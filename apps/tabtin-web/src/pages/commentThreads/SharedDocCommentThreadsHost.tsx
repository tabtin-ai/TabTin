/**
 * 分享页宿主：comment_threads_v1 右栏 + 底部全文线程。
 * 能力缺失时由 SharedDocPage 继续渲染旧 DocumentCommentsSection。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useAppHostClient } from '@tabtin/app-host-sdk'
import {
  addSharedCommentMessage,
  createSharedCommentThread,
  deleteSharedCommentMessage,
  hasCommentThreadsCapability,
  listSharedCommentThreads,
  reanchorSharedCommentThread,
  resolveSharedCommentAttachmentPreview,
  updateSharedCommentThreadStatus,
  type CommentThread,
} from '@tabtin/tabdoc-ui/api-client'
import {
  CommentRail,
  DocumentCommentThreadsSection,
  buildReanchorPayload,
  focusCommentAnchorInEditor,
  setActiveCommentThread,
  setCommentDecorationThreads,
  type BuildCommentAnchorResult,
  type CommentYjsCodec,
  type DocumentCommentMentionCandidate,
  type EditorInstance,
} from '@tabtin/tabdoc-ui/editor'
import { useAuthStore } from '@/stores/auth-store'
import { uploadShareCommentAttachmentImage } from './commentAttachmentUpload'
import { resolveThreadAttachmentPreviews } from './resolveShareAttachmentPreviews'
import {
  shouldReloadShareCommentThreadsOnEvent,
  type ShareCommentThreadEventType,
} from './shareCommentThreadEvents'
import { selectSharedDocCommentThread } from './sharedDocCommentSelection'

export type CommentThreadsCapabilityMode = 'loading' | 'threads' | 'legacy'

export interface SharedDocCommentThreadsHostProps {
  shareId: string
  password?: string
  editorRef: RefObject<EditorInstance | null>
  scrollContainerRef?: RefObject<HTMLElement | null>
  yjsCodec?: CommentYjsCodec | null
  railOpen: boolean
  onRailOpenChange: (open: boolean) => void
  activeThreadId: string | null
  onActiveThreadIdChange: (threadId: string | null) => void
  pendingAnchor: BuildCommentAnchorResult | null
  onPendingAnchorConsumed?: () => void
  onCollapseOutlineChange?: (collapse: boolean) => void
  focusComposerToken?: number
  viewportWidth: number
  mentionCandidates: DocumentCommentMentionCandidate[]
  /** 外部实时事件（由 useShareDocEventStream 转发） */
  realtimeEvent?: { type: string; action?: string | null; token: number } | null
  onCapabilityModeChange?: (mode: CommentThreadsCapabilityMode) => void
}

