import { useEffect } from 'react'
import { useSpaceStore } from '@stores/useSpaceStore'
import { cn } from '@utils/cn'
import { CHAT_MESSAGE_TEXT_BODY_BASE } from '../../../registry/chatDesignTokens'
import { AgentAvatar } from '../common/AgentAvatar'
import { resolveCurrentAgentDisplay } from '../../../model/resolveAgentDisplayName'

/**
 * 轮次 Agent 身份牌。名称与欢迎页 / 顶栏同口径：
 * cache 命中或同 id 的 selectedAgent；禁止 UUID 短码占位。
 * 外部历史消息可传 displayNameOverride（Codex / Cursor 等来源名）。
 */
export function TurnAgentBadge({
  agentId,
  displayNameOverride,
  avatarUrlOverride,
  avatarIdOverride,
}: {
  agentId?: string | null
  displayNameOverride?: string | null
  avatarUrlOverride?: string | null
  avatarIdOverride?: string | null
}) {
  const selectedAgent = useSpaceStore(state => state.selectedAgent)
  const agentCache = useSpaceStore(state => state.agentCache)
  const loadAgent = useSpaceStore(state => state.loadAgent)

  const overrideName = displayNameOverride?.trim() || null
  const resolved = resolveCurrentAgentDisplay({
    sessionAgentId: agentId,
    selectedAgent,
    agentCache,
  })

  useEffect(() => {
    if (overrideName) return
    if (agentId && !agentCache[agentId]) {
      void loadAgent(agentId)
    }
  }, [agentCache, agentId, loadAgent, overrideName])

  const displayName = overrideName || resolved?.displayName || null
  if (!displayName) return null

  const avatarId = avatarIdOverride?.trim()
    || resolved?.agentId
    || agentId
    || displayName

  return (
    <span
      className="mb-1 inline-flex max-w-48 items-center gap-1.5 text-foreground/55"
      title={displayName}
      data-testid="turn-agent-badge"
    >
      <AgentAvatar
        agentId={avatarId}
        name={displayName}
        avatarUrl={avatarUrlOverride?.trim() || resolved?.avatarUrl}
        // 覆盖 AgentAvatar 默认 h-5；用 ! 避免与 AGENT_AVATAR_20 在无 twMerge 时撞车
        className="!h-8 !w-8"
      />
      <span className={cn('truncate font-medium', CHAT_MESSAGE_TEXT_BODY_BASE)}>
        {displayName}
      </span>
    </span>
  )
}
