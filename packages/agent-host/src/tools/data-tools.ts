/**
 * Data tools — memory / credential.
 *
 * 4 类能力共 5 个工具（凭据拆 lookup + retrieve 两步），均为 HTTP wrapper
 * 调用云端 REST API：
 *   1. memory_search          → GET  /api/agent-memory/memories/         ( W2b)
 *   2. memory_write           → POST /api/agent-memory/memories/          ( W2b)
 *   3. memory_delete          → POST /api/agent-memory/memories/{id}/forget/ ( W2b)
 *   4a. credential_lookup     → GET  /api/credential-vault/{website,app}/match
 *   4b. credential_retrieve   → POST /api/credential-vault/{website,app}/{id}/autofill-reveal
 *
 * `rag_search` 与 TabCode 代码语义检索均已从工具面移除。
 *
 * **#4118 W2b（Agent Memory 从 TabMemo 解耦）**：memory_* 工具从旧的
 * `/tabmemo/memos?source=agent` 猜类型分流，切到独立领域端点 `/agent-memory`。
 * 归属三键 (organization, agent, subject) 中 organization/agent 由**可信上下文**
 * （`DataToolsDeps`）解析，不再让 LLM 传 space_id 自选归属；缺 agent 显式
 * 失败（RUNTIME_MISCONFIG），绝不写无主行。隐私总闸关闭时 search/write 不注册
 * （见 `createDataTools` 的 `memoryEnabled` 门控， 运行时侧）。
 *
 * list_conversations / read_conversation 已在工具系统宪法 W1 中删除——
 * LLM 通过 read_file 读本地 jsonl 作为 silent memory（system prompt 已引导）。
 */

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
  AUTH_FAILED,
  INVALID_PARAM_FORMAT,
  MISSING_REQUIRED_PARAM,
  NETWORK_FAILED,
  PERMISSION_DENIED,
  RATE_LIMITED,
  REQUEST_TIMEOUT,
  RESOURCE_NOT_FOUND,
  RUNTIME_MISCONFIG,
  UPSTREAM_ERROR,
} from '@tabtin/agent-runtime/tools'
import type { ToolErrorKind } from '@tabtin/agent-runtime/tools'

// ─── Shared types & helpers ──────────────────────────────────────────

export interface DataToolsDeps {
  apiBaseUrl: string
  apiAuthToken?: string
  organizationId?: string
  /**
   *  W2b：执行 Agent 的 agent_id（**可信上下文**，由 host 从会话烘焙注入，
   * 不由 LLM 提供）。Agent 记忆按 (organization, agent, subject_user) 完全隔离——
   * memory_search/write/delete 全部以此为归属键。缺失时记忆工具在调用 HTTP 前
   * 返回明确 RUNTIME_MISCONFIG（：绝不写无主行、不静默失败）。
   */
  agentId?: string
  /**
   *  W2b（运行时侧）：隐私总闸（`MemoRecordStyle.enabled` 派生的
   * `memoryCapability`）。``false`` 时 `createDataTools` 不注册 memory_search /
   * memory_write（不再暴露可调用又返回空、伪装"无记忆"）；memory_delete/forget
   * 保留（ 建议：关闭态用户仍可让 Agent 忘记既有记忆）。缺省视为 ``true``
   * （向后兼容——旧调用点/测试不传即按开启处理，后端仍是最终闸门）。
   */
  memoryEnabled?: boolean
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * W7 双层结果：LLM 摘要中保留前 N 条结果作为决策线索。
 *
 * 与 web-tools 同口径——3 条 + 200 字符 snippet 是经验平衡（够 LLM 判断
 * "是否找到相关结果"，但不污染 context）。memory_search 内容更短，单独留 300 字符。
 */
const LLM_RESULT_PREVIEW_COUNT = 3
const LLM_MEMORY_PREVIEW_CHARS = 300

/**
 * 统一的 emit 失败兜底：dev 模式下 console.warn 让本地排错时能看到，
 * 生产模式静默——双层是锦上添花，emit 失败不能阻塞工具结果回到 LLM。
 */
function warnEmitFailure(toolName: string, err: unknown): void {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    console.warn(`[${toolName}] RICH_CONTENT emit failed:`, err)
  }
}

interface HttpCallOptions {
  method: 'GET' | 'POST'
  path: string
  operation?: string
  toolName?: string
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  /** 超时（ms），默认 30s。 */
  timeout?: number
}

interface HttpCallSuccess<T> {
  ok: true
  status: number
  data: T
}

interface HttpCallFailure {
  ok: false
  status: number
  /** 归一化后的错误码：``invalid_input`` / ``unauthorized`` / ``forbidden`` /
   *  ``not_found`` / ``gone`` / ``rate_limited`` / ``service_unavailable`` /
   *  ``network_error`` / ``timeout`` / ``bad_response`` / ``unknown_error`` */
  error: string
  /** LLM-facing product message; backend implementation details have been translated. */
  message: string
  /** English actionable next step for the LLM. */
  hint: string
  /** Product-semantic error kind from the shared backend translator. */
  errorKind?: ToolErrorKind
  /** 后端返回的业务码（如 ``CREDENTIAL_EXPIRED`` / ``RATE_LIMITED``）——原样透传，
   *  便于上层做细粒度分支决策；若后端未给出则为 ``undefined``。 */
  code?: string
}

type HttpCallResult<T> = HttpCallSuccess<T> | HttpCallFailure

/**
 * 公共 fetch helper：
 *   - 统一注入 Authorization / X-TabTin-Organization-Id / Content-Type
 *   - HTTP 4xx/5xx / 网络异常 / 超时归一化为 ``HttpCallFailure``，业务侧不必每次重写
 *   - 解 JSON 失败时仍能给出可读错误，避免抛出未捕获异常打断 ReAct loop
 */
