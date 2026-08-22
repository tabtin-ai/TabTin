/**
 * Electron 宿主：comment_threads_v1 右栏 + 底部全文线程。
 * 能力缺失时由 DocEditorView 继续渲染旧 DocumentCommentsSection。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { OrganizationMember } from '@tabtin/app-shell'
import { useAppHostClient } from '@tabtin/app-host-sdk'
import { Button, toast } from '@components/ui'
import {
  addDocumentCommentMessage,
  createDocumentCommentThread,
  deleteDocumentCommentThread,
  deleteDocumentCommentMessage,
  hasCommentThreadsCapability,
  isSignedCommentPreviewUrl,
  listDocumentCommentThreads,
  reanchorDocumentCommentThread,
  resolveDocumentCommentAttachmentPreview,
  resolveDocumentThreadAttachmentPreviews,
  updateDocumentCommentThreadStatus,
  type CommentMessage,
  type CommentAnchorV1,
  type CommentThread,
} from '@tabtin/tabdoc-ui/api-client'
import {
  CommentRail,
  DocumentCommentThreadsSection,
  buildReanchorPayload,
  enrichCommentAnchorWithNodeId,
  focusCommentAnchorInEditor,
  getCommentDecorationAnchorStatuses,
  setActiveCommentThread,
  setCommentDecorationThreads,
  type BuildCommentAnchorResult,
  type CommentAttachmentPreviewRequest,
  type CommentYjsCodec,
  type DocumentCommentMentionCandidate,
  type EditorInstance,
} from '@tabtin/tabdoc-ui/editor'
import { MemberApiService } from '@/services/memberApi'
import { useAuthStore } from '@stores/useAuthStore'
import { electronTabDocEventStreamPort } from '../adapters/electronTabDocEventStreamPort'
import { uploadCommentAttachmentImage } from './commentAttachmentUpload'
import { tabdocCommentSubmitErrorDescription } from './commentSubmitRecovery'
import { shouldReloadCommentThreadsOnEvent } from './commentThreadEvents'
import { openDocumentCommentImagePreview } from './openDocumentCommentImagePreview'
import {
  type CommentThreadReloadDiagnostic,
  type CommentThreadReloadReason,
} from './commentThreadReloadCoordinator'
import {
  acquireSharedCommentThreadReload,
  type SharedCommentThreadReloadHandle,
} from './sharedCommentThreadReload'
import { isCommentThreadsCapabilityMissingError } from './commentThreadCapability'
import { findDeletedAnchorThreadIds } from './deletedAnchorThreads'
import { createLogger } from '@/utils/logger'

const log = createLogger('TabDocCommentThreads')
const PENDING_COMMENT_THREAD_ID = '__pending-comment-anchor__'

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
  return {
    userId,
    displayName,
    accountName: normalizeMentionLabel(input.username),
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

export type CommentThreadsCapabilityMode = 'loading' | 'threads' | 'legacy'

export interface DocumentCommentNotificationReveal {
  threadId: string
  commentId?: string
  requestId: number
}

function reloadReasonForRealtimeEvent(eventType: string): CommentThreadReloadReason {
  if (eventType === 'doc.events.comment_thread') return 'realtime_thread'
  if (eventType === 'doc.events.comment_message') return 'realtime_message'
  return 'realtime_comment'
}

export interface DocumentCommentThreadsHostProps {
  documentId: string
  organizationId: string
  editorRef: RefObject<EditorInstance | null>
  scrollContainerRef?: RefObject<HTMLElement | null>
  yjsCodec?: CommentYjsCodec | null
  railOpen: boolean
  onRailOpenChange: (open: boolean) => void
  activeThreadId: string | null
  onActiveThreadIdChange: (threadId: string | null) => void
  pendingAnchor: BuildCommentAnchorResult | null
  onPendingAnchorConsumed?: () => void
  onCollapseOutlineChange: (collapse: boolean) => void
  focusComposerToken?: number
  viewportWidth: number
  railContainer?: Element | null
  /** 能力探测结果回传给宿主（决定是否挂装饰 / 旧评论区） */
  onCapabilityModeChange?: (mode: CommentThreadsCapabilityMode) => void
  notificationReveal?: DocumentCommentNotificationReveal | null
  onNotificationRevealHandled?: (
    requestId: number,
    result: 'revealed' | 'unavailable',
  ) => void
}

