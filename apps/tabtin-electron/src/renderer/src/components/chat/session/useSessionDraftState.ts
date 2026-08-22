import { useCallback, useMemo } from 'react'
import type { ChatSession } from '@tabtin/chat-client'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { isExternalOpenedSession } from '@components/onboarding/external-import/externalOpenedSessionRegistry'
import { isExternalArchiveDecorationMessage } from '@components/onboarding/external-import/mergeExternalArchiveMessages'

const EMPTY_SESSION_MESSAGES: NonNullable<ReturnType<typeof useChatStore.getState>['messagesBySessionId'][string]> = []

export interface SessionDraftStateInput {
  showDraftSession: boolean
  currentSessionId: string | null
  scopeKey?: string | null
  draftBadgeSpaceId?: string | null
  highlightedSpaceIdOverride?: string | null
  spaceNameById?: Record<string, string>
  /** 列表渲染用（可已过滤空会话）；选中态 lookup 优先用 draftLookupSessions。 */
  sessions: ChatSession[]
  /** 未过滤会话：预建空草稿被滤出列表后仍能判定「当前已是新任务」。 */
  draftLookupSessions?: ChatSession[]
}

export function useSessionDraftState(input: SessionDraftStateInput) {
  const {
    showDraftSession,
    currentSessionId,
    scopeKey,
    draftBadgeSpaceId,
    highlightedSpaceIdOverride,
    spaceNameById,
    sessions,
    draftLookupSessions,
  } = input

  // 列表可滤掉 message_count=0；选中态必须能找到当前预建空会话。
  const lookupSessions = draftLookupSessions ?? sessions

  const isDraftActive = showDraftSession && !currentSessionId
  const effectiveDraftBadgeSpaceId = draftBadgeSpaceId ?? scopeKey ?? null
  const currentSessionMessages = useChatStore(useCallback(
    (s) => currentSessionId ? s.messagesBySessionId[currentSessionId] ?? EMPTY_SESSION_MESSAGES : EMPTY_SESSION_MESSAGES,
    [currentSessionId],
  ))

  const getSessionSpaceId = useCallback((session: ChatSession) => {
    return session.space_id ?? session.workspace_id ?? scopeKey ?? '__unknown__'
  }, [scopeKey])

  const currentBlankNewTaskSpaceId = useMemo(() => {
    if (!currentSessionId) return null
    // 外部档案展开会话服务端 message_count 常为 0，但不是「未发起的新任务」
    if (isExternalOpenedSession(currentSessionId)) return null
    if (currentSessionMessages.some(isExternalArchiveDecorationMessage)) return null
    const currentSession = lookupSessions.find(session => session.id === currentSessionId)
    if (!currentSession || (currentSession.message_count ?? 0) !== 0) return null
    const spaceId = getSessionSpaceId(currentSession)
    return spaceId === '__unknown__' ? null : spaceId
  }, [currentSessionId, currentSessionMessages, lookupSessions, getSessionSpaceId])

  const isAlreadyOnNewTask = isDraftActive || Boolean(currentBlankNewTaskSpaceId)

  const isSpaceAlreadyOnNewTask = useCallback((targetSpaceId: string | null) => {
    if (!targetSpaceId) return false
    if (isDraftActive && effectiveDraftBadgeSpaceId === targetSpaceId) return true
    return currentBlankNewTaskSpaceId === targetSpaceId
  }, [isDraftActive, effectiveDraftBadgeSpaceId, currentBlankNewTaskSpaceId])

  const selectedSpaceId = useSpaceStore(s => s.selectedSpace?.id ?? null)

  const highlightedSpaceId = useMemo(() => {
    if (highlightedSpaceIdOverride !== undefined) {
      return highlightedSpaceIdOverride
    }
    if (currentSessionId) {
      const session = lookupSessions.find(item => item.id === currentSessionId)
      const sessionSpaceId = session ? getSessionSpaceId(session) : null
      if (sessionSpaceId && sessionSpaceId !== '__unknown__') {
        return sessionSpaceId
      }
    }
    if (isDraftActive && effectiveDraftBadgeSpaceId) {
      return effectiveDraftBadgeSpaceId
    }
    if (selectedSpaceId && (!spaceNameById || selectedSpaceId in spaceNameById)) {
      return selectedSpaceId
    }
    if (scopeKey) return scopeKey
    return null
  }, [
    highlightedSpaceIdOverride,
    currentSessionId,
    lookupSessions,
    getSessionSpaceId,
    isDraftActive,
    effectiveDraftBadgeSpaceId,
    selectedSpaceId,
    spaceNameById,
    scopeKey,
  ])

  const draftSpaceName = useSpaceStore(useCallback((state) => {
    if (!effectiveDraftBadgeSpaceId) return state.selectedSpace?.name ?? null
    const selectedSpaceName = state.selectedSpace?.id === effectiveDraftBadgeSpaceId
      ? state.selectedSpace.name
      : null
    return state.spaces.find(space => space.id === effectiveDraftBadgeSpaceId)?.name ?? selectedSpaceName
  }, [effectiveDraftBadgeSpaceId]))

  const highlightedSpaceName = useSpaceStore(useCallback((state) => {
    if (!highlightedSpaceId) return null
    const selectedSpaceName = state.selectedSpace?.id === highlightedSpaceId
      ? state.selectedSpace.name
      : null
    return state.spaces.find(space => space.id === highlightedSpaceId)?.name ?? selectedSpaceName
  }, [highlightedSpaceId]))

  return {
    isDraftActive,
    effectiveDraftBadgeSpaceId,
    getSessionSpaceId,
    currentBlankNewTaskSpaceId,
    isAlreadyOnNewTask,
    isSpaceAlreadyOnNewTask,
    highlightedSpaceId,
    draftSpaceName,
    highlightedSpaceName,
  }
}
