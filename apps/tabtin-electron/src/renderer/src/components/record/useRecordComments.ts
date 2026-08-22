import * as React from 'react'
import {
  RecordCommentApiService,
  type CreateRecordCommentRequest,
  type CreateRecordCommentResponse,
  type DeleteRecordCommentResponse,
  type RecordComment,
  type RecordCommentListParams,
  type RecordCommentListResponse,
  type RecordCommentMentionCandidate,
  type RecordCommentStatus,
  type RecordCommentStatusFilter,
  type UpdateRecordCommentThreadStatusResponse,
} from '@tabtin/table-core'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'

const log = createLogger('RecordComments')
const MENTION_CANDIDATE_LIMIT = 200

export interface RecordCommentsGateway {
  listComments: (
    recordId: string,
    params?: RecordCommentListParams,
  ) => Promise<RecordCommentListResponse>
  createComment: (
    recordId: string,
    data: CreateRecordCommentRequest,
  ) => Promise<CreateRecordCommentResponse>
  deleteComment: (
    recordId: string,
    commentId: string,
  ) => Promise<DeleteRecordCommentResponse>
  updateThreadStatus: (
    recordId: string,
    threadId: string,
    status: RecordCommentStatus,
  ) => Promise<UpdateRecordCommentThreadStatusResponse>
  listMentionCandidates: (
    recordId: string,
    search?: string,
    limit?: number,
  ) => Promise<RecordCommentMentionCandidate[]>
}

export interface UseRecordCommentsOptions {
  recordId?: string
  anchorCommentId?: string
  enabled: boolean
  gateway?: RecordCommentsGateway
  requestIdFactory?: () => string
}

interface CommentSnapshot {
  recordId: string
  comments: RecordComment[]
  total: number
  threadTotal: number
  openThreadTotal: number
  hasMore: boolean
  nextCursor: string | null
}

interface PendingSubmit {
  recordId: string
  content: string
  mentionUserIds: string[]
  clientRequestId: string
  replyToCommentId?: string
}

interface StatusFilterState {
  recordId?: string
  anchorCommentId?: string
  value: RecordCommentStatusFilter
}

const sameMentionUserIds = (left: string[], right: string[]): boolean => (
  left.length === right.length && left.every((userId, index) => userId === right[index])
)

const matchesPendingSubmit = (
  pending: PendingSubmit | null,
  recordId: string,
  content: string,
  mentionUserIds: string[],
  replyToCommentId?: string,
): pending is PendingSubmit => Boolean(
  pending
  && pending.recordId === recordId
  && pending.content === content
  && sameMentionUserIds(pending.mentionUserIds, mentionUserIds)
  && pending.replyToCommentId === replyToCommentId
)

const EMPTY_SNAPSHOT: CommentSnapshot = {
  recordId: '',
  comments: [],
  total: 0,
  threadTotal: 0,
  openThreadTotal: 0,
  hasMore: false,
  nextCursor: null,
}