export function DocumentCommentThreadsHost({
  documentId,
  organizationId,
  editorRef,
  scrollContainerRef,
  yjsCodec = null,
  railOpen,
  onRailOpenChange,
  activeThreadId,
  onActiveThreadIdChange,
  pendingAnchor,
  onPendingAnchorConsumed,
  onCollapseOutlineChange,
  focusComposerToken,
  viewportWidth,
  railContainer,
  onCapabilityModeChange,
  notificationReveal = null,
  onNotificationRevealHandled,
}: DocumentCommentThreadsHostProps) {
  const client = useAppHostClient()
  const { t, i18n } = useTranslation('tabdoc')
  const currentUser = useAuthStore((state) => state.user)
  const [threads, setThreads] = useState<CommentThread[]>([])
  const [localAnchorStatuses, setLocalAnchorStatuses] = useState<ReadonlyMap<string, 'attached' | 'detached'>>(
    () => new Map(),
  )
  const [capabilities, setCapabilities] = useState<string[] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeDocumentThreadId, setActiveDocumentThreadId] = useState<string | null>(null)
  const [notificationFocus, setNotificationFocus] = useState<DocumentCommentNotificationReveal | null>(null)
  const handledNotificationRequestIdRef = useRef<number | null>(null)
  const reloadHandleRef = useRef<SharedCommentThreadReloadHandle | null>(null)
  const localAnchorStatusesRef = useRef<ReadonlyMap<string, 'attached' | 'detached'>>(new Map())
  const deletingAnchorThreadIdsRef = useRef(new Set<string>())
  const migratingAnchorThreadIdsRef = useRef(new Set<string>())
  const onCapabilityModeChangeRef = useRef(onCapabilityModeChange)
  onCapabilityModeChangeRef.current = onCapabilityModeChange
  const translateRef = useRef(t)
  translateRef.current = t
  const pendingAnchorRef = useRef(pendingAnchor)
  pendingAnchorRef.current = pendingAnchor

  const hasThreads = hasCommentThreadsCapability(capabilities)

  const hydrateThreadPreviews = useCallback(async (next: CommentThread[]) => {
    try {
      return await resolveDocumentThreadAttachmentPreviews(client, documentId, next)
    } catch (error) {
      log.warn('resolve comment attachment previews failed', error)
      return next
    }
  }, [client, documentId])

  const hydrateMessagePreviews = useCallback(async (message: CommentMessage) => {
    if (message.attachments.length === 0) return message
    const attachments = await Promise.all(message.attachments.map(async (attachment) => {
      if (isSignedCommentPreviewUrl(attachment.preview_url)) return attachment
      try {
        const signed = await resolveDocumentCommentAttachmentPreview(
          client,
          documentId,
          attachment.file_id,
        )
        if (isSignedCommentPreviewUrl(signed)) {
          return { ...attachment, preview_url: signed }
        }
      } catch {
        // keep auth path
      }
      return attachment
    }))
    return { ...message, attachments }
  }, [client, documentId])

  useEffect(() => {
    if (!documentId) return
    onCapabilityModeChangeRef.current?.('loading')
    setIsLoading(true)
    setLoadError(null)

    const listener = {
      onSuccess: (result: { threads: CommentThread[]; capabilities: string[] }) => {
        setThreads(result.threads)
        setCapabilities(result.capabilities)
        setLoadError(null)
        setIsLoading(false)
        const mode: CommentThreadsCapabilityMode = hasCommentThreadsCapability(result.capabilities)
          ? 'threads'
          : 'legacy'
        onCapabilityModeChangeRef.current?.(mode)
      },
      onError: (error: unknown) => {
        setIsLoading(false)
        if (isCommentThreadsCapabilityMissingError(error)) {
          log.warn('comment threads capability unavailable, falling back to legacy comments', error)
          setCapabilities([])
          onCapabilityModeChangeRef.current?.('legacy')
          return
        }
        const message = error instanceof Error
          ? error.message
          : translateRef.current('comments.loadFailed', { defaultValue: '评论加载失败' })
        setLoadError(message)
        log.warn('list comment threads failed, preserving last successful state', error)
      },
    }
    const handle = acquireSharedCommentThreadReload({
      clientKey: client,
      documentId,
      load: async () => {
        const result = await listDocumentCommentThreads(client, documentId)
        return {
          ...result,
          threads: await hydrateThreadPreviews(result.threads),
        }
      },
      listener,
      onDiagnostic: (event: CommentThreadReloadDiagnostic) => {
        const reason = 'reasons' in event ? event.reasons.join(',') : ''
        const sequence = event.requestSequence ?? 0
        const merged = 'mergedCount' in event ? event.mergedCount : 0
        const duration = 'durationMs' in event ? event.durationMs ?? 0 : 0
        if (event.phase === 'error') {
          log.warn(`reload ${event.phase} reason=${reason} merged=${merged} seq=${sequence} durationMs=${duration}`)
          return
        }
        log.debug(`reload ${event.phase} reason=${reason} merged=${merged} seq=${sequence} durationMs=${duration}`)
      },
    })
    reloadHandleRef.current = handle

    return () => {
      handle.release()
      if (reloadHandleRef.current === handle) {
        reloadHandleRef.current = null
      }
    }
  }, [client, documentId, hydrateThreadPreviews])

  useEffect(() => {
    if (!documentId || !hasThreads) return
    reloadHandleRef.current?.ensureRealtimeSubscription((request) => {
      return electronTabDocEventStreamPort.subscribe(documentId, (event) => {
        const action = typeof event.data?.action === 'string' ? event.data.action : null
        if (!shouldReloadCommentThreadsOnEvent(event.event, action)) return
        request(reloadReasonForRealtimeEvent(event.event))
      })
    })
  }, [documentId, hasThreads])

  const handleRetryLoad = useCallback(() => {
    setIsLoading(true)
    setLoadError(null)
    reloadHandleRef.current?.request('manual_retry')
  }, [])

  const deleteThreadsWithRemovedAnchors = useCallback((threadIds: readonly string[]) => {
    for (const threadId of threadIds) {
      if (deletingAnchorThreadIdsRef.current.has(threadId)) continue
      deletingAnchorThreadIdsRef.current.add(threadId)
      setThreads((previous) => previous.filter((thread) => thread.id !== threadId))
      if (activeThreadId === threadId) {
        onActiveThreadIdChange(null)
      }

      void deleteDocumentCommentThread(client, documentId, threadId)
        .catch((error: unknown) => {
          const status = typeof error === 'object' && error !== null && 'status' in error
            ? Number((error as { status?: unknown }).status)
            : null
          if (status === 404) return
          log.warn('delete comment thread after anchor removal failed', error)
          toast({
            title: t('comments.deleteFailed', { defaultValue: '评论删除失败' }),
            description: error instanceof Error ? error.message : undefined,
            variant: 'destructive',
          })
          reloadHandleRef.current?.request('manual_retry')
        })
        .finally(() => {
          deletingAnchorThreadIdsRef.current.delete(threadId)
        })
    }
  }, [activeThreadId, client, documentId, onActiveThreadIdChange, t])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !hasThreads) return
    const pendingDecoration = pendingAnchor && pendingAnchor.scope !== 'document'
      ? [{
          id: PENDING_COMMENT_THREAD_ID,
          scope: pendingAnchor.scope,
          status: 'open' as const,
          anchor: pendingAnchor.anchor,
          anchor_status: 'attached' as const,
        }]
      : []
    setCommentDecorationThreads(
      editor.view,
      [
        ...threads.map((thread) => ({
          id: thread.id,
          scope: thread.scope,
          status: thread.status,
          anchor: thread.anchor,
          anchor_status: thread.anchor_status,
        })),
        ...pendingDecoration,
      ],
    )
    setActiveCommentThread(
      editor.view,
      pendingDecoration.length > 0 ? PENDING_COMMENT_THREAD_ID : activeThreadId,
    )
  }, [activeThreadId, editorRef, hasThreads, pendingAnchor, threads])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !hasThreads) {
      localAnchorStatusesRef.current = new Map()
      setLocalAnchorStatuses(new Map())
      return
    }

    const initialStatuses = getCommentDecorationAnchorStatuses(editor.state)
    localAnchorStatusesRef.current = initialStatuses
    setLocalAnchorStatuses(initialStatuses)

    const syncLocalAnchorStatuses = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      const previous = localAnchorStatusesRef.current
      const current = getCommentDecorationAnchorStatuses(editor.state)
      localAnchorStatusesRef.current = current
      setLocalAnchorStatuses(current)
      if (!transaction.docChanged) return
      deleteThreadsWithRemovedAnchors(
        findDeletedAnchorThreadIds(previous, current, threads),
      )
    }
    editor.on('transaction', syncLocalAnchorStatuses)
    return () => {
      editor.off('transaction', syncLocalAnchorStatuses)
    }
  }, [deleteThreadsWithRemovedAnchors, editorRef, hasThreads, threads])

  const displayThreads = useMemo(() => threads.map((thread) => {
    if (
      thread.scope === 'document'
      || thread.status === 'resolved'
      || thread.anchor_status === 'orphaned'
      || thread.anchor_status === 'detached'
      || localAnchorStatuses.get(thread.id) !== 'detached'
    ) {
      return thread
    }
    return { ...thread, anchor_status: 'detached' as const }
  }), [localAnchorStatuses, threads])

  const [mentionCandidates, setMentionCandidates] = useState<DocumentCommentMentionCandidate[]>([])
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
        const next: DocumentCommentMentionCandidate[] = []
        const append = (candidate: DocumentCommentMentionCandidate | null) => {
          if (!candidate || seen.has(candidate.userId)) return
          seen.add(candidate.userId)
          next.push(candidate)
        }
        members.forEach((member) => append(organizationMemberToMentionCandidate(member)))
        append(buildMentionCandidate({
          userId: currentUser?.id,
          nickname: currentUser?.nickname,
          username: currentUser?.username,
          email: currentUser?.email,
          avatar: currentUser?.avatar,
        }))
        setMentionCandidates(next)
      })
      .catch(() => {
        if (!cancelled) setMentionCandidates([])
      })
    return () => {
      cancelled = true
    }
  }, [
    currentUser?.avatar,
    currentUser?.email,
    currentUser?.id,
    currentUser?.nickname,
    currentUser?.username,
    organizationId,
  ])

  const onUploadImage = useCallback(async (file: File) => {
    return uploadCommentAttachmentImage(client, documentId, file)
  }, [client, documentId])

  const onRefreshAttachmentPreview = useCallback(async (fileId: string) => {
    return resolveDocumentCommentAttachmentPreview(client, documentId, fileId)
  }, [client, documentId])

  const onOpenAttachmentPreview = useCallback(async (
    request: CommentAttachmentPreviewRequest,
  ) => {
    await openDocumentCommentImagePreview(request, onRefreshAttachmentPreview)
  }, [onRefreshAttachmentPreview])

  const threadLabels = useMemo(() => ({
    title: t('comments.threadsTitle', { defaultValue: '评论' }),
    filterOpen: t('comments.filterOpen', { defaultValue: '未解决' }),
    filterResolved: t('comments.filterResolved', { defaultValue: '已解决' }),
    filterAll: t('comments.filterAll', { defaultValue: '全部' }),
    empty: t('comments.threadsEmpty', { defaultValue: '暂无评论' }),
    close: t('comments.closeRail', { defaultValue: '关闭' }),
    newThreadPlaceholder: t('comments.newThreadPlaceholder', { defaultValue: '添加评论…' }),
    placeholder: t('comments.placeholder', { defaultValue: '输入评论' }),
    submit: t('comments.submit', { defaultValue: '发送' }),
    cancel: t('comments.cancelReply', { defaultValue: '取消' }),
    resolve: t('comments.resolve', { defaultValue: '解决' }),
    reopen: t('comments.reopen', { defaultValue: '重开' }),
    reanchor: t('comments.reanchor', { defaultValue: '重新关联' }),
    reply: t('comments.reply', { defaultValue: '回复' }),
    addImage: t('comments.addImage', { defaultValue: '添加图片' }),
    retryImage: t('comments.retryImage', { defaultValue: '重试' }),
    removeImage: t('comments.removeImage', { defaultValue: '移除' }),
    noMentionResults: t('comments.noMentionResults', { defaultValue: '没有匹配的成员' }),
  }), [t])

  const mergeThreadPreservingPreviews = useCallback((previous: CommentThread | undefined, next: CommentThread): CommentThread => {
    if (!previous) return next
    return {
      ...next,
      messages: next.messages.map((message) => {
        const prevMessage = previous.messages.find((item) => item.id === message.id)
        if (!prevMessage) return message
        return {
          ...message,
          attachments: message.attachments.map((attachment) => {
            const prevAttachment = prevMessage.attachments.find(
              (item) => item.file_id === attachment.file_id || item.id === attachment.id,
            )
            if (isSignedCommentPreviewUrl(attachment.preview_url) || !prevAttachment?.preview_url) {
              return attachment
            }
            return { ...attachment, preview_url: prevAttachment.preview_url }
          }),
        }
      }),
    }
  }, [])

  const replaceThreadPreservingPreviews = useCallback(async (updated: CommentThread) => {
    const [hydrated] = await hydrateThreadPreviews([updated])
    const next = hydrated ?? updated
    setThreads((prev) => {
      const previous = prev.find((item) => item.id === next.id)
      const merged = mergeThreadPreservingPreviews(previous, next)
      if (!previous) {
        return [merged, ...prev]
      }
      return prev.map((item) => (item.id === merged.id ? merged : item))
    })
    return next
  }, [hydrateThreadPreviews, mergeThreadPreservingPreviews])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !hasThreads) return

    const migrations = threads.flatMap((thread) => {
      if (
        thread.scope === 'document'
        || migratingAnchorThreadIdsRef.current.has(thread.id)
      ) return []
      const anchor = thread.anchor as CommentAnchorV1
      if (anchor.node_id || anchor.block_type !== 'image') return []
      const enriched = enrichCommentAnchorWithNodeId(editor.state.doc, anchor, {
        yjsCodec,
        state: editor.state,
      })
      return enriched.node_id ? [{ thread, scope: thread.scope, anchor: enriched }] : []
    })
    if (migrations.length === 0) return

    const anchorsByThreadId = new Map(
      migrations.map(({ thread, anchor }) => [thread.id, anchor]),
    )
    for (const { thread } of migrations) {
      migratingAnchorThreadIdsRef.current.add(thread.id)
    }
    setThreads((previous) => previous.map((thread) => {
      const anchor = anchorsByThreadId.get(thread.id)
      return anchor ? { ...thread, anchor } : thread
    }))

    for (const { thread, scope, anchor } of migrations) {
      void reanchorDocumentCommentThread(client, documentId, thread.id, {
        scope,
        anchor,
      })
        .then(replaceThreadPreservingPreviews)
        .catch((error: unknown) => {
          log.warn('persist stable image comment anchor failed', {
            threadId: thread.id,
            error,
          })
        })
        .finally(() => {
          migratingAnchorThreadIdsRef.current.delete(thread.id)
        })
    }
  }, [
    client,
    documentId,
    editorRef,
    hasThreads,
    replaceThreadPreservingPreviews,
    threads,
    yjsCodec,
  ])

  const persistCreatedThread = useCallback(async (created: CommentThread) => {
    const nextThread = await replaceThreadPreservingPreviews(created)
    return nextThread
  }, [replaceThreadPreservingPreviews])

  /** 右栏：必须锚定到选区/块，不得写入全文评论 */
  const handleCreateAnchoredThread = useCallback(async (input: {
    body: string
    mentionUserIds: string[]
    attachmentIds: string[]
    clientRequestId: string
  }) => {
    if (isCreating) {
      throw new Error(t('comments.submitInProgress', { defaultValue: '评论正在发送中' }))
    }
    const anchor = pendingAnchorRef.current
    if (!anchor || anchor.scope === 'document') {
      toast({
        title: t('comments.needSelection', { defaultValue: '请先选择要评论的内容' }),
      })
      // 必须 throw：Composer 仅在成功后清草稿，软 return 会被当成成功
      throw new Error(t('comments.needSelection', { defaultValue: '请先选择要评论的内容' }))
    }
    setIsCreating(true)
    try {
      const created = await createDocumentCommentThread(client, documentId, {
        body: input.body,
        mention_user_ids: input.mentionUserIds,
        attachment_ids: input.attachmentIds,
        scope: anchor.scope,
        anchor: anchor.anchor,
        selected_text: anchor.selected_text ?? '',
        client_request_id: input.clientRequestId,
      })
      const persisted = await persistCreatedThread(created)
      onActiveThreadIdChange(persisted.id)
      onPendingAnchorConsumed?.()
    } catch (error) {
      toast({
        title: t('comments.submitFailed', { defaultValue: '评论发送失败' }),
        description: tabdocCommentSubmitErrorDescription(error, t),
        variant: 'destructive',
      })
      throw error
    } finally {
      setIsCreating(false)
    }
  }, [client, documentId, isCreating, onActiveThreadIdChange, onPendingAnchorConsumed, persistCreatedThread, t])

  /** 底部：仅全文评论 */
  const handleCreateDocumentThread = useCallback(async (input: {
    body: string
    mentionUserIds: string[]
    attachmentIds: string[]
    clientRequestId: string
  }) => {
    if (isCreating) {
      throw new Error(t('comments.submitInProgress', { defaultValue: '评论正在发送中' }))
    }
    setIsCreating(true)
    try {
      const created = await createDocumentCommentThread(client, documentId, {
        body: input.body,
        mention_user_ids: input.mentionUserIds,
        attachment_ids: input.attachmentIds,
        scope: 'document',
        anchor: { version: 1 },
        selected_text: '',
        client_request_id: input.clientRequestId,
      })
      const persisted = await persistCreatedThread(created)
      setActiveDocumentThreadId(persisted.id)
      onRailOpenChange(false)
    } catch (error) {
      toast({
        title: t('comments.submitFailed', { defaultValue: '评论发送失败' }),
        description: tabdocCommentSubmitErrorDescription(error, t),
        variant: 'destructive',
      })
      throw error
    } finally {
      setIsCreating(false)
    }
  }, [client, documentId, isCreating, onRailOpenChange, persistCreatedThread, t])

  const handleReply = useCallback(async (
    threadId: string,
    input: { body: string; mentionUserIds: string[]; attachmentIds: string[]; clientRequestId: string },
  ) => {
    try {
      const message = await addDocumentCommentMessage(client, documentId, threadId, {
        body: input.body,
        mention_user_ids: input.mentionUserIds,
        attachment_ids: input.attachmentIds,
        client_request_id: input.clientRequestId,
      })
      const hydratedMessage = await hydrateMessagePreviews(message)
      setThreads((prev) => prev.map((thread) => {
        if (thread.id !== threadId) return thread
        if (thread.messages.some((item) => item.id === hydratedMessage.id)) return thread
        return { ...thread, messages: [...thread.messages, hydratedMessage] }
      }))
    } catch (error) {
      toast({
        title: t('comments.replyFailed', { defaultValue: '回复失败' }),
        description: tabdocCommentSubmitErrorDescription(error, t),
        variant: 'destructive',
      })
      throw error
    }
  }, [client, documentId, hydrateMessagePreviews, t])

  const handleResolve = useCallback(async (threadId: string) => {
    try {
      const updated = await updateDocumentCommentThreadStatus(client, documentId, threadId, 'resolved')
      await replaceThreadPreservingPreviews(updated)
    } catch (error) {
      toast({
        title: t('comments.resolveFailed', { defaultValue: '解决失败' }),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
      throw error
    }
  }, [client, documentId, replaceThreadPreservingPreviews, t])

  const handleReopen = useCallback(async (threadId: string) => {
    try {
      const updated = await updateDocumentCommentThreadStatus(client, documentId, threadId, 'open')
      await replaceThreadPreservingPreviews(updated)
    } catch (error) {
      toast({
        title: t('comments.reopenFailed', { defaultValue: '重开失败' }),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
      throw error
    }
  }, [client, documentId, replaceThreadPreservingPreviews, t])

  const handleReanchor = useCallback(async (threadId: string) => {
    const editor = editorRef.current
    if (!editor) return
    const payload = buildReanchorPayload(editor, { yjsCodec })
    if (!payload) {
      toast({
        title: t('comments.reanchorNeedSelection', { defaultValue: '请先框选要重新关联的内容' }),
        variant: 'destructive',
      })
      throw new Error(t('comments.reanchorNeedSelection', { defaultValue: '请先框选要重新关联的内容' }))
    }
    try {
      const updated = await reanchorDocumentCommentThread(client, documentId, threadId, payload)
      await replaceThreadPreservingPreviews(updated)
    } catch (error) {
      toast({
        title: t('comments.reanchorFailed', { defaultValue: '重新关联失败' }),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
      throw error
    }
  }, [client, documentId, editorRef, replaceThreadPreservingPreviews, t, yjsCodec])

  const handleDeleteMessage = useCallback(async (threadId: string, messageId: string) => {
    try {
      await deleteDocumentCommentMessage(client, documentId, threadId, messageId)
      setThreads((prev) => prev.map((thread) => {
        if (thread.id !== threadId) return thread
        return {
          ...thread,
          messages: thread.messages.map((message) => (
            message.id === messageId
              ? { ...message, is_deleted: true, body: '', attachments: [] }
              : message
          )),
        }
      }))
    } catch (error) {
      toast({
        title: t('comments.deleteFailed', { defaultValue: '评论删除失败' }),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
      throw error
    }
  }, [client, documentId, t])

  const handleSelectThread = useCallback((threadId: string) => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    if (thread.scope === 'document') {
      setActiveDocumentThreadId(thread.id)
      onRailOpenChange(false)
      return
    }
    onActiveThreadIdChange(thread.id)
    onRailOpenChange(true)
    const editor = editorRef.current
    if (!editor) return
    focusCommentAnchorInEditor(editor, thread, {
      yjsCodec,
      scrollContainer: scrollContainerRef?.current ?? null,
      state: editor.state,
    })
  }, [editorRef, onActiveThreadIdChange, onRailOpenChange, scrollContainerRef, threads, yjsCodec])

  useEffect(() => {
    if (!notificationReveal || isLoading || !hasThreads) return
    if (handledNotificationRequestIdRef.current === notificationReveal.requestId) return
    handledNotificationRequestIdRef.current = notificationReveal.requestId

    const thread = displayThreads.find((item) => item.id === notificationReveal.threadId)
    const message = notificationReveal.commentId
      ? thread?.messages.find((item) => item.id === notificationReveal.commentId)
      : null
    if (!thread || (notificationReveal.commentId && (!message || message.is_deleted))) {
      setNotificationFocus(null)
      onNotificationRevealHandled?.(notificationReveal.requestId, 'unavailable')
      return
    }

    setNotificationFocus(notificationReveal)
    handleSelectThread(thread.id)
    onNotificationRevealHandled?.(notificationReveal.requestId, 'revealed')
  }, [
    displayThreads,
    handleSelectThread,
    hasThreads,
    isLoading,
    notificationReveal,
    onNotificationRevealHandled,
  ])

  const handleRailOpenChange = useCallback((open: boolean) => {
    onRailOpenChange(open)
    if (!open && pendingAnchorRef.current) {
      onPendingAnchorConsumed?.()
    }
  }, [onPendingAnchorConsumed, onRailOpenChange])

  if (!hasThreads) {
    // 探测中或回退：不渲染线程 UI（宿主挂旧区）
    if (capabilities === null) {
      return (
        <div className="mt-8 flex items-center gap-3 pb-6 text-body text-muted-foreground" data-testid="comment-threads-loading">
          <span>
            {loadError || t('comments.loading', { defaultValue: '正在加载评论...' })}
          </span>
          {loadError ? (
            <Button variant="outline" size="sm" onClick={handleRetryLoad} disabled={isLoading}>
              {t('comments.retryLoad', { defaultValue: '重试' })}
            </Button>
          ) : null}
        </div>
      )
    }
    return null
  }

  const isEmbeddedRail = railContainer !== undefined
  const rail = (
    <CommentRail
        open={railOpen}
        onOpenChange={handleRailOpenChange}
        threads={displayThreads}
        activeThreadId={activeThreadId}
        focusThreadId={notificationFocus?.threadId}
        focusMessageId={notificationFocus?.commentId}
        viewportWidth={viewportWidth}
        currentUserId={currentUser?.id ?? null}
        locale={i18n.language || 'zh-CN'}
        labels={threadLabels}
        onSelectThread={handleSelectThread}
        onResolveThread={handleResolve}
        onReopenThread={handleReopen}
        onReanchorThread={handleReanchor}
        onReply={handleReply}
        onCreateThread={handleCreateAnchoredThread}
        onUploadImage={onUploadImage}
        onRefreshAttachmentPreview={onRefreshAttachmentPreview}
        onOpenAttachmentPreview={onOpenAttachmentPreview}
        onDeleteMessage={handleDeleteMessage}
        mentionCandidates={mentionCandidates}
        onCollapseOutlineChange={onCollapseOutlineChange}
        isCreating={isCreating}
        focusComposerToken={focusComposerToken}
        draftSelectedText={pendingAnchor?.selected_text}
        embedded={isEmbeddedRail}
      />
  )

  return (
    <>
      {railContainer ? createPortal(rail, railContainer) : (isEmbeddedRail ? null : rail)}
      {loadError ? (
        <div className="mt-4 flex items-center gap-3 text-body text-muted-foreground" data-testid="comment-threads-retry">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={handleRetryLoad} disabled={isLoading}>
            {t('comments.retryLoad', { defaultValue: '重试' })}
          </Button>
        </div>
      ) : null}
      <DocumentCommentThreadsSection
        threads={displayThreads}
        documentScopeOnly
        currentUserId={currentUser?.id ?? null}
        locale={i18n.language || 'zh-CN'}
        labels={{
          ...threadLabels,
          title: t('comments.title', { defaultValue: '全文评论' }),
          empty: loadError || t('comments.documentThreadsEmpty', { defaultValue: '暂无全文评论' }),
        }}
        onCreateThread={handleCreateDocumentThread}
        onReply={handleReply}
        onResolveThread={handleResolve}
        onReopenThread={handleReopen}
        onReanchorThread={handleReanchor}
        onSelectThread={handleSelectThread}
        onUploadImage={onUploadImage}
        onRefreshAttachmentPreview={onRefreshAttachmentPreview}
        onOpenAttachmentPreview={onOpenAttachmentPreview}
        onDeleteMessage={handleDeleteMessage}
        mentionCandidates={mentionCandidates}
        activeThreadId={activeDocumentThreadId}
        focusThreadId={notificationFocus?.threadId}
        focusMessageId={notificationFocus?.commentId}
        isCreating={isCreating}
      />
    </>
  )
}
