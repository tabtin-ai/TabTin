/**
 * Tests for TabDoc MCP P1 fixes:
 *   CE-P1-03: tabtin_doc_update mutual exclusion (content vs status/parent_id)
 *   CE-P1-04: tabtin_doc_update passes base_updated_at to Django
 *   CE-P1-05: Block-level document tools (list/read/update/insert/delete)
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { TabTinMcpServer } from '../src/transport/mcp/mcp-server.js'
import { McpToolApplication } from '../src/application/mcp/mcp-tool-application.js'
import type { TableKernelService } from '../src/platform/table/table-kernel-service.js'

function ok<T>(data?: T) {
  return { success: true, data, errors: [] }
}

function createMockKernel(): TableKernelService {
  return {
    createTable: vi.fn().mockResolvedValue(ok({ tableId: 't1' })),
    updateTable: vi.fn().mockResolvedValue(ok()),
    deleteTable: vi.fn().mockResolvedValue(ok()),
    archiveTable: vi.fn().mockResolvedValue(ok()),
    restoreTable: vi.fn().mockResolvedValue(ok()),
    createField: vi.fn().mockResolvedValue(ok({ fieldId: 'f1' })),
    updateField: vi.fn().mockResolvedValue(ok()),
    deleteField: vi.fn().mockResolvedValue(ok()),
    createView: vi.fn().mockResolvedValue(ok({ viewId: 'v1' })),
    updateView: vi.fn().mockResolvedValue(ok()),
    deleteView: vi.fn().mockResolvedValue(ok()),
    createRecord: vi.fn().mockResolvedValue(ok({ recordId: 'r1' })),
    updateRecord: vi.fn().mockResolvedValue(ok()),
    deleteRecord: vi.fn().mockResolvedValue(ok()),
    batchCreateRecords: vi.fn().mockResolvedValue(ok({ recordIds: ['r1', 'r2'], count: 2 })),
    batchUpdateRecords: vi.fn().mockResolvedValue(ok({ count: 1 })),
    batchDeleteRecords: vi.fn().mockResolvedValue(ok({ count: 1 })),
    query: vi.fn().mockResolvedValue([{ id: 1, name: 'test' }]),
  } as unknown as TableKernelService
}

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

function rpc(port: number, method: string, params?: Record<string, unknown>, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers,
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

// ── Sample ProseMirror JSON document ──

const SAMPLE_PM_JSON = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] },
  ],
}

function mockDocDetailResponse() {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve({
      success: true,
      data: {
        document: { id: 'doc1', title: 'Test', latest_version: 3, updated_at: '2026-03-15T00:00:00Z' },
        content: { description_json: structuredClone(SAMPLE_PM_JSON), description_markdown: '', description_plaintext: '' },
      },
    }),
  }
}

function mockSaveContentResponse() {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve({
      success: true,
      data: {
        document: { id: 'doc1', title: 'Test', latest_version: 4, updated_at: '2026-03-15T01:00:00Z' },
        content: { description_json: {}, description_markdown: '', description_plaintext: '' },
      },
    }),
  }
}

function mockPatchResponse() {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve({
      success: true,
      data: { document: { id: 'doc1', title: 'Updated', latest_version: 4 } },
    }),
  }
}

function mockAgentWriteResponse() {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve({
      success: true,
      data: { document: { id: 'doc1', title: 'Test', latest_version: 4 } },
    }),
  }
}

function mockDocCreateResponse() {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve({
      success: true,
      data: { document: { id: 'doc-new', title: 'New Doc', latest_version: 1 } },
    }),
  }
}

// ──  follow-up: create body parameter naming ──

describe('#751: tabtin_doc_create markdown parameter', () => {
  let server: McpToolApplication

  beforeAll(() => {
    globalThis.fetch = mockFetch as any
    server = new McpToolApplication({
      contentApi,
    })
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    mockFetch.mockClear()
  })

  it('exposes markdown as the preferred initial body field', () => {
    const tools = (server as any).getAllTools() as Array<{ name: string; inputSchema: any }>
    const docCreate = tools.find(t => t.name === 'tabtin_doc_create')
    expect(docCreate).toBeDefined()
    expect(docCreate!.inputSchema.properties.markdown).toBeDefined()
    expect(docCreate!.inputSchema.properties.markdown.description).toContain('--markdown')
    expect(docCreate!.inputSchema.properties.content).toBeUndefined()
  })

  it('maps markdown to initial_content_markdown', async () => {
    mockFetch.mockResolvedValueOnce(mockDocCreateResponse())
    await (server as any).document.toolDocCreate({
      organization_id: 'wt1',
      space_id: 'sp1',
      title: '红烧肉菜谱',
      markdown: '# 红烧肉',
    })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.initial_content_markdown).toBe('# 红烧肉')
    expect(body.content).toBeUndefined()
  })
})

// ── CE-P1-03: Mutual exclusion check (tested via internal method to bypass HITL) ──

describe('CE-P1-03: tabtin_doc_update mutual exclusion', () => {
  let server: McpToolApplication

  beforeAll(() => {
    globalThis.fetch = mockFetch as any
    server = new McpToolApplication({
      contentApi,
    })
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    mockFetch.mockClear()
  })

  it('rejects content + status simultaneously', async () => {
    await expect(
      (server as any).document.toolDocUpdate({ doc_id: 'doc1', content: '# New', status: 'archived' }),
    ).rejects.toThrow('mutually exclusive')
  })

  it('rejects content + parent_id simultaneously', async () => {
    await expect(
      (server as any).document.toolDocUpdate({ doc_id: 'doc1', content: '# New', parent_id: 'p1' }),
    ).rejects.toThrow('mutually exclusive')
  })

  it('rejects content + both status and parent_id', async () => {
    await expect(
      (server as any).document.toolDocUpdate({ doc_id: 'doc1', content: '# New', status: 'archived', parent_id: 'p1' }),
    ).rejects.toThrow('mutually exclusive')
  })

  it('allows content alone', async () => {
    mockFetch.mockResolvedValueOnce(mockAgentWriteResponse())
    const result = await (server as any).document.toolDocUpdate({ doc_id: 'doc1', content: '# New content' })
    expect(result.content[0].text).toBeDefined()
  })

  it('allows status alone', async () => {
    mockFetch.mockResolvedValueOnce(mockPatchResponse())
    const result = await (server as any).document.toolDocUpdate({ doc_id: 'doc1', status: 'archived' })
    expect(result.content[0].text).toContain('success')
  })

  it('allows parent_id alone', async () => {
    mockFetch.mockResolvedValueOnce(mockPatchResponse())
    const result = await (server as any).document.toolDocUpdate({ doc_id: 'doc1', parent_id: 'p2' })
    expect(result.content[0].text).toContain('success')
  })
})

// ── CE-P1-04: base_updated_at passthrough ──

describe('CE-P1-04: tabtin_doc_update base_updated_at', () => {
  let server: McpToolApplication

  beforeAll(() => {
    globalThis.fetch = mockFetch as any
    server = new McpToolApplication({
      contentApi,
    })
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    mockFetch.mockClear()
  })

  it('inputSchema includes base_updated_at field', () => {
    const tools = (server as any).getAllTools() as Array<{ name: string; inputSchema: any }>
    const docUpdate = tools.find(t => t.name === 'tabtin_doc_update')
    expect(docUpdate).toBeDefined()
    expect(docUpdate!.inputSchema.properties.base_updated_at).toBeDefined()
    expect(docUpdate!.inputSchema.properties.base_updated_at.type).toBe('string')
  })

  it('PATCH request body includes base_updated_at when provided', async () => {
    mockFetch.mockResolvedValueOnce(mockPatchResponse())
    await (server as any).document.toolDocUpdate({
      doc_id: 'doc1',
      title: 'New Title',
      base_version: 5,
      base_updated_at: '2026-03-15T12:00:00Z',
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.title).toBe('New Title')
    expect(body.base_version).toBe(5)
    expect(body.base_updated_at).toBe('2026-03-15T12:00:00Z')
  })

  it('PATCH request body includes status when provided', async () => {
    mockFetch.mockResolvedValueOnce(mockPatchResponse())
    await (server as any).document.toolDocUpdate({ doc_id: 'doc1', status: 'archived' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.status).toBe('archived')
  })

  it('PATCH request body includes parent_id when provided', async () => {
    mockFetch.mockResolvedValueOnce(mockPatchResponse())
    await (server as any).document.toolDocUpdate({ doc_id: 'doc1', parent_id: 'folder-1' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.parent_id).toBe('folder-1')
  })
})

// ── CE-P1-05: Block-level tools ──

describe('CE-P1-05: block-level document tools', () => {
  let server: TabTinMcpServer
  let port: number
  let token: string

  beforeAll(async () => {
    globalThis.fetch = mockFetch as any
    server = new TabTinMcpServer({
      contentApi,
      table: createMockKernel(),
    })
    port = await server.start()
    token = server.getBearerToken()
  })

  afterAll(async () => {
    await server.stop()
    globalThis.fetch = originalFetch
  })

  describe('tool registration', () => {
    it('all 5 block tools appear in tools/list', async () => {
      const resp = await rpc(port, 'tools/list', undefined, token)
      const names = resp.result.tools.map((t: any) => t.name) as string[]
      expect(names).toContain('tabtin_doc_list_blocks')
      expect(names).toContain('tabtin_doc_read_block')
      expect(names).toContain('tabtin_doc_update_block')
      expect(names).toContain('tabtin_doc_insert_block')
      expect(names).toContain('tabtin_doc_delete_block')
    })

    it('block tools appear in getLocalToolNames()', () => {
      const names = server.getLocalToolNames()
      expect(names).toContain('tabtin_doc_list_blocks')
      expect(names).toContain('tabtin_doc_read_block')
      expect(names).toContain('tabtin_doc_update_block')
      expect(names).toContain('tabtin_doc_insert_block')
      expect(names).toContain('tabtin_doc_delete_block')
    })
  })

  describe('tabtin_doc_list_blocks', () => {
    it('returns all blocks with index, type, and preview', async () => {
      mockFetch.mockResolvedValueOnce(mockDocDetailResponse())
      const resp = await rpc(port, 'tools/call', {
        name: 'tabtin_doc_list_blocks',
        arguments: { doc_id: 'doc1' },
      }, token)
      expect(resp.result.isError).toBeUndefined()
      const data = JSON.parse(resp.result.content[0].text)
      expect(data.total).toBe(3)
      expect(data.blocks[0]).toEqual({ block_index: 0, type: 'heading', text_preview: 'Title' })
      expect(data.blocks[1]).toEqual({ block_index: 1, type: 'paragraph', text_preview: 'Hello world' })
      expect(data.blocks[2]).toEqual({ block_index: 2, type: 'paragraph', text_preview: 'Second paragraph' })
      expect(data.latest_version).toBe(3)
    })

    it('rejects when doc_id is missing', async () => {
      const resp = await rpc(port, 'tools/call', {
        name: 'tabtin_doc_list_blocks',
        arguments: {},
      }, token)
      expect(resp.result.isError).toBe(true)
      expect(resp.result.content[0].text).toContain('doc_id')
    })
  })

  describe('tabtin_doc_read_block', () => {
    it('reads a single block by index', async () => {
      mockFetch.mockResolvedValueOnce(mockDocDetailResponse())
      const resp = await rpc(port, 'tools/call', {
        name: 'tabtin_doc_read_block',
        arguments: { doc_id: 'doc1', block_index: 1 },
      }, token)
      expect(resp.result.isError).toBeUndefined()
      const data = JSON.parse(resp.result.content[0].text)
      expect(data.block_index).toBe(1)
      expect(data.block.type).toBe('paragraph')
      expect(data.block.content[0].text).toBe('Hello world')
    })

    it('rejects out-of-range index', async () => {
      mockFetch.mockResolvedValueOnce(mockDocDetailResponse())
      const resp = await rpc(port, 'tools/call', {
        name: 'tabtin_doc_read_block',
        arguments: { doc_id: 'doc1', block_index: 99 },
      }, token)
      expect(resp.result.isError).toBe(true)
      expect(resp.result.content[0].text).toContain('out of range')
    })
  })

})

// ── Unit tests for block helper methods (bypass HITL by testing internals) ──

describe('CE-P1-05: block operations logic (internal)', () => {
  let server: McpToolApplication

  beforeAll(() => {
    globalThis.fetch = mockFetch as any
    server = new McpToolApplication({
      contentApi,
    })
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    mockFetch.mockClear()
  })

  it('fetchDocBlocks extracts blocks from Django response', async () => {
    mockFetch.mockResolvedValueOnce(mockDocDetailResponse())
    const { blocks, version } = await (server as any).document.fetchDocBlocks('doc1')
    expect(blocks).toHaveLength(3)
    expect(blocks[0].type).toBe('heading')
    expect(version).toBe(3)
  })

  it('blockPreview extracts text from nested content', () => {
    const block = { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }
    const preview = (server as any).document.blockPreview(block)
    expect(preview).toBe('Hello world')
  })

  it('blockPreview truncates long text', () => {
    const longText = 'A'.repeat(200)
    const block = { type: 'paragraph', content: [{ type: 'text', text: longText }] }
    const preview = (server as any).document.blockPreview(block)
    expect(preview.length).toBeLessThanOrEqual(121)
    expect(preview).toContain('…')
  })

  it('saveDocBlocks sends correct payload with CAS fields', async () => {
    mockFetch.mockResolvedValueOnce(mockSaveContentResponse())
    const blocks = [{ type: 'paragraph', content: [{ type: 'text', text: 'Only block' }] }]
    await (server as any).document.saveDocBlocks('doc1', blocks, 3, '2026-03-15T00:00:00Z')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const call = mockFetch.mock.calls[0]
    const body = JSON.parse(call[1].body)
    expect(body.content_pm_json).toEqual({ type: 'doc', content: blocks })
    expect(body.base_version).toBe(3)
    expect(body.base_updated_at).toBe('2026-03-15T00:00:00Z')
  })

  it('toolDocUpdateBlock replaces block at index', async () => {
    mockFetch.mockResolvedValueOnce(mockDocDetailResponse())
    mockFetch.mockResolvedValueOnce(mockSaveContentResponse())
    const newBlock = { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Updated' }] }
    await (server as any).document.toolDocUpdateBlock({ doc_id: 'doc1', block_index: 0, block: newBlock })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const saved = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(saved.content_pm_json.content[0]).toEqual(newBlock)
    expect(saved.content_pm_json.content).toHaveLength(3)
  })

  it('toolDocInsertBlock inserts block at index', async () => {
    mockFetch.mockResolvedValueOnce(mockDocDetailResponse())
    mockFetch.mockResolvedValueOnce(mockSaveContentResponse())
    const newBlock = { type: 'paragraph', content: [{ type: 'text', text: 'Inserted' }] }
    await (server as any).document.toolDocInsertBlock({ doc_id: 'doc1', block_index: 1, block: newBlock })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const saved = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(saved.content_pm_json.content).toHaveLength(4)
    expect(saved.content_pm_json.content[1]).toEqual(newBlock)
  })

  it('toolDocDeleteBlock removes block at index', async () => {
    mockFetch.mockResolvedValueOnce(mockDocDetailResponse())
    mockFetch.mockResolvedValueOnce(mockSaveContentResponse())
    await (server as any).document.toolDocDeleteBlock({ doc_id: 'doc1', block_index: 1 })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const saved = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(saved.content_pm_json.content).toHaveLength(2)
    expect(saved.content_pm_json.content[0].type).toBe('heading')
    expect(saved.content_pm_json.content[1].content[0].text).toBe('Second paragraph')
  })

  it('toolDocUpdateBlock rejects out-of-range index', async () => {
    mockFetch.mockResolvedValueOnce(mockDocDetailResponse())
    await expect(
      (server as any).document.toolDocUpdateBlock({ doc_id: 'doc1', block_index: 10, block: { type: 'paragraph' } }),
    ).rejects.toThrow('out of range')
  })

  it('toolDocInsertBlock allows index == blocks.length (append)', async () => {
    mockFetch.mockResolvedValueOnce(mockDocDetailResponse())
    mockFetch.mockResolvedValueOnce(mockSaveContentResponse())
    const newBlock = { type: 'paragraph', content: [{ type: 'text', text: 'Appended' }] }
    await (server as any).document.toolDocInsertBlock({ doc_id: 'doc1', block_index: 3, block: newBlock })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const saved = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(saved.content_pm_json.content).toHaveLength(4)
    expect(saved.content_pm_json.content[3]).toEqual(newBlock)
  })

  it('toolDocDeleteBlock rejects negative index', async () => {
    mockFetch.mockResolvedValueOnce(mockDocDetailResponse())
    await expect(
      (server as any).document.toolDocDeleteBlock({ doc_id: 'doc1', block_index: -1 }),
    ).rejects.toThrow('out of range')
  })

  it('rejects non-integer block_index (float)', async () => {
    await expect(
      (server as any).document.toolDocReadBlock({ doc_id: 'doc1', block_index: 1.5 }),
    ).rejects.toThrow('must be an integer')
  })

  it('rejects non-integer block_index (string)', async () => {
    await expect(
      (server as any).document.toolDocReadBlock({ doc_id: 'doc1', block_index: 'abc' }),
    ).rejects.toThrow('must be an integer')
  })
})
