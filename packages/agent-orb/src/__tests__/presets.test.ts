import { describe, expect, it } from 'vitest';
import { TASK_CAPSULE_STATUS_KEYS } from '@tabtin/contracts/agent';
import {
  pickOrbPresetSize,
  resolveOrbPreset,
  resolveOrbVisual,
} from '../presets.js';
import type { OrbPreset, OrbTexture, OrbVisual } from '../types.js';

const TEXTURES: OrbTexture[] = [
  'working',
  'searching',
  'solving',
  'listening',
  'connecting',
  'weaving',
  'composing',
  'breathing',
  'shaping',
];

const EXPECTED_VISUAL: Record<(typeof TASK_CAPSULE_STATUS_KEYS)[number], OrbVisual> =
  {
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

/** 改动前锁定的 20 / 64 档解析结果，防止手滑改动老档。 */
const LEGACY_PRESETS: Record<string, OrbPreset> = {
  'breathing@20': {
    mode: 'ring',
    speed: 3.78,
    opts: {
      lanes: 2,
      segs: 15,
      ghostN: 0,
      faceOn: 1,
      rBase: 1.1 * 1.622,
      rDepth: 1.7 * 1.622,
      rsPow: 0.6,
      rMin: 0.3,
      spin: 0,
      bandMul: 3.968,
      wobMul: 0.565,
    },
  },
  'breathing@64': {
    mode: 'ring',
    speed: 3.24,
    opts: {
      lanes: 3,
      segs: 44,
      ghostN: 0,
      faceOn: 1,
      rBase: 1.1 * 0.956,
      rDepth: 1.7 * 0.956,
      rsPow: 0.6,
      rMin: 0.3,
      spin: 0,
      bandMul: 3.627,
      wobMul: 0.368,
    },
  },
  'working@20': {
    mode: 'orbits',
    speed: 3.9,
    opts: {
      orbitN: 3,
      ghostN: 10,
      ghostR: 0.9 * 2.4,
      ghostA: 0.5,
      particles: 3,
      partR: 1.2 * 2.4,
      partRDepth: 1.6 * 2.4,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  'working@64': {
    mode: 'orbits',
    speed: 1.885,
    opts: {
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
  },
  'searching@20': {
    mode: 'globe',
    speed: 2.665,
    opts: {
      latRings: 6,
      lonDensity: 14,
      rBase: 0.6 * 1.75,
      rDepth: 1.7 * 1.75,
      rBoost: 1,
      inkFar: 0.62,
      inkSpan: 0.54,
      rsPow: 0.6,
      rMin: 0.3,
      scanMul: 4.335,
      dimBase: 0.45,
    },
  },
  'searching@64': {
    mode: 'globe',
    speed: 2.015,
    opts: {
      latRings: 11,
      lonDensity: 29,
      rBase: 0.6 * 1.15,
      rDepth: 1.7 * 1.15,
      rBoost: 1,
      inkFar: 0.62,
      inkSpan: 0.54,
      rsPow: 0.6,
      rMin: 0.3,
      scanMul: 4.08,
      dimBase: 0.45,
    },
  },
  'solving@20': {
    mode: 'rubik',
    speed: 1.95,
    opts: {
      latRings: 4,
      lonDensity: 12,
      moveCount: 14,
      rBase: 0.6 * 1.9,
      rDepth: 1.7 * 1.9,
      rActive: 0.3 * 1.9,
      inkFar: 0.62,
      inkSpan: 0.54,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  'solving@64': {
    mode: 'rubik',
    speed: 1.82,
    opts: {
      latRings: 9,
      lonDensity: 24,
      moveCount: 14,
      rBase: 0.6 * 1.05,
      rDepth: 1.7 * 1.05,
      rActive: 0.3 * 1.05,
      inkFar: 0.62,
      inkSpan: 0.54,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  'listening@20': {
    mode: 'wave',
    speed: 3.998,
    opts: {
      rings: 5,
      lonDensity: 13,
      rBase: 0.6 * 1.6,
      rDepth: 1.7 * 1.6,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  'listening@64': {
    mode: 'wave',
    speed: 4.388,
    opts: {
      rings: 9,
      lonDensity: 23,
      rBase: 0.6,
      rDepth: 1.7,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  'connecting@20': {
    mode: 'web',
    speed: 6.63,
    opts: {
      nodeN: 8,
      thr: 0.72,
      signals: 1,
      nodeR: 1.4 * 1.52,
      nodeRDepth: 1.8 * 1.52,
      lineW: 0.8,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  'connecting@64': {
    mode: 'web',
    speed: 3.315,
    opts: {
      nodeN: 41,
      thr: 0.72,
      signals: 7,
      nodeR: 1.4 * 0.95,
      nodeRDepth: 1.8 * 0.95,
      lineW: 0.8,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  'weaving@20': {
    mode: 'braid',
    speed: 2.75,
    opts: {
      strandN: 6,
      turns: 3,
      ghostN: 17,
      rBase: 1.2 * 1.36,
      rDepth: 1.8 * 1.36,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  'weaving@64': {
    mode: 'braid',
    speed: 1.625,
    opts: {
      strandN: 26,
      turns: 3,
      ghostN: 75,
      rBase: 1.2,
      rDepth: 1.8,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  'composing@20': {
    mode: 'ribbon',
    speed: 3.12,
    opts: {
      lanes: 2,
      segs: 20,
      ghostN: 8,
      rBase: 1.1 * 1.073,
      rDepth: 1.7 * 1.073,
      rsPow: 0.6,
      rMin: 0.3,
      spin: 0,
      bandMul: 4.94,
      wobMul: 1,
    },
  },
  'composing@64': {
    mode: 'ribbon',
    speed: 2.34,
    opts: {
      lanes: 3,
      segs: 44,
      ghostN: 38,
      rBase: 1.1 * 0.85,
      rDepth: 1.7 * 0.85,
      rsPow: 0.6,
      rMin: 0.3,
      spin: 0,
      bandMul: 3.9,
      wobMul: 1,
    },
  },
  'shaping@20': {
    mode: 'morph',
    speed: 2.08,
    opts: {
      rDot: 0.021 * 1.011,
      iconD: 0.53,
      rMin: 0.25,
      spread: 1.45,
    },
  },
  'shaping@64': {
    mode: 'morph',
    speed: 2.405,
    opts: {
      rDot: 0.021 * 0.395,
      iconD: Math.max(0.02, 0.702),
      rMin: 0.25,
      spread: 1.45,
    },
  },
};

function assertFiniteOpts(opts: OrbPreset['opts']) {
  for (const [key, value] of Object.entries(opts)) {
    if (typeof value === 'number') {
      expect(Number.isFinite(value), `${key} should be finite`).toBe(true);
    }
  }
}

/** 点数相关键的下限：0 是 ring 的 ghostN 哨兵，其余至少 1（iconD 可为小数）。 */
function assertCountFloor(opts: OrbPreset['opts']) {
  const linearKeys = ['orbitN', 'ghostN', 'nodeN', 'strandN', 'signals', 'lanes', 'segs', 'latRings', 'lonDensity', 'rings'] as const;
  for (const key of linearKeys) {
    const v = opts[key];
    if (typeof v !== 'number') continue;
    if (key === 'ghostN' && v === 0) continue;
    expect(v, `${key} below floor`).toBeGreaterThanOrEqual(1);
  }
  if (typeof opts.iconD === 'number') {
    expect(opts.iconD).toBeGreaterThanOrEqual(0.02);
  }
}

describe('resolveOrbVisual', () => {
  it('覆盖全部 14 个 canonical status key', () => {
    expect(TASK_CAPSULE_STATUS_KEYS).toHaveLength(14);
    for (const key of TASK_CAPSULE_STATUS_KEYS) {
      expect(resolveOrbVisual(key)).toEqual(EXPECTED_VISUAL[key]);
    }
  });

  it('thinking 与 planningNext 同纹理', () => {
    expect(resolveOrbVisual('thinking')).toEqual(resolveOrbVisual('planningNext'));
  });

  it('recovering 是唯一带 tint 的 orb', () => {
    const tinted = TASK_CAPSULE_STATUS_KEYS.filter((key) => {
      const visual = resolveOrbVisual(key);
      return visual.kind === 'orb' && visual.tint != null;
    });
    expect(tinted).toEqual(['recovering']);
  });
});

describe('resolveOrbPreset', () => {
  it('breathing@20：ring 模式与缩放后的 lanes/segs/点径', () => {
    const preset = resolveOrbPreset('breathing', 20);
    expect(preset.mode).toBe('ring');
    expect(preset.speed).toBe(3.78);
    expect(preset.opts.lanes).toBe(2);
    expect(preset.opts.segs).toBe(15);
    expect(preset.opts.ghostN).toBe(0);
    expect(preset.opts.faceOn).toBe(1);
    expect(preset.opts.rBase).toBeCloseTo(1.1 * 1.622, 10);
    expect(preset.opts.rDepth).toBeCloseTo(1.7 * 1.622, 10);
    expect(preset.opts.spin).toBe(0);
    expect(preset.opts.bandMul).toBe(3.968);
    expect(preset.opts.wobMul).toBe(0.565);
  });

  it('breathing@64：独立 64 档，不是 20 档放大', () => {
    const preset = resolveOrbPreset('breathing', 64);
    expect(preset.mode).toBe('ring');
    expect(preset.speed).toBe(3.24);
    expect(preset.opts.lanes).toBe(3);
    expect(preset.opts.segs).toBe(44);
    expect(preset.opts.ghostN).toBe(0);
    expect(preset.opts.rBase).toBeCloseTo(1.1 * 0.956, 10);
    expect(preset.opts.rDepth).toBeCloseTo(1.7 * 0.956, 10);
    expect(preset.opts.bandMul).toBe(3.627);
    expect(preset.opts.wobMul).toBe(0.368);
  });

  it('working@20：orbits + 线性 count 缩放', () => {
    const preset = resolveOrbPreset('working', 20);
    expect(preset.mode).toBe('orbits');
    expect(preset.speed).toBe(3.9);
    expect(preset.opts.orbitN).toBe(3);
    expect(preset.opts.ghostN).toBe(10);
    expect(preset.opts.ghostR).toBeCloseTo(0.9 * 2.4, 10);
    expect(preset.opts.partR).toBeCloseTo(1.2 * 2.4, 10);
    expect(preset.opts.partRDepth).toBeCloseTo(1.6 * 2.4, 10);
    expect(preset.opts.particles).toBe(3);
    expect(preset.opts.ghostA).toBe(0.5);
  });

  it('composing@64：ribbon + √count 成对缩放 + extra', () => {
    const preset = resolveOrbPreset('composing', 64);
    expect(preset.mode).toBe('ribbon');
    expect(preset.speed).toBe(2.34);
    expect(preset.opts.lanes).toBe(3);
    expect(preset.opts.segs).toBe(44);
    expect(preset.opts.ghostN).toBe(38);
    expect(preset.opts.rBase).toBeCloseTo(1.1 * 0.85, 10);
    expect(preset.opts.rDepth).toBeCloseTo(1.7 * 0.85, 10);
    expect(preset.opts.spin).toBe(0);
    expect(preset.opts.bandMul).toBe(3.9);
    expect(preset.opts.wobMul).toBe(1);
  });

  it('九个 mode 都能解析出合法的 12 档', () => {
    for (const texture of TEXTURES) {
      const preset = resolveOrbPreset(texture, 12);
      expect(preset.speed, `${texture} speed`).toBeGreaterThan(0);
      expect(Number.isFinite(preset.speed), `${texture} speed finite`).toBe(true);
      assertFiniteOpts(preset.opts);
      assertCountFloor(preset.opts);
    }
  });

  it('20 / 64 档解析结果与改动前逐字段完全一致', () => {
    for (const [key, expected] of Object.entries(LEGACY_PRESETS)) {
      const [texture, sizeStr] = key.split('@') as [OrbTexture, string];
      const size = Number(sizeStr) as 20 | 64;
      const actual = resolveOrbPreset(texture, size);
      expect(actual.mode).toBe(expected.mode);
      expect(actual.speed).toBe(expected.speed);
      expect(Object.keys(actual.opts).sort()).toEqual(Object.keys(expected.opts).sort());
      for (const [optKey, expectedVal] of Object.entries(expected.opts)) {
        const actualVal = actual.opts[optKey];
        if (typeof expectedVal === 'number' && typeof actualVal === 'number') {
          expect(actualVal, `${key}.${optKey}`).toBeCloseTo(expectedVal, 10);
        } else {
          expect(actualVal).toEqual(expectedVal);
        }
      }
    }
  });

  it('同入参两次调用结果逐位相等（无模块级缓存副作用）', () => {
    const a = resolveOrbPreset('breathing', 20);
    const b = resolveOrbPreset('breathing', 20);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe('pickOrbPresetSize', () => {
  it('≤15 → 12，≤28 → 20，否则 64', () => {
    expect(pickOrbPresetSize(10)).toBe(12);
    expect(pickOrbPresetSize(12)).toBe(12);
    expect(pickOrbPresetSize(15)).toBe(12);
    expect(pickOrbPresetSize(16)).toBe(20);
    expect(pickOrbPresetSize(20)).toBe(20);
    expect(pickOrbPresetSize(28)).toBe(20);
    expect(pickOrbPresetSize(29)).toBe(64);
    expect(pickOrbPresetSize(64)).toBe(64);
  });
});