const defaultRequestId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `comment-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const NETWORK_ERROR_CODE_PATTERN = /^(?:NETWORK_ERROR|ERR_NETWORK|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETDOWN|ENETUNREACH|EHOSTUNREACH|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET))$/i
const NETWORK_ERROR_MESSAGE_PATTERN = /\b(?:network error|network request failed|failed to fetch|fetch failed|request timed out|request timeout|socket hang up|internet disconnected)\b|网络(?:连接)?(?:失败|错误|中断)|请求超时/i
const RECOVERABLE_SUBMIT_FAILED_KEY = 'comments.recoverableSubmitFailed'
const RECOVERABLE_SUBMIT_FAILED_FALLBACK = '网络连接失败或请求超时，评论未发送，草稿已保留。请检查网络后重试。'

const errorDetails = (error: unknown): Record<string, unknown> => (
  error !== null && typeof error === 'object' ? error as Record<string, unknown> : {}
)

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  const message = errorDetails(error).message
  return typeof message === 'string' && message ? message : '评论请求失败'
}

const isRecoverableNetworkError = (error: unknown): boolean => {
  const details = errorDetails(error)
  const status = details.status ?? details.statusCode
  if (typeof status === 'number') return false

  const code = typeof details.code === 'string' ? details.code : ''
  return NETWORK_ERROR_CODE_PATTERN.test(code)
    || NETWORK_ERROR_MESSAGE_PATTERN.test(errorMessage(error))
}

const recoverableSubmitFailedMessage = (): string => {
  const translated = String(i18n.t(RECOVERABLE_SUBMIT_FAILED_KEY, {
    ns: 'record',
    defaultValue: RECOVERABLE_SUBMIT_FAILED_FALLBACK,
  }))
  return translated === RECOVERABLE_SUBMIT_FAILED_KEY
    || translated === `record:${RECOVERABLE_SUBMIT_FAILED_KEY}`
    ? RECOVERABLE_SUBMIT_FAILED_FALLBACK
    : translated
}

const submitErrorMessage = (error: unknown, recordId: string): string => {
  const recoverableNetworkError = isRecoverableNetworkError(error)
  const details = errorDetails(error)
  const diagnostic = {
    recordId,
    code: typeof details.code === 'string' ? details.code : undefined,
    recoverableNetworkError,
    message: errorMessage(error),
  }
  if (recoverableNetworkError) {
    log.warn('评论发送遇到可恢复的网络错误，草稿已保留', diagnostic)
    return recoverableSubmitFailedMessage()
  }

  log.error('评论发送失败，草稿已保留', diagnostic)
  return errorMessage(error)
}

export function useRecordComments({
  recordId,
  anchorCommentId,
  enabled,
  gateway = RecordCommentApiService,
  requestIdFactory = defaultRequestId,
}: UseRecordCommentsOptions) {
  const [snapshot, setSnapshot] = React.useState<CommentSnapshot>(EMPTY_SNAPSHOT)
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [mentionCandidates, setMentionCandidates] = React.useState<RecordCommentMentionCandidate[]>([])
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [deletingCommentIds, setDeletingCommentIds] = React.useState<string[]>([])
  const [updatingThreadIds, setUpdatingThreadIds] = React.useState<string[]>([])
  const [statusFilterState, setStatusFilterState] = React.useState<StatusFilterState>(() => ({
    recordId,
    anchorCommentId,
    value: anchorCommentId ? 'all' : 'open',
  }))
  const defaultStatusFilter = anchorCommentId ? 'all' : 'open'
  const statusFilter = (
    statusFilterState.recordId === recordId
    && statusFilterState.anchorCommentId === anchorCommentId
  )
    ? statusFilterState.value
    : defaultStatusFilter
  const setStatusFilter = React.useCallback((value: RecordCommentStatusFilter) => {
    setStatusFilterState({ recordId, anchorCommentId, value })
  }, [anchorCommentId, recordId])
  const [error, setError] = React.useState<string | null>(null)
  const requestEpochRef = React.useRef(0)
  const candidateRequestEpochRef = React.useRef(0)
  const activeRecordIdRef = React.useRef(recordId)
  const pendingSubmitRef = React.useRef<PendingSubmit | null>(null)
  const submittingRef = React.useRef(false)
  activeRecordIdRef.current = recordId

  React.useEffect(() => {
    setStatusFilterState((current) => {
      if (
        current.recordId === recordId
        && current.anchorCommentId === anchorCommentId
      ) {
        return current
      }
      return { recordId, anchorCommentId, value: defaultStatusFilter }
    })
  }, [anchorCommentId, defaultStatusFilter, recordId])

  const load = React.useCallback(async (
    targetRecordId: string,
    targetCommentId?: string,
  ) => {
    const epoch = ++requestEpochRef.current
    const candidateEpoch = ++candidateRequestEpochRef.current
    setLoading(true)
    setLoadingMore(false)
    if (pendingSubmitRef.current?.recordId !== targetRecordId) {
      setError(null)
    }
    setSnapshot((current) => (
      current.recordId === targetRecordId
        ? current
        : { ...EMPTY_SNAPSHOT, recordId: targetRecordId }
    ))
    void gateway.listMentionCandidates(targetRecordId, '', MENTION_CANDIDATE_LIMIT)
      .then((candidates) => {
        if (
          candidateRequestEpochRef.current === candidateEpoch
          && activeRecordIdRef.current === targetRecordId
        ) {
          setMentionCandidates(candidates)
        }
      })
      .catch(() => {
        if (
          candidateRequestEpochRef.current === candidateEpoch
          && activeRecordIdRef.current === targetRecordId
        ) {
          setMentionCandidates([])
        }
      })
    try {
      const result = await gateway.listComments(targetRecordId, {
        limit: 50,
        status: statusFilter,
        ...(targetCommentId ? { anchor: targetCommentId } : {}),
      })
      if (requestEpochRef.current !== epoch || activeRecordIdRef.current !== targetRecordId) return
      setSnapshot({
        recordId: targetRecordId,
        comments: result.comments,
        total: result.total,
        threadTotal: result.thread_total ?? result.total,
        openThreadTotal: result.open_thread_total ?? result.total,
        hasMore: result.has_more,
        nextCursor: result.next_cursor ?? null,
      })
    } catch (loadError) {
      if (requestEpochRef.current !== epoch || activeRecordIdRef.current !== targetRecordId) return
      if (pendingSubmitRef.current?.recordId !== targetRecordId) {
        setError(errorMessage(loadError))
      }
    } finally {
      if (requestEpochRef.current === epoch && activeRecordIdRef.current === targetRecordId) {
        setLoading(false)
      }
    }
  }, [gateway, statusFilter])

  React.useEffect(() => {
    if (!enabled || !recordId) {
      requestEpochRef.current += 1
      candidateRequestEpochRef.current += 1
      setLoading(false)
      setMentionCandidates([])
      return
    }
    void load(recordId, anchorCommentId)
    return () => {
      requestEpochRef.current += 1
    }
  }, [anchorCommentId, enabled, load, recordId])

  const setDraft = React.useCallback((value: string) => {
    if (!recordId) return
    const pending = pendingSubmitRef.current
    if (pending?.recordId === recordId && value.trim() !== pending.content) {
      pendingSubmitRef.current = null
      setError(null)
    }
    setDrafts((current) => ({ ...current, [recordId]: value }))
  }, [recordId])

  const searchMentionCandidates = React.useCallback(async (query: string) => {
    if (!recordId) return
    const targetRecordId = recordId
    const candidateEpoch = ++candidateRequestEpochRef.current
    try {
      const candidates = await gateway.listMentionCandidates(
        targetRecordId,
        query,
        MENTION_CANDIDATE_LIMIT,
      )
      if (
        candidateRequestEpochRef.current === candidateEpoch
        && activeRecordIdRef.current === targetRecordId
      ) {
        setMentionCandidates(candidates)
      }
    } catch {
      // 搜索候选失败只降级 @，不覆盖已经加载的评论和主错误状态。
    }
  }, [gateway, recordId])

  const sendPending = React.useCallback(async (pending: PendingSubmit) => {
    if (submittingRef.current) return undefined
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const result = await gateway.createComment(pending.recordId, {
        content: pending.content,
        mention_user_ids: pending.mentionUserIds,
        client_request_id: pending.clientRequestId,
        ...(pending.replyToCommentId ? { reply_to_comment_id: pending.replyToCommentId } : {}),
      })
      if (activeRecordIdRef.current === pending.recordId) {
        // Only reads for the changed record become stale. A newly selected record keeps loading.
        requestEpochRef.current += 1
        setLoading(false)
        setLoadingMore(false)
      }
      setDrafts((current) => ({ ...current, [pending.recordId]: '' }))
      if (pendingSubmitRef.current === pending) {
        pendingSubmitRef.current = null
      }
      if (!result.comment.is_deleted && activeRecordIdRef.current === pending.recordId) {
        setSnapshot((current) => {
          if (current.recordId !== pending.recordId) return current
          const exists = current.comments.some((comment) => comment.id === result.comment.id)
          const commentStatus = result.comment.thread?.status ?? 'open'
          const visible = statusFilter === 'all' || statusFilter === commentStatus
          const comments = exists || !visible
            ? current.comments
            : [...current.comments, result.comment]
          const total = result.created === false
            ? Math.max(current.total, comments.length)
            : current.total + (exists || !visible ? 0 : 1)
          const isNewThread = !result.comment.reply_to
          return {
            ...current,
            comments,
            total,
            threadTotal: current.threadTotal + (result.created !== false && !exists && visible && isNewThread ? 1 : 0),
            openThreadTotal: current.openThreadTotal + (result.created !== false && !exists && isNewThread ? 1 : 0),
          }
        })
      }
      return result.comment.is_deleted ? undefined : result.comment
    } catch (submitError) {
      // 服务端可能已经落库、只有响应丢失。保留同一幂等键供显式重试。
      pendingSubmitRef.current = pending
      const displayError = submitErrorMessage(submitError, pending.recordId)
      if (activeRecordIdRef.current === pending.recordId) {
        setError(displayError)
      }
      throw submitError
    } finally {
      setSubmitting(false)
      submittingRef.current = false
    }
  }, [gateway, statusFilter])

  const submit = React.useCallback(async (mentionUserIds: string[], replyToCommentId?: string) => {
    if (!recordId || submittingRef.current) return undefined
    const content = (drafts[recordId] ?? '').trim()
    if (!content) return undefined

    const existing = pendingSubmitRef.current
    const pending: PendingSubmit = matchesPendingSubmit(
      existing,
      recordId,
      content,
      mentionUserIds,
      replyToCommentId,
    ) ? existing : {
        recordId,
        content,
        mentionUserIds: [...mentionUserIds],
        clientRequestId: requestIdFactory(),
        replyToCommentId,
      }
    pendingSubmitRef.current = pending
    return sendPending(pending)
  }, [drafts, recordId, requestIdFactory, sendPending])

  const deleteComment = React.useCallback(async (commentId: string) => {
    if (!recordId) return
    const targetRecordId = recordId
    setDeletingCommentIds((current) => (
      current.includes(commentId) ? current : [...current, commentId]
    ))
    setError(null)
    try {
      const result = await gateway.deleteComment(targetRecordId, commentId)
      if (activeRecordIdRef.current === targetRecordId) {
        requestEpochRef.current += 1
        setLoading(false)
        setLoadingMore(false)
        setSnapshot((current) => {
          if (current.recordId !== targetRecordId) return current
          const target = current.comments.find((comment) => comment.id === commentId)
          const threadId = target?.thread?.id ?? target?.reply_to?.id ?? target?.id
          const isRoot = Boolean(target && (target.thread?.id === target.id || !target.reply_to))
          const comments = statusFilter === 'all' && result.comment
            ? current.comments.map((comment) => comment.id === commentId
                ? { ...result.comment!, content: '', mentions: [] }
                : comment)
            : current.comments.filter((comment) => (
                comment.id !== commentId
                && !(isRoot && (comment.thread?.id ?? comment.reply_to?.id ?? comment.id) === threadId)
              ))
          const removedCount = current.comments.length - comments.length
          return {
            ...current,
            comments,
            total: Math.max(0, current.total - removedCount),
            threadTotal: Math.max(0, current.threadTotal - (statusFilter !== 'all' && isRoot ? 1 : 0)),
            openThreadTotal: Math.max(0, current.openThreadTotal - (isRoot ? 1 : 0)),
          }
        })
      }
    } catch (deleteError) {
      if (activeRecordIdRef.current === targetRecordId) {
        setError(errorMessage(deleteError))
      }
      throw deleteError
    } finally {
      setDeletingCommentIds((current) => current.filter((id) => id !== commentId))
    }
  }, [gateway, recordId, statusFilter])

  const updateThreadStatus = React.useCallback(async (
    threadId: string,
    status: RecordCommentStatus,
  ) => {
    if (!recordId) return
    const targetRecordId = recordId
    setUpdatingThreadIds((current) => current.includes(threadId) ? current : [...current, threadId])
    setError(null)
    try {
      const result = await gateway.updateThreadStatus(targetRecordId, threadId, status)
      if (activeRecordIdRef.current !== targetRecordId) return
      setSnapshot((current) => {
        if (current.recordId !== targetRecordId) return current
        const wasOpen = current.comments.find((comment) => comment.thread?.id === threadId)?.thread?.status === 'open'
        if (statusFilter !== 'all' && statusFilter !== status) {
          const comments = current.comments.filter((comment) => comment.thread?.id !== threadId)
          return {
            ...current,
            comments,
            total: Math.max(0, current.total - (current.comments.length - comments.length)),
            threadTotal: Math.max(0, current.threadTotal - 1),
            openThreadTotal: Math.max(0, current.openThreadTotal + (status === 'open' ? 1 : wasOpen ? -1 : 0)),
          }
        }
        return {
          ...current,
          comments: current.comments.map((comment) => (
            comment.thread?.id === threadId ? { ...comment, thread: result.thread } : comment
          )),
          openThreadTotal: Math.max(0, current.openThreadTotal + (status === 'open' ? (wasOpen ? 0 : 1) : wasOpen ? -1 : 0)),
        }
      })
    } catch (statusError) {
      if (activeRecordIdRef.current === targetRecordId) setError(errorMessage(statusError))
      throw statusError
    } finally {
      setUpdatingThreadIds((current) => current.filter((id) => id !== threadId))
    }
  }, [gateway, recordId, statusFilter])

  const loadMore = React.useCallback(async () => {
    if (!recordId || loadingMore || !snapshot.hasMore || !snapshot.nextCursor) return
    const targetRecordId = recordId
    const cursor = snapshot.nextCursor
    const requestEpoch = requestEpochRef.current
    setLoadingMore(true)
    if (pendingSubmitRef.current?.recordId !== targetRecordId) {
      setError(null)
    }
    try {
      const result = await gateway.listComments(targetRecordId, { limit: 50, before: cursor, status: statusFilter })
      if (
        requestEpochRef.current !== requestEpoch
        || activeRecordIdRef.current !== targetRecordId
      ) return
      setSnapshot((current) => {
        if (current.recordId !== targetRecordId) return current
        const knownIds = new Set(current.comments.map((comment) => comment.id))
        const older = result.comments.filter((comment) => !knownIds.has(comment.id))
        return {
          recordId: targetRecordId,
          comments: [...older, ...current.comments],
          total: result.total,
          threadTotal: result.thread_total ?? current.threadTotal,
          openThreadTotal: result.open_thread_total ?? current.openThreadTotal,
          hasMore: result.has_more,
          nextCursor: result.next_cursor ?? null,
        }
      })
    } catch (loadMoreError) {
      if (
        requestEpochRef.current === requestEpoch
        && activeRecordIdRef.current === targetRecordId
        && pendingSubmitRef.current?.recordId !== targetRecordId
      ) {
        setError(errorMessage(loadMoreError))
        throw loadMoreError
      }
    } finally {
      if (
        requestEpochRef.current === requestEpoch
        && activeRecordIdRef.current === targetRecordId
      ) {
        setLoadingMore(false)
      }
    }
  }, [gateway, loadingMore, recordId, snapshot.hasMore, snapshot.nextCursor, statusFilter])

  const activeSnapshot = snapshot.recordId === recordId ? snapshot : EMPTY_SNAPSHOT
  const refresh = React.useCallback(async () => {
    if (recordId) await load(recordId)
  }, [load, recordId])
  const retry = React.useCallback(async () => {
    const pending = pendingSubmitRef.current
    if (pending && pending.recordId === recordId) {
      return sendPending(pending)
    }
    return refresh()
  }, [recordId, refresh, sendPending])

  return {
    comments: activeSnapshot.comments,
    total: activeSnapshot.total,
    threadTotal: activeSnapshot.threadTotal,
    openThreadTotal: activeSnapshot.openThreadTotal,
    statusFilter,
    setStatusFilter,
    hasMore: activeSnapshot.hasMore,
    loading,
    loadingMore,
    submitting,
    deletingCommentIds,
    updatingThreadIds,
    error,
    draft: recordId ? drafts[recordId] ?? '' : '',
    mentionCandidates,
    searchMentionCandidates,
    setDraft,
    submit,
    deleteComment,
    resolveThread: (threadId: string) => updateThreadStatus(threadId, 'resolved'),
    reopenThread: (threadId: string) => updateThreadStatus(threadId, 'open'),
    loadMore,
    refresh,
    retry,
  }
}
