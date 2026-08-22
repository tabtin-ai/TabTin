import { useMemo, useState } from 'react'
import type { CommentThread, CommentThreadStatusFilter } from '../../comment-threads/types'
import {
  filterCommentThreads,
  filterDocumentScopeCommentThreads,
} from '../../comment-threads/filter'
import type { DocumentCommentMentionCandidate } from '../DocumentCommentsSection'
import { CommentComposer, type CommentComposerLabels } from './CommentComposer'
import {
  CommentThreadCard,
  type CommentAttachmentPreviewRequest,
  type CommentThreadCardLabels,
} from './CommentThreadCard'

/**
 * 底部全文/线程评论区（comment_threads_v1）。
 * 与旧 DocumentCommentsSection 并存：能力缺失时宿主继续用旧组件。
 */
export interface DocumentCommentThreadsSectionLabels extends CommentThreadCardLabels, CommentComposerLabels {
  title?: string
  filterOpen?: string
  filterResolved?: string
  filterAll?: string
  empty?: string
}

export interface DocumentCommentThreadsSectionProps {
  threads: CommentThread[]
  /** 默认只展示 scope=document 的全文线程；传 false 展示全部 */
  documentScopeOnly?: boolean
  statusFilter?: CommentThreadStatusFilter
  onStatusFilterChange?: (filter: CommentThreadStatusFilter) => void
  currentUserId?: string | null
  locale?: string
  labels?: DocumentCommentThreadsSectionLabels
  onCreateThread?: (input: {
    body: string
    mentionUserIds: string[]
    attachmentIds: string[]
    clientRequestId: string
  }) => void | Promise<void>
  onReply?: (
    threadId: string,
    input: { body: string; mentionUserIds: string[]; attachmentIds: string[]; clientRequestId: string },
  ) => void | Promise<void>
  onResolveThread?: (threadId: string) => void | Promise<void>
  onReopenThread?: (threadId: string) => void | Promise<void>
  onReanchorThread?: (threadId: string) => void | Promise<void>
  onSelectThread?: (threadId: string) => void
  onUploadImage?: (file: File) => Promise<{ fileId: string; previewUrl?: string }>
  onRefreshAttachmentPreview?: (fileId: string) => Promise<string>
  onOpenAttachmentPreview?: (request: CommentAttachmentPreviewRequest) => void | Promise<void>
  onDeleteMessage?: (threadId: string, messageId: string) => void | Promise<void>
  mentionCandidates?: DocumentCommentMentionCandidate[]
  activeThreadId?: string | null
  /** 通知跳转时强制展示并聚焦的线程。 */
  focusThreadId?: string
  /** 通知跳转时精确聚焦的消息。 */
  focusMessageId?: string
  isCreating?: boolean
  className?: string
}

export function DocumentCommentThreadsSection({
  threads,
  documentScopeOnly = true,
  statusFilter: controlledFilter,
  onStatusFilterChange,
  currentUserId = null,
  locale,
  labels,
  onCreateThread,
  onReply,
  onResolveThread,
  onReopenThread,
  onReanchorThread,
  onSelectThread,
  onUploadImage,
  onRefreshAttachmentPreview,
  onOpenAttachmentPreview,
  onDeleteMessage,
  mentionCandidates,
  activeThreadId = null,
  focusThreadId,
  focusMessageId,
  isCreating = false,
  className,
}: DocumentCommentThreadsSectionProps) {
  const [uncontrolledFilter, setUncontrolledFilter] = useState<CommentThreadStatusFilter>('open')
  const [draft, setDraft] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [replyingThreadId, setReplyingThreadId] = useState<string | null>(null)
  const statusFilter = controlledFilter ?? uncontrolledFilter

  const visible = useMemo(() => {
    const scoped = documentScopeOnly
      ? filterDocumentScopeCommentThreads(threads)
      : threads
    const filtered = filterCommentThreads(scoped, statusFilter)
    if (!focusThreadId || filtered.some((thread) => thread.id === focusThreadId)) return filtered
    const focused = scoped.find((thread) => thread.id === focusThreadId)
    return focused ? [...filtered, focused] : filtered
  }, [documentScopeOnly, focusThreadId, statusFilter, threads])

  const title = labels?.title ?? '全文评论'
  const setFilter = (filter: CommentThreadStatusFilter) => {
    onStatusFilterChange?.(filter)
    if (controlledFilter === undefined) setUncontrolledFilter(filter)
  }

  return (
    <section
      data-testid="document-comment-threads-section"
      className={className ?? (visible.length > 0 ? 'mt-10 border-t border-border pb-10 pt-5' : 'mt-8 pb-10')}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-title font-semibold text-foreground">{title}</h2>
        <div className="flex gap-1" role="tablist" aria-label="全文评论筛选">
          {([
            ['open', labels?.filterOpen ?? '未解决'],
            ['resolved', labels?.filterResolved ?? '已解决'],
            ['all', labels?.filterAll ?? '全部'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={statusFilter === key}
              className={`rounded-full px-2.5 py-1 text-caption ${
                statusFilter === key ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
              }`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 space-y-3">
        {visible.length === 0 ? (
          <p className="text-body text-muted-foreground">{labels?.empty ?? '暂无全文评论'}</p>
        ) : (
          visible.map((thread) => (
            <CommentThreadCard
              key={thread.id}
              thread={thread}
              active={thread.id === activeThreadId}
              focusMessageId={thread.id === focusThreadId ? focusMessageId : undefined}
              currentUserId={currentUserId}
              locale={locale}
              labels={labels}
              onSelect={onSelectThread}
              onResolve={onResolveThread}
              onReopen={onReopenThread}
              onReanchor={onReanchorThread}
              onUploadImage={onUploadImage}
              onRefreshAttachmentPreview={onRefreshAttachmentPreview}
              onOpenAttachmentPreview={onOpenAttachmentPreview}
              onDeleteMessage={onDeleteMessage}
              mentionCandidates={mentionCandidates}
              replyValue={replyDrafts[thread.id] ?? ''}
              onReplyValueChange={(value) => setReplyDrafts((prev) => ({ ...prev, [thread.id]: value }))}
              isReplying={replyingThreadId === thread.id}
              onReply={onReply ? async (threadId, input) => {
                if (replyingThreadId) return
                setReplyingThreadId(threadId)
                try {
                  await onReply(threadId, input)
                  setReplyDrafts((prev) => ({ ...prev, [threadId]: '' }))
                } finally {
                  setReplyingThreadId(null)
                }
              } : undefined}
            />
          ))
        )}
      </div>

      {onCreateThread ? (
        <CommentComposer
          value={draft}
          onValueChange={setDraft}
          isSubmitting={isCreating}
          onUploadImage={onUploadImage}
          mentionCandidates={mentionCandidates}
          labels={labels}
          onSubmit={async (input) => {
            await onCreateThread(input)
            setDraft('')
          }}
        />
      ) : null}
    </section>
  )
}
