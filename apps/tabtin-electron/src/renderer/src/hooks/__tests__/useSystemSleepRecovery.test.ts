import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockStopHeartbeat,
  mockStartHeartbeat,
  mockEnsureDeviceRegistered,
  mockDisconnectCentrifugo,
  mockReconnectCentrifugo,
  mockCloseGateway,
  mockRefreshAllSlotTimers,
  mockTryReconnectGateway,
  deviceState,
  systemHandlers,
} = vi.hoisted(() => ({
  mockStopHeartbeat: vi.fn(),
  mockStartHeartbeat: vi.fn(),
  mockEnsureDeviceRegistered: vi.fn(),
  mockDisconnectCentrifugo: vi.fn(),
  mockReconnectCentrifugo: vi.fn(),
  mockCloseGateway: vi.fn(),
  mockRefreshAllSlotTimers: vi.fn(),
  mockTryReconnectGateway: vi.fn(),
  deviceState: {
    registered: true,
  },
  systemHandlers: {
    suspend: null as null | (() => void),
    resume: null as null | (() => void),
  },
}))

vi.mock('@/stores/useDeviceStore', () => ({
  stopHeartbeat: mockStopHeartbeat,
  startHeartbeat: mockStartHeartbeat,
  ensureDeviceRegistered: mockEnsureDeviceRegistered,
  useDeviceStore: {
    getState: () => deviceState,
  },
}))

vi.mock('@/hooks/useCentrifugoClient', () => ({
  disconnectCentrifugo: mockDisconnectCentrifugo,
  reconnectCentrifugo: mockReconnectCentrifugo,
}))

vi.mock('@/hooks/useConnectionRecovery', () => ({
  tryReconnectGateway: mockTryReconnectGateway,
}))

vi.mock('@/services/chatClientSingleton', () => ({
  getChatClientInstance: () => ({
    getGateway: () => ({ close: mockCloseGateway }),
    getStreamManager: () => ({ refreshAllSlotTimers: mockRefreshAllSlotTimers }),
  }),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    log: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('useSystemSleepRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    deviceState.registered = true
    systemHandlers.suspend = null
    systemHandlers.resume = null
    ;(window as any).tabtin = {
      system: {
        onSuspend: vi.fn((cb: () => void) => {
          systemHandlers.suspend = cb
          return () => { systemHandlers.suspend = null }
        }),
        onResume: vi.fn((cb: () => void) => {
          systemHandlers.resume = cb
          return () => { systemHandlers.resume = null }
        }),
      },
    }
  })

  it('triggers renderer gateway and Centrifugo reconnect on system resume', async () => {
    vi.useFakeTimers()
    const { useSystemSleepRecovery } = await import('../useSystemSleepRecovery')
    renderHook(() => useSystemSleepRecovery())

    systemHandlers.resume?.()

    expect(mockTryReconnectGateway).toHaveBeenCalledTimes(1)
    expect(mockReconnectCentrifugo).toHaveBeenCalledTimes(1)
    expect(mockRefreshAllSlotTimers).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(mockStartHeartbeat).toHaveBeenCalledTimes(1)
    expect(mockEnsureDeviceRegistered).not.toHaveBeenCalled()
  })

  it('closes renderer-side connections on system suspend', async () => {
    const { useSystemSleepRecovery } = await import('../useSystemSleepRecovery')
    renderHook(() => useSystemSleepRecovery())

    systemHandlers.suspend?.()

    expect(mockStopHeartbeat).toHaveBeenCalledTimes(1)
    expect(mockDisconnectCentrifugo).toHaveBeenCalledTimes(1)
    expect(mockCloseGateway).toHaveBeenCalledTimes(1)
  })
})
