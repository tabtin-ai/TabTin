import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import type { CommentThread, CommentThreadStatusFilter } from '../../comment-threads/types'
import {
  filterAnchoredCommentThreads,
  filterCommentThreads,
} from '../../comment-threads/filter'
import {
  COMMENT_RAIL_WIDTH_PX,
  resolveCommentRailLayout,
  shouldCollapseOutlineForComments,
  type CommentRailLayoutMode,
} from '../../comment-threads/layout'
import type { DocumentCommentMentionCandidate } from '../DocumentCommentsSection'
import {
  CommentThreadCard,
  type CommentAttachmentPreviewRequest,
  type CommentThreadCardLabels,
} from './CommentThreadCard'
import { CommentComposer, type CommentComposerLabels } from './CommentComposer'

export interface CommentRailLabels extends CommentThreadCardLabels, CommentComposerLabels {
  title?: string
  filterOpen?: string
  filterResolved?: string
  filterAll?: string
  empty?: string
  close?: string
  newThreadPlaceholder?: string
}

export interface CommentRailProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  threads: CommentThread[]
  activeThreadId?: string | null
  /** 通知跳转时强制展示并聚焦的线程。 */
  focusThreadId?: string
  /** 通知跳转时精确聚焦的消息。 */
  focusMessageId?: string
  viewportWidth: number
  currentUserId?: string | null
  locale?: string
  labels?: CommentRailLabels
  statusFilter?: CommentThreadStatusFilter
  onStatusFilterChange?: (filter: CommentThreadStatusFilter) => void
  onSelectThread?: (threadId: string) => void
  onResolveThread?: (threadId: string) => void | Promise<void>
  onReopenThread?: (threadId: string) => void | Promise<void>
  onReanchorThread?: (threadId: string) => void | Promise<void>
  onReply?: CommentThreadCardPropsOnReply
  onCreateThread?: (input: {
    body: string
    mentionUserIds: string[]
    attachmentIds: string[]
    clientRequestId: string
  }) => void | Promise<void>
  onUploadImage?: (file: File) => Promise<{ fileId: string; previewUrl?: string }>
  onRefreshAttachmentPreview?: (fileId: string) => Promise<string>
  onOpenAttachmentPreview?: (request: CommentAttachmentPreviewRequest) => void | Promise<void>
  onDeleteMessage?: (threadId: string, messageId: string) => void | Promise<void>
  mentionCandidates?: DocumentCommentMentionCandidate[]
  /** 右栏打开时回调 true，供宿主收起大纲 */
  onCollapseOutlineChange?: (collapse: boolean) => void
  isCreating?: boolean
  className?: string
  /** 递增以聚焦底部新建 composer（发起评论后） */
  focusComposerToken?: number
  /** 尚未提交的新评论所引用的锚点内容 */
  draftSelectedText?: string
  /** 宽屏时嵌入宿主的文档布局，避免覆盖正文。窄屏 drawer 仍使用全局遮罩。 */
  embedded?: boolean
}

type CommentThreadCardPropsOnReply = (
  threadId: string,
  input: { body: string; mentionUserIds: string[]; attachmentIds: string[]; clientRequestId: string },
) => void | Promise<void>

