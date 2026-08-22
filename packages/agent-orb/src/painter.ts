/**
 * Agent 状态 Orb —— 绘制数学。
 *
 * 移植自 Thinking Orbs（作者 Jakub Antalik，MIT）。
 * 原实现直接往 CanvasRenderingContext2D 上画；这里改成返回平台无关的 {@link OrbFrame}
 * 绘制指令，供 Electron / iOS / Android 各自落到画布。
 *
 * 哈希常数 43758.5453 必须原样保留——跨端 fixture 靠它对齐浮点精度
 * （*43758.5453 会把浮点误差放大四万倍，移植端必须用 double）。
 */

import type {
  OrbDot,
  OrbDotInkResolver,
  OrbFrame,
  OrbInkColor,
  OrbLine,
  OrbLineInkResolver,
  OrbMode,
  OrbPaintInput,
  OrbPaintOptions,
  OrbRgb,
  OrbSettleShape,
} from './types.js';
import { type BrainTarget, buildBrainTargets } from './brainShape.js';

const TAU = Math.PI * 2;

const fract = (x: number): number => x - Math.floor(x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (x: number): number => x * x * (3 - 2 * x);

/** 内部点：排序用 z；ink / 源 alpha 原样写出，景深颜色由 {@link resolveOrbDotInk} 解析。 */
interface RawDot {
  x: number;
  y: number;
  z: number;
  r: number;
  ink: number;
  a?: number;
}

interface RawLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ink: number;
  a?: number;
  w: number;
}

/** 确定性 hash。导出供跨端 fixture 对齐。 */
export function hash2(x: number, y: number): number {
  return fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453);
}

/** 双线性插值的 value noise（smoothstep 过渡）。 */
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let fx = x - xi;
  let fy = y - yi;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** 斐波那契球面均匀布点（黄金角 π(3-√5)）。 */
function fibonacciSphere(i: number, n: number): [number, number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(1 - y * y);
  const th = i * golden;
  return [r * Math.cos(th), y, r * Math.sin(th)];
}

/** 最短角差，用于扫描线判定「当前经度离扫描面多远」。 */
const angleDelta = (a: number, b: number): number =>
  Math.atan2(Math.sin(a - b), Math.cos(a - b));

/**
 * 相机：先绕 Y 轴 yaw，再绕 X 轴 pitch，正交投影到屏幕。
 * 返回 [screenX, screenY, depthZ]；depthZ 越大越靠前。
 */
function camera(
  yaw: number,
  pitch: number,
  cx: number,
  cy: number,
  scale: number,
): (x: number, y: number, z: number) => [number, number, number] {
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const sy = Math.sin(yaw);
  const cy2 = Math.cos(yaw);
  return (x, y, z) => {
    const x1 = x * cy2 + z * sy;
    const z1 = -x * sy + z * cy2;
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    return [cx + x1 * scale, cy - y1 * scale, z2];
  };
}

/** 点半径随画布尺寸的缩放曲线。 */
const dotScale = (size: number, pow = 0.6): number => Math.pow(size / 300, pow);

function optNum(opts: OrbPaintOptions, key: string, fallback: number): number {
  const v = opts[key];
  return typeof v === 'number' ? v : fallback;
}

function optTint(opts: OrbPaintOptions): OrbRgb | undefined {
  const t = opts.tint;
  if (Array.isArray(t) && t.length === 3 && typeof t[0] === 'number') {
    return t as OrbRgb;
  }
  return undefined;
}

/**
 * 写出点指令：源 alpha 过滤、rMin 钳制、按 z 排序；ink 原样携带，不折进 alpha。
 * 与 demo `paintDots` 的过滤/排序一致，颜色解析交给 {@link resolveOrbDotInk}。
 */
function collectDots(raw: RawDot[], rMin: number): OrbDot[] {
  raw.sort((a, b) => a.z - b.z);
  const out: OrbDot[] = [];
  for (const d of raw) {
    const alpha = d.a ?? 1;
    if (alpha < 0.02) continue;
    const ink = Math.min(1, Math.max(0, d.ink));
    out.push({
      x: d.x,
      y: d.y,
      r: Math.max(rMin, d.r),
      a: alpha,
      ink,
    });
  }
  return out;
}

function collectLines(raw: RawLine[]): OrbLine[] {
  const out: OrbLine[] = [];
  for (const l of raw) {
    const alpha = l.a ?? 1;
    if (alpha < 0.02) continue;
    const ink = Math.min(1, Math.max(0, l.ink));
    out.push({
      x1: l.x1,
      y1: l.y1,
      x2: l.x2,
      y2: l.y2,
      a: alpha,
      w: l.w,
      ink,
    });
  }
  return out;
}