async function callApi<T = unknown>(
  deps: DataToolsDeps,
  opts: HttpCallOptions,
): Promise<HttpCallResult<T>> {
  let url = joinApiPath(deps.apiBaseUrl, opts.path)
  if (opts.query) {
    const searchParams = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query)) {
      if (v == null) continue
      if (v === '') continue
      searchParams.set(k, String(v))
    }
    const qs = searchParams.toString()
    if (qs) url = `${url}?${qs}`
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  if (deps.apiAuthToken) {
    headers['Authorization'] = `Bearer ${deps.apiAuthToken}`
  }
  if (deps.organizationId) {
    headers['X-TabTin-Organization-Id'] = deps.organizationId
  }

  const init: RequestInit = {
    method: opts.method,
    headers,
    signal: AbortSignal.timeout(opts.timeout ?? DEFAULT_TIMEOUT_MS),
  }
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body)
  }

  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    const translated = translateBackendError({
      error,
      toolName: opts.toolName ?? 'data tool',
      operation: opts.operation ?? opts.path,
      fallbackMessage: 'The data service request failed.',
    })
    return {
      ok: false,
      status: 0,
      error: translated.error_kind === REQUEST_TIMEOUT ? 'timeout' : 'network_error',
      message: translated.message,
      hint: translated.hint,
      errorKind: translated.error_kind,
      code: translated.upstream_code,
    }
  }

  let payload: unknown
  let payloadParsed = false
  try {
    payload = await response.json()
    payloadParsed = true
  } catch {
    payload = null
  }

  if (response.ok) {
    if (!payloadParsed) {
      const translated = translateBackendError({
        status: response.status,
        body: null,
        toolName: opts.toolName ?? 'data tool',
        operation: opts.operation ?? opts.path,
        fallbackMessage: 'The data service returned an invalid response.',
      })
      return {
        ok: false,
        status: response.status,
        error: 'bad_response',
        message: translated.message,
        hint: translated.hint,
        errorKind: translated.error_kind,
        code: translated.upstream_code,
      }
    }
    return { ok: true, status: response.status, data: payload as T }
  }

  const translated = translateBackendError({
    status: response.status,
    body: payload,
    toolName: opts.toolName ?? 'data tool',
    operation: opts.operation ?? opts.path,
    fallbackMessage: 'The data service request failed.',
  })
  const backendCode = translated.upstream_code

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: response.status,
      error: response.status === 401 ? 'unauthorized' : 'forbidden',
      message: translated.message,
      hint: translated.hint,
      errorKind: translated.error_kind,
      code: backendCode,
    }
  }
  if (response.status === 404) {
    return {
      ok: false,
      status: response.status,
      error: 'not_found',
      message: translated.message,
      hint: translated.hint,
      errorKind: translated.error_kind,
      code: backendCode,
    }
  }
  if (response.status === 410) {
    // W1-B：App 凭据 autofill-reveal 在过期/停用时返回 410 + code=CREDENTIAL_EXPIRED
    // / CREDENTIAL_INACTIVE；归一化为 ``gone`` 让 Agent 能与「参数错」区分（重试
    // 策略不同——过期/停用重试一万次也没用，要提示用户在设置里更新）。
    return {
      ok: false,
      status: response.status,
      error: 'gone',
      message: translated.message,
      hint: translated.hint,
      errorKind: translated.error_kind,
      code: backendCode,
    }
  }
  if (response.status === 429) {
    return {
      ok: false,
      status: response.status,
      error: 'rate_limited',
      message: translated.message,
      hint: translated.hint,
      errorKind: translated.error_kind,
      code: backendCode,
    }
  }
  if (response.status >= 500) {
    return {
      ok: false,
      status: response.status,
      error: 'service_unavailable',
      message: translated.message,
      hint: translated.hint,
      errorKind: translated.error_kind,
      code: backendCode,
    }
  }
  if (response.status >= 400) {
    return {
      ok: false,
      status: response.status,
      error: 'invalid_input',
      message: translated.message,
      hint: translated.hint,
      errorKind: translated.error_kind,
      code: backendCode,
    }
  }
  return {
    ok: false,
    status: response.status,
    error: 'unknown_error',
    message: translated.message,
    hint: translated.hint,
    errorKind: translated.error_kind,
    code: backendCode,
  }
}

/** 把 HttpCallFailure 包成 ToolResult.content（JSON 字符串）。
 *  ``upstream_code`` 字段只保留安全白名单业务码（如 CREDENTIAL_EXPIRED），让 Agent
 *  能区分「参数错」「凭据失效」「限流」等语义相近但处置不同的失败。
 *
 *  **L-35（W13 收口）**：根据 failure.error 标签映射到前端 catalog 可识别的
 *  `error_kind`，让前端 / observability 拿到稳定枚举（不是 callApi 内部的细分
 *  std 字符串）。原 `failure.error` 仍作为 `error_label` 保留供 LLM 区分细类。
 */
function failureToToolResult(failure: HttpCallFailure): ToolResult {
  let errorKind: string | undefined = failure.errorKind
  if (!errorKind) {
    switch (failure.error) {
      case 'timeout':
        errorKind = REQUEST_TIMEOUT
        break
      case 'network_error':
        errorKind = NETWORK_FAILED
        break
      case 'unauthorized':
        errorKind = AUTH_FAILED
        break
      case 'forbidden':
        errorKind = PERMISSION_DENIED
        break
      case 'not_found':
      case 'gone':
        errorKind = RESOURCE_NOT_FOUND
        break
      case 'rate_limited':
        errorKind = RATE_LIMITED
        break
      case 'invalid_input':
        errorKind = INVALID_PARAM_FORMAT
        break
      default:
        errorKind = UPSTREAM_ERROR
    }
  }
  return jsonError(failure.message, toJsonErrorMetadata({
    error_kind: errorKind as ToolErrorKind,
    message: failure.message,
    hint: failure.hint,
    upstream_status: failure.status,
    upstream_code: failure.code,
  }, {
    error_label: failure.error,
    status: failure.status,
  }))
}

