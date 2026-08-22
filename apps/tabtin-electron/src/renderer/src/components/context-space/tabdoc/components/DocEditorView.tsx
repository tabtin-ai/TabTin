import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CollabStatus, ForceCloseOverlay } from '@tabtin/collab-core'
import { OnlinePresencePopover } from '@components/collab/OnlinePresencePopover'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Separator,
  toast,
} from '@components/ui'
import { ContextDialogHeader } from '@components/context-space/ContextDialogHeader'
import '@tabtin/tabdoc-ui/editor/prosemirror.css'
import type { TabdocComment, TabdocDocument, ExportFormat } from '@tabtin/tabdoc-ui/api-client'
import {
  COMMENT_RAIL_BREAKPOINT_PX,
  COMMENT_RAIL_WIDTH_PX,
  createDocumentComment,
  deleteDocumentComment,
  exportDocument,
  exportDocumentBlob,
  listDocumentComments,
} from '@tabtin/tabdoc-ui/api-client'
import type { OrganizationMember } from '@tabtin/app-shell'
import type {
  SaveState,
  DocumentSyncState,
  DocumentLoadErrorKind,
} from '@tabtin/tabdoc-ui/use-doc-editor'
import { useAppHostClient } from '@tabtin/app-host-sdk'
import { useTabDocHostActions } from '@tabtin/tabdoc-ui'
import {
  DocumentCommentsSection as SharedDocumentCommentsSection,
  SendToChatButton,
  StartCommentButton,
  DocEditorViewShell,
  HtmlBlockAccessProvider,
  revealDocSelection,
  buildCommentAnchorFromBlockPos,
  buildCommentAnchorFromSelection,
  createCommentDecorationsExtension,
  createYjsCodecFromModule,
  findCommentThreadsAtEditorPos,
  isImageNodeEventTarget,
  type BuildCommentAnchorResult,
  type CommentYjsCodec,
  type DocumentCommentMentionCandidate,
  useCommentRailController,
  useDocEditorViewState,
} from '@tabtin/tabdoc-ui/editor'
import {
  DocumentCommentThreadsHost,
  type CommentThreadsCapabilityMode,
} from '../commentThreads/DocumentCommentThreadsHost'
import { tabdocCommentSubmitErrorDescription } from '../commentThreads/commentSubmitRecovery'
import {
  RemovedFromResourceOverlay,
  useResourceShareDowngrade,
  isPermissionInsufficientForEditing,
  hasLiveResourceAccess,
  shouldShowRemovedOverlay,
  selectResourceShareNotifications,
} from '@components/ui'
import { useNotificationStore } from '@stores/useNotificationStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useContextTabScopeKey } from '@/hooks/useIsContextTabActive'
import { useAuthStore } from '@stores/useAuthStore'
import { MemberApiService } from '@/services/memberApi'
import { electronTabDocEventStreamPort } from '../adapters/electronTabDocEventStreamPort'
import type {
  YDoc,
  HocuspocusProvider,
  CollaborativeState,
  TabDocCollaborationUser,
} from '@tabtin/tabdoc-ui/use-collaborative-doc-editor'
import { TableSelector } from './editor/tabdata-block/TableSelector'
import { DRAG_TYPE_TAB_META } from '@/utils/split-coordinator'
import { sendSelectionToChat } from '@/services/sendSelectionToChat'
import type { ContextInjectPayload } from '@/stores/useContextInjectionStore'
import { useTabDocRevealStore } from '@/stores/useTabDocRevealStore'
import { useTabDocCommentRevealStore } from '@/stores/useTabDocCommentRevealStore'
import { buildPublicShareUrlPrefix } from '@/config/api'
import { shouldShowTabDocForceCloseOverlay } from '../tabdocForceCloseOverlay'
import { useScopedEventListener } from '@hooks/spaceActivity'
import { SendToIMDialog } from '@/components/tabchat/SendToIMDialog'
import type { SendToIMResource } from '@/components/tabchat/sendToIM/types'
import { requestResourceEditAccess } from '@/services/tabchatApi'
import { createLogger } from '@/utils/logger'
import { saveTabdocExportBlob } from './tabdocExportSave'
import { usePermissionDeniedAccessRequest } from '@components/context-space/usePermissionDeniedAccessRequest'

const log = createLogger('DocEditorView')

type ToastWithNativePreference = Parameters<typeof toast>[0] & { preferNative?: boolean }

function showTabdocExportToast(props: ToastWithNativePreference) {
  return toast(props)
}

const MAX_COMMENT_BODY_LENGTH = 2000

function normalizeMentionLabel(value: string | null | undefined): string {
  return (value || '').trim()
}

function buildMentionCandidate(input: {
  userId?: string | null
  nickname?: string | null
  username?: string | null
  email?: string | null
  avatar?: string | null
}): DocumentCommentMentionCandidate | null {
  const userId = normalizeMentionLabel(input.userId)
  if (!userId) return null
  const displayName = normalizeMentionLabel(input.nickname)
    || normalizeMentionLabel(input.username)
    || userId.slice(0, 8)
  const accountName = normalizeMentionLabel(input.username)
  return {
    userId,
    displayName,
    accountName,
    avatar: input.avatar || null,
    email: normalizeMentionLabel(input.email),
    labels: [input.nickname, input.username, input.email, userId]
      .map(normalizeMentionLabel)
      .filter(Boolean),
  }
}

function organizationMemberToMentionCandidate(member: OrganizationMember): DocumentCommentMentionCandidate | null {
  return buildMentionCandidate({
    userId: member.user_id || member.user?.id,
    nickname: member.user?.nickname,
    username: member.user?.username,
    email: member.user?.email,
    avatar: member.user?.avatar,
  })
}