export function SharedDocCommentThreadsHost({
  shareId,
  password,
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
  mentionCandidates,
  realtimeEvent,
  onCapabilityModeChange,
}: SharedDocCommentThreadsHostProps) {
  const client = useAppHostClient()
  const currentUser = useAuthStore((state) => state.user)
  const [threads, setThreads] = useState<CommentThread[]>([])
  const [capabilities, setCapabilities] = useState<string[] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeDocumentThreadId, setActiveDocumentThreadId] = useState<string | null>(null)
  const pendingAnchorRef = useRef(pendingAnchor)
  pendingAnchorRef.current = pendingAnchor
  const passwordRef = useRef(password)
  passwordRef.current = password

  const hasThreads = hasCommentThreadsCapability(capabilities)

  const replaceThreadPreservingPreviews = useCallback(async (updated: CommentThread) => {
    const [withPreview] = await resolveThreadAttachmentPreviews(
      client,
      shareId,
      [updated],
      passwordRef.current,
    )
    const next = withPreview ?? updated
    setThreads((prev) => {
      const previous = prev.find((item) => item.id === next.id)
      if (!previous) {
        return prev.some((item) => item.id === next.id)
          ? prev.map((item) => (item.id === next.id ? next : item))
          : [next, ...prev]
      }
      // 若重新签 URL 失败，保留本地已可用的 preview_url，避免 img 回退到鉴权 path
      const merged: CommentThread = {
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
              const looksSigned = /^https?:\/\//i.test(attachment.preview_url || '')
              if (looksSigned || !prevAttachment?.preview_url) return attachment
              return { ...attachment, preview_url: prevAttachment.preview_url }
            }),
          }
        }),
      }
      return prev.map((item) => (item.id === merged.id ? merged : item))
    })
  }, [client, shareId])

  const loadThreads = useCallback(async () => {
    if (!shareId) return
    setIsLoading(true)
    setLoadError(null)
    try {
      const result = await listSharedCommentThreads(client, shareId, passwordRef.current)
      const withPreviews = await resolveThreadAttachmentPreviews(
        client,
        shareId,
        result.threads,
        passwordRef.current,
      )
      setThreads(withPreviews)
      setCapabilities(result.capabilities)
      const mode: CommentThreadsCapabilityMode = hasCommentThreadsCapability(result.capabilities)
        ? 'threads'
        : 'legacy'
      onCapabilityModeChange?.(mode)
    } catch (error) {
      console.warn('[ShareCommentThreads] list failed, falling back to legacy', error)
      setCapabilities([])
      onCapabilityModeChange?.('legacy')
      setLoadError(error instanceof Error ? error.message : '评论加载失败')
    } finally {
      setIsLoading(false)
    }
  }, [client, onCapabilityModeChange, shareId])

  useEffect(() => {
    onCapabilityModeChange?.('loading')
    void loadThreads()
  }, [loadThreads, onCapabilityModeChange])

  useEffect(() => {
    if (!realtimeEvent || !hasThreads) return
    if (!shouldReloadShareCommentThreadsOnEvent(
      realtimeEvent.type as ShareCommentThreadEventType,
      realtimeEvent.action,
    )) return
    void loadThreads()
  }, [hasThreads, loadThreads, realtimeEvent])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !hasThreads) return
    setCommentDecorationThreads(
      editor.view,
      threads.map((thread) => ({
        id: thread.id,
        scope: thread.scope,
        status: thread.status,
        anchor: thread.anchor,
        anchor_status: thread.anchor_status,
      })),
    )
    setActiveCommentThread(editor.view, activeThreadId)
  }, [activeThreadId, editorRef, hasThreads, threads])

  const onUploadImage = useCallback(async (file: File) => {
    return uploadShareCommentAttachmentImage(client, shareId, file, passwordRef.current)
  }, [client, shareId])

  const onRefreshAttachmentPreview = useCallback(async (fileId: string) => {
    return resolveSharedCommentAttachmentPreview(
      client,
      shareId,
      fileId,
      passwordRef.current,
    )
  }, [client, shareId])

  const threadLabels = useMemo(() => ({
    title: '评论',
    filterOpen: '未解决',
    filterResolved: '已解决',
    filterAll: '全部',
    empty: '暂无评论',
    close: '关闭',
    newThreadPlaceholder: '添加评论…',
    placeholder: '输入评论',
    submit: '发送',
    cancel: '取消',
    resolve: '解决',
    reopen: '重开',
    reanchor: '重新关联',
    reply: '回复',
    addImage: '添加图片',
    retryImage: '重试',
    removeImage: '移除',
    noMentionResults: '没有匹配的成员',
  }), [])

  const notifyError = useCallback((title: string, error: unknown) => {
    const description = error instanceof Error ? error.message : undefined
    client.showToast(description ? `${title}：${description}` : title, 'error')
  }, [client])

  const selectThread = useCallback((thread: CommentThread) => {
    selectSharedDocCommentThread(thread, {
      selectDocumentThread: setActiveDocumentThreadId,
      selectAnchoredThread: onActiveThreadIdChange,
      closeRail: () => onRailOpenChange(false),
      openRail: () => onRailOpenChange(true),
      focusAnchor: () => {
        const editor = editorRef.current
        if (!editor) return
        focusCommentAnchorInEditor(editor, thread, {
          yjsCodec,
          scrollContainer: scrollContainerRef?.current ?? null,
          state: editor.state,
        })
      },
    })
  }, [editorRef, onActiveThreadIdChange, onRailOpenChange, scrollContainerRef, yjsCodec])

  const persistCreatedThread = useCallback(async (created: CommentThread) => {
    const [withPreview] = await resolveThreadAttachmentPreviews(
      client,
      shareId,
      [created],
      passwordRef.current,
    )
    const next = withPreview ?? created
    setThreads((prev) => {
      if (prev.some((item) => item.id === next.id)) {
        return prev.map((item) => (item.id === next.id ? next : item))
      }
      return [next, ...prev]
    })
    return next
  }, [client, shareId])

  const handleCreateAnchoredThread = useCallback(async (input: {
    body: string
    mentionUserIds: string[]
    attachmentIds: string[]
    clientRequestId: string
  }) => {
    if (isCreating) {
      throw new Error('评论正在发送中')
    }
    const anchor = pendingAnchorRef.current
    if (!anchor || anchor.scope === 'document') {
      client.showToast('请先选择要评论的内容', 'error')
      // 必须 throw：Composer 仅在成功后清草稿，软 return 会被当成成功
      throw new Error('请先选择要评论的内容')
    }
    setIsCreating(true)
    try {
      const created = await createSharedCommentThread(client, shareId, {
        body: input.body,
        mention_user_ids: input.mentionUserIds,
        attachment_ids: input.attachmentIds,
        scope: anchor.scope,
        anchor: anchor.anchor,
        selected_text: anchor.selected_text ?? '',
        client_request_id: input.clientRequestId,
        password: passwordRef.current,
      })
      const persisted = await persistCreatedThread(created)
      onActiveThreadIdChange(persisted.id)
      onPendingAnchorConsumed?.()
    } catch (error) {
      notifyError('评论发送失败', error)
      throw error
    } finally {
      setIsCreating(false)
    }
  }, [client, isCreating, notifyError, onActiveThreadIdChange, onPendingAnchorConsumed, persistCreatedThread, shareId])

  const handleCreateDocumentThread = useCallback(async (input: {
    body: string
    mentionUserIds: string[]
    attachmentIds: string[]
    clientRequestId: string
  }) => {
    if (isCreating) {
      throw new Error('评论正在发送中')
    }
    setIsCreating(true)
    try {
      const created = await createSharedCommentThread(client, shareId, {
        body: input.body,
        mention_user_ids: input.mentionUserIds,
        attachment_ids: input.attachmentIds,
        scope: 'document',
        anchor: { version: 1 },
        selected_text: '',
        client_request_id: input.clientRequestId,
        password: passwordRef.current,
      })
      const persisted = await persistCreatedThread(created)
      setActiveDocumentThreadId(persisted.id)
    } catch (error) {
      notifyError('评论发送失败', error)
      throw error
    } finally {
      setIsCreating(false)
    }
  }, [client, isCreating, notifyError, persistCreatedThread, shareId])

  const handleReply = useCallback(async (
    threadId: string,
    input: { body: string; mentionUserIds: string[]; attachmentIds: string[]; clientRequestId: string },
  ) => {
    try {
      const message = await addSharedCommentMessage(client, shareId, threadId, {
        body: input.body,
        mention_user_ids: input.mentionUserIds,
        attachment_ids: input.attachmentIds,
        client_request_id: input.clientRequestId,
        password: passwordRef.current,
      })
      setThreads((prev) => prev.map((thread) => {
        if (thread.id !== threadId) return thread
        if (thread.messages.some((item) => item.id === message.id)) return thread
        return { ...thread, messages: [...thread.messages, message] }
      }))
      // 全量刷新会重新换签，避免回复附件停留在鉴权 path
      void loadThreads()
    } catch (error) {
      notifyError('回复失败', error)
      throw error
    }
  }, [client, loadThreads, notifyError, shareId])

  const handleResolve = useCallback(async (threadId: string) => {
    try {
      const updated = await updateSharedCommentThreadStatus(
        client,
        shareId,
        threadId,
        'resolved',
        passwordRef.current,
      )
      await replaceThreadPreservingPreviews(updated)
    } catch (error) {
      notifyError('解决失败', error)
      throw error
    }
  }, [client, notifyError, replaceThreadPreservingPreviews, shareId])

  const handleReopen = useCallback(async (threadId: string) => {
    try {
      const updated = await updateSharedCommentThreadStatus(
        client,
        shareId,
        threadId,
        'open',
        passwordRef.current,
      )
      await replaceThreadPreservingPreviews(updated)
    } catch (error) {
      notifyError('重开失败', error)
    }
  }, [client, notifyError, replaceThreadPreservingPreviews, shareId])

  const handleReanchor = useCallback(async (threadId: string) => {
    const editor = editorRef.current
    if (!editor) return
    const payload = buildReanchorPayload(editor, { yjsCodec })
    if (!payload) {
      client.showToast('请先框选要重新关联的内容', 'warning')
      return
    }
    try {
      const updated = await reanchorSharedCommentThread(client, shareId, threadId, {
        ...payload,
        password: passwordRef.current,
      })
      await replaceThreadPreservingPreviews(updated)
    } catch (error) {
      notifyError('重新关联失败', error)
    }
  }, [client, editorRef, notifyError, replaceThreadPreservingPreviews, shareId, yjsCodec])

  const handleDeleteMessage = useCallback(async (threadId: string, messageId: string) => {
    try {
      await deleteSharedCommentMessage(
        client,
        shareId,
        threadId,
        messageId,
        passwordRef.current,
      )
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
      notifyError('评论删除失败', error)
      throw error
    }
  }, [client, notifyError, shareId])

  const handleSelectThread = useCallback((threadId: string) => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    selectThread(thread)
  }, [selectThread, threads])

  if (!hasThreads) {
    if (isLoading && capabilities === null) {
      return (
        <div className="mt-8 pb-6 text-body text-muted-foreground" data-testid="comment-threads-loading">
          正在加载评论...
        </div>
      )
    }
    return null
  }

  return (
    <>
      <CommentRail
        open={railOpen}
        onOpenChange={onRailOpenChange}
        threads={threads}
        activeThreadId={activeThreadId}
        viewportWidth={viewportWidth}
        currentUserId={currentUser?.id ?? null}
        locale="zh-CN"
        labels={threadLabels}
        onSelectThread={handleSelectThread}
        onResolveThread={handleResolve}
        onReopenThread={handleReopen}
        onReanchorThread={handleReanchor}
        onReply={handleReply}
        onCreateThread={handleCreateAnchoredThread}
        onUploadImage={onUploadImage}
        onRefreshAttachmentPreview={onRefreshAttachmentPreview}
        onDeleteMessage={handleDeleteMessage}
        mentionCandidates={mentionCandidates}
        onCollapseOutlineChange={onCollapseOutlineChange}
        isCreating={isCreating}
        focusComposerToken={focusComposerToken}
      />
      <DocumentCommentThreadsSection
        threads={threads}
        documentScopeOnly
        currentUserId={currentUser?.id ?? null}
        locale="zh-CN"
        labels={{
          ...threadLabels,
          title: '全文评论',
          empty: loadError || '暂无全文评论',
        }}
        onCreateThread={handleCreateDocumentThread}
        onReply={handleReply}
        onResolveThread={handleResolve}
        onReopenThread={handleReopen}
        onReanchorThread={handleReanchor}
        onSelectThread={handleSelectThread}
        onUploadImage={onUploadImage}
        onRefreshAttachmentPreview={onRefreshAttachmentPreview}
        onDeleteMessage={handleDeleteMessage}
        mentionCandidates={mentionCandidates}
        activeThreadId={activeDocumentThreadId}
        isCreating={isCreating}
      />
    </>
  )
}
