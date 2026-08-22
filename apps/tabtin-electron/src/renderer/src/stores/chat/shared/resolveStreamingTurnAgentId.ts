/**
 * 流式首帧解析本轮执行 Agent。
 *
 * 不发明字段：只用 renderer 已有的 message.agent_id / session.agent_id /
 * selectedAgent.id。落库消息身份优先，随后是会话执行身份，最后才是当前选择。
 */
export function resolveStreamingTurnAgentId(input: {
  messageAgentId?: string | null
  sessionAgentId?: string | null
  selectedAgentId?: string | null
}): string | null {
  const messageId = input.messageAgentId?.trim()
  if (messageId) return messageId
  const sessionId = input.sessionAgentId?.trim()
  if (sessionId) return sessionId
  const selectedId = input.selectedAgentId?.trim()
  if (selectedId) return selectedId
  return null
}

export interface StreamingTurnAgentFace {
  agentId: string | null
  agentName: string | null
  agentAvatar: string | null
}

/**
 * 把实时执行身份投影成与历史 ChatMessage 相同的安全展示快照。
 * 会话快照只属于 session.agent_id；消息已切换到其它 Agent 时禁止错配沿用。
 */
export function resolveStreamingTurnAgentFace(input: {
  messageAgentId?: string | null
  sessionAgentId?: string | null
  sessionAgentName?: string | null
  sessionAgentAvatar?: string | null
  selectedAgentId?: string | null
}): StreamingTurnAgentFace {
  const agentId = resolveStreamingTurnAgentId(input)
  const sessionAgentId = input.sessionAgentId?.trim() || null
  const canUseSessionFace = Boolean(agentId && sessionAgentId === agentId)
  return {
    agentId,
    agentName: canUseSessionFace ? input.sessionAgentName?.trim() || null : null,
    agentAvatar: canUseSessionFace ? input.sessionAgentAvatar?.trim() || null : null,
  }
}
