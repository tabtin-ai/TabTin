/**
 * StreamManager multi-stream tests.
 *
 * Uses a lightweight WsGateway stub so we can exercise the slot lifecycle,
 * event routing, abort logic and reconnect behaviour without a real WebSocket.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamManager } from '../../../../../packages/tabtin-chat-client/src/managers/StreamManager'

// ────────────────────────────────────────────────────────────
// Minimal WsGateway stub
// ────────────────────────────────────────────────────────────

function createMockGateway() {
  const listeners = new Set<(envelope: any) => void>()
  const reconnectedListeners = new Set<() => void>()
  const subscribedTopics: string[][] = []
  const unsubscribedTopics: string[][] = []

  const gateway = {
    connect: vi.fn().mockResolvedValue(true),
    subscribe: vi.fn().mockImplementation((topics: string[]) => {
      subscribedTopics.push(topics)
      return Promise.resolve({ ok: true })
    }),
    request: vi.fn().mockImplementation((_type: string, payload: any) => {
      if (_type === 'unsubscribe') unsubscribedTopics.push(payload.topics)
      return Promise.resolve({ ok: true })
    }),
    addListener: vi.fn().mockImplementation((fn: any) => listeners.add(fn)),
    removeListener: vi.fn().mockImplementation((fn: any) => listeners.delete(fn)),
    onReconnectedEvent: vi.fn().mockImplementation((fn: any) => reconnectedListeners.add(fn)),
    offReconnectedEvent: vi.fn().mockImplementation((fn: any) => reconnectedListeners.delete(fn)),
    hasCapability: vi.fn().mockReturnValue(false),
    isConnected: vi.fn().mockReturnValue(true),
    getConnectionStatus: vi.fn().mockReturnValue('ready'),
    sendResume: vi.fn().mockResolvedValue(undefined),

    // helpers for testing
    _emit(envelope: any) { for (const fn of listeners) fn(envelope) },
    _reconnect() { for (const fn of reconnectedListeners) fn() },
    _listeners: listeners,
    _reconnectedListeners: reconnectedListeners,
    _subscribedTopics: subscribedTopics,
    _unsubscribedTopics: unsubscribedTopics,
  }

  return gateway
}

type MockGateway = ReturnType<typeof createMockGateway>

function createManager(gw: MockGateway) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: null }),
    text: () => Promise.resolve(''),
  }) as any
  return new StreamManager(
    {
      baseURL: 'https://example.com/api/chat',
      getToken: () => 'test-token',
    },
    gw as any,
  )
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe('StreamManager multi-stream', () => {
  let gw: MockGateway
  let sm: StreamManager

  beforeEach(() => {
    vi.restoreAllMocks()
    gw = createMockGateway()
    sm = createManager(gw)
  })

  describe('single stream (backward compat)', () => {
    it('creates a slot on stream()', async () => {
      const cb = { onChunk: vi.fn() }
      await sm.stream('sess-1', 'hi', cb)
      expect(sm.isStreaming()).toBe(true)
      expect(sm.isStreaming('sess-1')).toBe(true)
      expect(sm.isStreaming('sess-2')).toBe(false)
    })

    it('skips duplicate stream() for same session', async () => {
      const cb1 = { onChunk: vi.fn() }
      const cb2 = { onChunk: vi.fn() }
      await sm.stream('sess-1', 'hi', cb1)
      await sm.stream('sess-1', 'hi again', cb2)
      expect(gw._subscribedTopics.length).toBe(1)
    })

    it('routes events by thread_id', async () => {
      const onChunk = vi.fn()
      await sm.stream('sess-1', 'hi', { onChunk })
      gw._emit({
        thread_id: 'chat-session-sess-1',
        type: 'agent.stream.chunk',
        payload: { content: 'hello' },
      })
      expect(onChunk).toHaveBeenCalledWith('hello', 'hello')
    })

    it('abort() cleans up', async () => {
      await sm.stream('sess-1', 'hi', {})
      await sm.abortAndWait()
      expect(sm.isStreaming()).toBe(false)
      expect(sm.isStreaming('sess-1')).toBe(false)
    })
  })

  describe('concurrent streams', () => {
    it('supports two sessions simultaneously', async () => {
      const chunkA = vi.fn()
      const chunkB = vi.fn()
      await sm.stream('sess-a', 'hi A', { onChunk: chunkA })
      await sm.stream('sess-b', 'hi B', { onChunk: chunkB })

      expect(sm.isStreaming('sess-a')).toBe(true)
      expect(sm.isStreaming('sess-b')).toBe(true)
      expect(gw._subscribedTopics.length).toBe(2)
    })

    it('routes events to correct session', async () => {
      const chunkA = vi.fn()
      const chunkB = vi.fn()
      await sm.stream('sess-a', 'hi A', { onChunk: chunkA })
      await sm.stream('sess-b', 'hi B', { onChunk: chunkB })

      gw._emit({
        thread_id: 'chat-session-sess-a',
        type: 'agent.stream.chunk',
        payload: { content: 'for A' },
      })
      gw._emit({
        thread_id: 'chat-session-sess-b',
        type: 'agent.stream.chunk',
        payload: { content: 'for B' },
      })

      expect(chunkA).toHaveBeenCalledWith('for A', 'for A')
      expect(chunkB).toHaveBeenCalledWith('for B', 'for B')
      expect(chunkA).not.toHaveBeenCalledWith('for B', expect.anything())
      expect(chunkB).not.toHaveBeenCalledWith('for A', expect.anything())
    })

    it('abortSession() only affects target session', async () => {
      const errA = vi.fn()
      const errB = vi.fn()
      await sm.stream('sess-a', 'hi A', { onError: errA })
      await sm.stream('sess-b', 'hi B', { onError: errB })

      await sm.abortSession('sess-a')

      expect(sm.isStreaming('sess-a')).toBe(false)
      expect(sm.isStreaming('sess-b')).toBe(true)
      expect(sm.isStreaming()).toBe(true)
    })

    it('abortAll() cleans up everything', async () => {
      await sm.stream('sess-a', 'hi A', {})
      await sm.stream('sess-b', 'hi B', {})

      await sm.abortAll()

      expect(sm.isStreaming()).toBe(false)
      expect(sm.isStreaming('sess-a')).toBe(false)
      expect(sm.isStreaming('sess-b')).toBe(false)
    })

    it('accumulates fullContent independently per session', async () => {
      const chunkA = vi.fn()
      const chunkB = vi.fn()
      await sm.stream('sess-a', 'a', { onChunk: chunkA })
      await sm.stream('sess-b', 'b', { onChunk: chunkB })

      gw._emit({ thread_id: 'chat-session-sess-a', type: 'agent.stream.chunk', payload: { content: 'A1' } })
      gw._emit({ thread_id: 'chat-session-sess-b', type: 'agent.stream.chunk', payload: { content: 'B1' } })
      gw._emit({ thread_id: 'chat-session-sess-a', type: 'agent.stream.chunk', payload: { content: 'A2' } })

      expect(chunkA).toHaveBeenLastCalledWith('A2', 'A1A2')
      expect(chunkB).toHaveBeenLastCalledWith('B1', 'B1')
    })
  })

  describe('done / error cleanup', () => {
    it('done event cleans up the slot', async () => {
      const onDone = vi.fn()
      await sm.stream('sess-1', 'hi', { onDone })

      gw._emit({
        thread_id: 'chat-session-sess-1',
        type: 'agent.stream.done',
        payload: { message_id: 'msg-1', content: 'final' },
      })

      expect(onDone).toHaveBeenCalledWith('msg-1', 'final', undefined)
      expect(sm.isStreaming('sess-1')).toBe(false)
    })

    it('error event cleans up the slot', async () => {
      const onError = vi.fn()
      await sm.stream('sess-1', 'hi', { onError })

      gw._emit({
        thread_id: 'chat-session-sess-1',
        type: 'error',
        payload: { message: 'boom' },
      })

      expect(onError).toHaveBeenCalledWith('boom', 'unknown')
      expect(sm.isStreaming('sess-1')).toBe(false)
    })

    it('done for one session does not affect the other', async () => {
      const doneA = vi.fn()
      const doneB = vi.fn()
      await sm.stream('sess-a', 'a', { onDone: doneA })
      await sm.stream('sess-b', 'b', { onDone: doneB })

      gw._emit({
        thread_id: 'chat-session-sess-a',
        type: 'agent.stream.done',
        payload: { message_id: 'msg-a' },
      })

      expect(doneA).toHaveBeenCalled()
      expect(doneB).not.toHaveBeenCalled()
      expect(sm.isStreaming('sess-a')).toBe(false)
      expect(sm.isStreaming('sess-b')).toBe(true)
    })
  })

  describe('global handler lifecycle', () => {
    it('registers router handler on first slot, removes on last', async () => {
      expect(gw._listeners.size).toBe(0)

      await sm.stream('sess-1', 'hi', {})
      expect(gw._listeners.size).toBe(1)

      await sm.stream('sess-2', 'hi', {})
      expect(gw._listeners.size).toBe(1)

      await sm.abortSession('sess-1')
      expect(gw._listeners.size).toBe(1)

      await sm.abortSession('sess-2')
      expect(gw._listeners.size).toBe(0)
    })

    it('registers reconnect handler on first slot, removes on last', async () => {
      expect(gw._reconnectedListeners.size).toBe(0)

      await sm.stream('sess-1', 'hi', {})
      expect(gw._reconnectedListeners.size).toBe(1)

      await sm.abortSession('sess-1')
      expect(gw._reconnectedListeners.size).toBe(0)
    })
  })

  describe('reconnection', () => {
    it('re-subscribes all active slots on reconnect', async () => {
      await sm.stream('sess-a', 'a', {})
      await sm.stream('sess-b', 'b', {})

      const countBefore = gw._subscribedTopics.length
      gw._reconnect()
      // Give the async resubscribe a tick
      await new Promise(r => setTimeout(r, 10))
      expect(gw._subscribedTopics.length).toBeGreaterThan(countBefore)
    })
  })

  describe('fallback routing', () => {
    it('routes envelope without thread_id to single active slot', async () => {
      const onChunk = vi.fn()
      await sm.stream('sess-1', 'hi', { onChunk })

      gw._emit({
        type: 'agent.stream.chunk',
        payload: { content: 'no-thread-id' },
      })

      expect(onChunk).toHaveBeenCalledWith('no-thread-id', 'no-thread-id')
    })

    it('ignores envelope without thread_id when multiple slots active', async () => {
      const chunkA = vi.fn()
      const chunkB = vi.fn()
      await sm.stream('sess-a', 'a', { onChunk: chunkA })
      await sm.stream('sess-b', 'b', { onChunk: chunkB })

      gw._emit({
        type: 'agent.stream.chunk',
        payload: { content: 'orphan' },
      })

      expect(chunkA).not.toHaveBeenCalled()
      expect(chunkB).not.toHaveBeenCalled()
    })
  })
})
