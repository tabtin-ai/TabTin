import { describe, expect, it, vi } from 'vitest'
import type { CommentThread } from '@tabtin/tabdoc-ui/api-client'
import { acquireSharedCommentThreadReload } from './sharedCommentThreadReload'

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('sharedCommentThreadReload', () => {
  it('瞬时错误后新窗格同时收到最后成功快照与可恢复错误', async () => {
    const lastSuccess = {
      threads: [
        { id: 'thread-1', messages: [], scope: 'document', status: 'open' },
      ] as CommentThread[],
      capabilities: ['comment_threads_v1'],
    }
    const transientError = Object.assign(new Error('Service Unavailable'), {
      status: 503,
    })
    const load = vi
      .fn()
      .mockResolvedValueOnce(lastSuccess)
      .mockRejectedValueOnce(transientError)
    const clientKey = {}
    const firstListener = { onSuccess: vi.fn(), onError: vi.fn() }
    const first = acquireSharedCommentThreadReload({
      clientKey,
      documentId: 'doc-1',
      load,
      listener: firstListener,
    })

    await vi.waitFor(() =>
      expect(firstListener.onSuccess).toHaveBeenCalledWith(lastSuccess),
    )
    first.request('realtime_message')
    await vi.waitFor(() =>
      expect(firstListener.onError).toHaveBeenCalledWith(transientError),
    )

    const secondListener = { onSuccess: vi.fn(), onError: vi.fn() }
    const second = acquireSharedCommentThreadReload({
      clientKey,
      documentId: 'doc-1',
      load,
      listener: secondListener,
    })
    await flushMicrotasks()

    expect(secondListener.onSuccess).toHaveBeenCalledWith(lastSuccess)
    expect(secondListener.onError).toHaveBeenCalledWith(transientError)

    first.release()
    second.release()
  })

  it('同一渲染周期重挂复用初始请求与实时订阅', async () => {
    const load = vi
      .fn()
      .mockResolvedValue({ threads: [], capabilities: ['comment_threads_v1'] })
    const subscribe = vi.fn().mockReturnValue({ unsubscribe: vi.fn() })
    const clientKey = {}
    const first = acquireSharedCommentThreadReload({
      clientKey,
      documentId: 'doc-remount',
      load,
      listener: { onSuccess: vi.fn(), onError: vi.fn() },
    })
    first.ensureRealtimeSubscription(subscribe)
    first.release()

    const second = acquireSharedCommentThreadReload({
      clientKey,
      documentId: 'doc-remount',
      load,
      listener: { onSuccess: vi.fn(), onError: vi.fn() },
    })
    second.ensureRealtimeSubscription(subscribe)
    await flushMicrotasks()

    expect(load).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)

    second.release()
    await flushMicrotasks()
  })
})