/**
 * 把点的景深墨值解析成最终 rgba。与 demo `paintDots`（第 539–543 行）逐字一致。
 */
export const resolveOrbDotInk: OrbDotInkResolver = (frame, ink, alpha): OrbInkColor => {
  const clamped = Math.min(1, Math.max(0, ink));
  if (frame.tint) {
    return {
      r: frame.tint[0],
      g: frame.tint[1],
      b: frame.tint[2],
      a: alpha * (frame.dark ? 1 - clamped : 1 - clamped * 0.4),
    };
  }
  const lum = Math.round((frame.dark ? 1 - clamped : clamped) * 255);
  return { r: lum, g: lum, b: lum, a: alpha };
};

/**
 * 把线的景深墨值解析成最终 rgba。与 demo `paintLines`（第 554–556 行）逐字一致。
 * 故意不接受 tint：连线从不染色。
 */
export const resolveOrbLineInk: OrbLineInkResolver = (frame, ink, alpha): OrbInkColor => {
  const clamped = Math.min(1, Math.max(0, ink));
  const lum = Math.round((frame.dark ? 1 - clamped : clamped) * 255);
  return { r: lum, g: lum, b: lum, a: alpha };
};

/* ---------------- globe / searching：扫描面掠过点阵球 ---------------- */
function drawGlobe(size: number, t: number, o: OrbPaintOptions): { dots: RawDot[]; lines: RawLine[] } {
  const R = (size / 2) * 0.82;
  const proj = camera(t * 0.5, 0.4 + 0.06 * Math.sin(t * 0.35), size / 2, size / 2, R);
  const scanAngle = t * (0.5 + 1.2 * optNum(o, 'scanMul', 1));
  const s = dotScale(size, optNum(o, 'rsPow', 0.6));
  const dim = optNum(o, 'dimBase', 1);
  const rings = optNum(o, 'latRings', 17);
  const lonN = optNum(o, 'lonDensity', 44);
  const rBase = optNum(o, 'rBase', 0.6);
  const rDepth = optNum(o, 'rDepth', 1.7);
  const rBoost = optNum(o, 'rBoost', 1);
  const inkFar = optNum(o, 'inkFar', 0.62);
  const inkSpan = optNum(o, 'inkSpan', 0.54);
  const dots: RawDot[] = [];
  for (let i = 0; i <= rings; i++) {
    const lat = -Math.PI / 2 + (i / rings) * Math.PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    const n = Math.max(1, Math.round(Math.abs(cl) * lonN));
    for (let j = 0; j < n; j++) {
      const lon = (j / n) * TAU;
      const [x, y, z] = proj(cl * Math.cos(lon), sl, cl * Math.sin(lon));
      const depth = (z + 1) / 2;
      const d = angleDelta(lon + t * 0.5, scanAngle);
      // 高斯窗：只有靠近扫描面、且朝向观察者的点被点亮
      const glow = Math.exp(-(d * d) / 0.18) * Math.max(0, z);
      dots.push({
        x,
        y,
        z,
        r: (rBase + rDepth * depth + rBoost * glow) * s,
        ink: inkFar - inkSpan * depth,
        a: dim + (1 - dim) * Math.min(1, glow),
      });
    }
  }
  return { dots, lines: [] };
}

