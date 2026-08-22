import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetMainAgentGatewayBridgeForTests,
  mainAgentGateway,
} from '../mainAgentGateway'

type AgentGatewayBridgeMock = {
  status: string
  getStatus: ReturnType<typeof vi.fn>
  reconnect: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  getOrganizationIds: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  onReconnected: ReturnType<typeof vi.fn>
}

function installBridge(): AgentGatewayBridgeMock {
  const bridge: AgentGatewayBridgeMock = {
    status: 'ready',
    getStatus: vi.fn(() => Promise.resolve(bridge.status)),
    reconnect: vi.fn(() => {
      bridge.status = 'ready'
      return Promise.resolve(true)
    }),
    request: vi.fn(() => Promise.resolve({ ok: true })),
    send: vi.fn(() => Promise.resolve({ ok: true })),
    subscribe: vi.fn(() => Promise.resolve({ ok: true })),
    unsubscribe: vi.fn(() => Promise.resolve({ ok: true })),
    getOrganizationIds: vi.fn(() => Promise.resolve(['org-1'])),
    onEvent: vi.fn(() => vi.fn()),
    onReconnected: vi.fn(() => vi.fn()),
  }
  ;(window as any).tabtin = { agentGateway: bridge }
  return bridge
}

describe('mainAgentGateway', () => {
  beforeEach(() => {
    __resetMainAgentGatewayBridgeForTests()
  })

  afterEach(() => {
    __resetMainAgentGatewayBridgeForTests()
    delete (window as any).tabtin
  })

  it('does not reconnect when connect sees an already ready main gateway', async () => {
    const bridge = installBridge()

    await expect(mainAgentGateway.connect()).resolves.toBe(true)

    expect(bridge.getStatus).toHaveBeenCalledTimes(1)
    expect(bridge.reconnect).not.toHaveBeenCalled()
    expect(mainAgentGateway.isConnected()).toBe(true)
    await expect(mainAgentGateway.sendResume()).resolves.toBeUndefined()
  })

  it('forceReconnect always asks main to refresh the gateway auth context', async () => {
    const bridge = installBridge()

    await expect(mainAgentGateway.forceReconnect()).resolves.toBe(true)

    expect(bridge.reconnect).toHaveBeenCalledTimes(1)
  })

  it('forwards request, send and non-agent-stream topic operations through the preload bridge', async () => {
    const bridge = installBridge()

    await mainAgentGateway.request('ping', { id: 1 }, { timeoutMs: 1000 })
    mainAgentGateway.send('fire-and-forget', { ok: true })
    await mainAgentGateway.subscribe(['table.events.space-1'])
    await mainAgentGateway.unsubscribe(['table.events.space-1'])

    expect(bridge.request).toHaveBeenCalledWith({
      messageType: 'ping',
      payload: { id: 1 },
      requestOptions: { timeoutMs: 1000 },
    })
    expect(bridge.send).toHaveBeenCalledWith({
      messageType: 'fire-and-forget',
      payload: { ok: true },
      requestOptions: undefined,
    })
    expect(bridge.subscribe).toHaveBeenCalledWith({
      topics: ['table.events.space-1'],
      options: undefined,
    })
    expect(bridge.unsubscribe).toHaveBeenCalledWith({
      topics: ['table.events.space-1'],
    })
  })

  it('blocks renderer-facing agent.stream subscriptions; stream return belongs to agent-host IPC', async () => {
    const bridge = installBridge()

    await expect(mainAgentGateway.subscribe(['agent.stream.chat-session-sess-1']))
      .resolves.toMatchObject({ ok: false, error: { code: 'AGENT_STREAM_IPC_ONLY' } })
    await expect(mainAgentGateway.unsubscribe(['agent.stream.chat-session-sess-1']))
      .resolves.toMatchObject({ ok: false, error: { code: 'AGENT_STREAM_IPC_ONLY' } })
    await expect(mainAgentGateway.request('subscribe', { topics: ['agent.stream.chat-session-sess-1'] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'AGENT_STREAM_IPC_ONLY' } })
    expect(mainAgentGateway.send('subscribe', { topics: ['agent.stream.chat-session-sess-1'] }))
      .toBe(false)

    expect(mainAgentGateway.hasCapability('agent.stream')).toBe(false)
    expect(bridge.subscribe).not.toHaveBeenCalled()
    expect(bridge.unsubscribe).not.toHaveBeenCalled()
    expect(bridge.request).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
  })
})
