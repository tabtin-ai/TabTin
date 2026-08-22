/**
 * Agent 对话视口 Phase 0：模式、事件、几何与帧探针 schema。
 * 纯类型，无运行时副作用。
 */

export type ViewportMode =
  | { kind: 'follow-latest' }
  | {
      kind: 'anchored-reading'
      reason: 'browse-history' | 'read-here' | 'navigate'
      anchor?: {
        messageKey: string
        offsetWithinItem: number
      }
    }

/**
 * 帧探针允许记录无法解析的 dataset mode，便于指标明确失败。
 * `invalid:*` 仅用于探针诊断，不是产品视口模式。
 */
export type ViewportFrameMode = ViewportMode['kind'] | `invalid:${string}`

export type ViewportLayoutReason =
  | 'content-resize'
  | 'viewport-resize'
  | 'message-appended'
  | 'streaming-tick'
  | 'streaming-tail-first-block'
  | 'turn-ended'
  | 'foreground-restored'
  | 'empty-window'

export type ConversationViewportEvent =
  | { type: 'user-browse-up'; source: 'wheel' | 'keyboard' | 'touch' | 'scrollbar' }
  | { type: 'user-read-here'; source: 'expand' | 'selection'; messageKey: string }
  | { type: 'follow-latest'; source: 'send' | 'return-button' | 'initial-open' | 'reached-bottom' }
  | { type: 'navigate'; messageKey: string; align: 'start' | 'center' }
  | { type: 'layout-changed'; reason: ViewportLayoutReason }
  | { type: 'visual-anchor-shift'; delta: number }
  | { type: 'history-prepended'; scrollTop: number }
  | { type: 'programmatic-scroll-completed'; scrollTop: number }

export type ViewportGeometry = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export type ConversationViewportFrame = ViewportGeometry & {
  ts: number
  frame: number
  scopeKey: string
  mode: ViewportFrameMode
  /** 触发该帧的事件 type；layout-changed 帧使用其 layout reason，而非事件 source。 */
  reason: string
  source: 'user' | 'programmatic' | 'browser-clamp' | 'virtualizer' | 'unknown'
  targetOffset?: number
  followError?: number
  anchorMessageKey?: string
  anchorTop?: number
  writesThisFrame: number
}
