import { describe, expect, it } from 'vitest';
import { buildOrbFrame, hash2, resolveOrbDotInk, resolveOrbLineInk } from '../painter.js';
import { BRAIN_POINT_COUNT, buildBrainTargets } from '../brainShape.js';
import type { OrbMode, OrbPaintInput, OrbPaintOptions } from '../types.js';

/** demo BASE_OPTS 精简副本，仅供本测驱动九种 mode。 */
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
    spin: 0,
    bandMul: 3.627,
    wobMul: 0.368,
  },
  morph: { rDot: 0.021, iconD: 1, rMin: 0.25 },
};

const MODES: OrbMode[] = [
  'globe',
  'orbits',
  'rubik',
  'wave',
  'web',
  'braid',
  'ribbon',
  'ring',
  'morph',
];

function frameInput(mode: OrbMode, overrides?: Partial<OrbPaintInput>): OrbPaintInput {
  return {
    mode,
    size: 64,
    t: 0.6,
    dark: true,
    opts: { ...BASE_OPTS[mode] },
    ...overrides,
  };
}

function radiusVariance(dots: { x: number; y: number }[], size: number): number {
  const cx = size / 2;
  const cy = size / 2;
  const radii = dots.map((d) => Math.hypot(d.x - cx, d.y - cy));
  const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
  return radii.reduce((s, r) => s + (r - mean) ** 2, 0) / radii.length;
}

describe('hash2', () => {
  it('定点值与跨端 fixture 对齐', () => {
    expect(hash2(1, 2)).toBe(0.07390410361767863);
    expect(hash2(0.5, 0.5)).toBe(0.1844875210808823);
    expect(hash2(0, 0)).toBe(0);
    expect(hash2(3, 7)).toBe(0.5414905330253532);
  });
});

