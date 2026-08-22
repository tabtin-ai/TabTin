import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Button, ConfirmDialog, UserAvatar } from '@tabtin/smartsheet-ui'
import type { CommentAttachment, CommentMessage, CommentThread } from '../../comment-threads/types'
import { isAnchorDetached, threadSelectedText } from '../../comment-threads/types'
import type { DocumentCommentMentionCandidate } from '../DocumentCommentsSection'
import { CommentComposer, type CommentComposerLabels } from './CommentComposer'

export interface CommentThreadCardLabels extends CommentComposerLabels {
  reply?: string
  resolve?: string
  reopen?: string
  reanchor?: string
  detached?: string
  replyPlaceholder?: string
  deleteConfirmTitle?: string
  deleteConfirmDescription?: string
  deleteConfirmText?: string
  resolveConfirmTitle?: string
  resolveConfirmDescription?: string
  resolveConfirmText?: string
  cancelConfirmText?: string
}

export interface CommentAttachmentPreviewRequest {
  attachment: CommentAttachment
  attachments: CommentAttachment[]
  previewUrl: string
}

export interface CommentThreadCardProps {
  thread: CommentThread
  active?: boolean
  currentUserId?: string | null
  locale?: string
  labels?: CommentThreadCardLabels
  /** 回调由宿主接线，不绑具体 API */
  onSelect?: (threadId: string) => void
  onResolve?: (threadId: string) => void | Promise<void>
  onReopen?: (threadId: string) => void | Promise<void>
  onReanchor?: (threadId: string) => void | Promise<void>
  onReply?: (threadId: string, input: {
    body: string
    mentionUserIds: string[]
    attachmentIds: string[]
    clientRequestId: string
  }) => void | Promise<void>
  onUploadImage?: (file: File) => Promise<{ fileId: string; previewUrl?: string }>
  onRefreshAttachmentPreview?: (fileId: string) => Promise<string>
  /** 图片预览由宿主接线；未提供时保留原有新窗口打开行为。 */
  onOpenAttachmentPreview?: (request: CommentAttachmentPreviewRequest) => void | Promise<void>
  onDeleteMessage?: (threadId: string, messageId: string) => void | Promise<void>
  mentionCandidates?: DocumentCommentMentionCandidate[]
  replyValue?: string
  onReplyValueChange?: (value: string) => void
  isReplying?: boolean
  focusMessageId?: string
  className?: string
}

function formatTime(value: string | null | undefined, locale?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale)
}

