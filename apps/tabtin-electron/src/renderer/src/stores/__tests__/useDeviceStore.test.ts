import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gatewayState,
  mockedState,
  mockToast,
  mockEmitDeviceStatusMessage,
  mockRegisterResetAction,
  mockOnOrganizationSelected,
  mockHeartbeat,
  mockRegisterDevice,
  mockReportOffline,
  mockReportOfflineSync,
  mockLoadAgent,
  mockRefreshSpace,
} = vi.hoisted(() => {
  const gateway = {
    listener: null as ((envelope: any) => void) | null,
    reconnectHandler: null as (() => void) | null,
    addListener: vi.fn((listener: (envelope: any) => void) => {
      gateway.listener = listener
    }),
    onReconnectedEvent: vi.fn((handler: () => void) => {
      gateway.reconnectHandler = handler
    }),
    offReconnectedEvent: vi.fn(),
  }

  return {
    gatewayState: gateway,
    mockedState: {
      user: { id: 'user-1' },
      selectedOrganization: { id: 'ws-1' },
      selectedAgent: { id: 'agent-1', control_device_id: 'device-1', bound_device_id: null },
      spaces: [{ id: 'space-1', agent_id: 'agent-1' }],
      wsStatus: 'connected',
    },
    mockToast: vi.fn(),
    mockEmitDeviceStatusMessage: vi.fn(),
    mockRegisterResetAction: vi.fn(),
    mockOnOrganizationSelected: vi.fn(),
    mockHeartbeat: vi.fn().mockResolvedValue(undefined),
    mockRegisterDevice: vi.fn(),
    mockReportOffline: vi.fn().mockResolvedValue(undefined),
    mockReportOfflineSync: vi.fn(),
    mockLoadAgent: vi.fn().mockResolvedValue(null),
    mockRefreshSpace: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('@tabtin/ws-gateway-client', () => ({
  DomainEvents: {
    DEVICE_STATUS: 'device.status',
    DEVICE_UNBOUND: 'device.unbound',
  },
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => gatewayState,
  }),
}))

vi.mock('@/services/deviceApi', () => ({
  DeviceApiService: {
    heartbeat: mockHeartbeat,
    registerDevice: mockRegisterDevice,
    listDevices: vi.fn().mockResolvedValue({ devices: [] }),
    updateDevice: vi.fn(),
    deleteDevice: vi.fn(),
    reportOffline: mockReportOffline,
    reportOfflineSync: mockReportOfflineSync,
  },
}))

vi.mock('@/utils/deviceId', () => ({
  getOrCreateDeviceId: () => 'device-current',
  getSyncedDeviceIdentity: () => ({
    fingerprint: 'device-current',
    machineKey: 'machine-current',
    previousFingerprint: null,
    recoveryFingerprints: [],
  }),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  }),
}))

vi.mock('@/adapters/api-adapter-instance', () => ({
  getAuthToken: vi.fn().mockResolvedValue('token'),
}))

vi.mock('@/services/runtimeSnapshot', () => ({
  collectCurrentHostRuntimeSnapshot: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/utils/sleepAwareInterval', () => ({
  createSleepAwareInterval: () => ({ start: vi.fn(), stop: vi.fn() }),
}))

vi.mock('../useWsConnectionStore', () => ({
  useWsConnectionStore: {
    getState: () => ({
      status: mockedState.wsStatus,
    }),
  },
}))

vi.mock('../useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      selectedAgent: mockedState.selectedAgent,
      spaces: mockedState.spaces,
      loadAgent: mockLoadAgent,
      refreshSpace: mockRefreshSpace,
    }),
  },
}))

vi.mock('../useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      user: mockedState.user,
    }),
  },
}))

vi.mock('../useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      selectedOrganization: mockedState.selectedOrganization,
    }),
    subscribe: vi.fn(() => () => undefined),
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  FALLBACK_TAG_BACKGROUND_COLOR: '#000000',
  FALLBACK_TAG_TEXT_COLOR: '#ffffff',
  resolveChoiceTagColors: vi.fn(() => ({
    backgroundColor: '#000000',
    textColor: '#ffffff',
  })),
  toast: mockToast,
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: mockToast,
}))

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: mockRegisterResetAction,
}))