/* ---------------- orbits / working：粒子沿多条倾斜轨道并行跑 ---------------- */
function drawOrbits(size: number, t: number, o: OrbPaintOptions): { dots: RawDot[]; lines: RawLine[] } {
  const R = (size / 2) * 0.82;
  const proj = camera(t * 0.12, 0.3, size / 2, size / 2, 1);
  const s = dotScale(size, optNum(o, 'rsPow', 0.6));
  const orbitN = optNum(o, 'orbitN', 12);
  const ghostN = optNum(o, 'ghostN', 40);
  const ghostR = optNum(o, 'ghostR', 0.9);
  const ghostA = optNum(o, 'ghostA', 0.5);
  const particles = optNum(o, 'particles', 3);
  const partR = optNum(o, 'partR', 1.2);
  const partRDepth = optNum(o, 'partRDepth', 1.6);
  const dots: RawDot[] = [];
  for (let k = 0; k < orbitN; k++) {
    const h1 = hash2(k, 1.7);
    const h2 = hash2(k, 5.2);
    const h3 = hash2(k, 8.9);
    const radius = R * (0.45 + 0.52 * h1);
    const phi = h1 * TAU;
    const theta = Math.acos(2 * h2 - 1);
    const nx = Math.sin(theta) * Math.cos(phi);
    const ny = Math.cos(theta);
    const nz = Math.sin(theta) * Math.sin(phi);
    let ux = -ny;
    let uy = nx;
    let uz = 0;
    const len = Math.max(1e-6, Math.hypot(ux, uy));
    ux /= len;
    uy /= len;
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;
    const speed = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1);
    const at = (ang: number): [number, number, number] =>
      proj(
        (ux * Math.cos(ang) + vx * Math.sin(ang)) * radius,
        (uy * Math.cos(ang) + vy * Math.sin(ang)) * radius,
        (uz * Math.cos(ang) + vz * Math.sin(ang)) * radius,
      );
    for (let g = 0; g < ghostN; g++) {
      const [x, y, z] = at((g / ghostN) * TAU);
      const depth = (z / radius + 1) / 2;
      dots.push({ x, y, z, r: ghostR * s, ink: 0.72, a: ghostA * (0.4 + 0.6 * depth) });
    }
    for (let p = 0; p < particles; p++) {
      const [x, y, z] = at(t * speed + (p / particles) * TAU + h2 * 6);
      const depth = (z / radius + 1) / 2;
      dots.push({ x, y, z, r: (partR + partRDepth * depth) * s, ink: 0.3 - 0.22 * depth });
    }
  }
  return { dots, lines: [] };
}

/* ---------------- wave / listening：纬度环半径起伏 ---------------- */
function drawWave(size: number, t: number, o: OrbPaintOptions): { dots: RawDot[]; lines: RawLine[] } {
  const R = (size / 2) * 0.874;
  const proj = camera(t * 0.18, 0.38, size / 2, size / 2, 1);
  const s = dotScale(size, optNum(o, 'rsPow', 0.6));
  const rings = optNum(o, 'rings', 15);
  const lonDensity = optNum(o, 'lonDensity', 40);
  const rBase = optNum(o, 'rBase', 0.6);
  const rDepth = optNum(o, 'rDepth', 1.7);
  const dots: RawDot[] = [];
  for (let i = 0; i <= rings; i++) {
    const lat = -Math.PI / 2 + (i / rings) * Math.PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    const amp = 0.62 * Math.sin(t * 2.1 - i * 0.52) + 0.38 * Math.sin(t * 1.27 + i * 0.83);
    const rr = R * (0.88 + 0.105 * amp);
    const n = Math.max(1, Math.round(Math.abs(cl) * lonDensity));
    for (let j = 0; j < n; j++) {
      const lon = (j / n) * TAU;
      const [x, y, z] = proj(cl * Math.cos(lon) * rr, sl * rr, cl * Math.sin(lon) * rr);
      const depth = (z / R + 1) / 2;
      const peak = Math.max(0, amp);
      dots.push({
        x,
        y,
        z,
        r: (rBase + rDepth * depth) * (1 + 0.4 * peak) * s,
        ink: 0.66 - 0.56 * depth - 0.1 * peak,
      });
    }
  }
  return { dots, lines: [] };
}

