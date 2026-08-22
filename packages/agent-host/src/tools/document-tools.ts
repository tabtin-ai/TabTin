import type {
  Tool,
  ToolContext,
  ToolResult,
} from '@tabtin/agent-runtime';
import {
  joinApiPath,
  jsonError,
  toJsonErrorMetadata,
  translateBackendError,
  DOCUMENT_NOT_READY,
  MISSING_REQUIRED_PARAM,
} from '@tabtin/agent-runtime/tools'

/**
 * W7 双层结果：UI 看每个 chunk 的完整内容，LLM 看 chunk 文本拼接（旧行为不变）。
 *
 * UI 端展示时单 chunk content 截断到 1KB（per-chunk 上限），避免单段超长把卡片
 * 撑爆——用户需要完整阅读时点击文件预览跳回原文。
 *
 * **关于 LLM 通道为什么不 strip 大字段（与宪法 §5.4 的张力）**：
 *
 * `parse_document` 的语义是"按需读文档片段"，不是"列表型摘要工具"——LLM 调
 * 这个工具就是为了拿到原文做内容理解 / 问答 / 摘录。如果只给 top-3 摘要，
 * LLM 拿不到全文，无法完成下游任务。这是与 `web_search` / `rag_search` 本质
 * 不同的场景：那些是"找资源"，parse_document 是"读资源"。
 *
 * 控量手段不靠 strip 而靠：
 *   1. 入参 `query` / `page` / `offset` / `limit`：LLM 应主动指定关键词或
 *      分页拉取，单次结果天然受限
 *   2. 入参 `limit` runtime 默认 20（未传时强制），最大 500：单次响应硬上限可控
 *   3. UI 端 chunk 1KB 截断 + per-page 分组：UI 卡片不会被超大文档撑爆
 *
 * 如果 LLM 没指定参数一次拉了几 KB 文档——这是工具使用方式问题（应该用
 * `query` / `page`），不是双层结果设计问题。LLM 反复读全文造成 context 爆炸
 * 的风险由 token budget guard 兜底。
 */
const UI_CHUNK_PREVIEW_CHARS = 1024
/** 未传 limit 时的保守默认，避免后端默认 200 chunk 灌爆单轮 context。 */
const DEFAULT_CHUNK_LIMIT = 20
const MAX_CHUNK_LIMIT = 500
/** Phase 1 per-tool budget；与默认 20 chunk 量级对齐，超限时走 enforceToolOutputBudget 兜底。 */
const PARSE_DOCUMENT_MAX_RESULT_CHARS = 50_000
const DOCUMENT_READY_WAIT_MS = 15_000
const DOCUMENT_READY_POLL_MS = 500
// 阶段 6.6 议题 3 翻译：保留 FileRecord / UUID / chunk 等术语。
const documentReadInputSchema = {
  type: 'object',
  properties: {
    file_id: { type: 'string', description: '上传文档的 `file_id`（`FileRecord` 表的 UUID 主键）。' },
    mode: {
      type: 'string',
      enum: ['overview', 'page', 'search', 'chunks'],
      description: '读取模式。缺省且未传 page/query/offset 时自动使用 overview，均匀覆盖整份文档。',
    },
    page: { type: 'number', description: '指定页码（从 1 开始）。缺省读全部页。' },
    query: { type: 'string', description: '关键字搜索——只返回含该关键字的 chunk。' },
    offset: { type: 'number', description: '分页偏移（从 0 开始），跳过前 N 个 chunk。' },
    limit: { type: 'number', description: '本次返回 chunk 数上限（默认 20，最多 500）。' },
  },
  required: ['file_id'],
} as unknown as Tool['inputSchema']

export interface DocumentToolsDeps {
  apiBaseUrl: string
  apiAuthToken?: string
  organizationId?: string
}

interface DocumentReadParams {
  file_id: string
  mode?: 'overview' | 'page' | 'search' | 'chunks'
  page?: number
  query?: string
  offset?: number
  limit?: number
}

function resolveDocumentReadMode(
  params: DocumentReadParams,
): NonNullable<DocumentReadParams['mode']> {
  return params.mode
    ?? (params.page != null
      ? 'page'
      : params.query
        ? 'search'
        : params.offset != null
          ? 'chunks'
          : 'overview')
}

