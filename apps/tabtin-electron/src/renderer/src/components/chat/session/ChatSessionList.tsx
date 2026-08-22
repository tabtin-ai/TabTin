import React, { useCallback, useEffect, useMemo } from 'react'
import { useChatStore } from '../../../stores/chat/useChatStore'
import { useSpaceStore } from '../../../stores/useSpaceStore'
import { ChatSessionSwitcher } from './ChatSessionSwitcher'
import { filterSidebarSessions } from './filterSidebarSessions'
import { useTranslation } from 'react-i18next'

interface ChatSessionListProps {
  onSelectSession?: () => void
}

/**
 * 向后兼容组件：
 * 统一复用 ChatSessionSwitcher，避免和标签栏维护两套会话切换逻辑。
 */
export const ChatSessionList: React.FC<ChatSessionListProps> = ({ onSelectSession }) => {
  const { t } = useTranslation('chat')
  const sessions = useChatStore(s => s.sessions)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const visibleSessions = useMemo(
    () => filterSidebarSessions(sessions, currentSessionId),
    [sessions, currentSessionId],
  )
  const isLoading = useChatStore(s => s.isLoading)
  const startDraftSessionForSpace = useChatStore(s => s.startDraftSessionForSpace)
  const loadSessions = useChatStore(s => s.loadSessions)
  const selectSession = useChatStore(s => s.selectSession)
  const deleteSession = useChatStore(s => s.deleteSession)
  const renameSession = useChatStore(s => s.renameSession)
  const forkSession = useChatStore(s => s.forkSession)
  const unforkSession = useChatStore(s => s.unforkSession)

  const selectedSpace = useSpaceStore(state => state.selectedSpace)
  // 会话列表始终由其所属 Space 定位。切换组织的短暂窗口内，不能把新前台组织
  // 和旧 Space 配对去拉取会话。
  const resolvedOrganizationId = selectedSpace?.organization_id ?? null

  const spaceId = selectedSpace?.id || null
  const isDraftSession = useChatStore(s => (spaceId ? s.draftSessionBySpaceId[spaceId] ?? false : false))

  useEffect(() => {
    if (spaceId && resolvedOrganizationId) {
      loadSessions(spaceId, resolvedOrganizationId).catch(err => {
        console.error('[ChatSessionList] Failed to load sessions:', err)
      })
    }
  }, [loadSessions, resolvedOrganizationId, spaceId])

  const handleCreateSession = useCallback(() => {
    if (!spaceId) return
    startDraftSessionForSpace(spaceId)
    onSelectSession?.()
  }, [onSelectSession, spaceId, startDraftSessionForSpace])

  const handleSelectSession = useCallback(async (sessionId: string) => {
    if (!spaceId) return
    await selectSession(spaceId, sessionId)
    onSelectSession?.()
  }, [onSelectSession, selectSession, spaceId])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    if (!spaceId) return
    await deleteSession(spaceId, sessionId)
  }, [deleteSession, spaceId])

  const handleRenameSession = useCallback(async (sessionId: string, title: string) => {
    if (!spaceId) return
    await renameSession(spaceId, sessionId, title)
  }, [renameSession, spaceId])

  const handleForkSession = useCallback(async (sessionId: string) => {
    if (!spaceId) return
    await forkSession(spaceId, sessionId)
  }, [forkSession, spaceId])

  const handleUnforkSession = useCallback(async (sessionId: string) => {
    if (!spaceId) return
    await unforkSession(spaceId, sessionId)
  }, [unforkSession, spaceId])

  if (!spaceId) {
    return (
      <div className="h-full flex items-center justify-center text-body text-muted-foreground px-4 text-center">
        {t('sessionList.noSpace')}
      </div>
    )
  }

  return (
    <ChatSessionSwitcher
      variant="list"
      sessions={visibleSessions}
      draftLookupSessions={sessions}
      currentSessionId={currentSessionId}
      showDraftSession={isDraftSession}
      isLoading={isLoading}
      onSelectSession={handleSelectSession}
      onCreateSession={handleCreateSession}
      onRenameSession={handleRenameSession}
      onDeleteSession={handleDeleteSession}
      onForkSession={handleForkSession}
      onUnforkSession={handleUnforkSession}
      scopeKey={spaceId}
    />
  )
}
