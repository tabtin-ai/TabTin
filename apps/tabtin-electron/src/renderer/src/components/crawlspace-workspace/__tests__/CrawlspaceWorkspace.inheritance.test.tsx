import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAfterViewControlInheritance } from '../CrawlspaceWorkspace'

describe('CrawlspaceWorkspace 派生 view 继承屏障', () => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const ipc = {
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      const channelListeners = listeners.get(channel) ?? []
      channelListeners.push(listener)
      listeners.set(channel, channelListeners)
      return () => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((candidate) => candidate !== listener),
        )
      }
    }),
    send: vi.fn(),
  }

  function emit(channel: string, payload: unknown): void {
    for (const listener of [...(listeners.get(channel) ?? [])]) {
      listener({}, payload)
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    listeners.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0)
    expect(listeners.get('workspace:create-view:inherited') ?? []).toHaveLength(0)
    vi.useRealTimers()
  })

  it('switchView 不早于 main 的 inherited 确认', async () => {
    const switchView = vi.fn()
    const closeView = vi.fn()
    const flow = runAfterViewControlInheritance(
      ipc,
      { requestId: 'request-1', viewId: 'view-new' },
      switchView,
      { timeoutMs: 1000, closeView },
    )

    await Promise.resolve()
    expect(ipc.send).toHaveBeenCalledWith('workspace:create-view:created', {
      requestId: 'request-1',
      viewId: 'view-new',
    })
    expect(switchView).not.toHaveBeenCalled()

    emit('workspace:create-view:inherited', {
      requestId: 'request-1',
      viewId: 'view-other',
    })
    await Promise.resolve()
    expect(switchView).not.toHaveBeenCalled()

    emit('workspace:create-view:inherited', {
      requestId: 'request-1',
      viewId: 'view-new',
    })
    await flow

    expect(switchView).toHaveBeenCalledTimes(1)
    expect(closeView).not.toHaveBeenCalled()
  })

  it('确认超时后关闭新 view 且不激活', async () => {
    const switchView = vi.fn()
    const closeView = vi.fn()
    const onFailure = vi.fn()
    const flow = runAfterViewControlInheritance(
      ipc,
      { requestId: 'request-timeout', viewId: 'view-new' },
      switchView,
      { timeoutMs: 1000, closeView, onFailure },
    )

    await vi.advanceTimersByTimeAsync(1000)
    await flow

    expect(onFailure).toHaveBeenCalledWith('timeout', undefined)
    expect(closeView).toHaveBeenCalledTimes(1)
    expect(switchView).not.toHaveBeenCalled()
  })

  it('组件卸载取消等待时关闭新 view、释放 listener 和 timer，且不再激活', async () => {
    const controller = new AbortController()
    const switchView = vi.fn()
    const closeView = vi.fn()
    let settled = false
    const flow = runAfterViewControlInheritance(
      ipc,
      { requestId: 'request-unmounted', viewId: 'view-new' },
      switchView,
      { timeoutMs: 1000, signal: controller.signal, closeView },
    ).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(listeners.get('workspace:create-view:inherited') ?? []).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)

    controller.abort()
    await flow

    expect(settled).toBe(true)
    expect(listeners.get('workspace:create-view:inherited') ?? []).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(closeView).toHaveBeenCalledTimes(1)
    expect(switchView).not.toHaveBeenCalled()
  })

  it('超时关闭后迟到确认不会激活或重复关闭', async () => {
    const switchView = vi.fn()
    const closeView = vi.fn()
    const flow = runAfterViewControlInheritance(
      ipc,
      { requestId: 'request-late-confirm', viewId: 'view-new' },
      switchView,
      { timeoutMs: 1000, closeView },
    )

    await vi.advanceTimersByTimeAsync(1000)
    await flow
    emit('workspace:create-view:inherited', {
      requestId: 'request-late-confirm',
      viewId: 'view-new',
    })
    await Promise.resolve()

    expect(closeView).toHaveBeenCalledTimes(1)
    expect(switchView).not.toHaveBeenCalled()
  })

  it('发送 created 失败时关闭新 view 且不激活', async () => {
    const sendError = new Error('renderer unavailable')
    ipc.send.mockImplementationOnce(() => {
      throw sendError
    })
    const switchView = vi.fn()
    const closeView = vi.fn()
    const onFailure = vi.fn()

    await runAfterViewControlInheritance(
      ipc,
      { requestId: 'request-send-failed', viewId: 'view-new' },
      switchView,
      { timeoutMs: 1000, closeView, onFailure },
    )

    expect(onFailure).toHaveBeenCalledWith('send-failed', sendError)
    expect(closeView).toHaveBeenCalledTimes(1)
    expect(switchView).not.toHaveBeenCalled()
  })
})
