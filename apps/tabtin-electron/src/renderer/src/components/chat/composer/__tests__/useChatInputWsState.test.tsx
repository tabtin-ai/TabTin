import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useChatInputWsState } from '../useChatInputWsState'

const mockState = vi.hoisted(() => ({
  agentGatewayStatus: 'ready',
}))

vi.mock('@/stores/useWsConnectionStore', () => ({
  useWsConnectionStore: (selector: (state: { status: string; reconnectAttempt: number }) => unknown) =>
    selector({ status: 'disconnected', reconnectAttempt: 7 }),
}))

vi.mock('@/hooks/useAgentGatewayStatus', () => ({
  useAgentGatewayStatus: () => mockState.agentGatewayStatus,
}))

vi.mock('@/services/mainAgentGateway', () => ({
  mainAgentGateway: {
    connect: vi.fn(() => Promise.resolve(true)),
  },
}))

vi.mock('@/hooks/useCentrifugoClient', () => ({
  reconnectCentrifugo: vi.fn(),
}))

describe('useChatInputWsState', () => {
  it('keeps Agent Gateway status for display without blocking IPC sends', () => {
    mockState.agentGatewayStatus = 'connecting'

    const { result } = renderHook(() => useChatInputWsState())

    expect(result.current.wsStatus).toBe('disconnected')
    expect(result.current.wsDisconnected).toBe(false)
    expect(result.current.reconnectAttempt).toBe(7)
  })
})
