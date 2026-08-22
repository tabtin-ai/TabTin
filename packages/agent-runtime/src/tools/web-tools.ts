import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../engine/contracts/tools.js';
import { joinApiPath } from '../utils/api-url.js'
import { jsonError } from '../capability/core/_utils.js'
import {
  MISSING_REQUIRED_PARAM,
} from '../engine/errors/error-kinds.js'
import { toJsonErrorMetadata, translateBackendError } from './_backend-error-translator.js'

/**
 * W7 双层结果：LLM 摘要中保留前 N 条结果作为决策线索。
 *
 * 取值权衡：
 *   - 太少（1-2）→ LLM 可能错过相关结果导致额外调用
 *   - 太多（10+）→ 每条搜索都污染几 KB context，长会话爆炸
 *   3 条 + 200 字符 snippet 是经验平衡点（控制工具结果体积）
 */
const LLM_RESULT_PREVIEW_COUNT = 3
const LLM_SNIPPET_MAX_CHARS = 200
/** 搜索引擎 AI 摘要上限；snippet/条数已控，summary 需单独截断防旁路灌 context */
const LLM_SUMMARY_MAX_CHARS = 2000

function truncateWithEllipsis(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false }
  }
  return { text: `${text.slice(0, maxChars)}…`, truncated: true }
}

// ─── Schemas ─────────────────────────────────────────────────────────
//
//   `web_fetch` FC 工具已删除（数据采集链去 FC 化）。URL 正文抓取 / 渲染页取正文 /
//   二进制下载的具体引导统一放到 system prompt，不在工具描述里内联平台命令。
//
//   `web_search` 保留——这是真实搜索 API，不属于采集链 FC（搜索 vs 抓页是
//   不同事），且无等价替代。

const webSearchInputSchema = {
  type: 'object',
  properties: {
    search_term: {
      type: 'string',
      description:
        '搜索词，短且具体。高级语法仅限引号短语、-排除、OR、site:/filetype:/intitle:/inurl:、before:/after:、数字..数字、*通配；运行时不解析，提供方可能透传或截断，勿扩展或承诺精确生效。',
    },
    count: { type: 'number', description: '返回结果数量（1-50，默认 8）。' },
    freshness: { type: 'string', description: '时间过滤：`noLimit` / `oneDay` / `oneWeek` / `oneMonth` / `oneYear` / `YYYY-MM-DD..YYYY-MM-DD`。' },
    include_summary: { type: 'boolean', description: '是否返回搜索结果的 AI 摘要。' },
    include_domains: { type: 'array', items: { type: 'string' }, description: '只包含这些域名下的结果。' },
    exclude_domains: { type: 'array', items: { type: 'string' }, description: '排除这些域名下的结果。' },
    offset: {
      type: 'number',
      // P2-field medium tier ≤150：翻页语义保留；响应字段名见工具说明。
      description:
        '摘要起始偏移（默认 0）。每次连续 3 条；用 3、6… 翻页，勿换词重搜。',
    },
  },
  required: ['search_term'],
} as unknown as Tool['inputSchema']

// ─── Factory ─────────────────────────────────────────────────────────

export interface WebToolsDeps {
  apiBaseUrl: string
  apiAuthToken?: string
  organizationId?: string
}

interface WebSearchParams {
  search_term: string
  count?: number
  freshness?: string
  include_summary?: boolean
  include_domains?: string[]
  exclude_domains?: string[]
  offset?: number
}

export function createWebTools(deps: WebToolsDeps): Tool[] {
  return [
    createWebSearchTool(deps),
  ]
}

function buildWebSearchBody(
  params: WebSearchParams,
  context?: Pick<ToolContext, 'agentRunId' | 'toolUseId'>,
): Record<string, unknown> {
  const count = Math.max(1, Math.min(params.count ?? 8, 50))
  const body: Record<string, unknown> = {
    query: params.search_term,
    count,
    biz_type: 'orchestration.web_search',
  }
  if (params.freshness) body.freshness = params.freshness
  if (params.include_summary != null) body.summary = params.include_summary
  if (params.include_domains?.length) body.include_domains = params.include_domains
  if (params.exclude_domains?.length) body.exclude_domains = params.exclude_domains
  if (context?.agentRunId) {
    body.agent_run_id = context.agentRunId
    if (context.toolUseId) {
      body.client_tool_invocation_component = context.toolUseId
    }
  }
  return body
}

function buildWebSearchHeaders(deps: WebToolsDeps): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.apiAuthToken) headers['Authorization'] = `Bearer ${deps.apiAuthToken}`
  if (deps.organizationId) headers['X-TabTin-Organization-Id'] = deps.organizationId
  return headers
}

async function readWebSearchError(response: Response): Promise<ToolResult> {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const translated = translateBackendError({
    status: response.status,
    body,
    toolName: 'web_search',
    operation: 'web search',
    fallbackMessage: 'The search service could not complete the request.',
  })
  return jsonError(translated.message, toJsonErrorMetadata(translated, {
    http_status: response.status,
  }))
}

