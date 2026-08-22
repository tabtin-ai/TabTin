import React, { useMemo, useRef } from 'react'
import {
  advanceOrbClock,
  beginOrbResolve,
  buildOrbFrame,
  createOrbClock,
  isOrbResting,
  pickOrbPresetSize,
  resolveOrbDotInk,
  resolveOrbLineInk,
  resolveOrbPreset,
  settleOrbClock,
  type OrbClockState,
  type OrbFrame,
  type OrbPaintOptions,
  type OrbResolveKind,
  type OrbRgb,
  type OrbSettleShape,
  type OrbTexture,
} from '@tabtin/agent-orb'
import { useUIStore } from '@stores/useUIStore'
import { useScopedEffect, useScopedEventListener } from '@hooks/spaceActivity'
import { registerOrbDriver } from './orbScheduler'

/**
 * Agent 状态点云球体。唯一把 `@tabtin/agent-orb` 的绘制指令落到 Canvas2D 的地方。
 *
 * 它只表达「Agent 在用哪类能力」这一条信息，**不承载颜色语义**——要不要用户出手由色点管。
 * 所以终态与等待人工介入的状态不要渲染 orb，交给调用方按 `resolveOrbVisual` 分流。
 */
export interface AgentOrbProps {
  texture: OrbTexture
  /** CSS 逻辑边长。≤28 自动走 20 档预设，否则 64 档——两档是独立手调设计，不是缩放关系。 */
  cssSize: number
  /**
   * 染色用的 CSS 变量名（如 `'--warning'`）。仅 `recovering` 用得上；不传则走灰阶。
   * Token 是裸 HSL 分量（`H S% L%`），由组件在 render 阶段解析成 rgb。
   */
  tintVar?: string
  /**
   * 从 undefined 变为有值时开始收束；收束结束触发一次 {@link AgentOrbProps.onRested}。
   * 变回 undefined 表示新一轮开始，组件需要重建 clock（收束后的 clock 回不到运行态）。
   */
  resolve?: OrbResolveKind
  onRested?: () => void
  /**
   * 挂载即终态：直接画静止完美点环，不播收束动画、不触发 {@link AgentOrbProps.onRested}。
   * 与 `resolve` 同时传时以此为准（历史消息初次挂载已结束的思考块用这条）。
   */
  restedAtMount?: boolean
  /**
   * 收成什么形状，缺省 `dot`（一颗安静的实心点）。
   *
   * `brain` 只给「思考」用——脑是具象隐喻，套到 search / terminal 这些活儿上就成了错的比喻。
   * 20px 以下认不出，包内会自动退回 `dot`。
   */
  settleShape?: OrbSettleShape
  /**
   * 走时快慢，缺省 1（预设原速）。乘在 `preset.speed` 上，只改节奏不改形态。
   *
   * 给大尺寸场景用：预设是按 12–64px 的小球调的，那个转速放到上百像素的画面里显得躁。
   * 例如生图占位用 0.4，让 `shaping` 的每个形态停约 1.5 秒，读起来是「轮播」而不是「翻动」。
   */
  speedScale?: number
  /**
   * 外层已统一的减弱动效开关（如 framer `useReducedMotion` / `MotionConfig`）。
   * 传了就用传的；`undefined` 时回退到本组件内部的 `matchMedia`。
   */
  reducedMotion?: boolean
  /** 外部已声明状态文案时传 true，避免屏幕阅读器重复播报 */
  decorative?: boolean
  'aria-label'?: string
  className?: string
}

