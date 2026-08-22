/**
 * Tests for MA-P1-3 and MA-P1-4 fixes.
 *
 * MA-P1-3: sendAgentEvent must throw on !response.ok (parity with Electron).
 * MA-P1-4: MEMO_TOOLS must expose tabtin_memo_update and tabtin_memo_delete in tools/list.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import http from 'node:http'
import { TabTinMcpServer } from '../src/transport/mcp/mcp-server.js'

// ── MA-P1-3: sendAgentEvent throws on failure ──

describe('MA-P1-3 — sendAgentEvent throws on !response.ok', () => {
  const sourcePath = path.resolve(__dirname, '../src/transport/gateway/gateway-client.ts')

  it('should throw Error instead of logging warn when response is not ok', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8')
    const sendMethodMatch = source.match(
      /async sendAgentEvent\b[\s\S]*?^\s{2}\}/m,
    )
    expect(sendMethodMatch).not.toBeNull()
    const methodBody = sendMethodMatch![0]
    expect(methodBody).toContain('throw new Error')
    expect(methodBody).not.toMatch(/this\.logger\.warn\(.*Failed to send agent event/)
  })

  it('daemon sendAgentEvent keeps the host-independent failure contract', () => {
    const daemonSource = fs.readFileSync(sourcePath, 'utf-8')
    const daemonMatch = daemonSource.match(
      /async sendAgentEvent\b[\s\S]*?^\s{2}\}/m,
    )
    expect(daemonMatch).not.toBeNull()
    const daemonBody = daemonMatch![0]
    expect(daemonBody).toContain('throw new Error')
  })
})

// ── MA-P1-4: MEMO_TOOLS includes memo_update and memo_delete ──

const mockFetch = vi.fn()
const originalFetch = globalThis.fetch
const contentApi = {
  async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await mockFetch(`https://api.example.com/api${path}`, init)
    const payload = await response.json()
    return payload?.success && 'data' in payload ? payload.data : payload
  },
  get(path: string): Promise<unknown> { return this.request(path) },
}

describe('MA-P1-4 — MEMO_TOOLS exposes memo_update and memo_delete', () => {
  let server: TabTinMcpServer
  let port: number
  let token: string

  beforeAll(async () => {
    globalThis.fetch = mockFetch as any
    server = new TabTinMcpServer({
      contentApi,
    })
    port = await server.start()
    token = server.getBearerToken()
  })

  beforeEach(() => {
    mockFetch.mockReset()
  })

  afterAll(async () => {
    await server.stop()
    globalThis.fetch = originalFetch
  })

  function rpc(method: string, params?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())))
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  it('tools/list includes tabtin_memo_update', async () => {
    const resp = await rpc('tools/list')
    const names: string[] = resp.result.tools.map((t: any) => t.name)
    expect(names).toContain('tabtin_memo_update')
  })

  it('tools/list includes tabtin_memo_delete', async () => {
    const resp = await rpc('tools/list')
    const names: string[] = resp.result.tools.map((t: any) => t.name)
    expect(names).toContain('tabtin_memo_delete')
  })

  it('tabtin_memo_update schema has memo_id as required', async () => {
    const resp = await rpc('tools/list')
    const tool = resp.result.tools.find((t: any) => t.name === 'tabtin_memo_update')
    expect(tool).toBeDefined()
    expect(tool.inputSchema.required).toContain('memo_id')
    expect(tool.inputSchema.properties.memo_id).toBeDefined()
    expect(tool.inputSchema.properties.content_markdown).toBeDefined()
    expect(tool.inputSchema.properties.tags).toBeDefined()
    expect(tool.inputSchema.properties.color).toBeDefined()
    expect(tool.inputSchema.properties.importance).toBeDefined()
  })

  it('tabtin_memo_delete schema has memo_id as required', async () => {
    const resp = await rpc('tools/list')
    const tool = resp.result.tools.find((t: any) => t.name === 'tabtin_memo_delete')
    expect(tool).toBeDefined()
    expect(tool.inputSchema.required).toContain('memo_id')
    expect(tool.inputSchema.properties.memo_id).toBeDefined()
  })

})
