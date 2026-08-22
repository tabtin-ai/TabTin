/** HTTP + JSON-RPC adapter for the MCP tool application. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveDisabledToolPrefixes } from '@tabtin/agent-wire'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import { atomicWriteFile } from '@tabtin/terminal-core'

import {
  McpToolApplication,
  type McpRequestContext,
  type McpServerConfig,
} from '../../application/mcp/mcp-tool-application.js'

export type { McpServerConfig } from '../../application/mcp/mcp-tool-application.js'

interface McpRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

const MCP_CONFIG_FILE = join(getHomeTabtinPath(), 'mcp-server.json')
const MAX_BODY_BYTES = 10 * 1024 * 1024
const MAX_CONCURRENT_CALLS = 5

export class TabTinMcpServer {
  private server: Server | null = null
  private port = 0
  private activeCalls = 0
  private readonly bearerToken = randomBytes(32).toString('hex')
  private readonly tools: McpToolApplication

  constructor(config: McpServerConfig) {
    this.tools = new McpToolApplication(config)
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } }))
        })
      })
      this.server.listen(0, '127.0.0.1', async () => {
        const address = this.server?.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        try {
          await this.writeConfig()
          resolve(this.port)
        } catch (error) {
          const server = this.server
          this.server = null
          server?.close(() => reject(error))
        }
      })
      this.server.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await unlink(MCP_CONFIG_FILE).catch(() => undefined)
  }

  suspendIngress(): void {
    this.server?.close()
  }

  getRuntimeStatus(): { running: boolean; tools: string[]; port?: number; endpoint?: string; error?: string } {
    if (!this.server || this.port <= 0) return { running: false, tools: [], error: 'MCP server not started' }
    return {
      running: true,
      tools: this.tools.getAllTools().map(tool => tool.name),
      port: this.port,
      endpoint: `http://127.0.0.1:${this.port}/mcp`,
    }
  }

  getActiveCallCount(): number { return this.activeCalls }
  getPort(): number { return this.port }
  getBearerToken(): string { return this.bearerToken }
  getLocalToolNames(): string[] { return this.tools.getLocalToolNames() }
  getNonLlmFacingAdapterToolNames(): string[] { return this.tools.getNonLlmFacingAdapterToolNames() }

  private async writeConfig(): Promise<void> {
    await mkdir(getHomeTabtinPath(), { recursive: true })
    await atomicWriteFile(MCP_CONFIG_FILE, JSON.stringify({
      port: this.port,
      endpoint: `http://127.0.0.1:${this.port}/mcp`,
      bearer_token: this.bearerToken,
      tools: this.tools.getAllTools().map(tool => tool.name),
      pid: process.pid,
    }, null, 2), 0o600)
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', 'null')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (req.method === 'GET' && req.url === '/health') {
      this.sendJson(res, 200, { status: 'ok', tools: this.tools.getAllTools().length, pid: process.pid })
      return
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      this.sendJson(res, 404, { error: 'Not found' })
      return
    }
    if (!this.validateBearerToken(req)) {
      this.sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized: invalid or missing Bearer token' } })
      return
    }
    let request: McpRequest
    try {
      request = JSON.parse(await this.readBody(req)) as McpRequest
    } catch {
      this.sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } })
      return
    }
    this.sendJson(res, 200, await this.handleRpc(request, this.buildRequestContext(req)))
  }

  private async handleRpc(req: McpRequest, context: McpRequestContext): Promise<Record<string, unknown>> {
    if (req.method === 'initialize') return {
      jsonrpc: '2.0', id: req.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tabtin-mcp-server', version: '0.2.0' } },
    }
    if (req.method === 'tools/list') return {
      jsonrpc: '2.0', id: req.id,
      result: { tools: this.tools.filterDisabledTools(this.tools.getAllTools(), context) },
    }
    if (req.method === 'tools/call') return this.executeToolCall(req, context)
    if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled' || req.method.startsWith('notifications/')) {
      return { jsonrpc: '2.0', id: req.id, result: {} }
    }
    return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } }
  }

  private async executeToolCall(req: McpRequest, context: McpRequestContext): Promise<Record<string, unknown>> {
    if (this.activeCalls >= MAX_CONCURRENT_CALLS) {
      return { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'Too many concurrent requests' } }
    }
    this.activeCalls += 1
    try {
      const params = req.params ?? {}
      const result = await this.tools.executeTool(
        params.name as string,
        (params.arguments ?? {}) as Record<string, unknown>,
        context,
      )
      return { jsonrpc: '2.0', id: req.id, result }
    } finally {
      this.activeCalls -= 1
    }
  }

  private buildRequestContext(req: IncomingMessage): McpRequestContext {
    const disabledApps = this.parseCsvHeader(req.headers['x-disabled-apps'])
    const explicitPrefixes = this.parseCsvHeader(req.headers['x-disabled-tool-prefixes'])
    return { disabledApps, disabledToolPrefixes: resolveDisabledToolPrefixes(disabledApps, explicitPrefixes) }
  }

  private parseCsvHeader(value: string | string[] | undefined): string[] {
    const raw = Array.isArray(value) ? value.join(',') : value
    return raw ? raw.split(',').map(part => part.trim()).filter(Boolean) : []
  }

  private validateBearerToken(req: IncomingMessage): boolean {
    const [scheme, token, extra] = req.headers.authorization?.split(' ') ?? []
    if (scheme?.toLowerCase() !== 'bearer' || !token || extra) return false
    const provided = Buffer.from(token)
    const expected = Buffer.from(this.bearerToken)
    return provided.length === expected.length && timingSafeEqual(provided, expected)
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) { req.destroy(); reject(new Error('Request body too large')); return }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      req.on('error', reject)
    })
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}
