import { describe, expect, it, vi } from 'vitest'
import {
  createCommentThreadReloadCoordinator,
  type CommentThreadReloadBatch,
  type CommentThreadReloadDiagnostic,
} from './commentThreadReloadCoordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('commentThreadReloadCoordinator', () => {
  it.each([1, 4, 9])(
    '%i 张图对应的重复 thread/message 事件仍只有一次刷新',
    async (imageCount) => {
      const batches: CommentThreadReloadBatch[] = []
      const load = vi.fn(async (batch: CommentThreadReloadBatch) => {
        batches.push(batch)
        return 'ok'
      })
      const coordinator = createCommentThreadReloadCoordinator({
        load,
        onSuccess: vi.fn(),
        onError: vi.fn(),
      })

      for (let index = 0; index < imageCount; index += 1) {
        coordinator.request('realtime_thread')
        coordinator.request('realtime_message')
      }
      await flushMicrotasks()

      expect(load).toHaveBeenCalledTimes(1)
      expect(batches[0]).toMatchObject({
        reasons: ['realtime_thread', 'realtime_message'],
        mergedCount: imageCount * 2 - 1,
        requestSequence: 1,
      })
    },
  )

  it('在途风暴最多排队一次后续刷新，并记录递增请求序号', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const diagnostics: CommentThreadReloadDiagnostic[] = []
    const load = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const onSuccess = vi.fn()
    const coordinator = createCommentThreadReloadCoordinator({
      load,
      onSuccess,
      onError: vi.fn(),
      onDiagnostic: (event) => diagnostics.push(event),
    })

    coordinator.request('initial')
    await flushMicrotasks()
    expect(load).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 100; index += 1) {
      coordinator.request(
        index % 2 === 0 ? 'realtime_thread' : 'realtime_message',
      )
    }
    expect(load).toHaveBeenCalledTimes(1)

    first.resolve('first')
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))

    second.resolve('second')
    await flushMicrotasks()
    expect(load).toHaveBeenCalledTimes(2)
    expect(onSuccess).toHaveBeenCalledTimes(2)
    expect(
      diagnostics
        .filter((event) => event.phase === 'start')
        .map((event) => event.requestSequence),
    ).toEqual([1, 2])
  })

  it('卸载后不提交陈旧成功或失败结果', async () => {
    const pending = deferred<string>()
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const coordinator = createCommentThreadReloadCoordinator({
      load: () => pending.promise,
      onSuccess,
      onError,
    })

    coordinator.request('initial')
    await flushMicrotasks()
    coordinator.dispose()
    pending.resolve('stale')
    await flushMicrotasks()

    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
