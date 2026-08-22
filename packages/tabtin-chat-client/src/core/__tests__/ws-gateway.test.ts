import { beforeEach, describe, expect, it, vi } from 'vitest'

const { coreUnsubscribe, coreOptions } = vi.hoisted(() => ({
  coreUnsubscribe: vi.fn(),
  coreOptions: [] as any[],
}))

vi.mock('@tabtin/ws-gateway-client', () => ({
  WsGatewayClient: class {
    constructor(options: any) {
      coreOptions.push(options)
    }
    isConnected = () => false
    unsubscribe = coreUnsubscribe
  },
}))

import { WsGateway } from '../ws-gateway'

describe('WsGateway', () => {
  beforeEach(() => {
    coreOptions.length = 0
    coreUnsubscribe.mockReset()
    coreUnsubscribe.mockResolvedValue({
      ok: false,
      type: 'error',
      requestId: 'req_unavailable',
      error: { code: 'WS_CLIENT_NOT_READY', message: 'ws connection not ready' },
    })
  })

  it('forgets an unsubscribed topic even while disconnected', async () => {
    const gateway = new WsGateway({
      baseURL: 'https://api.test',
      capabilities: [],
      getToken: async () => null,
    } as never)

    await gateway.unsubscribe(['session.collaboration.share-1.1'])

    expect(coreUnsubscribe).toHaveBeenCalledWith(['session.collaboration.share-1.1'])
  })

  it('首次连接的 replay gap 在 ready 后只触发一次权威重连对账', () => {
    const gateway = new WsGateway({
      baseURL: 'https://api.test',
      capabilities: [],
      getToken: async () => null,
    } as never)
    const reconciles = vi.fn()
    gateway.onReconnectedEvent(reconciles)

    coreOptions[0].onReplayGap({
      code: 'WS_1014_REPLAY_GAP',
      message: 'reload history',
      details: { recovery: 'reload_history' },
    })
    expect(reconciles).not.toHaveBeenCalled()

    coreOptions[0].onReady({ reconnected: false })
    expect(reconciles).toHaveBeenCalledTimes(1)
  })

  it('重连期间 replay gap 不会与 onReady 重复触发权威对账', () => {
    const onReconnected = vi.fn()
    const gateway = new WsGateway({
      baseURL: 'https://api.test',
      capabilities: [],
      getToken: async () => null,
      onReconnected,
    } as never)
    const listener = vi.fn()
    gateway.onReconnectedEvent(listener)

    coreOptions[0].onReplayGap({
      code: 'WS_1014_REPLAY_GAP',
      message: 'reload history',
    })
    coreOptions[0].onReady({ reconnected: true })

    expect(onReconnected).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
