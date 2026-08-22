/**
 * Pure helper functions for the Chat store.
 *
 * Extracted from useChatStore.ts — these are stateless utilities
 * used by the store and the stream message handler.
 */

import i18n from '@/i18n'
import { showBillingErrorToast } from '@/lib/billingErrorHandler'
import { BILLING_ERROR_CATEGORIES } from '@utils/chat/billingErrorCategories'
import { getShellFailureReason } from '@utils/chat/shellFailureReason'

/**
 * 剥 `<tool_output>` fence，还原结构化 output 给前端 UI 消费。
 *
 * 背景：PRD 08 W12（L-23）后，本地 4 件套读工具（read_file / grep_search /
 * glob_search / semantic_search）+ 所有非只读工具的 result.content 在
 * runtime 端被 `wrapInToolOutputFence` 包成 `<tool_output ...>{body}</tool_output>`。
 * fence 是给 LLM 看的视觉边界（FR-09 prompt injection 防御），UI 不应感知。
 *
 * 这个函数：
 * - 不是 fence 字符串：原值不动返回（向后兼容 think / todo_write / list_directory
 *   等不走 fence 的工具，以及结构化 object output 的旧路径）
 * - 是 fence 字符串但 body 是 JSON：解析为 object 返回（前端 card extractor
 *   就能拿到 `{success, content, path}` 这类结构）
 * - 是 fence 字符串但 body 不是 JSON：返回 body 字符串（人类可读纯文本）
 *
 * fence 形态参考 `packages/agent-runtime/src/engine/tool-output-sanitizer.ts`。
 */
const TOOL_OUTPUT_FENCE_RE = /^<tool_output\b[^>]*>\n([\s\S]*?)\n<\/tool_output>$/
const TOOL_OUTPUT_FENCE_HEAD_RE = /^<tool_output\b([^>]*)>/
const TOOL_OUTPUT_SUSPICIOUS_ATTR_RE = /\bsuspicious\s*=\s*["']true["']/

/**
 * 提取 fence 头部的 `suspicious="true"` 标记。
 *
 * 背景：PRD 08 W12 的 FR-09 防护链路下，`tool-output-sanitizer.ts`
 * `scanForInjectionPatterns` 命中注入模式时会在 fence 加 `suspicious="true"`
 * 属性，并通过 `system_notice` telemetry 通知 host。这条信号目前对 LLM
 * 是可读的（fence head 在 prompt 里），但对用户不可见——我们需要在工具
 * 卡片里显示一个轻量 badge 让用户知道该输出已被注入扫描标记。
 *
 * 这个 helper 单独存在的原因：
 *   - `unwrapToolOutputFence` 已被 9 个测试钉死返回 unwrap 后的内容（剥
 *     fence 还原 body），为不打破契约这里独立成一个 metadata 抽取函数
 *   - 不强求先调 `unwrapToolOutputFence`：badge 的可见性应在工具结果"成
 *     功"也要展示（攻击者可以制造 success=true + suspicious 注入文本的
 *     混合 payload，sanitizer 会照样标记 suspicious=true，UI 不能因为
 *     output.success=true 就吞掉这个信号）
 *
 * 输入非字符串 / 非 fence 字符串 / fence 但无 suspicious attr → 返回
 * false。坏 fence（缺闭标签等）也返回 false 不抛错——前端容错优先。
 */
export function extractToolOutputFenceSuspicious(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed.startsWith('<tool_output')) return false
  const head = trimmed.match(TOOL_OUTPUT_FENCE_HEAD_RE)
  if (!head) return false
  return TOOL_OUTPUT_SUSPICIOUS_ATTR_RE.test(head[1])
}

