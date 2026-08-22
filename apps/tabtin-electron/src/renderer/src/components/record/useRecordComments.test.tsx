import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  CreateRecordCommentRequest,
  CreateRecordCommentResponse,
  DeleteRecordCommentResponse,
  RecordComment,
  RecordCommentListParams,
  RecordCommentListResponse,
  RecordCommentMentionCandidate,
  UpdateRecordCommentThreadStatusResponse,
} from '@tabtin/table-core'
import { useRecordComments, type RecordCommentsGateway } from './useRecordComments'

const makeComment = (id: string, content: string): RecordComment => ({
  id,
  record_id: 'record-1',
  content,
  mentions: [],
  actor: { type: 'human', id: 'user-1', name: 'User 1' },
  authorization_subject: { type: 'user', id: 'user-1', name: 'User 1' },
  is_deleted: false,
  created_at: '2026-08-10T00:00:00Z',
  updated_at: '2026-08-10T00:00:00Z',
  capabilities: { can_delete: true },
  thread: {
    id,
    status: 'open',
    capabilities: { can_resolve: true, can_reopen: false },
  },
})

const makeGateway = (): RecordCommentsGateway => ({
  listComments: vi.fn(async (): Promise<RecordCommentListResponse> => ({
    comments: [makeComment('comment-1', 'Existing')],
    total: 1,
    has_more: false,
    next_cursor: null,
    thread_total: 1,
    open_thread_total: 1,
  })),
  createComment: vi.fn(async (
    _recordId: string,
    data: CreateRecordCommentRequest,
  ): Promise<CreateRecordCommentResponse> => ({
    comment: makeComment('comment-2', data.content),
    created: true,
  })),
  deleteComment: vi.fn(async (): Promise<DeleteRecordCommentResponse> => ({
    deleted: true,
    comment_id: 'comment-1',
  })),
  updateThreadStatus: vi.fn(async (
    _recordId: string,
    threadId: string,
    status: 'open' | 'resolved',
  ): Promise<UpdateRecordCommentThreadStatusResponse> => ({
    thread: {
      id: threadId,
      status,
      capabilities: { can_resolve: status === 'open', can_reopen: status === 'resolved' },
    },
  })),
  listMentionCandidates: vi.fn(async (): Promise<RecordCommentMentionCandidate[]> => []),
})

