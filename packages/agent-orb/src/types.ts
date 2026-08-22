import type { TaskCapsuleStatusKind } from '@tabtin/contracts/agent';

/**
 * Agent 状态 Orb —— 跨任务类型接缝。
 *
 * 本包的存在理由：把「Agent 在用哪类能力」这条信息从颜色里拆出来，交给单色点云球体的
 * 运动纹理承载，颜色则专管「要不要你出手」。铁律是 **动 = 它在干活，静 = 球在你这边**。
 *
 * 本包零平台依赖：只产出绘制指令（{@link OrbFrame}），由 Electron / iOS / Android 各自落到画布。
 */

// ─── 纹理与模式 ──────────────────────────────────────────────────────

/**
 * 产品语言里的九种「劳作方式」。用户不需要学名字，只需建立「这个纹理 ≈ 这类活」的直觉。
 */
export type OrbTexture =
  | 'working'
  | 'searching'
  | 'solving'
  | 'listening'
  | 'connecting'
  | 'weaving'
  | 'composing'
  | 'breathing'
  | 'shaping';

/** 绘制器实现名（上游库口径）。纹理 → 模式是多对一：`ring` 与 `ribbon` 共用一个绘制器。 */
export type OrbMode =
  | 'globe'
  | 'orbits'
  | 'rubik'
  | 'wave'
  | 'web'
  | 'braid'
  | 'ribbon'
  | 'ring'
  | 'morph';

/**
 * 12 / 20 / 64 三档，各自独立手调，不是互相缩放。
 * 中间尺寸由调用方选档 + 画布缩放实现。
 */
export type OrbPresetSize = 12 | 20 | 64;

// ─── 视觉决策 ────────────────────────────────────────────────────────

/** 静态色点的语义色。与三端既有 status 色板对齐，本包不产出具体色值。 */
export type OrbDotTone = 'muted' | 'warning' | 'success' | 'critical';

/**
 * 一个 status key 该长什么样。
 *
 * `orb` 只发给「真的在动」的状态；终态与等待人工介入的状态一律给 `dot` 或 `dashedRing`——
 * 它们的本质是「不在动了」，配一个持续转的球会误导用户以为还在跑。
 */
export type OrbVisual =
  | { kind: 'orb'; texture: OrbTexture; tint?: 'warning' }
  | { kind: 'dot'; tone: OrbDotTone }
  | { kind: 'dashedRing' };

// ─── 调参预设 ────────────────────────────────────────────────────────

/** 归一化前的 8bit rgb 三元组。 */
export type OrbRgb = readonly [number, number, number];

/**
 * 绘制器入参。键名与取值直接沿用上游手调结果，故为开放字典而非穷举字段——
 * 每个 mode 只认自己那几个键。
 */
export type OrbPaintOptions = Record<string, number | OrbRgb | undefined>;

export interface OrbPreset {
  mode: OrbMode;
  /** 烘进预设的基础节奏；相位乘它之后才交给绘制器。 */
  speed: number;
  opts: OrbPaintOptions;
}

// ─── 绘制指令 ────────────────────────────────────────────────────────

/**
 * 景深墨值 ∈ [0,1]：0 = 离观察者最近（最浓），1 = 最远（最淡）。
 *
 * 它承载的是**灰度阶梯**而不是透明度——点云的立体感全靠这条阶梯。
 * 不要把它折算进 alpha：折算只在纯黑 / 纯白底上近似成立，落到真实表面色上层次会塌，
 * 而且浅色主题下极易把浓淡关系写反。一律用 {@link OrbInkResolver} 解析成最终颜色。
 */
export type OrbInk = number;

export interface OrbDot {
  x: number;
  y: number;
  /** 半径，逻辑像素 */
  r: number;
  /** 源 alpha ∈ [0,1]，未经景深调制 */
  a: number;
  ink: OrbInk;
}

export interface OrbLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  a: number;
  /** 线宽，逻辑像素 */
  w: number;
  ink: OrbInk;
}

/** 解析后的最终描画色。 */
export interface OrbInkColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * 一帧的平台无关绘制指令。坐标系原点在画布左上角，边长为 {@link OrbFrame.size}；
 * DPR 与「按 cssSize 缩放」由渲染层用变换矩阵处理，本包不关心。
 */
export interface OrbFrame {
  size: number;
  /** 已按 z 由远及近排好序，渲染层按数组顺序画即可 */
  dots: OrbDot[];
  lines: OrbLine[];
  dark: boolean;
  /** 染色 orb 的基色。仅 `recovering` 会用到；未染色时为 undefined，走灰阶阶梯。 */
  tint?: OrbRgb;
}

