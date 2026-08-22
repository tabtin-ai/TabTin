import type { TaskCapsuleStatusKind } from '@tabtin/contracts/agent';
import type {
  OrbMode,
  OrbPaintOptions,
  OrbPreset,
  OrbPresetSize,
  OrbRgb,
  OrbTexture,
  OrbVisual,
} from './types.js';

/**
 * status → 视觉决策。
 *
 * 铁律：动 = 它在干活，静 = 球在你这边。终态与介入态一律不发 orb，
 * 避免持续转动的球误导用户以为还在跑。
 *
 * thinking / planningNext 刻意同纹理——都是「在想」，用户无需被迫区分。
 * recovering 是唯一染色的 orb：既在动，又需要你知情。
 */
const STATUS_TO_VISUAL: Record<TaskCapsuleStatusKind, OrbVisual> = {
  ready: { kind: 'dot', tone: 'muted' },
  preparing: { kind: 'orb', texture: 'breathing' },
  queued: { kind: 'orb', texture: 'breathing' },
  thinking: { kind: 'orb', texture: 'breathing' },
  planningNext: { kind: 'orb', texture: 'breathing' },
  working: { kind: 'orb', texture: 'working' },
  finishing: { kind: 'orb', texture: 'composing' },
  recovering: { kind: 'orb', texture: 'connecting', tint: 'warning' },
  needsApproval: { kind: 'dot', tone: 'warning' },
  needsAnswer: { kind: 'dot', tone: 'warning' },
  paused: { kind: 'dashedRing' },
  complete: { kind: 'dot', tone: 'success' },
  stopped: { kind: 'dot', tone: 'muted' },
  error: { kind: 'dot', tone: 'critical' },
};

/** 产品纹理 → 上游绘制器 mode（多对一：ring 与 ribbon 共用 ribbon 绘制器）。 */
const STATE_TO_MODE: Record<OrbTexture, OrbMode> = {
  working: 'orbits',
  searching: 'globe',
  solving: 'rubik',
  listening: 'wave',
  connecting: 'web',
  weaving: 'braid',
  composing: 'ribbon',
  breathing: 'ring',
  shaping: 'morph',
};

/**
 * 各 mode 在 64 基准下的手调密度 / 点径。
 * 数值逐字来自 demo，改一个都会让观感崩掉。
 */
const BASE_OPTS: Record<OrbMode, OrbPaintOptions> = {
  globe: {
    latRings: 17,
    lonDensity: 44,
    rBase: 0.6,
    rDepth: 1.7,
    rBoost: 1,
    inkFar: 0.62,
    inkSpan: 0.54,
    rsPow: 0.6,
    rMin: 0.3,
  },
  orbits: {
    orbitN: 12,
    ghostN: 40,
    ghostR: 0.9,
    ghostA: 0.5,
    particles: 3,
    partR: 1.2,
    partRDepth: 1.6,
    rsPow: 0.6,
    rMin: 0.3,
  },
  rubik: {
    latRings: 15,
    lonDensity: 40,
    moveCount: 14,
    rBase: 0.6,
    rDepth: 1.7,
    rActive: 0.3,
    inkFar: 0.62,
    inkSpan: 0.54,
    rsPow: 0.6,
    rMin: 0.3,
  },
  wave: {
    rings: 15,
    lonDensity: 40,
    rBase: 0.6,
    rDepth: 1.7,
    rsPow: 0.6,
    rMin: 0.3,
  },
  web: {
    nodeN: 30,
    thr: 0.72,
    signals: 5,
    nodeR: 1.4,
    nodeRDepth: 1.8,
    lineW: 0.8,
    rsPow: 0.6,
    rMin: 0.3,
  },
  braid: {
    strandN: 52,
    turns: 3,
    ghostN: 150,
    rBase: 1.2,
    rDepth: 1.8,
    rsPow: 0.6,
    rMin: 0.3,
  },
  ribbon: {
    lanes: 5,
    segs: 88,
    ghostN: 150,
    rBase: 1.1,
    rDepth: 1.7,
    rsPow: 0.6,
    rMin: 0.3,
  },
  ring: {
    lanes: 5,
    segs: 88,
    ghostN: 0,
    faceOn: 1,
    rBase: 1.1,
    rDepth: 1.7,
    rsPow: 0.6,
    rMin: 0.3,
  },
  morph: { rDot: 0.021, iconD: 1, rMin: 0.25 },
};

