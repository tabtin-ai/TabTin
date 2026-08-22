import type { Agent } from '@tabtin/app-shell'
import { extractAgentAvatarUrl } from '@/utils/resolveAgentAvatar'

/**
 * 配置页 / 选择器同口径：优先 display_name，其次 name。
 * 皆空时返回 ''，由调用方决定是否渲染（禁止用 UUID 短码冒充展示名，）。
 */
export function resolveAgentDisplayName(
  agent: Pick<Agent, 'display_name' | 'name'> | null | undefined,
): string {
  return agent?.display_name?.trim() || agent?.name?.trim() || ''
}

export type AgentDisplaySource = Pick<Agent, 'id' | 'display_name' | 'name' | 'settings'>

/**
 * 当前对话生效的 Agent id（ / 草稿斜杠携带态）。
 * session.agent_id 优先；草稿 / pending 首发回落 selectedAgent。
 */
export function resolveCurrentAgentId(input: {
  sessionAgentId?: string | null
  selectedAgentId?: string | null
}): string | null {
  const sessionId = input.sessionAgentId?.trim() || null
  const selectedId = input.selectedAgentId?.trim() || null
  return sessionId ?? selectedId
}

/**
 * 当前生效 Agent 的展示身份（与 useCurrentAgentDisplayName 同口径，）。
 * session.agent_id 优先，否则 selectedAgent；名字 cache 优先，否则同 id 的 selectedAgent。
 * 解析不出真名时返回 null——禁止 `Agent xxxx` / UUID 短码占位。
 */
export function resolveCurrentAgentDisplay(input: {
  sessionAgentId?: string | null
  selectedAgent?: AgentDisplaySource | null
  agentCache: Record<string, Pick<Agent, 'display_name' | 'name' | 'settings'> | undefined | null>
}): { agentId: string; displayName: string; avatarUrl: string | null } | null {
  const agentId = resolveCurrentAgentId({
    sessionAgentId: input.sessionAgentId,
    selectedAgentId: input.selectedAgent?.id,
  })
  if (!agentId) return null

  const agent = input.agentCache[agentId]
    ?? (input.selectedAgent?.id === agentId ? input.selectedAgent : null)
  const displayName = resolveAgentDisplayName(agent)
  if (!displayName) return null
  return {
    agentId,
    displayName,
    avatarUrl: extractAgentAvatarUrl(agent?.settings),
  }
}