/**
 * 把**点**的景深墨值解析成最终 rgba。**三端必须共用这一份公式**，否则同一帧在不同平台上深浅不一。
 */
export type OrbDotInkResolver = (
  frame: Pick<OrbFrame, 'dark' | 'tint'>,
  ink: OrbInk,
  alpha: number,
) => OrbInkColor;

/**
 * 把**线**的景深墨值解析成最终 rgba。
 *
 * 与点分成两个函数是刻意的：上游的连线**从不染色**，染色只作用于点。
 * 唯一染色的状态 `recovering` 走的恰好是带连线的 `connecting` 纹理，
 * 若线也套用点的染色公式，整张网会被染黄。签名上不接受 `tint` 就是为了让这种误用编译不过。
 */
export type OrbLineInkResolver = (
  frame: Pick<OrbFrame, 'dark'>,
  ink: OrbInk,
  alpha: number,
) => OrbInkColor;

/**
 * 收束成什么形状。
 *
 * - `dot`：塌缩成一颗实心点。**默认**，与产品全局「终态 = 静止实心色点」同语汇，最安静。
 * - `brain`：点云重组成 lucide `Brain` 的轮廓。只给「思考」这类语义用——脑是**具象**的，
 *   放到 search / terminal 这些活儿上就成了错的比喻。代价是墨量约为 `dot` 的两倍，
 *   历史区里更抢眼；且 12 档认不出，会自动退回 `dot`（见 `applySettle`）。
 */
export type OrbSettleShape = 'dot' | 'brain';

export interface OrbPaintInput {
  mode: OrbMode;
  /** 逻辑画布边长，通常等于 {@link OrbPresetSize} */
  size: number;
  /** 已乘过 {@link OrbPreset.speed} 的相位 */
  t: number;
  dark: boolean;
  opts: OrbPaintOptions;
  /**
   * 收束进度 ∈ [0,1]，取自 {@link OrbClockState.settle}；缺省 0 = 运行态。
   *
   * **渲染层不要自己实现收束**——放在这里才能保证三端塌缩曲线一致。
   */
  settle?: number;
  /** 收成什么形状，缺省 `dot`。见 {@link OrbSettleShape}。 */
  settleShape?: OrbSettleShape;
}

// ─── 生命周期 ────────────────────────────────────────────────────────

/**
 * 怎么收场。`done` = 正常结束，滑停；`interrupt` = 需要你确认 / 出错，急停后交棒给静态色点。
 * 两者是**同一个动作原语**，只差停得多急。
 */
export type OrbResolveKind = 'done' | 'interrupt';

export interface OrbResolveState {
  kind: OrbResolveKind;
  startMs: number;
  durationMs: number;
  /** 触发收束那一刻的实际值——允许在收束中途再次触发而不跳变 */
  fromTimeScale: number;
  fromSettle: number;
}

/**
 * 相位累积器 + 收束状态。
 *
 * 上游库把时间直接映射成 `t = now / 1000 * speed`，那样没有可以缓到 0 的旋钮，做不了减速滑停。
 * 改成按 `dt` 累积后，{@link OrbClockState.timeScale} 从 1 缓到 0 就是「惯性停住」，
 * 换纹理时相位也不会突变。
 */
export interface OrbClockState {
  phase: number;
  /** 运动速率系数，1 = 全速，0 = 停住 */
  timeScale: number;
  /**
   * 收束程度 ∈ [0,1]。0 = 正常起伏，1 = 起伏振幅归零、波纹平复成完美等距点环。
   *
   * 退场必须同时推进 `timeScale` 和 `settle`：只停不收会冻在一个随意的乱帧上，
   * 起伏还歪着，看着像卡死而不是做完。
   */
  settle: number;
  resolve?: OrbResolveState;
}

// ─── 供实现文件对齐的函数签名 ────────────────────────────────────────

export type ResolveOrbVisual = (status: TaskCapsuleStatusKind) => OrbVisual;
export type ResolveOrbPreset = (texture: OrbTexture, size: OrbPresetSize) => OrbPreset;
export type PickOrbPresetSize = (cssSize: number) => OrbPresetSize;
export type BuildOrbFrame = (input: OrbPaintInput) => OrbFrame;
export type CreateOrbClock = () => OrbClockState;
export type AdvanceOrbClock = (
  state: OrbClockState,
  dtSeconds: number,
  nowMs: number,
) => OrbClockState;
export type BeginOrbResolve = (
  state: OrbClockState,
  kind: OrbResolveKind,
  nowMs: number,
) => OrbClockState;
export type IsOrbResting = (state: OrbClockState) => boolean;
