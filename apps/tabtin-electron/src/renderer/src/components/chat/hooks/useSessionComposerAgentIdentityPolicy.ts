/**
 * 已落库单会话 Composer（SharedSessionOwner / ChatSplitPane）的 Agent 身份策略。
 *
 * 与 ChatContent 正式会话对齐：展示身份；非 team_space 可换 Agent（只写 session.agent_id）。
 * 不开放工作空间底栏切换（enableAgentPicker=false）。
 */

import { useCallback } from 'react'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { resolveCanChangeAgent } from '../panel/chatContentState'

export interface SessionComposerAgentIdentityPolicy {
  showAgentIdentity: true
  canChangeAgent: boolean
  enableAgentPicker: false
}

export function useSessionComposerAgentIdentityPolicy(
  spaceId: string | null | undefined,
): SessionComposerAgentIdentityPolicy {
  const isTeamSpace = useSpaceStore(
    useCallback(
      (s) => Boolean(spaceId && s.spaces.find((space) => space.id === spaceId)?.type === 'team_space'),
      [spaceId],
    ),
  )

  return {
    showAgentIdentity: true,
    canChangeAgent: resolveCanChangeAgent({ isTeamDraftSpace: isTeamSpace }),
    enableAgentPicker: false,
  }
}