/** 运行时可变状态：rAF 与 React render 通过这份 ref 交接，避免每帧 setState。 */
interface OrbRuntime {
  canvas: HTMLCanvasElement | null
  clock: OrbClockState
  /** 接缝事实 1：resting 后必须先画过终帧才允许跳过 */
  painted: boolean
  visible: boolean
  texture: OrbTexture
  cssSize: number
  tint?: OrbRgb
  dark: boolean
  resolve?: OrbResolveKind
  /** 上一帧已消费的 resolve，用来侦测「有值 ↔ undefined」边沿 */
  appliedResolve: OrbResolveKind | undefined
  restedNotified: boolean
  /** 挂载即终态：跳过 resolve 边沿与 onRested */
  restedAtMount: boolean
  settleShape: OrbSettleShape
  speedScale: number
  onRested?: () => void
  /** 调用方透传；`undefined` = 走内部 matchMedia */
  reducedMotion?: boolean
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function shouldReduceMotion(runtime: OrbRuntime): boolean {
  if (typeof runtime.reducedMotion === 'boolean') return runtime.reducedMotion
  return prefersReducedMotion()
}

/** TabTin token 是裸 HSL 分量；转成绘制层要的 8bit rgb。失败一律当作不染色。 */
function hslComponentsToRgb(h: number, s: number, l: number): OrbRgb {
  const sat = s / 100
  const light = l / 100
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r1 = 0
  let g1 = 0
  let b1 = 0
  if (hp < 1) {
    r1 = c
    g1 = x
  } else if (hp < 2) {
    r1 = x
    g1 = c
  } else if (hp < 3) {
    g1 = c
    b1 = x
  } else if (hp < 4) {
    g1 = x
    b1 = c
  } else if (hp < 5) {
    r1 = x
    b1 = c
  } else {
    r1 = c
    b1 = x
  }
  const m = light - c / 2
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ]
}

function resolveTintFromCssVar(tintVar: string | undefined): OrbRgb | undefined {
  if (!tintVar) return undefined
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(tintVar)
      .trim()
    // 主题 token：`38 70% 50%`；容忍尾部 alpha / 多余空白
    const match = raw.match(
      /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/,
    )
    if (!match) return undefined
    return hslComponentsToRgb(Number(match[1]), Number(match[2]), Number(match[3]))
  } catch {
    return undefined
  }
}

function tintChanged(
  prev: OrbRgb | undefined,
  next: OrbRgb | undefined,
): boolean {
  if (prev === next) return false
  if (!prev || !next) return true
  return prev[0] !== next[0] || prev[1] !== next[1] || prev[2] !== next[2]
}

function buildPaintOpts(base: OrbPaintOptions, tint: OrbRgb | undefined): OrbPaintOptions {
  return tint ? { ...base, tint } : { ...base }
}

function paintCanvas(runtime: OrbRuntime, t: number): void {
  const canvas = runtime.canvas
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const presetSize = pickOrbPresetSize(runtime.cssSize)
  const preset = resolveOrbPreset(runtime.texture, presetSize)
  const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  const pixel = Math.max(1, Math.round(runtime.cssSize * dpr))
  if (canvas.width !== pixel || canvas.height !== pixel) {
    canvas.width = pixel
    canvas.height = pixel
  }

  const frame: OrbFrame = buildOrbFrame({
    mode: preset.mode,
    size: presetSize,
    t,
    dark: runtime.dark,
    opts: buildPaintOpts(preset.opts, runtime.tint),
    settle: runtime.clock.settle,
    settleShape: runtime.settleShape,
  })

  // 逻辑坐标按 presetSize 画，再用矩阵缩到 cssSize × dpr
  const k = dpr * (runtime.cssSize / presetSize)
  ctx.setTransform(k, 0, 0, k, 0, 0)
  ctx.clearRect(0, 0, presetSize, presetSize)

  // 线故意走 resolveOrbLineInk：连线从不染色（recovering 的黄只染点）
  for (const line of frame.lines) {
    const c = resolveOrbLineInk(frame, line.ink, line.a)
    ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`
    ctx.lineWidth = line.w
    ctx.beginPath()
    ctx.moveTo(line.x1, line.y1)
    ctx.lineTo(line.x2, line.y2)
    ctx.stroke()
  }

  // dots 已按 z 排好序，按数组顺序画即可；景深墨值必须经 resolveOrbDotInk，勿自行折进 alpha
  for (const dot of frame.dots) {
    const c = resolveOrbDotInk(frame, dot.ink, dot.a)
    ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${c.a})`
    ctx.beginPath()
    ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2)
    ctx.fill()
  }

  runtime.painted = true
}

/** {@link syncRuntimeProps} 要同步的这一批——即 props 中会影响绘制的部分 */
type OrbSyncedProps = Pick<
  OrbRuntime,
  | 'texture'
  | 'cssSize'
  | 'tint'
  | 'dark'
  | 'resolve'
  | 'restedAtMount'
  | 'settleShape'
  | 'speedScale'
  | 'onRested'
  | 'reducedMotion'
