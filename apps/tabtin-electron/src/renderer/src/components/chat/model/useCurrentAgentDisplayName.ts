import { useMemo } from 'react'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { resolveCurrentAgentDisplay } from './resolveAgentDisplayName'

type CurrentAgentDisplay = NonNullable<ReturnType<typeof resolveCurrentAgentDisplay>>

function useCurrentAgentDisplayState(sessionId: string | null): CurrentAgentDisplay | null {
  const sessionAgentId = useChatStore(
    state => (sessionId ? state.getSessionById(sessionId)?.agent_id : undefined) ?? null,
  )
  const selectedAgent = useSpaceStore(state => state.selectedAgent)
  const agentCache = useSpaceStore(state => state.agentCache)

  return useMemo(() => {
    return resolveCurrentAgentDisplay({
      sessionAgentId,
      selectedAgent,
      agentCache,
    })
  }, [agentCache, selectedAgent, sessionAgentId])
}

/**
 * 当前对话生效的 Agent 展示身份（名 + 头像），与 Agent 选择器同口径。
 * session.agent_id 优先，草稿 / pending 首发回落 selectedAgent；不触发 listAgents。
 */
export function useCurrentAgentDisplay(sessionId: string | null): CurrentAgentDisplay | null {
  return useCurrentAgentDisplayState(sessionId)
}

/**
 * 当前对话生效的 Agent 展示名（与 Agent 选择器同口径）。
 * session.agent_id 优先，草稿 / pending 首发回落 selectedAgent；不触发 listAgents。
 */
export function useCurrentAgentDisplayName(sessionId: string | null): string {
  return useCurrentAgentDisplayState(sessionId)?.displayName ?? ''
}
