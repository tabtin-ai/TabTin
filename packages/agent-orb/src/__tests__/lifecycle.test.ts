import { describe, expect, it } from 'vitest';
import {
  advanceOrbClock,
  beginOrbResolve,
  createOrbClock,
  isOrbResting,
  settleOrbClock,
} from '../lifecycle.js';
import type { OrbClockState } from '../types.js';

/** 与 lifecycle 内 easeOutQuad 对齐：easeOut = (1-k)² */
function expectedResolve(fromTimeScale: number, fromSettle: number, k: number) {
  const clamped = Math.min(1, Math.max(0, k));
  if (clamped >= 1) {
    return { timeScale: 0, settle: 1 };
  }
  const easeOut = (1 - clamped) * (1 - clamped);
  return {
    timeScale: fromTimeScale * easeOut,
    settle: fromSettle + (1 - fromSettle) * (1 - easeOut),
  };
}

function driveResolve(
  start: OrbClockState,
  kind: 'done' | 'interrupt',
  startMs: number,
  sampleOffsetsMs: number[],
  dtSeconds = 1 / 60,
): OrbClockState[] {
  let state = beginOrbResolve(start, kind, startMs);
  return sampleOffsetsMs.map((offset) => {
    state = advanceOrbClock(state, dtSeconds, startMs + offset);
    return state;
  });
}

describe('createOrbClock', () => {
  it('初始相位钉在 demo 的 0.6，全速且未收束', () => {
    const clock = createOrbClock();
    expect(clock).toEqual({
      phase: 0.6,
      timeScale: 1,
      settle: 0,
    });
    expect(clock.resolve).toBeUndefined();
    expect(isOrbResting(clock)).toBe(false);
  });
});

describe('advanceOrbClock', () => {
  it('按 dt × timeScale 累积相位', () => {
    const clock = createOrbClock();
    const next = advanceOrbClock(clock, 0.02, 1000);
    expect(next.phase).toBeCloseTo(0.6 + 0.02 * 1, 12);
    expect(next.timeScale).toBe(1);
    expect(next.settle).toBe(0);
  });

  it('dt 上限钳到 0.05：传 10 秒只推进 0.05×timeScale', () => {
    const clock = createOrbClock();
    const next = advanceOrbClock(clock, 10, 1000);
    expect(next.phase).toBeCloseTo(0.6 + 0.05 * 1, 12);
  });

  it('不读墙上时钟：相同入参产出相同状态', () => {
    const clock = createOrbClock();
    const a = advanceOrbClock(clock, 0.016, 5000);
    const b = advanceOrbClock(clock, 0.016, 5000);
    expect(a).toEqual(b);
  });

  it('不修改入参（纯函数）', () => {
    const clock = createOrbClock();
    const snapshot = structuredClone(clock);
    advanceOrbClock(clock, 0.03, 2000);
    expect(clock).toEqual(snapshot);
  });
});