vi.mock('../deviceStatusEvents', () => ({
  emitDeviceStatusMessage: mockEmitDeviceStatusMessage,
  onDeviceStatusMessage: vi.fn(() => () => undefined),
}))

vi.mock('../organizationLifecycleEvents', () => ({
  onOrganizationSelected: mockOnOrganizationSelected,
}))

vi.mock('@/i18n', () => {
  const translations: Record<string, string> = {
    'space:device.toastOfflineTitle': '执行设备 {{name}} 已离线',
    'space:device.toastOfflineDesc': '终端、浏览器、文件操作等工具暂不可用，设备恢复在线后自动恢复。',
    'space:device.toastOnlineTitle': '执行设备 {{name}} 已上线',
    'space:device.toastOnlineDesc': '全部工具能力已恢复。',
    'space:device.emitOffline': '⚠️ 执行设备 "{{name}}" 已离线 — 终端/浏览器/文件工具暂不可用，设备恢复在线后自动恢复。',
    'space:device.emitBusy': '🔄 执行设备 "{{name}}" 正在执行任务',
    'space:device.emitOnline': '✅ 执行设备 "{{name}}" 已上线 — 全部工具能力已恢复。',
    'space:device.registerFailed': '设备注册失败',
  }
  return {
    default: {
      t: (key: string, opts?: Record<string, any>) => {
        let result = translations[key] ?? key
        if (opts) {
          for (const [k, v] of Object.entries(opts)) {
            if (typeof v === 'string') result = result.replaceAll(`{{${k}}}`, v)
          }
        }
        return result
      },
    },
  }
})

let useDeviceStore: typeof import('../useDeviceStore').useDeviceStore
let ensureDeviceRegistered: typeof import('../useDeviceStore').ensureDeviceRegistered

const BASE_DEVICE = {
  id: 'device-1',
  organization_id: 'ws-1',
  user_id: 'user-1',
  name: 'Daemon A',
  device_type: 'daemon' as const,
  role: 'control' as const,
  fingerprint: 'fp-1',
  os_info: {},
  capabilities: ['terminal_execute'],
  status: 'online' as const,
  created_at: '2026-03-08T00:00:00.000Z',
  updated_at: '2026-03-08T00:00:00.000Z',
}

type StoreDevice = typeof BASE_DEVICE

function makeDevice(overrides: Partial<StoreDevice> = {}): StoreDevice {
  return { ...BASE_DEVICE, ...overrides }
}

function emitDeviceStatus(envelope: Record<string, unknown>) {
  expect(gatewayState.listener).toBeTypeOf('function')
  gatewayState.listener?.(envelope)
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  vi.useRealTimers()

  gatewayState.listener = null
  gatewayState.reconnectHandler = null
  mockedState.user = { id: 'user-1' }
  mockedState.selectedOrganization = { id: 'ws-1' }
  mockedState.selectedAgent = {
    id: 'agent-1',
    control_device_id: 'device-1',
    bound_device_id: null,
  }
  mockedState.spaces = [{ id: 'space-1', agent_id: 'agent-1' }]
  mockedState.wsStatus = 'connected'
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: {
      ...(window.tabtin ?? {}),
      ensureDeviceRegistered: mockRegisterDevice,
    },
  })

  const mod = await import('../useDeviceStore')
  useDeviceStore = mod.useDeviceStore
  ensureDeviceRegistered = mod.ensureDeviceRegistered
  useDeviceStore.setState({
    currentDevice: null,
    devices: [],
    registered: false,
    isLoading: false,
    error: null,
  })
})