interface SizeTuning {
  speed: number;
  count: number;
  size: number;
  extra?: OrbPaintOptions;
}

/**
 * speed / count / size 是相对 64 基准的节奏、密度与点径系数。
 * 12 / 20 / 64 是三套独立手调，不是互相缩小。
 * 12 档原则：更少点、更大点、略快节奏，轮廓优先于纹理细节。
 *
 * ⚠️ 12 档只有 `ring`（breathing）通过了目视验收，产品里也只用它。
 * 12px 在 retina 上只有 24 个设备像素，装不下九种可区分的纹理——目视对照见
 * `docs/agent/orb-b1-shots/`：orbits 会散成几个偏心墨块、web 只剩三个点，
 * 读不出是什么。其余八组存在只为类型完整与将来重调的起点，**别直接拿去用**；
 * 小尺寸槽位一律用 breathing，靠旁边的行文案区分在做什么。
 */
const TUNING: Record<OrbMode, Record<OrbPresetSize, SizeTuning>> = {
  orbits: {
    64: { speed: 1.885, count: 1, size: 1 },
    20: { speed: 3.9, count: 0.238, size: 2.4 },
    // 12：2 轨 + 少量幽灵点；点径略低于初值，避免挤成一团
    12: { speed: 4.6, count: 0.14, size: 2.9 },
  },
  globe: {
    64: {
      speed: 2.015,
      count: 0.42,
      size: 1.15,
      extra: { scanMul: 4.08, dimBase: 0.45 },
    },
    20: {
      speed: 2.665,
      count: 0.105,
      size: 1.75,
      extra: { scanMul: 4.335, dimBase: 0.45 },
    },
    12: {
      speed: 3.1,
      count: 0.045,
      size: 2.5,
      extra: { scanMul: 4.6, dimBase: 0.45 },
    },
  },
  rubik: {
    64: { speed: 1.82, count: 0.35, size: 1.05 },
    20: { speed: 1.95, count: 0.088, size: 1.9 },
    12: { speed: 2.25, count: 0.04, size: 2.7 },
  },
  wave: {
    64: { speed: 4.388, count: 0.341, size: 1 },
    20: { speed: 3.998, count: 0.105, size: 1.6 },
    12: { speed: 4.7, count: 0.045, size: 2.4 },
  },
  web: {
    64: { speed: 3.315, count: 1.35, size: 0.95 },
    20: { speed: 6.63, count: 0.25, size: 1.52 },
    // 12：节点太少会看不见网；放宽 thr 让稀疏节点仍能出连线
    12: { speed: 8.0, count: 0.2, size: 2.1, extra: { thr: 0.95 } },
  },
  braid: {
    64: { speed: 1.625, count: 0.5, size: 1 },
    20: { speed: 2.75, count: 0.1125, size: 1.36 },
    12: { speed: 3.35, count: 0.055, size: 2.0 },
  },
  ribbon: {
    64: {
      speed: 2.34,
      count: 0.25,
      size: 0.85,
      extra: { spin: 0, bandMul: 3.9, wobMul: 1 },
    },
    20: {
      speed: 3.12,
      count: 0.051,
      size: 1.073,
      extra: { spin: 0, bandMul: 4.94, wobMul: 1 },
    },
    12: {
      speed: 3.7,
      count: 0.022,
      size: 1.55,
      extra: { spin: 0, bandMul: 5.4, wobMul: 1 },
    },
  },
  ring: {
    64: {
      speed: 3.24,
      count: 0.25,
      size: 0.956,
      extra: { spin: 0, bandMul: 3.627, wobMul: 0.368 },
    },
    20: {
      speed: 3.78,
      count: 0.028,
      size: 1.622,
      extra: { spin: 0, bandMul: 3.968, wobMul: 0.565 },
    },
    12: {
      speed: 4.4,
      count: 0.012,
      size: 2.35,
      extra: { spin: 0, bandMul: 4.35, wobMul: 0.52 },
    },
  },
  morph: {
    64: {
      speed: 2.405,
      count: 0.702,
      size: 0.395,
      extra: { spread: 1.45 },
    },
    20: {
      speed: 2.08,
      count: 0.53,
      size: 1.011,
      extra: { spread: 1.45 },
    },
    12: {
      speed: 2.4,
      count: 0.38,
      size: 1.55,
      extra: { spread: 1.45 },
    },
  },
};