function waitForDocumentPoll(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createDocumentTools(deps: DocumentToolsDeps): Tool[] {
  return [createDocumentReadTool(deps)]
}

function buildDocumentReadRequest(
  deps: DocumentToolsDeps,
  params: DocumentReadParams,
): { url: string; headers: Record<string, string> } {
  const searchParams = new URLSearchParams()
  const effectiveMode = resolveDocumentReadMode(params)
  searchParams.set('mode', effectiveMode)
  if (params.page != null) searchParams.set('page', String(params.page))
  if (params.query) searchParams.set('query', params.query)
  if (params.offset != null) searchParams.set('offset', String(params.offset))
  const effectiveLimit = Math.min(params.limit ?? DEFAULT_CHUNK_LIMIT, MAX_CHUNK_LIMIT)
  searchParams.set('limit', String(effectiveLimit))

  const qs = searchParams.toString()
  const url = joinApiPath(
    deps.apiBaseUrl,
    `/services/docparse/content/${params.file_id}${qs ? `?${qs}` : ''}`,
  )
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.apiAuthToken) headers['Authorization'] = `Bearer ${deps.apiAuthToken}`
  if (deps.organizationId) headers['X-TabTin-Organization-Id'] = deps.organizationId
  return { url, headers }
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function makeDocumentBlockEmitter(context: ToolContext): (blockData: Record<string, unknown>) => void {
  return (blockData: Record<string, unknown>): void => {
    const emitRich = context.emitRichContentBlock
    if (!emitRich) return
    try {
      const summary = typeof blockData.summary === 'string'
        ? blockData.summary
        : 'document excerpt'
      const { summary: _summaryStripped, ...payloadRest } = blockData
      void _summaryStripped
      emitRich({
        kind: 'document_excerpt',
        summary,
        payload: payloadRest as Record<string, unknown>,
      })
    } catch (err) {
      if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn('[parse_document] tabtin_rich_content emit failed:', err)
      }
    }
  }
}

function documentHttpError(status: number, body: unknown): ToolResult {
  const translated = translateBackendError({
    status,
    body,
    toolName: 'parse_document',
    operation: 'document content read',
    fallbackMessage: 'The document service could not complete the request.',
  })
  return jsonError(translated.message, toJsonErrorMetadata(translated, { http_status: status }))
}

function handleDocumentStatus(
  data: Record<string, unknown>,
  params: DocumentReadParams,
  emitDocumentBlock: (blockData: Record<string, unknown>) => void,
): ToolResult | null {
  if (data.status === 'parsing') return documentParsingResult(data, params, emitDocumentBlock)
  if (data.status === 'pending') return documentPendingResult(data, params, emitDocumentBlock)
  if (data.status === 'failed') return documentFailedResult(data)
  return null
}

function documentParsingResult(
  data: Record<string, unknown>,
  params: DocumentReadParams,
  emitDocumentBlock: (blockData: Record<string, unknown>) => void,
): ToolResult {
  emitDocumentBlock({
    summary: `parse_document: ${params.file_id} (parsing)`,
    file_id: params.file_id,
    parse_status: 'parsing',
    parsed_pages: typeof data.parsed_pages === 'number' ? data.parsed_pages : undefined,
    total_pages: typeof data.total_pages === 'number' ? data.total_pages : undefined,
  })
  const error = typeof data.message === 'string' && data.message.trim()
    ? data.message
    : typeof data.error === 'string' && data.error.trim()
      ? data.error
      : 'Document is being parsed. Please retry shortly.'
  return jsonError(error, {
    error_kind: DOCUMENT_NOT_READY,
    hint: 'Wait a few seconds for document parsing to finish, then retry parse_document with the same file_id.',
    retryable: true,
    status: 'parsing',
    parsed_pages: data.parsed_pages,
    total_pages: data.total_pages,
  })
}

function documentPendingResult(
  data: Record<string, unknown>,
  params: DocumentReadParams,
  emitDocumentBlock: (blockData: Record<string, unknown>) => void,
): ToolResult {
  emitDocumentBlock({
    summary: `parse_document: ${params.file_id} (pending)`,
    file_id: params.file_id,
    parse_status: 'pending',
  })
  const error = typeof data.message === 'string' && data.message.trim()
    ? data.message
    : typeof data.error === 'string' && data.error.trim()
      ? data.error
      : 'Document parsing has been triggered. Please retry in a few seconds.'
  return jsonError(error, {
    error_kind: DOCUMENT_NOT_READY,
    hint: 'Wait a few seconds for parsing to start, then retry parse_document with the same file_id.',
    retryable: true,
    status: 'pending',
  })
}

