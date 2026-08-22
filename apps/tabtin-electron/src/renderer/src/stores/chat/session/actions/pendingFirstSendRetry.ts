/**
 * ：local-pending 首发失败后的「重试」不能直接走 store.sendMessage——
 * 它从不建会话，消息会朝不存在的 session 再次失败（草稿切过 Agent 时前门禁
 * 还会对 local-pending id 打 sessions.update 404）。
 *
 * ChatPanel（useChatCallbacks）按 draft scope 在此注册完整首发编排
 * （ensure 建会话 → 迁 pending 消息 → 发送；adopt_owned 复用同一气泡不叠泡），
 * 气泡上的重试按钮经 draftMessage 绑定找回对应面板的编排入口。
 */

import { getDraftSessionBySessionId } from '../draftSession'
import { isDraftSessionMessageActive } from '../draftMessageSessionCoordinator'

export interface PendingFirstSendRetryInput {
  message: string
  contextBlocks?: Array<Record<string, unknown>>
}

type PendingFirstSendRetryHandler = (input: PendingFirstSendRetryInput) => void

const handlerByDraftScopeKey = new Map<string, PendingFirstSendRetryHandler>()

export function registerPendingFirstSendRetryHandler(
  draftScopeKey: string,
  handler: PendingFirstSendRetryHandler,
): () => void {
  handlerByDraftScopeKey.set(draftScopeKey, handler)
  return () => {
    if (handlerByDraftScopeKey.get(draftScopeKey) === handler) {
      handlerByDraftScopeKey.delete(draftScopeKey)
    }
  }
}

/**
 * 按 pending session 的 draftMessage 绑定路由到面板首发编排。
 * draftMessage 已取消 / 面板未挂载时返回 false，由调用方降级（回填 Composer）。
 */
export function retryPendingFirstSend(
  pendingSessionId: string,
  input: PendingFirstSendRetryInput,
): boolean {
  const draftSession = getDraftSessionBySessionId(pendingSessionId)
  if (
    !draftSession
    || draftSession.status === 'released'
    || !isDraftSessionMessageActive(pendingSessionId)
  ) return false
  const handler = handlerByDraftScopeKey.get(draftSession.draftScopeKey)
  if (!handler) return false
  handler(input)
  return true
}

/** @internal 测试用 */
export function __resetPendingFirstSendRetryForTests(): void {
  handlerByDraftScopeKey.clear()
}