/** 成对密度按 √count 缩，保持球面点阵长宽比。 */
const COUNT_PAIRS = [
  ['latRings', 'lonDensity'],
  ['rings', 'lonDensity'],
  ['lanes', 'segs'],
] as const;

/** 独立计数按 count 线性缩。 */
const COUNT_LINEAR = [
  'orbitN',
  'ghostN',
  'nodeN',
  'strandN',
  'signals',
] as const;

const COUNT_DIRECT = ['iconD'] as const;

const SIZE_KEYS = [
  'rBase',
  'rDepth',
  'rActive',
  'rDot',
  'ghostR',
  'partR',
  'partRDepth',
  'nodeR',
  'nodeRDepth',
] as const;

/** OrbPaintOptions 里可能夹 OrbRgb，缩放只碰 number。 */
function asNumber(value: number | OrbRgb | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function scaleCount(opts: OrbPaintOptions, count: number): OrbPaintOptions {
  const out: OrbPaintOptions = { ...opts };
  const done = new Set<string>();
  const root = Math.sqrt(count);

  for (const [a, b] of COUNT_PAIRS) {
    const av = asNumber(out[a]);
    const bv = asNumber(out[b]);
    if (av == null || bv == null || done.has(a) || done.has(b)) continue;
    out[a] = Math.max(2, Math.round(av * root));
    out[b] = Math.max(2, Math.round(bv * root));
    done.add(a);
    done.add(b);
  }

  for (const k of COUNT_LINEAR) {
    const v = asNumber(out[k]);
    // ghostN: 0 是 ring 的「不要幽灵点」哨兵，不能被 max(1, …) 抬成 1
    if (v == null || v === 0 || done.has(k)) continue;
    out[k] = Math.max(1, Math.round(v * count));
  }

  for (const k of COUNT_DIRECT) {
    const v = asNumber(out[k]);
    if (v != null) out[k] = Math.max(0.02, v * count);
  }

  return out;
}

function scaleDotSize(opts: OrbPaintOptions, mul: number): OrbPaintOptions {
  const out: OrbPaintOptions = { ...opts };
  for (const k of SIZE_KEYS) {
    const v = asNumber(out[k]);
    if (v != null) out[k] = v * mul;
  }
  return out;
}

export function resolveOrbVisual(status: TaskCapsuleStatusKind): OrbVisual {
  return STATUS_TO_VISUAL[status];
}

/**
 * 按纹理 + 尺寸档产出绘制预设。
 *
 * 故意不缓存：Global Constraint 3 禁止可变模块级状态；
 * 解析本身是廉价纯函数，缓存收益不足以换一个工厂 API。
 */
export function resolveOrbPreset(
  texture: OrbTexture,
  size: OrbPresetSize,
): OrbPreset {
  const mode = STATE_TO_MODE[texture];
  const tune = TUNING[mode][size];
  let opts: OrbPaintOptions = { ...BASE_OPTS[mode] };
  if (tune.count !== 1) opts = scaleCount(opts, tune.count);
  if (tune.size !== 1) opts = scaleDotSize(opts, tune.size);
  if (tune.extra) opts = { ...opts, ...tune.extra };
  return { mode, speed: tune.speed, opts };
}

/** 中间尺寸靠调用方选档 + 画布缩放；边界钉在 15 / 28。 */
export function pickOrbPresetSize(cssSize: number): OrbPresetSize {
  if (cssSize <= 15) return 12;
  if (cssSize <= 28) return 20;
  return 64;
}