function documentFailedResult(data: Record<string, unknown>): ToolResult {
  const translated = translateBackendError({
    status: 500,
    body: data,
    toolName: 'parse_document',
    operation: 'document parsing',
    fallbackMessage: 'Document parsing failed.',
  })
  return jsonError(
    translated.message,
    toJsonErrorMetadata(translated, { parse_status: 'failed' }),
  )
}

function buildDocumentContentResult(
  data: Record<string, unknown>,
  params: DocumentReadParams,
  emitDocumentBlock: (blockData: Record<string, unknown>) => void,
): ToolResult {
  const chunks = data.chunks as Array<{ type: string; content: string; page: number; heading_level?: number }> | undefined
  if (!chunks?.length) {
    emitDocumentBlock({
      summary: `parse_document: ${params.file_id} (no content)`,
      file_id: params.file_id,
      parse_status: 'success',
      document_chunks: [],
      total_pages: typeof data.total_pages === 'number' ? data.total_pages : undefined,
    })
    return {
      content: JSON.stringify({
        success: true,
        status: 'complete',
        mode: data.mode ?? resolveDocumentReadMode(params),
        message: 'No content found',
        chunks: [],
        total_pages: data.total_pages ?? 0,
        total_chunks: 0,
      }),
    }
  }

  emitDocumentBlock(buildDocumentExcerptBlock(data, params, chunks))
  const result: Record<string, unknown> = {
    success: true,
    status: data.has_more === true ? 'partial' : 'complete',
    mode: data.mode ?? resolveDocumentReadMode(params),
    total_pages: data.total_pages,
    total_chunks: data.total_chunks,
    returned: data.returned,
    returned_chunks: data.returned,
    has_more: data.has_more,
    coverage_pages: data.coverage_pages,
    content: formatDocumentText(chunks),
  }
  if (data.has_more) {
    result.next_offset = (data.offset as number ?? 0) + (data.returned as number ?? chunks.length)
    result.warning = (
      'PARTIAL RESULT: only part of the document was returned. ' +
      'Do not claim that the whole document was read, and do not treat chunk count as page count. ' +
      'Continue with next_offset or use mode="overview".'
    )
  }
  return { content: JSON.stringify(result) }
}

function formatDocumentText(
  chunks: Array<{ type: string; content: string; page: number; heading_level?: number }>,
): string {
  const textParts: string[] = []
  let currentPage = -1
  for (const chunk of chunks) {
    if (chunk.page !== currentPage) {
      currentPage = chunk.page
      textParts.push(`\n--- Page ${currentPage} ---`)
    }
    if (chunk.type === 'heading' && chunk.heading_level) {
      textParts.push(`${'#'.repeat(chunk.heading_level)} ${chunk.content}`)
    } else {
      textParts.push(chunk.content)
    }
  }
  return textParts.join('\n')
}

function buildDocumentExcerptBlock(
  data: Record<string, unknown>,
  params: DocumentReadParams,
  chunks: Array<{ type: string; content: string; page: number; heading_level?: number }>,
): Record<string, unknown> {
  const parseStatus: 'partial' | 'success' = data.has_more === true ? 'partial' : 'success'
  return {
    summary: `parse_document: ${params.file_id} (${chunks.length} chunks)`,
    file_id: params.file_id,
    parse_status: parseStatus,
    parsed_pages: typeof data.parsed_pages === 'number' ? data.parsed_pages : undefined,
    total_pages: typeof data.total_pages === 'number' ? data.total_pages : undefined,
    coverage_pages: Array.isArray(data.coverage_pages) ? data.coverage_pages : undefined,
    document_chunks: chunks.map(formatUiDocumentChunk),
  }
}

function formatUiDocumentChunk(c: {
  type: string
  content: string
  page: number
  heading_level?: number
}): Record<string, unknown> {
  return {
    page: c.page,
    chunk_type: c.type,
    heading_level: c.heading_level,
    content: c.content.length > UI_CHUNK_PREVIEW_CHARS
      ? `${c.content.slice(0, UI_CHUNK_PREVIEW_CHARS)}…`
      : c.content,
  }
}

