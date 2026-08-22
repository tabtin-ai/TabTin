/**
 * chatCapsuleMorph —— 分屏 ⇄ 应用聚焦切换时，聊天面板与右下角胶囊之间的
 * 共享元素连续性动画（ghost + WAAPI）。
 *
 * 不用 framer layoutId：真实面板跨 portal 宿主迁移时 layoutId 不可靠；
 * ghost 是单个无子树元素，允许动宽高。pending 只消费一次且 1s 过期。
 */
import type { TaskViewMode } from './../../layout/taskLayoutState'

type MorphDirection = 'to-capsule' | 'to-rail'

interface PendingMorph {
  direction: MorphDirection
  from: DOMRect
  capturedAt: number
}

let pendingMorph: PendingMorph | null = null
/** to-capsule morph 播放期间，实体胶囊应保持隐藏至该时间戳（抗 Strict Mode 双挂载）。 */
let capsuleRevealAtMs = 0
/** to-rail morph 播放期间，实体 rail 应保持隐藏至该时间戳（抗 Strict Mode 双挂载）。 */
let railRevealAtMs = 0

/** ghost 主动画时长；消费方隐藏实体 / 列宽过渡应对齐此值，勿另写第二份。 */
export const MORPH_DURATION_MS = 420
/** ghost 与辅位列宽过渡共用缓动，勿另写第二份。 */
export const MORPH_EASING = 'cubic-bezier(0.77, 0, 0.175, 1)'
const GHOST_FADE_MS = 140
const PENDING_TTL_MS = 1000
const RAIL_RADIUS_PX = 12