/** 把云端响应直接包成 ToolResult.content；带 success:true 包装。 */
function successToToolResult(data: unknown): ToolResult {
  // 云端 RAG/credential 直接返回 schema；tabmemo/chat 走 success_response 信封
  // 解包后仍是 schema。统一在 wrapper 层补 success:true 让 LLM 一眼分辨。
  let body: Record<string, unknown>
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    body = { success: true, ...(data as Record<string, unknown>) }
  } else {
    body = { success: true, data }
  }
  return { content: JSON.stringify(body) }
}

/** 解云端 success_response 信封（{success, data, ...}）拿到内层 data；
 *  若已经是裸数据（如 RAG/credential 直接返回），原样返回。 */
function unwrapEnvelope<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && 'success' in raw && 'data' in (raw as Record<string, unknown>)) {
    return (raw as unknown as { data: T }).data
  }
  return raw as T
}

function safeCredentialLookupEntry(
  credential: Record<string, unknown>,
  credentialType: 'website' | 'app',
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    credential_type: credentialType,
  }
  if (typeof credential.id === 'string') entry.id = credential.id
  if (typeof credential.credential_id === 'string') entry.credential_id = credential.credential_id
  if (typeof credential.username === 'string') entry.username = credential.username
  if (typeof credential.masked_password === 'string') entry.masked_password = credential.masked_password
  if (credentialType === 'website' && typeof credential.url === 'string') entry.url = credential.url
  if (credentialType === 'app' && typeof credential.app_package === 'string') {
    entry.app_package = credential.app_package
  }
  return entry
}

interface CredentialAvailabilityRecord {
  id?: string
  username?: string
  url?: string
  app_package?: string
  service_name?: string
  is_active?: boolean
  expires_at?: string | null
  masked_data?: Record<string, unknown>
}

function credentialAvailabilityCategory(
  credentialType: 'website' | 'app',
): 'website_login' | 'app_login' {
  return credentialType === 'website' ? 'website_login' : 'app_login'
}

function findCredentialAvailabilityRecord(
  items: unknown[],
  credentialId: string,
): CredentialAvailabilityRecord | undefined {
  return items.find(
    (item) => String((item as CredentialAvailabilityRecord).id) === credentialId,
  ) as CredentialAvailabilityRecord | undefined
}

function credentialAvailabilityFailure(
  reason: 'not_found' | 'inactive' | 'expired',
): ToolResult {
  if (reason === 'not_found') {
    const message = 'Saved credential was not found.'
    return jsonError(message, toJsonErrorMetadata({
      error_kind: RESOURCE_NOT_FOUND,
      message,
      hint: 'Run credential_lookup again. If the credential was deleted, ask the user to re-save it in Agent Security settings.',
      // 安全运维归因码：仅 NOT_FOUND 字面，不含 credential id / secret。
      upstream_code: 'NOT_FOUND',
    }))
  }
  const code = reason === 'expired' ? 'CREDENTIAL_EXPIRED' : 'CREDENTIAL_INACTIVE'
  const message =
    reason === 'expired'
      ? 'Saved credential has expired.'
      : 'Saved credential is inactive.'
  return jsonError(
    message,
    toJsonErrorMetadata({
      error_kind: RESOURCE_NOT_FOUND,
      message,
      hint: 'Do not call credential_retrieve again with the same input. Ask the user to update or re-enable the saved credential, then run credential_lookup again.',
      upstream_code: code,
    }),
  )
}

function credentialAvailabilityMetadata(
  record: CredentialAvailabilityRecord,
  credentialType: 'website' | 'app',
): { username: string; url?: string } {
  const masked = record.masked_data ?? {}
  const username =
    typeof record.username === 'string'
      ? record.username
      : typeof masked.username === 'string'
        ? masked.username
        : ''
  if (credentialType === 'website') {
    const url =
      typeof record.url === 'string'
        ? record.url
        : typeof masked.url === 'string'
          ? masked.url
          : ''
    return { username, url }
  }
  return { username }
}

// ─── Schemas ─────────────────────────────────────────────────────────

const memorySearchInputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        '自然语言检索 Agent 记忆（后端按关键词 / 中文 bigram 打分，支持改写问法；' +
        '不是整句精确子串匹配）。传 `"*"` 作为通配符浏览近期记忆。',
    },
    // /#4118 W2b：不再暴露 space_id——记忆归属 (organization, agent, subject)
    // 由可信上下文解析，LLM 不能自选空间/归属。
    memo_type: {
      type: 'string',
      enum: ['about_you', 'insight', 'task_summary', 'diary'],
      description: '按记忆类型过滤：`about_you`（用户事实）/ `insight`（学到的模式）/ `task_summary` / `diary`（日记）。',
    },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  // W4 Lane F：query 必填化——避免 silent "browse mode" 把列最近 20 条记忆
  // 当"搜索结果"误读（W15 盘点 F2.1）。
  required: ['query'],
} as unknown as Tool['inputSchema']

const memoryWriteInputSchema = {
  type: 'object',
  properties: {
    content: { type: 'string', description: '要记忆的 markdown 正文（推荐）或纯文本。' },
    // /#4118 W2b：不再暴露 space_id——归属由可信上下文（当前执行 Agent）解析。
    memo_type: {
      type: 'string',
      enum: ['about_you', 'insight', 'task_summary'],
      default: 'insight',
      description: '记忆类型：`about_you`（用户事实）/ `insight`（学到的模式）/ `task_summary`。',
    },
    importance: { type: 'integer', minimum: 1, maximum: 5, description: '可选重要性提示（1-5）。' },
    tags: { type: 'array', items: { type: 'string' }, description: '可选标签列表。' },
    source_url: { type: 'string', description: '可选来源链接（譬如 `thread://session_id`）。' },
  },
  required: ['content'],
} as unknown as Tool['inputSchema']