export function CommentRail({
  open,
  onOpenChange,
  threads,
  activeThreadId = null,
  focusThreadId,
  focusMessageId,
  viewportWidth,
  currentUserId = null,
  locale,
  labels,
  statusFilter: controlledFilter,
  onStatusFilterChange,
  onSelectThread,
  onResolveThread,
  onReopenThread,
  onReanchorThread,
  onReply,
  onCreateThread,
  onUploadImage,
  onRefreshAttachmentPreview,
  onOpenAttachmentPreview,
  onDeleteMessage,
  mentionCandidates,
  onCollapseOutlineChange,
  isCreating = false,
  className,
  focusComposerToken,
  draftSelectedText,
  embedded = false,
}: CommentRailProps) {
  const [uncontrolledFilter, setUncontrolledFilter] = useState<CommentThreadStatusFilter>('open')
  const [draft, setDraft] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [replyingThreadId, setReplyingThreadId] = useState<string | null>(null)
  const statusFilter = controlledFilter ?? uncontrolledFilter
  const setStatusFilter = (filter: CommentThreadStatusFilter) => {
    onStatusFilterChange?.(filter)
    if (controlledFilter === undefined) setUncontrolledFilter(filter)
  }

  const layout: CommentRailLayoutMode = resolveCommentRailLayout(viewportWidth)
  const filtered = useMemo(() => {
    const anchored = filterAnchoredCommentThreads(threads)
    const visible = filterCommentThreads(anchored, statusFilter)
    if (!focusThreadId || visible.some((thread) => thread.id === focusThreadId)) return visible
    const focused = anchored.find((thread) => thread.id === focusThreadId)
    return focused ? [...visible, focused] : visible
  }, [focusThreadId, statusFilter, threads])

  useEffect(() => {
    onCollapseOutlineChange?.(
      embedded ? open : shouldCollapseOutlineForComments({ open, layout }),
    )
  }, [embedded, open, layout, onCollapseOutlineChange])

  if (!open) return null

  const title = labels?.title ?? '评论'
  const panelStyle = layout === 'rail'
    ? { width: COMMENT_RAIL_WIDTH_PX }
    : { width: Math.min(COMMENT_RAIL_WIDTH_PX, Math.max(280, viewportWidth - 24)) }

  // rail / drawer 均贴右侧：宿主可把本组件挂在任意槽位，不必依赖横向 flex。
  const panel = (
    <aside
      data-testid="comment-rail"
      data-layout={layout}
      className={className ?? `${embedded ? 'relative max-h-full min-h-0' : 'fixed inset-y-0 right-0'} flex h-full flex-col border-l border-border bg-background shadow-sm ${layout === 'drawer' && !embedded ? 'z-modal' : 'z-sticky'}`}
      style={panelStyle}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-title font-semibold text-foreground">{title}</h2>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={labels?.close ?? '关闭'}
          onClick={() => onOpenChange(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex gap-1 border-b border-border px-3 py-2" role="tablist" aria-label="评论筛选">
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
            data-testid={`comment-filter-${key}`}
            className={`rounded-full px-2.5 py-1 text-caption ${
              statusFilter === key ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
            }`}
            onClick={() => setStatusFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {filtered.length === 0 ? (
          <p className="text-body text-muted-foreground">{labels?.empty ?? '暂无评论'}</p>
        ) : (
          filtered.map((thread) => (
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
        <div className="border-t border-border p-3">
          {draftSelectedText ? (
            <blockquote
              data-testid="comment-draft-anchor"
              className="mb-3 border-l-2 border-primary/40 pl-2 text-caption text-muted-foreground"
            >
              {draftSelectedText}
            </blockquote>
          ) : null}
          <CommentComposer
            value={draft}
            onValueChange={setDraft}
            isSubmitting={isCreating}
            onUploadImage={onUploadImage}
            mentionCandidates={mentionCandidates}
            focusToken={focusComposerToken}
            autoFocus={focusComposerToken != null}
            labels={{
              ...labels,
              placeholder: labels?.newThreadPlaceholder ?? labels?.placeholder ?? '添加评论…',
            }}
            onSubmit={async (input) => {
              await onCreateThread(input)
              setDraft('')
            }}
          />
        </div>
      ) : null}
    </aside>
  )

  if (layout === 'drawer' && !embedded) {
    return (
      <div className="fixed inset-0 z-modal" data-testid="comment-rail-drawer-root">
        <button
          type="button"
          className="absolute inset-0 bg-black/30"
          aria-label={labels?.close ?? '关闭'}
          onClick={() => onOpenChange(false)}
        />
        {panel}
      </div>
    )
  }

  return panel
}
