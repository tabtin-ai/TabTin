import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAgentStreamGatewaySubscribePayload } from '../deferred-init-action-bridge'

const readMainSource = (relativePath: string) =>
  readFileSync(resolve(__dirname, '..', relativePath), 'utf8')

describe('LocalAgentHost startup', () => {
  it('等待启动完成，并在易失败的初始化前提供 get-state', () => {
    const bridgeSource = readMainSource('deferred-init-action-bridge.ts')
    const hostSource = readMainSource('agent/ElectronAgentHost.ts')
    const exportedInit = bridgeSource.slice(bridgeSource.indexOf('export async function initLocalAgentHost'))
    const startBody = hostSource.slice(
      hostSource.indexOf('  async start(): Promise<void>'),
      hostSource.indexOf('  private async handleSharedHostUserResponse'),
    )
    const getStateBody = hostSource.slice(
      hostSource.indexOf('  private handleGetState('),
      hostSource.indexOf('  private isSessionBusyForCodeRootBind'),
    )

    expect(exportedInit).toContain('await electronAgentHost.start()')
    expect(startBody.indexOf('registerSurfaceAsIpc(agentEngineSurfaces.agentEngineGetState)'))
      .toBeLessThan(startBody.indexOf('await this.startSharedHost()'))
    expect(getStateBody).toContain('if (!this.sharedHost)')
  })

  it('renderer 建立本机会话 watch 后重放 Host 当前 run_sync', () => {
    const hostSource = readMainSource('agent/ElectronAgentHost.ts')
    const watchBody = hostSource.slice(
      hostSource.indexOf("'agent-engine:watch-session'"),
      hostSource.indexOf("'agent-engine:unwatch-session'"),
    )

    const watchIndex = watchBody.indexOf('this.sharedHost?.watch(sessionId,')
    const replayIndex = watchBody.indexOf('this.sharedHost?.syncCurrentRunState(sessionId)')
    expect(watchIndex).toBeGreaterThan(0)
    expect(replayIndex).toBeGreaterThan(watchIndex)
    expect(watchBody).toContain('observeTransport: false')
  })

  it('遥控 gateway-send 由主进程先 observe 会话再代发', () => {
    const hostSource = readMainSource('agent/ElectronAgentHost.ts')
    const gatewaySendBody = hostSource.slice(
      hostSource.indexOf("'agent-engine:gateway-send'"),
      hostSource.indexOf("'agent-engine:abort-run'"),
    )

    const observeIndex = gatewaySendBody.indexOf('this.sharedHost?.observe(sessionId)')
    const requestIndex = gatewaySendBody.indexOf('electronWsGateway.requestWithLastAuth')
    expect(observeIndex).toBeGreaterThan(0)
    expect(requestIndex).toBeGreaterThan(observeIndex)
  })

  it('raw agent gateway IPC 也禁止 renderer 订阅 agent.stream', () => {
    const bridgeSource = readMainSource('deferred-init-action-bridge.ts')
    const gatewayBridgeBody = bridgeSource.slice(
      bridgeSource.indexOf("'ws:agent-gateway-status-get'"),
      bridgeSource.indexOf("'ws:agent-gateway-reconnect'"),
    )

    expect(gatewayBridgeBody).toContain('AGENT_STREAM_IPC_ONLY')
    expect(gatewayBridgeBody).toContain('isAgentStreamGatewaySubscribePayload(payload)')
    expect(gatewayBridgeBody).toContain("'ws:agent-gateway-send'")
    expect(gatewayBridgeBody).toContain("'ws:agent-gateway-subscribe'")
    expect(gatewayBridgeBody).toContain("'ws:agent-gateway-unsubscribe'")
  })

  it('raw gateway subscribe payload 判定覆盖 request 与 send 入口', () => {
    expect(isAgentStreamGatewaySubscribePayload({
      messageType: 'subscribe',
      payload: { topics: ['agent.stream.chat-session-sess-1'] },
    })).toBe(true)
    expect(isAgentStreamGatewaySubscribePayload({
      messageType: 'unsubscribe',
      payload: { topics: ['agent.stream.chat-session-sess-1'] },
    })).toBe(true)
    expect(isAgentStreamGatewaySubscribePayload({
      messageType: 'subscribe',
      payload: { topics: ['table.events.space-1'] },
    })).toBe(false)
    expect(isAgentStreamGatewaySubscribePayload({
      messageType: 'chat.send_message',
      payload: { thread_id: 'sess-1' },
    })).toBe(false)
  })
})
