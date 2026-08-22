/**
 * CollapsibleToolCardGroup 动效辅助：count-up + reduced-motion 判定。
 * CSS 类（chat-motion-tool-group-content）由共享层定义；这里只负责 JS 侧编排。
 */
import { MOTION } from '../registry/chatDesignTokens'

export const TOOL_GROUP_COUNT_UP_MS = Number.parseFloat(MOTION.countUp)
export const TOOL_GROUP_COLLAPSE_MS = Number.parseFloat(MOTION.state)

function shouldFinishImmediately(
  reducedMotion: boolean,
  durationMs: number,
  from: number,
  target: number,
): boolean {
  return reducedMotion || durationMs <= 0 || target <= from
}

/** 可测试：默认读 matchMedia；测试可 mock window.matchMedia 或直接 spy 本函数。 */
export function prefersReducedMotion(
  matchMedia: ((query: string) => MediaQueryList) | undefined = typeof window !== 'undefined'
    ? window.matchMedia?.bind(window)
    : undefined,
): boolean {
  if (typeof matchMedia !== 'function') return false
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * 300ms 内用少量 rAF 从 0（或 from）count-up 到 target；返回取消函数。
 * reduced-motion 时直接呈现最终值。
 */
export function runCountUp(
  target: number,
  onUpdate: (value: number) => void,
  options?: {
    from?: number
    durationMs?: number
    reducedMotion?: boolean
    raf?: (cb: FrameRequestCallback) => number
    caf?: (id: number) => void
    onComplete?: () => void
  },
): () => void {
  const from = options?.from ?? 0
  const durationMs = options?.durationMs ?? TOOL_GROUP_COUNT_UP_MS
  const reduced = options?.reducedMotion ?? prefersReducedMotion()
  const raf = options?.raf ?? requestAnimationFrame
  const caf = options?.caf ?? cancelAnimationFrame

  if (shouldFinishImmediately(reduced, durationMs, from, target)) {
    onUpdate(target)
    options?.onComplete?.()
    return () => {}
  }

  let rafId = 0
  let cancelled = false
  let startTs: number | null = null

  const frame: FrameRequestCallback = (now) => {
    if (cancelled) return
    if (startTs == null) startTs = now
    const progress = Math.min(1, (now - startTs) / durationMs)
    onUpdate(Math.round(from + (target - from) * progress))
    if (progress < 1) {
      rafId = raf(frame)
    } else {
      options?.onComplete?.()
    }
  }

  onUpdate(from)
  rafId = raf(frame)

  return () => {
    cancelled = true
    caf(rafId)
  }
}