describe('beginOrbResolve + 收束缓动', () => {
  it('done = 420ms，interrupt = 180ms', () => {
    const clock = createOrbClock();
    expect(beginOrbResolve(clock, 'done', 0).resolve?.durationMs).toBe(420);
    expect(beginOrbResolve(clock, 'interrupt', 0).resolve?.durationMs).toBe(180);
  });

  it('done 收束：timeScale / settle 单调，末值精确为 0 / 1，缓动公式逐点对齐', () => {
    const startMs = 10_000;
    const durationMs = 420;
    const offsets = [0, 105, 210, 315, 420, 500];
    const samples = driveResolve(createOrbClock(), 'done', startMs, offsets, 0);

    let prevTs = Number.POSITIVE_INFINITY;
    let prevSettle = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < offsets.length; i++) {
      const k = offsets[i]! / durationMs;
      const expected = expectedResolve(1, 0, k);
      expect(samples[i]!.timeScale).toBeCloseTo(expected.timeScale, 12);
      expect(samples[i]!.settle).toBeCloseTo(expected.settle, 12);

      expect(samples[i]!.timeScale).toBeLessThanOrEqual(prevTs + 1e-12);
      expect(samples[i]!.settle).toBeGreaterThanOrEqual(prevSettle - 1e-12);
      prevTs = samples[i]!.timeScale;
      prevSettle = samples[i]!.settle;
    }

    const last = samples[samples.length - 1]!;
    expect(last.timeScale).toBe(0);
    expect(last.settle).toBe(1);
    expect(isOrbResting(last)).toBe(true);
  });

  it('interrupt 收束：180ms 内落到 timeScale=0 / settle=1', () => {
    const startMs = 0;
    const samples = driveResolve(createOrbClock(), 'interrupt', startMs, [0, 90, 180], 0);
    expect(samples[0]!.timeScale).toBe(1);
    expect(samples[0]!.settle).toBe(0);

    const mid = expectedResolve(1, 0, 0.5);
    expect(samples[1]!.timeScale).toBeCloseTo(mid.timeScale, 12);
    expect(samples[1]!.settle).toBeCloseTo(mid.settle, 12);

    expect(samples[2]!.timeScale).toBe(0);
    expect(samples[2]!.settle).toBe(1);
  });

  it('收束中途再次 beginOrbResolve：新起点等于当时实际值，不跳变', () => {
    const t0 = 1000;
    let state = beginOrbResolve(createOrbClock(), 'done', t0);
    // k = 210/420 = 0.5 → timeScale = 0.25，settle = 0.75
    state = advanceOrbClock(state, 0, t0 + 210);
    expect(state.timeScale).toBeCloseTo(0.25, 12);
    expect(state.settle).toBeCloseTo(0.75, 12);

    const before = { timeScale: state.timeScale, settle: state.settle };
    state = beginOrbResolve(state, 'interrupt', t0 + 210);

    expect(state.resolve?.kind).toBe('interrupt');
    expect(state.resolve?.durationMs).toBe(180);
    expect(state.resolve?.fromTimeScale).toBe(before.timeScale);
    expect(state.resolve?.fromSettle).toBe(before.settle);
    // begin 本身不改旋钮；同刻 advance 的 k=0，值应保持
    expect(state.timeScale).toBe(before.timeScale);
    expect(state.settle).toBe(before.settle);

    state = advanceOrbClock(state, 0, t0 + 210);
    expect(state.timeScale).toBe(before.timeScale);
    expect(state.settle).toBe(before.settle);
  });

  it('收束期间相位仍按当前 timeScale 推进（惯性滑停）', () => {
    const t0 = 0;
    let state = beginOrbResolve(createOrbClock(), 'done', t0);
    // k=0 时仍全速；dt 钳后推进 0.05
    state = advanceOrbClock(state, 0.05, t0);
    expect(state.phase).toBeCloseTo(0.6 + 0.05 * 1, 12);

    // 走到一半：timeScale=0.25，再推进一帧
    state = advanceOrbClock(state, 0.05, t0 + 210);
    expect(state.timeScale).toBeCloseTo(0.25, 12);
    // 本帧 phase 用的是「advance 入口处」的 timeScale（上一帧末值 1），不是本帧缓动后的 0.25
    // 再喂一帧才能看到减速后的相位步长
    const phaseAfterHalf = state.phase;
    state = advanceOrbClock(state, 0.05, t0 + 211);
    expect(state.phase - phaseAfterHalf).toBeCloseTo(0.05 * 0.25, 12);
  });
});

describe('settleOrbClock', () => {
  it('落到 timeScale=0 / settle=1，且立即算 resting', () => {
    const settled = settleOrbClock(createOrbClock());
    expect(settled.timeScale).toBe(0);
    expect(settled.settle).toBe(1);
    expect(isOrbResting(settled)).toBe(true);
  });

  it('保留相位与 resolve：终帧构图不跳、收束意图不丢', () => {
    const running = advanceOrbClock(createOrbClock(), 0.05, 0);
    const state = beginOrbResolve(running, 'done', 1000);
    const settled = settleOrbClock(state);
    expect(settled.phase).toBe(state.phase);
    expect(settled.resolve).toEqual(state.resolve);
  });

  it('与走完整条收束曲线的终态一致', () => {
    const t0 = 3000;
    const viaCurve = advanceOrbClock(beginOrbResolve(createOrbClock(), 'done', t0), 0, t0 + 420);
    const viaSettle = settleOrbClock(beginOrbResolve(createOrbClock(), 'done', t0));
    expect(viaSettle.timeScale).toBe(viaCurve.timeScale);
    expect(viaSettle.settle).toBe(viaCurve.settle);
  });

  it('不修改入参（纯函数）', () => {
    const clock = createOrbClock();
    const snapshot = structuredClone(clock);
    settleOrbClock(clock);
    expect(clock).toEqual(snapshot);
  });
});

describe('isOrbResting', () => {
  it('仅当 timeScale === 0', () => {
    expect(isOrbResting({ phase: 0.6, timeScale: 1, settle: 0 })).toBe(false);
    expect(isOrbResting({ phase: 0.6, timeScale: 0.0001, settle: 0.9 })).toBe(false);
    expect(isOrbResting({ phase: 1.2, timeScale: 0, settle: 1 })).toBe(true);
  });
});