export interface ConsumeCapsuleMorphOptions {
  /**
   * 目标尚未布局到最终尺寸时（如辅位列从 0 展到目标宽），传入最终矩形，
   * 避免 ghost 飞向宽度为 0 的瞬时 rect。
   */
  finalRect?: DOMRect
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 三态切换点击时调用（布局变化前），捕获出发矩形。 */
export function captureTaskViewModeMorph(
  prev: TaskViewMode | undefined,
  next: TaskViewMode,
): void {
  if (!prev || prev === next || typeof document === 'undefined' || prefersReducedMotion()) return
  if (prev === 'split' && next === 'app-focus') {
    const rail = document.querySelector('[data-task-chat-rail]')
    if (rail) {
      pendingMorph = { direction: 'to-capsule', from: rail.getBoundingClientRect(), capturedAt: Date.now() }
      // 捕获当下就开始隐藏窗口期，避免消费前/Strict 重挂时实体胶囊先闪一帧
      capsuleRevealAtMs = Date.now() + MORPH_DURATION_MS
    }
    return
  }
  if (prev === 'app-focus' && next === 'split') {
    const source = document.querySelector('[data-agent-chat-overlay]')
      ?? document.querySelector('[data-agent-chat-capsule]')
    if (source) {
      pendingMorph = { direction: 'to-rail', from: source.getBoundingClientRect(), capturedAt: Date.now() }
      // 与 to-capsule 对称：捕获当下就开始隐藏窗口，避免 Strict 二次挂载时实体 rail 先闪
      railRevealAtMs = Date.now() + MORPH_DURATION_MS
    }
  }
}

/** 是否有尚未过期、方向匹配的 pending（首渲前探测，用于跳过 framer enter）。 */
export function hasPendingCapsuleMorph(direction: MorphDirection): boolean {
  const pending = pendingMorph
  if (!pending || pending.direction !== direction) return false
  return Date.now() - pending.capturedAt <= PENDING_TTL_MS
}

/** 是否仍应隐藏实体胶囊（pending 或 morph 播放中）。 */
export function shouldHideCapsuleForMorph(): boolean {
  if (hasPendingCapsuleMorph('to-capsule')) return true
  return Date.now() < capsuleRevealAtMs
}

/** 距胶囊可露出的剩余毫秒；0 表示可立即露出。 */
export function getCapsuleMorphRevealDelayMs(): number {
  if (hasPendingCapsuleMorph('to-capsule')) return MORPH_DURATION_MS
  return Math.max(0, capsuleRevealAtMs - Date.now())
}

/** 是否仍应隐藏实体 rail（pending 或 morph 播放中）。 */
export function shouldHideRailForMorph(): boolean {
  if (hasPendingCapsuleMorph('to-rail')) return true
  return Date.now() < railRevealAtMs
}

/** 距 rail 可露出的剩余毫秒；0 表示可立即露出。 */
export function getRailMorphRevealDelayMs(): number {
  if (hasPendingCapsuleMorph('to-rail')) return MORPH_DURATION_MS
  return Math.max(0, railRevealAtMs - Date.now())
}

/**
 * 目标元素挂载后调用（useLayoutEffect），消费一次 pending 并播放 ghost。
 * 方向不匹配时保留 pending，留给正确方向的消费方；方向匹配或已过期才清除。
 * @returns 是否真正消费并开始播放 morph（供调用方跳过叠加入场动画）
 */
export function consumeCapsuleMorph(
  direction: MorphDirection,
  target: HTMLElement,
  opts?: ConsumeCapsuleMorphOptions,
): boolean {
  const pending = pendingMorph
  if (!pending) return false
  // 方向不匹配：保留 pending（TTL 仍兜底过期）
  if (pending.direction !== direction) return false
  pendingMorph = null
  if (Date.now() - pending.capturedAt > PENDING_TTL_MS) return false
  runGhostMorph(pending.from, opts?.finalRect ?? target.getBoundingClientRect(), direction)
  return true
}

function runGhostMorph(from: DOMRect, to: DOMRect, direction: MorphDirection): void {
  // 拒绝退化目标（宽/高为 0）：避免小窗口/列宽过渡首帧把 ghost 飞到错误尺寸
  const safeTo = to.width >= 1 && to.height >= 1 ? to : from
  // 再次钉死隐藏窗口（消费时刻），与 capture 时写入互为兜底
  if (direction === 'to-capsule') {
    capsuleRevealAtMs = Math.max(capsuleRevealAtMs, Date.now() + MORPH_DURATION_MS)
  } else {
    railRevealAtMs = Math.max(railRevealAtMs, Date.now() + MORPH_DURATION_MS)
  }

  const ghost = document.createElement('div')
  ghost.setAttribute('aria-hidden', 'true')
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    zIndex: 'var(--z-modal)',
    pointerEvents: 'none',
    background: 'hsl(var(--background))',
    border: '1px solid hsl(var(--border))',
    borderRadius: `${direction === 'to-capsule' ? RAIL_RADIUS_PX : from.height / 2}px`,
    boxShadow: 'var(--shadow-float)',
    willChange: 'transform, opacity',
  })
  document.body.appendChild(ghost)

  // 圆角按矩形实际高度取半径：12→999 直插会在大尺寸阶段畸变成椭圆
  const radiusFrom = direction === 'to-capsule' ? RAIL_RADIUS_PX : from.height / 2
  const radiusTo = direction === 'to-capsule' ? safeTo.height / 2 : RAIL_RADIUS_PX

  const animation = ghost.animate([
    {
      transform: 'translate(0, 0)',
      width: `${from.width}px`,
      height: `${from.height}px`,
      borderRadius: `${radiusFrom}px`,
      opacity: 1,
      filter: 'blur(0px)',
    },
    // 中途轻 blur 掩盖内容替换（emil：blur 桥接 crossfade）
    { offset: 0.5, filter: 'blur(1.5px)', opacity: 0.96 },
    {
      transform: `translate(${safeTo.left - from.left}px, ${safeTo.top - from.top}px)`,
      width: `${safeTo.width}px`,
      height: `${safeTo.height}px`,
      borderRadius: `${radiusTo}px`,
      opacity: 1,
      filter: 'blur(0px)',
    },
  ], { duration: MORPH_DURATION_MS, easing: MORPH_EASING, fill: 'forwards' })

  animation.onfinish = () => {
    const fade = ghost.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: GHOST_FADE_MS, fill: 'forwards' },
    )
    fade.onfinish = () => ghost.remove()
  }
  animation.oncancel = () => ghost.remove()
}
