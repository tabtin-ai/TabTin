import { McpDomainSupport } from './domain-support.js'
import { API_ENDPOINTS } from '@tabtin/config'

export class MemoMcpDomain extends McpDomainSupport {
  async toolMemoList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'organization_id')
    const params = new URLSearchParams({ organization_id: String(args.organization_id) })
    if (args.space_id) params.set('space_id', String(args.space_id))
    if (args.search) params.set('search', String(args.search))
    if (args.tags) params.set('tags', String(args.tags))
    if (args.status) params.set('status', String(args.status))
    if (args.sort) params.set('sort', String(args.sort))
    if (args.cursor) params.set('cursor', String(args.cursor))
    if (args.limit) params.set('limit', String(args.limit))
    const data = await this.get(`${API_ENDPOINTS.TABMEMO.MEMOS}?${params}`)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async toolMemoGet(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'memo_id')
    const data = await this.get(API_ENDPOINTS.TABMEMO.MEMO_DETAIL(args.memo_id as string))
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async toolMemoCreate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'organization_id', 'space_id', 'content_markdown')
    const body: Record<string, unknown> = {
      organization_id: args.organization_id,
      space_id: args.space_id,
      content_markdown: args.content_markdown,
    }
    if (Array.isArray(args.tags)) body.tags = args.tags
    if (args.color) body.color = args.color
    if (args.memo_type) body.memo_type = args.memo_type
    if (args.importance != null) body.importance = args.importance
    if (args.bookmark_url) body.bookmark_url = args.bookmark_url
    const data = await this.request(API_ENDPOINTS.TABMEMO.MEMOS, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async toolMemoSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'query', 'organization_id')
    const params = new URLSearchParams({
      organization_id: String(args.organization_id),
      search: String(args.query),
    })
    if (args.space_id) params.set('space_id', String(args.space_id))
    if (args.limit) params.set('limit', String(args.limit))
    const data = await this.get(`${API_ENDPOINTS.TABMEMO.MEMOS}?${params}`)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async toolMemoUpdate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'memo_id')
    const body: Record<string, unknown> = {}
    if (args.content_markdown != null) body.content_markdown = args.content_markdown
    if (Array.isArray(args.tags)) body.tags = args.tags
    if (args.color != null) body.color = args.color
    if (args.importance != null) body.importance = args.importance
    const data = await this.request(API_ENDPOINTS.TABMEMO.MEMO_DETAIL(args.memo_id as string), {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async toolMemoDelete(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'memo_id')
    const data = await this.request(API_ENDPOINTS.TABMEMO.MEMO_DETAIL(args.memo_id as string), {
      method: 'DELETE',
    })
    return { content: [{ type: 'text', text: JSON.stringify(data ?? { success: true }, null, 2) }] }
  }

  // ── TabData SQL query (local PGlite) ──

}