/* ---------------- web / connecting：星座连线 + 数据包沿边跑 ---------------- */
function drawWeb(size: number, t: number, o: OrbPaintOptions): { dots: RawDot[]; lines: RawLine[] } {
  const R = (size / 2) * 0.8 * optNum(o, 'spread', 1);
  const proj = camera(t * 0.12, 0.32, size / 2, size / 2, R);
  const s = dotScale(size, optNum(o, 'rsPow', 0.6));
  const nodeN = optNum(o, 'nodeN', 30);
  const thr = optNum(o, 'thr', 0.72);
  const signals = optNum(o, 'signals', 5);
  const nodeR = optNum(o, 'nodeR', 1.4);
  const nodeRDepth = optNum(o, 'nodeRDepth', 1.8);
  const lineW = optNum(o, 'lineW', 0.8);
  const nodes: [number, number, number][] = [];
  for (let i = 0; i < nodeN; i++) {
    const p = fibonacciSphere(i, nodeN);
    const x = p[0] + 0.6 * (valueNoise(i * 0.31 + 9, t * 0.24) - 0.5);
    const y = p[1] + 0.6 * (valueNoise(i * 0.53 + 27, t * 0.21) - 0.5);
    const z = p[2] + 0.6 * (valueNoise(i * 0.77 + 55, t * 0.27) - 0.5);
    const m = Math.sqrt(x * x + y * y + z * z);
    nodes.push([x / m, y / m, z / m]);
  }
  const lines: RawLine[] = [];
  const dots: RawDot[] = [];
  for (let i = 0; i < nodeN; i++) {
    for (let j = i + 1; j < nodeN; j++) {
      const dx = nodes[i][0] - nodes[j][0];
      const dy = nodes[i][1] - nodes[j][1];
      const dz = nodes[i][2] - nodes[j][2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= thr) continue;
      const [x1, y1, z1] = proj(...nodes[i]);
      const [x2, y2, z2] = proj(...nodes[j]);
      const depth = ((z1 + z2) / 2 + 1) / 2;
      lines.push({
        x1,
        y1,
        x2,
        y2,
        ink: 0.42,
        a: (1 - dist / thr) * (0.3 + 0.55 * depth),
        w: Math.max(0.6, lineW * s),
      });
    }
  }
  for (let i = 0; i < nodeN; i++) {
    const [x, y, z] = proj(...nodes[i]);
    const depth = (z + 1) / 2;
    const breath = 1 + 0.25 * Math.sin(t * 1.4 + i * 2.7);
    dots.push({
      x,
      y,
      z,
      r: (nodeR + nodeRDepth * depth) * breath * s,
      ink: 0.55 - 0.45 * depth,
    });
  }
  for (let i = 0; i < signals; i++) {
    const beat = Math.floor(t * 0.55 + i * 7.31);
    const a = Math.floor(hash2(beat, i * 3.1 + 1.7) * nodeN);
    const b = Math.floor(hash2(beat, i * 5.7 + 4.2) * nodeN);
    if (a === b) continue;
    const f = fract(t * 0.55 + i * 7.31);
    let px = lerp(nodes[a][0], nodes[b][0], f);
    let py = lerp(nodes[a][1], nodes[b][1], f);
    let pz = lerp(nodes[a][2], nodes[b][2], f);
    const m = Math.max(1e-6, Math.sqrt(px * px + py * py + pz * pz));
    const [x, y, z] = proj(px / m, py / m, pz / m);
    const depth = (z + 1) / 2;
    dots.push({
      x,
      y,
      z,
      r: (nodeR * 1.5 + nodeRDepth * depth) * s,
      ink: 0.05,
      a: 0.5 + 0.5 * depth,
    });
  }
  return { dots, lines };
}

/* ---------------- rubik / solving：条带按 90° 拧动，拧满再倒回 ---------------- */
interface RubikMove {
  axis: number;
  lo: number;
  hi: number;
  ang: number;
}

function buildMoves(n: number): RubikMove[] {
  const moves: RubikMove[] = [];
  for (let i = 0; i < n; i++) {
    const axis = Math.min(2, Math.floor(hash2(i, 2.3) * 3));
    const lo = -1 + 0.5 * Math.min(3, Math.floor(hash2(i, 5.9) * 4));
    const dir = hash2(i, 7.7) < 0.5 ? 1 : -1;
    moves.push({ axis, lo, hi: lo + 0.5, ang: (dir * Math.PI) / 2 });
  }
  return moves;
}

/** 进度表：依次拧完 n 步 → hold → 依次倒回，形成呼吸式循环。 */
function moveSchedule(
  t: number,
  n: number,
  per: number,
  hold: number,
): { amount: number[]; active: number } {
  const period = 2 * n * per + hold;
  const e = t % period;
  const amount = new Array<number>(n).fill(0);
  let active = -1;
  if (e < 2 * n * per) {
    const idx = Math.floor(e / per);
    const f = (e - idx * per) / per;
    const ease = 1 - Math.pow(1 - Math.min(1, f / 0.7), 3);
    if (idx < n) {
      for (let i = 0; i < idx; i++) amount[i] = 1;
      amount[idx] = ease;
      active = idx;
    } else {
      const g = 2 * n - 1 - idx;
      for (let i = 0; i < g; i++) amount[i] = 1;
      amount[g] = 1 - ease;
      active = g;
    }
  }
  return { amount, active };
}

function applyMoves(
  p: [number, number, number],
  moves: RubikMove[],
  sched: { amount: number[]; active: number },
): [number, number, number, boolean] {
  let [x, y, z] = p;
  let onActive = false;
  for (let i = 0; i < moves.length; i++) {
    if (sched.amount[i] <= 0) continue;
    const m = moves[i];
    const sel = m.axis === 0 ? x : m.axis === 1 ? y : z;
    if (sel < m.lo || sel >= m.hi) continue;
    if (i === sched.active) onActive = true;
    const a = m.ang * sched.amount[i];
    const c = Math.cos(a);
    const s = Math.sin(a);
    if (m.axis === 0) {
      const u = y * c - z * s;
      z = y * s + z * c;
      y = u;
    } else if (m.axis === 1) {
      const u = x * c + z * s;
      z = -x * s + z * c;
      x = u;
    } else {
      const u = x * c - y * s;
      y = x * s + y * c;
      x = u;
    }
  }
  return [x, y, z, onActive];
}

