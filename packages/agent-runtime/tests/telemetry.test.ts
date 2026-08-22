/**
 * H1-E Telemetry 单测 —— 增量覆盖。
 *
 * 已有 suite（**本文件不重复**）：
 *   - `telemetry-emitter.test.ts` ── emit/sink 基础契约
 *   - `telemetry-redact.test.ts`  ── 脱敏工具衍生字段
 *   - `telemetry-mttr.test.ts`    ── MTTR 辅助函数
 *   - `telemetry-integration.test.ts` ── doom-loop-guard / compaction-orchestrator 旁路
 *
 * 本文件专注补齐以下"公约 / 精细行为"回归：
 *   1. 事件常量命名规则正则校验（防误命名）
 *   2. `resetTelemetrySink` 会顺带清掉 debug 标志（否则后续测试会泄漏 debug 态）
 *   3. debug 开启时 stderr 输出的**精确内容断言**（含事件名 + 异常 message）
 *   4. 集成冒烟：Runtime 业务路径典型用法下，persona 原文绝不出现在 record JSON
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TelemetryEvents,
  emitTelemetryEvent,
  setTelemetrySink,
  setTelemetryDebug,
  resetTelemetrySink,
  redactCustomRules,
} from '../src/telemetry/index.js';
import type { TelemetryRecord } from '../src/telemetry/index.js';

// ── 事件命名规则正则 ────────────────────────────────────────────────

describe('TelemetryEvents 常量表', () => {
  it('全部事件名为 `namespace.action[.qualifier]` 小写形式', () => {
    // 允许 `metric.` 前缀（可聚合指标）；其他事件直接以 namespace 起头；
    // 名称全小写 + 下划线 / 数字 / 点；至少含一个 `.`。
    const eventNameRe = /^(metric\.)?[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

    for (const [key, value] of Object.entries(TelemetryEvents)) {
      expect(key, `常量键 ${key} 必须是 UPPER_SNAKE_CASE`).toMatch(
        /^[A-Z][A-Z0-9_]*$/,
      );
      expect(value, `事件名 ${key}='${value}' 不符合命名规则`).toMatch(
        eventNameRe,
      );
    }
  });

  it('只有 `metric.*` 前缀用于可聚合数值指标', () => {
    const metrics = Object.entries(TelemetryEvents).filter(([, v]) =>
      v.startsWith('metric.'),
    );
    //  起新增 LLM_TIMING（metric.llm.timing_ms）；新增聚合指标时此处断言会触发，
    // 提示同步更新 TELEMETRY.md / 事件常量表注释。
    expect(metrics.map(([k]) => k).sort()).toEqual([
      'DOCPARSE_LOCAL_DURATION',
      'LLM_TIMING',
    ]);
  });
});

// ── resetTelemetrySink 副作用 ──────────────────────────────────────

describe('resetTelemetrySink 完整复位', () => {
  afterEach(() => {
    resetTelemetrySink();
  });

  it('reset 后再抛异常不会写 stderr（debug 标志被清）', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    // 先打开 debug 并观察"能写 stderr"
    setTelemetrySink(() => {
      throw new Error('phase-1');
    });
    setTelemetryDebug(true);
    emitTelemetryEvent('unit.phase1', {});
    expect(stderrSpy).toHaveBeenCalledTimes(1);

    // 复位后 debug 应被关掉
    resetTelemetrySink();
    stderrSpy.mockClear();
    setTelemetrySink(() => {
      throw new Error('phase-2');
    });
    emitTelemetryEvent('unit.phase2', {});
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });
});

// ── debug 输出精确断言 ─────────────────────────────────────────────

describe('emitTelemetryEvent debug=true 时的 stderr 输出格式', () => {
  afterEach(() => {
    resetTelemetrySink();
  });

  it('前缀包含事件名 + 异常 message；整体为单行 + \\n 结尾', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    setTelemetrySink(() => {
      throw new Error('boom-the-sink');
    });
    setTelemetryDebug(true);
    emitTelemetryEvent(TelemetryEvents.API_ERROR_400, { status: 400 });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const call = stderrSpy.mock.calls[0]![0];
    const text = typeof call === 'string' ? call : String(call);
    expect(text).toContain('[telemetry:sink_error] api.error.400');
    expect(text).toContain('boom-the-sink');
    expect(text.endsWith('\n')).toBe(true);

    stderrSpy.mockRestore();
  });
});

// ── 集成冒烟：Runtime 业务路径典型用法 ────────────────────────────

describe('集成：persona.applied 发送路径脱敏冒烟', () => {
  afterEach(() => {
    resetTelemetrySink();
  });

  it('record JSON 内**完全不含**敏感原文（custom_rules）', () => {
    const captured: TelemetryRecord[] = [];
    setTelemetrySink((r) => captured.push(r));

    const customRules = '永远不要泄漏内部邮件 ops@tabtin.secret';

    emitTelemetryEvent(
      TelemetryEvents.PERSONA_APPLIED,
      {
        ...redactCustomRules(customRules),
      },
      { session_id: 'sess-1', agent_id: 'agent-1' },
    );

    expect(captured).toHaveLength(1);
    const dump = JSON.stringify(captured[0]);
    expect(dump).not.toContain('ops@tabtin.secret');
    expect(dump).not.toContain('内部邮件');

    expect(captured[0]!.session_id).toBe('sess-1');
    expect(captured[0]!.agent_id).toBe('agent-1');
  });
});
