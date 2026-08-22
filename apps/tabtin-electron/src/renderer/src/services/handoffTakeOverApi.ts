/**
 * handoffTakeOverApi — 接力（handoff）接手升级链路。
 *
 * POST /im/handoffs/{handoff_id}/take-over-session：把交接包冻结快照物化成
 * 接收人自己的 Agent × Workspace 新会话；幂等（已接手且会话仍在时返回既有会话）。
 * 响应 data 对齐 shared-fork：ChatSessionSchema，前端可直接 enterChatSession。
 *
 * 400「该交接为仅查看，无法接手」/「该交接没有可接手的会话快照」等错误
 * 通过 ShareApiError.message 透传给 toast。
 */

import { shareApiRequest } from './sessionShareApi'
import type { ChatSession } from '@tabtin/chat-client'

export async function takeOverHandoffSession(
  handoffId: string,
  params: { agentId: string; workspaceId: string },
): Promise<ChatSession> {
  return shareApiRequest<ChatSession>('POST', `/im/handoffs/${handoffId}/take-over-session`, {
    agent_id: params.agentId,
    workspace_id: params.workspaceId,
  })
}
