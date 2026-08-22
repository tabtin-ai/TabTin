/**
 * Tool tracker base utilities 单测。
 *
 * 这些 utility 是 `tool-failure-tracker` / `tool-repetition-tracker` 共用的
 * 基础块（stage 升级 / env 解析 / thresholds 合并 / buffer 兜底）。
 * 两 tracker 各自的集成测试已经间接覆盖大部分行为，本文件做"独立单元
 * 锁定"——任何 utility 行为漂移会先在这里跑红，避免漂到上层 tracker 才
 * 被 ~135 个集成测试合力暴露。
 */

import { describe, it, expect } from 'vitest';
import {
  parseTrackerEnvBoolean,
  parseTrackerEnvNumber,
  mergeTrackerThresholds,
  applyTrackerBufferFloor,
} from '../guards/tool-tracker-base.js';

describe('parseTrackerEnvBoolean', () => {
  it('returns undefined for undefined / empty / whitespace input', () => {
    expect(parseTrackerEnvBoolean(undefined)).toBeUndefined();
    expect(parseTrackerEnvBoolean('')).toBeUndefined();
    expect(parseTrackerEnvBoolean('   ')).toBeUndefined();
  });

  it('accepts the documented "on" alias set', () => {
    for (const v of ['on', 'true', '1', 'enabled', 'yes', 'ON', ' Yes ']) {
      expect(parseTrackerEnvBoolean(v)).toBe(true);
    }
  });

  it('accepts the documented "off" alias set', () => {
    for (const v of ['off', 'false', '0', 'disabled', 'no', 'OFF', ' No ']) {
      expect(parseTrackerEnvBoolean(v)).toBe(false);
    }
  });

  it('returns undefined for unrecognized strings', () => {
    expect(parseTrackerEnvBoolean('maybe')).toBeUndefined();
    expect(parseTrackerEnvBoolean('2')).toBeUndefined();
    expect(parseTrackerEnvBoolean('null')).toBeUndefined();
  });
});

describe('parseTrackerEnvNumber', () => {
  const opts = { min: 1, max: 100 };

  it('returns undefined for undefined / empty / whitespace input', () => {
    expect(parseTrackerEnvNumber(undefined, opts)).toBeUndefined();
    expect(parseTrackerEnvNumber('', opts)).toBeUndefined();
    expect(parseTrackerEnvNumber('   ', opts)).toBeUndefined();
  });

  it('parses and floors integer-valued strings', () => {
    expect(parseTrackerEnvNumber('5', opts)).toBe(5);
    expect(parseTrackerEnvNumber('  100  ', opts)).toBe(100);
  });

  it('parses and floors floats inside range', () => {
    expect(parseTrackerEnvNumber('2.9', opts)).toBe(2);
    expect(parseTrackerEnvNumber('99.6', opts)).toBe(99);
  });

  it('parses scientific notation inside range', () => {
    expect(parseTrackerEnvNumber('5e0', opts)).toBe(5);
    expect(parseTrackerEnvNumber('5e1', opts)).toBe(50);
  });

  it('rejects NaN / non-numeric / Infinity', () => {
    expect(parseTrackerEnvNumber('NaN', opts)).toBeUndefined();
    expect(parseTrackerEnvNumber('abc', opts)).toBeUndefined();
    expect(parseTrackerEnvNumber('Infinity', opts)).toBeUndefined();
    expect(parseTrackerEnvNumber('-Infinity', opts)).toBeUndefined();
  });

  it('rejects values below min / above max (inclusive bounds)', () => {
    expect(parseTrackerEnvNumber('0', opts)).toBeUndefined();
    expect(parseTrackerEnvNumber('-1', opts)).toBeUndefined();
    expect(parseTrackerEnvNumber('100.1', opts)).toBeUndefined();
    expect(parseTrackerEnvNumber('999', opts)).toBeUndefined();
    expect(parseTrackerEnvNumber('1.5e3', opts)).toBeUndefined();
  });

  it('honors custom min / max ranges (windowMs scenario)', () => {
    const win = { min: 1_000, max: 3_600_000 };
    expect(parseTrackerEnvNumber('500', win)).toBeUndefined();
    expect(parseTrackerEnvNumber('1000', win)).toBe(1000);
    expect(parseTrackerEnvNumber('60000', win)).toBe(60000);
    expect(parseTrackerEnvNumber('3600000', win)).toBe(3_600_000);
    expect(parseTrackerEnvNumber('7200000', win)).toBeUndefined();
  });
});

