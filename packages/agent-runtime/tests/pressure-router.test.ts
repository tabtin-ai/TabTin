/**
 * pressure-router 单元测试。
 *
 * W1（压缩路径简化）：删除 layeredPrune / sessionMemoryCompact
 * 后档位精简为 none / microcompact / llmSummary / emergency。
 * 旧 sessionMemory 档位与对应阈值 / helper 一并删除。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolvePressureThresholds,
  computePressureStage,
  shouldRunTimeBasedMicrocompact,
  shouldRunLlmSummary,
  DEFAULT_PRESSURE_THRESHOLDS,
  RECOMMENDED_PRESSURE_THRESHOLDS,
} from '../src/compact/pressure-router.js';
import {
  DEFAULT_CONTEXT_BUDGET,
} from '../src/engine/contracts/context-capability.js';

describe('resolvePressureThresholds SSoT 合并语义', () => {
  it('no budget + no override → DEFAULT', () => {
    expect(resolvePressureThresholds(undefined, undefined)).toEqual(DEFAULT_PRESSURE_THRESHOLDS);
  });

  it('budget.compactThreshold → llmSummaryStart 自动对齐（向后兼容）', () => {
    const t = resolvePressureThresholds(
      { ...DEFAULT_CONTEXT_BUDGET, compactThreshold: 0.90, emergencyThreshold: 0.98 },
      undefined,
    );
    expect(t.llmSummaryStart).toBe(0.90);
    expect(t.emergencyStart).toBe(0.98);
    expect(t.microCompactStart).toBe(DEFAULT_PRESSURE_THRESHOLDS.microCompactStart);
  });

  it('compactThreshold 低于默认 micro 起点 → micro 钳到同值（跳过 micro 档）', () => {
    const t = resolvePressureThresholds(
      { ...DEFAULT_CONTEXT_BUDGET, compactThreshold: 0.5, emergencyThreshold: 0.95 },
      undefined,
    );
    expect(t.microCompactStart).toBe(0.5);
    expect(t.llmSummaryStart).toBe(0.5);
    expect(t.emergencyStart).toBe(0.95);
  });

  it('micro == llmSummary（钳制产物 / 显式并线）合法，不回落 DEFAULT', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = resolvePressureThresholds(undefined, {
      microCompactStart: 0.85,
      llmSummaryStart: 0.85,
      emergencyStart: 0.95,
    });
    expect(t).toEqual({ microCompactStart: 0.85, llmSummaryStart: 0.85, emergencyStart: 0.95 });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('显式 override micro 高于钳制后的 llmSummary → 非法，回落 DEFAULT', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = resolvePressureThresholds(
      { ...DEFAULT_CONTEXT_BUDGET, compactThreshold: 0.5, emergencyThreshold: 0.95 },
      { microCompactStart: 0.75 },
    );
    expect(t).toEqual(DEFAULT_PRESSURE_THRESHOLDS);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('override 优先级高于 budget', () => {
    const t = resolvePressureThresholds(
      { ...DEFAULT_CONTEXT_BUDGET, compactThreshold: 0.90 },
      { llmSummaryStart: 0.88 },
    );
    expect(t.llmSummaryStart).toBe(0.88);
  });

  it('override = RECOMMENDED', () => {
    expect(resolvePressureThresholds(undefined, RECOMMENDED_PRESSURE_THRESHOLDS))
      .toEqual(RECOMMENDED_PRESSURE_THRESHOLDS);
  });

  it('非法配置（主序不递增）→ 回落 DEFAULT', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = resolvePressureThresholds(undefined, {
      microCompactStart: 0.95,
      llmSummaryStart: 0.85,
    });
    expect(t).toEqual(DEFAULT_PRESSURE_THRESHOLDS);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('非法配置（超出 [0,1]）→ 回落 DEFAULT', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = resolvePressureThresholds(undefined, { llmSummaryStart: 1.5 });
    expect(t).toEqual(DEFAULT_PRESSURE_THRESHOLDS);
    warnSpy.mockRestore();
  });
});

describe('computePressureStage 档位边界', () => {
  const th = RECOMMENDED_PRESSURE_THRESHOLDS;

  it.each([
    [0.00, 'none'],
    [0.50, 'none'],
    [0.749, 'none'],
    [0.75, 'microcompact'],
    [0.899, 'microcompact'],
    [0.90, 'llmSummary'],
    [0.94, 'llmSummary'],
    [0.95, 'emergency'],
    [1.00, 'emergency'],
  ])('pressure=%f → stage=%s', (pressure, expected) => {
    expect(computePressureStage(pressure as number, th)).toBe(expected);
  });

  it('pressure 非法值 → none', () => {
    expect(computePressureStage(NaN, th)).toBe('none');
    expect(computePressureStage(-0.1, th)).toBe('none');
  });
});

describe('shouldRunXXX 累积触发语义', () => {
  const th = RECOMMENDED_PRESSURE_THRESHOLDS;

  it('微压（< 0.75）：都不跑', () => {
    expect(shouldRunTimeBasedMicrocompact(0.50, th)).toBe(false);
    expect(shouldRunLlmSummary(0.50, th)).toBe(false);
  });

  it('microcompact 档位：只 time-based MC', () => {
    expect(shouldRunTimeBasedMicrocompact(0.80, th)).toBe(true);
    expect(shouldRunLlmSummary(0.80, th)).toBe(false);
  });

  it('llmSummary 档位：+ LLM summary', () => {
    expect(shouldRunTimeBasedMicrocompact(0.92, th)).toBe(true);
    expect(shouldRunLlmSummary(0.92, th)).toBe(true);
  });

  it('emergency 档位：全部触发', () => {
    expect(shouldRunTimeBasedMicrocompact(0.97, th)).toBe(true);
    expect(shouldRunLlmSummary(0.97, th)).toBe(true);
  });
});

describe('DEFAULT 与 RECOMMENDED 常量语义', () => {
  it('DEFAULT：75/85/95（W1 删 sessionMemory 档位后简化）', () => {
    expect(DEFAULT_PRESSURE_THRESHOLDS).toEqual({
      microCompactStart: 0.75,
      llmSummaryStart: 0.85,
      emergencyStart: 0.95,
    });
  });

  it('RECOMMENDED：75/90/95', () => {
    expect(RECOMMENDED_PRESSURE_THRESHOLDS).toEqual({
      microCompactStart: 0.75,
      llmSummaryStart: 0.90,
      emergencyStart: 0.95,
    });
  });

  it('两者 emergencyStart 一致', () => {
    expect(DEFAULT_PRESSURE_THRESHOLDS.emergencyStart)
      .toBe(RECOMMENDED_PRESSURE_THRESHOLDS.emergencyStart);
  });
});