const memoryDeleteInputSchema = {
  type: 'object',
  properties: {
    memo_id: { type: 'string', description: '要忘记（forget）的记忆 UUID。先用 memory_search 拿到 id。' },
  },
  required: ['memo_id'],
} as unknown as Tool['inputSchema']

const credentialLookupInputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string', description: '要匹配的网站域名（譬如 `github.com` 或 `login.github.com`）。' },
    app_package: { type: 'string', description: '应用包名（譬如 `com.twitter.android`）。' },
  },
} as unknown as Tool['inputSchema']

const credentialRetrieveInputSchema = {
  type: 'object',
  properties: {
    credential_id: { type: 'string', description: '要验证的凭证 UUID。' },
    credential_type: {
      type: 'string',
      enum: ['website', 'app'],
      description:
        // 阶段 6.6 议题 3 瘦身 + 翻译：secret 不返回 / autofill / skill injection
        // 细节已搬到工具 description（data-tools.ts credential_retrieve 工厂）。
        '必填：必须与 credential_lookup 返回的 type 一致。',
    },
  },
  required: ['credential_id', 'credential_type'],
} as unknown as Tool['inputSchema']

// ─── Factory ─────────────────────────────────────────────────────────

export function createDataTools(deps: DataToolsDeps): Tool[] {
  //  / ：隐私总闸门控——memoryEnabled=false（总闸关）时，
  // 不把 memory_search / memory_write 暴露给 LLM——LLM 连工具 schema 都看不到，
  // 从根上避免"关闭后仍能读旧记忆 / 写新记忆"或"返回空数组伪装无记忆"。
  // memory_delete（forget）保留：关闭态用户仍可让 Agent 忘记既有记忆（ 建议）。
  // 缺省（undefined）按开启处理——旧装配点/测试不传即向后兼容；Electron/Daemon
  // 装配点应显式传入 memoryCapability === true 的布尔值（ WP2）。
  const memoryEnabled = deps.memoryEnabled !== false
  const tools: Tool[] = []
  if (memoryEnabled) {
    tools.push(createMemorySearchTool(deps), createMemoryWriteTool(deps))
  }
  tools.push(
    createMemoryDeleteTool(deps),
    createCredentialLookupTool(deps),
    createCredentialRetrieveTool(deps),
  )
  return tools
}

// ─── memory_search ───────────────────────────────────────────────────

/**
 * Agent 视角的一条记忆摘要 —— 给 `memory_search` 工具和 `memory-injector`
 * hook 共享的"已解析字段集"。
 *
 * 字段来源是后端 `/agent-memory` 领域 DTO（`MemoryOut`，见 W2a
 * `apps/agent_memory/schemas.py`）；这里只挑 LLM 真正会用的几个，把领域字段名
 * （`memory_type` / `source_ref`）映射回本地 shape（`memo_type` / `source_url`），
 * 让下游 `buildMemoryRecallSection` 无需感知领域拆分（ W2b）。
 */
export interface MemorySummary {
  id?: string
  content: string
  memo_type?: string
  tags?: string[]
  importance?: number
  created_at?: string
  source_url?: string
}

/**
 *  W2b：memory 召回一次 HTTP 取材的结构化结局（不含记忆正文，只含范畴）。
 *
 * `callMemorySearchAPI` 保持 fail-soft（永远返回数组，失败返 `[]`），但通过
 * `hooks.reportOutcome` 把「成功命中 N / 零命中 / 失败（分类）」上报给宿主，
 * 让 memory-injector 的自动召回不再"失败 = 无记忆"混同（用户/运维无法归因）。
 */
export type MemoryRecallErrorCategory =
  | 'misconfig'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'network'
  | 'timeout'
  | 'server'
  | 'invalid'
  | 'unknown'

export type MemoryRecallFetchOutcome =
  | { kind: 'ok'; count: number }
  | { kind: 'zero_hit' }
  | { kind: 'error'; category: MemoryRecallErrorCategory }

export interface MemorySearchHooks {
  /** 上报本次取材结局（不含记忆正文）；宿主可落内部诊断日志/指标。 */
  reportOutcome?: (outcome: MemoryRecallFetchOutcome) => void
}

/** 把 `HttpCallFailure.error` 归一化标签映射到召回错误范畴（ 诊断分类）。 */
function mapRecallErrorCategory(errorLabel: string): MemoryRecallErrorCategory {
  switch (errorLabel) {
    case 'unauthorized':
      return 'auth'
    case 'forbidden':
      return 'forbidden'
    case 'not_found':
    case 'gone':
      return 'not_found'
    case 'rate_limited':
      return 'rate_limited'
    case 'network_error':
      return 'network'
    case 'timeout':
      return 'timeout'
    case 'service_unavailable':
    // callApi 在 2xx 但响应体非法 JSON 时归一为 `bad_response`——这是服务端
    // 吐了坏响应，归 server 类而非 unknown，便于与真正的未知失败区分。
    case 'bad_response':
      return 'server'
    case 'invalid_input':
      return 'invalid'
    default:
      return 'unknown'
  }
}

/**
 * 调 `/agent-memory` 召回记忆，并解析成 `MemorySummary[]`（ W2b）。
 *
 * 被两个消费方共用：
 *   1. `memory_search` 工具（保持原行为：双层结果 + emitRichContentBlock）
 *   2. `memory-injector` hook（每轮 LLM 前 `<memory_recall>` 注入）
 *
 * **归属**：记忆按 (organization, agent, subject) 隔离——organization/agent 由
 * `deps` 可信上下文提供；缺任一 → 视为 `misconfig`，reportOutcome 上报后返回
 * `[]`（：不静默失败）。
 *
 * **检索语义**：`query` 原样透传为 `search=`；后端统一检索层做分词 /
 * 关键词 OR 候选 / 命中数打分 / 分数+新鲜度排序——不是整句 `icontains`，
 * 也不是向量全文检索。零关键词命中 → 空数组（`zero_hit`）。
 *
 * **失败语义**：HTTP 4xx/5xx / 网络异常时不抛——返回空数组（hook 静默跳过
 * 注入；tool 自己已经走 failureToToolResult 路径，与 helper 解耦）。但通过
 * `hooks.reportOutcome` 上报结局分类，让宿主区分零命中 vs 召回失明。
 */
