import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetDocMultiTabPresenceForTest,
  subscribeDocMultiTabPresence,
} from '../docMultiTabPresence'

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = []

  readonly name: string
  readonly postMessage = vi.fn((data: unknown) => {
    for (const peer of MockBroadcastChannel.instances) {
      if (peer === this || peer.closed || peer.name !== this.name) continue
      peer.onmessage?.({ data } as MessageEvent)
    }
  })
  readonly close = vi.fn(() => {
    this.closed = true
  })

  closed = false
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(name: string) {
    this.name = name
    MockBroadcastChannel.instances.push(this)
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  static reset(): void {
    MockBroadcastChannel.instances = []
  }
}

describe('docMultiTabPresence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockBroadcastChannel.reset()
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel as unknown as typeof BroadcastChannel)
    resetDocMultiTabPresenceForTest()
  })

  afterEach(() => {
    resetDocMultiTabPresenceForTest()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('同一 renderer 的多个订阅者应共享一个 channel，并只广播一次 open', () => {
    const listenerA = vi.fn()
    const listenerB = vi.fn()

    const releaseA = subscribeDocMultiTabPresence('doc-1', listenerA)
    const releaseB = subscribeDocMultiTabPresence('doc-1', listenerB)

    expect(MockBroadcastChannel.instances).toHaveLength(1)
    expect(MockBroadcastChannel.instances[0]?.postMessage).toHaveBeenCalledTimes(1)

    releaseA()
    releaseB()
    vi.runAllTimers()
  })

  it('在释放宽限期内重新订阅时，应复用同一个 session 以兼容 StrictMode 双挂载', () => {
    const listener = vi.fn()

    const releaseFirst = subscribeDocMultiTabPresence('doc-1', listener)
    const channel = MockBroadcastChannel.instances[0]

    releaseFirst()

    const releaseSecond = subscribeDocMultiTabPresence('doc-1', listener)

    expect(MockBroadcastChannel.instances).toHaveLength(1)
    expect(channel?.close).not.toHaveBeenCalled()
    expect(channel?.postMessage).toHaveBeenCalledTimes(1)

    releaseSecond()
    vi.runAllTimers()

    expect(channel?.close).toHaveBeenCalledTimes(1)
  })

  it('收到远端 open 时应通知订阅者，并回发 ack', () => {
    const listener = vi.fn()

    const release = subscribeDocMultiTabPresence('doc-1', listener)
    const channel = MockBroadcastChannel.instances[0]

    channel?.emit({ type: 'open' })

    expect(listener).toHaveBeenCalledWith({ type: 'open', runtimeId: null })
    expect(channel?.postMessage).toHaveBeenCalledTimes(2)
    expect(channel?.postMessage.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      kind: 'tabdoc-multi-tab',
      type: 'ack',
      runtimeId: expect.any(String),
    }))

    release()
    vi.runAllTimers()
  })
})