export function unwrapToolOutputFence(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()

  // Path A — fence-wrapped string（runtime 实时 stream 路径 + 历史 content_blocks_json
  // 数据，2026-05-10 Bug 3 修复前的存量数据形态）。
  if (trimmed.startsWith('<tool_output')) {
    const m = trimmed.match(TOOL_OUTPUT_FENCE_RE)
    if (!m) return value
    const body = m[1]
    if (!body) return ''
    // body 可能是 JSON.stringify 的 object（绝大多数 action-tools 路径），
    // 也可能是 plain text（极少见，比如 raw command stdout），或者是
    // attachSchemaWarning 的 textEnvelope 产物 `{"result": "...", "_schema_validation_warning": ...}`。
    const head = body.trimStart()[0]
    if (head !== '{' && head !== '[') return body
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }

  // Path B — plain JSON string（2026-05-10 Bug 3 修复后的新 content_blocks_json 形态）。
  // runtime 端 blocks-collector.ts 已 `stripToolOutputFence`，持久化的 block.output
  // 是干净的 JSON string；hydrate 路径需要继续 deserialize 成对象，
  // 才能让 FileReadCard / extractFileRead 等下游消费者拿到 `.content` 字段。
  // 设计参见 packages/agent-runtime/src/engine/tool-output-sanitizer.ts:stripToolOutputFence
  // 上方注释——iOS / Android 客户端的 step.output 是 String?（Codable 强约束），
  // 它们各自做 JSON 解析；Electron renderer 的 toolEvent.output 是 unknown，
  // 在 unwrap 这里集中做 JSON.parse 让上层卡片代码无需各自识别 string vs object。
  const head = trimmed[0]
  if (head === '{' || head === '[') {
    try {
      return JSON.parse(trimmed)
    } catch {
      // 解不出来就 passthrough，兼容 plain string output（错误文案 / shell stdout 等）
      return value
    }
  }

  return value
}

export function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input) return ''
  try {
    if (typeof input !== 'object') return String(input).slice(0, 80)
    const obj = input as Record<string, unknown>

    const kwargs = typeof obj.kwargs === 'object' && obj.kwargs ? obj.kwargs as Record<string, unknown> : null
    const args = kwargs || obj
    if (!args || typeof args !== 'object') return String(input).slice(0, 80)

    if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'delete_file') {
      return String((args as Record<string, unknown>).path || '').split('/').pop() || ''
    }
    if (toolName === 'edit_file') {
      return String((args as Record<string, unknown>).path || '').split('/').pop() || ''
    }
    if (toolName === 'grep_search') {
      return `/${(args as Record<string, unknown>).pattern || ''}/`
    }
    if (toolName === 'glob_search') return String((args as Record<string, unknown>).glob_pattern || '')
    if (toolName === 'semantic_search') {
      const q = String((args as Record<string, unknown>).query || '')
      return q.length > 60 ? q.slice(0, 60) + '...' : q
    }
    if (toolName === 'run_terminal_command' || toolName === 'terminal_execute' || toolName === 'execute_in_terminal') {
      const cmd = String((args as Record<string, unknown>).command || '')
      return cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd
    }

    if (toolName.includes('sql') || toolName.includes('query')) {
      const a = args as Record<string, unknown>
      const sql = String(a.sql || a.query || '')
      return sql.length > 100 ? sql.slice(0, 100) + '...' : sql
    }

    const a = args as Record<string, unknown>
    const keys = Object.keys(a).filter(k => !k.startsWith('_')).slice(0, 3)
    return keys.map(k => `${k}: ${String(a[k]).slice(0, 30)}`).join(', ')
  } catch {
    return ''
  }
}