>

/**
 * render 阶段把 props 同步进可变 runtime。
 *
 * 凡是会改变画面的入参都必须在这里置脏，否则「已 painted」会把变化吞掉——静止终帧尤其容易中招，
 * 它不靠动画驱动重绘，漏一处就永远停在旧画面上。本组件是共享原语，别把这种坑留给下一个调用方。
 */
function syncRuntimeProps(runtime: OrbRuntime, next: OrbSyncedProps): void {
  const repaint =
    runtime.dark !== next.dark ||
    runtime.texture !== next.texture ||
    runtime.cssSize !== next.cssSize ||
    runtime.settleShape !== next.settleShape ||
    runtime.speedScale !== next.speedScale ||
    tintChanged(runtime.tint, next.tint)
  if (repaint) runtime.painted = false

  // clock 只在初始化时建过一次，restedAtMount 挂载后翻转要在这里补齐两个方向
  if (next.restedAtMount !== runtime.restedAtMount) {
    runtime.clock = next.restedAtMount ? settleOrbClock(runtime.clock) : createOrbClock()
    runtime.restedNotified = false
    runtime.painted = false
  }

  Object.assign(runtime, next)
}

function maybeNotifyRested(runtime: OrbRuntime): void {
  if (
    runtime.restedNotified ||
    runtime.restedAtMount ||
    !runtime.resolve ||
    !isOrbResting(runtime.clock) ||
    !runtime.painted
  ) {
    return
  }
  runtime.restedNotified = true
  runtime.onRested?.()
}

function syncResolveEdge(runtime: OrbRuntime, nowMs: number): void {
  // 挂载即终态：clock 已 settle，不得被 resolve 边沿误判成「新一轮 / 开始收束」
  if (runtime.restedAtMount) return
  if (runtime.resolve === runtime.appliedResolve) return

  if (runtime.resolve == null) {
    // 接缝事实 2：收束后的 clock 回不到运行态，新一轮必须重建
    runtime.clock = createOrbClock()
    runtime.restedNotified = false
    runtime.painted = false
  } else {
    runtime.clock = beginOrbResolve(runtime.clock, runtime.resolve, nowMs)
    runtime.restedNotified = false
    runtime.painted = false
  }
  runtime.appliedResolve = runtime.resolve
}

/** 按当前 clock.phase 画一帧（运行态与终态共用）。 */
function paintPhaseFrame(runtime: OrbRuntime): void {
  const presetSize = pickOrbPresetSize(runtime.cssSize)
  const preset = resolveOrbPreset(runtime.texture, presetSize)
  paintCanvas(runtime, runtime.clock.phase * preset.speed * runtime.speedScale)
}

/** 减弱动效分支：看不见运动，但仍须看见结束（resolve → 终帧 + onRested）。 */
function driveReducedMotionFrame(runtime: OrbRuntime): void {
  // 挂载即终态：只补一帧静止终帧，不走 resolve / onRested
  if (runtime.restedAtMount) {
    if (!runtime.painted) paintPhaseFrame(runtime)
    return
  }
  if (runtime.resolve) {
    if (runtime.clock.settle !== 1 || runtime.clock.timeScale !== 0) {
      runtime.clock = settleOrbClock(runtime.clock)
      runtime.painted = false
    }
    if (!runtime.painted) paintPhaseFrame(runtime)
    maybeNotifyRested(runtime)
    return
  }
  if (!runtime.painted) {
    // 固定静帧（phase=0.6，与 createOrbClock 初值一致）
    const presetSize = pickOrbPresetSize(runtime.cssSize)
    const preset = resolveOrbPreset(runtime.texture, presetSize)
    paintCanvas(runtime, 0.6 * preset.speed * runtime.speedScale)
  }
}