function AttachmentPreview({
  attachment,
  attachments,
  onRefresh,
  onOpenPreview,
}: {
  attachment: CommentAttachment
  attachments: CommentAttachment[]
  onRefresh?: (fileId: string) => Promise<string>
  onOpenPreview?: (request: CommentAttachmentPreviewRequest) => void | Promise<void>
}) {
  const [previewUrl, setPreviewUrl] = useState(attachment.preview_url)
  const refreshPromiseRef = useRef<Promise<string> | null>(null)
  const failedUrlRef = useRef<string | null>(null)

  useEffect(() => {
    setPreviewUrl(attachment.preview_url)
    failedUrlRef.current = null
  }, [attachment.preview_url])

  const refresh = useCallback(() => {
    if (!onRefresh || !attachment.file_id) return Promise.resolve(previewUrl)
    if (refreshPromiseRef.current) return refreshPromiseRef.current
    const pending = onRefresh(attachment.file_id)
      .then((next) => {
        if (next) {
          setPreviewUrl(next)
          failedUrlRef.current = null
          return next
        }
        return previewUrl
      })
      .finally(() => {
        refreshPromiseRef.current = null
      })
    refreshPromiseRef.current = pending
    return pending
  }, [attachment.file_id, onRefresh, previewUrl])

  const shouldOpenInApp = attachment.type === 'image' && Boolean(onOpenPreview)

  const openFreshPreview = async (event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => {
    if (!shouldOpenInApp && !onRefresh) return
    event.preventDefault()
    event.stopPropagation()

    if (shouldOpenInApp && onOpenPreview) {
      try {
        const freshUrl = onRefresh ? await refresh() : previewUrl
        await onOpenPreview({ attachment, attachments, previewUrl: freshUrl })
      } catch {
        // 换签或宿主预览失败时留在评论上下文，不回退成隐式下载。
      }
      return
    }

    const popup = window.open('about:blank', '_blank', 'noopener,noreferrer')
    try {
      const freshUrl = await refresh()
      if (popup) popup.location.replace(freshUrl)
      else window.open(freshUrl, '_blank', 'noopener,noreferrer')
    } catch {
      popup?.close()
    }
  }

  const thumbnail = (
    <img
      src={previewUrl}
      alt={attachment.metadata.file_name || 'attachment'}
      className="h-full w-full object-cover"
      onError={() => {
        if (!onRefresh || failedUrlRef.current === previewUrl) return
        failedUrlRef.current = previewUrl
        void refresh()
      }}
    />
  )

  if (shouldOpenInApp) {
    return (
      <button
        type="button"
        className="block h-16 w-16 overflow-hidden rounded-md border border-border"
        aria-label={attachment.metadata.file_name || 'attachment'}
        onClick={(event) => { void openFreshPreview(event) }}
      >
        {thumbnail}
      </button>
    )
  }

  return (
    <a
      href={previewUrl}
      target="_blank"
      rel="noreferrer"
      className="block h-16 w-16 overflow-hidden rounded-md border border-border"
      onClick={(event) => { void openFreshPreview(event) }}
    >
      {thumbnail}
    </a>
  )
}

function MessageBody({
  message,
  onRefreshAttachmentPreview,
  onOpenAttachmentPreview,
}: {
  message: CommentMessage
  onRefreshAttachmentPreview?: (fileId: string) => Promise<string>
  onOpenAttachmentPreview?: (request: CommentAttachmentPreviewRequest) => void | Promise<void>
}) {
  if (message.is_deleted) {
    return <p className="text-body text-muted-foreground">消息已删除</p>
  }
  return (
    <div className="space-y-2">
      {message.body ? (
        <p className="whitespace-pre-wrap break-words text-body text-foreground">{message.body}</p>
      ) : null}
      {message.attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {message.attachments.map((attachment) => (
            <AttachmentPreview
              key={attachment.id || attachment.file_id}
              attachment={attachment}
              attachments={message.attachments}
              onRefresh={onRefreshAttachmentPreview}
              onOpenPreview={onOpenAttachmentPreview}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function CommentThreadCard({
  thread,
  active = false,
  currentUserId = null,
  locale,
  labels,
  onSelect,
  onResolve,
  onReopen,
  onReanchor,
  onReply,
  onUploadImage,
  onRefreshAttachmentPreview,
  onOpenAttachmentPreview,
  onDeleteMessage,
  mentionCandidates,
  replyValue = '',
  onReplyValueChange,
  isReplying = false,
  focusMessageId,
  className,
}: CommentThreadCardProps) {
  const selectedText = threadSelectedText(thread)
  const detached = thread.scope !== 'document' && isAnchorDetached(thread.anchor_status)
  const resolveLabel = labels?.resolve ?? '解决'
  const reopenLabel = labels?.reopen ?? '重开'
  const reanchorLabel = labels?.reanchor ?? '重新关联'
  const detachedLabel = labels?.detached ?? '锚点已失效'
  const cancelText = labels?.cancelConfirmText ?? '取消'
  const replyLabel = labels?.reply ?? '回复'

  const [pendingDeleteMessageId, setPendingDeleteMessageId] = useState<string | null>(null)
  const [pendingResolve, setPendingResolve] = useState(false)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [replyComposerOpen, setReplyComposerOpen] = useState(false)
  const [replyFocusToken, setReplyFocusToken] = useState(0)
  const messageElementsRef = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    if (!focusMessageId) return
    messageElementsRef.current.get(focusMessageId)?.scrollIntoView?.({ block: 'nearest' })
  }, [focusMessageId, thread.messages])

  const openReplyComposer = () => {
    setReplyComposerOpen(true)
    setReplyFocusToken((token) => token + 1)
  }

  return (
    <article
      data-testid="comment-thread-card"
      data-thread-id={thread.id}
      data-comment-thread-id={thread.id}
      data-active={active ? 'true' : 'false'}
      className={className ?? `rounded-lg border px-3 py-3 ${active ? 'border-primary/50 bg-primary/5' : 'border-border bg-background'}`}
      onClick={(event) => {
        // React Portal 中的确认对话框仍会沿 React 树冒泡到卡片，
        // 但它不属于卡片正文点击，不能触发线程选择。
        if (!event.currentTarget.contains(event.target as Node)) return
        onSelect?.(thread.id)
      }}
    >
      <ConfirmDialog
        open={Boolean(pendingDeleteMessageId)}
        onOpenChange={(open) => {
          if (!open && !confirmBusy) setPendingDeleteMessageId(null)
        }}
        title={labels?.deleteConfirmTitle ?? '删除这条评论？'}
        description={labels?.deleteConfirmDescription ?? '删除后将无法在评论区恢复。'}
        confirmText={labels?.deleteConfirmText ?? '确认删除'}
        cancelText={cancelText}
        variant="destructive"
        isLoading={confirmBusy}
        onConfirm={async () => {
          if (!pendingDeleteMessageId || !onDeleteMessage) return
          setConfirmBusy(true)
          try {
            await onDeleteMessage(thread.id, pendingDeleteMessageId)
            setPendingDeleteMessageId(null)
          } finally {
            setConfirmBusy(false)
          }
        }}
      />
      <ConfirmDialog
        open={pendingResolve}
        onOpenChange={(open) => {
          if (!open && !confirmBusy) setPendingResolve(false)
        }}
        title={labels?.resolveConfirmTitle ?? '标记为已解决？'}
        description={labels?.resolveConfirmDescription ?? '解决后仍可重新打开这条评论。'}
        confirmText={labels?.resolveConfirmText ?? '确认解决'}
        cancelText={cancelText}
        isLoading={confirmBusy}
        onConfirm={async () => {
          if (!onResolve) return
          setConfirmBusy(true)
          try {
            await onResolve(thread.id)
            setPendingResolve(false)
          } finally {
            setConfirmBusy(false)
          }
        }}
      />

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-0.5">
            {thread.status === 'resolved' ? '已解决' : '进行中'}
          </span>
          {detached ? (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">{detachedLabel}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1" onClick={(event) => event.stopPropagation()}>
          {thread.status === 'open' && onResolve ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-caption"
              data-testid="comment-thread-resolve"
              onClick={() => setPendingResolve(true)}
            >
              {resolveLabel}
            </Button>
          ) : null}
          {thread.status === 'resolved' && onReopen ? (
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-caption" onClick={() => void onReopen(thread.id)}>
              {reopenLabel}
            </Button>
          ) : null}
          {detached && onReanchor ? (
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-caption" onClick={() => void onReanchor(thread.id)}>
              {reanchorLabel}
            </Button>
          ) : null}
        </div>
      </div>

      {selectedText ? (
        <blockquote className="mb-3 border-l-2 border-primary/40 pl-2 text-caption text-muted-foreground">
          {selectedText}
        </blockquote>
      ) : null}

      <div className="space-y-3">
        {thread.messages.map((message) => {
          const canDelete = Boolean(
            onDeleteMessage
            && currentUserId
            && message.author_user_id
            && message.author_user_id === currentUserId
            && !message.is_deleted,
          )
          return (
            <div
              key={message.id}
              ref={(element) => {
                if (element) messageElementsRef.current.set(message.id, element)
                else messageElementsRef.current.delete(message.id)
              }}
              data-testid={`comment-message-${message.id}`}
              data-comment-message-id={message.id}
              data-notification-focus={focusMessageId === message.id ? 'true' : 'false'}
              className={`flex gap-2 rounded-md transition-colors ${
                focusMessageId === message.id ? 'bg-primary/10 ring-1 ring-primary/40' : ''
              }`}
            >
              <UserAvatar
                name={message.author_name || '用户'}
                avatarUrl={message.author_avatar}
                seed={message.author_user_id}
                size={28}
              />
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex flex-wrap items-center gap-2">
                  <span className="text-caption font-medium text-foreground">{message.author_name || '用户'}</span>
                  {message.created_at ? (
                    <span className="text-caption text-muted-foreground/70">{formatTime(message.created_at, locale)}</span>
                  ) : null}
                  {onReply && !message.is_deleted ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1 text-caption text-muted-foreground"
                      data-testid="comment-message-reply"
                      onClick={(event) => {
                        event.stopPropagation()
                        openReplyComposer()
                      }}
                    >
                      {replyLabel}
                    </Button>
                  ) : null}
                  {canDelete ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1 text-caption text-destructive"
                      data-testid="comment-message-delete"
                      onClick={(event) => {
                        event.stopPropagation()
                        setPendingDeleteMessageId(message.id)
                      }}
                    >
                      删除
                    </Button>
                  ) : null}
                </div>
                <MessageBody
                  message={message}
                  onRefreshAttachmentPreview={onRefreshAttachmentPreview}
                  onOpenAttachmentPreview={onOpenAttachmentPreview}
                />
              </div>
            </div>
          )
        })}
      </div>

      {replyComposerOpen && onReply && onReplyValueChange ? (
        <div className="mt-3" onClick={(event) => event.stopPropagation()}>
          <CommentComposer
            value={replyValue}
            onValueChange={onReplyValueChange}
            onCancel={() => {
              onReplyValueChange('')
              setReplyComposerOpen(false)
            }}
            onSubmit={async (input) => {
              await onReply(thread.id, input)
              setReplyComposerOpen(false)
            }}
            onUploadImage={onUploadImage}
            mentionCandidates={mentionCandidates}
            isSubmitting={isReplying}
            autoFocus
            focusToken={replyFocusToken}
            labels={{
              ...labels,
              placeholder: labels?.replyPlaceholder ?? '回复…',
            }}
          />
        </div>
      ) : null}
    </article>
  )
}