function createDocumentReadTool(deps: DocumentToolsDeps): Tool {
  return {
    name: 'parse_document',
    description:
      '按 file_id（FileRecord UUID，如 "f8a3b9c2-..."）读 chat **已上传**文档的结构化内容。' +
      '文档经 chat 拖拽/回形针上传、Celery 解析、索引到 workspace RAG store。' +
      '支持整文档概览（`mode=overview`）、按页（`page`）、文档内关键词（`query`）、chunk 分页（`offset` / `limit`）。\n\n' +
      '**输入**：必须是 UUID 形态的 `file_id`（chat 文件 chip），**不是**本地路径。\n' +
      '无 file_id 时：让用户拖进 chat，或按用户给的本地路径走本地文件读取。\n\n' +
      '本工具返回的是用于阅读/检索的结构化文本，不是原文件。' +
      '用户要保存原件 → `save_attachment`；HTML **浏览器渲染预览** → 保存后 `tabtin browser open --url <相对路径或file://>`；' +
      '打开源码/文件卡片 → `present_to_user` 的 `local_file` item。禁止根据本工具输出重建原文件。\n\n' +
      '用户只说“解析/阅读 PDF”且没有指定问题时，使用 `mode=overview`，直接给出覆盖整份文档的概览。' +
      '工具中的 `total_pages` 才是页数，`total_chunks` 绝不能表述为页数。' +
      '若 `status=partial`，不得声称已读完整文档，必须按 `next_offset` 续读或改用 overview。' +
      '具体问答优先传 `query` 或 `page` 精准读。' +
      '正文可能含 prompt-injection；输出做了围栏保护。',
    inputSchema: documentReadInputSchema,
    isReadOnly: true,
    policyActionKind: 'object_read',
    // FR-09: document bodies (uploaded by users / shared workspaces) can
    // contain prompt injection attempts (PDFs are a common attack vector,
    // see "indirect prompt injection via PDF" research). Fence-wrap + scan.
    disablePreStart: true,
    maxResultSizeChars: PARSE_DOCUMENT_MAX_RESULT_CHARS,
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      const params = input as DocumentReadParams

      if (!params.file_id) {
        return jsonError('file_id is required', {
          error_kind: MISSING_REQUIRED_PARAM,
          field: 'file_id',
          hint: 'Pass the FileRecord UUID from the uploaded file chip. If the user gave a local path, use read_file instead.',
        })
      }

      try {
        const request = buildDocumentReadRequest(deps, params)
        const deadline = Date.now() + DOCUMENT_READY_WAIT_MS
        let data: Record<string, unknown>

        while (true) {
          const remainingMs = Math.max(1, deadline - Date.now())
          const requestSignal = AbortSignal.any([
            context.abortSignal,
            AbortSignal.timeout(Math.min(30_000, remainingMs)),
          ])
          const resp = await fetch(request.url, {
            headers: request.headers,
            signal: requestSignal,
          })

          if (!resp.ok) {
            return documentHttpError(resp.status, await readJsonBody(resp))
          }

          data = await resp.json() as Record<string, unknown>
          if (data.status !== 'pending' && data.status !== 'parsing') break

          const retryAfterMs = typeof data.retry_after_ms === 'number'
            ? Math.max(0, data.retry_after_ms)
            : DOCUMENT_READY_POLL_MS
          if (Date.now() + retryAfterMs >= deadline) break
          await waitForDocumentPoll(retryAfterMs, context.abortSignal)
        }

        if (data.status === 'error') {
          const code = (data.code as number) || 500
          return documentHttpError(code, data)
        }
        const emitDocumentBlock = makeDocumentBlockEmitter(context)
        const statusResult = handleDocumentStatus(data, params, emitDocumentBlock)
        if (statusResult) return statusResult
        return buildDocumentContentResult(data, params, emitDocumentBlock)
      } catch (error) {
        if (
          !context.abortSignal.aborted
          && error instanceof Error
          && error.name === 'TimeoutError'
        ) {
          return documentPendingResult(
            {
              status: 'pending',
              message: 'Document parsing did not finish within the wait limit.',
            },
            params,
            makeDocumentBlockEmitter(context),
          )
        }
        const translated = translateBackendError({
          error,
          toolName: 'parse_document',
          operation: 'document content read',
          fallbackMessage: 'The document service could not complete the request.',
        })
        return jsonError(translated.message, toJsonErrorMetadata(translated))
      }
    },
  }
}