export async function callMemorySearchAPI(
  deps: DataToolsDeps,
  params: { query: string; limit?: number; memoType?: string },
  hooks?: MemorySearchHooks,
): Promise<MemorySummary[]> {
  // ：诊断上报兜底——宿主 sink 抛错绝不能把 fail-soft 召回变成抛错路径
  // （与 memory-injector 的 emitDiagnostic 同契约）。
  const reportOutcome = (outcome: MemoryRecallFetchOutcome): void => {
    try {
      hooks?.reportOutcome?.(outcome)
    } catch {
      // 诊断信号锦上添花，绝不反噬召回主路径。
    }
  }
  // /#4118：归属三键缺 organization/agent 时不发请求——绝不猜、不静默空。
  if (!deps.organizationId || !deps.agentId) {
    reportOutcome({ kind: 'error', category: 'misconfig' })
    return []
  }
  const trimmed = params.query.trim()
  if (!trimmed) {
    reportOutcome({ kind: 'zero_hit' })
    return []
  }

  // 后端不接受字面 '*'（会变成"包含星号"过滤）；adapter 端把 '*' 翻译成不传 search。
  const isWildcardBrowse = trimmed === '*'
  const searchKeyword = isWildcardBrowse ? undefined : params.query

  const result = await callApi<Record<string, unknown>>(deps, {
    method: 'GET',
    path: '/agent-memory/memories/',
    toolName: 'memory_search',
    operation: 'agent memory recall',
    query: {
      organization_id: deps.organizationId,
      // ：归属 = 当前执行 Agent（可信上下文），后端按 (org, agent, subject) 强隔离。
      agent_id: deps.agentId,
      search: searchKeyword,
      memory_type: params.memoType,
      limit: params.limit ?? 20,
    },
  })

  if (!result.ok) {
    reportOutcome({ kind: 'error', category: mapRecallErrorCategory(result.error) })
    return []
  }
  const inner = unwrapEnvelope<Record<string, unknown>>(result.data)
  const items = Array.isArray(inner.items) ? (inner.items as Record<string, unknown>[]) : []
  const memos = items.map((m) => ({
    id: typeof m.id === 'string' ? m.id : undefined,
    // /agent-memory DTO 字段名：content / memory_type / source_ref（W2a schemas.py）。
    content: typeof m.content === 'string' ? m.content : '',
    memo_type: typeof m.memory_type === 'string' ? m.memory_type : undefined,
    tags: Array.isArray(m.tags) ? (m.tags as unknown[]).filter((t): t is string => typeof t === 'string') : undefined,
    importance: typeof m.importance === 'number' ? m.importance : undefined,
    created_at: typeof m.created_at === 'string' ? m.created_at : undefined,
    source_url: typeof m.source_ref === 'string' ? m.source_ref : undefined,
  }))
  reportOutcome(memos.length > 0 ? { kind: 'ok', count: memos.length } : { kind: 'zero_hit' })
  return memos
}

