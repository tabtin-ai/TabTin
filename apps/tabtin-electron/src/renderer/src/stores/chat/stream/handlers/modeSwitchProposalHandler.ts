/**
 * modeSwitchProposalHandler — 处理 `agent.stream.mode_switch_proposal` 事件
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { createLogger } from '@/utils/logger'
import { resolveAgentModeName } from '@stores/chat/shared/types'
import type { AgentStreamMessage, HandlerContext } from './streamHandlerTypes'

const log = createLogger('ModeSwitchProposal')

export function handleModeSwitchProposalEvent(
  message: AgentStreamMessage,
  ctx: HandlerContext,
): void {
  const payload = (message.payload ?? {}) as Record<string, unknown>
  const proposalId =
    typeof payload.proposal_id === 'string' ? payload.proposal_id : ''
  if (!proposalId) {
    log.warn('mode_switch_proposal missing proposal_id, dropped', {
      ctxSessionId: ctx.sessionId.slice(0, 8),
    })
    return
  }
  const targetSessionId =
    (typeof payload.session_id === 'string' && payload.session_id) || ctx.sessionId
  if (!targetSessionId) return

  const reason = typeof payload.reason === 'string' ? payload.reason : ''
  // 通用化：target/from 由工具按白名单填，非法值回退（target→agent、from→plan）
  // 兼容通用化前 payload（无 from_mode_id、target 恒 agent）。
  const targetModeId = resolveAgentModeName(payload.target_mode_id, 'agent')
  const fromModeId = resolveAgentModeName(payload.from_mode_id, 'plan')

  const proposalMessage: ChatMessage = {
    id: `mode-switch-proposal-${proposalId}`,
    role: 'system',
    content: `请求切换到 ${targetModeId} 模式`,
    created_at: new Date().toISOString(),
    metadata: {
      kind: 'mode_switch_proposal',
      mode_switch_proposal: {
        proposal_id: proposalId,
        target_mode_id: targetModeId,
        from_mode_id: fromModeId,
        reason,
        resolved: null as 'approved' | 'cancelled' | null,
      },
    },
  }

  log.info('mode_switch_proposal received', {
    sessionId: targetSessionId.slice(0, 8),
    proposalId: proposalId.slice(0, 8),
  })

  void import('@stores/chat/useChatStore')
    .then(({ useChatStore }) => {
      useChatStore.getState().injectSystemMessage(targetSessionId, proposalMessage)
    })
    .catch((err) => log.warn('Failed to inject mode_switch_proposal message', err))
}
