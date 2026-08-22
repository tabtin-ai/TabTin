import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CompositionEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Loader2, Send } from 'lucide-react'
import { Badge } from '../badge'
import { Button } from '../button'
import { ConfirmDialog } from '../confirm-dialog'
import { UserAvatar } from '../common/user-avatar'

export interface CommentItem {
  id: string
  author_name: string
  /** 展示作者类型；省略时保持既有的人类作者展示。 */
  author_type?: 'human' | 'agent'
  /** Agent 发言时保留授权用户与运行锚点，供审计追溯。 */
  authorization_subject_name?: string | null
  agent_run_id?: string | null
  author_user_id?: string | null
  author_avatar?: string | null
  author_account_name?: string | null
  body: string
  created_at: string | null
  selected_text?: string
  mention_user_ids?: string[]
  /** 服务端按资源权限计算的删除能力；未提供时兼容按作者用户判断。 */
  can_delete?: boolean
  is_deleted?: boolean
  thread_id?: string
  thread_status?: 'open' | 'resolved'
  can_resolve?: boolean
  can_reopen?: boolean
  reply_to?: {
    id: string
    author_name: string
    body: string
    is_deleted: boolean
  } | null
}

export interface CommentsLabels {
  title?: string
  placeholder?: string
  submit?: string
  deleteComment?: string
  deletingComment?: string
  retry?: string
  loading?: string
  unknownUser?: string
  noMentionResults?: string
  loadMore?: string
  loadingMore?: string
  reply?: string
  replyingTo?: string
  cancelReply?: string
  deletedComment?: string
  filterOpen?: string
  filterResolved?: string
  filterAll?: string
  resolveThread?: string
  reopenThread?: string
  updatingThread?: string
  empty?: string
  countUnit?: string
}

export interface CommentMentionCandidate {
  userId: string
  displayName: string
  accountName?: string | null
  avatar?: string | null
  email?: string | null
  labels?: string[]
}

export interface CommentsSectionProps {
  comments: CommentItem[]
  total?: number
  value: string
  onValueChange: (value: string) => void
  /** 提交时附带编辑器内真实 mention segment 的 userId，避免仅靠正文文本匹配丢 ID。 */
  onSubmit: (mentionUserIds: string[], replyToCommentId?: string) => void | Promise<void>
  mentionCandidates?: CommentMentionCandidate[]
  onMentionSelect?: (candidate: CommentMentionCandidate) => void
  /** 输入 @ 查询时通知宿主补充远端候选；本地候选仍立即过滤展示。 */
  onMentionSearch?: (query: string) => void
  currentUserId?: string | null
  deletingCommentIds?: readonly string[]
  onDeleteComment?: (commentId: string) => void | Promise<void>
  statusFilter?: 'open' | 'resolved' | 'all'
  onStatusFilterChange?: (status: 'open' | 'resolved' | 'all') => void
  updatingThreadIds?: readonly string[]
  onResolveThread?: (threadId: string) => void | Promise<void>
  onReopenThread?: (threadId: string) => void | Promise<void>
  onRetry?: () => void | Promise<void>
  isLoading?: boolean
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void | Promise<void>
  isSubmitting?: boolean
  error?: string | null
  /** 通知等入口需要定位的评论；宿主清空后高亮随之消失。 */
  highlightedCommentId?: string | null
  maxLength?: number
  labels?: CommentsLabels
  locale?: string
  className?: string
  /** 隐藏发布、删除等评论写操作；应按评论权限传入，不要从宿主记录的只读状态推断。 */
  readOnly?: boolean
  /** inline 保持 TabDoc 原布局；side-panel 提供独立标题、滚动区和底部输入区。 */
  layout?: 'inline' | 'side-panel'
  /** 面板首次挂载后把焦点放到评论输入框。 */
  autoFocus?: boolean
}

type DocumentCommentItem = CommentItem
type DocumentCommentMentionCandidate = CommentMentionCandidate

const DEFAULT_MAX_COMMENT_LENGTH = 2000
const MAX_MENTION_RESULTS = 8
const MAX_MENTION_QUERY_LENGTH = 20
const MENTION_SEARCH_DEBOUNCE_MS = 250
const MENTION_CARD_WIDTH_PX = 320
const MENTION_CARD_HEIGHT_PX = 128
const MENTION_CARD_GAP_PX = 8
const VIEWPORT_GUTTER_PX = 8
const DELETE_COMMENT_CONFIRM_TITLE = '删除这条评论？'
const DELETE_COMMENT_CONFIRM_DESCRIPTION = '删除后将无法在评论区恢复。'
const DELETE_COMMENT_CONFIRM_TEXT = '确认删除'
const DELETE_COMMENT_CANCEL_TEXT = '取消'
const MENTION_QUERY_RE = new RegExp(`@([^\\s@]{0,${MAX_MENTION_QUERY_LENGTH}})$`)
const COMMENT_MENTION_RE = /@([^\s@,.;:!?，。！？、；："'“”‘’()[\]{}<>《》]+)/g
const COMMENT_HTTP_URL_RE = /\bhttps?:\/\/[^\s<>"'，。！？、；：]+/gi
const URL_TRAILING_PUNCTUATION_RE = /[),.;!?\]}]+$/

interface MentionState {
  query: string
  startIndex: number
}

type CommentInputSegment =
  | { type: 'text', text: string }
  | { type: 'mention', candidate: DocumentCommentMentionCandidate }

interface MentionCardState {
  candidate: DocumentCommentMentionCandidate
  anchorRect: DOMRect
}

interface MentionCardPosition {
  top: number
  left: number
  maxHeight: number
}

function formatCommentTime(value: string | null, locale?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale)
}

function commentAuthorDisplayName(comment: DocumentCommentItem, fallback: string): string {
  return comment.author_name.trim() || fallback
}

function commentAuthorCandidate(
  comment: DocumentCommentItem,
  fallback: string,
): DocumentCommentMentionCandidate | null {
  const userId = comment.author_user_id?.trim()
  if (!userId) return null
  return {
    userId,
    displayName: commentAuthorDisplayName(comment, fallback),
    accountName: comment.author_account_name?.trim() || null,
    avatar: comment.author_avatar || null,
  }
}