function createMemorySearchTool(deps: DataToolsDeps): Tool {
  return {
    name: 'memory_search',
    description:
      '关键词检索本 Agent **自写**的长期记忆（about_you / insight / task_summary / diary，独立 Agent 记忆域）。' +
      '后端对 query 分词后做多关键词 OR 候选 + 命中数打分，自然语言改写也可命中；' +
      '**不是**整句子串匹配，也**不是**向量语义搜索。' +
      '**用途**：用户偏好、过去对话、任务上下文、Agent 自己的笔记。' +
      '**只**返回当前 Agent 对当前用户的记忆——跨 Agent / 跨用户完全隔离。' +
      '**不是**：workspace 源码或文件内容；工作空间向量语义搜索；shell 内容搜索。' +
      'query 必填；浏览近期可传 query="*"。',
    inputSchema: memorySearchInputSchema,
    isReadOnly: true,
    policyActionKind: 'object_read',
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      const params = input as {
        query?: string
        memo_type?: string
        limit?: number
      }

      // W4 Lane F：query 必填化（W15 盘点 F2.1 修复方向）。
      //
      // **calculator 同款 silent-success 入口**：旧实现 query 漏传时后端按
      // `?source=agent&organization_id=...&limit=20` 列最近 20 条 memo —— LLM
      // 看到 `count: 20, memories: [...]` 会以为"默认搜全部相关"，实际是
      // "时间倒序的 20 条无关 memo"。把"列出"误读为"相关"是教科书级
      // false positive。
      //
      // 修法：query 缺失或空字符串 → fail with MISSING_REQUIRED_PARAM。
      // hint 引导 LLM 用 `query='*'` 强制 wildcard 浏览（后端支持的话）
      // 或 deliberate query。任务范围："如 list_recent_memories 不存在则
      // 只 fail" —— TabTin 当前没有 list_recent_memories 工具，所以这里
      // 只 fail，不暗示其它工具。
      if (typeof params.query !== 'string' || params.query.trim() === '') {
        return jsonError('query is required for memory_search.', {
          error_kind: MISSING_REQUIRED_PARAM,
          field: 'query',
          hint:
            'Provide a non-empty query that describes the memory you want to find. ' +
            'To browse recent memories without a specific topic, pass query="*" as a wildcard.',
        })
      }

      if (!deps.organizationId) {
        return jsonError('缺少 organization_id 上下文，无法搜索记忆。请检查 Agent 启动配置。', {
          error_kind: RUNTIME_MISCONFIG,
          missing: 'organization_id',
        })
      }
      // /#4118：记忆按 (organization, agent, subject) 隔离，agent_id 由可信
      // 上下文注入。缺失时明确失败——不发无归属请求、不返回空数组伪装无记忆。
      if (!deps.agentId) {
        return jsonError('缺少执行 Agent 上下文，无法搜索记忆。请检查 Agent 启动配置。', {
          error_kind: RUNTIME_MISCONFIG,
          missing: 'agent_id',
        })
      }

      // 后端不接受字面 '*' 作 search keyword（会变成"包含星号"过滤）；adapter
      // 端把 '*' 翻译成"不传 search"，让后端走默认列表（仍受 limit / memory_type
      // 限制）。用户 → LLM → tool 这条链上 LLM 显式表达"我要列最近的"，并不是
      // "我忘了传 query"。这里仍然走 callApi 一手（拿原 result 走 envelope /
      // pagination / failureToToolResult 路径），不复用 helper —— helper 是
      // 解过的 MemorySummary，丢了 has_more / next_cursor / failure detail。
      const isWildcardBrowse = params.query.trim() === '*'
      const searchKeyword = isWildcardBrowse ? undefined : params.query

      const result = await callApi<Record<string, unknown>>(deps, {
        method: 'GET',
        path: '/agent-memory/memories/',
        toolName: 'memory_search',
        operation: 'agent memory recall',
        query: {
          organization_id: deps.organizationId,
          // ：归属 = 当前执行 Agent（可信上下文），后端按 (org, agent, subject) 强隔离。
          agent_id: deps.agentId,
          search: searchKeyword,
          memory_type: params.memo_type,
          limit: params.limit ?? 20,
        },
      })

      if (!result.ok) return failureToToolResult(result)
      const inner = unwrapEnvelope<Record<string, unknown>>(result.data)
      const items = Array.isArray(inner.items) ? (inner.items as Record<string, unknown>[]) : []

      // W7 双层结果：UI 看完整 memo 卡片，LLM 看 top-N 摘要（content 截断 300 字符）。
      // 字段解析与 ``callMemorySearchAPI`` helper 严格一致 —— 那里是这部分逻辑的
      // 抽出版本（给 memory-injector hook 复用）；本入口保留 inline 形态是为了
      // 同时拿到 has_more / next_cursor 等 envelope 周边字段。
      // /agent-memory DTO 字段名：content / memory_type / source_ref（W2a）。
      const fullMemories: MemorySummary[] = items.map((m) => ({
        id: typeof m.id === 'string' ? m.id : undefined,
        content: typeof m.content === 'string' ? m.content : '',
        memo_type: typeof m.memory_type === 'string' ? m.memory_type : undefined,
        tags: Array.isArray(m.tags) ? (m.tags as unknown[]).filter((t): t is string => typeof t === 'string') : undefined,
        importance: typeof m.importance === 'number' ? m.importance : undefined,
        created_at: typeof m.created_at === 'string' ? m.created_at : undefined,
        source_url: typeof m.source_ref === 'string' ? m.source_ref : undefined,
      }))

      const hasMore = inner.has_more === true
      const nextCursor = typeof inner.next_cursor === 'string' ? inner.next_cursor : ''

      // Wave 2: 走 ToolContext.emitRichContentBlock，emit tabtin_rich_content
      // block（kind='memory_card'）。
      if (fullMemories.length > 0 && context.emitRichContentBlock) {
        try {
          context.emitRichContentBlock({
            kind: 'memory_card',
            summary: `memory_search${params.query ? `: ${params.query}` : ''} (${fullMemories.length})`,
            payload: {
              query: params.query,
              memories: fullMemories,
              total_count: fullMemories.length,
              has_more: hasMore,
              next_cursor: nextCursor,
              //  W5：把执行 Agent 的可信 agent_id 随富块下发，让聊天里的
              // 记忆卡深链能精确落到「我的 Agent → 该 Agent → 记忆」并高亮该条
              // （RichMemoryCard 消费 block.agent_id）。deps.agentId 在本分支上游
              // 已校验非空（memory_search 缺 agent_id 直接失败，不发请求）。
              agent_id: deps.agentId,
            },
          })
        } catch (err) {
          warnEmitFailure('memory_search', err)
        }
      }

      // LLM 摘要：前 N 条 memo 的 type + content 前 300 字符 + tags。LLM 能判断
      // "这条记忆跟当前任务相关吗 / 我要不要 deep-dive 哪条"，但不会回流大文本。
      const previewMemories = fullMemories.slice(0, LLM_RESULT_PREVIEW_COUNT).map((m, i) => ({
        index: i + 1,
        id: m.id,
        memo_type: m.memo_type,
        content_preview: m.content.length > LLM_MEMORY_PREVIEW_CHARS
          ? `${m.content.slice(0, LLM_MEMORY_PREVIEW_CHARS)}…`
          : m.content,
        tags: m.tags,
        created_at: m.created_at,
      }))

      return {
        content: JSON.stringify({
          success: true,
          count: fullMemories.length,
          shown_in_summary: previewMemories.length,
          memories: previewMemories,
          next_cursor: nextCursor,
          has_more: hasMore,
          _memories: fullMemories,
        }),
        llmStripKeys: ['_memories'],
      }
    },
  }
}

// ─── memory_write ────────────────────────────────────────────────────

