/**
 * Composer 发送路由判定（从 ChatInput.handleSend 提取）。
 *
 * 在线（含忙碌）一律直发；断网拒绝发送（不再本地缓冲）。
 */

export type ComposerSendRoute = 'reject' | 'direct'

export interface ComposerSendRouteInput {
  hasContent: boolean
  disabled: boolean
  messageTooLong: boolean
  wsDisconnected: boolean
  onCooldown: boolean
}

export function resolveComposerSendRoute(input: ComposerSendRouteInput): ComposerSendRoute {
  if (input.onCooldown) return 'reject'
  if (!input.hasContent || input.disabled) return 'reject'
  if (input.messageTooLong) return 'reject'
  return 'direct'
}