export function summarizeToolOutput(toolName: string, output: unknown): string {
  if (!output) return ''
  try {
    if (typeof output === 'string') {
      return output.length > 120 ? output.slice(0, 120) + '...' : output
    }
    if (typeof output !== 'object') return String(output).slice(0, 120)

    const obj = output as Record<string, unknown>
    const data = typeof obj.data === 'object' && obj.data ? obj.data as Record<string, unknown> : null
    const success = obj.success

    if (toolName === 'edit_file' && data && 'replacements' in data) {
      return `✓ 替换了 ${data.replacements} 处`
    }
    if (toolName === 'write_file' && data?.path) {
      return `✓ ${String(data.path).split('/').pop()}`
    }
    // T2 final R3：glob_search adapter wrapper 改输出 `{output: string, total_files: number}` 后
    // `data.files` 数组永远空 → 摘要总显示「无匹配」假数据。改读 `total_files` 真值，兼容旧 `files`。
    if (toolName === 'glob_search' && data) {
      const total = typeof data.total_files === 'number'
        ? (data.total_files as number)
        : Array.isArray(data.files)
          ? (data.files as unknown[]).length
          : null
      if (total !== null) {
        return total > 0 ? `找到 ${total} 个文件` : '无文件'
      }
    }
    if (toolName === 'grep_search' && data && 'output' in data) {
      const o = String(data.output).trim()
      // T2 final R3：识别 0 匹配固定文案 + count 双段复合（adapter 跟常见 agent 工具 对齐）
      if (
        o === 'No matches found.' ||
        o === 'No files found.' ||
        o === 'Found 0 total occurrences across 0 files.' ||
        o.split('\n').map((l) => l.trim()).filter(Boolean).every(
          (line) =>
            line === 'No matches found.' ||
            line === 'Found 0 total occurrences across 0 files.',
        )
      ) {
        return '无匹配'
      }
      // T2 follow-up B3：B3 加了 `Found N files` 汇总头——直接从汇总头取文件数最准
      const foundMatch = o.match(/^Found (\d+) files?/)
      if (foundMatch) {
        const n = parseInt(foundMatch[1], 10)
        return n > 0 ? `${n} 个文件` : '无匹配'
      }
      const total =
        typeof data.total_matches === 'number'
          ? (data.total_matches as number)
          : typeof data.total_files === 'number'
            ? (data.total_files as number)
            : o.split('\n').filter(Boolean).length
      return total > 0 ? `${total} 行匹配` : '无匹配'
    }
    if (toolName === 'semantic_search') {
      return '语义搜索已迁移至后端，请使用 grep_search/glob_search'
    }
    const terminalData = data ?? obj
    if ((toolName === 'run_terminal_command' || toolName === 'terminal_execute' || toolName === 'execute_in_terminal') && ('exit_code' in terminalData || 'exitCode' in terminalData || 'output' in terminalData || 'stdout' in terminalData)) {
      const rawCode = terminalData.exit_code ?? terminalData.exitCode
      const code = rawCode == null ? null : Number(rawCode)
      const hasCode = code != null && Number.isFinite(code)
      const stdout = String(terminalData.output || terminalData.stdout || '').trim()
      const statusStr = String(terminalData.status ?? '')
      const exitedBy = String(terminalData.exited_by ?? '')
      const translateChat = (key: string, options?: Record<string, unknown>): string => {
        const namespacedKey = `chat:${key}`
        const translated = String(i18n.t(namespacedKey, options))
        return translated === namespacedKey || translated === key
          ? String(options?.defaultValue ?? key)
          : translated
      }
      // 退出码非零 ≠ 失败：以执行层结构化终态为准（status / exited_by，见 shell.ts:1704 与
      // TerminalCard.deriveStatusFromStructuredFields）。只有 status:failed / exec_failure /
      // signal 才算失败；normal_exit / completed 即正常完成（含 du、grep 这类非零业务码）。
      const isFailure =
        statusStr === 'failed' ||
        exitedBy === 'exec_failure' ||
        exitedBy === 'signal' ||
        terminalData.success === false // runtime buildToolErrorResult 真失败信号（spawn/受限/abort）
      const isCompleted = statusStr === 'completed' || exitedBy === 'normal_exit' || hasCode
      const reason = isFailure && hasCode ? getShellFailureReason(translateChat, code) : null
      const prefix = isFailure ? `✗ ${reason ?? '失败'}` : isCompleted ? '✓' : '⏳'
      const preview = stdout.length > 80 ? stdout.slice(0, 80) + '...' : stdout
      return preview ? `${prefix} ${preview}` : prefix
    }

    if (success === false) {
      const errorVal = obj.error
      const errMsg = typeof errorVal === 'object' && errorVal ? (errorVal as Record<string, unknown>).message : errorVal
      return `✗ ${errMsg || '失败'}`
    }
    if (success === true) return '✓ 成功'
    if (Array.isArray(data)) return `返回 ${data.length} 条结果`
    if ('rows' in obj && Array.isArray(obj.rows)) return `查询到 ${(obj.rows as unknown[]).length} 行`

    const str = JSON.stringify(output)
    return str.length > 120 ? str.slice(0, 120) + '...' : str
  } catch {
    return ''
  }
}

