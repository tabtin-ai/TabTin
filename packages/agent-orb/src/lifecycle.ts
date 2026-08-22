import type { OrbClockState, OrbResolveKind } from './types.js';

/** demo 里构图好看的那一帧；静帧降级也钉在这里，避免随机相位。 */
const INITIAL_PHASE = 0.6;

/** 夹住卡顿导致的大跳，避免相位一次蹦出「穿帮」感。 */
const DT_SECONDS_MAX = 0.05;

const RESOLVE_DURATION_MS: Record<OrbResolveKind, number> = {
  done: 420,
  interrupt: 180,
};

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function createOrbClock(): OrbClockState {
  return {
    phase: INITIAL_PHASE,
    timeScale: 1,
    settle: 0,
  };
}

export function advanceOrbClock(
  state: OrbClockState,
  dtSeconds: number,
  nowMs: number,
): OrbClockState {
  const dt = Math.min(DT_SECONDS_MAX, dtSeconds);
  // 先用本帧开始时的 timeScale 累积相位，再同步收束旋钮——这样减速滑停有惯性，不会先改系数再「少走一截」
  let phase = state.phase + dt * state.timeScale;
  let timeScale = state.timeScale;
  let settle = state.settle;
  const resolve = state.resolve;

  if (resolve) {
    const k = clamp01((nowMs - resolve.startMs) / resolve.durationMs);
    if (k >= 1) {
      // 末帧钉死，避免浮点尾巴留下「几乎 0 / 几乎 1」
      timeScale = 0;
      settle = 1;
    } else {
      // easeOutQuad：尾巴拖得自然（运动先快后慢地刹住，起伏后半段才平复完）
      const easeOut = (1 - k) * (1 - k);
      timeScale = resolve.fromTimeScale * easeOut;
      settle = resolve.fromSettle + (1 - resolve.fromSettle) * (1 - easeOut);
    }
  }

  if (resolve) {
    return { phase, timeScale, settle, resolve };
  }
  return { phase, timeScale, settle };
}

export function beginOrbResolve(
  state: OrbClockState,
  kind: OrbResolveKind,
  nowMs: number,
): OrbClockState {
  // 起点取当前实际值：收束中途再次触发时从「现在」继续，不得跳变
  return {
    ...state,
    resolve: {
      kind,
      startMs: nowMs,
      durationMs: RESOLVE_DURATION_MS[kind],
      fromTimeScale: state.timeScale,
      fromSettle: state.settle,
    },
  };
}

/**
 * 直接落到收束终态（完美点环），不播减速过程。
 *
 * 给「减弱动效」用：这类用户要的是不看见运动，而不是看不见结束——省掉过渡但仍须给出终帧，
 * 否则球会停在运行态的某个乱帧上，读起来像卡住而不是做完了。
 */
export function settleOrbClock(state: OrbClockState): OrbClockState {
  return { ...state, timeScale: 0, settle: 1 };
}

export function isOrbResting(state: OrbClockState): boolean {
  // 渲染层靠这个跳过重复重绘：动停了才算休息
  return state.timeScale === 0;
}
