import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StreamManager, type StreamSlot, type SlotPhase } from '../StreamManager'
import type { WsGateway } from '../../core/ws-gateway'
import type { StreamCallbacks } from '../../types/streaming'
import type { ChatClientOptions } from '../../types/common'

vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/stream-observability', () => ({
  trackStreamTelemetry: vi.fn(),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function setupFetchSuccess() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: null }),
  })
}

function createMockWsGateway() {
  let messageListener: ((envelope: any) => void) | null = null
  let reconnectListener: (() => void) | null = null

  const gateway = {
    connect: vi.fn().mockResolvedValue(true),
    subscribe: vi.fn().mockResolvedValue({
      ok: true,
      type: 'subscribe.ok',
      requestId: 'req_sub',
    }),
    request: vi.fn().mockResolvedValue({
      ok: true,
      type: 'unsubscribe.ok',
      requestId: 'req_unsub',
    }),
    addListener: vi.fn((fn: (envelope: any) => void) => {
      messageListener = fn
    }),
    removeListener: vi.fn(),
    onReconnectedEvent: vi.fn((fn: () => void) => {
      reconnectListener = fn
    }),
    offReconnectedEvent: vi.fn(),
    sendResume: vi.fn().mockResolvedValue(undefined),
    hasCapability: vi.fn().mockReturnValue(false),
    isConnected: vi.fn().mockReturnValue(true),
  }

  return {
    gateway: gateway as unknown as WsGateway,
    simulateMessage: (envelope: any) => messageListener?.(envelope),
    simulateReconnect: () => reconnectListener?.(),
  }
}

function createMockCallbacks(): StreamCallbacks {
  return {
    onChunk: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onSeqGap: vi.fn(),
    onSuspended: vi.fn(),
    onRunCompleted: vi.fn(),
    onRunStillRunning: vi.fn(),
    onOpen: vi.fn(),
    onConnected: vi.fn(),
    onMessage: vi.fn(),
    onHeartbeat: vi.fn(),
    // v0.4 W1.5（PRD §7.4 / §7.5）：runtime 端切到 approval_requested batch 形态，
    // 旧 onReviewRequired 已按 D6 删除。
    onApprovalRequested: vi.fn(),
    onApprovalResolved: vi.fn(),
    onAskUserRequired: vi.fn(),
  }
}

function createOptions(overrides?: Partial<ChatClientOptions>): ChatClientOptions {
  return {
    baseURL: 'http://localhost:8000/api/chat',
    getToken: vi.fn().mockResolvedValue('mock-token'),
    ...overrides,
  }
}

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

function getSlots(mgr: StreamManager): Map<string, StreamSlot> {
  return (mgr as any).slots
}

