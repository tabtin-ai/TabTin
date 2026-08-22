import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { MessageSquare, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { ScrollArea, ConfirmDialog } from '@tabtin/smartsheet-ui'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { useChatStore } from '@stores/chat/useChatStore'
import { useAgentSettingsSheetStore } from '@stores/useAgentSettingsSheetStore'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { SpaceSettingsSectionHeader } from '@components/space-settings/SpaceSettingsSectionHeader'
import type { ChatSession } from '@tabtin/chat-client'

interface ArchivedChatSessionsSectionProps {
  spaceId: string
  organizationId?: string | null
  className?: string
}

const formatTime = (value?: string | null) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

export const ArchivedChatSessionsSection: React.FC<ArchivedChatSessionsSectionProps> = ({
  spaceId,
  organizationId,
  className,
}) => {
  const { t } = useTranslation('space')
  const listArchivedSessions = useChatStore(state => state.listArchivedSessions)
  const deleteSessionPermanently = useChatStore(state => state.deleteSessionPermanently)
  const closeSettingsSheet = useAgentSettingsSheetStore(state => state.close)

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [restoringSessionId, setRestoringSessionId] = useState<string | null>(null)
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null)
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null)

  const loadArchivedSessions = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const archived = await listArchivedSessions(spaceId, organizationId || undefined, 200)
      setSessions(archived)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('chatArchive.loadFailed'))
    } finally {
      setIsLoading(false)
    }
  }, [listArchivedSessions, spaceId, t, organizationId])

  useEffect(() => {
    void loadArchivedSessions()
  }, [loadArchivedSessions])

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const aTs = Date.parse(a.updated_at || a.created_at || '')
      const bTs = Date.parse(b.updated_at || b.created_at || '')
      return (Number.isNaN(bTs) ? 0 : bTs) - (Number.isNaN(aTs) ? 0 : aTs)
    })
  }, [sessions])

  const handlePermanentDelete = useCallback((sessionId: string) => {
    setDeleteConfirmSessionId(sessionId)
  }, [])

  /**
   * 查看归档对话：只打开正文，不取消归档；可继续聊。
   * 动作走 getState()，避免 hook 闭包拿到过期 action。
   */
  const handleView = useCallback(async (session: ChatSession) => {
    setViewingSessionId(session.id)
    setError(null)
    try {
      await useChatStore.getState().viewArchivedSession(spaceId, session)
      closeSettingsSheet()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('chatArchive.viewFailed'))
    } finally {
      setViewingSessionId(null)
    }
  }, [closeSettingsSheet, spaceId, t])

  /** 取消归档：写回主列表（不强制跳转；需要看就再点标题）。 */
  const handleRestore = useCallback(async (sessionId: string) => {
    setRestoringSessionId(sessionId)
    setError(null)
    try {
      await useChatStore.getState().restoreSession(spaceId, sessionId)
      setSessions(prev => prev.filter(s => s.id !== sessionId))
      toast({ title: t('chatArchive.restoreSuccess'), duration: 2000 })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('chatArchive.restoreFailed')
      setError(message)
      toast({ title: message, variant: 'destructive', duration: 3000 })
    } finally {
      setRestoringSessionId(null)
    }
  }, [spaceId, t])

  const confirmPermanentDelete = useCallback(async () => {
    if (!deleteConfirmSessionId) return
    const sessionId = deleteConfirmSessionId
    setDeletingSessionId(sessionId)
    setError(null)
    try {
      await deleteSessionPermanently(spaceId, sessionId)
      setSessions(prev => prev.filter(s => s.id !== sessionId))
      toast({ title: t('chatArchive.deleteSuccess', { defaultValue: '已永久删除' }), duration: 2000 })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('chatArchive.deleteFailed')
      setError(message)
      toast({ title: message, variant: 'destructive', duration: 3000 })
      throw err
    } finally {
      setDeletingSessionId(null)
    }
  }, [deleteConfirmSessionId, deleteSessionPermanently, spaceId, t])

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      <SpaceSettingsSectionHeader
        marginBottomClassName="mb-2"
        title={t('tabs.archived')}
        description={(
          <>
            <span className="block">{t('chatArchive.description')}</span>
            {sortedSessions.length > 0 && (
              <span className="mt-1.5 block">{sortedSessions.length}</span>
            )}
          </>
        )}
        actions={(
          <button
            type="button"
            onClick={() => { void loadArchivedSessions() }}
            disabled={isLoading}
            title={t('chatArchive.refresh')}
            className="h-8 w-8 shrink-0 rounded-md flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-muted/30 transition-colors"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </button>
        )}
      />

      {error ? (
        <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-1.5 text-caption text-destructive">
          {error}
        </div>
      ) : null}

      {isLoading && sortedSessions.length === 0 ? (
        <div className="mt-2 text-caption text-muted-foreground/60">{t('chatArchive.loading')}</div>
      ) : null}

      {!isLoading && sortedSessions.length === 0 ? (
        <div className="mt-2 flex items-center gap-1.5 text-caption text-muted-foreground/40">
          <MessageSquare className="h-3 w-3" />
          <span>{t('chatArchive.empty')}</span>
        </div>
      ) : null}

      {sortedSessions.length > 0 ? (
        <ScrollArea className="mt-2 flex-1 min-h-0" scrollBar="vertical">
          <div className="space-y-1 pr-1">
          {sortedSessions.map(session => {
            const busy =
              restoringSessionId === session.id
              || deletingSessionId === session.id
              || viewingSessionId === session.id
            return (
            <div
              key={session.id}
              className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/20 transition-colors"
            >
              <button
                type="button"
                className="min-w-0 flex-1 rounded-sm text-left disabled:opacity-50"
                onClick={() => { void handleView(session) }}
                disabled={busy}
                title={t('chatArchive.view')}
              >
                <div className="truncate text-body text-foreground/80 group-hover:text-foreground">
                  {session.title || t('chatArchive.untitled')}
                </div>
                <div className="text-caption text-muted-foreground/40">
                  {t('chatArchive.updatedAt', { time: formatTime(session.updated_at || session.created_at) })}
                  {' · '}
                  {t('chatArchive.messageCount', { count: session.message_count ?? 0 })}
                </div>
              </button>
              <div
                className="flex shrink-0 items-center gap-0.5"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="rounded-md p-1.5 text-muted-foreground/60 opacity-70 hover:text-foreground hover:opacity-100 transition-colors disabled:opacity-40 disabled:hover:opacity-40"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleRestore(session.id)
                  }}
                  disabled={busy}
                  title={t('chatArchive.restore')}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="rounded-md p-1.5 text-muted-foreground/60 opacity-70 hover:text-destructive hover:opacity-100 transition-colors disabled:opacity-40 disabled:hover:opacity-40"
                  onClick={(e) => {
                    e.stopPropagation()
                    handlePermanentDelete(session.id)
                  }}
                  disabled={busy}
                  title={t('chatArchive.delete')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            )
          })}
          </div>
        </ScrollArea>
      ) : null}

      <ConfirmDialog
        open={!!deleteConfirmSessionId}
        onOpenChange={(open) => { if (!open) setDeleteConfirmSessionId(null) }}
        title={t('chatArchive.deleteConfirmTitle', '删除确认')}
        description={t('chatArchive.deleteConfirm')}
        variant="destructive"
        container={null}
        onConfirm={confirmPermanentDelete}
      />
    </div>
  )
}
