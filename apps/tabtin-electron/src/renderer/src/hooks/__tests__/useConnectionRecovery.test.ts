/**
 * useConnectionRecovery + executeRecovery 单元测试
 *
 * 覆盖场景：
 *  1. idle→connected 不触发恢复
 *  2. connected→disconnected→connected 触发 executeRecovery
 *  3. RECOVERY_TASKS 全部成功 → recoveryInFlight 释放
 *  4. 部分 RECOVERY_TASKS 失败 → 最多 3 次重试（2s/5s/10s）
 *  5. 恢复完成后检查 Centrifugo 状态，未连接则 reconnect
 *  6. 恢复过程中 WS 再次断连 → 不重复触发
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  __resetNativeFilePickerGuardForTests,
  beginNativeFilePickerInteraction,
} from '@/utils/nativeFilePickerGuard'

// ── Hoisted mocks ──

const {
  mockLoadOrganizations,
  mockLoadSpaces,
  mockLoadDevices,
  mockRegisterCurrentDevice,
  mockEnsureDeviceRegistered,
  deviceState,
  mockFetchAccounts,
  mockLoadUnreadCount,
  mockLoadTasks,
  mockSyncSessionMessagesFromServer,
  mockLoadSessions,
  mockReconnectCentrifugo,
  mockGetChatClient,
  mockMarkSessionsSuspended,
  wsConnectionState,
  agentGatewayState,
  organizationState,
  spaceState,
  imState,
  chatState,
} = vi.hoisted(() => ({
  mockLoadOrganizations: vi.fn().mockResolvedValue(undefined),
  mockLoadSpaces: vi.fn().mockResolvedValue(undefined),
  mockLoadDevices: vi.fn().mockResolvedValue(undefined),
  mockRegisterCurrentDevice: vi.fn().mockResolvedValue(null),
  mockEnsureDeviceRegistered: vi.fn(),
  deviceState: {
    registered: true,
  },
  mockFetchAccounts: vi.fn().mockResolvedValue(undefined),
  mockLoadUnreadCount: vi.fn().mockResolvedValue(undefined),
  mockLoadTasks: vi.fn().mockResolvedValue(undefined),
  mockSyncSessionMessagesFromServer: vi.fn().mockResolvedValue(undefined),
  mockLoadSessions: vi.fn().mockResolvedValue(undefined),
  mockReconnectCentrifugo: vi.fn(),
  mockGetChatClient: vi.fn(),
  mockMarkSessionsSuspended: vi.fn(),
  wsConnectionState: {
    status: 'idle' as string,
    organizationAccessRecoveryInFlight: false,
    setNetworkOnline: vi.fn(),
    setOrganizationAccessRecoveryInFlight: vi.fn((value: boolean) => {
      wsConnectionState.organizationAccessRecoveryInFlight = value
    }),
    _subscribers: [] as Array<(state: { status: string }) => void>,
  },
  agentGatewayState: {
    status: 'idle' as string,
    _subscribers: [] as Array<(state: { status: string }) => void>,
  },
  organizationState: {
    selectedOrganization: { id: 'ws-test' } as { id: string } | null,
  },
  spaceState: {
    selectedSpace: { id: 'sp-test' } as { id: string } | null,
  },
  imState: {
    connectionStatus: 'connected' as string,
  },
  chatState: {
    currentSessionId: null as string | null,
    sessionsBySpaceId: { 'sp-test': [] } as Record<string, unknown[]>,
  },
}))

// ：busy 会话来自执行态单一投影（getBusySessionIds），测试用可控值驱动。
const busyIds = vi.hoisted(() => ({ value: [] as string[] }))
vi.mock('@/stores/chat/execution/sessionRunProjection', () => ({
  getBusySessionIds: () => busyIds.value,
  getGatewayDisconnectSuspendSessionIds: () => busyIds.value,
}))

// ── vi.mock 声明 ──

vi.mock('@/stores/useWsConnectionStore', () => {
  const store = (selector: (state: typeof wsConnectionState) => unknown) =>
    selector(wsConnectionState)

  store.getState = () => wsConnectionState
  store.subscribe = (cb: (state: { status: string }) => void) => {
    wsConnectionState._subscribers.push(cb)
    return () => {
      const idx = wsConnectionState._subscribers.indexOf(cb)
      if (idx >= 0) wsConnectionState._subscribers.splice(idx, 1)
    }
  }

  return { useWsConnectionStore: store }
})

vi.mock('@/stores/useAgentGatewayStore', () => {
  const store = (selector: (state: typeof agentGatewayState) => unknown) =>
    selector(agentGatewayState)

  store.getState = () => agentGatewayState
  store.subscribe = (cb: (state: { status: string }) => void) => {
    agentGatewayState._subscribers.push(cb)
    return () => {
      const idx = agentGatewayState._subscribers.indexOf(cb)
      if (idx >= 0) agentGatewayState._subscribers.splice(idx, 1)
    }
  }

  return { useAgentGatewayStore: store }
})

vi.mock('@/stores/useOrganizationStore', () => {
  const store = (selector: (state: any) => unknown) =>
    selector({ ...organizationState, loadOrganizations: mockLoadOrganizations })
  store.getState = () => ({ ...organizationState, loadOrganizations: mockLoadOrganizations })
  return { useOrganizationStore: store }
})

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      loadSpaces: mockLoadSpaces,
      selectedSpace: spaceState.selectedSpace,
    }),
  },
}))

vi.mock('@/stores/useDeviceStore', () => ({
  useDeviceStore: {
    getState: () => ({
      registered: deviceState.registered,
      registerCurrentDevice: mockRegisterCurrentDevice,
      loadDevices: mockLoadDevices,
    }),
  },
  ensureDeviceRegistered: mockEnsureDeviceRegistered,
}))

vi.mock('@/stores/useChannelStore', () => ({
  useChannelStore: {
    getState: () => ({ fetchAccounts: mockFetchAccounts }),
  },
}))

vi.mock('@/stores/useNotificationStore', () => ({
  useNotificationStore: {
    getState: () => ({ loadUnreadCount: mockLoadUnreadCount }),
  },
}))

vi.mock('@/stores/useTrackerStore', () => ({
  useTrackerStore: {
    getState: () => ({ loadTasks: mockLoadTasks }),
  },
}))

vi.mock('@/stores/useIMStore', () => {
  const store = (selector: (state: typeof imState) => unknown) =>
    selector(imState)
  store.getState = () => imState
  return { useIMStore: store }
})

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      currentSessionId: chatState.currentSessionId,
      sessionsBySpaceId: chatState.sessionsBySpaceId,
      syncSessionMessagesFromServer: mockSyncSessionMessagesFromServer,
      loadSessions: mockLoadSessions,
    }),
  },
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: mockGetChatClient,
}))

vi.mock('@/hooks/useCentrifugoClient', () => ({
  reconnectCentrifugo: mockReconnectCentrifugo,
}))

vi.mock('@/services/sessionSuspended', () => ({
  markSessionsSuspended: mockMarkSessionsSuspended,
}))

// ── Helpers ──

function emitWsStatus(status: string) {
  wsConnectionState.status = status
  for (const cb of [...wsConnectionState._subscribers]) {
    cb({ status })
  }
  const agentGatewayStatus =
    status === 'connected' ? 'ready' : status === 'idle' ? 'idle' : 'connecting'
  agentGatewayState.status = agentGatewayStatus
  for (const cb of [...agentGatewayState._subscribers]) {
    cb({ status: agentGatewayStatus })
  }
}

function tick(): Promise<void> {
  return new Promise((r) => queueMicrotask(r))
}

async function tickN(n: number) {
  for (let i = 0; i < n; i++) await tick()
}

async function flushRecoveryWork() {
  await tickN(10)
  await vi.dynamicImportSettled()
  await tickN(10)
}

async function mountRecoveryHook() {
  const { useConnectionRecovery } = await import('../useConnectionRecovery')
  renderHook(() => useConnectionRecovery())
  await tickN(1)
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.clearAllMocks()
  wsConnectionState.status = 'idle'
  agentGatewayState.status = 'idle'
  wsConnectionState.organizationAccessRecoveryInFlight = false
  wsConnectionState.setNetworkOnline = vi.fn()
  wsConnectionState.setOrganizationAccessRecoveryInFlight = vi.fn((value: boolean) => {
    wsConnectionState.organizationAccessRecoveryInFlight = value
  })
  wsConnectionState._subscribers = []
  agentGatewayState._subscribers = []
  organizationState.selectedOrganization = { id: 'ws-test' }
  spaceState.selectedSpace = { id: 'sp-test' }
  imState.connectionStatus = 'connected'
  chatState.currentSessionId = null
  chatState.sessionsBySpaceId = { 'sp-test': [] }
  busyIds.value = []
  deviceState.registered = true
  ;(window as any).tabtin = undefined
  mockRegisterCurrentDevice.mockResolvedValue(null)
  mockLoadOrganizations.mockResolvedValue(undefined)
  mockLoadSpaces.mockResolvedValue(undefined)
  mockLoadDevices.mockResolvedValue(undefined)
  mockFetchAccounts.mockResolvedValue(undefined)
  mockLoadUnreadCount.mockResolvedValue(undefined)
  mockLoadTasks.mockResolvedValue(undefined)
  mockSyncSessionMessagesFromServer.mockResolvedValue(undefined)
  mockLoadSessions.mockResolvedValue(undefined)
  __resetNativeFilePickerGuardForTests()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  __resetNativeFilePickerGuardForTests()
})

describe('组织 membership 重连补偿', () => {
  it('main-backed gateway 使用 forceReconnect 刷新 membership，不被 ready connect 短路', async () => {
    let organizationIds = ['old-org']
    const connect = vi.fn(async () => true)
    const close = vi.fn()
    const forceReconnect = vi.fn(async () => {
      organizationIds = ['old-org', 'target-org']
      return true
    })
    mockGetChatClient.mockReturnValue({
      getOrganizationIds: () => organizationIds,
      getGateway: () => ({ close, connect, forceReconnect }),
    })

    const { reconnectGatewayIfOrganizationNotSynced } = await import('../useConnectionRecovery')
    await reconnectGatewayIfOrganizationNotSynced('target-org')

    expect(forceReconnect).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('membership 重连失败后短退避重试，并在结束后释放 in-flight 状态', async () => {
    vi.useFakeTimers()
    let organizationIds = ['old-org']
    const close = vi.fn()
    const connect = vi.fn(async () => {
      if (connect.mock.calls.length === 2) {
        organizationIds = ['old-org', 'target-org']
        return true
      }
      return false
    })
    mockGetChatClient.mockReturnValue({
      getOrganizationIds: () => organizationIds,
      getGateway: () => ({ close, connect }),
    })

    const { reconnectGatewayIfOrganizationNotSynced } = await import('../useConnectionRecovery')
    const reconnectPromise = reconnectGatewayIfOrganizationNotSynced('target-org')

    await tickN(2)
    expect(wsConnectionState.setOrganizationAccessRecoveryInFlight).toHaveBeenCalledWith(true)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(wsConnectionState.organizationAccessRecoveryInFlight).toBe(true)

    await vi.advanceTimersByTimeAsync(300)
    await reconnectPromise

    expect(close).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(wsConnectionState.setOrganizationAccessRecoveryInFlight).toHaveBeenLastCalledWith(false)
    expect(wsConnectionState.organizationAccessRecoveryInFlight).toBe(false)
  })
})

describe('场景 1: idle→connected 不触发恢复', () => {
  it('首次连接 idle→connected 不调用 RECOVERY_TASKS', async () => {
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(5)

    expect(mockLoadOrganizations).not.toHaveBeenCalled()
    expect(mockLoadSpaces).not.toHaveBeenCalled()
    expect(mockLoadDevices).not.toHaveBeenCalled()
    expect(mockFetchAccounts).not.toHaveBeenCalled()
  })
})

describe('场景 2: connected→disconnected→connected 触发 executeRecovery', () => {
  it('断连后重连成功时调用全部 RECOVERY_TASKS', async () => {
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await tickN(3)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockLoadOrganizations).toHaveBeenCalledTimes(1)
    expect(mockLoadSpaces).toHaveBeenCalledWith('ws-test')
    expect(mockLoadDevices).toHaveBeenCalledWith('ws-test')
    expect(mockFetchAccounts).toHaveBeenCalledWith('ws-test')
    expect(mockLoadUnreadCount).toHaveBeenCalledTimes(1)
    // Tracker 列表跟着当前激活 Space 走；setUp 默认 selectedSpace=sp-test，
    // 因此 trackers recovery task 应携带 (organizationId, spaceId) 调 loadTasks(force)。
    expect(mockLoadTasks).toHaveBeenCalledWith('ws-test', 'sp-test', undefined, { force: true })
    // ：已加载 Space 会话列表 REST reconcile
    expect(mockLoadSessions).toHaveBeenCalledWith('sp-test', 'ws-test')
  })

  it('重连恢复时设备未注册：先补注册再刷新设备列表', async () => {
    deviceState.registered = false
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await tickN(3)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockRegisterCurrentDevice).toHaveBeenCalledWith('ws-test')
    expect(mockLoadDevices).toHaveBeenCalledWith('ws-test')
  })

  it('重连恢复时设备已注册：不重复注册', async () => {
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await tickN(3)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockRegisterCurrentDevice).not.toHaveBeenCalled()
    expect(mockLoadDevices).toHaveBeenCalledWith('ws-test')
  })

  it('reconnecting→connected 同样触发恢复', async () => {
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('reconnecting')
    await tickN(3)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockLoadOrganizations).toHaveBeenCalledTimes(1)
  })

  it('无 selectedOrganization 时不触发恢复', async () => {
    organizationState.selectedOrganization = null
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await tickN(3)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockLoadOrganizations).not.toHaveBeenCalled()
  })

  it('有 selectedOrganization 但无 selectedSpace 时，trackers task 跳过', async () => {
    // Tracker 列表跟随当前激活 Space 走；用户当前未选中任何 Space 时，
    // 断连重连不应抛 loadTasks 调用——其他 RECOVERY_TASKS（organization/spaces/
    // devices/channels/notifications）仍正常执行。
    spaceState.selectedSpace = null
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await tickN(3)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockLoadOrganizations).toHaveBeenCalledTimes(1)
    expect(mockLoadSpaces).toHaveBeenCalledWith('ws-test')
    // 关键：trackers task 因 activeSpaceId 为 null 提前 return
    expect(mockLoadTasks).not.toHaveBeenCalled()
  })
})

describe('场景 3: RECOVERY_TASKS 全部成功 → recoveryInFlight 释放', () => {
  it('所有任务成功后可再次触发恢复', async () => {
    let now = 100_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await mountRecoveryHook()

    // 第一轮
    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await tickN(3)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockLoadOrganizations).toHaveBeenCalledTimes(1)

    // 冷却窗口结束后再触发第二轮，证明 recoveryInFlight 已释放
    now = 161_000
    emitWsStatus('disconnected')
    await tickN(3)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockLoadOrganizations).toHaveBeenCalledTimes(2)
  })
})

describe('场景 4: 部分失败 → 最多 3 次重试（2s/5s/10s 延迟）', () => {
  it('部分任务失败后会按重试策略恢复成功', async () => {
    vi.useFakeTimers()

    let spacesCallCount = 0
    mockLoadSpaces.mockImplementation(async () => {
      spacesCallCount++
      if (spacesCallCount <= 2) throw new Error('spaces failed')
    })

    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(5)
    emitWsStatus('disconnected')
    await tickN(5)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockLoadSpaces).toHaveBeenCalledTimes(1)

    // 给 2s / 5s 两轮重试留足缓冲，避免微任务调度导致的边界抖动
    await vi.advanceTimersByTimeAsync(10_000)
    await flushRecoveryWork()
    expect(mockLoadSpaces).toHaveBeenCalledTimes(3)
  })

  it('3 次重试后仍失败则放弃', async () => {
    vi.useFakeTimers()

    mockLoadDevices.mockRejectedValue(new Error('always fail'))

    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(5)
    emitWsStatus('disconnected')
    await tickN(5)
    emitWsStatus('connected')
    await flushRecoveryWork()

    // 初始 1 次
    expect(mockLoadDevices).toHaveBeenCalledTimes(1)

    // 给 2s / 5s / 10s 三轮重试留足缓冲，验证最终总次数
    await vi.advanceTimersByTimeAsync(20_000)
    await flushRecoveryWork()
    expect(mockLoadDevices).toHaveBeenCalledTimes(4)

    // 不应有第 4 次重试
    await vi.advanceTimersByTimeAsync(20000)
    expect(mockLoadDevices).toHaveBeenCalledTimes(4)
  })
})

describe('场景 5: 恢复完成后检查 Centrifugo 状态', () => {
  it('IM 未连接 → 触发 reconnectCentrifugo', async () => {
    imState.connectionStatus = 'disconnected'
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await tickN(3)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockReconnectCentrifugo).toHaveBeenCalledTimes(1)
  })

  it('IM 已连接 → 不触发 reconnectCentrifugo', async () => {
    imState.connectionStatus = 'connected'
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await tickN(3)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockReconnectCentrifugo).not.toHaveBeenCalled()
  })
})

describe('场景 6: 恢复过程中 WS 再次断连 → 不重复触发', () => {
  it('recoveryInFlight 期间新的 connected 事件不启动第二轮恢复', async () => {
    let resolveSpaces: () => void
    const spacesDeferred = new Promise<void>((r) => { resolveSpaces = r })
    mockLoadSpaces.mockReturnValue(spacesDeferred)

    await mountRecoveryHook()

    // 触发恢复（spaces 会挂起）
    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await tickN(3)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockLoadOrganizations).toHaveBeenCalledTimes(1)

    // 恢复仍在进行中 — 再次断连再连接
    emitWsStatus('disconnected')
    await tickN(3)
    emitWsStatus('connected')
    await tickN(5)

    // 不应触发第二轮
    expect(mockLoadOrganizations).toHaveBeenCalledTimes(1)

    // 释放挂起的 promise
    resolveSpaces!()
    await tickN(10)
  })

  it('重试中 WS 断连 → 中止后续重试', async () => {
    vi.useFakeTimers()

    mockLoadDevices.mockRejectedValue(new Error('fail'))

    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(5)
    emitWsStatus('disconnected')
    await tickN(5)
    emitWsStatus('connected')
    await flushRecoveryWork()

    expect(mockLoadDevices).toHaveBeenCalledTimes(1)

    // 在重试延迟期间断连
    emitWsStatus('disconnected')
    await tickN(3)

    // 推进 2s → retry 触发但 status !== connected → 中止
    await vi.advanceTimersByTimeAsync(2100)

    // executeRecovery 内部检查 wsStatus，应不再调用 devices
    expect(mockLoadDevices).toHaveBeenCalledTimes(1)
  })
})

describe('场景 6b: 主进程唤醒恢复中 → renderer 通用重连不抢跑', () => {
  it('online debounce 触发时若 Agent Gateway 为 recovering，等待恢复结束后再补偿重连', async () => {
    vi.useFakeTimers()
    const connect = vi.fn().mockResolvedValue(true)
    let agentGatewayStatus = 'recovering'
    let agentGatewayStatusListener: ((status: string) => void) | null = null
    mockGetChatClient.mockReturnValue({
      getGateway: () => ({
        getConnectionStatus: () => 'idle',
        connect,
      }),
    })
    ;(window as any).tabtin = {
      agentGateway: {
        getStatus: vi.fn().mockImplementation(() => Promise.resolve(agentGatewayStatus)),
        onStatusChange: vi.fn((cb: (status: string) => void) => {
          agentGatewayStatusListener = cb
          return () => { agentGatewayStatusListener = null }
        }),
      },
    }

    await mountRecoveryHook()

    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await vi.advanceTimersByTimeAsync(3_100)
    await flushRecoveryWork()

    expect(connect).not.toHaveBeenCalled()
    expect(mockEnsureDeviceRegistered).toHaveBeenCalledTimes(1)

    agentGatewayStatus = 'ready'
    agentGatewayStatusListener?.('ready')
    await flushRecoveryWork()

    expect(connect).toHaveBeenCalledTimes(1)
  })
})

describe('场景 6c: 原生文件选择器返回 → 不抢占 file input change', () => {
  it('文件选择器返回 visible 时先延后连接恢复，静默窗口结束后再补跑', async () => {
    vi.useFakeTimers()
    chatState.currentSessionId = 'session-file-picker'
    wsConnectionState.status = 'connected'
    agentGatewayState.status = 'ready'
    imState.connectionStatus = 'disconnected'
    const finishNativePicker = beginNativeFilePickerInteraction()

    await mountRecoveryHook()
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flushRecoveryWork()

    expect(mockReconnectCentrifugo).not.toHaveBeenCalled()
    expect(mockSyncSessionMessagesFromServer).not.toHaveBeenCalled()

    finishNativePicker()
    await vi.advanceTimersByTimeAsync(1_001)
    await flushRecoveryWork()

    expect(mockReconnectCentrifugo).toHaveBeenCalledTimes(1)
  })
})

describe('场景 7: Agent Gateway 持续非 ready 超过 SUSPEND_DEBOUNCE_MS → 标记 streaming session 为 suspended', () => {
  it('非 ready 持续 3s 后把仍在 streaming 的 session 标 suspended', async () => {
    vi.useFakeTimers()
    busyIds.value = ['s1', 's2'] // s3 非 busy
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')

    // 推进到 3s 临界 — debounce 触发
    await vi.advanceTimersByTimeAsync(3001)
    await flushRecoveryWork()

    expect(mockMarkSessionsSuspended).toHaveBeenCalledTimes(1)
    const [ids, suspended] = mockMarkSessionsSuspended.mock.calls[0]
    expect(suspended).toBe(true)
    expect(new Set(ids)).toEqual(new Set(['s1', 's2'])) // s3 不在 streaming 中
  })

  it('reconnecting 状态同样触发 debounce 标记', async () => {
    vi.useFakeTimers()
    busyIds.value = ['sx']
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('reconnecting')

    await vi.advanceTimersByTimeAsync(3001)
    await flushRecoveryWork()

    expect(mockMarkSessionsSuspended).toHaveBeenCalledWith(['sx'], true)
  })

  it('3s 内恢复 connected → 不标记', async () => {
    vi.useFakeTimers()
    busyIds.value = ['s1']
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await vi.advanceTimersByTimeAsync(2000) // 2s 后回来
    emitWsStatus('connected')
    await vi.advanceTimersByTimeAsync(2000) // 再过 2s 确认 timer 没启动
    await flushRecoveryWork()

    expect(mockMarkSessionsSuspended).not.toHaveBeenCalled()
  })

  it('断连后没有 streaming session → 不调用 utility', async () => {
    vi.useFakeTimers()
    busyIds.value = [] // 空
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await vi.advanceTimersByTimeAsync(3001)
    await flushRecoveryWork()

    expect(mockMarkSessionsSuspended).not.toHaveBeenCalled()
  })

  it('连续多次 reconnecting 事件 → 不重启 timer（仅以首次进入时间计算）', async () => {
    vi.useFakeTimers()
    busyIds.value = ['s1']
    await mountRecoveryHook()

    emitWsStatus('connected')
    await tickN(3)
    emitWsStatus('disconnected')
    await vi.advanceTimersByTimeAsync(2000)
    // 进入 reconnecting 不应重启 timer
    emitWsStatus('reconnecting')
    await vi.advanceTimersByTimeAsync(1100) // 累计 3.1s 应触发
    await flushRecoveryWork()

    expect(mockMarkSessionsSuspended).toHaveBeenCalledTimes(1)
  })

  it('mount 时即处于 disconnected → debounce 后照常标记', async () => {
    vi.useFakeTimers()
    wsConnectionState.status = 'disconnected'
    agentGatewayState.status = 'connecting'
    busyIds.value = ['s1']
    await mountRecoveryHook()

    await vi.advanceTimersByTimeAsync(3001)
    await flushRecoveryWork()

    expect(mockMarkSessionsSuspended).toHaveBeenCalledWith(['s1'], true)
  })

  it('#10899 同一 disconnected 状态下 store 其它字段更新不重复标 suspended', async () => {
    vi.useFakeTimers()
    busyIds.value = ['s1']
    await mountRecoveryHook()

    emitWsStatus('disconnected')
    await vi.advanceTimersByTimeAsync(3001)
    await flushRecoveryWork()
    expect(mockMarkSessionsSuspended).toHaveBeenCalledTimes(1)

    for (const cb of [...wsConnectionState._subscribers]) {
      cb({ status: 'disconnected' })
    }
    await vi.advanceTimersByTimeAsync(3001)
    await flushRecoveryWork()
    expect(mockMarkSessionsSuspended).toHaveBeenCalledTimes(1)
  })

  it('hook unmount 取消 timer，不会延迟触发', async () => {
    vi.useFakeTimers()
    busyIds.value = ['s1']
    const { useConnectionRecovery } = await import('../useConnectionRecovery')
    const { unmount } = renderHook(() => useConnectionRecovery())

    emitWsStatus('disconnected')
    await vi.advanceTimersByTimeAsync(2000)
    unmount()
    await vi.advanceTimersByTimeAsync(2000)
    await flushRecoveryWork()

    expect(mockMarkSessionsSuspended).not.toHaveBeenCalled()
  })
})
