import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('ensureMcpRemoteClientName', () => {
  const home = join(tmpdir(), `tabtin-mcp-auth-${process.pid}-${Date.now()}`)

  beforeEach(() => {
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    mkdirSync(home, { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    rmSync(home, { recursive: true, force: true })
  })

  it('removes client_info when client_name is not TabTin', async () => {
    const { ensureMcpRemoteClientName, mcpRemoteServerUrlHash } = await import('../mcp-remote-client')
    const hash = mcpRemoteServerUrlHash('https://mcp.stripe.com')
    const dir = join(home, '.mcp-auth', 'mcp-remote-0.1.37')
    mkdirSync(dir, { recursive: true })
    const clientInfoPath = join(dir, `${hash}_client_info.json`)
    writeFileSync(
      clientInfoPath,
      JSON.stringify({ client_name: 'MCP CLI Proxy', client_id: 'oacli_x', scope: 'mcp' }),
    )
    writeFileSync(join(dir, `${hash}_lock.json`), JSON.stringify({ pid: 1, port: 1, timestamp: 1 }))

    ensureMcpRemoteClientName('https://mcp.stripe.com', 'TabTin')

    expect(existsSync(clientInfoPath)).toBe(false)
    expect(existsSync(join(dir, `${hash}_lock.json`))).toBe(false)
  })

  it('keeps client_info when client_name already matches', async () => {
    const { ensureMcpRemoteClientName, mcpRemoteServerUrlHash } = await import('../mcp-remote-client')
    const hash = mcpRemoteServerUrlHash('https://mcp.stripe.com')
    const dir = join(home, '.mcp-auth', 'mcp-remote-0.1.37')
    mkdirSync(dir, { recursive: true })
    const clientInfoPath = join(dir, `${hash}_client_info.json`)
    const payload = { client_name: 'TabTin', client_id: 'oacli_ok', scope: 'mcp' }
    writeFileSync(clientInfoPath, JSON.stringify(payload))

    ensureMcpRemoteClientName('https://mcp.stripe.com', 'TabTin')

    expect(JSON.parse(readFileSync(clientInfoPath, 'utf8'))).toEqual(payload)
  })
})