function drawRubik(size: number, t: number, o: OrbPaintOptions): { dots: RawDot[]; lines: RawLine[] } {
  const R = (size / 2) * 0.82;
  const proj = camera(t * 0.55, 0.35 + 0.1 * Math.sin(t * 0.9), size / 2, size / 2, R);
  const s = dotScale(size, optNum(o, 'rsPow', 0.6));
  const moveCount = optNum(o, 'moveCount', 14);
  const latRings = optNum(o, 'latRings', 15);
  const lonDensity = optNum(o, 'lonDensity', 40);
  const rBase = optNum(o, 'rBase', 0.6);
  const rDepth = optNum(o, 'rDepth', 1.7);
  const rActive = optNum(o, 'rActive', 0.3);
  const inkFar = optNum(o, 'inkFar', 0.62);
  const inkSpan = optNum(o, 'inkSpan', 0.54);
  const moves = buildMoves(moveCount);
  const sched = moveSchedule(t, moveCount, 0.42, 1.2);
  const dots: RawDot[] = [];
  for (let i = 0; i <= latRings; i++) {
    const lat = -Math.PI / 2 + (i / latRings) * Math.PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    const n = Math.max(1, Math.round(Math.abs(cl) * lonDensity));
    for (let j = 0; j < n; j++) {
      const lon = (j / n) * TAU;
      const [px, py, pz, hot] = applyMoves(
        [cl * Math.cos(lon), sl, cl * Math.sin(lon)],
        moves,
        sched,
      );
      const [x, y, z] = proj(px, py, pz);
      const depth = (z + 1) / 2;
      dots.push({
        x,
        y,
        z,
        r: (rBase + rDepth * depth + (hot ? rActive : 0)) * s,
        ink: inkFar - inkSpan * depth - (hot ? 0.14 : 0),
      });
    }
  }
  return { dots, lines: [] };
}

/* ---------------- ribbon / composing + ring / breathing（共用画笔） ----------------
 * faceOn=1 时取消相机倾斜、把起伏挪到半径上，就从「斜挂的绶带」变成「正对观察者的呼吸环」。 */
function drawRibbon(size: number, t: number, o: OrbPaintOptions): { dots: RawDot[]; lines: RawLine[] } {
  const R = (size / 2) * 0.78;
  const spin = optNum(o, 'spin', 1);
  const pitch = 0.3;
  const proj = camera(t * 0.1 * spin, pitch, size / 2, size / 2, 1);
  const s = dotScale(size, optNum(o, 'rsPow', 0.6));
  const ghostN = optNum(o, 'ghostN', 150);
  const faceOn = optNum(o, 'faceOn', 0);
  const wobMul = optNum(o, 'wobMul', 1);
  const bandMul = optNum(o, 'bandMul', 1);
  const lanes = optNum(o, 'lanes', 5);
  const segs = optNum(o, 'segs', 88);
  const rBase = optNum(o, 'rBase', 1.1);
  const rDepth = optNum(o, 'rDepth', 1.7);
  const dots: RawDot[] = [];
  for (let i = 0; i < ghostN; i++) {
    const p = fibonacciSphere(i, ghostN);
    const [x, y, z] = proj(p[0] * R, p[1] * R, p[2] * R);
    dots.push({ x, y, z, r: 0.8 * s, ink: 0.78, a: 0.1 + 0.22 * ((z / R + 1) / 2) });
  }
  const yaw = t * 0.24 * spin;
  const tilt = faceOn ? -pitch : 0.55 + 0.3 * Math.sin(t * 0.18) * spin;
  const ax = Math.cos(yaw);
  const ay = 0;
  const az = Math.sin(yaw);
  const bx = -az * Math.sin(tilt);
  const by = Math.cos(tilt);
  const bz = ax * Math.sin(tilt);
  const cx3 = ay * bz - az * by;
  const cy3 = az * bx - ax * bz;
  const cz3 = ax * by - ay * bx;
  const wob = 0.23 * wobMul;
  const baseR = faceOn ? R / (1 + 0.85 * wob) : R;
  const laneN = Math.max(1, Math.round(lanes * bandMul));
  for (let li = 0; li < laneN; li++) {
    const off = (li - (laneN - 1) / 2) * 0.075;
    const edge = Math.abs(li - (laneN - 1) / 2) / Math.max(1, (laneN - 1) / 2);
    for (let si = 0; si < segs; si++) {
      const u = (si / segs) * TAU;
      const wave =
        (0.16 * Math.sin(u * 3 - t * 1.7 + li * 0.22) + 0.07 * Math.sin(u * 5 + t * 1.1)) *
        wobMul;
      const radial = faceOn ? 1 + wave : 1;
      const lateral = faceOn ? off : off + wave;
      const px = ax * Math.cos(u) + bx * Math.sin(u) + cx3 * lateral;
      const py = ay * Math.cos(u) + by * Math.sin(u) + cy3 * lateral;
      const pz = az * Math.cos(u) + bz * Math.sin(u) + cz3 * lateral;
      const m = Math.sqrt(px * px + py * py + pz * pz);
      const rr = baseR * radial;
      const [x, y, z] = proj((px / m) * rr, (py / m) * rr, (pz / m) * rr);
      const depth = (z / R + 1) / 2;
      dots.push({
        x,
        y,
        z,
        r: (rBase + rDepth * depth) * (1 - 0.25 * edge) * s,
        ink: 0.52 - 0.44 * depth + 0.18 * edge,
        a: 0.4 + 0.6 * depth,
      });
    }
  }
  return { dots, lines: [] };
}

