/**
 * 统一搜索（FTS）API 客户端
 *
 * 1:1 对齐 `apps/tabtin_django/apps/fts/schemas.py` 的请求/响应契约：
 * - SearchParams（请求）
 * - SearchResultItem（单条结果）
 * - SearchResponse（响应整体）
 *
 * 后端端点：`GET /api/search`，由 `tabtin/urls.py` 通过
 * `_safe_add_router('/search', fts_router)` 挂载。
 *
 * 与其他 service 的差异：
 * - fts 走 ninja `response=SearchResponse`，body 顶层就是
 *   `{ results, total, facets, ... }`，**不是** `{ success, data: { ... } }`
 *   wrapper。这里直接信任 ninja 序列化结果。
 * - 支持 `AbortSignal`：长查询/防抖竞态时可取消请求。
 * - degraded 路径仍是合法 200 响应（`degraded=true`），调用方根据
 *   `degraded_reason` 判断如何向用户反馈。
 *
 * Wave 3 前端只需 import 本文件，不再调旧的
 * `SpaceApiService.searchOrganization` / `getChatClient().sessions.listAll`。
 */

import { API_ENDPOINTS, joinApiPath } from '@tabtin/config'
import { apiBaseUrl, getAuthToken } from './base.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('FtsApi')

// ── 请求 ────────────────────────────────────────────────────────
export type FtsCreatorType = 'user' | 'agent' | 'any'
export type FtsRoleFilter = 'user' | 'assistant' | 'any'
export type FtsSearchModeRequest = 'fast' | 'fallback_ok'

export interface UnifiedSearchParams {
  /** 搜索关键词；带双引号的 q 视为短语精确搜索（PRD 4.6） */
  q: string
  /** 租户隔离必填（PRD 5.1） */
  organization_id: string
  /** 逗号分隔：messages,resources,agents,spaces,memos,im；不传则搜全部 */
  types?: string
  /** resources 子类：tabdoc/tabdata/tabslide/tabcode/... */
  item_type?: string
  /** 收窄到指定 Space */
  space_id?: string
  /** 按 Agent 筛（仅作用于 messages/agents 索引；R2-11 已知遗留） */
  agent_id?: string
  /** user/agent/any，默认 any */
  creator_type?: FtsCreatorType
  /** 消息 role 过滤：user/assistant/any */
  role?: FtsRoleFilter
  /** ISO datetime 下限 */
  created_after?: string
  /** ISO datetime 上限 */
  created_before?: string
  /** 单类型条数上限：1-100，默认 20 */
  limit?: number
  /** 分页偏移：0-10000 */
  offset?: number
  /** fast 仅 ES，fallback_ok 允许直接走降级响应 */
  mode?: FtsSearchModeRequest
}

// ── 响应 ────────────────────────────────────────────────────────
/** 6 类对象的 result type 联合（schemas.py `ResultType`） */
export type FtsResultType = 'message' | 'resource' | 'agent' | 'space' | 'memo' | 'im'

/** 9 种降级原因封闭枚举（schemas.py SearchResponse.degraded_reason） */
export type FtsDegradedReason =
  | 'engine_disabled'
  | 'health_red'
  | 'circuit_open'
  | 'error_rate_breach'
  | 'opensearch_unavailable'
  | 'partial_failure'
  | 'rate_limited'
  | 'auth_missing'
  | 'internal_error'

/** 6 个逻辑索引名（partial_indices 元素值，与后端 `INDEX_DEFINITIONS.keys()` 对齐） */
export type FtsLogicalIndex = 'messages' | 'resources' | 'agents' | 'spaces' | 'memos' | 'im'

export type FtsSearchModeResponse = 'normal' | 'fallback'

export interface SearchResultItem {
  id: string
  type: FtsResultType
  title: string
  /** 高亮片段（含 `<em>...</em>` 标签）；可能为空字符串 */
  snippet: string
  /** 字段名 → 含 `<em>` 片段列表 */
  highlight: Record<string, string[]>

  creator_type?: 'user' | 'agent' | null
  creator_id?: string | null
  creator_name?: string | null
  creator_avatar?: string | null

  space_id?: string | null
  space_name?: string | null

  /** message / im 共用：im 时填的是 `conversation_id` */
  session_id?: string | null
  session_title?: string | null

  /** resource 专用 */
  resource_id?: string | null

  score: number
  rrf_score: number
  /** ISO 8601 字符串 */
  created_at?: string | null

  /** message 专用（user/assistant） */
  role?: string | null