function createMemoryWriteTool(deps: DataToolsDeps): Tool {
  return {
    name: 'memory_write',
    description:
      '写一条长期记忆。用来记关于用户的事实（about_you）、从过去任务里得到的洞察（insight）、' +
      '或任务小结（task_summary）。' +
      '**不要**写琐碎或临时的信息——记忆是跨 session 持久化的。' +
      '**不要**当作临时推理的草稿本用。',
    inputSchema: memoryWriteInputSchema,
    isReadOnly: false,
    policyActionKind: 'object_write',
    execute: async (input: unknown): Promise<ToolResult> => {
      const params = input as {
        content?: string
        memo_type?: string
        importance?: number
        tags?: string[]
        source_url?: string
      }

      if (!params.content || params.content.trim() === '') {
        return jsonError('content 不能为空', {
          error_kind: MISSING_REQUIRED_PARAM,
          field: 'content',
          hint: 'Provide the durable memory content in content before calling memory_write.',
        })
      }
      if (!deps.organizationId) {
        return jsonError('缺少 organization_id 上下文，无法写入记忆。请检查 Agent 启动配置。', {
          error_kind: RUNTIME_MISCONFIG,
          missing: 'organization_id',
        })
      }
      // ：写入归属由可信上下文（当前执行 Agent）解析——缺 agent_id 时在调
      // HTTP 前明确失败，绝不写无主行（后端 record 也会以三键必填兜底拒绝）。
      if (!deps.agentId) {
        return jsonError('缺少执行 Agent 上下文，无法写入记忆。请检查 Agent 启动配置。', {
          error_kind: RUNTIME_MISCONFIG,
          missing: 'agent_id',
        })
      }

      const body: Record<string, unknown> = {
        organization_id: deps.organizationId,
        // ：归属 = 当前执行 Agent（可信上下文，非 LLM 自选 space）。
        agent_id: deps.agentId,
        content: params.content,
        memory_type: params.memo_type ?? 'insight',
      }
      if (params.importance != null) body.importance = params.importance
      if (params.tags?.length) body.tags = params.tags
      // /agent-memory 领域用 source_ref 字段承载来源引用（W2a schemas.py）。
      if (params.source_url) body.source_ref = params.source_url

      const result = await callApi<Record<string, unknown>>(deps, {
        method: 'POST',
        path: '/agent-memory/memories/',
        toolName: 'memory_write',
        operation: 'agent memory record',
        body,
      })

      if (!result.ok) return failureToToolResult(result)
      const inner = unwrapEnvelope<Record<string, unknown>>(result.data)
      return successToToolResult({
        memo_id: inner.id ?? null,
        memo_type: inner.memory_type ?? null,
        message: '记忆已写入。',
      })
    },
  }
}

// ─── memory_delete ───────────────────────────────────────────────────

function createMemoryDeleteTool(deps: DataToolsDeps): Tool {
  return {
    name: 'memory_delete',
    description:
      '忘记（forget）一条记忆——之后不再被召回。' +
      '记忆过期、或用户明确要求忘掉某事时用。' +
      '先用 memory_search 找到 memo_id。',
    inputSchema: memoryDeleteInputSchema,
    isReadOnly: false,
    policyActionKind: 'object_write',
    execute: async (input: unknown): Promise<ToolResult> => {
      const { memo_id } = input as { memo_id?: string }
      if (!memo_id) {
        return jsonError('memo_id 不能为空', {
          error_kind: MISSING_REQUIRED_PARAM,
          field: 'memo_id',
          hint: 'Run memory_search first, then pass the memo_id of the memory the user wants forgotten.',
        })
      }
      if (!deps.organizationId) {
        return jsonError('缺少 organization_id 上下文，无法忘记记忆。请检查 Agent 启动配置。', {
          error_kind: RUNTIME_MISCONFIG,
          missing: 'organization_id',
        })
      }
      // /#4118：按 ID 的 forget 走 /agent-memory 显式端点（不再落 Memo 表），
      // 归属由可信上下文的 (organization, agent) 强制——缺 agent_id 明确失败。
      if (!deps.agentId) {
        return jsonError('缺少执行 Agent 上下文，无法忘记记忆。请检查 Agent 启动配置。', {
          error_kind: RUNTIME_MISCONFIG,
          missing: 'agent_id',
        })
      }

      const result = await callApi<Record<string, unknown>>(deps, {
        method: 'POST',
        path: `/agent-memory/memories/${encodeURIComponent(memo_id)}/forget/`,
        toolName: 'memory_delete',
        operation: 'agent memory forget',
        body: {
          organization_id: deps.organizationId,
          agent_id: deps.agentId,
        },
      })

      if (!result.ok) return failureToToolResult(result)
      const inner = unwrapEnvelope<Record<string, unknown>>(result.data)
      // 后端 forget 成功恒返回 forgotten=true；changed 表示本次是否发生状态变化
      // （幂等重复 forget → changed=false）。原样透传供 LLM 判断。
      return successToToolResult({
        memo_id,
        forgotten: true,
        changed: inner.changed === true,
        message: '记忆已忘记，不再被召回。',
      })
    },
  }
}

// ─── credential_lookup ───────────────────────────────────────────────

