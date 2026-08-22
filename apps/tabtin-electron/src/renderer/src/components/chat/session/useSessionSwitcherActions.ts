import { useCallback, useState } from 'react'
import { toast } from '@components/ui'
import type { ChatSession } from '@tabtin/chat-client'
import { listSessionSharesBySession } from '@/services/tabchatApi'
import { useChatStore } from '@/stores/chat/useChatStore'
import {
  archiveSessionWithRestoreToast,
  useInlineArchiveConfirm,
} from './useInlineArchiveConfirm'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import {
  buildSessionReferenceClipboardText,
  warmSpacePathCache,
} from '@/utils/buildSessionReferenceClipboardText'
import { copyToClipboard } from '@components/shared/file-ops/clipboard'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { MAX_SESSION_TITLE_LENGTH } from './sessionSwitcherStorage'
import type { ExternalArchiveDeleteTarget } from './ExternalArchiveDeleteDialog'

export interface RenameDialogState {
  sessionId: string
  initialTitle: string
  value: string
  error: string | null
}

export interface ContextMenuState {
  open: boolean
  x: number
  y: number
  sessionId: string | null
}

export interface UseSessionSwitcherActionsInput {
  sessions: ChatSession[]
  scopeKey?: string | null
  onRenameSession?: (sessionId: string, title: string) => void | Promise<void>
  onDeleteSession?: (sessionId: string) => void | Promise<void>
  externalOpenedSessionIds?: ReadonlySet<string>
  resolveExternalArchiveByOpenedSessionId?: (sessionId: string) => ExternalArchiveDeleteTarget | null
  t: (key: string, opts?: Record<string, unknown>) => string
}

