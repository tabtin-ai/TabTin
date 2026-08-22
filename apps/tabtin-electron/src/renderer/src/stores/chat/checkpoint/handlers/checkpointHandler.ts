/**
 * Checkpoint event handler — processes CHECKPOINT_FAILED and CHECKPOINT_SUCCESS.
 *
 * NOTE（Wave 13）：原本 DECISION_SUMMARY_READY 也走 agent.stream 事件流，
 * 但该 topic 在 agent.stream.done 后被前端立即 unsubscribe，LLM 增强摘要
 * 投递时订阅已断（见 QC-01）。现在 DECISION_SUMMARY_READY / FAILED 改投递到
 * agent.session.{session_id}，由 `useChatSessionEventStream` + `applyDecisionSummaryUpdate`
 * 消费；本文件仅保留 checkpoint_failed / success 两个事件。
 */

import { AgentStreamEvents } from '@tabtin/ws-gateway-client'
import type { DecisionSummary } from '@tabtin/chat-client'
import type { AgentStreamMessage, HandlerContext } from '../../stream/handlers/streamHandlerTypes'

const DIFF_SYNC_DELAY_MS = 2000
const _diffSyncTimerBySession = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 将新版 decision_summary 合并到对应消息的 checkpoint_record 中。
 *
 * 供两个入口复用：
 *   1. agent.session.{session_id} topic 推送（主路径）
 *   2. CheckpointContextCard 展开时的兜底拉取
 *
 * 匹配规则（优先 messageId，fallback checkpointId）保证即便后端只回传
 * 其中一个字段也能定位目标消息。幂等：已 ready 的消息不再被覆盖。
 */
export function applyDecisionSummaryUpdate(params: {
  targetSessionId: string
  messageId?: string | null
  checkpointId?: string | null
  decisionSummary: DecisionSummary
}): Promise<boolean> {
  const { targetSessionId, messageId, checkpointId, decisionSummary } = params
  if (!decisionSummary || !decisionSummary.status) return Promise.resolve(false)
  if (!messageId && !checkpointId) return Promise.resolve(false)

  return import('@stores/chat/useChatStore').then(({ useChatStore }) => {
    // 定位 + ready 终态守卫 + 状态升级逻辑内聚在 store action。
    const matched = useChatStore.getState().applyCheckpointDecisionSummary(
      targetSessionId,
      { messageId: messageId ?? undefined, checkpointId: checkpointId ?? undefined },
      decisionSummary,
    )
    if (!matched) {
      console.debug(
        '[StreamHandler] applyDecisionSummaryUpdate: no matching message found',
        { targetSessionId, messageId, checkpointId },
      )
    }
    return matched
  }).catch((err) => {
    console.warn('[StreamHandler] applyDecisionSummaryUpdate error:', err)
    return false
  })
}

export function handleCheckpointEvent(message: AgentStreamMessage, ctx: HandlerContext): void {
  const { sessionId } = ctx
  const eventType = message.type

  if (eventType === AgentStreamEvents.CHECKPOINT_FAILED) {
    import('@stores/chat/useChatStore').then(({ useChatStore }) => {
      useChatStore.getState().reportCheckpointFailure(sessionId)
    }).catch((err) => {
      console.warn('[StreamHandler] checkpoint_failed handler error:', err)
    })
    return
  }

  if (eventType === AgentStreamEvents.CHECKPOINT_SUCCESS) {
    import('@stores/chat/useChatStore').then(({ useChatStore }) => {
      useChatStore.getState().reportCheckpointSuccess(sessionId)
    }).catch((err) => {
      console.warn('[StreamHandler] checkpoint_success handler error:', err)
    })

    // Daemon 模式下 diff_summary 由后台线程异步持久化，CHECKPOINT_SUCCESS 到达时
    // 数据库可能尚未写入完成。延迟同步消息以拉取含 diff_summary 的最新数据。
    const targetSessionId = (message.payload?.session_id as string) || sessionId
    const prevTimer = _diffSyncTimerBySession.get(targetSessionId)
    if (prevTimer !== undefined) clearTimeout(prevTimer)
    _diffSyncTimerBySession.set(
      targetSessionId,
      setTimeout(() => {
        _diffSyncTimerBySession.delete(targetSessionId)
        import('@stores/chat/useChatStore').then(({ useChatStore }) => {
          useChatStore.getState().syncSessionMessagesFromServer(targetSessionId)
        }).catch((err) => {
          console.warn('[StreamHandler] checkpoint_success diff sync error:', err)
        })
      }, DIFF_SYNC_DELAY_MS),
    )
    return
  }
}
