import { API_ENDPOINTS } from '@tabtin/config'
import { McpDomainSupport } from './domain-support.js'
interface DjangoDocEntry { id: string; title?: string; created_at?: string; updated_at?: string }
interface DjangoDocListPayload { documents?: DjangoDocEntry[]; items?: DjangoDocEntry[] }
interface DjangoDocExportPayload { content?: string; markdown?: string; html?: string }
interface DjangoDocSearchEntry { document?: DjangoDocEntry; id: string; title?: string; snippet?: string; highlight?: string; score?: number; relevance_score?: number }
interface DjangoDocSearchPayload { results?: DjangoDocSearchEntry[]; items?: DjangoDocSearchEntry[] }
export class DocumentMcpDomain extends McpDomainSupport {
  async toolDocList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'organization_id', 'space_id')
    const page = (args.page as number) || 1
    const pageSize = Math.min((args.page_size as number) || 200, 500)
    const params = new URLSearchParams({
      organization_id: String(args.organization_id),
      space_id: String(args.space_id),
      page: String(page),
      page_size: String(pageSize),
    })
    if (args.include_archived) params.set('include_archived', 'true')
    const path = `${API_ENDPOINTS.TABDOC.DOCUMENTS}?${params}`
    const data = await this.get(path) as DjangoDocListPayload & { total?: number; page?: number; page_size?: number }
    const source = data.documents ?? data.items ?? []
    const docs = source.map((d) => ({
      id: d.id,
      title: d.title || 'Untitled',
      created_at: d.created_at,
      updated_at: d.updated_at,
    }))
    return {
      content: [{ type: 'text', text: JSON.stringify({ documents: docs, total: data.total ?? docs.length, page, page_size: pageSize }, null, 2) }],
    }
  }

  async toolDocRead(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const docId = args.doc_id as string
    const format = (args.format as string) || 'markdown'

    const [docData, exportData] = await Promise.all([
      this.get(API_ENDPOINTS.TABDOC.DOCUMENT_DETAIL(docId)) as Promise<Record<string, unknown>>,
      this.get(API_ENDPOINTS.TABDOC.DOCUMENT_EXPORT(docId, format)) as Promise<DjangoDocExportPayload>,
    ])
    const doc = (docData.document ?? docData) as Record<string, unknown>
    const content = exportData.content ?? exportData.markdown ?? exportData.html ?? JSON.stringify(exportData)
    return {
      content: [{ type: 'text', text: JSON.stringify({
        id: doc.id ?? docId,
        title: doc.title ?? 'Untitled',
        latest_version: doc.latest_version,
        updated_at: doc.updated_at,
        content,
      }, null, 2) }],
    }
  }

  async toolDocSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'query', 'organization_id', 'space_id')
    const query = args.query as string
    const page = (args.page as number) || 1
    const limit = (args.limit as number) || 20

    const params = new URLSearchParams({
      q: query,
      organization_id: String(args.organization_id),
      space_id: String(args.space_id),
      page: String(page),
      page_size: String(limit),
    })

    const data = await this.get(`${API_ENDPOINTS.TABDOC.SEARCH}?${params}`) as DjangoDocSearchPayload & { total?: number; page?: number }
    const source = data.results ?? data.items ?? []
    const results = source.map((d) => ({
      id: d.document?.id ?? d.id,
      title: d.document?.title ?? d.title ?? 'Untitled',
      snippet: d.snippet || d.highlight || '',
      score: d.relevance_score ?? d.score,
    }))
    return {
      content: [{ type: 'text', text: JSON.stringify({ results, total: data.total ?? results.length, page }, null, 2) }],
    }
  }

  // ── Write tools (via TableKernelService DDD layer) ──

  async toolDocCreate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'organization_id', 'space_id', 'title')
    const body: Record<string, unknown> = {
      organization_id: args.organization_id,
      space_id: args.space_id,
      title: args.title,
    }
    if (args.folder_id) body.parent_id = args.folder_id
    const markdown = typeof args.markdown === 'string' ? args.markdown : ''
    if (markdown) body.initial_content_markdown = markdown
    const data = await this.request(API_ENDPOINTS.TABDOC.DOCUMENTS, {
      method: 'POST',
      body: JSON.stringify(body),
    }) as Record<string, unknown>
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async updateDocMetadata(docId: string, args: Record<string, unknown>, hasStatus: boolean, hasParentId: boolean): Promise<void> {
    const body: Record<string, unknown> = {}
    if (args.title) body.title = args.title
    if (args.base_version != null) body.base_version = args.base_version
    if (args.base_updated_at != null) body.base_updated_at = args.base_updated_at
    if (hasStatus) body.status = args.status
    if (hasParentId) body.parent_id = args.parent_id
    if (Object.keys(body).length === 0) return
    const result = await this.request(API_ENDPOINTS.TABDOC.DOCUMENT_DETAIL(docId), { method: 'PATCH', body: JSON.stringify(body) }) as Record<string, unknown>
    if ((result as { success?: boolean }).success === false) throw new Error(`Failed to update document metadata: ${JSON.stringify(result)}`)
  }

  async toolDocUpdate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'doc_id')
    const docId = args.doc_id as string

    const hasContent = args.content != null && args.content !== ''
    const hasStatus = args.status != null && args.status !== ''
    const hasParentId = args.parent_id != null && args.parent_id !== ''
    if (hasContent && (hasStatus || hasParentId)) {
      throw new Error(
        'content and status/parent_id are mutually exclusive. ' +
        'Update content in one call, then change status or parent_id in a separate call.',
      )
    }

    await this.updateDocMetadata(docId, args, hasStatus, hasParentId)

    if (hasContent) {
      const data = await this.request(API_ENDPOINTS.TABDOC.DOCUMENT_AGENT_WRITE(docId), {
        method: 'POST',
        body: JSON.stringify({ content_markdown: args.content, agent_id: 'mcp-server' }),
      }) as Record<string, unknown>
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    return { content: [{ type: 'text', text: JSON.stringify({ success: true, doc_id: docId }, null, 2) }] }
  }

  async toolDocDelete(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'doc_id')
    const data = await this.request(API_ENDPOINTS.TABDOC.DOCUMENT_DETAIL(args.doc_id as string), { method: 'DELETE' }) as Record<string, unknown>
    return { content: [{ type: 'text', text: JSON.stringify(data ?? { success: true }, null, 2) }] }
  }

  // ── TabDoc block-level tools ──

  async fetchDocBlocks(docId: string): Promise<{ blocks: Record<string, unknown>[]; doc: Record<string, unknown>; version: number }> {
    const docData = await this.get(API_ENDPOINTS.TABDOC.DOCUMENT_DETAIL(docId)) as Record<string, unknown>
    const doc = (docData.document ?? docData) as Record<string, unknown>
    const contentObj = (docData.content ?? {}) as Record<string, unknown>
    const pmJson = (contentObj.description_json ?? {}) as Record<string, unknown>
    const blocks = (Array.isArray(pmJson.content) ? pmJson.content : []) as Record<string, unknown>[]
    const version = (doc.latest_version as number) ?? 0
    return { blocks, doc, version }
  }

  requireBlockIndex(args: Record<string, unknown>): number {
    const raw = args.block_index
    if (raw == null) throw new Error('Missing required parameter: block_index')
    const idx = Number(raw)
    if (!Number.isInteger(idx)) {
      throw new Error(`block_index must be an integer, got ${JSON.stringify(raw)}`)
    }
    return idx
  }

  blockPreview(block: Record<string, unknown>): string {
    const extractText = (node: Record<string, unknown>): string => {
      if (node.text && typeof node.text === 'string') return node.text
      if (Array.isArray(node.content)) {
        return (node.content as Record<string, unknown>[]).map(extractText).join('')
      }
      return ''
    }
    const text = extractText(block)
    return text.length > 120 ? text.slice(0, 120) + '…' : text
  }

  async saveDocBlocks(
    docId: string,
    blocks: Record<string, unknown>[],
    baseVersion?: number,
    baseUpdatedAt?: string,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      content_pm_json: { type: 'doc', content: blocks },
    }
    if (baseVersion != null) body.base_version = baseVersion
    if (baseUpdatedAt != null) body.base_updated_at = baseUpdatedAt
    return await this.request(API_ENDPOINTS.TABDOC.DOCUMENT_CONTENT(docId), {
      method: 'POST',
      body: JSON.stringify(body),
    }) as Record<string, unknown>
  }

  async toolDocListBlocks(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'doc_id')
    const { blocks, version } = await this.fetchDocBlocks(args.doc_id as string)
    const items = blocks.map((b, i) => ({
      block_index: i,
      type: b.type ?? 'unknown',
      text_preview: this.blockPreview(b),
    }))
    return { content: [{ type: 'text', text: JSON.stringify({ blocks: items, total: items.length, latest_version: version }, null, 2) }] }
  }

  async toolDocReadBlock(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'doc_id', 'block_index')
    const idx = this.requireBlockIndex(args)
    const { blocks, version } = await this.fetchDocBlocks(args.doc_id as string)
    if (idx < 0 || idx >= blocks.length) {
      throw new Error(`block_index ${idx} out of range [0, ${blocks.length - 1}]`)
    }
    return { content: [{ type: 'text', text: JSON.stringify({ block_index: idx, block: blocks[idx], latest_version: version }, null, 2) }] }
  }

  async toolDocUpdateBlock(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'doc_id', 'block_index', 'block')
    const docId = args.doc_id as string
    const idx = this.requireBlockIndex(args)
    const { blocks } = await this.fetchDocBlocks(docId)
    if (idx < 0 || idx >= blocks.length) {
      throw new Error(`block_index ${idx} out of range [0, ${blocks.length - 1}]`)
    }
    blocks[idx] = args.block as Record<string, unknown>
    const data = await this.saveDocBlocks(docId, blocks, args.base_version as number | undefined, args.base_updated_at as string | undefined)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async toolDocInsertBlock(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'doc_id', 'block_index', 'block')
    const docId = args.doc_id as string
    const idx = this.requireBlockIndex(args)
    const { blocks } = await this.fetchDocBlocks(docId)
    if (idx < 0 || idx > blocks.length) {
      throw new Error(`block_index ${idx} out of range [0, ${blocks.length}]`)
    }
    blocks.splice(idx, 0, args.block as Record<string, unknown>)
    const data = await this.saveDocBlocks(docId, blocks, args.base_version as number | undefined, args.base_updated_at as string | undefined)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async toolDocDeleteBlock(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'doc_id', 'block_index')
    const docId = args.doc_id as string
    const idx = this.requireBlockIndex(args)
    const { blocks } = await this.fetchDocBlocks(docId)
    if (idx < 0 || idx >= blocks.length) {
      throw new Error(`block_index ${idx} out of range [0, ${blocks.length - 1}]`)
    }
    blocks.splice(idx, 1)
    const data = await this.saveDocBlocks(docId, blocks, args.base_version as number | undefined, args.base_updated_at as string | undefined)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
}