  /** 透传字段（item_type、tags、source 等） */
  metadata: Record<string, unknown>
}

/** 状态附加说明（Wave 5 R4-09）：明确区分"权限错配"vs"真零结果"等特殊场景 */
export type FtsNotice = 'no_accessible_spaces'

export interface UnifiedSearchResponse {
  results: SearchResultItem[]
  total: number
  /** 按类型计数：messages/resources/agents/spaces/memos/im */
  facets: Record<string, number>
  /** ES suggest 拼写建议；空结果场景才有 */
  suggestions: string[]
  took_ms: number
  search_mode: FtsSearchModeResponse
  degraded: boolean
  degraded_reason?: FtsDegradedReason | null
  /** 本次响应未覆盖的索引 */
  partial_indices: FtsLogicalIndex[]
  /**
   * Wave 5 R4-09：状态附加说明（可选）。'no_accessible_spaces' = 当前 Organization
   * 内无任何 Space 访问权限。前端应显示明确文案而非"无结果"。
   */
  notice?: FtsNotice | null
}

// ── 错误 ────────────────────────────────────────────────────────
/** 调用 `unifiedSearch` 抛出的可读错误。AbortError 不会被包装，保留原 name */
export class UnifiedSearchError extends Error {
  status: number
  cause?: unknown

  constructor(message: string, status: number, cause?: unknown) {
    super(message)
    this.name = 'UnifiedSearchError'
    this.status = status
    this.cause = cause
  }
}

// ── 客户端 ──────────────────────────────────────────────────────

// 运行时枚举集合：normalizeResponse 用，未知值归 null/兜底
const RESULT_TYPE_SET = new Set<FtsResultType>(['message', 'resource', 'agent', 'space', 'memo', 'im'])
const LOGICAL_INDEX_SET = new Set<FtsLogicalIndex>(['messages', 'resources', 'agents', 'spaces', 'memos', 'im'])
const DEGRADED_REASON_SET = new Set<FtsDegradedReason>([
  'engine_disabled',
  'health_red',
  'circuit_open',
  'error_rate_breach',
  'opensearch_unavailable',
  'partial_failure',
  'rate_limited',
  'auth_missing',
  'internal_error',
])
const NOTICE_SET = new Set<FtsNotice>(['no_accessible_spaces'])

function buildQueryString(params: UnifiedSearchParams): string {
  const sp = new URLSearchParams()
  sp.append('q', params.q)
  sp.append('organization_id', params.organization_id)
  if (params.types) sp.append('types', params.types)
  if (params.item_type) sp.append('item_type', params.item_type)
  if (params.space_id) sp.append('space_id', params.space_id)
  if (params.agent_id) sp.append('agent_id', params.agent_id)
  if (params.creator_type) sp.append('creator_type', params.creator_type)
  if (params.role) sp.append('role', params.role)
  if (params.created_after) sp.append('created_after', params.created_after)
  if (params.created_before) sp.append('created_before', params.created_before)
  if (typeof params.limit === 'number') sp.append('limit', String(params.limit))
  if (typeof params.offset === 'number') sp.append('offset', String(params.offset))
  if (params.mode) sp.append('mode', params.mode)
  return sp.toString()
}

function normalizeResponse(raw: unknown): UnifiedSearchResponse {
  // ninja 直接 dump SearchResponse；做一道防御性归一保证字段在
  // 极端响应（旧版本 / 网关被改写）下也不爆
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<UnifiedSearchResponse>
  const results = Array.isArray(obj.results) ? obj.results : []

  // degraded_reason 运行时枚举校验：未知值归 null（前端 banner 用 'unknown' 文案兜底）
  let degradedReason: FtsDegradedReason | null = null
  if (typeof obj.degraded_reason === 'string' && DEGRADED_REASON_SET.has(obj.degraded_reason as FtsDegradedReason)) {
    degradedReason = obj.degraded_reason as FtsDegradedReason
  }

  // partial_indices 运行时枚举过滤：丢弃未知 logical index
  const partialIndices: FtsLogicalIndex[] = Array.isArray(obj.partial_indices)
    ? (obj.partial_indices.filter(
        (i): i is FtsLogicalIndex => typeof i === 'string' && LOGICAL_INDEX_SET.has(i as FtsLogicalIndex),
      ))
    : []

  // notice 运行时枚举校验（Wave 5 R4-09）：未知值归 null
  let notice: FtsNotice | null = null
  if (typeof obj.notice === 'string' && NOTICE_SET.has(obj.notice as FtsNotice)) {
    notice = obj.notice as FtsNotice
  }

  return {
    results: results.map(normalizeResultItem),
    total: typeof obj.total === 'number' ? obj.total : 0,
    facets: obj.facets && typeof obj.facets === 'object' ? obj.facets as Record<string, number> : {},
    suggestions: Array.isArray(obj.suggestions) ? obj.suggestions.filter((s): s is string => typeof s === 'string') : [],
    took_ms: typeof obj.took_ms === 'number' ? obj.took_ms : 0,
    search_mode: obj.search_mode === 'fallback' ? 'fallback' : 'normal',
    degraded: obj.degraded === true,
    degraded_reason: degradedReason,
    partial_indices: partialIndices,
    notice,
  }
}