function mentionDisplayName(candidate: DocumentCommentMentionCandidate): string {
  return candidate.displayName.trim()
    || candidate.accountName?.trim()
    || candidate.userId.slice(0, 8)
}

function mentionSearchText(candidate: DocumentCommentMentionCandidate): string {
  return [
    candidate.displayName,
    candidate.accountName,
    candidate.email,
    candidate.userId,
    ...(candidate.labels ?? []),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

function mentionTokenText(candidate: DocumentCommentMentionCandidate): string {
  return `@${mentionDisplayName(candidate)}`
}

function mentionAccountName(candidate: DocumentCommentMentionCandidate): string {
  return candidate.accountName?.trim() || candidate.userId.slice(0, 8)
}

/** 从 contentEditable mention segment 提取去重后的 userId，供提交通知使用。 */
function extractMentionUserIdsFromSegments(
  segments: ReadonlyArray<CommentInputSegment>,
): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const segment of segments) {
    if (segment.type !== 'mention') continue
    const userId = segment.candidate.userId?.trim()
    if (!userId || seen.has(userId)) continue
    seen.add(userId)
    ids.push(userId)
  }
  return ids
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getMentionCardPosition(anchorRect: DOMRect, cardHeight: number): MentionCardPosition {
  const viewportBottom = window.innerHeight - VIEWPORT_GUTTER_PX
  const belowTop = anchorRect.bottom + MENTION_CARD_GAP_PX
  const belowAvailable = Math.max(0, viewportBottom - belowTop)
  const aboveBottom = anchorRect.top - MENTION_CARD_GAP_PX
  const aboveAvailable = Math.max(0, aboveBottom - VIEWPORT_GUTTER_PX)
  const measuredHeight = Math.max(1, cardHeight || MENTION_CARD_HEIGHT_PX)
  const maxLeft = Math.max(VIEWPORT_GUTTER_PX, window.innerWidth - VIEWPORT_GUTTER_PX - MENTION_CARD_WIDTH_PX)
  const left = clamp(anchorRect.left, VIEWPORT_GUTTER_PX, maxLeft)

  if (belowAvailable >= measuredHeight || belowAvailable >= aboveAvailable) {
    const renderedHeight = Math.min(measuredHeight, Math.max(1, belowAvailable))
    const top = clamp(belowTop, VIEWPORT_GUTTER_PX, viewportBottom - renderedHeight)
    return {
      top,
      left,
      maxHeight: Math.max(1, viewportBottom - top),
    }
  }

  const renderedHeight = Math.min(measuredHeight, Math.max(1, aboveAvailable))
  const top = Math.max(VIEWPORT_GUTTER_PX, aboveBottom - renderedHeight)
  return {
    top,
    left,
    maxHeight: Math.max(1, aboveBottom - top),
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function segmentsToHtml(segments: CommentInputSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.type === 'text') return escapeHtml(segment.text).replace(/\n/g, '<br>')
      const displayName = mentionDisplayName(segment.candidate)
      return [
        '<span',
        ' role="button"',
        ' tabindex="0"',
        ' contenteditable="false"',
        ` aria-label="查看 ${escapeHtml(displayName)} 的用户信息"`,
        ` data-mention-user-id="${escapeHtml(segment.candidate.userId)}"`,
        ` data-mention-display-name="${escapeHtml(displayName)}"`,
        segment.candidate.accountName ? ` data-mention-account-name="${escapeHtml(segment.candidate.accountName)}"` : '',
        segment.candidate.avatar ? ` data-mention-avatar="${escapeHtml(segment.candidate.avatar)}"` : '',
        ' class="mx-0.5 inline cursor-pointer select-none rounded-sm text-primary outline-none hover:bg-primary/10 hover:underline focus-visible:bg-primary/10 focus-visible:ring-1 focus-visible:ring-primary/40"',
        `>@${escapeHtml(displayName)}</span>`,
      ].join('')
    })
    .join('')
}

function mentionCandidateFromToken(
  token: string,
  mentionUserId: string | undefined,
  mentionCandidateById: Map<string, DocumentCommentMentionCandidate>,
  mentionCandidates: DocumentCommentMentionCandidate[],
): DocumentCommentMentionCandidate | null {
  const displayName = token.slice(1).trim()
  if (!displayName) return null
  if (mentionUserId) {
    const candidate = mentionCandidateById.get(mentionUserId)
    if (candidate) return candidate
    return { userId: mentionUserId, displayName: displayName || mentionUserId.slice(0, 8) }
  }

  const matches = mentionCandidates.filter((candidate) => mentionDisplayName(candidate) === displayName)
  if (matches.length === 1) return matches[0]

  return null
}