describe('useDeviceStore', () => {
  it('当前设备被解绑时强制重拉 Agent 和对应 Space', () => {
    const device = makeDevice()
    useDeviceStore.setState({ devices: [device], currentDevice: device })
    useDeviceStore.getState().initGlobalWsListener()

    emitDeviceStatus({
      type: 'device.unbound',
      payload: {
        device_id: 'device-1',
        agent_id: 'agent-1',
        organization_id: 'ws-1',
      },
    })

    expect(mockLoadAgent).toHaveBeenCalledWith('agent-1', { force: true })
    expect(mockRefreshSpace).toHaveBeenCalledWith('space-1')
  })

  it('其他设备被解绑时不刷新当前客户端 Agent 状态', () => {
    const device = makeDevice()
    useDeviceStore.setState({ devices: [device], currentDevice: device })
    useDeviceStore.getState().initGlobalWsListener()

    emitDeviceStatus({
      type: 'device.unbound',
      payload: {
        device_id: 'device-other',
        agent_id: 'agent-1',
        organization_id: 'ws-1',
      },
    })

    expect(mockLoadAgent).not.toHaveBeenCalled()
    expect(mockRefreshSpace).not.toHaveBeenCalled()
  })

  it('只接收当前 organization 的未知设备事件', () => {
    useDeviceStore.getState().initGlobalWsListener()

    emitDeviceStatus({
      type: 'device.status',
      organization_id: 'ws-2',
      payload: {
        device_id: 'device-2',
        user_id: 'user-1',
        fingerprint: 'fp-2',
        name: 'Daemon B',
        device_type: 'daemon',
        role: 'control',
        status: 'online',
        capabilities: ['terminal_execute'],
      },
    })

    expect(useDeviceStore.getState().devices).toEqual([])

    emitDeviceStatus({
      type: 'device.status',
      organization_id: 'ws-1',
      payload: {
        device_id: 'device-2',
        user_id: 'user-1',
        fingerprint: 'fp-2',
        name: 'Daemon B',
        device_type: 'daemon',
        role: 'control',
        status: 'online',
        capabilities: ['terminal_execute'],
      },
    })

    expect(useDeviceStore.getState().devices).toHaveLength(1)
    expect(useDeviceStore.getState().devices[0]).toMatchObject({
      id: 'device-2',
      organization_id: 'ws-1',
      user_id: 'user-1',
      name: 'Daemon B',
      role: 'control',
    })
  })

  it('绑定设备 offline：立刻 toast，宽限内不写对话（DV-2 假离线去噪）', async () => {
    vi.useFakeTimers()
    const device = makeDevice()
    useDeviceStore.setState({ devices: [device], currentDevice: device })
    useDeviceStore.getState().initGlobalWsListener()

    emitDeviceStatus({
      type: 'device.status',
      organization_id: 'ws-1',
      payload: {
        device_id: 'device-1',
        user_id: 'user-1',
        fingerprint: 'fp-1',
        name: 'Daemon A',
        device_type: 'daemon',
        role: 'control',
        status: 'offline',
        capabilities: ['terminal_execute'],
      },
    })

    expect(mockToast).toHaveBeenCalledTimes(1)
    expect(mockEmitDeviceStatusMessage).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(89_999)
    expect(mockEmitDeviceStatusMessage).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(mockEmitDeviceStatusMessage).toHaveBeenCalledTimes(1)
    expect(mockEmitDeviceStatusMessage).toHaveBeenCalledWith(
      expect.stringContaining('已离线'),
    )
    vi.useRealTimers()
  })

  it('绑定设备 offline 后宽限内 online：只 toast，对话零噪声（DV-2）', async () => {
    vi.useFakeTimers()
    const device = makeDevice()
    useDeviceStore.setState({ devices: [device], currentDevice: device })
    useDeviceStore.getState().initGlobalWsListener()

    emitDeviceStatus({
      type: 'device.status',
      organization_id: 'ws-1',
      payload: {
        device_id: 'device-1',
        user_id: 'user-1',
        fingerprint: 'fp-1',
        name: 'Daemon A',
        device_type: 'daemon',
        role: 'control',
        status: 'offline',
        capabilities: ['terminal_execute'],
      },
    })

    await vi.advanceTimersByTimeAsync(30_000)

    emitDeviceStatus({
      type: 'device.status',
      organization_id: 'ws-1',
      payload: {
        device_id: 'device-1',
        user_id: 'user-1',
        fingerprint: 'fp-1',
        name: 'Daemon A',
        device_type: 'daemon',
        role: 'control',
        status: 'online',
        capabilities: ['terminal_execute'],
      },
    })

    expect(mockToast).toHaveBeenCalledTimes(2)
    expect(mockEmitDeviceStatusMessage).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(mockEmitDeviceStatusMessage).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('已有设备收到相同状态时不会重复提示', () => {
    const device = makeDevice()
    useDeviceStore.setState({
      devices: [device],
      currentDevice: device,
    })
    useDeviceStore.getState().initGlobalWsListener()

    emitDeviceStatus({
      type: 'device.status',
      organization_id: 'ws-1',
      payload: {
        device_id: 'device-1',
        user_id: 'user-1',
        fingerprint: 'fp-1',
        name: 'Daemon A',
        device_type: 'daemon',
        role: 'control',
        status: 'online',
        capabilities: ['terminal_execute'],
      },
    })

    expect(mockToast).not.toHaveBeenCalled()
    expect(mockEmitDeviceStatusMessage).not.toHaveBeenCalled()

    emitDeviceStatus({
      type: 'device.status',
      organization_id: 'ws-1',
      payload: {
        device_id: 'device-1',
        user_id: 'user-1',
        fingerprint: 'fp-1',
        name: 'Daemon A',
        device_type: 'daemon',
        role: 'control',
        status: 'offline',
        capabilities: ['terminal_execute'],
      },
    })

    expect(mockToast).toHaveBeenCalledTimes(1)
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '执行设备 Daemon A 已离线',
        variant: 'destructive',
      }),
    )
    // DV-2：offline 对话横幅有 90s 宽限，不会立刻注入。
    expect(mockEmitDeviceStatusMessage).not.toHaveBeenCalled()
    expect(useDeviceStore.getState().devices[0]?.status).toBe('offline')
  })
})