describe('mergeTrackerThresholds', () => {
  const base = { notice: 3, nudge: 5 } as const;

  it('returns base when no env / explicit overrides', () => {
    expect(mergeTrackerThresholds(base, undefined, undefined, 100)).toEqual({
      notice: 3,
      nudge: 5,
    });
  });

  it('env overrides base; explicit overrides env', () => {
    expect(mergeTrackerThresholds(base, { notice: 2, nudge: 4 }, undefined, 100)).toEqual({
      notice: 2,
      nudge: 4,
    });
    expect(mergeTrackerThresholds(base, { notice: 2, nudge: 4 }, { notice: 8, nudge: 12 }, 100)).toEqual({
      notice: 8,
      nudge: 12,
    });
  });

  it('partial env / explicit only overrides given fields, falls back layer-wise', () => {
    expect(mergeTrackerThresholds(base, { notice: 2 }, undefined, 100)).toEqual({
      notice: 2,
      nudge: 5,
    });
    expect(mergeTrackerThresholds(base, undefined, { nudge: 9 }, 100)).toEqual({
      notice: 3,
      nudge: 9,
    });
  });

  it('falls back to base entirely when notice >= nudge invariant violated', () => {
    expect(mergeTrackerThresholds(base, { notice: 5, nudge: 3 }, undefined, 100)).toEqual(base);
    expect(mergeTrackerThresholds(base, undefined, { notice: 7, nudge: 7 }, 100)).toEqual(base);
  });

  it('falls back when nudge exceeds max', () => {
    expect(mergeTrackerThresholds(base, undefined, { notice: 50, nudge: 101 }, 100)).toEqual(base);
  });

  it('falls back when values are non-integer / negative / zero', () => {
    // 浮点 (env 解析层应已 floor，但本函数仍兜底)
    expect(mergeTrackerThresholds(base, undefined, { notice: 2.5, nudge: 4 }, 100)).toEqual(base);
    // 0 / 负数
    expect(mergeTrackerThresholds(base, undefined, { notice: 0, nudge: 5 }, 100)).toEqual(base);
    expect(mergeTrackerThresholds(base, undefined, { notice: -1, nudge: 5 }, 100)).toEqual(base);
  });

  it('preserves additional readonly properties through generic widening (valid path)', () => {
    interface ExtendedThresholds {
      readonly notice: number;
      readonly nudge: number;
      readonly decay: string;
    }
    const extBase: ExtendedThresholds = { notice: 2, nudge: 3, decay: 'linear' };

    // valid path: env / explicit override notice/nudge but extra `decay` must survive.
    const validOut = mergeTrackerThresholds(extBase, undefined, { notice: 4, nudge: 6 }, 100);
    expect(validOut).toEqual({ notice: 4, nudge: 6, decay: 'linear' });

    // invalid path: full base spread (notice/nudge restored, decay survives via base).
    const invalidOut = mergeTrackerThresholds(extBase, undefined, { notice: 7, nudge: 5 }, 100);
    expect(invalidOut).toEqual(extBase);
  });

  it('does NOT mutate input thresholds (returns new object)', () => {
    const env = { notice: 4, nudge: 6 };
    const explicit = { notice: 8, nudge: 10 };
    const result = mergeTrackerThresholds(base, env, explicit, 100);
    expect(env).toEqual({ notice: 4, nudge: 6 });
    expect(explicit).toEqual({ notice: 8, nudge: 10 });
    expect(result).not.toBe(base);
  });
});

describe('applyTrackerBufferFloor', () => {
  it('uses base when explicit is undefined and base ≥ nudge', () => {
    expect(applyTrackerBufferFloor(undefined, 10, 5, 10_000)).toBe(10);
  });

  it('uses explicit when valid and ≥ nudge', () => {
    expect(applyTrackerBufferFloor(20, 10, 5, 10_000)).toBe(20);
  });

  it('expands buffer to nudge floor when explicit is below nudge', () => {
    expect(applyTrackerBufferFloor(3, 10, 12, 10_000)).toBe(12);
  });

  it('expands buffer to nudge floor when base is below nudge (no explicit)', () => {
    expect(applyTrackerBufferFloor(undefined, 10, 12, 10_000)).toBe(12);
  });

  it('falls back to base then floors when explicit is non-integer / NaN / negative / zero', () => {
    expect(applyTrackerBufferFloor(NaN, 10, 5, 10_000)).toBe(10);
    expect(applyTrackerBufferFloor(2.5, 10, 5, 10_000)).toBe(10);
    expect(applyTrackerBufferFloor(-1, 10, 5, 10_000)).toBe(10);
    expect(applyTrackerBufferFloor(0, 10, 5, 10_000)).toBe(10);
  });

  it('falls back to base when explicit exceeds max', () => {
    expect(applyTrackerBufferFloor(20_000, 10, 5, 10_000)).toBe(10);
    // repetition 较大上限场景仍工作
    expect(applyTrackerBufferFloor(50_000, 256, 3, 100_000)).toBe(50_000);
    expect(applyTrackerBufferFloor(200_000, 256, 3, 100_000)).toBe(256);
  });

  it('honors max upper bound inclusively', () => {
    expect(applyTrackerBufferFloor(10_000, 10, 5, 10_000)).toBe(10_000);
    expect(applyTrackerBufferFloor(100_000, 256, 3, 100_000)).toBe(100_000);
  });
});