export type TodoToolAction = 'open' | 'add' | 'update' | 'remove' | 'close'

/** 从 todo 工具 input 解析 action 入参。权威数据在 tool_use args。 */
export function extractTodoActionFromToolInput(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  const kwargs = typeof obj.kwargs === 'object' && obj.kwargs ? (obj.kwargs as Record<string, unknown>) : null
  const args = kwargs ?? obj
  const action = args.action
  if (
    action !== 'open' &&
    action !== 'add' &&
    action !== 'update' &&
    action !== 'remove' &&
    action !== 'close'
  ) {
    return null
  }
  return args
}

export function isTodoInitInputPayload(input: unknown): boolean {
  const args = extractTodoActionFromToolInput(input)
  if (!args || args.action !== 'open') return false
  return Array.isArray(args.items) && (args.items as unknown[]).length > 0
}

export function shouldHideTodoInitEvent(toolName: string, phase: string, payload: unknown): boolean {
  if (toolName !== 'todo') return false
  if (!payload || typeof payload !== 'object') return false
  const obj = payload as Record<string, unknown>
  if (phase === 'start') return isTodoInitInputPayload(obj.input)
  if (phase === 'end') return isTodoInitInputPayload(obj.input)
  return false
}

export const CURRENT_TOOL_NAME_MAP: Record<string, string> = {
  sql_query: 'SQL 查询',
  sql_execute: 'SQL 执行',
  sql_catalog: '表结构查询',
  python_repl: 'Python 执行',
  web_search: '网页搜索',
  browser_navigate: '浏览器导航',
  read_skill: '读取 Skill',
  terminal_execute: '终端执行', // legacy compat
  execute_in_terminal: '终端执行',
  write_to_terminal: '终端写入',
  read_terminal_output: '读取终端',
  list_terminal_sessions: '终端列表',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  delete_file: '删除文件',
  grep_search: '代码搜索',
  glob_search: '文件查找',
  semantic_search: '语义搜索（迁移中）',
}

/**
 * Historical transcript display only.
 *
 * Retired tool names are not current capabilities; this map only keeps old
 * persisted conversations readable without teaching the UI a second live tool
 * registry.
 */
export const HISTORICAL_TRANSCRIPT_TOOL_NAME_MAP: Record<string, string> = {
  bash: '历史命令执行',
  read_file: '历史读取文件',
  write_file: '历史写入文件',
  delete_file: '历史删除文件',
  web_fetch: '历史网页抓取',
}

export const TOOL_NAME_MAP: Record<string, string> = {
  ...CURRENT_TOOL_NAME_MAP,
  ...HISTORICAL_TRANSCRIPT_TOOL_NAME_MAP,
}

export function humanizeToolName(toolName: string): string {
  const fallback = TOOL_NAME_MAP[toolName]
    ?? i18n.t('chat:toolName.unknown', { defaultValue: 'Tool' })
  return i18n.t(`chat:toolName.${toolName}`, { defaultValue: fallback })
}