function mentionRenderToken(body: string, startIndex: number, token: string, candidate: DocumentCommentMentionCandidate): string {
  const fullToken = mentionTokenText(candidate)
  if (fullToken.length > token.length && fullToken.startsWith(token) && body.startsWith(fullToken, startIndex)) {
    return fullToken
  }
  return token
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

interface SafeHttpUrlToken {
  start: number
  end: number
  rawEnd: number
  url: string
  trailing: string
}

function collectSafeHttpUrls(text: string): SafeHttpUrlToken[] {
  const tokens: SafeHttpUrlToken[] = []
  let match: RegExpExecArray | null

  COMMENT_HTTP_URL_RE.lastIndex = 0
  while ((match = COMMENT_HTTP_URL_RE.exec(text)) !== null) {
    const rawMatch = match[0]
    const trailing = rawMatch.match(URL_TRAILING_PUNCTUATION_RE)?.[0] ?? ''
    const url = trailing ? rawMatch.slice(0, -trailing.length) : rawMatch
    if (!url || !isSafeHttpUrl(url)) continue
    tokens.push({
      start: match.index,
      end: match.index + url.length,
      rawEnd: match.index + rawMatch.length,
      url,
      trailing,
    })
  }

  return tokens
}

function appendTextWithSafeLinks(
  nodes: ReactNode[],
  text: string,
  sourceOffset: number,
) {
  let lastIndex = 0
  for (const token of collectSafeHttpUrls(text)) {
    if (token.start > lastIndex) nodes.push(text.slice(lastIndex, token.start))
    nodes.push(
      <a
        key={`url-${sourceOffset + token.start}-${token.url}`}
        href={token.url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-primary underline underline-offset-2 hover:text-primary/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
      >
        {token.url}
      </a>,
    )
    if (token.trailing) nodes.push(token.trailing)
    lastIndex = token.rawEnd
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
}

function runCommentAction(action: () => void | Promise<void>) {
  try {
    void Promise.resolve(action()).catch(() => undefined)
  } catch {
    // 宿主维护并展示请求错误；组件只确保事件回调不会产生未处理异常。
  }
}

function renderCommentBody(
  body: string,
  mentionUserIds: string[] | undefined,
  mentionCandidateById: Map<string, DocumentCommentMentionCandidate>,
  mentionCandidates: DocumentCommentMentionCandidate[],
  onMentionOpen: (candidate: DocumentCommentMentionCandidate, target: HTMLElement) => void,
) {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let mentionUserIndex = 0
  let match: RegExpExecArray | null
  const safeUrlRanges = collectSafeHttpUrls(body)

  COMMENT_MENTION_RE.lastIndex = 0
  while ((match = COMMENT_MENTION_RE.exec(body)) !== null) {
    if (safeUrlRanges.some((url) => match!.index >= url.start && match!.index < url.end)) {
      continue
    }
    const [token] = match
    if (match.index > lastIndex) {
      appendTextWithSafeLinks(nodes, body.slice(lastIndex, match.index), lastIndex)
    }
    const mentionUserId = mentionUserIds?.[mentionUserIndex]
    const candidate = mentionCandidateFromToken(token, mentionUserId, mentionCandidateById, mentionCandidates)
    if (candidate?.userId && mentionUserId && candidate.userId === mentionUserId) {
      mentionUserIndex += 1
    }
    const renderToken = candidate ? mentionRenderToken(body, match.index, token, candidate) : token
    if (candidate) {
      const displayName = mentionDisplayName(candidate)
      nodes.push(
        <button
          key={`${match.index}-${renderToken}`}
          type="button"
          data-mention-user-id={candidate.userId}
          className="inline rounded-sm bg-transparent px-0.5 text-primary underline-offset-2 hover:bg-primary/10 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
          aria-label={`查看 ${displayName} 的用户信息`}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onMentionOpen(candidate, event.currentTarget)
          }}
        >
          {renderToken}
        </button>,
      )
    } else {
      // 未绑定真实成员的 @文本不当成 mention 高亮，避免「@后面全变蓝」
      nodes.push(renderToken)
    }
    lastIndex = match.index + renderToken.length
    COMMENT_MENTION_RE.lastIndex = lastIndex
  }

  if (lastIndex < body.length) {
    appendTextWithSafeLinks(nodes, body.slice(lastIndex), lastIndex)
  }
  return nodes.length > 0 ? nodes : body
}

function serializeCommentSegments(segments: CommentInputSegment[]): string {
  return segments
    .map((segment) => segment.type === 'mention' ? mentionTokenText(segment.candidate) : segment.text)
    .join('')
}

function normalizeTextSegments(segments: CommentInputSegment[]): CommentInputSegment[] {
  const result: CommentInputSegment[] = []
  for (const segment of segments) {
    if (segment.type === 'mention') {
      result.push(segment)
      continue
    }
    if (!segment.text) continue
    const previous = result[result.length - 1]
    if (previous?.type === 'text') {
      previous.text += segment.text
    } else {
      result.push({ type: 'text', text: segment.text })
    }
  }
  return result.length > 0 ? result : [{ type: 'text', text: '' }]
}

function segmentLength(segment: CommentInputSegment): number {
  return segment.type === 'mention' ? mentionTokenText(segment.candidate).length : segment.text.length
}

function replaceSegmentRange(
  segments: CommentInputSegment[],
  start: number,
  end: number,
  replacement: CommentInputSegment[],
): CommentInputSegment[] {
  const next: CommentInputSegment[] = []
  let offset = 0
  let inserted = false

  for (const segment of segments) {
    const length = segmentLength(segment)
    const segmentStart = offset
    const segmentEnd = offset + length

    if (segmentEnd <= start || segmentStart >= end) {
      if (!inserted && segmentStart >= end) {
        next.push(...replacement)
        inserted = true
      }
      next.push(segment)
      offset = segmentEnd
      continue
    }

    if (segment.type === 'text') {
      const beforeLength = Math.max(0, start - segmentStart)
      const afterStart = Math.max(0, end - segmentStart)
      const before = segment.text.slice(0, beforeLength)
      const after = segment.text.slice(afterStart)
      if (before) next.push({ type: 'text', text: before })
      if (!inserted) {
        next.push(...replacement)
        inserted = true
      }
      if (after) next.push({ type: 'text', text: after })
    } else if (!inserted) {
      next.push(...replacement)
      inserted = true
    }

    offset = segmentEnd
  }

  if (!inserted) next.push(...replacement)
  return normalizeTextSegments(next)
}

function clampCommentSegments(segments: CommentInputSegment[], maxLength: number): CommentInputSegment[] {
  if (maxLength <= 0) return [{ type: 'text', text: '' }]
  const next: CommentInputSegment[] = []
  let remaining = maxLength

  for (const segment of segments) {
    if (remaining <= 0) break
    const length = segmentLength(segment)
    if (length <= remaining) {
      next.push(segment)
      remaining -= length
      continue
    }
    if (segment.type === 'text') {
      next.push({ type: 'text', text: segment.text.slice(0, remaining) })
    }
    break
  }

  return normalizeTextSegments(next)
}

function candidateFromMentionElement(element: HTMLElement): DocumentCommentMentionCandidate | null {
  const userId = element.dataset.mentionUserId
  const displayName = element.dataset.mentionDisplayName
  if (!userId || !displayName) return null
  return {
    userId,
    displayName,
    accountName: element.dataset.mentionAccountName || null,
    avatar: element.dataset.mentionAvatar || null,
  }
}

function findMentionElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  return target.closest<HTMLElement>('[data-mention-user-id]')
}

