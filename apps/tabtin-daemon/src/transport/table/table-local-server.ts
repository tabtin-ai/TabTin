/**
 * TableLocalServer — Daemon 的本地 HTTP 服务
 *
 * 让 CLI 的读命令可以直接连到 Daemon 的 PGlite 引擎，
 * 而不需要绕行 Electron → Django。
 *
 * 监听 127.0.0.1 的动态端口，端口写入 ~/.tabtin/daemon-table.json。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import { atomicWriteFile } from '@tabtin/terminal-core'
import type { FilterSet, SortConfig } from '@tabtin/table-kernel'
import {
  externalFilterToKernel,
  externalSortsToKernel,
} from '@tabtin/table-kernel'
import type { ExternalFilterSet } from '@tabtin/table-kernel'
import type { ViewType, FieldType, UpdateViewInput } from '@tabtin/table-kernel'
import type { TableApplicationPort } from '../../application/table/table-application-port.js'
import { consoleLogger, type KernelLogger } from '../../platform/observability/logging/logger.js'

const DAEMON_TABLE_CONFIG_DIR = getHomeTabtinPath()
const DAEMON_TABLE_CONFIG_FILE = join(DAEMON_TABLE_CONFIG_DIR, 'daemon-table.json')

const SQL_READONLY_RE = /^\s*(SELECT|WITH|EXPLAIN)\s/i
const SQL_WRITE_OPS_RE = /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|DROP\s|ALTER\s|TRUNCATE\s|CREATE\s)/i
const SQL_MULTI_STMT_RE = /;/

export interface TableConnectionInfoPublisher {
  publish(info: { port: number; bearerToken: string }): Promise<void>
  unpublish(): Promise<void>
}

const fileConnectionInfoPublisher: TableConnectionInfoPublisher = {
  async publish({ port, bearerToken }) {
    await mkdir(DAEMON_TABLE_CONFIG_DIR, { recursive: true })
    await atomicWriteFile(
      DAEMON_TABLE_CONFIG_FILE,
      JSON.stringify({ port, bearer_token: bearerToken, pid: process.pid }, null, 2),
      0o600,
    )
  },
  async unpublish() {
    try { await unlink(DAEMON_TABLE_CONFIG_FILE) } catch { /* ignore */ }
  },
}

export class TableLocalServer {
  private server: Server | null = null
  private port = 0
  private readonly log: KernelLogger
  private readonly bearerToken: string
  private startPromise: Promise<number> | null = null
  private suspended = false

  constructor(
    private kernelService: TableApplicationPort,
    logger?: KernelLogger,
    private readonly connectionInfo: TableConnectionInfoPublisher = fileConnectionInfoPublisher,
  ) {
    this.log = logger ?? consoleLogger
    this.bearerToken = randomBytes(32).toString('hex')
  }

  getBearerToken(): string {
    return this.bearerToken
  }

  async start(): Promise<number> {
    if (this.suspended) throw new Error('TableLocalServer ingress is suspended')
    if (this.server?.listening) return this.port
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startOnce().finally(() => { this.startPromise = null })
    return this.startPromise
  }