// ---------------------------------------------------------------------------
// Shared error category → hint / billing-toast mapping
// ---------------------------------------------------------------------------

const BILLING_ERROR_MAP: Record<string, Parameters<typeof showBillingErrorToast>[0]> = {
  rate_limit: 'RATE_LIMITED',
  organization_insufficient_credits: 'ORGANIZATION_INSUFFICIENT_CREDITS',
  insufficient_credits: 'INSUFFICIENT_CREDITS',
  quota: 'QUOTA_EXCEEDED',
  conversation_quota_exceeded: 'CONVERSATION_QUOTA_EXCEEDED',
  budget_exceeded: 'BUDGET_EXCEEDED',
  member_budget: 'MEMBER_MONTHLY_LIMIT',
  member_monthly_limit: 'MEMBER_MONTHLY_LIMIT',
  member_daily_limit: 'MEMBER_DAILY_LIMIT',
  member_model_restricted: 'MEMBER_MODEL_RESTRICTED',
}

const ERROR_HINT_KEYS: Record<string, string> = {
  rate_limit: 'chat:errors.rateLimitHint',
  budget_exceeded: 'chat:errors.budgetExceeded',
  organization_insufficient_credits: 'chat:errors.organizationInsufficientCredits',
  insufficient_credits: 'chat:errors.insufficientCredits',
  quota: 'chat:errors.quotaExceeded',
  conversation_quota_exceeded: 'chat:errors.conversationQuotaExceeded',
  model_unavailable: 'chat:errors.modelUnavailableHint',
  context_too_long: 'chat:errors.contextTooLongHint',
  provider_overloaded: 'chat:errors.providerOverloadedHint',
  owner_execution_device_unavailable: 'chat:errors.ownerExecutionUnavailableHint',
  member_budget: 'chat:errors.memberMonthlyLimit',
  member_monthly_limit: 'chat:errors.memberMonthlyLimit',
  member_daily_limit: 'chat:errors.memberDailyLimit',
  member_model_restricted: 'chat:errors.memberModelRestricted',
  process_timeout: 'chat:errors.processTimeoutHint',
  resume_failed: 'chat:errors.resumeFailedHint',
}

/**
 * Show a billing error toast for a known error category. No-op for unknown categories.
 */
export function showBillingErrorByCategory(category: string): void {
  // 对话内失败以 BillingErrorCard 气泡为权威出口（信息最全、带角色感知 CTA）：
  // 该 category 有气泡时不再叠加右上角 toast，避免同一次失败重复提示。无对应
  // 气泡的 category（如 rate_limit / conversation_quota_exceeded）仍弹 toast 兜底。
  if (BILLING_ERROR_CATEGORIES.has(category)) return
  const billingCode = BILLING_ERROR_MAP[category]
  if (billingCode) showBillingErrorToast(billingCode)
}

/**
 * Get a user-facing hint string for a known error category.
 * Returns undefined for unknown categories (caller should fall back to generic message).
 */
export function getErrorHint(category: string): string | undefined {
  const key = ERROR_HINT_KEYS[category]
  return key ? i18n.t(key) : undefined
}

/**
 * Build a Record<category, hintString> for all known categories.
 * Lazily evaluated so i18n is initialized before access.
 */
export function buildErrorHintMap(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [cat, key] of Object.entries(ERROR_HINT_KEYS)) {
    map[cat] = i18n.t(key)
  }
  return map
}

// ---------------------------------------------------------------------------
// Payload accessor helpers
// ---------------------------------------------------------------------------

export type Payload = Record<string, unknown>
export const payloadStr = (v: unknown, fallback = ''): string => typeof v === 'string' ? v : fallback
export const payloadStrOpt = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined
export const payloadStrNull = (v: unknown): string | null => typeof v === 'string' ? v : null
export const payloadNum = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined
export const payloadBool = (v: unknown): boolean | undefined => typeof v === 'boolean' ? v : undefined