function buildWebSearchResult(
  payload: Record<string, unknown>,
  params: WebSearchParams,
): ToolResult {
  const rawResults = Array.isArray(payload.results)
    ? (payload.results as Record<string, unknown>[])
    : []
  const fullResults = rawResults.map(formatWebSearchResult)
  const totalCount = typeof payload.total_count === 'number' ? payload.total_count : fullResults.length

  const summaryOffset = Math.max(0, Math.floor(params.offset ?? 0))
  const previewResults = fullResults
    .slice(summaryOffset, summaryOffset + LLM_RESULT_PREVIEW_COUNT)
    .map((r, i) => formatWebSearchPreview(r, summaryOffset + i + 1))
  const nextSummaryOffset = summaryOffset + previewResults.length < fullResults.length
    ? summaryOffset + previewResults.length
    : null
  const formatted: Record<string, unknown> = {
    success: true,
    query: params.search_term,
    total_count: totalCount,
    result_count: fullResults.length,
    summary_offset: summaryOffset,
    shown_in_summary: previewResults.length,
    summary_range: previewResults.length > 0
      ? `${summaryOffset + 1}-${summaryOffset + previewResults.length}`
      : null,
    has_more_in_summary: nextSummaryOffset != null,
    next_summary_offset: nextSummaryOffset,
    results: previewResults,
    _search_results: fullResults,
  }
  appendWebSearchSummary(formatted, payload.summary)
  return { content: JSON.stringify(formatted), llmStripKeys: ['_search_results'] }
}

function formatWebSearchResult(r: Record<string, unknown>): Record<string, string | undefined> {
  return {
    title: typeof r.title === 'string' ? r.title : (typeof r.name === 'string' ? r.name : ''),
    url: typeof r.url === 'string' ? r.url : (typeof r.link === 'string' ? r.link : ''),
    snippet: typeof r.snippet === 'string'
      ? r.snippet
      : (typeof r.description === 'string' ? r.description : ''),
    favicon: typeof r.favicon === 'string' ? r.favicon : undefined,
    source: typeof r.source === 'string' ? r.source : undefined,
  }
}

function formatWebSearchPreview(
  result: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const snippet = typeof result.snippet === 'string' ? result.snippet : ''
  return {
    index,
    title: result.title,
    url: result.url,
    snippet: snippet.length > LLM_SNIPPET_MAX_CHARS
      ? `${snippet.slice(0, LLM_SNIPPET_MAX_CHARS)}…`
      : snippet,
  }
}

function appendWebSearchSummary(formatted: Record<string, unknown>, summary: unknown): void {
  if (typeof summary !== 'string') return
  const { text, truncated } = truncateWithEllipsis(summary, LLM_SUMMARY_MAX_CHARS)
  formatted.summary = text
  if (truncated) formatted.summary_truncated = true
}

// ─── web_search ──────────────────────────────────────────────────────

function createWebSearchTool(deps: WebToolsDeps): Tool {
  return {
    name: 'web_search',
    description:
      `搜索实时公开网络信息。返回 title / URL / snippet。
LLM 摘要默认只含前 3 条：结果相关但排在后面 → 用 offset 翻页；整页都不相关 → 换角度重组关键词（换同义词 / 换语言 / 加 site: 限定），而不是在原查询上追加修饰词。
高级语法仅限下表；运行时不解析，提供方可能透传或截断，勿扩展或承诺精确生效。

| 写法 | 用途 | 示例 |
|---|---|---|
| \`"完整短语"\` | 精确匹配整句话 | \`"connection refused"\` |
| \`-关键词\` | 排除无关结果 | \`苹果 -手机 -电脑\` |
| \`OR\` | 满足多个条件之一 | \`React OR Vue 状态管理\` |
| \`site:\` | 限定网站或域名 | \`site:github.com electron ipc\` |
| \`filetype:\` | 限定文件格式 | \`大模型安全 filetype:pdf\` |
| \`intitle:\` | 标题必须包含关键词 | \`intitle:"system design" cache\` |
| \`inurl:\` | URL 必须包含关键词 | \`inurl:docs websocket\` |
| \`before:\` | 只看某日期之前 | \`OpenAI before:2024-01-01\` |
| \`after:\` | 只看某日期之后 | \`React after:2025-01-01\` |
| \`数字..数字\` | 搜索数值范围 | \`机械键盘 500..1000 元\` |
| \`*\` | 精确短语中的通配位置 | \`"the * of software design"\` |`,
    inputSchema: webSearchInputSchema,
    isReadOnly: true,
    policyActionKind: 'object_read',
    // FR-09: search snippets come from arbitrary websites — fence-wrap +
    // injection scan even though we only "read" remote content.
    disablePreStart: true,
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      const params = input as WebSearchParams

      if (!params.search_term || params.search_term.trim() === '') {
        return jsonError('search_term is required', {
          error_kind: MISSING_REQUIRED_PARAM,
          hint: 'Provide the web search query in search_term before calling web_search.',
        })
      }
      try {
        const response = await fetch(joinApiPath(deps.apiBaseUrl, '/search/web'), {
          method: 'POST',
          headers: buildWebSearchHeaders(deps),
          body: JSON.stringify(buildWebSearchBody(params, context)),
          signal: AbortSignal.timeout(30_000),
        })

        if (!response.ok) {
          return readWebSearchError(response)
        }

        const raw = await response.json() as Record<string, unknown>
        const payload = (raw.data ?? raw) as Record<string, unknown>
        return buildWebSearchResult(payload, params)
      } catch (error) {
        const translated = translateBackendError({
          error,
          toolName: 'web_search',
          operation: 'web search',
          fallbackMessage: 'The search service could not complete the request.',
        })
        return jsonError(translated.message, toJsonErrorMetadata(translated))
      }
    },
  }
}