describe('设备注册自动重试', () => {
  function makeSelfDevice() {
    return makeDevice({
      id: 'device-self',
      fingerprint: 'device-current',
      name: 'My Electron',
    })
  }

  it('注册成功：registered 置位、currentDevice/devices 同步、心跳启动', async () => {
    vi.useFakeTimers()
    mockRegisterDevice.mockResolvedValueOnce(makeSelfDevice())

    const result = await useDeviceStore.getState().registerCurrentDevice('ws-1')

    expect(result?.id).toBe('device-self')
    const state = useDeviceStore.getState()
    expect(state.registered).toBe(true)
    expect(state.currentDevice?.id).toBe('device-self')
    expect(state.devices.some((d) => d.id === 'device-self')).toBe(true)

    // startHeartbeat 立即发一次心跳
    await vi.advanceTimersByTimeAsync(0)
    expect(mockHeartbeat).toHaveBeenCalledWith('device-current', expect.anything())
    vi.useRealTimers()
  })

  it('首次注册失败不锁死：退避 5s 后自动重试，成功后恢复注册态与心跳', async () => {
    vi.useFakeTimers()
    mockRegisterDevice
      .mockRejectedValueOnce(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7070'), {
          endpoint: 'http://127.0.0.1:7070/api/devices/register',
        }),
      )
      .mockResolvedValueOnce(makeSelfDevice())

    const result = await useDeviceStore.getState().registerCurrentDevice('ws-1')

    expect(result).toBeNull()
    expect(useDeviceStore.getState().registered).toBe(false)
    expect(useDeviceStore.getState().error).toContain('ECONNREFUSED')
    expect(mockRegisterDevice).toHaveBeenCalledTimes(1)
    expect(mockHeartbeat).not.toHaveBeenCalled()

    // 5s 退避后自动重试并成功
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockRegisterDevice).toHaveBeenCalledTimes(2)

    const state = useDeviceStore.getState()
    expect(state.registered).toBe(true)
    expect(state.currentDevice?.id).toBe('device-self')
    await vi.advanceTimersByTimeAsync(0)
    expect(mockHeartbeat).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('连续失败时重试间隔指数退避（5s → 10s）', async () => {
    vi.useFakeTimers()
    mockRegisterDevice.mockRejectedValue(new Error('backend down'))

    await useDeviceStore.getState().registerCurrentDevice('ws-1')
    expect(mockRegisterDevice).toHaveBeenCalledTimes(1)

    // 第一次重试：5s
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockRegisterDevice).toHaveBeenCalledTimes(2)

    // 第二次重试间隔 10s：5s 时不应触发
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockRegisterDevice).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockRegisterDevice).toHaveBeenCalledTimes(3)

    // 登出 / clearDevices 取消挂起的重试
    useDeviceStore.getState().clearDevices()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mockRegisterDevice).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('ensureDeviceRegistered：未注册时立即去重注册，已注册时 no-op', async () => {
    vi.useFakeTimers()
    mockRegisterDevice
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValue(makeSelfDevice())

    await useDeviceStore.getState().registerCurrentDevice('ws-1')
    expect(useDeviceStore.getState().registered).toBe(false)

    // 恢复时机触发：立即重试，不等退避计时器
    ensureDeviceRegistered()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockRegisterDevice).toHaveBeenCalledTimes(2)
    expect(useDeviceStore.getState().registered).toBe(true)

    // 已注册后再触发：不重复注册
    ensureDeviceRegistered()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockRegisterDevice).toHaveBeenCalledTimes(2)

    // 原退避计时器已被取消，不会再补一次注册
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mockRegisterDevice).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('WS 重连时若未注册则补注册而不是只发心跳', async () => {
    vi.useFakeTimers()
    mockRegisterDevice
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValue(makeSelfDevice())

    useDeviceStore.getState().initGlobalWsListener()
    await useDeviceStore.getState().registerCurrentDevice('ws-1')
    expect(useDeviceStore.getState().registered).toBe(false)

    expect(gatewayState.reconnectHandler).toBeTypeOf('function')
    gatewayState.reconnectHandler?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(mockRegisterDevice).toHaveBeenCalledTimes(2)
    expect(useDeviceStore.getState().registered).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockHeartbeat).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('并发调用 registerCurrentDevice 全部委托给 AgentHost，由主进程合并注册事务', async () => {
    mockRegisterDevice.mockResolvedValue(makeSelfDevice())

    const [a, b] = await Promise.all([
      useDeviceStore.getState().registerCurrentDevice('ws-1'),
      useDeviceStore.getState().registerCurrentDevice('ws-1'),
    ])

    expect(mockRegisterDevice).toHaveBeenCalledTimes(2)
    expect(a?.id).toBe('device-self')
    expect(b?.id).toBe('device-self')
  })

  it('组织切换时忽略较晚返回的旧组织注册结果', async () => {
    const resolvers = new Map<string, (device: ReturnType<typeof makeSelfDevice>) => void>()
    mockRegisterDevice.mockImplementation((organizationId: string) =>
      new Promise<ReturnType<typeof makeSelfDevice>>((resolve) => {
        resolvers.set(organizationId, resolve)
      }))

    const oldOrganization = useDeviceStore.getState().registerCurrentDevice('org-old')
    const currentOrganization = useDeviceStore.getState().registerCurrentDevice('org-current')
    expect(useDeviceStore.getState()).toMatchObject({
      currentDevice: null,
      registered: false,
      isLoading: true,
    })
    resolvers.get('org-current')?.({ ...makeSelfDevice(), id: 'device-current' })
    await expect(currentOrganization).resolves.toMatchObject({ id: 'device-current' })
    resolvers.get('org-old')?.({ ...makeSelfDevice(), id: 'device-old' })
    await expect(oldOrganization).resolves.toBeNull()

    expect(useDeviceStore.getState().currentDevice?.id).toBe('device-current')
  })
})