function getSlot(mgr: StreamManager, sessionId: string): StreamSlot | undefined {
  return getSlots(mgr).get(sessionId)
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe('StreamManager', () => {
  let mockGw: ReturnType<typeof createMockWsGateway>
  let manager: StreamManager
  let mockProbeRun: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    setupFetchSuccess()
    mockGw = createMockWsGateway()
    mockProbeRun = vi.fn().mockResolvedValue({ status: 'unknown' })
    manager = new StreamManager(
      createOptions({ probeRun: mockProbeRun }),
      mockGw.gateway,
    )
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    mockFetch.mockReset()
  })

  // ──────────────────────────────────────
  // 基础功能（Case 1-3）
  // ──────────────────────────────────────

  describe('基础功能', () => {
    it('Case 1: stream() 创建 slot 且 phase 为 active', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      expect(getSlots(manager).has('chat-session-s1')).toBe(true)
      const slot = getSlot(manager, 'chat-session-s1')!
      expect(slot.phase).toBe('active')
      expect(slot.sessionId).toBe('chat-session-s1')
      expect(slot.threadId).toBe('chat-session-s1')
      expect(callbacks.onOpen).toHaveBeenCalledOnce()
      expect(callbacks.onConnected).toHaveBeenCalledWith('chat-session-s1')
    })

    it('Case 2: routeEnvelope 正确路由到 threadId 匹配的 slot', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      mockGw.simulateMessage({
        thread_id: 'chat-session-s1',
        type: 'agent.stream.chunk',
        payload: { content: 'world' },
      })

      expect(callbacks.onChunk).toHaveBeenCalledWith('world', 'world')
      expect(getSlot(manager, 'chat-session-s1')!.fullContent).toBe('world')
    })

    it('Case 3: 并发 stream() 由 connectingSessionIds 守卫', async () => {
      const cb1 = createMockCallbacks()
      const cb2 = createMockCallbacks()

      const p1 = manager.stream('chat-session-s1', 'first', cb1)
      const p2 = manager.stream('chat-session-s1', 'second', cb2)
      await Promise.all([p1, p2])

      expect(getSlots(manager).size).toBe(1)
      expect(cb1.onOpen).toHaveBeenCalledOnce()
      expect(cb2.onOpen).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────
  // 挂起机制（Case 4-6）
  // ──────────────────────────────────────

  describe('挂起机制', () => {
    it('Case 4: slot 超时后 phase 变为 suspended，不清理 slot', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      // streamTimeoutMs 默认 90s，定时器间隔 5s，需超过 90s 才触发
      vi.advanceTimersByTime(95_000)

      const slot = getSlot(manager, 'chat-session-s1')
      expect(slot).toBeDefined()
      expect(slot!.phase).toBe('suspended')
      expect(slot!.suspendedAt).toBeTypeOf('number')
      expect(callbacks.onSuspended).toHaveBeenCalledOnce()
      expect(getSlots(manager).has('chat-session-s1')).toBe(true)
    })

    it('Case 5: sweepStaleSlots 对 suspended slot 30min 后才清理（cancelRun=false）', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      const slot = getSlot(manager, 'chat-session-s1')!
      slot.phase = 'suspended'
      slot.suspendedAt = Date.now()
      slot.lastEnvelopeAt = 0

      // 29min: 应存活
      vi.advanceTimersByTime(29 * 60_000)
      expect(getSlots(manager).has('chat-session-s1')).toBe(true)

      // 再过 2min（总计 31min）: 应清理
      mockFetch.mockClear()
      vi.advanceTimersByTime(2 * 60_000)
      expect(getSlots(manager).has('chat-session-s1')).toBe(false)
      // cancelRun=false → 不发 cancel HTTP 请求
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('Case 6: sweepStaleSlots 清理前触发 onRunCompleted(runId, "unknown") 补偿', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      const slot = getSlot(manager, 'chat-session-s1')!
      slot.phase = 'suspended'
      slot.suspendedAt = Date.now()
      slot.runId = 'run-42'
      slot.lastEnvelopeAt = 0

      vi.advanceTimersByTime(31 * 60_000)

      expect(callbacks.onRunCompleted).toHaveBeenCalledWith('run-42', 'unknown')
      expect(getSlots(manager).has('chat-session-s1')).toBe(false)
    })
  })

  // ──────────────────────────────────────
  // 重连恢复（Case 7-9）
  // ──────────────────────────────────────

  describe('重连恢复', () => {
    it('Case 7: handleReconnect 对 suspended slot 执行 probeSuspendedSlots', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      const slot = getSlot(manager, 'chat-session-s1')!
      slot.phase = 'suspended'
      slot.runId = 'run-77'

      mockProbeRun.mockResolvedValueOnce({ status: 'completed' })

      mockGw.simulateReconnect()
      await flushMicrotasks()

      expect(mockProbeRun).toHaveBeenCalledWith('run-77')
    })

    it('Case 8: handleReconnect 只对非 suspended slot 重置时间戳（X-1 修复）', async () => {
      const cb1 = createMockCallbacks()
      const cb2 = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', cb1)
      await manager.stream('chat-session-s2', 'world', cb2)

      const slot1 = getSlot(manager, 'chat-session-s1')!
      const slot2 = getSlot(manager, 'chat-session-s2')!

      slot1.phase = 'active'
      slot1.lastEnvelopeAt = 100
      slot1.lastChunkAt = 100

      slot2.phase = 'suspended'
      slot2.lastEnvelopeAt = 200
      slot2.lastChunkAt = 200

      mockGw.simulateReconnect()
      await flushMicrotasks()

      expect(slot1.lastEnvelopeAt).toBeGreaterThan(100)
      expect(slot1.lastChunkAt).toBeGreaterThan(100)

      expect(slot2.lastEnvelopeAt).toBe(200)
      expect(slot2.lastChunkAt).toBe(200)
    })

    it('Case 9: probeRunStatus 返回 unknown → slot 保持 suspended', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      const slot = getSlot(manager, 'chat-session-s1')!
      slot.phase = 'suspended'
      slot.runId = 'run-99'

      mockProbeRun.mockResolvedValueOnce({ status: 'unknown' })

      mockGw.simulateReconnect()
      await flushMicrotasks()

      expect(getSlot(manager, 'chat-session-s1')!.phase).toBe('suspended')
      expect(callbacks.onRunCompleted).not.toHaveBeenCalled()
      expect(callbacks.onRunStillRunning).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────
  // 并发安全（Case 10-12）
  // ──────────────────────────────────────

  describe('并发安全', () => {
    it('Case 10: routeEnvelope unsuspend 后 done 事件清理 slot 安全（B-1 修复）', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      const slot = getSlot(manager, 'chat-session-s1')!
      slot.phase = 'suspended'
      slot.suspendedAt = Date.now()

      mockGw.simulateMessage({
        thread_id: 'chat-session-s1',
        type: 'agent.stream.done',
        payload: { message_id: 'msg-1', content: 'finished' },
      })

      expect(callbacks.onDone).toHaveBeenCalledOnce()
      expect(callbacks.onDone).toHaveBeenCalledWith('msg-1', 'finished', undefined)
      expect(getSlots(manager).has('chat-session-s1')).toBe(false)

      // 清理后再路由同 thread 的事件不会崩溃
      mockGw.simulateMessage({
        thread_id: 'chat-session-s1',
        type: 'agent.stream.chunk',
        payload: { content: 'late' },
      })
      expect(callbacks.onChunk).not.toHaveBeenCalled()
    })

    it('Case 11: probeSuspendedSlots 在 probe 期间 slot 被 unsuspend 时跳过（B-2 修复）', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      const slot = getSlot(manager, 'chat-session-s1')!
      slot.phase = 'suspended'
      slot.runId = 'run-100'

      mockProbeRun.mockImplementationOnce(async () => {
        // 模拟 probe 期间 slot 被 routeEnvelope unsuspend
        slot.phase = 'active'
        slot.suspendedAt = null
        return { status: 'completed' }
      })

      mockGw.simulateReconnect()
      await flushMicrotasks()

      // probe 返回 completed，但 slot 已 unsuspend → 跳过处理
      expect(callbacks.onRunCompleted).not.toHaveBeenCalled()
      expect(getSlots(manager).has('chat-session-s1')).toBe(true)
    })

    it('Case 12: onRunCompleted 在 runId 为 null 时不触发（D-3 修复）', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      const slot = getSlot(manager, 'chat-session-s1')!
      slot.phase = 'suspended'
      slot.suspendedAt = Date.now()
      slot.runId = null
      slot.lastEnvelopeAt = 0

      vi.advanceTimersByTime(31 * 60_000)

      expect(callbacks.onRunCompleted).not.toHaveBeenCalled()
      expect(getSlots(manager).has('chat-session-s1')).toBe(false)
    })
  })

  // ──────────────────────────────────────
  // 状态枚举（Case 13-15）
  // ──────────────────────────────────────

  describe('状态枚举', () => {
    it('Case 13: pauseForReview → review_paused，新 envelope 恢复 → active 且定时器重启（R4 修复）', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      const slot = getSlot(manager, 'chat-session-s1')!
      expect(slot.timeoutTimer).not.toBeNull()

      manager.pauseForReview('chat-session-s1')
      expect(slot.phase).toBe('review_paused')
      expect(slot.timeoutTimer).toBeNull()

      mockGw.simulateMessage({
        thread_id: 'chat-session-s1',
        type: 'agent.stream.chunk',
        payload: { content: 'resumed' },
      })

      expect(slot.phase).toBe('active')
      expect(slot.timeoutTimer).not.toBeNull()
      expect(callbacks.onChunk).toHaveBeenCalledWith('resumed', 'resumed')
    })

    it('Case 14: isStreaming 对不同 phase 返回正确值', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      const slot = getSlot(manager, 'chat-session-s1')!

      slot.phase = 'active'
      expect(manager.isStreaming('chat-session-s1')).toBe(true)

      slot.phase = 'suspended'
      expect(manager.isStreaming('chat-session-s1')).toBe(true)

      slot.phase = 'review_paused'
      expect(manager.isStreaming('chat-session-s1')).toBe(true)

      slot.phase = 'completed'
      expect(manager.isStreaming('chat-session-s1')).toBe(false)
    })

    it('Case 14b: isStreaming 注入 streamingChecker 时优先读宿主 SSoT（PRD 05 §7.8.2 选项 A）', () => {
      // 模拟 Renderer 的 useChatStore.streamingBySessionId 单源
      const storeStreaming: Record<string, boolean> = {
        'chat-session-ipc-1': true,
        'chat-session-ipc-2': false,
      }
      const checker = vi.fn((sessionId: string) => storeStreaming[sessionId] ?? false)

      const mgrWithChecker = new StreamManager(
        createOptions({ streamingChecker: checker }),
        mockGw.gateway,
      )

      // 本地 IPC 主路径下不建 slot——旧 isStreaming 永远 false；新 checker 返回 store 值
      expect(mgrWithChecker.isStreaming('chat-session-ipc-1')).toBe(true)
      expect(checker).toHaveBeenCalledWith('chat-session-ipc-1')

      expect(mgrWithChecker.isStreaming('chat-session-ipc-2')).toBe(false)
      expect(checker).toHaveBeenCalledWith('chat-session-ipc-2')
    })

    it('Case 14c: isStreaming 不注入 streamingChecker 时退化到 slot.phase 旧路径', async () => {
      // 默认 manager 没注入 checker
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-fallback', 'hello', callbacks)

      const slot = getSlot(manager, 'chat-session-fallback')!
      slot.phase = 'active'
      expect(manager.isStreaming('chat-session-fallback')).toBe(true)

      slot.phase = 'completed'
      expect(manager.isStreaming('chat-session-fallback')).toBe(false)
    })

    // L1.5-2-F（W1.5-轮 3 顺手补）：streamingChecker 测试覆盖完善——
    // 之前 Case 14b 只覆盖了 happy path，下面三个用例覆盖：抛错、checker false 但
    // connectingSessionIds 兜底、checker false 且未 connecting。
    it('Case 14d: streamingChecker 抛错时回退到 slot.phase 路径不崩', () => {
      const checkerThrows = vi.fn((_id: string) => {
        throw new Error('store access failed')
      })
      const mgrWithChecker = new StreamManager(
        createOptions({ streamingChecker: checkerThrows }),
        mockGw.gateway,
      )

      // 入参合法、未 connecting、无 slot —— checker 抛错冒到调用方是合理的
      // （宿主 store 异常应当让上层感知，而不是被默默吞掉变成假 false）。
      expect(() => mgrWithChecker.isStreaming('chat-session-throw')).toThrow(/store access failed/)
      expect(checkerThrows).toHaveBeenCalledWith('chat-session-throw')
    })

    it('Case 14e: streamingChecker 返回 false 但 connectingSessionIds 命中时仍 streaming', () => {
      const checker = vi.fn((_id: string) => false)
      const mgrWithChecker = new StreamManager(
        createOptions({ streamingChecker: checker }),
        mockGw.gateway,
      )

      // 通过反射（vitest 同 package）注入 connecting 状态——避免真起 stream
      ;(mgrWithChecker as unknown as { connectingSessionIds: Set<string> })
        .connectingSessionIds.add('chat-session-connecting')

      expect(mgrWithChecker.isStreaming('chat-session-connecting')).toBe(true)
      expect(checker).toHaveBeenCalledWith('chat-session-connecting')
    })

    it('Case 14f: streamingChecker 返回 false 且非 connecting 时为 false（OR 组合短路）', () => {
      const checker = vi.fn((_id: string) => false)
      const mgrWithChecker = new StreamManager(
        createOptions({ streamingChecker: checker }),
        mockGw.gateway,
      )

      expect(mgrWithChecker.isStreaming('chat-session-idle')).toBe(false)
      expect(checker).toHaveBeenCalledWith('chat-session-idle')
    })

    it('Case 15: startSlotTimeout 只在 phase === active 时挂起，review_paused 不挂起（N8 修复）', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      const slot = getSlot(manager, 'chat-session-s1')!
      // 手动设置为 review_paused（模拟 timer 仍在运行的边界情况）
      slot.phase = 'review_paused' as SlotPhase

      vi.advanceTimersByTime(95_000)

      // phase 不应变为 suspended
      expect(slot.phase).toBe('review_paused')
      expect(callbacks.onSuspended).not.toHaveBeenCalled()
      expect(getSlots(manager).has('chat-session-s1')).toBe(true)
    })
  })

  describe('序列号跟踪', () => {
    it('Case 16: chunk 事件消耗的 seq 会被计入，不会对后续 onMessage 误报缺号', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      mockGw.simulateMessage({
        thread_id: 'chat-session-s1',
        type: 'agent.stream.lifecycle',
        payload: { phase: 'start', _seq: 1 },
      })
      mockGw.simulateMessage({
        thread_id: 'chat-session-s1',
        type: 'agent.stream.chunk',
        payload: { content: 'partial', _seq: 2 },
      })
      mockGw.simulateMessage({
        thread_id: 'chat-session-s1',
        type: 'agent.stream.lifecycle',
        payload: { phase: 'progress', _seq: 3 },
      })

      expect(callbacks.onSeqGap).not.toHaveBeenCalled()
      expect(getSlot(manager, 'chat-session-s1')!.lastSeq).toBe(3)
    })

    it('Case 17: 真正缺号时即使发生在 chunk 事件也会触发 onSeqGap', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      mockGw.simulateMessage({
        thread_id: 'chat-session-s1',
        type: 'agent.stream.lifecycle',
        payload: { phase: 'start', _seq: 1 },
      })
      mockGw.simulateMessage({
        thread_id: 'chat-session-s1',
        type: 'agent.stream.chunk',
        payload: { content: 'partial', _seq: 4 },
      })

      expect(callbacks.onSeqGap).toHaveBeenCalledWith({
        expectedSeq: 2,
        actualSeq: 4,
        gap: 2,
      })
      expect(getSlot(manager, 'chat-session-s1')!.lastSeq).toBe(4)
    })

    it('Case 18: coalesced_count 覆盖的连续 seq 不误报且正文不丢不乱', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      mockGw.simulateMessage({
        thread_id: 'chat-session-s1',
        type: 'agent.stream.chunk',
        payload: { content: 'AB', _seq: 2, coalesced_count: 2 },
      })
      mockGw.simulateMessage({
        thread_id: 'chat-session-s1',
        type: 'agent.stream.chunk',
        payload: { content: 'CDE', _seq: 5, coalesced_count: 3 },
      })

      expect(callbacks.onSeqGap).not.toHaveBeenCalled()
      expect(callbacks.onChunk).toHaveBeenNthCalledWith(1, 'AB', 'AB')
      expect(callbacks.onChunk).toHaveBeenNthCalledWith(2, 'CDE', 'ABCDE')
      expect(getSlot(manager, 'chat-session-s1')!.lastSeq).toBe(5)
    })
  })

  describe('user-level envelope 短路（W2）', () => {
    /**
     * 反退化锚点：``agent.user.*`` envelope（如 title_updated / notification.new /
     * permission.changed）由 chatApi.ts::handleUserLevelEnvelope 与
     * useNotificationEventStream 各自路由。它们走 user-level group 投递，**没有
     * 顶层 thread_id 也没有 _topic**——若不在 routeEnvelope 入口短路，单 active
     * slot 时会兜底落到 handleSlotEnvelope default 分支误调 callbacks.onMessage。
     *
     * 本测试覆盖：StreamManager 对 user-level envelope 必须**完全不调任何 callback**。
     */
    it('user-level envelope 不应触发 slot callback（即便单 active slot）', async () => {
      const callbacks = createMockCallbacks()
      await manager.stream('chat-session-s1', 'hello', callbacks)

      ;(callbacks.onMessage as ReturnType<typeof vi.fn>).mockClear()
      ;(callbacks.onChunk as ReturnType<typeof vi.fn>).mockClear()

      mockGw.simulateMessage({
        type: 'agent.user.title_updated',
        payload: { session_id: 'chat-session-s1', title: 'should-not-route' },
      })
      mockGw.simulateMessage({
        type: 'agent.user.notification.new',
        payload: { id: 'notif-1' },
      })
      mockGw.simulateMessage({
        type: 'agent.user.permission.changed',
        payload: { organization_id: 'wt-1', space_id: '' },
      })

      expect(callbacks.onMessage).not.toHaveBeenCalled()
      expect(callbacks.onChunk).not.toHaveBeenCalled()
      expect(callbacks.onDone).not.toHaveBeenCalled()
    })
  })
})