  private async startOnce(): Promise<number> {
    const server = createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res)
      } catch (err) {
        this.log.error('[TableLocalServer] unhandled error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    })
    this.server = server

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onError)
          resolve()
        })
      })
      const addr = server.address()
      this.port = typeof addr === 'object' && addr ? addr.port : 0
      if (this.suspended) throw new Error('TableLocalServer ingress is suspended')
      await this.connectionInfo.publish({ port: this.port, bearerToken: this.bearerToken })
      if (this.suspended) throw new Error('TableLocalServer ingress is suspended')
      return this.port
    } catch (error) {
      await this.closeServer(server)
      if (this.server === server) this.server = null
      this.port = 0
      await this.connectionInfo.unpublish()
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.startPromise?.catch(() => undefined)
    if (this.server) {
      await this.closeServer(this.server)
      this.server = null
    }
    await this.connectionInfo.unpublish()
    this.suspended = false
  }

  async suspendIngress(): Promise<void> {
    this.suspended = true
    await this.startPromise?.catch(() => undefined)
    if (this.server) await this.closeServer(this.server)
    await this.connectionInfo.unpublish()
  }

  private closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
    })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    const path = url.pathname
    res.setHeader('Content-Type', 'application/json')

    if (!this.kernelService.isReady) {
      res.writeHead(503)
      res.end(JSON.stringify({ error: 'TableKernelService not ready' }))
      return
    }

    if (req.method === 'GET' && path === '/health') {
      return this.handleHealth(res)
    }

    if (!this.validateBearerToken(req)) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing Bearer token' }))
      return
    }

    if (await this.handleCoreTableRoute(req, res, url, path)) return

    if (await this.handleRecordRoute(req, res, url, path)) return
    if (await this.handleFieldRoute(req, res, url, path)) return
    if (await this.handleTableRoute(req, res, path)) return
    if (await this.handleViewRoute(req, res, path)) return

    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
  }

  private async handleCoreTableRoute(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<boolean> {
    if (req.method === 'GET' && path === '/table/sync-status') { await this.handleSyncStatus(res, url.searchParams.get('tableId')); return true }
    if (req.method === 'POST' && path === '/table/query') { await withJsonBody(req, res, data => this.handleQuery(data, res)); return true }
    if (req.method === 'POST' && path === '/table/filter-query') { await withJsonBody(req, res, data => this.handleFilterQuery(data, res)); return true }
    if (req.method === 'POST' && path === '/table/records/batch') { await withJsonBody(req, res, data => this.handleBatch(data, res)); return true }
    return false
  }

  private async handleRecordRoute(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<boolean> {
    if (req.method === 'POST' && path === '/table/records') { await withJsonBody(req, res, data => this.handleCreateRecord(data, res)); return true }
    const match = path.match(/^\/table\/records\/([^/]+)$/)
    if (!match) return false
    const id = decodeURIComponent(match[1])
    if (req.method === 'PATCH') { await withJsonBody(req, res, data => this.handleUpdateRecord(data, res, id)); return true }
    if (req.method === 'DELETE') { await this.handleDeleteRecord(res, id, url.searchParams.get('tableId')); return true }
    return false
  }

  private async handleFieldRoute(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<boolean> {
    if (req.method === 'POST' && path === '/fields') { await withJsonBody(req, res, data => this.handleCreateField(data, res)); return true }
    const match = path.match(/^\/fields\/([^/]+)$/)
    if (!match) return false
    const id = decodeURIComponent(match[1])
    if (req.method === 'PATCH') { await withJsonBody(req, res, data => this.handleUpdateField(data, res, id)); return true }
    if (req.method === 'DELETE') { await this.handleDeleteField(res, id, url.searchParams.get('tableId')); return true }
    return false
  }

  private async handleTableRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (req.method === 'POST' && path === '/tables') { await withJsonBody(req, res, data => this.handleCreateTable(data, res)); return true }
    const match = path.match(/^\/tables\/([^/]+)$/)
    if (match && req.method === 'PATCH') { await withJsonBody(req, res, data => this.handleUpdateTable(data, res, decodeURIComponent(match[1]))); return true }
    if (match && req.method === 'DELETE') { await this.handleDeleteTable(res, decodeURIComponent(match[1])); return true }
    const action = path.match(/^\/tables\/([^/]+)\/(archive|restore)$/)
    if (action && req.method === 'POST') { await this.handleTableAction(res, decodeURIComponent(action[1]), action[2] as 'archive' | 'restore'); return true }
    return false
  }

  private async handleViewRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (req.method === 'POST' && path === '/views') { await withJsonBody(req, res, data => this.handleCreateView(data, res)); return true }
    const match = path.match(/^\/views\/([^/]+)$/)
    if (!match) return false
    const id = decodeURIComponent(match[1])
    if (req.method === 'PATCH') { await withJsonBody(req, res, data => this.handleUpdateView(data, res, id)); return true }
    if (req.method === 'DELETE') { await this.handleDeleteView(res, id); return true }
    return false
  }

  private async handleHealth(res: ServerResponse): Promise<void> {
    const sync = await this.kernelService.listSyncStatus()
    const status = sync.some((item) => item.pending > 0 || item.processing > 0 || item.failed > 0 || item.lastFlushError)
      ? 'degraded'
      : 'ok'
    res.writeHead(200)
    res.end(JSON.stringify({
      status,
      tables: this.kernelService.getCachedTableIds(),
      recoveredProcessingCount: this.kernelService.getRecoveredProcessingCount(),
      sync,
    }))
  }

  private async handleSyncStatus(res: ServerResponse, tableId: string | null): Promise<void> {
    const sync = tableId
      ? await this.kernelService.getSyncStatus(tableId)
      : await this.kernelService.listSyncStatus()
    res.writeHead(200)
    res.end(JSON.stringify({
      recoveredProcessingCount: this.kernelService.getRecoveredProcessingCount(),
      sync,
    }))
  }

  private async handleQuery(data: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { sql, params } = data
    // Strip SQL comments before validation to prevent bypass via embedded comment tricks.
    // e.g. SELECT /* DROP TABLE users */ 1  would pass SQL_WRITE_OPS_RE without stripping.
    const stripped = (sql as string)
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    if (!SQL_READONLY_RE.test(stripped) || SQL_WRITE_OPS_RE.test(stripped) || SQL_MULTI_STMT_RE.test(stripped)) {
      res.writeHead(403)
      res.end(JSON.stringify({ error: 'Only single read-only queries (SELECT/WITH/EXPLAIN) are allowed' }))
      return
    }
    const rows = await this.kernelService.query(sql as string, params as unknown[])
    res.writeHead(200)
    res.end(JSON.stringify({ rows }))
  }

  private async handleFilterQuery(data: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { tableId, filter, sorts, limit, offset } = data
    if (!tableId) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'tableId is required' }))
      return
    }
    const kernelFilter = adaptFilter(filter)
    const kernelSorts = adaptSorts(sorts)
    const rows = await this.kernelService.queryWithFilter(tableId as string, kernelFilter, kernelSorts, limit as number | undefined, offset as number | undefined)
    res.writeHead(200)
    res.end(JSON.stringify({ rows }))
  }

  private async handleCreateRecord(data: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { tableId, data: recordData } = data
    if (!tableId || !recordData) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'tableId and data are required' }))
      return
    }
    const result = await this.kernelService.createRecord({ tableId: tableId as string, data: recordData as Record<string, unknown> })
    res.writeHead(result.success ? 201 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  private async handleUpdateRecord(data: Record<string, unknown>, res: ServerResponse, recordId: string): Promise<void> {
    const { tableId, data: recordData } = data
    if (!tableId || !recordData) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'tableId and data are required' }))
      return
    }
    const result = await this.kernelService.updateRecord({ tableId: tableId as string, recordId, data: recordData as Record<string, unknown> })
    res.writeHead(result.success ? 200 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  private async handleDeleteRecord(res: ServerResponse, recordId: string, tableId: string | null): Promise<void> {
    if (!tableId) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'tableId query parameter is required' }))
      return
    }
    const result = await this.kernelService.deleteRecord({ tableId, recordId })
    res.writeHead(result.success ? 200 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  private async handleBatch(data: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { tableId, action, records, recordIds, data: batchData } = data
    if (!tableId || !action) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'tableId and action are required. Valid actions: create, update, delete' }))
      return
    }

    let result
    switch (action) {
      case 'create':
        result = await this.kernelService.batchCreateRecords({ tableId: tableId as string, records: (records ?? []) as Record<string, unknown>[] })
        break
      case 'update':
        result = await this.kernelService.batchUpdateRecords({
          tableId: tableId as string,
          records: ((records ?? []) as Array<{ id: string; data?: Record<string, unknown> }>).map((r) => ({
            id: r.id,
            data: r.data ?? (batchData as Record<string, unknown>) ?? {},
          })),
        })
        break
      case 'delete':
        result = await this.kernelService.batchDeleteRecords({ tableId: tableId as string, recordIds: (recordIds ?? []) as string[] })
        break
      default:
        res.writeHead(400)
        res.end(JSON.stringify({ error: `Unknown batch action: "${action}". Valid actions: create, update, delete` }))
        return
    }
    res.writeHead(result.success ? (action === 'create' ? 201 : 200) : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  // ── Field handlers ──

  private async handleCreateField(data: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { tableId, name, fieldType, options } = data
    if (!tableId || !name || !fieldType) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'tableId, name, and fieldType are required' }))
      return
    }
    const result = await this.kernelService.createField({
      tableId: tableId as string,
      name: name as string,
      fieldType: fieldType as FieldType,
      options: options as Record<string, unknown> | undefined,
    })
    res.writeHead(result.success ? 201 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  private async handleUpdateField(data: Record<string, unknown>, res: ServerResponse, fieldId: string): Promise<void> {
    const { tableId, changes } = data
    if (!tableId) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'tableId is required in body' }))
      return
    }
    const result = await this.kernelService.updateField({
      tableId: tableId as string,
      fieldId,
      changes: (changes ?? {}) as Partial<{ name: string; options: Record<string, unknown> }>,
    })
    res.writeHead(result.success ? 200 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  private async handleDeleteField(res: ServerResponse, fieldId: string, tableId: string | null): Promise<void> {
    if (!tableId) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'tableId query parameter is required' }))
      return
    }
    const result = await this.kernelService.deleteField({ tableId, fieldId })
    res.writeHead(result.success ? 200 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  // ── Table handlers ──

  private async handleCreateTable(data: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { spaceId, name, description } = data
    if (!spaceId || !name) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'spaceId and name are required' }))
      return
    }
    const result = await this.kernelService.createTable({
      spaceId: spaceId as string,
      name: name as string,
      description: description as string | undefined,
    })
    res.writeHead(result.success ? 201 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  private async handleUpdateTable(data: Record<string, unknown>, res: ServerResponse, tableId: string): Promise<void> {
    const { changes } = data
    const result = await this.kernelService.updateTable({
      tableId,
      changes: (changes ?? {}) as Partial<{ name: string; description: string; icon: string }>,
    })
    res.writeHead(result.success ? 200 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  private async handleDeleteTable(res: ServerResponse, tableId: string): Promise<void> {
    const result = await this.kernelService.deleteTable(tableId)
    res.writeHead(result.success ? 200 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  private async handleTableAction(res: ServerResponse, tableId: string, action: 'archive' | 'restore'): Promise<void> {
    const result = action === 'archive'
      ? await this.kernelService.archiveTable(tableId)
      : await this.kernelService.restoreTable(tableId)
    res.writeHead(result.success ? 200 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  // ── View handlers ──

  private async handleCreateView(data: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { tableId, name, viewType } = data
    if (!tableId || !name || !viewType) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'tableId, name, and viewType are required' }))
      return
    }
    const result = await this.kernelService.createView({
      tableId: tableId as string,
      name: name as string,
      viewType: viewType as ViewType,
      ...extractViewOptionalFields(data),
    })
    res.writeHead(result.success ? 201 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  private async handleUpdateView(data: Record<string, unknown>, res: ServerResponse, viewId: string): Promise<void> {
    const normalizedChanges = normalizeViewChanges(data.changes)
    const result = await this.kernelService.updateView({
      viewId,
      changes: normalizedChanges,
    })
    res.writeHead(result.success ? 200 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  private async handleDeleteView(res: ServerResponse, viewId: string): Promise<void> {
    const result = await this.kernelService.deleteView(viewId)
    res.writeHead(result.success ? 200 : mapErrorStatus(result))
    res.end(JSON.stringify(result))
  }

  private validateBearerToken(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization
    if (!authHeader) return false
    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return false
    const provided = Buffer.from(parts[1])
    const expected = Buffer.from(this.bearerToken)
    if (provided.length !== expected.length) return false
    return timingSafeEqual(provided, expected)
  }
}


function mapErrorStatus(result: { success: boolean; errors: Array<{ code: string; message: string }> }): number {
  if (result.success) return 200
  const code = result.errors[0]?.code
  if (code === 'NOT_FOUND') return 404
  if (code === 'NOT_READY') return 503
  if (code === 'DB_ERROR') return 500
  return 400
}

function isExternalFormat(item: Record<string, unknown>): boolean {
  return 'field_id' in item && !('fieldId' in item)
}

function adaptFilter(filter: unknown): FilterSet | null | undefined {
  if (!filter || typeof filter !== 'object') return filter as null | undefined
  const f = filter as Record<string, unknown>

  if ('conjunction' in f && 'filterSet' in f) {
    const items = f.filterSet as unknown[]
    if (items.length > 0 && typeof items[0] === 'object' && items[0] !== null && isExternalFormat(items[0] as Record<string, unknown>)) {
      return externalFilterToKernel(filter as ExternalFilterSet) as FilterSet
    }
  }
  return filter as FilterSet
}

function adaptSorts(sorts: unknown): SortConfig[] | undefined {
  if (!Array.isArray(sorts) || sorts.length === 0) return sorts as undefined
  if (isExternalFormat(sorts[0])) {
    return externalSortsToKernel(sorts)
  }
  return sorts as SortConfig[]
}

const MAX_BODY = 10 * 1024 * 1024 // 10 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

async function withJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (data: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  const raw = await readBody(req)
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    res.writeHead(400)
    res.end(JSON.stringify({ error: 'Invalid JSON in request body' }))
    return
  }
  await handler(data as Record<string, unknown>)
}

function extractViewOptionalFields(data: Record<string, unknown>): Record<string, unknown> {
  const optional: Record<string, unknown> = {}
  for (const key of ['description', 'visibleFields', 'fieldOrder', 'filter', 'sorts', 'config'] as const) {
    if (data[key] !== undefined) optional[key] = data[key]
  }
  const columnMeta = data.column_meta ?? data.columnMeta
  if (columnMeta !== undefined) {
    optional.column_meta = columnMeta
  }
  return optional
}

function normalizeViewChanges(changes: unknown): UpdateViewInput['changes'] {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return {}
  }

  const normalized = { ...(changes as Record<string, unknown>) } as UpdateViewInput['changes'] & {
    columnMeta?: unknown
  }
  const columnMeta = normalized.column_meta ?? normalized.columnMeta
  if (columnMeta !== undefined) {
    normalized.column_meta = columnMeta
  }
  delete normalized.columnMeta
  return normalized
}