/* ---------------- braid / weaving：三股绕球编织 ---------------- */
function drawBraid(size: number, t: number, o: OrbPaintOptions): { dots: RawDot[]; lines: RawLine[] } {
  const R = (size / 2) * 0.76;
  const proj = camera(t * 0.4, 0.3, size / 2, size / 2, 1);
  const s = dotScale(size, optNum(o, 'rsPow', 0.6));
  const ghostN = optNum(o, 'ghostN', 150);
  const strandN = optNum(o, 'strandN', 52);
  const turns = optNum(o, 'turns', 3);
  const rBase = optNum(o, 'rBase', 1.2);
  const rDepth = optNum(o, 'rDepth', 1.8);
  const dots: RawDot[] = [];
  for (let i = 0; i < ghostN; i++) {
    const p = fibonacciSphere(i, ghostN);
    const [x, y, z] = proj(p[0] * R, p[1] * R, p[2] * R);
    dots.push({ x, y, z, r: 0.8 * s, ink: 0.78, a: 0.1 + 0.22 * ((z / R + 1) / 2) });
  }
  for (let strand = 0; strand < 3; strand++) {
    const phase = (strand / 3) * TAU;
    for (let k = 0; k < strandN; k++) {
      const axis = (fract(k / strandN + t * 0.045) * 2 - 1) * 0.96;
      const ring = Math.sqrt(Math.max(0, 1 - axis * axis));
      const fade = Math.min(1, (1 - Math.abs(axis)) / 0.1);
      const ang = axis * Math.PI * turns + phase;
      const puff = 1 + 0.075 * Math.sin(axis * Math.PI * turns * 2 + phase * 2 + t * 0.8);
      const rr = ring * R * puff;
      const [x, y, z] = proj(Math.cos(ang) * rr, axis * R * puff, Math.sin(ang) * rr);
      const depth = (z / R + 1) / 2;
      dots.push({
        x,
        y,
        z,
        r: (rBase + rDepth * depth) * s,
        ink: 0.55 - 0.45 * depth,
        a: fade * (0.45 + 0.55 * depth),
      });
    }
  }
  return { dots, lines: [] };
}

/* ---------------- morph / shaping：点勾轮廓在 圆 → 三角 → 方 之间变形 ---------------- */
/** 把闭合折线包成「按弧长采样」的函数，保证变形过程中点距始终均匀。 */
function closedPolyline(pts: [number, number][]): (u: number) => [number, number] {
  const n = pts.length;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(d);
    total += d;
  }
  return (u) => {
    let want = u * total;
    let i = 0;
    while (want > seg[i] && i < n - 1) {
      want -= seg[i];
      i++;
    }
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const f = seg[i] ? Math.min(1, want / seg[i]) : 0;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
}

const SHAPES: Array<(u: number) => [number, number]> = [
  (u) => {
    const a = -Math.PI / 2 + u * TAU;
    return [Math.cos(a) * 0.24, Math.sin(a) * 0.24];
  },
  closedPolyline([
    [0, -0.26],
    [0.24, 0.16],
    [-0.24, 0.16],
  ]),
  closedPolyline([
    [0, -0.2],
    [0.2, -0.2],
    [0.2, 0.2],
    [-0.2, 0.2],
    [-0.2, -0.2],
  ]),
];

