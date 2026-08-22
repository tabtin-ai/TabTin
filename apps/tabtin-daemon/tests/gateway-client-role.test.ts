import { describe, it, expect } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'

describe('DaemonGatewayClient — P0-1 (EX-P0-06) regression', () => {
  const gatewayClientPath = path.resolve(
    __dirname,
    '../src/transport/gateway/gateway-client.ts',
  )

  it('should not use "as any" on the role field', () => {
    const source = fs.readFileSync(gatewayClientPath, 'utf-8')
    expect(source).not.toMatch(/role:\s*['"]daemon['"]\s*as\s+any/)
    expect(source).toMatch(/role:\s*['"]daemon['"]/)
  })

  it('GatewayRole type in ws-gateway-client should include daemon', () => {
    const wsGatewaySrcPath = path.resolve(
      __dirname,
      '../../../packages/ws-gateway-client/src/index.ts',
    )
    const source = fs.readFileSync(wsGatewaySrcPath, 'utf-8')
    expect(source).toMatch(/['"]daemon['"]/)
  })

  it('drain suspension preserves reconnect callbacks and control envelopes', () => {
    const source = fs.readFileSync(gatewayClientPath, 'utf-8')
    const suspendBody = source.slice(source.indexOf('suspendIngress()'), source.indexOf('sendGitDiffResponse'))
    expect(suspendBody).not.toContain('reconnectCallbacks = []')
    expect(source).toContain("envelope.type === 'agent.prompt.forward' && !this.acceptingWorkIngress")
    expect(source).toContain("envelope.type === 'agent.action.cancel'")
  })
})