function DocumentCommentsContainer({ documentId, organizationId }: { documentId: string, organizationId: string }) {
  const client = useAppHostClient()
  const { t, i18n } = useTranslation('tabdoc')
  const currentUser = useAuthStore((state) => state.user)
  const [comments, setComments] = useState<TabdocComment[]>([])
  const [commentBody, setCommentBody] = useState('')
  const [mentionCandidates, setMentionCandidates] = useState<DocumentCommentMentionCandidate[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deletingCommentIds, setDeletingCommentIds] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const deletingCommentIdsRef = useRef(new Set<string>())
  const deletedCommentIdsRef = useRef(new Set<string>())

  const loadComments = useCallback(async () => {
    if (!documentId) return
    setIsLoading(true)
    setLoadError(null)
    try {
      const nextComments = await listDocumentComments(client, documentId)
      setComments(nextComments.filter((comment) => !deletedCommentIdsRef.current.has(comment.id)))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('comments.loadFailed', { defaultValue: '评论加载失败' }))
    } finally {
      setIsLoading(false)
    }
  }, [client, documentId, t])

  useEffect(() => {
    let cancelled = false
    if (!documentId) return
    setIsLoading(true)
    setLoadError(null)
    listDocumentComments(client, documentId)
      .then((nextComments) => {
        if (!cancelled) {
          setComments(nextComments.filter((comment) => !deletedCommentIdsRef.current.has(comment.id)))
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : t('comments.loadFailed', { defaultValue: '评论加载失败' }))
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, documentId, t])

  useEffect(() => {
    if (!documentId) return
    const subscription = electronTabDocEventStreamPort.subscribe(documentId, (event) => {
      if (event.event !== 'doc.events.comment') return
      const commentId = typeof event.data?.comment_id === 'string' ? event.data.comment_id : ''
      const action = typeof event.data?.action === 'string' ? event.data.action : 'created'
      if (action === 'deleted') {
        if (commentId) {
          deletedCommentIdsRef.current.add(commentId)
          setComments((items) => items.filter((item) => item.id !== commentId))
        }
        return
      }
      void loadComments()
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [documentId, loadComments])

  useEffect(() => {
    let cancelled = false
    if (!organizationId) {
      setMentionCandidates([])
      return
    }
    MemberApiService.getMembers(organizationId, { limit: 200 })
      .then(({ members }) => {
        if (cancelled) return
        const seen = new Set<string>()
        const nextCandidates: DocumentCommentMentionCandidate[] = []
        const appendCandidate = (candidate: DocumentCommentMentionCandidate | null) => {
          if (!candidate || seen.has(candidate.userId)) return
          seen.add(candidate.userId)
          nextCandidates.push(candidate)
        }
        members.forEach((member) => appendCandidate(organizationMemberToMentionCandidate(member)))
        appendCandidate(buildMentionCandidate({
          userId: currentUser?.id,
          nickname: currentUser?.nickname,
          username: currentUser?.username,
          email: currentUser?.email,
          avatar: currentUser?.avatar,
        }))
        setMentionCandidates(nextCandidates)
      })
      .catch(() => {
        if (!cancelled) setMentionCandidates([])
      })
    return () => {
      cancelled = true
    }
  }, [currentUser?.avatar, currentUser?.email, currentUser?.id, currentUser?.nickname, currentUser?.username, organizationId])

  const handleSubmitComment = useCallback(async (mentionUserIds: string[]) => {
    const body = commentBody.trim()
    if (!body || isSubmitting) return
    setIsSubmitting(true)
    setLoadError(null)
    try {
      const created = await createDocumentComment(client, documentId, body, mentionUserIds)
      setComments((items) => [...items, created])
      setCommentBody('')
      setLoadError(null)
    } catch (error) {
      toast({
        title: t('comments.submitFailed', { defaultValue: '评论发送失败' }),
        description: tabdocCommentSubmitErrorDescription(error, t),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }, [client, commentBody, documentId, isSubmitting, t])

  const handleCommentBodyChange = useCallback((nextValue: string) => {
    setCommentBody(nextValue)
  }, [])

  const handleDeleteComment = useCallback(async (commentId: string) => {
    if (!commentId) return
    if (deletingCommentIdsRef.current.has(commentId)) return
    deletingCommentIdsRef.current.add(commentId)
    setDeletingCommentIds((items) => items.includes(commentId) ? items : [...items, commentId])
    try {
      await deleteDocumentComment(client, documentId, commentId)
      deletedCommentIdsRef.current.add(commentId)
      setComments((items) => items.filter((item) => item.id !== commentId))
    } catch (error) {
      toast({
        title: t('comments.deleteFailed', { defaultValue: '评论删除失败' }),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      deletingCommentIdsRef.current.delete(commentId)
      setDeletingCommentIds((items) => items.filter((item) => item !== commentId))
    }
  }, [client, documentId, t])

  return (
    <SharedDocumentCommentsSection
      comments={comments}
      value={commentBody}
      onValueChange={handleCommentBodyChange}
      onSubmit={handleSubmitComment}
      mentionCandidates={mentionCandidates}
      currentUserId={currentUser?.id ?? null}
      deletingCommentIds={deletingCommentIds}
      onDeleteComment={handleDeleteComment}
      onRetry={loadComments}
      isLoading={isLoading}
      isSubmitting={isSubmitting}
      error={loadError}
      maxLength={MAX_COMMENT_BODY_LENGTH}
      labels={{
        title: t('comments.title', { defaultValue: '全文评论' }),
        placeholder: t('comments.placeholder', { defaultValue: '输入评论' }),
        submit: t('comments.submit', { defaultValue: '发送评论' }),
        deleteComment: t('comments.delete', { defaultValue: '删除' }),
        deletingComment: t('comments.deleting', { defaultValue: '删除中' }),
        retry: t('retry', { defaultValue: '重试' }),
        loading: t('comments.loading', { defaultValue: '正在加载评论...' }),
        unknownUser: t('comments.unknownUser', { defaultValue: '用户' }),
        noMentionResults: t('comments.noMentionResults', { defaultValue: '没有匹配的成员' }),
      }}
      locale={i18n.language || 'zh-CN'}
    />
  )
}

interface DocEditorViewProps {
  document: TabdocDocument | null
  /** 当前标签的资源 ID；文档因 403 被清空后仍用于关闭原标签。 */
  resourceId?: string
  initialPmJson: Record<string, unknown>
  initialMarkdown: string
  editorKey: number
  isLoading: boolean
  saveState: SaveState
  saveMessage: string
  syncState?: DocumentSyncState
  showRevisions: boolean
  onEditorUpdate: (markdown: string, pmJson: Record<string, unknown>) => void
  onDraftSync?: (markdown: string, pmJson: Record<string, unknown>) => void
  onManualSave: () => void
  onToggleRevisions: () => void
  onTitleChange?: (newTitle: string) => void
  onDocumentPropertyChange?: (updates: Record<string, unknown>) => void
  onContentFlushedBeforeExport?: (document: Partial<TabdocDocument>) => void
  /** 与 autosave 同源 CAS baseline（读 ref） */
  getSaveBaseline?: () => { baseVersion: number | null; baseUpdatedAt: string | null }
  onSaveVersion?: () => void
  ydoc?: YDoc | null
  hocuspocusProvider?: HocuspocusProvider | null
  collaborationUser?: TabDocCollaborationUser | null
  collaborative?: CollaborativeState | null
  loadError?: string | null
  loadErrorKind?: DocumentLoadErrorKind | null
  onRetryLoad?: () => void
  isReadonly?: boolean
  isRestoring?: boolean
  onForceCloseReload?: () => void
  /** 手动重连（重建 Provider 保留 Y.Doc/IndexedDB），挂起/断线时工具栏徽标点击触发 */
  onManualReconnect?: () => void
  /** 新建文档打开后自动聚焦标题输入框（一次性） */
  autoFocusTitle?: boolean
  /** 当前分屏 pane 是否活跃；用于表格 chrome body Portal 显隐。 */
  isPaneActive?: boolean
  /** 当前标签是否可见；visibility keepAlive 下非当前标签为 false。 */
  isVisible?: boolean
  /** 资源事件已确认当前用户被撤权，立即显示稳定无权遮罩。 */
  accessRevoked?: boolean
  revokedResourceTitle?: string
}

export function DocEditorView({
  document: doc,
  resourceId,
  initialPmJson,
  initialMarkdown,
  editorKey,
  isLoading,
  saveState,
  saveMessage,
  syncState,
  showRevisions,
  onEditorUpdate,
  onDraftSync,
  onManualSave,
  onToggleRevisions,
  onTitleChange,
  onDocumentPropertyChange,
  onContentFlushedBeforeExport,
  getSaveBaseline,
  onSaveVersion,
  ydoc,
  hocuspocusProvider,
  collaborationUser,
  collaborative,
  loadError,
  loadErrorKind,
  onRetryLoad,
  isReadonly = false,
  isRestoring,
  onForceCloseReload,
  onManualReconnect,
  autoFocusTitle = false,
  isPaneActive = true,
  isVisible = true,
  accessRevoked = false,
  revokedResourceTitle = '',
}: DocEditorViewProps) {
  const { t } = useTranslation('tabdoc')
  const { t: tExport } = useTranslation('export')
  const client = useAppHostClient()
  const hostActions = useTabDocHostActions()
  const activeDocumentId = doc?.id || resourceId
  const docTabScopeKey = useContextTabScopeKey(
    activeDocumentId ? `tabdoc:${activeDocumentId}` : null,
  )
  const storedResourceTitle = useSpaceContextTabsStore((state) => {
    if (!activeDocumentId) return ''
    const tabKey = `tabdoc:${activeDocumentId}`
    const scopeKey = docTabScopeKey ?? state.findSpaceByTabKey(tabKey)
    return scopeKey ? state.itemsBySpace[scopeKey]?.[tabKey]?.title || '' : ''
  })

  const [showTableSelector, setShowTableSelector] = useState(false)
  const handleCreateNewTableRef = useRef<(() => Promise<void>) | undefined>(undefined)

  // stuck_connecting 降级期间保留 collabStatus：手动重连（STUCK→RECONNECTING）后
  // 徽标要继续显示「连接中」反馈，不能因 isFallback 整体消失（ review P2-3）；
  // 其余降级（字段受限/断连超时）维持基线行为——不显示协作状态徽标。
  const collabStatus =
    collaborative && (!collaborative.isFallback || collaborative.syncModeReason === 'stuck_connecting')
      ? collaborative.status
      : null
  const docOnlinePresence = useMemo(() => {
    if (!collaborationUser?.id || !collaborative) return null
    // 现代协作：仅 SYNCED/SYNCING 视为在线；legacy fallback：有协作态即展示
    const modernOnline = Boolean(
      collabStatus
      && (collabStatus === CollabStatus.SYNCED || collabStatus === CollabStatus.SYNCING),
    )
    const fallbackOnline = Boolean(collaborative.isFallback)
    const isOnline = modernOnline || fallbackOnline
    if (!isOnline) return null
    const peers = (collaborative.activeEditors || [])
      .filter(editor => editor.id !== collaborationUser.id)
      .map(editor => ({
        id: editor.id,
        name: editor.name,
        type: editor.type === 'agent' ? 'agent' as const : 'user' as const,
        color: editor.color,
      }))
    return (
      <OnlinePresencePopover
        isOnline={isOnline}
        peers={peers}
        self={{
          id: collaborationUser.id,
          name: collaborationUser.name,
          type: collaborationUser.type === 'agent' ? 'agent' : 'user',
          color: collaborationUser.color,
        }}
      />
    )
  }, [collaborationUser, collaborative, collabStatus])

  // D10 + Wave 5 §D：后端 GET /tabdoc/documents/{id} 已回填 current_user_role；
  // 这是 SSOT，前端不再做 owner_id / organization role 旁路。
  const currentUserRole = doc?.current_user_role
  const canManageShare = useMemo(() => {
    const role = currentUserRole
    return role === 'owner' || role === 'admin'
  }, [currentUserRole])
  const organizationIdForShare = doc?.organization_id || client.getOrganizationId() || ''
  const [sendToIMOpen, setSendToIMOpen] = useState(false)
  const sendToIMResource = useMemo((): SendToIMResource | null => {
    if (!doc?.id) return null
    return {
      kind: 'resource_card',
      ref: {
        type: 'document',
        resourceId: doc.id,
        name: doc.title || '',
        spaceId: doc.space_id ?? undefined,
        hintCarrierAppId: 'tabdoc',
      },
    }
  }, [doc?.id, doc?.space_id, doc?.title])
  const handleOpenSendToIM = useCallback(() => {
    setSendToIMOpen(true)
  }, [])
  const [requestEditConfirmOpen, setRequestEditConfirmOpen] = useState(false)
  const [requestingEditAccess, setRequestingEditAccess] = useState(false)
  const [editAccessRequested, setEditAccessRequested] = useState(false)
  useEffect(() => {
    setEditAccessRequested(false)
    setRequestingEditAccess(false)
    setRequestEditConfirmOpen(false)
  }, [doc?.id])
  const canRequestEditAccess = Boolean(
    doc?.id
    && hasLiveResourceAccess(currentUserRole)
    && isPermissionInsufficientForEditing(currentUserRole),
  )
  const handleOpenRequestEditConfirm = useCallback(() => {
    if (!canRequestEditAccess || requestingEditAccess || editAccessRequested) return
    setRequestEditConfirmOpen(true)
  }, [canRequestEditAccess, editAccessRequested, requestingEditAccess])
  const handleConfirmRequestEditAccess = useCallback(async () => {
    if (!doc?.id || !canRequestEditAccess || requestingEditAccess || editAccessRequested) {
      return
    }
    setRequestingEditAccess(true)
    try {
      await requestResourceEditAccess('document', doc.id)
      setEditAccessRequested(true)
      setRequestEditConfirmOpen(false)
      toast({
        title: t('requestEditAccessSubmitted', {
          defaultValue: '已提交编辑申请',
        }),
        description: t('requestEditAccessSubmittedDesc', {
          defaultValue: '已通知资源所有者，通过后即可编辑',
        }),
      })
    } catch (err) {
      log.warn('request edit access failed', { documentId: doc.id, error: err })
      toast({
        title: t('requestEditAccessFailed', { defaultValue: '申请失败' }),
        description: err instanceof Error
          ? err.message
          : t('requestEditAccessFailedDesc', { defaultValue: '请稍后重试' }),
        variant: 'destructive',
      })
    } finally {
      setRequestingEditAccess(false)
    }
  }, [
    canRequestEditAccess,
    doc?.id,
    editAccessRequested,
    requestingEditAccess,
    t,
  ])

  // Wave 4 F6 (PRD §五块 2.3 末段):订阅 NotificationStore,实时降级响应。
  //  - resource_shared + action='removed'/'auto_removed' + 命中当前 docId → 显示遮罩
  //  - resource_shared + action='permission_changed' + 新权限 < editor → 切换 readonly + toast
  // 订阅整个 notifications(store 内引用稳定),外层 useMemo 派生 — 避免 selector 每次返回新数组
  // 触发 zustand v5 + React useSyncExternalStore 的 "getSnapshot should be cached" 无限循环。
  const allNotifications = useNotificationStore((s) => s.notifications)
  const resourceNotifications = useMemo(
    () => selectResourceShareNotifications(allNotifications, 'doc', activeDocumentId ?? null),
    [activeDocumentId, allNotifications],
  )
  const downgrade = useResourceShareDowngrade('doc', activeDocumentId ?? null, resourceNotifications)
  const downgradeInsufficient = isPermissionInsufficientForEditing(downgrade.changedPermission)
  // ：仅当 role 在 removed 通知之后重新拉取确认 viewer+ 时，才压住历史遮罩
  const [roleFetchedAtMs, setRoleFetchedAtMs] = useState(0)
  useEffect(() => {
    if (doc?.id && currentUserRole) {
      setRoleFetchedAtMs(Date.now())
    }
  }, [doc?.id, currentUserRole])
  const showRemovedOverlay = accessRevoked || shouldShowRemovedOverlay({
    isRemoved: downgrade.isRemoved,
    role: currentUserRole,
    removedAt: downgrade.sourceCreatedAt,
    roleFetchedAtMs,
  })
  const accessRequest = usePermissionDeniedAccessRequest({
    resourceType: 'document',
    resourceId: activeDocumentId || '',
  })
  const canRequestRemovedResourceAccess = downgrade.removalAction !== 'auto_removed'

  // 权限降级 toast — 仅当从 editor+ 降到 viewer 时触发一次(避免反复弹)
  const lastToastedNotifIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!downgradeInsufficient || !downgrade.sourceNotificationId) return
    if (lastToastedNotifIdRef.current === downgrade.sourceNotificationId) return
    lastToastedNotifIdRef.current = downgrade.sourceNotificationId
    const permLabel = downgrade.changedPermission
      ? t(`share.permission.${downgrade.changedPermission}Label`, {
          ns: 'common',
          defaultValue: downgrade.changedPermission,
        })
      : ''
    toast({
      title: t('share.editor.permissionChanged.toast', {
        ns: 'common',
        permission: permLabel,
        defaultValue: `你的权限已变更为 ${permLabel},编辑器已切换为只读`,
      }),
    })
  }, [downgradeInsufficient, downgrade.sourceNotificationId, downgrade.changedPermission, t])

  // 返回空间:关闭当前 tab + 切回 SpaceHome(若 tab 在 store 中能定位)
  const handleReturnFromRemoved = useCallback(() => {
    const docId = activeDocumentId
    if (!docId) return
    const tabsStore = useSpaceContextTabsStore.getState()
    const spaceId = docTabScopeKey ?? tabsStore.findSpaceByTabKey(`tabdoc:${docId}`)
    if (spaceId) {
      const tabKey = `tabdoc:${docId}`
      if (tabsStore.closeExplicitTab) tabsStore.closeExplicitTab(spaceId, tabKey)
      else tabsStore.closeTab(spaceId, tabKey)
    }
  }, [activeDocumentId, docTabScopeKey])

  const roleReadonly = isPermissionInsufficientForEditing(currentUserRole)
  const collabReadonly = Boolean(collaborative && !collaborative.isFallback && collaborative.readOnly)
  const effectiveReadonly = Boolean(
    isReadonly || accessRevoked || roleReadonly || collabReadonly || downgradeInsufficient,
  )

  const guardedEditorUpdate = useCallback((markdown: string, pmJson: Record<string, unknown>) => {
    if (effectiveReadonly) return
    onEditorUpdate(markdown, pmJson)
  }, [effectiveReadonly, onEditorUpdate])

  const guardedDraftSync = useCallback((markdown: string, pmJson: Record<string, unknown>) => {
    if (effectiveReadonly) return
    onDraftSync?.(markdown, pmJson)
  }, [effectiveReadonly, onDraftSync])

  const guardedManualSave = useCallback(() => {
    if (effectiveReadonly) return
    onManualSave()
  }, [effectiveReadonly, onManualSave])

  const guardedSaveVersion = useCallback(() => {
    if (effectiveReadonly) return
    onSaveVersion?.()
  }, [effectiveReadonly, onSaveVersion])

  // ── comment_threads_v1 宿主状态 ──
  const [commentCapabilityMode, setCommentCapabilityMode] = useState<CommentThreadsCapabilityMode>('loading')
  const {
    railOpen: commentRailOpen,
    activeThreadId: activeCommentThreadId,
    setRailOpen: setCommentRailOpen,
    setActiveThreadId: setActiveCommentThreadId,
    openThread: openCommentThread,
    clearActiveThreadUnlessCommentTarget,
  } = useCommentRailController()
  const [pendingCommentAnchor, setPendingCommentAnchor] = useState<BuildCommentAnchorResult | null>(null)
  const [outlineCollapsedForComments, setOutlineCollapsedForComments] = useState(false)
  const [commentFocusToken, setCommentFocusToken] = useState(0)
  const [commentRailContainer, setCommentRailContainer] = useState<HTMLDivElement | null>(null)
  const pendingCommentReveal = useTabDocCommentRevealStore((state) => (
    activeDocumentId ? state.pendingByDocumentId[activeDocumentId] ?? null : null
  ))
  const consumeCommentReveal = useTabDocCommentRevealStore((state) => state.consumeCommentReveal)
  const [viewportWidth, setViewportWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  )

  const handleNotificationRevealHandled = useCallback((
    requestId: number,
    result: 'revealed' | 'unavailable',
  ) => {
    if (!activeDocumentId) return
    consumeCommentReveal(activeDocumentId, requestId)
    if (result === 'unavailable') {
      toast({
        title: t('comments.notificationUnavailable', { defaultValue: '该评论已不可用' }),
      })
    }
  }, [activeDocumentId, consumeCommentReveal, t])

  useEffect(() => {
    if (!activeDocumentId || !pendingCommentReveal || commentCapabilityMode !== 'legacy') return
    consumeCommentReveal(activeDocumentId, pendingCommentReveal.requestId)
    toast({
      title: t('comments.notificationUnavailable', { defaultValue: '该评论已不可用' }),
    })
  }, [
    activeDocumentId,
    commentCapabilityMode,
    consumeCommentReveal,
    pendingCommentReveal,
    t,
  ])

  useScopedEventListener<PointerEvent>(
    typeof document === 'undefined' ? null : document,
    'pointerdown',
    (event) => {
      clearActiveThreadUnlessCommentTarget(event.target)
    },
    {
      scope: 'foreground',
      enabled: commentCapabilityMode === 'threads' && Boolean(activeCommentThreadId),
      capture: true,
    },
  )
  const commentResolveOptions = useMemo(
    () => ({ yjsCodec: null as CommentYjsCodec | null }),
    [],
  )
  const commentDecorationsExtension = useMemo(
    () => createCommentDecorationsExtension({ resolveOptions: commentResolveOptions }),
    [commentResolveOptions],
  )

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!ydoc) {
      commentResolveOptions.yjsCodec = null
      return
    }
    // 动态模块名避免 Electron 包未直声明 y-prosemirror 时 tsc 报 TS2307；运行时缺失则回退
    const yProsemirrorModuleId = 'y-prosemirror'
    void import(/* @vite-ignore */ yProsemirrorModuleId)
      .then((mod) => {
        if (cancelled) return
        commentResolveOptions.yjsCodec = createYjsCodecFromModule(mod as Parameters<typeof createYjsCodecFromModule>[0])
      })
      .catch(() => {
        // 无 y-prosemirror 时跳过 Yjs 锚点策略（Task 3 已支持回退）
        if (!cancelled) commentResolveOptions.yjsCodec = null
      })
    return () => {
      cancelled = true
    }
  }, [commentResolveOptions, ydoc])

  const viewState = useDocEditorViewState({
    document: doc,
    initialPmJson,
    initialMarkdown,
    editorKey,
    isLoading,
    saveState,
    saveMessage,
    showRevisions,
    onEditorUpdate: guardedEditorUpdate,
    onDraftSync: guardedDraftSync,
    onManualSave: guardedManualSave,
    onToggleRevisions,
    onTitleChange,
    onDocumentPropertyChange,
    onContentFlushedBeforeExport,
    getSaveBaseline,
    onSaveVersion: guardedSaveVersion,
    ydoc,
    hocuspocusProvider,
    collaborationUser,
    collaborative,
    slashHostActions: {
      onRequestCreateDatabase: () => void handleCreateNewTableRef.current?.(),
      onRequestSelectTable: () => setShowTableSelector(true),
    },
    t: (key, opts) => t(key, opts) as string,
    autoFocusTitle,
    extraExtensions: [commentDecorationsExtension],
    toolbarExtraProps: {
      syncState,
      collabStatus,
      // 挂起信号不因 isFallback 置空：stuck 降级后仍需显示「连接异常」+ 重连入口
      collabConnectionStatus: collaborative?.connectionStatus ?? null,
      onCollabReconnect: onManualReconnect,
      organizationId: organizationIdForShare,
      shareUrlPrefix: buildPublicShareUrlPrefix('doc'),
      canManage: canManageShare,
      canEdit: !effectiveReadonly,
      onlinePresence: docOnlinePresence,
      onSendToIM: sendToIMResource ? handleOpenSendToIM : undefined,
      onRequestEditAccess:
        canRequestEditAccess && !editAccessRequested
          ? handleOpenRequestEditConfirm
          : undefined,
    },
  })

  const startCommentFromSelection = useCallback(() => {
    if (commentCapabilityMode !== 'threads') return
    const editor = viewState.editorInstanceRef.current
    if (!editor) return
    const built = buildCommentAnchorFromSelection(editor, {
      yjsCodec: commentResolveOptions.yjsCodec,
    })
    if (!built) {
      toast({
        title: t('comments.needSelection', { defaultValue: '请先选择要评论的内容' }),
      })
      return
    }
    setPendingCommentAnchor(built)
    openCommentThread(null)
    setCommentFocusToken((token) => token + 1)
  }, [commentCapabilityMode, commentResolveOptions, openCommentThread, t, viewState.editorInstanceRef])

  const handleCommentBlock = useCallback((nodePos: number) => {
    if (commentCapabilityMode !== 'threads') return
    const editor = viewState.editorInstanceRef.current
    if (!editor) return
    const built = buildCommentAnchorFromBlockPos(editor, nodePos, {
      yjsCodec: commentResolveOptions.yjsCodec,
    }) || buildCommentAnchorFromSelection(editor, {
      yjsCodec: commentResolveOptions.yjsCodec,
    })
    if (!built) {
      toast({
        title: t('comments.needSelection', { defaultValue: '请先选择要评论的内容' }),
      })
      return
    }
    setPendingCommentAnchor(built)
    openCommentThread(null)
    setCommentFocusToken((token) => token + 1)
  }, [commentCapabilityMode, commentResolveOptions, openCommentThread, t, viewState.editorInstanceRef])

  const viewStateWithCommentShortcut = useMemo(() => ({
    ...viewState,
    handleContainerKeyDown: (event: React.KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const modPressed = event.metaKey || event.ctrlKey
      if (
        modPressed
        && event.altKey
        && !event.shiftKey
        && key === 'm'
        && commentCapabilityMode === 'threads'
      ) {
        event.preventDefault()
        startCommentFromSelection()
        return
      }
      viewState.handleContainerKeyDown(event)
    },
  }), [commentCapabilityMode, startCommentFromSelection, viewState])

  const consumePendingReveal = useTabDocRevealStore(s => s.consumePendingReveal)
  const pendingReveal = useTabDocRevealStore(
    s => (doc?.id ? s.pendingRevealByDocId[doc.id] ?? null : null),
  )

  useEffect(() => {
    if (!doc?.id || isLoading || !pendingReveal) return
    let cancelled = false
    let timer: number | null = null

    const attemptReveal = (remainingRetries: number) => {
      if (cancelled || !doc?.id) return
      const editor = viewState.editorInstanceRef.current
      const scrollContainer = viewState.scrollRef.current
      if (!editor?.view || !scrollContainer) {
        if (remainingRetries <= 0) return
        timer = window.setTimeout(() => attemptReveal(remainingRetries - 1), 100)
        return
      }

      const reveal = pendingReveal
      const result = revealDocSelection(editor, scrollContainer, {
        blockIds: reveal.blockIds,
        fullText: reveal.fullText,
      })
      if (result.matched) {
        consumePendingReveal(doc.id, reveal.requestId)
        return
      }

      if (remainingRetries > 0) {
        timer = window.setTimeout(() => attemptReveal(remainingRetries - 1), 100)
        return
      }

      const consumed = consumePendingReveal(doc.id, reveal.requestId)
      if (!consumed) return
      if (!result.matched) {
        console.warn('[TabDoc] pending reveal target not found', {
          documentId: doc.id,
          requestId: reveal.requestId,
          hasBlockIds: Boolean(reveal.blockIds?.length),
          hasFullText: Boolean(reveal.fullText),
        })
      }
    }

    attemptReveal(3)
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [
    doc?.id,
    isLoading,
    pendingReveal,
    consumePendingReveal,
    viewState.editorInstanceRef,
    viewState.scrollRef,
  ])

  // ── TabData 嵌入块集成 ──
  const handleTableSelected = useCallback(
    (table: { id: string; name: string }) => {
      viewState.editorInstanceRef.current
        ?.chain()
        .focus()
        .insertTabDataBlock({ tableId: table.id, title: table.name })
        .run()
    },
    [],
  )

  const docRef = useRef(doc)
  docRef.current = doc

  const handleCreateNewTable = useCallback(async () => {
    const currentDoc = docRef.current
    if (!currentDoc?.id) return
    try {
      const table = await hostActions.createEmbeddedTable({
        organizationId: client.getOrganizationId(),
        spaceId: currentDoc.space_id ?? null,
        sourceDocumentId: currentDoc.id,
        title: t('tabdataBlock.untitled'),
      })
      handleTableSelected(table)
    } catch (error) {
      toast({
        title: t('tabdataBlock.createFailed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    }
  }, [client, handleTableSelected, hostActions, t])
  handleCreateNewTableRef.current = handleCreateNewTable

  const handleSendToChat = useCallback((payload: {
    type: string
    resourceId: string
    label: string
    spaceId?: string
    preview: string
    meta: Record<string, unknown>
  }) => {
    const injectPayload: ContextInjectPayload = {
      type: (payload.type === 'doc_selection' ? 'doc_selection' : 'document'),
      resourceId: payload.resourceId,
      label: payload.label,
      spaceId: payload.spaceId,
      preview: payload.preview,
      meta: payload.meta,
      tabType: 'tabdoc',
    }
    sendSelectionToChat({
      payload: injectPayload,
      resource: {
        kind: 'tabdoc',
        id: payload.resourceId,
        title: docRef.current?.title || payload.label,
        spaceId: payload.spaceId || docRef.current?.space_id || null,
      },
    })
  }, [])

  // ── Electron 导出流程（waitForSave + 确认对话框） ──
  const [electronExporting, setElectronExporting] = useState(false)
  const [waitingForSave, setWaitingForSave] = useState(false)
  const exportConfirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  const [exportConfirmDialog, setExportConfirmDialog] = useState<{ open: boolean; message: string }>({ open: false, message: '' })

  const showExportConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      exportConfirmResolverRef.current = resolve
      setExportConfirmDialog({ open: true, message })
    })
  }, [])

  const handleExportConfirmResult = useCallback((confirmed: boolean) => {
    setExportConfirmDialog({ open: false, message: '' })
    exportConfirmResolverRef.current?.(confirmed)
    exportConfirmResolverRef.current = null
  }, [])

  const saveStateRef = useRef<SaveState>(saveState)
  const saveStateResolversRef = useRef<Set<(state: SaveState) => void>>(new Set())
  useEffect(() => {
    saveStateRef.current = saveState
    if (saveStateResolversRef.current.size > 0) {
      for (const resolver of saveStateResolversRef.current) resolver(saveState)
    }
  }, [saveState])

  const waitForSave = useCallback(async (): Promise<'ok' | 'timeout' | 'error'> => {
    const current = saveStateRef.current
    if (current === 'saved' || current === 'idle') return 'ok'
    if (current === 'error') return 'error'
    setWaitingForSave(true)
    try {
      return await new Promise<'ok' | 'timeout' | 'error'>((resolve) => {
        let settled = false
        const resolver = (state: SaveState) => {
          if (settled) return
          if (state === 'saved' || state === 'idle' || state === 'error') {
            settled = true
            clearTimeout(timeout)
            saveStateResolversRef.current.delete(resolver)
            resolve(state === 'error' ? 'error' : 'ok')
          }
        }
        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          saveStateResolversRef.current.delete(resolver)
          resolve('timeout')
        }, 15000)
        saveStateResolversRef.current.add(resolver)
      })
    } finally {
      setWaitingForSave(false)
    }
  }, [])

  const electronHandleExport = useCallback(
    async (format: ExportFormat) => {
      if (!doc || electronExporting || waitingForSave) return
      setElectronExporting(true)
      let dismissExportToast: (() => void) | null = null
      try {
        if (saveState === 'error') {
          const ok = await showExportConfirm(t('exportSaveErrorConfirm', { defaultValue: '当前有保存失败的内容，导出可能不包含最新修改。是否继续导出？' }))
          if (!ok) return
        } else if (saveState === 'dirty' || saveState === 'saving') {
          toast({ title: t('exportUnsavedWarning'), description: t('exportUnsavedDesc') })
          if (saveState === 'dirty') onManualSave()
          const saveResult = await waitForSave()
          if (saveResult === 'error') {
            if (!await showExportConfirm(t('exportSaveErrorConfirm', { defaultValue: '当前有保存失败的内容，导出可能不包含最新修改。是否继续导出？' }))) return
          } else if (saveResult === 'timeout') {
            if (!await showExportConfirm(t('exportSaveTimeoutConfirm', { defaultValue: '有未保存的更改，导出内容可能不完整。是否继续导出？' }))) return
          }
        }

        const extMap: Record<string, string> = { markdown: '.md', html: '.html', txt: '.txt', docx: '.docx', pdf: '.pdf' }
        const dedupeExt = (name: string, ext: string) =>
          name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext

        const exportToastId = `tabdoc-export-${doc.id}`
        dismissExportToast = showTabdocExportToast({
          id: exportToastId,
          title: t('exportInProgress', { defaultValue: '正在导出...' }),
          description: undefined,
          action: undefined,
          variant: undefined,
          duration: 60_000,
          preferNative: true,
        }).dismiss

        let exportUsedBrowserFallback = false
        const saveBlobAndResolvePath = async (blob: Blob, downloadName: string): Promise<string | null | 'cancelled'> => {
          const saveResult = await saveTabdocExportBlob(blob, downloadName)
          if (saveResult.status === 'cancelled') return 'cancelled'
          if (saveResult.status === 'fallback') {
            exportUsedBrowserFallback = true
            return null
          }
          return saveResult.status === 'saved' ? saveResult.path : null
        }

        await viewState.flushEditorContentBeforeExport()

        let exportPath: string | null = null
        if (format === 'docx' || format === 'pdf') {
          const { blob, filename } = await exportDocumentBlob(client, doc.id, format)
          const saveResult = await saveBlobAndResolvePath(blob, dedupeExt(filename, extMap[format]))
          if (saveResult === 'cancelled') {
            dismissExportToast?.()
            dismissExportToast = null
            return
          }
          exportPath = saveResult
        } else {
          const result = await exportDocument(client, doc.id, format)
          const blob = new Blob([result.content], { type: result.mime_type || 'text/plain;charset=utf-8' })
          const ext = extMap[format] || `.${format}`
          const name = result.filename ? dedupeExt(result.filename, ext) : dedupeExt(doc.title, ext)
          const saveResult = await saveBlobAndResolvePath(blob, name)
          if (saveResult === 'cancelled') {
            dismissExportToast?.()
            dismissExportToast = null
            return
          }
          exportPath = saveResult
        }

        const savedPath = exportPath
        showTabdocExportToast({
          id: exportToastId,
          title: t('exportSuccess'),
          description: exportUsedBrowserFallback
            ? t('exportSavedByBrowser', { defaultValue: '已开始下载，保存位置由系统下载设置决定' })
            : undefined,
          action: savedPath ? (
            <Button
              variant="link"
              className="h-auto p-0 text-accent"
              onClick={() => void window.tabtin?.showItemInFolder?.(savedPath)}
            >
              {tExport('success.showInFolder', { defaultValue: '打开文件位置' })}
            </Button>
          ) : undefined,
          variant: undefined,
          duration: savedPath || exportUsedBrowserFallback ? 6000 : 4000,
          preferNative: true,
        })
        dismissExportToast = null
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          dismissExportToast?.()
          dismissExportToast = null
          return
        }
        const retryFormat = format
        showTabdocExportToast({
          id: `tabdoc-export-${doc.id}`,
          title: t('exportFailed'),
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
          action: (
            <Button variant="link" className="h-auto p-0 text-accent" onClick={() => void electronHandleExport(retryFormat)}>
              {t('retry', { defaultValue: '重试' })}
            </Button>
          ),
          preferNative: true,
        })
      } finally {
        setElectronExporting(false)
      }
    },
    [client, doc, t, tExport, electronExporting, waitingForSave, saveState, onManualSave, waitForSave, showExportConfirm, viewState.flushEditorContentBeforeExport],
  )

  const electronToolbarProps = useMemo(() => ({
    ...viewState.toolbarProps,
    exporting: electronExporting,
    waitingForSave,
    onExport: electronHandleExport,
  }), [viewState.toolbarProps, electronExporting, waitingForSave, electronHandleExport])

  const electronEditorProps = useMemo(() => {
    const baseProps = viewState.editorProps as Record<string, any>
    const baseHandleClick = baseProps.handleClick as
      | ((view: unknown, pos: number, event: MouseEvent) => boolean)
      | undefined
    const baseKeydown = baseProps.handleDOMEvents?.keydown as
      | ((view: unknown, event: KeyboardEvent) => boolean)
      | undefined

    return {
      ...baseProps,
      editable: () => !isRestoring && !effectiveReadonly,
      handleClick: (view: any, pos: number, event: MouseEvent) => {
        if (commentCapabilityMode === 'threads') {
          const target = event.target as HTMLElement | null
          const badgeThreadId = target?.closest?.('[data-comment-thread-id]')
            ?.getAttribute?.('data-comment-thread-id')
          if (!badgeThreadId && isImageNodeEventTarget(target)) {
            return false
          }
          const hits = badgeThreadId
            ? [badgeThreadId]
            : findCommentThreadsAtEditorPos({ state: view.state }, pos)
          if (hits.length > 0) {
            openCommentThread(hits[0]!)
            return true
          }
        }
        return baseHandleClick?.(view, pos, event) ?? false
      },
      handleDOMEvents: {
        ...(baseProps.handleDOMEvents || {}),
        keydown: (view: unknown, event: KeyboardEvent) => {
          const key = event.key.toLowerCase()
          const modPressed = event.metaKey || event.ctrlKey
          if (modPressed && event.altKey && !event.shiftKey && key === 'm') {
            if (commentCapabilityMode === 'threads') {
              event.preventDefault()
              startCommentFromSelection()
              return true
            }
          }
          return baseKeydown?.(view, event) ?? false
        },
      },
      handleDrop: (view: any, event: DragEvent, _slice: any, moved: boolean) => {
        if (effectiveReadonly) return false
        if (!moved) {
          const metaRaw = event.dataTransfer?.getData(DRAG_TYPE_TAB_META)
          if (metaRaw) {
            try {
              const payload = JSON.parse(metaRaw) as { type?: string; id?: string; title?: string; viewId?: string }
              if (payload.type === 'tabdata' && payload.id) {
                event.preventDefault()
                const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
                const rawPos = coords?.pos ?? view.state.doc.content.size
                const $pos = view.state.doc.resolve(rawPos)
                const insertPos = $pos.depth > 0 ? $pos.after($pos.depth) : $pos.pos
                const node = view.state.schema.nodes.tabdataBlock?.create({
                  tableId: payload.id, viewId: payload.viewId || null, title: payload.title || '未命名表格',
                })
                if (node) view.dispatch(view.state.tr.insert(insertPos, node))
                return true
              }
            } catch { /* ignore malformed payload */ }
          }

          const dropFiles = event.dataTransfer?.files
          if (dropFiles && dropFiles.length > 0) {
            const imageFiles = Array.from(dropFiles).filter((f: File) => f.type.startsWith('image/'))
            if (imageFiles.length > 1) {
              event.preventDefault()
              const MAX_BATCH = 10
              const MAX_FILE_SIZE = 20 * 1024 * 1024
              const validFiles = imageFiles.slice(0, MAX_BATCH).filter((f: File) => f.size <= MAX_FILE_SIZE)
              if (validFiles.length < imageFiles.length) {
                toast({
                  title: t('imageBatchLimited', { defaultValue: '部分图片被跳过' }),
                  description: t('imageBatchLimitedDesc', { defaultValue: `单次最多 ${MAX_BATCH} 张，单张不超过 20MB` }),
                })
              }
              const upload = doc?.id ? viewState.createEditorUploadFn(doc.id) : viewState.docUploadFn
              if (upload) {
                const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
                const pos = coords?.pos ?? view.state.selection.from
                const docSize = view.state.doc.content.size
                for (let i = 0; i < validFiles.length; i++) upload(validFiles[i], view, Math.min(pos + i, docSize))
              }
              return true
            }
          }
        }
        return baseProps.handleDrop?.(view, event, _slice, moved) ?? false
      },
    }
  }, [
    commentCapabilityMode,
    doc?.id,
    effectiveReadonly,
    isRestoring,
    openCommentThread,
    startCommentFromSelection,
    t,
    viewState.createEditorUploadFn,
    viewState.docUploadFn,
    viewState.editorProps,
  ])

  const shouldShowForceCloseOverlay = shouldShowTabDocForceCloseOverlay(
    collaborative?.forceCloseMessage,
    loadError,
  )

  const htmlBlockAccess = useMemo(
    () => ({
      documentId: doc?.id,
    }),
    [doc?.id],
  )

  return (
    <HtmlBlockAccessProvider value={htmlBlockAccess}>
    <DocEditorViewShell
      document={doc}
      isLoading={isLoading}
      loadError={loadError}
      loadErrorFallback={(
        loadErrorKind === 'permission_denied'
        || loadErrorKind === 'not_found'
      ) && activeDocumentId ? (
        <RemovedFromResourceOverlay
          resourceTitle={
            revokedResourceTitle
            || downgrade.resourceTitle
            || doc?.title
            || storedResourceTitle
          }
          action={loadErrorKind === 'not_found' ? 'unavailable' : (downgrade.removalAction || 'removed')}
          onReturn={handleReturnFromRemoved}
          onRequestView={loadErrorKind === 'permission_denied' && canRequestRemovedResourceAccess
            ? accessRequest.requestViewAccess
            : undefined}
          onRequestEdit={loadErrorKind === 'permission_denied' && canRequestRemovedResourceAccess
            ? accessRequest.requestEditAccess
            : undefined}
          requestingRole={accessRequest.requestingRole}
          requestedRole={accessRequest.requestedRole}
          t={(key, opts) => t(key, { ns: 'common', ...opts }) as string}
        />
      ) : undefined}
      onRetryLoad={onRetryLoad}
      showRevisions={showRevisions}
      ydoc={ydoc}
      t={(key, opts) => t(key, opts) as string}
      viewState={viewStateWithCommentShortcut}
      toolbarProps={electronToolbarProps}
      editorProps={electronEditorProps}
      readOnly={effectiveReadonly}
      isPaneActive={isPaneActive}
      isVisible={isVisible}
      outlineCollapsed={outlineCollapsedForComments}
      onCommentBlock={commentCapabilityMode === 'threads' ? handleCommentBlock : undefined}
      afterEditorContent={doc?.id ? (
        commentCapabilityMode === 'legacy' ? (
          <DocumentCommentsContainer
            documentId={doc.id}
            organizationId={doc.organization_id || client.getOrganizationId() || ''}
          />
        ) : (
          <DocumentCommentThreadsHost
            documentId={doc.id}
            organizationId={doc.organization_id || client.getOrganizationId() || ''}
            editorRef={viewState.editorInstanceRef}
            scrollContainerRef={viewState.scrollRef}
            yjsCodec={commentResolveOptions.yjsCodec}
            railOpen={commentRailOpen}
            onRailOpenChange={setCommentRailOpen}
            activeThreadId={activeCommentThreadId}
            onActiveThreadIdChange={setActiveCommentThreadId}
            pendingAnchor={pendingCommentAnchor}
            onPendingAnchorConsumed={() => setPendingCommentAnchor(null)}
            onCollapseOutlineChange={setOutlineCollapsedForComments}
            focusComposerToken={commentFocusToken}
            viewportWidth={viewportWidth}
            railContainer={commentRailContainer}
            onCapabilityModeChange={setCommentCapabilityMode}
            notificationReveal={pendingCommentReveal}
            onNotificationRevealHandled={handleNotificationRevealHandled}
          />
        )
      ) : null}
      asideContent={(
        <div
          ref={setCommentRailContainer}
          className="h-full min-h-0 shrink-0 self-stretch overflow-hidden transition-[width] duration-200"
          style={{
            width: commentRailOpen
              ? (viewportWidth >= COMMENT_RAIL_BREAKPOINT_PX
                  ? COMMENT_RAIL_WIDTH_PX
                  : Math.min(COMMENT_RAIL_WIDTH_PX, Math.max(280, viewportWidth - 24)))
              : 0,
          }}
          aria-hidden={!commentRailOpen}
        />
      )}
      bubbleMenuExtra={
        <>
          {commentCapabilityMode === 'threads' ? (
            <>
              <Separator orientation="vertical" />
              <StartCommentButton onStartComment={startCommentFromSelection} />
            </>
          ) : null}
          <Separator orientation="vertical" />
          <SendToChatButton documentId={doc?.id || ''} documentTitle={doc?.title || ''} spaceId={doc?.space_id || ''} onSendToChat={handleSendToChat} />
        </>
      }
      imageBubbleMenuExtra={commentCapabilityMode === 'threads' ? (
        <StartCommentButton onStartComment={startCommentFromSelection} />
      ) : null}
    >
      {shouldShowForceCloseOverlay && collaborative?.forceCloseMessage && (
        <ForceCloseOverlay
          message={collaborative.forceCloseMessage}
          title={t('forceCloseTitle', { defaultValue: '连接已断开' })}
          reloadLabel={t('forceCloseReload', { defaultValue: '重新加载' })}
          hasUnsavedEdits={saveState === 'dirty' || saveState === 'saving' || saveState === 'error'}
          unsavedHint={t('forceCloseUnsavedHint', { defaultValue: '您最近的编辑已保存在本地，恢复连接后将自动同步。' })}
          safeHint={t('forceCloseSafeHint', { defaultValue: '您的数据已安全保存。' })}
          onReload={onForceCloseReload}
        />
      )}

      <Dialog open={exportConfirmDialog.open} onOpenChange={(open) => { if (!open) handleExportConfirmResult(false) }}>
        <DialogContent className="sm:max-w-[420px]">
          <ContextDialogHeader
            className="px-0 pt-0"
            icon={<FileText className="h-7 w-7" />}
            title={t('exportConfirmTitle', { defaultValue: '导出确认' })}
            description={exportConfirmDialog.message}
          />
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="ghost" size="sm" onClick={() => handleExportConfirmResult(false)}>{t('cancel')}</Button>
            <Button size="sm" onClick={() => handleExportConfirmResult(true)}>{t('continueExport', { defaultValue: '继续导出' })}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <TableSelector open={showTableSelector} onOpenChange={setShowTableSelector} onSelect={handleTableSelected} onCreateNew={handleCreateNewTable} spaceId={doc?.space_id} />

      {/* Wave 4 F6: 被移出资源后的全屏遮罩（ 有实时权限时不盖） */}
      {showRemovedOverlay && loadErrorKind !== 'permission_denied' && activeDocumentId && (
        <RemovedFromResourceOverlay
          resourceTitle={revokedResourceTitle || downgrade.resourceTitle || doc?.title || ''}
          action={downgrade.removalAction || 'removed'}
          onReturn={handleReturnFromRemoved}
          onRequestView={canRequestRemovedResourceAccess ? accessRequest.requestViewAccess : undefined}
          onRequestEdit={canRequestRemovedResourceAccess ? accessRequest.requestEditAccess : undefined}
          requestingRole={accessRequest.requestingRole}
          requestedRole={accessRequest.requestedRole}
          t={(key, opts) => t(key, { ns: 'common', ...opts }) as string}
        />
      )}

      {sendToIMOpen && sendToIMResource && (
        <SendToIMDialog
          open={sendToIMOpen}
          onOpenChange={setSendToIMOpen}
          resource={sendToIMResource}
          organizationId={organizationIdForShare || undefined}
          canGrantResourceAccess={canManageShare}
        />
      )}

      <ConfirmDialog
        open={requestEditConfirmOpen}
        onOpenChange={setRequestEditConfirmOpen}
        title={t('requestEditAccessConfirmTitle', { defaultValue: '申请编辑权限？' })}
        description={t('requestEditAccessConfirmDesc', {
          defaultValue: '将向资源所有者发送编辑申请，通过后你才能编辑此文档。',
        })}
        confirmText={t('requestEditAccessConfirmAction', { defaultValue: '确认申请' })}
        cancelText={t('cancel', { ns: 'common', defaultValue: '取消' })}
        onConfirm={handleConfirmRequestEditAccess}
        isLoading={requestingEditAccess}
        container={null}
      />
    </DocEditorViewShell>
    </HtmlBlockAccessProvider>
  )
}