function normalizeResultItem(raw: unknown): SearchResultItem {
  const it = (raw && typeof raw === 'object' ? raw : {}) as Partial<SearchResultItem>
  // type 运行时枚举校验：未知值归 'message'（最常见 fallback；同时打 console 警告以便排查）
  let resultType: FtsResultType = 'message'
  if (typeof it.type === 'string' && RESULT_TYPE_SET.has(it.type as FtsResultType)) {
    resultType = it.type as FtsResultType
  } else if (typeof it.type === 'string') {
    // 降级分支：后端返回未知 result type，归一到 message——记一条便于对齐契约漂移
    log.warn('unknown result type, falling back to message:', { type: it.type })
  }

  return {
    id: typeof it.id === 'string' ? it.id : '',
    type: resultType,
    title: typeof it.title === 'string' ? it.title : '',
    snippet: typeof it.snippet === 'string' ? it.snippet : '',
    highlight: it.highlight && typeof it.highlight === 'object'
      ? (it.highlight as Record<string, string[]>)
      : {},
    creator_type: (it.creator_type === 'user' || it.creator_type === 'agent') ? it.creator_type : null,
    creator_id: it.creator_id ?? null,
    creator_name: it.creator_name ?? null,
    creator_avatar: it.creator_avatar ?? null,
    space_id: it.space_id ?? null,
    space_name: it.space_name ?? null,
    session_id: it.session_id ?? null,
    session_title: it.session_title ?? null,
    resource_id: it.resource_id ?? null,
    score: typeof it.score === 'number' ? it.score : 0,
    rrf_score: typeof it.rrf_score === 'number' ? it.rrf_score : 0,
    created_at: it.created_at ?? null,
    role: it.role ?? null,
    metadata: it.metadata && typeof it.metadata === 'object'
      ? (it.metadata as Record<string, unknown>)
      : {},
  }
}

/**
 * 调用统一搜索 API。
 *
 * 关键约束：
 * - **不要** 在 React effect 里直接 catch AbortError 当成错误显示；
 *   AbortError 是用户取消的正常路径。
 * - degraded 不是错误：response.degraded=true 时函数仍 resolve，
 *   调用方读取 `degraded_reason` 后渲染 banner。
 * - 401（未登录）/ 5xx 抛 `UnifiedSearchError`，调用方应区分处理。
 *
 * @param params  请求参数（1:1 对齐 SearchParams schema）
 * @param options.signal AbortSignal，用于取消过时请求
 * @returns       归一化后的 UnifiedSearchResponse
 */
export async function unifiedSearch(
  params: UnifiedSearchParams,
  options: { signal?: AbortSignal } = {},
): Promise<UnifiedSearchResponse> {
  if (!params.q || !params.q.trim()) {
    throw new UnifiedSearchError('q 不能为空', 400)
  }
  if (!params.organization_id || !params.organization_id.trim()) {
    throw new UnifiedSearchError('organization_id 不能为空', 400)
  }

  const qs = buildQueryString(params)
  const url = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.FTS.SEARCH}${qs ? `?${qs}` : ''}`)
  const token = await getAuthToken()
  const headers: Record<string, string> = { 'Accept': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers,
      signal: options.signal,
    })
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw err
    }
    throw new UnifiedSearchError('网络请求失败，请检查连接', 0, err)
  }

  if (resp.status === 401) {
    throw new UnifiedSearchError('登录已失效，请重新登录', 401)
  }
  if (!resp.ok) {
    let body: unknown
    try { body = await resp.json() } catch { body = undefined }
    throw new UnifiedSearchError(
      `搜索服务返回错误（HTTP ${resp.status}）`,
      resp.status,
      body,
    )
  }

  let data: unknown
  try {
    data = await resp.json()
  } catch (err) {
    throw new UnifiedSearchError('搜索响应解析失败', 502, err)
  }

  return normalizeResponse(data)
}