function driveFrame(runtime: OrbRuntime, dtSeconds: number, nowMs: number): void {
  syncResolveEdge(runtime, nowMs)

  if (shouldReduceMotion(runtime)) {
    driveReducedMotionFrame(runtime)
    return
  }

  // 窗口不可见 / 元素离屏：停画且不推进相位，回来后从原相位续上
  if (typeof document !== 'undefined' && document.hidden) return
  if (!runtime.visible) return

  const prevSettle = runtime.clock.settle
  const prevTimeScale = runtime.clock.timeScale
  runtime.clock = advanceOrbClock(runtime.clock, dtSeconds, nowMs)
  // settle / timeScale 变化时置脏——否则 resting 终帧（完美点环）会被「已 painted」跳过
  if (
    runtime.clock.settle !== prevSettle ||
    runtime.clock.timeScale !== prevTimeScale
  ) {
    runtime.painted = false
  }

  if (isOrbResting(runtime.clock) && runtime.painted) {
    maybeNotifyRested(runtime)
    return
  }

  paintPhaseFrame(runtime)
  maybeNotifyRested(runtime)
}

export const AgentOrb: React.FC<AgentOrbProps> = ({
  texture,
  cssSize,
  tintVar,
  resolve,
  onRested,
  restedAtMount = false,
  settleShape = 'dot',
  speedScale = 1,
  reducedMotion,
  decorative = false,
  'aria-label': ariaLabel,
  className,
}) => {
  const resolvedTheme = useUIStore((s) => s.resolvedTheme)
  const colorScheme = useUIStore((s) => s.colorScheme)
  const dark = resolvedTheme === 'dark'
  // 主题 / 配色一换，token 的 HSL 分量就变。读的是 CSS 变量而非闭包值，所以
  // resolvedTheme / colorScheme 不出现在函数体里——它们是**故意**留的重算触发器，
  // 按 exhaustive-deps 的建议删掉会导致切主题后染色停在旧色上。
  const tint = useMemo(
    () => resolveTintFromCssVar(tintVar),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tintVar, resolvedTheme, colorScheme],
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const runtimeRef = useRef<OrbRuntime | null>(null)

  if (runtimeRef.current == null) {
    runtimeRef.current = {
      canvas: null,
      // restedAtMount：一挂载就是收束完的静止环，不播减速动画
      clock: restedAtMount ? settleOrbClock(createOrbClock()) : createOrbClock(),
      painted: false,
      visible: true,
      texture,
      cssSize,
      tint,
      dark,
      resolve,
      appliedResolve: undefined,
      restedNotified: false,
      restedAtMount,
      settleShape,
      speedScale,
      onRested,
      reducedMotion,
    }
  }

  const runtime = runtimeRef.current
  syncRuntimeProps(runtime, {
    texture,
    cssSize,
    tint,
    dark,
    resolve,
    restedAtMount,
    settleShape,
    speedScale,
    onRested,
    reducedMotion,
  })

  // Space 切到后台就整个摘掉：连 rAF 注册一起停，比留着驱动再逐帧判断可见性更省
  useScopedEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    runtime.canvas = canvas

    const driver = {
      onFrame: (dt: number, now: number) => driveFrame(runtime, dt, now),
    }
    const unregister = registerOrbDriver(driver)

    let io: IntersectionObserver | null = null
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.target !== canvas) continue
          runtime.visible = entry.isIntersecting
          // 重新进入视口时置脏，避免 resting 期间主题已变却仍跳过
          if (entry.isIntersecting) runtime.painted = false
        }
      })
      io.observe(canvas)
    }

    let motionMql: MediaQueryList | null = null
    const onMotionChange = () => {
      runtime.painted = false
    }
    try {
      motionMql = window.matchMedia('(prefers-reduced-motion: reduce)')
      motionMql.addEventListener('change', onMotionChange)
    } catch {
      motionMql = null
    }

    // 重新挂上时先置脏：离开期间主题可能已变，静止态不会自己重画
    runtime.painted = false

    return () => {
      unregister()
      io?.disconnect()
      motionMql?.removeEventListener('change', onMotionChange)
    }
    // runtime 是稳定 ref；只在挂载/卸载与 scope 进出时建调度
  }, [])

  useScopedEventListener(document, 'visibilitychange', () => {
    if (!document.hidden) runtime.painted = false
  })

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={cssSize}
      height={cssSize}
      style={{ width: cssSize, height: cssSize, display: 'block' }}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : ariaLabel}
    />
  )
}
AgentOrb.displayName = 'AgentOrb'