describe('buildOrbFrame', () => {
  it('相同入参连续两次结果逐位相等', () => {
    const input = frameInput('globe');
    const a = buildOrbFrame(input);
    const b = buildOrbFrame(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it.each(MODES)('mode=%s 产出有限点且无 NaN', (mode) => {
    const frame = buildOrbFrame(frameInput(mode));
    expect(frame.dots.length).toBeGreaterThan(0);
    for (const d of frame.dots) {
      expect(Number.isFinite(d.x)).toBe(true);
      expect(Number.isFinite(d.y)).toBe(true);
      expect(Number.isFinite(d.r)).toBe(true);
      expect(Number.isFinite(d.a)).toBe(true);
      expect(Number.isFinite(d.ink)).toBe(true);
      expect(d.ink).toBeGreaterThanOrEqual(0);
      expect(d.ink).toBeLessThanOrEqual(1);
    }
    for (const l of frame.lines) {
      expect(Number.isFinite(l.x1)).toBe(true);
      expect(Number.isFinite(l.y1)).toBe(true);
      expect(Number.isFinite(l.x2)).toBe(true);
      expect(Number.isFinite(l.y2)).toBe(true);
      expect(Number.isFinite(l.a)).toBe(true);
      expect(Number.isFinite(l.w)).toBe(true);
      expect(Number.isFinite(l.ink)).toBe(true);
      expect(l.ink).toBeGreaterThanOrEqual(0);
      expect(l.ink).toBeLessThanOrEqual(1);
    }
  });

  it('帧携带 dark / tint；未染色时 tint 为 undefined', () => {
    const dark = buildOrbFrame(frameInput('morph', { dark: true }));
    const light = buildOrbFrame(frameInput('morph', { dark: false }));
    expect(dark.dark).toBe(true);
    expect(light.dark).toBe(false);
    expect(dark.tint).toBeUndefined();
    expect(light.tint).toBeUndefined();

    const tint = [255, 180, 40] as const;
    const tinted = buildOrbFrame(
      frameInput('morph', { dark: true, opts: { ...BASE_OPTS.morph, tint } }),
    );
    expect(tinted.dark).toBe(true);
    expect(tinted.tint).toEqual(tint);
  });

  it('源 alpha 未经景深调制；ink 原样携带', () => {
    const frame = buildOrbFrame(frameInput('morph', { dark: true }));
    // morph 点源 a 缺省为 1，ink 固定 0.1——若误折进 alpha，深色主题会变成 0.9
    for (const d of frame.dots) {
      expect(d.a).toBe(1);
      expect(d.ink).toBeCloseTo(0.1, 5);
    }
  });

  it('orbits 幽灵点源 alpha 随景深变化，且不被 ink 折算', () => {
    // ghostA=0.5 → a = 0.5 * (0.4 + 0.6*depth) ∈ [0.2, 0.5]；ink 固定 0.72
    // 若误把 ink 乘回 alpha（深色 a*(1-ink)），会落到 ≈[0.056, 0.14]，掉出源公式区间
    const ghostA = 0.5;
    const ghostInk = 0.72;
    const aMin = ghostA * 0.4;
    const aMax = ghostA * 1.0;
    const foldedMax = aMax * (1 - ghostInk);
    expect(foldedMax).toBeLessThan(aMin);

    const frame = buildOrbFrame(frameInput('orbits', { dark: true }));
    const ghosts = frame.dots.filter((d) => d.ink === ghostInk);
    expect(ghosts.length).toBeGreaterThan(0);
    let sawVarying = false;
    let prevA: number | undefined;
    for (const d of ghosts) {
      expect(d.a).toBeGreaterThanOrEqual(aMin - 1e-9);
      expect(d.a).toBeLessThanOrEqual(aMax + 1e-9);
      expect(d.a).toBeGreaterThan(foldedMax);
      if (prevA !== undefined && Math.abs(d.a - prevA) > 1e-6) sawVarying = true;
      prevA = d.a;
    }
    expect(sawVarying).toBe(true);
  });

  it('ring 模式下 wobMul:0 的半径方差显著小于 wobMul:0.368', () => {
    // 单 lane 才能把「波纹起伏」从多 lane 同心环结构里拆出来测 settle 语义
    const ringOpts: OrbPaintOptions = {
      lanes: 1,
      segs: 88,
      ghostN: 0,
      faceOn: 1,
      rBase: 1.1,
      rDepth: 1.7,
      rsPow: 0.6,
      rMin: 0.3,
      spin: 0,
      bandMul: 1,
    };
    const settled = buildOrbFrame(frameInput('ring', { opts: { ...ringOpts, wobMul: 0 } }));
    const lively = buildOrbFrame(frameInput('ring', { opts: { ...ringOpts, wobMul: 0.368 } }));
    const v0 = radiusVariance(settled.dots, settled.size);
    const v1 = radiusVariance(lively.dots, lively.size);
    expect(v0).toBeLessThan(1e-6);
    expect(v1).toBeGreaterThan(0.5);
    expect(v0).toBeLessThan(v1 * 0.01);
  });

  it('钳制 rMin，且不引入非有限 alpha', () => {
    const frame = buildOrbFrame(frameInput('ring'));
    for (const d of frame.dots) {
      expect(d.r).toBeGreaterThanOrEqual(0.3);
      expect(Number.isFinite(d.a)).toBe(true);
      expect(d.a).toBeGreaterThan(0);
    }
  });
});

describe('buildOrbFrame · settle 收束', () => {
  /** 点云的外包半径：塌缩到实心点后它必须显著变小 */
  function spread(frame: ReturnType<typeof buildOrbFrame>): number {
    const c = frame.size / 2;
    return Math.max(...frame.dots.map((d) => Math.hypot(d.x - c, d.y - c)));
  }

  it('settle 缺省 / 为 0 时与不传完全一致（运行态零开销）', () => {
    const base = buildOrbFrame(frameInput('globe'));
    const zero = buildOrbFrame(frameInput('globe', { settle: 0 }));
    expect(JSON.stringify(zero)).toBe(JSON.stringify(base));
  });

  // 这条是  的门禁：旧实现靠压平 wobMul 收束，只有 ring / ribbon 有这个旋钮，
  // 其余七种纹理会冻在乱帧上。塌缩改为对 frame 坐标做形变后，九种必须一视同仁。
  it.each(MODES)('mode=%s settle=1 时塌缩成一颗实心点', (mode) => {
    const running = buildOrbFrame(frameInput(mode));
    const settled = buildOrbFrame(frameInput(mode, { settle: 1 }));

    // 收拢：外包半径掉到运行态的两成以内
    expect(spread(settled)).toBeLessThan(spread(running) * 0.2);
    // 实心：点径整体放大，避免塌缩后变成一撮看不清的碎点。
    // 只能比均值不能按下标比——ring / ribbon 被压平 wobMul 后 painter 输出的
    // z 排序与半径分布都变了，同一下标已不是同一个点。
    const meanR = (f: typeof settled): number =>
      f.dots.reduce((s, d) => s + d.r, 0) / f.dots.length;
    expect(meanR(settled)).toBeGreaterThan(meanR(running) * 1.5);
    // 干净：不留向外发散的连线
    expect(settled.lines).toHaveLength(0);
    for (const d of settled.dots) {
      expect(Number.isFinite(d.x) && Number.isFinite(d.y)).toBe(true);
      expect(d.a).toBeGreaterThan(0);
      expect(d.a).toBeLessThanOrEqual(1);
      expect(d.ink).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(MODES)('mode=%s 塌缩随 settle 单调推进，不会中途反弹', (mode) => {
    const spreads = [0, 0.25, 0.5, 0.75, 1].map((s) =>
      spread(buildOrbFrame(frameInput(mode, { settle: s }))),
    );
    for (let i = 1; i < spreads.length; i += 1) {
      expect(spreads[i]!).toBeLessThan(spreads[i - 1]!);
    }
  });

  it('settle 超出 [0,1] 被钳制，不产出反向形变', () => {
    const one = buildOrbFrame(frameInput('ring', { settle: 1 }));
    const over = buildOrbFrame(frameInput('ring', { settle: 4 }));
    const under = buildOrbFrame(frameInput('ring', { settle: -2 }));
    expect(JSON.stringify(over)).toBe(JSON.stringify(one));
    expect(JSON.stringify(under)).toBe(JSON.stringify(buildOrbFrame(frameInput('ring'))));
  });

  it('settleShape 缺省为 dot，与显式传 dot 一致', () => {
    const implicit = buildOrbFrame(frameInput('ring', { settle: 1 }));
    const explicit = buildOrbFrame(frameInput('ring', { settle: 1, settleShape: 'dot' }));
    expect(JSON.stringify(implicit)).toBe(JSON.stringify(explicit));
  });

  it('ring 仍保留 wobMul 压平这层润色：收束中途比同相位运行态更规整', () => {
    const mid = buildOrbFrame(frameInput('ring', { settle: 0.5 }));
    const run = buildOrbFrame(frameInput('ring'));
    // 半径方差按塌缩比例归一后仍应更小，说明 wobMul 确实被压了
    const norm = (1 - 0.93 * 0.5) ** 2;
    expect(radiusVariance(mid.dots, mid.size)).toBeLessThan(
      radiusVariance(run.dots, run.size) * norm,
    );
  });
});

describe('resolveOrbDotInk / resolveOrbLineInk', () => {
  it('同一 ink 在 dark/light 下灰度互补，近处点浓淡方向正确', () => {
    const nearInk = 0.05;
    const midInk = 0.4;
    const darkNear = resolveOrbDotInk({ dark: true }, nearInk, 1);
    const lightNear = resolveOrbDotInk({ dark: false }, nearInk, 1);
    const darkMid = resolveOrbDotInk({ dark: true }, midInk, 1);
    const lightMid = resolveOrbDotInk({ dark: false }, midInk, 1);

    expect(darkMid.r + lightMid.r).toBe(255);
    expect(darkMid.g + lightMid.g).toBe(255);
    expect(darkMid.b + lightMid.b).toBe(255);
    expect(darkNear.r + lightNear.r).toBe(255);

    // 近处（ink≈0）：深色主题接近白，浅色主题接近黑——钉死旧版浅色 alpha*ink 写反
    expect(darkNear.r).toBeGreaterThan(240);
    expect(lightNear.r).toBeLessThan(20);
    expect(darkNear.a).toBe(1);
    expect(lightNear.a).toBe(1);
  });

  it('染色路径调制 alpha，rgb 取 tint', () => {
    const tint = [255, 180, 40] as const;
    const ink = 0.5;
    const dark = resolveOrbDotInk({ dark: true, tint }, ink, 0.8);
    const light = resolveOrbDotInk({ dark: false, tint }, ink, 0.8);
    expect(dark).toEqual({ r: 255, g: 180, b: 40, a: 0.8 * (1 - 0.5) });
    expect(light).toEqual({ r: 255, g: 180, b: 40, a: 0.8 * (1 - 0.5 * 0.4) });
  });

  it('带 tint 时点染色、线仍灰阶', () => {
    const tint = [255, 180, 40] as const;
    const ink = 0.35;
    const alpha = 0.7;
    const frame = { dark: true as const, tint };
    const dot = resolveOrbDotInk(frame, ink, alpha);
    const line = resolveOrbLineInk({ dark: frame.dark }, ink, alpha);

    expect(dot.r).toBe(tint[0]);
    expect(dot.g).toBe(tint[1]);
    expect(dot.b).toBe(tint[2]);

    const lum = Math.round((1 - ink) * 255);
    expect(line).toEqual({ r: lum, g: lum, b: lum, a: alpha });
    expect(line.r).toBe(line.g);
    expect(line.g).toBe(line.b);
    expect(line.r).not.toBe(dot.r);
  });
});

describe('buildOrbFrame · settleShape=brain', () => {
  /** 点到脑轮廓的最近距离——用来判断「落在形上」而不是散在别处 */
  function distToBrain(p: { x: number; y: number }, size: number): number {
    return Math.min(
      ...buildBrainTargets(size).map((t) => Math.hypot(p.x - t.x, p.y - t.y)),
    );
  }

  it.each(MODES)('mode=%s settle=1 时所有点都落在脑轮廓上', (mode) => {
    const frame = buildOrbFrame(frameInput(mode, { settle: 1, settleShape: 'brain' }));
    for (const d of frame.dots) {
      // 容差 0.01 逻辑像素：lerp 到 settle=1 应当精确命中目标
      expect(distToBrain(d, frame.size)).toBeLessThan(0.01);
    }
    expect(frame.lines).toHaveLength(0);
  });

  it('铺满脑轮廓而不是挤在一小段上', () => {
    const frame = buildOrbFrame(frameInput('globe', { settle: 1, settleShape: 'brain' }));
    // 命中的目标点应覆盖轮廓的大部分，否则说明配对退化（多点挤同一目标）
    const hit = new Set(
      frame.dots.map((d) => {
        const targets = buildBrainTargets(frame.size);
        let best = 0;
        let bestD = Infinity;
        targets.forEach((t, i) => {
          const dd = Math.hypot(d.x - t.x, d.y - t.y);
          if (dd < bestD) { bestD = dd; best = i; }
        });
        return best;
      }),
    );
    // 点多于目标时最多命中 BRAIN_POINT_COUNT 个，所以对可用目标数取比
    const reachable = Math.min(frame.dots.length, BRAIN_POINT_COUNT);
    expect(hit.size).toBeGreaterThan(reachable * 0.8);
  });

  it('脑形比点形克制：墨值不压到最浓、alpha 不加成', () => {
    const brain = buildOrbFrame(frameInput('ring', { settle: 1, settleShape: 'brain' }));
    const dot = buildOrbFrame(frameInput('ring', { settle: 1, settleShape: 'dot' }));
    const meanInk = (f: typeof brain): number =>
      f.dots.reduce((s, d) => s + d.ink, 0) / f.dots.length;
    // ink 越小越浓；脑必须比点淡，否则 20px 历史行会出现一排黑脑
    expect(meanInk(brain)).toBeGreaterThan(meanInk(dot));
    const running = buildOrbFrame(frameInput('ring'));
    const meanA = (f: typeof brain): number =>
      f.dots.reduce((s, d) => s + d.a, 0) / f.dots.length;
    expect(meanA(brain)).toBeCloseTo(meanA(running), 5);
  });

  it('12 档认不出脑，自动退回 dot', () => {
    const brain = buildOrbFrame(frameInput('ring', { size: 12, settle: 1, settleShape: 'brain' }));
    const dot = buildOrbFrame(frameInput('ring', { size: 12, settle: 1, settleShape: 'dot' }));
    expect(JSON.stringify(brain)).toBe(JSON.stringify(dot));
  });

  it('settle=0 时 brain 与 dot 都不改运行帧', () => {
    const base = buildOrbFrame(frameInput('globe'));
    const brain = buildOrbFrame(frameInput('globe', { settle: 0, settleShape: 'brain' }));
    expect(JSON.stringify(brain)).toBe(JSON.stringify(base));
  });

  it('重组过程稳定：同一 settle 值重复构建逐位相同（配对不漂移）', () => {
    for (const s of [0.3, 0.6, 0.9]) {
      const a = buildOrbFrame(frameInput('web', { settle: s, settleShape: 'brain' }));
      const b = buildOrbFrame(frameInput('web', { settle: s, settleShape: 'brain' }));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});