const MORPH_HOLD = 1.4;
const MORPH_TIME = 0.9;
const MORPH_CYCLE = MORPH_HOLD + MORPH_TIME;

function drawMorph(size: number, t: number, o: OrbPaintOptions): { dots: RawDot[]; lines: RawLine[] } {
  const n = SHAPES.length;
  const c = t % (MORPH_CYCLE * n);
  const idx = Math.floor(c / MORPH_CYCLE);
  const local = c - idx * MORPH_CYCLE;
  const blend = local > MORPH_HOLD ? smoothstep((local - MORPH_HOLD) / MORPH_TIME) : 0;
  const spread = optNum(o, 'spread', 1);
  const from = SHAPES[idx];
  const to = SHAPES[(idx + 1) % n];
  const SAMPLES = 160;
  const path: [number, number][] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const u = i / SAMPLES;
    const a = from(u);
    const b = to(u);
    path.push([(a[0] + (b[0] - a[0]) * blend) * spread, (a[1] + (b[1] - a[1]) * blend) * spread]);
  }
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const a = path[i];
    const b = path[(i + 1) % SAMPLES];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(d);
    total += d;
  }
  const count = Math.max(6, Math.round(34 * optNum(o, 'iconD', 1)));
  const rDot = optNum(o, 'rDot', 0.021) * 1.35 * spread;
  const breath = 1 + 0.02 * Math.sin(local * 3.1);
  const dots: RawDot[] = [];
  const half = size / 2;
  let cursor = 0;
  let walked = 0;
  for (let i = 0; i < count; i++) {
    const want = (i / count) * total;
    while (walked + seg[cursor] < want && cursor < SAMPLES - 1) {
      walked += seg[cursor];
      cursor++;
    }
    const a = path[cursor];
    const b = path[(cursor + 1) % SAMPLES];
    const f = seg[cursor] ? Math.min(1, (want - walked) / seg[cursor]) : 0;
    const px = (a[0] + (b[0] - a[0]) * f) * breath;
    const py = (a[1] + (b[1] - a[1]) * f) * breath;
    dots.push({
      x: half + px * size,
      y: half + py * size,
      z: 0,
      r: Math.max(0.35, rDot * size),
      ink: 0.1,
    });
  }
  return { dots, lines: [] };
}

type Painter = (size: number, t: number, o: OrbPaintOptions) => { dots: RawDot[]; lines: RawLine[] };

const PAINTERS: Record<OrbMode, Painter> = {
  globe: drawGlobe,
  orbits: drawOrbits,
  wave: drawWave,
  web: drawWeb,
  rubik: drawRubik,
  ribbon: drawRibbon,
  ring: drawRibbon,
  braid: drawBraid,
  morph: drawMorph,
};

/**
 * 收束形变常量。`settle = 1` 时点云塌缩成**一颗实心点**。
 *
 * 为什么是实心点而不是「完美空心环」：空心轮廓在界面语汇里几乎全都表示待填充（未选中的
 * 单选框、进度条空轨道、虚线占位框），实机上被读成「还没填」。而本产品终态一直是静止实心
 * 色点——收成点之后，球与色点是同一套语汇：**球干完活自己变成了那颗点**。
 */
const SETTLE_PULL = 0.93; // 位置向圆心收拢的比例
const SETTLE_GROW = 1.85; // 点径放大倍率，保证塌缩后是一颗实心点而非一撮碎点
const SETTLE_ALPHA_GAIN = 0.5;
const SETTLE_INK_DARKEN = 0.75;

/**
 * 脑形收束的墨值目标。
 *
 * 不跟 `dot` 一样往 0（最浓）压：脑的轮廓点比一颗点多得多，压到同样浓度会让 20px 的历史行
 * 出现一排抢眼的黑脑（实测墨量是 `dot` 的 4.3 倍）。收敛到中段灰、且不给 alpha 加成，
 * 换来形状清楚但分量克制。
 */
const BRAIN_INK_TARGET = 0.34;
/** 脑轮廓上相邻点本就重叠成线，再放大点径只会糊掉细节 */
const BRAIN_GROW = 0.12;
/** 低于这一档认不出是脑（12px 在 retina 上仅 24 设备像素），退回 dot */
const BRAIN_MIN_SIZE = 20;

/**
 * 按极角把点配到脑轮廓上：每个点走最短路径，重组读作「收拢成形」而不是「乱飞」。
 *
 * 配对基于**未形变**的点位。收束期间 `timeScale → 0`、相位几乎冻结，所以逐帧配对结果稳定；
 * 若改用当前帧位置配对，点越靠近目标角度越会重排，肉眼可见抖动。
 */
