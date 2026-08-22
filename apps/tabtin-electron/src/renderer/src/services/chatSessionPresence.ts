/**
 * Chat session presence 纯逻辑（无 React / Gateway 副作用）。
 *
 * - resolvePresenceSessionId：主窗应上报的前台 session
 * - shouldSuppressAgentOsNotification：直接 stream 到达时是否跳过本机 OS/in-app 系统通知
 *   （HITL 等待 / lifecycle 完成·出错·中断共用）
 */

export interface PresenceViewState {
  currentSessionId: string | null | undefined
  hasFocus: boolean
  visibilityState: DocumentVisibilityState
}

/** 当前应上报的 session；不在场返回 null（调用方发 clear）。 */
export function resolvePresenceSessionId(input: PresenceViewState): string | null {
  if (!input.currentSessionId) return null
  if (!input.hasFocus) return null
  if (input.visibilityState !== 'visible') return null
  return input.currentSessionId
}

/**
 * 直接 stream 到达时：若用户已在前台看该会话，跳过本机系统通知。
 * 判定同时要求：窗口聚焦 + document visible + currentSessionId === eventSessionId。
 * （不读路由 / Workspace 指针；与 presence 上报、HITL 门闩同一 session id 语义。）
 */
export function shouldSuppressAgentOsNotification(input: {
  eventSessionId: string
  currentSessionId: string | null | undefined
  hasFocus: boolean
  visibilityState: DocumentVisibilityState
}): boolean {
  return resolvePresenceSessionId({
    currentSessionId: input.currentSessionId,
    hasFocus: input.hasFocus,
    visibilityState: input.visibilityState,
  }) === input.eventSessionId
}

/** @deprecated 使用 shouldSuppressAgentOsNotification；保留别名以免 HITL 调用方大面积改名 */
export const shouldSuppressHitlOsNotification = shouldSuppressAgentOsNotification