export function useSessionSwitcherActions(input: UseSessionSwitcherActionsInput) {
  const {
    sessions,
    scopeKey,
    onRenameSession,
    onDeleteSession,
    externalOpenedSessionIds,
    resolveExternalArchiveByOpenedSessionId,
    t,
  } = input
  const organizationId = useResolvedOrganizationId()

  const {
    pendingArchiveSessionId,
    requestInlineArchiveConfirm,
    resetArchiveConfirming,
  } = useInlineArchiveConfirm()
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null)
  const [externalArchiveDeleteTarget, setExternalArchiveDeleteTarget] =
    useState<ExternalArchiveDeleteTarget | null>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({
    open: false, x: 0, y: 0, sessionId: null,
  })
  const [shareToColleagueSessionId, setShareToColleagueSessionId] = useState<string | null>(null)
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)

  const buildSessionReferenceText = useCallback((sessionId: string): string | null => {
    const session = sessions.find(item => item.id === sessionId)
    if (!session) {
      toast.error(t('session.copyReferenceFailed', { defaultValue: '复制失败：找不到对话' }))
      return null
    }

    const spaceId = session.space_id ?? session.workspace_id ?? scopeKey ?? null
    const resolvedOrganizationId = session.organization_id ?? organizationId ?? null
    if (!spaceId || !resolvedOrganizationId) {
      toast.error(t('session.copyReferenceFailed', { defaultValue: '复制失败：缺少 Space 上下文' }))
      return null
    }

    warmSpacePathCache(spaceId, resolvedOrganizationId)

    const spaceName = useSpaceStore.getState().spaces.find(sp => sp.id === spaceId)?.name
    const organizationState = useOrganizationStore.getState()
    const organizationName =
      organizationState.organizations.find(wt => wt.id === resolvedOrganizationId)?.name
      ?? organizationState.selectedOrganization?.name

    const text = buildSessionReferenceClipboardText(session, {
      spaceId,
      organizationId: resolvedOrganizationId,
      spaceName,
      organizationName,
    })
    if (!text.trim()) {
      toast.error(t('session.copyReferenceFailed', { defaultValue: '复制失败：内容为空' }))
      return null
    }

    return text
  }, [sessions, scopeKey, organizationId, t])

  const handleCopySessionReference = useCallback((sessionId: string) => {
    const text = buildSessionReferenceText(sessionId)
    if (!text) return

    void copyToClipboard(text).then((ok) => {
      if (ok) {
        toast.success(t('session.copyReferenceSuccess', { defaultValue: '已复制对话引用' }))
      } else {
        toast.error(t('session.copyReferenceFailed', { defaultValue: '复制失败，请重试' }))
      }
    })
  }, [buildSessionReferenceText, t])

  const handleOpenShareToColleague = useCallback((sessionId: string) => {
    setShareToColleagueSessionId(sessionId)
  }, [])

  const isSessionArchived = useCallback((sessionId: string | null) => {
    if (!sessionId) return false
    return sessions.find(item => item.id === sessionId)?.status === 'archived'
  }, [sessions])

  const isExternalOpenedSession = useCallback((sessionId: string | null) => {
    if (!sessionId) return false
    return externalOpenedSessionIds?.has(sessionId) ?? false
  }, [externalOpenedSessionIds])

  const resolveArchiveSpaceId = useCallback((sessionId: string) => {
    const session = sessions.find(item => item.id === sessionId)
    return session?.space_id ?? session?.workspace_id ?? scopeKey ?? null
  }, [scopeKey, sessions])

  const beginArchiveNow = useCallback((sessionId: string) => {
    const spaceId = resolveArchiveSpaceId(sessionId)
    if (spaceId) useChatStore.getState().beginOptimisticArchive(spaceId, sessionId)
  }, [resolveArchiveSpaceId])

  const rollbackArchiveNow = useCallback((sessionId: string) => {
    const spaceId = resolveArchiveSpaceId(sessionId) ?? ''
    useChatStore.getState().rollbackOptimisticArchive(spaceId, sessionId)
  }, [resolveArchiveSpaceId])

  const commitArchiveWithRestoreToast = useCallback((sessionId: string) => {
    if (!onDeleteSession) return
    const session = sessions.find(item => item.id === sessionId)
    const spaceId = resolveArchiveSpaceId(sessionId)
    if (!spaceId) {
      void Promise.resolve(onDeleteSession(sessionId)).catch(() => {
        toast({
          title: t('session.archiveFailed', { defaultValue: '归档失败，请重试' }),
          variant: 'destructive',
        })
      })
      return
    }
    archiveSessionWithRestoreToast({
      spaceId,
      sessionId,
      sessionTitle: session?.title?.trim()
        || t('session.conversationReference.untitled', { defaultValue: '未命名对话' }),
      onDeleteSession,
      onShareConflict: setArchiveTarget,
      t,
    })
  }, [onDeleteSession, resolveArchiveSpaceId, sessions, t])

  const handleArchiveRequest = useCallback((sessionId: string) => {
    // 已归档会话可查看/继续聊，不应再出现「归档」入口
    if (isSessionArchived(sessionId)) return
    // 外部档案展开的本机会话：归档 = 删除本机档案（无法分叉续写）
    if (isExternalOpenedSession(sessionId)) {
      const target = resolveExternalArchiveByOpenedSessionId?.(sessionId)
      if (target) {
        resetArchiveConfirming()
        setExternalArchiveDeleteTarget(target)
        return
      }
    }
    requestInlineArchiveConfirm(sessionId, () => {
      const spaceId = resolveArchiveSpaceId(sessionId)
      if (spaceId) {
        useChatStore.getState().beginOptimisticArchive(spaceId, sessionId)
      }
      void listSessionSharesBySession(sessionId).then((shares) => {
        const isSharing = shares.some(share => share.status === 'pending' || share.status === 'active')
        if (isSharing) {
          if (spaceId) {
            useChatStore.getState().rollbackOptimisticArchive(spaceId, sessionId)
          }
          setArchiveTarget(sessionId)
          return
        }
        commitArchiveWithRestoreToast(sessionId)
      }, () => {
        commitArchiveWithRestoreToast(sessionId)
      })
    })
  }, [
    commitArchiveWithRestoreToast,
    resolveArchiveSpaceId,
    isExternalOpenedSession,
    isSessionArchived,
    requestInlineArchiveConfirm,
    resetArchiveConfirming,
    resolveExternalArchiveByOpenedSessionId,
  ])

  const handleDeleteExternalArchiveRequest = useCallback((target: ExternalArchiveDeleteTarget) => {
    setExternalArchiveDeleteTarget(target)
  }, [])

  const handleRenameRequest = useCallback((sessionId: string) => {
    const session = sessions.find(item => item.id === sessionId)
    const initialTitle = session?.title || t('sessionList.untitled', { defaultValue: '新任务' })
    setRenameDialog({ sessionId, initialTitle, value: initialTitle, error: null })
  }, [sessions, t])

  const handleRenameSubmit = useCallback(async () => {
    if (!renameDialog || !onRenameSession) return
    const nextTitle = renameDialog.value.trim()
    if (!nextTitle) {
      setRenameDialog(prev => prev ? { ...prev, error: t('session.renameEmptyError', { defaultValue: '对话名称不能为空' }) } : prev)
      return
    }
    if (nextTitle.length > MAX_SESSION_TITLE_LENGTH) {
      setRenameDialog(prev => prev ? {
        ...prev,
        error: t('session.renameTooLongError', {
          defaultValue: '对话名称不能超过 {{count}} 个字符',
          count: MAX_SESSION_TITLE_LENGTH,
        }),
      } : prev)
      return
    }
    if (nextTitle === renameDialog.initialTitle.trim()) {
      setRenameDialog(null)
      return
    }

    setIsRenaming(true)
    try {
      await onRenameSession(renameDialog.sessionId, nextTitle)
      toast.success(t('session.renameSuccess', { defaultValue: '对话已重命名' }))
      setRenameDialog(null)
    } catch (error) {
      setRenameDialog(prev => prev ? {
        ...prev,
        error: error instanceof Error ? error.message : t('session.renameFailed', { defaultValue: '重命名失败，请重试' }),
      } : prev)
    } finally {
      setIsRenaming(false)
    }
  }, [onRenameSession, renameDialog, t])

  const closeContextMenu = useCallback(() => {
    setCtxMenu({ open: false, x: 0, y: 0, sessionId: null })
  }, [])

  return {
    pendingArchiveSessionId,
    archiveTarget,
    setArchiveTarget,
    externalArchiveDeleteTarget,
    setExternalArchiveDeleteTarget,
    ctxMenu,
    setCtxMenu,
    shareToColleagueSessionId,
    setShareToColleagueSessionId,
    renameDialog,
    setRenameDialog,
    isRenaming,
    handleCopySessionReference,
    handleOpenShareToColleague,
    isSessionArchived,
    isExternalOpenedSession,
    handleArchiveRequest,
    beginArchiveNow,
    rollbackArchiveNow,
    commitArchiveWithRestoreToast,
    handleDeleteExternalArchiveRequest,
    handleRenameRequest,
    handleRenameSubmit,
    closeContextMenu,
  }
}
