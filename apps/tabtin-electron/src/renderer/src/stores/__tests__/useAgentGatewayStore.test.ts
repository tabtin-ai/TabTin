import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  __resetAgentGatewayBridgeForTests,
  ensureAgentGatewayBridge,
  useAgentGatewayStore,
} from '../useAgentGatewayStore'
import { useAgentGatewayStatus } from '@/hooks/useAgentGatewayStatus'

describe('useAgentGatewayStore / remount persistence ( placeholder flash)', () => {
  beforeEach(() => {
    __resetAgentGatewayBridgeForTests()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    __resetAgentGatewayBridgeForTests()
    vi.unstubAllGlobals()
  })

  it('keeps ready status across hook remounts without flashing connecting', async () => {
    let statusListener: ((s: string) => void) | null = null
    const getStatus = vi.fn().mockResolvedValue('ready')
    vi.stubGlobal('tabtin', {
      agentGateway: {
        getStatus,
        onStatusChange: (cb: (s: string) => void) => {
          statusListener = cb
          return () => {
            statusListener = null
          }
        },
      },
    })

    const first = renderHook(() => useAgentGatewayStatus())
    await vi.waitFor(() => {
      expect(first.result.current).toBe('ready')
    })
    expect(getStatus).toHaveBeenCalledTimes(1)

    first.unmount()

    // remount（模拟 ChatInput key 变化）应直接读到 store 里的 ready，不再回到 connecting
    const second = renderHook(() => useAgentGatewayStatus())
    expect(second.result.current).toBe('ready')
    // bridge 只建一次
    expect(getStatus).toHaveBeenCalledTimes(1)

    act(() => {
      statusListener?.('recovering')
    })
    expect(second.result.current).toBe('recovering')

    second.unmount()
  })

  it('does not latch bridge when agentGateway is missing yet', async () => {
    vi.stubGlobal('tabtin', {})
    ensureAgentGatewayBridge()
    expect(useAgentGatewayStore.getState().status).toBe('connecting')

    const getStatus = vi.fn().mockResolvedValue('ready')
    vi.stubGlobal('tabtin', {
      agentGateway: {
        getStatus,
        onStatusChange: () => () => {},
      },
    })

    ensureAgentGatewayBridge()
    expect(getStatus).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(useAgentGatewayStore.getState().status).toBe('ready')
    })
  })

  it('reset re-fetches getStatus when bridge already started', async () => {
    const getStatus = vi.fn()
      .mockResolvedValueOnce('ready')
      .mockResolvedValueOnce('ready')
    vi.stubGlobal('tabtin', {
      agentGateway: {
        getStatus,
        onStatusChange: () => () => {},
      },
    })

    ensureAgentGatewayBridge()
    await vi.waitFor(() => {
      expect(useAgentGatewayStore.getState().status).toBe('ready')
    })
    expect(getStatus).toHaveBeenCalledTimes(1)

    useAgentGatewayStore.getState().reset()
    expect(useAgentGatewayStore.getState().status).toBe('connecting')
    await vi.waitFor(() => {
      expect(useAgentGatewayStore.getState().status).toBe('ready')
    })
    expect(getStatus).toHaveBeenCalledTimes(2)
  })
})