function createCredentialLookupTool(deps: DataToolsDeps): Tool {
  return {
    name: 'credential_lookup',
    policyActionKind: 'object_read',
    description:
      '按 domain（网站登录）或 app package（应用登录）查找已保存的凭证。' +
      '**只**返回匹配的元数据（id / url / username / masked_password）。每条包含 ' +
      'credential_type；把 id 和 credential_type 传给 credential_retrieve 来验证可用性并拿到安全 handle。' +
      '浏览器网站优先用宿主托管的自动填充。',
    inputSchema: credentialLookupInputSchema,
    isReadOnly: true,
    execute: async (input: unknown): Promise<ToolResult> => {
      const { domain, app_package } = input as { domain?: string; app_package?: string }
      if (!domain && !app_package) {
        return jsonError('domain 与 app_package 至少传一个', {
          error_kind: MISSING_REQUIRED_PARAM,
          hint: 'Pass domain for a website login or app_package for an app login before calling credential_lookup.',
        })
      }

      const calls: Array<Promise<HttpCallResult<unknown>>> = []
      if (domain) {
        calls.push(callApi(deps, {
          method: 'GET',
          path: '/credential-vault/website/match',
          toolName: 'credential_lookup',
          operation: 'website credential lookup',
          query: { domain },
        }))
      }
      if (app_package) {
        calls.push(callApi(deps, {
          method: 'GET',
          path: '/credential-vault/app/match',
          toolName: 'credential_lookup',
          operation: 'app credential lookup',
          query: { package: app_package },
        }))
      }

      const results = await Promise.all(calls)
      const websiteResult = domain ? results[0] : undefined
      const appResult = app_package ? results[domain ? 1 : 0] : undefined

      const errors: string[] = []
      const failures: HttpCallFailure[] = []
      let websiteCredentials: unknown[] = []
      let appCredentials: unknown[] = []
      if (websiteResult) {
        if (websiteResult.ok) {
          const raw = Array.isArray(websiteResult.data) ? websiteResult.data : []
          // 白名单输出字段：lookup 是 LLM-facing 元数据通道，不能透传后端对象。
          websiteCredentials = raw.map((c) => safeCredentialLookupEntry(c as Record<string, unknown>, 'website'))
        } else {
          errors.push(`website lookup: ${websiteResult.message}`)
          failures.push(websiteResult)
        }
      }
      if (appResult) {
        if (appResult.ok) {
          const raw = Array.isArray(appResult.data) ? appResult.data : []
          appCredentials = raw.map((c) => safeCredentialLookupEntry(c as Record<string, unknown>, 'app'))
        } else {
          errors.push(`app lookup: ${appResult.message}`)
          failures.push(appResult)
        }
      }

      // 任一子调成功即返回 success（部分失败用 warnings 提示），全失败才 isError
      if (websiteCredentials.length === 0 && appCredentials.length === 0 && errors.length > 0) {
        const lookupErrorMessage = errors.join('；')
        const primaryFailure = failures[0]
        const primaryKind = primaryFailure?.errorKind ?? UPSTREAM_ERROR
        return jsonError(lookupErrorMessage, toJsonErrorMetadata({
          error_kind: primaryKind,
          message: lookupErrorMessage,
          hint: primaryFailure?.hint ?? 'Retry credential_lookup once with a single domain or app_package. If it still fails, ask the user to verify saved credentials in Agent Security settings.',
          upstream_status: primaryFailure?.status,
          upstream_code: primaryFailure?.code,
        }, {
          error_label: 'lookup_failed',
          primary_error_label: primaryFailure?.error,
        }))
      }

      return successToToolResult({
        website_credentials: websiteCredentials,
        app_credentials: appCredentials,
        warnings: errors.length > 0 ? errors : undefined,
      })
    },
  }
}

// ─── credential_retrieve ─────────────────────────────────────────────

function createCredentialRetrieveTool(deps: DataToolsDeps): Tool {
  return {
    name: 'credential_retrieve',
    policyActionKind: 'object_read',
    description:
      '验证已保存的凭证并返回一个安全 handle。' +
      '输入：credential_lookup 给的 credential_id、credential_type（"website" | "app"）。' +
      '凭证秘密**永远不会**返回在 ToolResult.content 里。用宿主托管的自动填充或 skill runtime 凭证注入；' +
      '没有安全的注入路径时，停下来让用户手动完成那一步登录。',
    inputSchema: credentialRetrieveInputSchema,
    isReadOnly: true,
    // 凭据元数据仍属敏感上下文；即便只读也不走 pre-start 快路径。
    disablePreStart: true,
    execute: async (input: unknown): Promise<ToolResult> => {
      const { credential_id, credential_type } = input as {
        credential_id?: string
        credential_type?: 'website' | 'app'
      }
      if (!credential_id) {
        return jsonError('credential_id 不能为空', {
          error_kind: MISSING_REQUIRED_PARAM,
          field: 'credential_id',
          hint: 'Run credential_lookup first, then pass the returned credential_id to credential_retrieve.',
        })
      }
      if (credential_type !== 'website' && credential_type !== 'app') {
        return jsonError(
          'credential_type is required ("website" or "app"). Use the credential_type returned by credential_lookup.',
          {
            error_kind: INVALID_PARAM_FORMAT,
            field: 'credential_type',
            hint: 'Use the credential_type value returned by credential_lookup; only "website" and "app" are valid.',
          },
        )
      }

      // ：验活走脱敏 list 元数据，不调 autofill-reveal（该端点会返回明文
      // encrypted_data）。专用 availability 端点落地前，用
      // GET /credential-vault/list?category=… 做存在性 + is_active + expires_at
      // 检查——响应不含 password。
      const listPath = `/credential-vault/list?category=${encodeURIComponent(
        credentialAvailabilityCategory(credential_type),
      )}`

      const result = await callApi<unknown[]>(deps, {
        method: 'GET',
        path: listPath,
        toolName: 'credential_retrieve',
        operation: 'credential availability verify',
      })

      if (!result.ok) return failureToToolResult(result)

      const items = Array.isArray(result.data) ? result.data : []
      const record = findCredentialAvailabilityRecord(items, credential_id)
      if (!record) {
        return credentialAvailabilityFailure('not_found')
      }
      if (record.is_active === false) {
        return credentialAvailabilityFailure('inactive')
      }
      if (record.expires_at) {
        const expiresAt = Date.parse(record.expires_at)
        if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
          return credentialAvailabilityFailure('expired')
        }
      }

      const metadata = credentialAvailabilityMetadata(record, credential_type)
      const payload: Record<string, unknown> = {
        credential_id,
        credential_type,
        credential_handle: {
          credential_id,
          credential_type,
        },
        username: metadata.username,
        credential_available: true,
        secret_value_returned: false,
        status: 'available_not_revealed',
        message:
          'Saved credential was found, but this tool did not fill or reveal the secret.',
        next_step: credential_type === 'website'
          ? 'Do not repeat credential_retrieve. If browser autofill has not already filled the login form, ask the user to complete the login manually.'
          : 'Do not repeat credential_retrieve. If no host-managed secure injection path is active for this app, ask the user to complete the login manually.',
      }
      if (credential_type === 'website') {
        payload.url = metadata.url ?? ''
      }
      return successToToolResult(payload)
    },
  }
}