function MentionUserCard({
  state,
  cardRef,
  onClose,
}: {
  state: MentionCardState
  cardRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
}) {
  const displayName = mentionDisplayName(state.candidate)
  const accountName = mentionAccountName(state.candidate)
  const [position, setPosition] = useState<MentionCardPosition>(() => (
    getMentionCardPosition(state.anchorRect, MENTION_CARD_HEIGHT_PX)
  ))

  useLayoutEffect(() => {
    setPosition(getMentionCardPosition(state.anchorRect, cardRef.current?.offsetHeight || MENTION_CARD_HEIGHT_PX))
  }, [cardRef, state.anchorRect])

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`${displayName} 的用户信息`}
      className="fixed z-dropdown w-80 overflow-hidden rounded-xl border border-border bg-background p-4 shadow-lg"
      style={{ top: position.top, left: position.left, maxHeight: position.maxHeight }}
    >
      <div className="flex items-start gap-4">
        <span aria-hidden="true">
          <UserAvatar
            name={displayName}
            avatarUrl={state.candidate.avatar}
            seed={state.candidate.userId}
            size={56}
            className="border border-primary/20"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-title font-semibold text-foreground">{displayName}</div>
          <div className="mt-1 whitespace-normal break-all text-body leading-snug text-muted-foreground">
            @{accountName}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="关闭用户信息卡"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </div>
  )
}

/**
 * Chromium 清空 contentEditable 时常残留单个 <br>（或零宽字符），
 * 若按字面解析会变成 "\n" / "\u200B"：字数显示 1，且 :empty placeholder 失效。
 */
function isContentEditableCaretEmpty(serialized: string): boolean {
  return serialized === '' || serialized === '\n' || serialized === '\u200B'
}

function parseEditorSegments(root: HTMLElement): CommentInputSegment[] {
  const segments: CommentInputSegment[] = []

  const visit = (node: ChildNode) => {
    if (node.nodeType === Node.TEXT_NODE) {
      segments.push({ type: 'text', text: node.textContent ?? '' })
      return
    }
    if (!(node instanceof HTMLElement)) return
    const candidate = node.dataset.mentionUserId ? candidateFromMentionElement(node) : null
    if (candidate) {
      segments.push({ type: 'mention', candidate })
      return
    }
    if (node.tagName === 'BR') {
      segments.push({ type: 'text', text: '\n' })
      return
    }
    node.childNodes.forEach(visit)
  }

  root.childNodes.forEach(visit)
  const normalized = normalizeTextSegments(segments)
  if (isContentEditableCaretEmpty(serializeCommentSegments(normalized))) {
    return [{ type: 'text', text: '' }]
  }
  return normalized
}

function getEditorCaretOffset(root: HTMLElement): number | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.endContainer)) return null
  const before = range.cloneRange()
  before.selectNodeContents(root)
  before.setEnd(range.endContainer, range.endOffset)
  return before.toString().length
}