function pairToBrain(dots: OrbDot[], size: number): BrainTarget[] {
  const targets = buildBrainTargets(size);
  const c = size / 2;
  const byAngle = (p: { x: number; y: number }): number => Math.atan2(p.y - c, p.x - c);
  const dotOrder = dots
    .map((d, i) => ({ i, a: byAngle(d) }))
    .sort((p, q) => p.a - q.a || p.i - q.i);
  const targetOrder = targets
    .map((t, i) => ({ i, a: byAngle(t) }))
    .sort((p, q) => p.a - q.a || p.i - q.i);
  const paired = new Array<BrainTarget>(dots.length);
  for (let k = 0; k < dotOrder.length; k += 1) {
    const t = targetOrder[Math.floor((k * targetOrder.length) / dotOrder.length)]!;
    paired[dotOrder[k]!.i] = targets[t.i]!;
  }
  return paired;
}

/**
 * 把已排好序的一帧塌缩成终态。**与 mode 无关**——只动 {@link OrbFrame} 的坐标 / 半径 / 墨值，
 * 所以九种纹理都能正确收束。早先的收束靠压平 `wobMul`，而只有 ring / ribbon 有这个旋钮，
 * 其余七种会冻在乱帧上。
 */
function applySettle(frame: OrbFrame, settle: number, shape: OrbSettleShape): OrbFrame {
  const c = frame.size / 2;
  // 连线一律随收束淡出：无论收成点还是脑，都不该有蛛网向外发散
  const lines = frame.lines
    .map((l) => ({ ...l, a: l.a * (1 - settle) }))
    .filter((l) => l.a >= 0.02);

  if (shape === 'brain' && frame.size >= BRAIN_MIN_SIZE) {
    const targets = pairToBrain(frame.dots, frame.size);
    return {
      ...frame,
      lines,
      dots: frame.dots.map((d, i) => {
        const t = targets[i]!;
        return {
          x: d.x + (t.x - d.x) * settle,
          y: d.y + (t.y - d.y) * settle,
          r: d.r * (1 + BRAIN_GROW * settle),
          a: d.a,
          // 收成图形后景深没有意义：墨值不收敛的话轮廓深浅斑驳，读不出形
          ink: d.ink + (BRAIN_INK_TARGET - d.ink) * settle,
        };
      }),
    };
  }

  const pull = 1 - SETTLE_PULL * settle;
  return {
    ...frame,
    lines: lines.map((l) => ({
      ...l,
      x1: c + (l.x1 - c) * pull,
      y1: c + (l.y1 - c) * pull,
      x2: c + (l.x2 - c) * pull,
      y2: c + (l.y2 - c) * pull,
    })),
    dots: frame.dots.map((d) => ({
      x: c + (d.x - c) * pull,
      y: c + (d.y - c) * pull,
      r: d.r * (1 + SETTLE_GROW * settle),
      a: Math.min(1, d.a * (1 + SETTLE_ALPHA_GAIN * settle)),
      ink: d.ink * (1 - SETTLE_INK_DARKEN * settle),
    })),
  };
}

/**
 * ring / ribbon 独有的收束润色：塌缩过程中同时压平径向抖动，环先「站正」再收拢。
 * 纯锦上添花——真正让九种纹理都能收束的是 {@link applySettle}。
 */
function settleOpts(opts: OrbPaintOptions, mode: OrbMode, settle: number): OrbPaintOptions {
  if (settle <= 0 || (mode !== 'ring' && mode !== 'ribbon')) return opts;
  const wob = typeof opts.wobMul === 'number' ? opts.wobMul : 1;
  return { ...opts, wobMul: wob * (1 - settle) };
}

/** 对相同入参产出逐位相同的绘制指令；禁止 Math.random / 时间 / 可变模块级状态。 */
export function buildOrbFrame(input: OrbPaintInput): OrbFrame {
  const { mode, size, t, dark, opts } = input;
  const settle = Math.min(1, Math.max(0, input.settle ?? 0));
  const painter = PAINTERS[mode];
  const paintOpts = settleOpts(opts, mode, settle);
  const { dots: rawDots, lines: rawLines } = painter(size, t, paintOpts);
  const tint = optTint(paintOpts);
  const rMin = optNum(paintOpts, 'rMin', 0.3);
  const frame: OrbFrame = {
    size,
    dots: collectDots(rawDots, rMin),
    lines: collectLines(rawLines),
    dark,
    tint,
  };
  return settle > 0 ? applySettle(frame, settle, input.settleShape ?? 'dot') : frame;
}
