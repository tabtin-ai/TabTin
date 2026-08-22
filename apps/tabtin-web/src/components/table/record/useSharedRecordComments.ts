import * as React from 'react'
import type { CommentItem, CommentMentionCandidate } from '@tabtin/smartsheet-ui'
import { RecordCommentApiService } from '@tabtin/table-core'
import { API_BASE_URL } from '@/config/api'
import { shareAuthHeaders } from '@/pages/shareAuth'
import {
  createSharedRecordCommentsClient,
  toCommentItem,
  toMentionCandidate,
} from './shared-record-comments-client'
import { createInternalRecordCommentsClient, type RecordCommentsClient } from './record-comments-client'
import {
  isRecordRequestCurrent,
  matchesPendingRecordCommentSubmit,
  mergeOlderComments,
} from './shared-record-comments-state'

export interface SharedRecordCommentsAccess {
  shareId: string
  password?: string
}

interface UseRecordCommentsOptions {
  access?: SharedRecordCommentsAccess
  recordId?: string
  enabled: boolean
  targetCommentId?: string | null
  subscribe?: (onChange: () => void) => () => void
}

interface CommentSnapshot {
  recordId: string
  comments: CommentItem[]
  total: number
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

const EMPTY_SNAPSHOT: CommentSnapshot = {
  recordId: '',
  comments: [],
  total: 0,
  hasMore: false,
  nextCursor: null,
}

const createClientRequestId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `record-comment-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : '评论请求失败'
)

/** One state machine for authenticated and public-share record comments. */
export function useRecordComments({
  access,
  recordId,
  enabled,
  targetCommentId,
  subscribe,
}: UseRecordCommentsOptions) {
  const shareId = access?.shareId
  const password = access?.password
  const client = React.useMemo<RecordCommentsClient>(() => (
    shareId
      ? createSharedRecordCommentsClient({
          apiBaseUrl: API_BASE_URL || '/api',
          shareId,
          password,
          getAuthHeaders: shareAuthHeaders,
        })
      : createInternalRecordCommentsClient(RecordCommentApiService)
  ), [password, shareId])
  const [snapshot, setSnapshot] = React.useState<CommentSnapshot>(EMPTY_SNAPSHOT)
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [mentionCandidates, setMentionCandidates] = React.useState<CommentMentionCandidate[]>([])
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [deletingCommentIds, setDeletingCommentIds] = React.useState<string[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const requestEpochRef = React.useRef(0)
  const candidateEpochRef = React.useRef(0)
  const activeRecordIdRef = React.useRef(recordId)
  const pendingSubmitRef = React.useRef<PendingSubmit | null>(null)
  const submittingRef = React.useRef(false)
  activeRecordIdRef.current = recordId

  const loadMentionCandidates = React.useCallback(async (
    targetRecordId: string,
    search = '',
  ) => {
    const epoch = ++candidateEpochRef.current
    try {
      const candidates = await client.listMentionCandidates(targetRecordId, search)
      if (candidateEpochRef.current !== epoch || activeRecordIdRef.current !== targetRecordId) return
      setMentionCandidates(candidates.map(toMentionCandidate))
    } catch {
      if (candidateEpochRef.current !== epoch || activeRecordIdRef.current !== targetRecordId) return
      setMentionCandidates([])
    }
  }, [client])

  const load = React.useCallback(async (targetRecordId: string, anchor?: string | null) => {
    const epoch = ++requestEpochRef.current
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
    try {
      const result = await client.list(targetRecordId, { limit: 50, anchor })
      if (requestEpochRef.current !== epoch || activeRecordIdRef.current !== targetRecordId) return
      setSnapshot({
        recordId: targetRecordId,
        comments: result.comments.map(toCommentItem),
        total: result.total,
        hasMore: result.has_more,
        nextCursor: result.next_cursor,
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
  }, [client])

  React.useEffect(() => {
    if (!enabled || !recordId) {
      requestEpochRef.current += 1
      candidateEpochRef.current += 1
      setLoading(false)
      setMentionCandidates([])
      return
    }
    void load(recordId, targetCommentId)
    void loadMentionCandidates(recordId)
    return () => {
      requestEpochRef.current += 1
      candidateEpochRef.current += 1
    }
  }, [enabled, load, loadMentionCandidates, recordId, targetCommentId])

  const setDraft = React.useCallback((value: string) => {
    if (!recordId) return
    const pending = pendingSubmitRef.current
    if (pending?.recordId === recordId && value.trim() !== pending.content) {
      pendingSubmitRef.current = null
      setError(null)
    }
    setDrafts((current) => ({ ...current, [recordId]: value }))
  }, [recordId])

  const sendPending = React.useCallback(async (pending: PendingSubmit) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const result = await client.create(pending.recordId, {
        content: pending.content,
        mentionUserIds: pending.mentionUserIds,
        clientRequestId: pending.clientRequestId,
        replyToCommentId: pending.replyToCommentId,
      })
      if (isRecordRequestCurrent(activeRecordIdRef.current, pending.recordId)) {
        requestEpochRef.current += 1
        setLoading(false)
        setLoadingMore(false)
      }
      setDrafts((current) => ({ ...current, [pending.recordId]: '' }))
      if (pendingSubmitRef.current === pending) {
        pendingSubmitRef.current = null
      }
      if (activeRecordIdRef.current === pending.recordId && result.comment.is_deleted !== true) {
        const commentItem = toCommentItem(result.comment)
        setSnapshot((current) => {
          if (current.recordId !== pending.recordId) return current
          const existingIndex = current.comments.findIndex((comment) => comment.id === commentItem.id)
          const comments = existingIndex >= 0
            ? current.comments.map((comment, index) => index === existingIndex ? commentItem : comment)
            : [...current.comments, commentItem]
          return {
            ...current,
            comments,
            total: result.created && existingIndex < 0
              ? current.total + 1
              : Math.max(current.total, comments.length),
          }
        })
      }
    } catch (submitError) {
      pendingSubmitRef.current = pending
      if (isRecordRequestCurrent(activeRecordIdRef.current, pending.recordId)) {
        setError(errorMessage(submitError))
      }
      throw submitError
    } finally {
      setSubmitting(false)
      submittingRef.current = false
    }
  }, [client])

  const submit = React.useCallback(async (mentionUserIds: string[], replyToCommentId?: string) => {
    if (!recordId || submittingRef.current) return
    const content = (drafts[recordId] ?? '').trim()
    if (!content) return
    const existing = pendingSubmitRef.current
    const pending: PendingSubmit = matchesPendingRecordCommentSubmit(existing, {
      recordId,
      content,
      mentionUserIds,
      replyToCommentId,
    }) ? existing : {
        recordId,
        content,
        mentionUserIds: [...mentionUserIds],
        clientRequestId: createClientRequestId(),
        replyToCommentId,
      }
    pendingSubmitRef.current = pending
    await sendPending(pending)
  }, [drafts, recordId, sendPending])

  const deleteComment = React.useCallback(async (commentId: string) => {
    if (!recordId) return
    const targetRecordId = recordId
    setDeletingCommentIds((current) => (
      current.includes(commentId) ? current : [...current, commentId]
    ))
    setError(null)
    try {
      await client.remove(targetRecordId, commentId)
      if (isRecordRequestCurrent(activeRecordIdRef.current, targetRecordId)) {
        requestEpochRef.current += 1
        setLoading(false)
        setLoadingMore(false)
        setSnapshot((current) => {
          if (current.recordId !== targetRecordId) return current
          const comments = current.comments.filter((comment) => comment.id !== commentId)
          return {
            ...current,
            comments,
            total: comments.length === current.comments.length
              ? current.total
              : Math.max(0, current.total - 1),
          }
        })
      }
    } catch (deleteError) {
      if (isRecordRequestCurrent(activeRecordIdRef.current, targetRecordId)) {
        setError(errorMessage(deleteError))
      }
      throw deleteError
    } finally {
      setDeletingCommentIds((current) => current.filter((id) => id !== commentId))
    }
  }, [client, recordId])

  const loadMore = React.useCallback(async () => {
    if (!recordId || loadingMore || !snapshot.hasMore || !snapshot.nextCursor) return
    const targetRecordId = recordId
    const requestEpoch = requestEpochRef.current
    setLoadingMore(true)
    if (pendingSubmitRef.current?.recordId !== targetRecordId) {
      setError(null)
    }
    try {
      const result = await client.list(targetRecordId, {
        before: snapshot.nextCursor,
        limit: 50,
      })
      if (requestEpochRef.current !== requestEpoch || activeRecordIdRef.current !== targetRecordId) return
      setSnapshot((current) => {
        if (current.recordId !== targetRecordId) return current
        const comments = mergeOlderComments(current.comments, result.comments.map(toCommentItem))
        return {
          recordId: targetRecordId,
          comments,
          total: result.total,
          hasMore: result.has_more,
          nextCursor: result.next_cursor,
        }
      })
    } catch (loadError) {
      if (
        requestEpochRef.current === requestEpoch
        && activeRecordIdRef.current === targetRecordId
        && pendingSubmitRef.current?.recordId !== targetRecordId
      ) {
        setError(errorMessage(loadError))
      }
    } finally {
      if (
        requestEpochRef.current === requestEpoch
        && activeRecordIdRef.current === targetRecordId
      ) {
        setLoadingMore(false)
      }
    }
  }, [client, loadingMore, recordId, snapshot.hasMore, snapshot.nextCursor])

  const activeSnapshot = snapshot.recordId === recordId ? snapshot : EMPTY_SNAPSHOT
  const refresh = React.useCallback(async () => {
    if (recordId) await load(recordId)
  }, [load, recordId])
  const retry = React.useCallback(async () => {
    const pending = pendingSubmitRef.current
    if (pending && pending.recordId === recordId) {
      await sendPending(pending)
      return
    }
    await refresh()
  }, [recordId, refresh, sendPending])
  const searchMentionCandidates = React.useCallback((query: string) => {
    if (!recordId) return
    void loadMentionCandidates(recordId, query)
  }, [loadMentionCandidates, recordId])

  React.useEffect(() => {
    if (!enabled || !subscribe) return undefined
    return subscribe(() => { void refresh() })
  }, [enabled, refresh, subscribe])

  return {
    comments: activeSnapshot.comments,
    total: activeSnapshot.total,
    hasMore: activeSnapshot.hasMore,
    loading,
    loadingMore,
    submitting,
    deletingCommentIds,
    error,
    draft: recordId ? drafts[recordId] ?? '' : '',
    mentionCandidates,
    setDraft,
    submit,
    deleteComment,
    loadMore,
    refresh,
    retry,
    searchMentionCandidates,
  }
}

/** Backward-compatible export for existing call sites and tests. */
export const useSharedRecordComments = useRecordComments