describe('useRecordComments', () => {
  it('does not request comments while the record detail is disabled', () => {
    const gateway = makeGateway()
    renderHook(() => useRecordComments({ recordId: 'record-1', enabled: false, gateway }))
    expect(gateway.listComments).not.toHaveBeenCalled()
  })

  it('loads comments lazily for the active record', async () => {
    const gateway = makeGateway()
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
    }))

    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    expect(gateway.listComments).toHaveBeenCalledWith('record-1', { limit: 50, status: 'open' })
    expect(result.current.total).toBe(1)
    expect(result.current.threadTotal).toBe(1)
  })

  it('keeps existing comments when a realtime refresh races with a successful submit', async () => {
    let resolveRefresh: ((value: RecordCommentListResponse) => void) | undefined
    let resolveSubmit: ((value: CreateRecordCommentResponse) => void) | undefined
    let listAttempt = 0
    const gateway = makeGateway()
    gateway.listComments = vi.fn(() => {
      listAttempt += 1
      if (listAttempt === 1) {
        return Promise.resolve({
          comments: [makeComment('comment-1', 'Existing')],
          total: 1,
          has_more: false,
          next_cursor: null,
        })
      }
      return new Promise<RecordCommentListResponse>((resolve) => {
        resolveRefresh = resolve
      })
    })
    gateway.createComment = vi.fn(() => new Promise<CreateRecordCommentResponse>((resolve) => {
      resolveSubmit = resolve
    }))

    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
      requestIdFactory: () => 'request-1',
    }))
    await waitFor(() => expect(result.current.comments.map((comment) => comment.id)).toEqual(['comment-1']))

    act(() => result.current.setDraft('New comment'))
    let submitPromise: Promise<RecordComment | undefined> | undefined
    act(() => {
      submitPromise = result.current.submit([])
    })
    await waitFor(() => expect(gateway.createComment).toHaveBeenCalledTimes(1))

    let refreshPromise: Promise<void> | undefined
    act(() => {
      refreshPromise = result.current.refresh()
    })
    await waitFor(() => expect(gateway.listComments).toHaveBeenCalledTimes(2))

    await act(async () => {
      resolveSubmit?.({
        comment: makeComment('comment-2', 'New comment'),
        created: true,
      })
      await submitPromise
    })

    expect(result.current.comments.map((comment) => comment.id)).toEqual([
      'comment-1',
      'comment-2',
    ])

    await act(async () => {
      resolveRefresh?.({
        comments: [
          makeComment('comment-1', 'Existing'),
          makeComment('comment-2', 'New comment'),
        ],
        total: 2,
        has_more: false,
        next_cursor: null,
      })
      await refreshPromise
    })
  })

  it('keeps the comment timeline when mention candidates fail to load', async () => {
    const gateway = makeGateway()
    gateway.listMentionCandidates = vi.fn(async () => { throw new Error('members unavailable') })
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
    }))

    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    expect(result.current.mentionCandidates).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('does not wait for a slow mention-candidate request before showing comments', async () => {
    const gateway = makeGateway()
    gateway.listMentionCandidates = vi.fn(() => new Promise(() => {}))
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
    }))

    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    expect(result.current.loading).toBe(false)
  })

  it('loads the page containing a notification target comment', async () => {
    const gateway = makeGateway()
    renderHook(() => useRecordComments({
      recordId: 'record-1',
      anchorCommentId: 'comment-older',
      enabled: true,
      gateway,
    }))

    await waitFor(() => expect(gateway.listComments).toHaveBeenCalledWith('record-1', {
      limit: 50,
      status: 'all',
      anchor: 'comment-older',
    }))
  })

  it('resets the thread filter after leaving a notification target', async () => {
    const gateway = makeGateway()
    const { result, rerender } = renderHook(
      ({ recordId, anchorCommentId }: { recordId: string, anchorCommentId?: string }) => useRecordComments({
        recordId,
        anchorCommentId,
        enabled: true,
        gateway,
      }),
      { initialProps: { recordId: 'record-1', anchorCommentId: 'comment-older' } },
    )

    await waitFor(() => expect(gateway.listComments).toHaveBeenCalledWith('record-1', {
      limit: 50,
      status: 'all',
      anchor: 'comment-older',
    }))

    rerender({ recordId: 'record-2', anchorCommentId: undefined })

    await waitFor(() => expect(gateway.listComments).toHaveBeenLastCalledWith('record-2', {
      limit: 50,
      status: 'open',
    }))
    expect(result.current.statusFilter).toBe('open')
  })

  it('switches thread categories and resolves the active thread', async () => {
    const gateway = makeGateway()
    gateway.listComments = vi.fn(async (_recordId, params) => ({
      comments: params?.status === 'resolved'
        ? [{
            ...makeComment('comment-1', 'Resolved'),
            thread: {
              id: 'comment-1',
              status: 'resolved',
              capabilities: { can_resolve: false, can_reopen: true },
            },
          }]
        : [makeComment('comment-1', 'Existing')],
      total: 1,
      thread_total: 1,
      open_thread_total: params?.status === 'resolved' ? 0 : 1,
      has_more: false,
      next_cursor: null,
    }))
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
    }))
    await waitFor(() => expect(result.current.comments).toHaveLength(1))

    await act(async () => {
      await result.current.resolveThread('comment-1')
    })
    expect(gateway.updateThreadStatus).toHaveBeenCalledWith(
      'record-1',
      'comment-1',
      'resolved',
    )
    expect(result.current.comments).toEqual([])
    expect(result.current.threadTotal).toBe(0)
    expect(result.current.openThreadTotal).toBe(0)

    act(() => result.current.setStatusFilter('resolved'))
    await waitFor(() => expect(result.current.comments[0]?.thread?.status).toBe('resolved'))
    expect(gateway.listComments).toHaveBeenLastCalledWith('record-1', {
      limit: 50,
      status: 'resolved',
    })
  })

  it('searches mention candidates on the server for members outside the first page', async () => {
    const gateway = makeGateway()
    gateway.listMentionCandidates = vi.fn(async (_recordId, query) => (
      query === 'Ada'
        ? [{ user_id: 'user-51', display_name: 'Ada' }]
        : []
    ))
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
    }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.searchMentionCandidates('Ada')
    })

    expect(gateway.listMentionCandidates).toHaveBeenLastCalledWith('record-1', 'Ada', 200)
    expect(result.current.mentionCandidates).toEqual([
      { user_id: 'user-51', display_name: 'Ada' },
    ])
  })

  it('ignores a stale response after switching records', async () => {
    let resolveFirst: ((value: RecordCommentListResponse) => void) | undefined
    const gateway = makeGateway()
    gateway.listComments = vi.fn((recordId: string, _params?: RecordCommentListParams) => {
      if (recordId === 'record-1') {
        return new Promise<RecordCommentListResponse>((resolve) => { resolveFirst = resolve })
      }
      return Promise.resolve({
        comments: [{ ...makeComment('comment-2', 'Second'), record_id: 'record-2' }],
        total: 1,
        has_more: false,
        next_cursor: null,
      })
    })

    const { result, rerender } = renderHook(
      ({ recordId }) => useRecordComments({ recordId, enabled: true, gateway }),
      { initialProps: { recordId: 'record-1' } },
    )
    rerender({ recordId: 'record-2' })

    await waitFor(() => expect(result.current.comments[0]?.record_id).toBe('record-2'))
    await act(async () => {
      resolveFirst?.({
        comments: [makeComment('comment-1', 'First')],
        total: 1,
        has_more: false,
        next_cursor: null,
      })
    })
    expect(result.current.comments[0]?.record_id).toBe('record-2')
  })

  it('keeps drafts isolated per record and clears only after a successful send', async () => {
    const gateway = makeGateway()
    const { result, rerender } = renderHook(
      ({ recordId }) => useRecordComments({
        recordId,
        enabled: true,
        gateway,
        requestIdFactory: () => 'request-1',
      }),
      { initialProps: { recordId: 'record-1' } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setDraft('Draft one'))
    rerender({ recordId: 'record-2' })
    act(() => result.current.setDraft('Draft two'))
    rerender({ recordId: 'record-1' })
    expect(result.current.draft).toBe('Draft one')
    await waitFor(() => expect(result.current.comments[0]?.content).toBe('Existing'))

    await act(async () => {
      await result.current.submit(['user-2'], 'comment-parent')
    })
    expect(gateway.createComment).toHaveBeenCalledWith('record-1', {
      content: 'Draft one',
      mention_user_ids: ['user-2'],
      client_request_id: 'request-1',
      reply_to_comment_id: 'comment-parent',
    })
    expect(result.current.draft).toBe('')
    expect(result.current.total).toBe(2)
  })

  it('preserves a non-network submit error without changing its meaning', async () => {
    const gateway = makeGateway()
    gateway.createComment = vi.fn(async () => { throw new Error('没有评论权限') })
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
    }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setDraft('Retry me'))

    await act(async () => {
      await expect(result.current.submit([])).rejects.toThrow('没有评论权限')
    })
    expect(result.current.draft).toBe('Retry me')
    expect(result.current.error).toBe('没有评论权限')
  })

  it('explains that a timed-out comment was not sent and keeps its draft', async () => {
    const gateway = makeGateway()
    gateway.createComment = vi.fn(async () => { throw new Error('请求超时（30s）') })
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
    }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setDraft('Retry after timeout'))

    await act(async () => {
      await expect(result.current.submit([])).rejects.toThrow('请求超时')
    })

    expect(result.current.draft).toBe('Retry after timeout')
    expect(result.current.error).toContain('评论未发送')
    expect(result.current.error).toContain('草稿已保留')
    expect(result.current.error).toContain('重试')
  })

  it('shows recoverable guidance and reuses the same request when retrying offline', async () => {
    const gateway = makeGateway()
    let attempts = 0
    gateway.createComment = vi.fn(async (
      _recordId: string,
      data: CreateRecordCommentRequest,
    ) => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('Network error: internet disconnected'), {
          code: 'NETWORK_ERROR',
        })
      }
      return {
        comment: makeComment('comment-2', data.content),
        created: false,
      }
    })
    const requestIdFactory = vi.fn(() => 'stable-request-id')
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
      requestIdFactory,
    }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setDraft('Retry safely'))

    await act(async () => {
      await expect(result.current.submit(['user-2'])).rejects.toThrow('Network error')
    })
    expect(result.current.draft).toBe('Retry safely')
    expect(result.current.error).toContain('评论未发送')
    expect(result.current.error).toContain('草稿已保留')
    expect(result.current.error).toContain('重试')
    await act(async () => {
      await result.current.retry()
    })

    expect(requestIdFactory).toHaveBeenCalledTimes(1)
    expect(gateway.createComment).toHaveBeenCalledTimes(2)
    expect(gateway.createComment).toHaveBeenNthCalledWith(1, 'record-1', {
      content: 'Retry safely',
      mention_user_ids: ['user-2'],
      client_request_id: 'stable-request-id',
    })
    expect(gateway.createComment).toHaveBeenNthCalledWith(2, 'record-1', {
      content: 'Retry safely',
      mention_user_ids: ['user-2'],
      client_request_id: 'stable-request-id',
    })
    expect(result.current.draft).toBe('')
    expect(result.current.total).toBe(2)
  })

  it('reuses the pending request id when the unchanged draft is submitted normally again', async () => {
    const gateway = makeGateway()
    let attempts = 0
    gateway.createComment = vi.fn(async (
      _recordId: string,
      data: CreateRecordCommentRequest,
    ) => {
      attempts += 1
      if (attempts === 1) throw new Error('response lost')
      return {
        comment: makeComment('comment-2', data.content),
        created: false,
      }
    })
    const requestIdFactory = vi.fn()
      .mockReturnValueOnce('request-original')
      .mockReturnValueOnce('request-new')
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
      requestIdFactory,
    }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setDraft('Retry safely'))

    await act(async () => {
      await expect(result.current.submit(['user-2'])).rejects.toThrow('response lost')
    })
    // Controlled editors may report their current value again without a user edit.
    act(() => result.current.setDraft('Retry safely'))
    await act(async () => {
      await result.current.submit(['user-2'])
    })

    expect(requestIdFactory).toHaveBeenCalledTimes(1)
    expect(gateway.createComment).toHaveBeenNthCalledWith(2, 'record-1', {
      content: 'Retry safely',
      mention_user_ids: ['user-2'],
      client_request_id: 'request-original',
    })
  })

  it('allocates a new request id after the failed payload changes', async () => {
    const gateway = makeGateway()
    gateway.createComment = vi.fn(async (
      _recordId: string,
      data: CreateRecordCommentRequest,
    ) => {
      if (data.client_request_id === 'request-original') throw new Error('response lost')
      return {
        comment: makeComment('comment-2', data.content),
        created: true,
      }
    })
    const requestIdFactory = vi.fn()
      .mockReturnValueOnce('request-original')
      .mockReturnValueOnce('request-new')
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
      requestIdFactory,
    }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setDraft('Original'))
    await act(async () => {
      await expect(result.current.submit(['user-2'])).rejects.toThrow('response lost')
    })

    act(() => result.current.setDraft('Changed'))
    await act(async () => {
      await result.current.submit(['user-3'])
    })

    expect(requestIdFactory).toHaveBeenCalledTimes(2)
    expect(gateway.createComment).toHaveBeenNthCalledWith(2, 'record-1', {
      content: 'Changed',
      mention_user_ids: ['user-3'],
      client_request_id: 'request-new',
    })
  })

  it('preserves a failed submit across refresh and reuses it on normal submit', async () => {
    const gateway = makeGateway()
    let attempts = 0
    gateway.createComment = vi.fn(async (
      _recordId: string,
      data: CreateRecordCommentRequest,
    ) => {
      attempts += 1
      if (attempts === 1) throw new Error('response lost')
      return { comment: makeComment('comment-2', data.content), created: false }
    })
    const requestIdFactory = vi.fn(() => 'request-original')
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
      requestIdFactory,
    }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setDraft('Retry safely'))
    await act(async () => {
      await expect(result.current.submit([])).rejects.toThrow('response lost')
    })

    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error).toBe('response lost')
    await act(async () => {
      await result.current.submit([])
    })

    expect(requestIdFactory).toHaveBeenCalledTimes(1)
    expect(gateway.createComment).toHaveBeenNthCalledWith(2, 'record-1', {
      content: 'Retry safely',
      mention_user_ids: [],
      client_request_id: 'request-original',
    })
  })

  it('does not let a completed submit for the old record cancel the new record load', async () => {
    let resolveSubmit: ((value: CreateRecordCommentResponse) => void) | undefined
    let resolveSecondLoad: ((value: RecordCommentListResponse) => void) | undefined
    const gateway = makeGateway()
    gateway.createComment = vi.fn(() => new Promise<CreateRecordCommentResponse>((resolve) => {
      resolveSubmit = resolve
    }))
    gateway.listComments = vi.fn((recordId: string) => {
      if (recordId === 'record-2') {
        return new Promise<RecordCommentListResponse>((resolve) => { resolveSecondLoad = resolve })
      }
      return Promise.resolve({
        comments: [makeComment('comment-1', 'Existing')],
        total: 1,
        has_more: false,
        next_cursor: null,
      })
    })
    const { result, rerender } = renderHook(
      ({ recordId }) => useRecordComments({ recordId, enabled: true, gateway }),
      { initialProps: { recordId: 'record-1' } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setDraft('Sent from record one'))
    let submitPromise: Promise<RecordComment | undefined> | undefined
    act(() => {
      submitPromise = result.current.submit([])
    })

    rerender({ recordId: 'record-2' })
    await waitFor(() => expect(result.current.loading).toBe(true))
    await act(async () => {
      resolveSubmit?.({
        comment: makeComment('comment-2', 'Sent from record one'),
        created: true,
      })
      await submitPromise
    })

    expect(result.current.loading).toBe(true)
    expect(result.current.error).toBeNull()
    await act(async () => {
      resolveSecondLoad?.({
        comments: [{ ...makeComment('comment-3', 'Record two'), record_id: 'record-2' }],
        total: 1,
        has_more: false,
        next_cursor: null,
      })
    })
    await waitFor(() => expect(result.current.comments[0]?.record_id).toBe('record-2'))
    expect(result.current.loading).toBe(false)
  })

  it('does not show an old record submit failure on the newly selected record', async () => {
    let rejectSubmit: ((reason?: unknown) => void) | undefined
    let resolveSecondLoad: ((value: RecordCommentListResponse) => void) | undefined
    const gateway = makeGateway()
    gateway.createComment = vi.fn(() => new Promise<CreateRecordCommentResponse>((_resolve, reject) => {
      rejectSubmit = reject
    }))
    gateway.listComments = vi.fn((recordId: string) => {
      if (recordId === 'record-2') {
        return new Promise<RecordCommentListResponse>((resolve) => { resolveSecondLoad = resolve })
      }
      return Promise.resolve({
        comments: [makeComment('comment-1', 'Existing')],
        total: 1,
        has_more: false,
        next_cursor: null,
      })
    })
    const { result, rerender } = renderHook(
      ({ recordId }) => useRecordComments({ recordId, enabled: true, gateway }),
      { initialProps: { recordId: 'record-1' } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setDraft('Sent from record one'))
    let submitPromise: Promise<RecordComment | undefined> | undefined
    act(() => {
      submitPromise = result.current.submit([])
    })

    rerender({ recordId: 'record-2' })
    await waitFor(() => expect(result.current.loading).toBe(true))
    await act(async () => {
      rejectSubmit?.(new Error('record one failed'))
      await expect(submitPromise).rejects.toThrow('record one failed')
    })

    expect(result.current.loading).toBe(true)
    expect(result.current.error).toBeNull()
    await act(async () => {
      resolveSecondLoad?.({
        comments: [{ ...makeComment('comment-3', 'Record two'), record_id: 'record-2' }],
        total: 1,
        has_more: false,
        next_cursor: null,
      })
    })
    await waitFor(() => expect(result.current.comments[0]?.record_id).toBe('record-2'))
  })

  it('does not restore a deleted comment when an idempotent request is replayed', async () => {
    const gateway = makeGateway()
    gateway.createComment = vi.fn(async (
      _recordId: string,
      data: CreateRecordCommentRequest,
    ) => ({
      comment: { ...makeComment('comment-2', data.content), is_deleted: true },
      created: false,
    }))
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
    }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setDraft('Already deleted'))

    await act(async () => {
      await result.current.submit([])
    })

    expect(result.current.comments.map((comment) => comment.id)).toEqual(['comment-1'])
    expect(result.current.total).toBe(1)
    expect(result.current.draft).toBe('')
  })

  it('ignores an older-page response invalidated by a successful send', async () => {
    let resolveOlder: ((value: RecordCommentListResponse) => void) | undefined
    const gateway = makeGateway()
    gateway.listComments = vi.fn((_recordId: string, params?: RecordCommentListParams) => {
      if (params?.before) {
        return new Promise<RecordCommentListResponse>((resolve) => { resolveOlder = resolve })
      }
      return Promise.resolve({
        comments: [makeComment('comment-1', 'Existing')],
        total: 2,
        has_more: true,
        next_cursor: 'older-cursor',
      })
    })
    const { result } = renderHook(() => useRecordComments({
      recordId: 'record-1',
      enabled: true,
      gateway,
      requestIdFactory: () => 'request-new',
    }))
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    let loadMorePromise: Promise<void> | undefined
    act(() => {
      loadMorePromise = result.current.loadMore()
    })
    act(() => result.current.setDraft('New comment'))
    await act(async () => {
      await result.current.submit([])
    })
    await act(async () => {
      resolveOlder?.({
        comments: [makeComment('comment-old', 'Older')],
        total: 2,
        has_more: false,
        next_cursor: null,
      })
      await loadMorePromise
    })

    expect(result.current.comments.map((comment) => comment.id)).toEqual([
      'comment-1',
      'comment-2',
    ])
  })

  it('does not leak a stale load-more failure into the next record', async () => {
    let rejectOlder: ((reason?: unknown) => void) | undefined
    const gateway = makeGateway()
    gateway.listComments = vi.fn((recordId: string, params?: RecordCommentListParams) => {
      if (recordId === 'record-1' && params?.before) {
        return new Promise<RecordCommentListResponse>((_resolve, reject) => {
          rejectOlder = reject
        })
      }
      return Promise.resolve({
        comments: [makeComment(recordId === 'record-1' ? 'comment-1' : 'comment-3', 'Current')],
        total: recordId === 'record-1' ? 2 : 1,
        has_more: recordId === 'record-1',
        next_cursor: recordId === 'record-1' ? 'older-cursor' : null,
      })
    })
    const { result, rerender } = renderHook(
      ({ recordId }) => useRecordComments({ recordId, enabled: true, gateway }),
      { initialProps: { recordId: 'record-1' } },
    )
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    let loadMorePromise: Promise<void> | undefined
    act(() => {
      loadMorePromise = result.current.loadMore()
    })
    rerender({ recordId: 'record-2' })
    await waitFor(() => expect(result.current.comments[0]?.id).toBe('comment-3'))
    await act(async () => {
      rejectOlder?.(new Error('old page failed'))
      await loadMorePromise
    })

    expect(result.current.error).toBeNull()
    expect(result.current.comments.map((comment) => comment.id)).toEqual(['comment-3'])
    expect(result.current.loadingMore).toBe(false)
  })
})