function setEditorCaretOffset(root: HTMLElement, offset: number) {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  let remaining = offset
  let placed = false

  const visit = (node: ChildNode) => {
    if (placed) return
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      if (remaining <= text.length) {
        range.setStart(node, remaining)
        placed = true
        return
      }
      remaining -= text.length
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.mentionUserId) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        range.setStartAfter(node)
        placed = true
        return
      }
      remaining -= length
      return
    }
    node.childNodes.forEach(visit)
  }

  root.childNodes.forEach(visit)
  if (!placed) range.selectNodeContents(root)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function CommentsSection({
  comments,
  total,
  value,
  onValueChange,
  onSubmit,
  mentionCandidates = [],
  onMentionSelect,
  onMentionSearch,
  currentUserId = null,
  deletingCommentIds = [],
  onDeleteComment,
  statusFilter,
  onStatusFilterChange,
  updatingThreadIds = [],
  onResolveThread,
  onReopenThread,
  onRetry,
  isLoading = false,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  isSubmitting = false,
  error = null,
  highlightedCommentId = null,
  maxLength = DEFAULT_MAX_COMMENT_LENGTH,
  labels,
  locale,
  className,
  readOnly = false,
  layout = 'inline',
  autoFocus = false,
}: CommentsSectionProps) {
  const title = labels?.title ?? '全文评论'
  const placeholder = labels?.placeholder ?? '输入评论'
  const submitLabel = labels?.submit ?? '发送评论'
  const deleteCommentLabel = labels?.deleteComment ?? '删除'
  const deletingCommentLabel = labels?.deletingComment ?? '正在删除...'
  const retryLabel = labels?.retry ?? '重试'
  const loadingLabel = labels?.loading ?? '正在加载评论...'
  const unknownUserLabel = labels?.unknownUser ?? '用户'
  const noMentionResultsLabel = labels?.noMentionResults ?? '没有匹配的成员'
  const loadMoreLabel = labels?.loadMore ?? '加载更早评论'
  const loadingMoreLabel = labels?.loadingMore ?? '正在加载...'
  const replyLabel = labels?.reply ?? '回复'
  const replyingToLabel = labels?.replyingTo ?? '回复'
  const cancelReplyLabel = labels?.cancelReply ?? '取消回复'
  const deletedCommentLabel = labels?.deletedComment ?? '原评论已删除'
  const filterOpenLabel = labels?.filterOpen ?? '未解决'
  const filterResolvedLabel = labels?.filterResolved ?? '已解决'
  const filterAllLabel = labels?.filterAll ?? '全部'
  const resolveThreadLabel = labels?.resolveThread ?? '标记已解决'
  const reopenThreadLabel = labels?.reopenThread ?? '重新打开'
  const updatingThreadLabel = labels?.updatingThread ?? '正在更新...'
  const emptyLabel = labels?.empty ?? '暂无评论'
  const countUnitLabel = labels?.countUnit ?? '条线程'
  const trimmedValue = value.trim()
  const hasComments = comments.length > 0
  const isSidePanel = layout === 'side-panel'
  const canSubmit = trimmedValue.length > 0 && trimmedValue.length <= maxLength && !isSubmitting
  const editorRef = useRef<HTMLDivElement>(null)
  const mentionCardRef = useRef<HTMLDivElement>(null)
  const highlightedCommentRef = useRef<HTMLElement>(null)
  const isComposingRef = useRef(false)
  const dismissedMentionStartIndexRef = useRef<number | null>(null)
  const [segments, setSegments] = useState<CommentInputSegment[]>([{ type: 'text', text: value }])
  const [hasCompositionText, setHasCompositionText] = useState(false)
  const [mentionState, setMentionState] = useState<MentionState | null>(null)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [mentionCard, setMentionCard] = useState<MentionCardState | null>(null)
  const [deleteConfirmComment, setDeleteConfirmComment] = useState<DocumentCommentItem | null>(null)
  const [replyTarget, setReplyTarget] = useState<DocumentCommentItem | null>(null)
  const showPlaceholder = value.length === 0 && !hasCompositionText

  useLayoutEffect(() => {
    // contentEditable 先于 React input 回调改写 DOM；即使 clamp 后 HTML 未变，
    // 每次 segment 提交仍需检查并纠正浏览器留下的超额内容。
    const editor = editorRef.current
    const editorHtml = segmentsToHtml(segments)
    if (!editor || editor.innerHTML === editorHtml) return

    const caretOffset = document.activeElement === editor
      ? getEditorCaretOffset(editor)
      : null
    editor.innerHTML = editorHtml
    if (caretOffset !== null) setEditorCaretOffset(editor, caretOffset)
  }, [segments])

  useEffect(() => {
    if (!autoFocus || readOnly) return undefined
    const frame = requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [autoFocus, readOnly])

  const submitComment = useCallback(async () => {
    const mentionUserIds = extractMentionUserIdsFromSegments(segments)
    if (replyTarget) await onSubmit(mentionUserIds, replyTarget.id)
    else await onSubmit(mentionUserIds)
    setReplyTarget(null)
  }, [onSubmit, replyTarget, segments])

  const startReply = useCallback((comment: DocumentCommentItem) => {
    setReplyTarget(comment)
    requestAnimationFrame(() => editorRef.current?.focus())
  }, [])

  useEffect(() => {
    if (replyTarget && !comments.some((comment) => comment.id === replyTarget.id)) {
      setReplyTarget(null)
    }
  }, [comments, replyTarget])

  const mentionCandidateById = useMemo(() => {
    const map = new Map<string, DocumentCommentMentionCandidate>()
    mentionCandidates.forEach((candidate) => {
      if (candidate.userId) map.set(candidate.userId, candidate)
    })
    return map
  }, [mentionCandidates])

  const closeMentionCard = useCallback(() => {
    setMentionCard(null)
  }, [])

  const closeDeleteConfirm = useCallback(() => {
    setDeleteConfirmComment(null)
  }, [])

  const openMentionCard = useCallback((
    candidate: DocumentCommentMentionCandidate,
    target: HTMLElement,
  ) => {
    const knownCandidate = mentionCandidateById.get(candidate.userId)
    const cardCandidate = knownCandidate
      ? {
          ...candidate,
          ...knownCandidate,
          accountName: knownCandidate.accountName ?? candidate.accountName,
          avatar: knownCandidate.avatar ?? candidate.avatar,
        }
      : candidate
    setMentionCard({
      candidate: cardCandidate,
      anchorRect: target.getBoundingClientRect(),
    })
  }, [mentionCandidateById])

  const confirmDeleteComment = useCallback(async () => {
    if (!deleteConfirmComment) return
    await onDeleteComment?.(deleteConfirmComment.id)
  }, [deleteConfirmComment, onDeleteComment])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const handleNativeKeyDown = (event: globalThis.KeyboardEvent) => {
      const element = findMentionElement(event.target)
      if (element && (event.key === 'Enter' || event.key === ' ')) {
        const candidate = candidateFromMentionElement(element)
        if (!candidate) return
        event.preventDefault()
        event.stopPropagation()
        openMentionCard(candidate, element)
        return
      }
      if (event.key === 'Escape') closeMentionCard()
    }

    editor.addEventListener('keydown', handleNativeKeyDown)
    return () => {
      editor.removeEventListener('keydown', handleNativeKeyDown)
    }
  }, [closeMentionCard, openMentionCard])

  const filteredMentionCandidates = useMemo(() => {
    if (!mentionState || mentionCandidates.length === 0) return []
    const query = mentionState.query.trim().toLowerCase()
    return mentionCandidates
      .filter((candidate) => {
        if (!candidate.userId) return false
        if (!query) return true
        return mentionSearchText(candidate).includes(query)
      })
      .slice(0, MAX_MENTION_RESULTS)
  }, [mentionCandidates, mentionState])

  useEffect(() => {
    if (!mentionState || !onMentionSearch) return undefined
    const query = mentionState.query.trim()
    const timer = window.setTimeout(() => {
      runCommentAction(() => onMentionSearch(query))
    }, MENTION_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [mentionState?.query, onMentionSearch])

  useEffect(() => {
    if (!highlightedCommentId) return
    highlightedCommentRef.current?.scrollIntoView?.({ block: 'center' })
  }, [comments, highlightedCommentId])

  useEffect(() => {
    setActiveMentionIndex(0)
  }, [mentionState?.query])

  useEffect(() => {
    if (!mentionCard) return
    const handlePointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target
      if (mentionCardRef.current && target instanceof Node && mentionCardRef.current.contains(target)) return
      if (findMentionElement(target)) return
      closeMentionCard()
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeMentionCard()
    }
    const handleViewportMove = () => {
      closeMentionCard()
    }
    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('scroll', handleViewportMove, true)
    window.addEventListener('resize', handleViewportMove)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('scroll', handleViewportMove, true)
      window.removeEventListener('resize', handleViewportMove)
    }
  }, [closeMentionCard, mentionCard])

  useEffect(() => {
    if (isComposingRef.current) return
    if (!value) {
      dismissedMentionStartIndexRef.current = null
      setMentionState(null)
    }
    const serialized = serializeCommentSegments(segments)
    if (serialized === value) return
    if (!value || document.activeElement !== editorRef.current) {
      setSegments([{ type: 'text', text: value }])
    }
  }, [segments, value])

  const closeMentionSelector = (options?: { suppressCurrentQuery?: boolean }) => {
    if (options?.suppressCurrentQuery && mentionState) {
      dismissedMentionStartIndexRef.current = mentionState.startIndex
    }
    setMentionState(null)
  }

  const updateMentionState = (nextValue: string, cursorPosition: number | null) => {
    if (cursorPosition === null) {
      dismissedMentionStartIndexRef.current = null
      setMentionState(null)
      return
    }
    const textBeforeCursor = nextValue.slice(0, cursorPosition)
    const match = textBeforeCursor.match(MENTION_QUERY_RE)
    if (!match) {
      dismissedMentionStartIndexRef.current = null
      setMentionState(null)
      return
    }
    const startIndex = cursorPosition - match[0].length
    if (dismissedMentionStartIndexRef.current === startIndex) {
      setMentionState(null)
      return
    }
    dismissedMentionStartIndexRef.current = null
    setMentionState({
      query: match[1] ?? '',
      startIndex,
    })
  }

  const commitSegments = (nextSegments: CommentInputSegment[], cursorPosition: number | null) => {
    const normalized = clampCommentSegments(nextSegments, maxLength)
    const nextValue = serializeCommentSegments(normalized)
    setSegments(normalized)
    onValueChange(nextValue)
    updateMentionState(nextValue, cursorPosition)
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor || cursorPosition === null) return
      setEditorCaretOffset(editor, cursorPosition)
    })
  }

  const handleEditorInput = (event: FormEvent<HTMLDivElement>) => {
    const root = event.currentTarget
    if (isComposingRef.current) {
      setHasCompositionText(!isContentEditableCaretEmpty(root.textContent ?? ''))
      return
    }
    const nextSegments = parseEditorSegments(root)
    const nextValue = serializeCommentSegments(nextSegments)
    // 清掉残留 <br>，否则 React 从 ""→"" 时可能不刷 DOM，placeholder 仍不出来
    if (nextValue === '' && root.innerHTML !== '') {
      root.innerHTML = ''
    }
    commitSegments(nextSegments, nextValue === '' ? 0 : getEditorCaretOffset(root))
  }

  const handleEditorBlur = () => {
    closeMentionSelector({ suppressCurrentQuery: true })
  }

  const handleEditorMentionOpen = (event: MouseEvent<HTMLDivElement>) => {
    const element = findMentionElement(event.target)
    const candidate = element ? candidateFromMentionElement(element) : null
    if (!element || !candidate) return
    event.preventDefault()
    event.stopPropagation()
    openMentionCard(candidate, element)
  }

  const handleCompositionStart = () => {
    isComposingRef.current = true
    setHasCompositionText(false)
  }

  const handleCompositionEnd = (event: CompositionEvent<HTMLDivElement>) => {
    isComposingRef.current = false
    setHasCompositionText(false)
    const root = event.currentTarget
    const nextSegments = parseEditorSegments(root)
    const nextValue = serializeCommentSegments(nextSegments)
    if (nextValue === '' && root.innerHTML !== '') {
      root.innerHTML = ''
    }
    commitSegments(nextSegments, nextValue === '' ? 0 : getEditorCaretOffset(root))
  }

  const selectMentionCandidate = (candidate: DocumentCommentMentionCandidate) => {
    if (!mentionState) return
    const displayName = mentionDisplayName(candidate)
    const before = value.slice(0, mentionState.startIndex)
    const replacement: CommentInputSegment[] = [
      { type: 'mention', candidate: { ...candidate, displayName } },
      { type: 'text', text: ' ' },
    ]
    const nextSegments = clampCommentSegments(
      replaceSegmentRange(
        segments,
        mentionState.startIndex,
        mentionState.startIndex + 1 + mentionState.query.length,
        replacement,
      ),
      maxLength,
    )
    const nextValue = serializeCommentSegments(nextSegments)
    setSegments(nextSegments)
    onValueChange(nextValue)
    onMentionSelect?.(candidate)
    dismissedMentionStartIndexRef.current = null
    setMentionState(null)
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      setEditorCaretOffset(editor, before.length + mentionTokenText(candidate).length + 1)
    })
  }

  const removeMentionBeforeCaret = (caretOffset: number): boolean => {
    let offset = 0
    let previousMention: { start: number, end: number } | null = null
    for (const segment of segments) {
      const length = segmentLength(segment)
      const start = offset
      const end = offset + length
      if (segment.type === 'mention' && end === caretOffset) {
        const nextSegments = replaceSegmentRange(segments, offset, end, [])
        setSegments(nextSegments)
        onValueChange(serializeCommentSegments(nextSegments))
        requestAnimationFrame(() => {
          const editor = editorRef.current
          if (!editor) return
          editor.focus()
          setEditorCaretOffset(editor, offset)
        })
        return true
      }
      if (segment.type === 'mention') {
        previousMention = { start, end }
      } else if (
        previousMention?.end === start
        && caretOffset > start
        && caretOffset <= end
        && segment.text.slice(0, caretOffset - start).trim() === ''
      ) {
        const removeStart = previousMention.start
        const nextSegments = replaceSegmentRange(segments, removeStart, caretOffset, [])
        setSegments(nextSegments)
        onValueChange(serializeCommentSegments(nextSegments))
        requestAnimationFrame(() => {
          const editor = editorRef.current
          if (!editor) return
          editor.focus()
          setEditorCaretOffset(editor, removeStart)
        })
        return true
      }
      offset = end
    }
    return false
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mentionElement = findMentionElement(event.target)
    if (mentionElement && (event.key === 'Enter' || event.key === ' ')) {
      const candidate = candidateFromMentionElement(mentionElement)
      if (candidate) {
        event.preventDefault()
        event.stopPropagation()
        openMentionCard(candidate, mentionElement)
        return
      }
    }
    if (mentionCard && event.key === 'Escape') {
      event.preventDefault()
      closeMentionCard()
      return
    }
    if (mentionState) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMentionSelector({ suppressCurrentQuery: true })
        return
      }
      if (filteredMentionCandidates.length > 0) {
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveMentionIndex((current) => (current <= 0 ? filteredMentionCandidates.length - 1 : current - 1))
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActiveMentionIndex((current) => (current >= filteredMentionCandidates.length - 1 ? 0 : current + 1))
          return
        }
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          selectMentionCandidate(filteredMentionCandidates[activeMentionIndex])
          return
        }
      }
    }
    if (event.key === 'Backspace') {
      const editor = editorRef.current
      const selection = window.getSelection()
      if (editor && selection?.isCollapsed) {
        const caretOffset = getEditorCaretOffset(editor)
        if (caretOffset !== null && removeMentionBeforeCaret(caretOffset)) {
          event.preventDefault()
          return
        }
      }
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.shiftKey) return
    event.preventDefault()
    if (canSubmit) {
      runCommentAction(submitComment)
    }
  }

  return (
    <section
      aria-label={isSidePanel ? title : undefined}
      className={
        className
        ?? (isSidePanel
          ? 'flex h-full min-h-0 flex-col bg-background'
          : hasComments
            ? 'mt-10 border-t border-border pb-10 pt-5'
            : 'mt-8 pb-10')
      }
    >
      {mentionCard ? (
        <MentionUserCard
          state={mentionCard}
          cardRef={mentionCardRef}
          onClose={closeMentionCard}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(deleteConfirmComment)}
        onOpenChange={(open) => {
          if (!open) closeDeleteConfirm()
        }}
        title={DELETE_COMMENT_CONFIRM_TITLE}
        description={DELETE_COMMENT_CONFIRM_DESCRIPTION}
        confirmText={DELETE_COMMENT_CONFIRM_TEXT}
        cancelText={DELETE_COMMENT_CANCEL_TEXT}
        variant="destructive"
        isLoading={Boolean(deleteConfirmComment && deletingCommentIds.includes(deleteConfirmComment.id))}
        onConfirm={confirmDeleteComment}
      />
      {hasComments || isSidePanel ? (
        <div className={isSidePanel ? 'flex min-h-0 flex-1 flex-col' : 'mb-5'}>
          <div className={isSidePanel ? 'shrink-0 border-b border-border/40 px-4 py-3' : 'mb-4'}>
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-title font-semibold text-foreground">{title}</h2>
              <div className="rounded-full bg-muted px-3 py-1 text-caption text-muted-foreground">
                {total ?? comments.length} {countUnitLabel}
              </div>
            </div>
            {statusFilter && onStatusFilterChange ? (
              <div className="mt-3 flex gap-1" role="tablist" aria-label={title}>
                {([
                  ['open', filterOpenLabel],
                  ['resolved', filterResolvedLabel],
                  ['all', filterAllLabel],
                ] as const).map(([status, label]) => (
                  <Button
                    key={status}
                    type="button"
                    role="tab"
                    aria-selected={statusFilter === status}
                    variant={statusFilter === status ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-7 px-2.5 text-caption"
                    onClick={() => onStatusFilterChange(status)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>

          <div className={isSidePanel ? 'min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3' : 'space-y-4'}>
            {hasMore && onLoadMore ? (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isLoadingMore}
                  onClick={() => runCommentAction(onLoadMore)}
                >
                  {isLoadingMore ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                  {isLoadingMore ? loadingMoreLabel : loadMoreLabel}
                </Button>
              </div>
            ) : null}
            {isSidePanel && isLoading && !hasComments ? (
              <div
                role="status"
                aria-label={loadingLabel}
                className="flex min-h-24 items-center justify-center gap-2 text-body text-muted-foreground"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>{loadingLabel}</span>
              </div>
            ) : null}
            {!isLoading && !hasComments ? (
              <div className="flex min-h-24 items-center justify-center text-body text-muted-foreground">
                {emptyLabel}
              </div>
            ) : null}
            {comments.map((comment) => {
              const authorDisplayName = commentAuthorDisplayName(comment, unknownUserLabel)
              const authorCandidate = commentAuthorCandidate(comment, unknownUserLabel)
              const isOwnComment = Boolean(currentUserId && comment.author_user_id && comment.author_user_id === currentUserId)
              const canDeleteComment = !readOnly
                && !comment.is_deleted
                && (comment.can_delete ?? isOwnComment)
                && Boolean(onDeleteComment)
              const isDeletingComment = deletingCommentIds.includes(comment.id)
              const threadId = comment.thread_id ?? comment.id
              const isThreadRoot = threadId === comment.id
              const isUpdatingThread = updatingThreadIds.includes(threadId)
              const statusAction = !readOnly && isThreadRoot
                ? comment.thread_status === 'resolved' && comment.can_reopen && onReopenThread
                  ? { label: reopenThreadLabel, action: onReopenThread }
                  : comment.thread_status !== 'resolved' && comment.can_resolve && onResolveThread
                    ? { label: resolveThreadLabel, action: onResolveThread }
                    : null
                : null
              const authorAvatar = (
                <span aria-hidden="true">
                  <UserAvatar
                    name={authorDisplayName}
                    avatarUrl={comment.author_avatar}
                    seed={comment.author_user_id}
                    size={36}
                  />
                </span>
              )

              return (
                <article
                  key={comment.id}
                  ref={comment.id === highlightedCommentId ? highlightedCommentRef : undefined}
                  data-comment-id={comment.id}
                  data-highlighted={comment.id === highlightedCommentId ? 'true' : undefined}
                  className={`flex gap-3 rounded-md px-1 py-2 transition-colors ${
                    comment.id === highlightedCommentId
                      ? 'bg-accent/10 ring-1 ring-inset ring-primary/30'
                      : ''
                  }`}
                >
                  {authorCandidate ? (
                    <button
                      type="button"
                      className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border-0 bg-transparent p-0 transition hover:ring-2 hover:ring-primary/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      aria-label={`查看评论作者 ${authorDisplayName} 的用户信息`}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        openMentionCard(authorCandidate, event.currentTarget)
                      }}
                    >
                      {authorAvatar}
                    </button>
                  ) : (
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full">
                      {authorAvatar}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-body font-medium text-foreground">{authorDisplayName}</span>
                        {comment.author_type === 'agent' ? (
                          <Badge
                            variant="secondary"
                            className="shrink-0 px-1.5 py-0 font-normal"
                            title={[
                              comment.authorization_subject_name
                                ? `授权用户：${comment.authorization_subject_name}`
                                : '',
                              comment.agent_run_id ? `Run：${comment.agent_run_id}` : '',
                            ].filter(Boolean).join('\n') || 'Agent'}
                          >
                            Agent
                          </Badge>
                        ) : null}
                        {comment.created_at ? (
                          <span className="text-caption text-muted-foreground/60">{formatCommentTime(comment.created_at, locale)}</span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {statusAction ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 shrink-0 px-2 text-caption text-muted-foreground"
                            disabled={isUpdatingThread}
                            onClick={() => runCommentAction(() => statusAction.action(threadId))}
                          >
                            {isUpdatingThread ? updatingThreadLabel : statusAction.label}
                          </Button>
                        ) : null}
                        {!readOnly && !comment.is_deleted ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 shrink-0 px-2 text-caption text-muted-foreground"
                            aria-label={`${replyLabel} ${authorDisplayName} 的评论`}
                            onClick={() => startReply(comment)}
                          >
                            {replyLabel}
                          </Button>
                        ) : null}
                        {canDeleteComment ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 shrink-0 px-2 text-caption text-destructive hover:text-destructive"
                            disabled={isDeletingComment}
                            aria-label={`${deleteCommentLabel} ${authorDisplayName} 的评论`}
                            onClick={() => setDeleteConfirmComment(comment)}
                          >
                            {isDeletingComment ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" /> : null}
                            {isDeletingComment ? deletingCommentLabel : deleteCommentLabel}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {comment.selected_text ? (
                      <blockquote className="mt-2 border-l-2 border-primary/40 pl-2 text-caption text-muted-foreground">
                        {comment.selected_text}
                      </blockquote>
                    ) : null}
                    {comment.reply_to ? (
                      <div className="mt-2 rounded-md border-l-2 border-border bg-muted/60 px-2 py-1.5 text-caption text-muted-foreground">
                        <span className="font-medium text-foreground/80">{comment.reply_to.author_name}</span>
                        <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words">
                          {comment.reply_to.is_deleted ? deletedCommentLabel : comment.reply_to.body}
                        </p>
                      </div>
                    ) : null}
                    <p className={`mt-1 whitespace-pre-wrap break-words text-body leading-relaxed ${comment.is_deleted ? 'italic text-muted-foreground' : 'text-foreground'}`}>
                      {comment.is_deleted
                        ? deletedCommentLabel
                        : renderCommentBody(
                            comment.body,
                            comment.mention_user_ids,
                            mentionCandidateById,
                            mentionCandidates,
                            openMentionCard,
                          )}
                    </p>
                  </div>
                </article>
              )
            })}
          </div>
        </div>
      ) : null}

      {error && (hasComments || isSidePanel) ? (
        <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-md bg-destructive/10 px-3 py-2">
          <span className="text-caption text-destructive">{error}</span>
          {onRetry ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => runCommentAction(onRetry)}>
              {retryLabel}
            </Button>
          ) : null}
        </div>
      ) : null}

      {!readOnly ? <div className={isSidePanel ? 'relative shrink-0 border-t border-border/40 px-4 py-3 group/comment-input' : 'relative group/comment-input'}>
        {replyTarget ? (
          <div className="mb-2 flex items-start justify-between gap-3 rounded-md bg-muted px-3 py-2 text-caption text-muted-foreground">
            <div className="min-w-0">
              <div>{replyingToLabel} <span className="font-medium text-foreground">{replyTarget.author_name}</span></div>
              <div className="mt-0.5 truncate">{replyTarget.body}</div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2"
              aria-label={cancelReplyLabel}
              onClick={() => setReplyTarget(null)}
            >
              {cancelReplyLabel}
            </Button>
          </div>
        ) : null}
        {mentionState ? (
          <div
            role="listbox"
            aria-label="选择提及成员"
            className="absolute bottom-full left-0 z-dropdown mb-2 max-h-52 w-64 overflow-y-auto rounded-lg border border-border bg-background py-1 shadow-md"
          >
            {filteredMentionCandidates.length === 0 ? (
              <div className="px-3 py-2 text-body text-muted-foreground">{noMentionResultsLabel}</div>
            ) : (
              filteredMentionCandidates.map((candidate, index) => {
                const displayName = mentionDisplayName(candidate)
                const isActive = index === activeMentionIndex
                return (
                  <button
                    key={candidate.userId}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-body transition-colors ${
                      isActive ? 'bg-accent/10 text-foreground' : 'text-foreground/80 hover:bg-muted/30'
                    }`}
                    onMouseEnter={() => setActiveMentionIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      selectMentionCandidate(candidate)
                    }}
                  >
                    <span aria-hidden="true">
                      <UserAvatar
                        name={displayName}
                        avatarUrl={candidate.avatar}
                        seed={candidate.userId}
                        size={24}
                        className="border border-border/30"
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{displayName}</span>
                  </button>
                )
              })
            )}
          </div>
        ) : null}
        <div className="relative">
          <div
            className="flex min-h-11 min-w-0 max-w-full rounded-interactive bg-muted px-3 py-2 pr-12 text-body text-foreground focus-within:bg-background focus-within:ring-1 focus-within:ring-inset focus-within:ring-primary/50"
            onClick={() => editorRef.current?.focus()}
          >
            <div
              ref={editorRef}
              role="textbox"
              aria-label={placeholder}
              contentEditable={!isSubmitting}
              suppressContentEditableWarning
              className={`min-w-0 flex-1 whitespace-pre-wrap break-words leading-[1.65] outline-none${
                isSidePanel ? ' max-h-40 overflow-y-auto overscroll-contain' : ''
              }${
                showPlaceholder
                  ? ' before:pointer-events-none before:text-muted-foreground before:content-[attr(data-placeholder)]'
                  : ''
              }`}
              data-placeholder={placeholder}
              data-empty={showPlaceholder ? 'true' : undefined}
              onInput={handleEditorInput}
              onBlur={handleEditorBlur}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onClick={handleEditorMentionOpen}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="absolute inset-y-0 right-2 flex items-center gap-1">
            {isLoading && hasComments ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground/60" aria-label={loadingLabel} /> : null}
            {trimmedValue ? (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => runCommentAction(submitComment)}
                disabled={!canSubmit}
                aria-label={submitLabel}
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            ) : null}
          </div>
        </div>
        <div
          className="mt-1 hidden text-right text-caption tabular-nums text-muted-foreground group-focus-within/comment-input:block"
          aria-live="polite"
          data-testid="comment-char-count"
        >
          {value.length} / {maxLength}
        </div>
      </div> : null}
    </section>
  )
}
