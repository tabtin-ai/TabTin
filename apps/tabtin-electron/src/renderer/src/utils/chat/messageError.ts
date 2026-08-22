import type { ChatMessage } from '@tabtin/chat-client'

type MessageLike = Pick<ChatMessage, 'metadata' | 'content_blocks_json' | 'error_info_json'>

type MessageBlock = Record<string, unknown>

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function normalizeErrorClass(
  errorClass: string | undefined,
  errorMessage: string | undefined,
): string | undefined {
  if (
    errorClass === 'LLM_ERROR'
    && errorMessage
    && /订阅套餐/.test(errorMessage)
    && /ChatGPT/.test(errorMessage)
    && /Codex/.test(errorMessage)
  ) {
    return 'LLM_CODEX_LOGIN_REQUIRED'
  }
  // ：火山 / 豆包 burst 英文原文若仍以 LLM_ERROR 落库，升格为限流卡。
  if (
    errorClass === 'LLM_ERROR'
    && errorMessage
    && /request burst|system protection triggered|slow down traffic growth/i.test(errorMessage)
  ) {
    return 'RATE_LIMITED'
  }
  return errorClass
}

function asBlockList(blocks: unknown): MessageBlock[] {
  return Array.isArray(blocks)
    ? blocks.filter((block): block is MessageBlock => !!block && typeof block === 'object')
    : []
}

function findLatestMetadataBlock(blocks: MessageBlock[]): MessageBlock | undefined {
  return [...blocks].reverse().find(block => block.type === 'metadata')
}

const CATEGORY_TO_ERROR_CLASS: Record<string, string> = {
  llm_provider_error: 'LLM_PROVIDER_ERROR',
  context_overflow: 'CONTEXT_OVERFLOW',
  tool_exec: 'TOOL_EXECUTION_ERROR',
  billing: 'BUDGET_EXHAUSTED',
  rate_limited: 'RATE_LIMITED',
  // agent-runtime ClassifiedError.category（ burst 限流）
  rate_limit: 'RATE_LIMITED',
  // PRD-04 Wave 5 三次收尾任务 2b：abort 路径兜底——本地 runtime / ACP Agent
  // 如果 metadata 缺 errorClass，按 errorCategory='aborted' 映射到 'ABORT'，
  // 让 errorClassMap 能画出"已中止 + 重试"卡片。
  aborted: 'ABORT',
}

/** wire / 落库 error_info.category → UI errorCategory（与 metadata 口径对齐）。 */
const ERROR_INFO_CATEGORY_TO_UI: Record<string, string> = {
  aborted: 'aborted',
  timeout: 'timeout',
  protocol_error: 'protocol_error',
  runtime_failed: 'runtime_failed',
  // 保持 budget_exceeded：BillingErrorCard 与 ErrorClassCard 分流靠 errorClass，
  // 勿并进泛化 billing（否则迭代/token 预算墙会误走计费卡）。
  budget_exceeded: 'budget_exceeded',
}

function readErrorInfoJson(message: MessageLike): Record<string, unknown> | undefined {
  const raw = message.error_info_json
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

/** 与 DONE metadata.errorExtras / pickErrorExtras 对齐的诊断字段。 */
const ERROR_EXTRA_KEYS = [
  'stage',
  'reason',
  'host',
  'failed_count',
  'total_count',
  'error_type',
  'backend_error_type',
  'error_category',
  'topup_reason',
] as const

function pickErrorExtras(source: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined
  const nested = (source.error_extras ?? source.errorExtras) as Record<string, unknown> | undefined
  const fromNested = nested
    && typeof nested === 'object'
    && !Array.isArray(nested)
    ? nested
    : undefined
  const result: Record<string, unknown> = {}
  for (const key of ERROR_EXTRA_KEYS) {
    const value = source[key] ?? fromNested?.[key]
    if (value !== undefined) result[key] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function resolveMessageErrorState(message: MessageLike): {
  errorCategory?: string
  errorMessage?: string
  errorClass?: string
  suggestedAction?: string
  isErrorMessage?: boolean
  /**
   * Wave 3：后端透传的结构化诊断字段（stage / reason / host / failed_count
   * 等）。MessageBubble 把它传给 `getErrorClassInfo`，用 stage 路由到
   * "图片下载失败 / 模型能力不匹配"等专属卡片标题。
   */
  errorExtras?: Record<string, unknown>
} {
  const meta = (message.metadata ?? {}) as Record<string, unknown>
  // ：充值后客户端消警——对话卡与侧栏失败 `!` 不再展示余额不足态
  if (meta.billingErrorResolved === true) {
    return {}
  }

  // ：终止卡正典源是 message_stop → error_info_json（与正常消息同链路）。
  // metadata.errorClass 仍作活态 DONE 兼容；二者并存时优先 error_info_json。
  const info = readErrorInfoJson(message)
  const infoErrorClass = readNonEmptyString(info?.error_class)
  const infoErrorMessage = readNonEmptyString(info?.error_message)
  const infoSuggestedAction = readNonEmptyString(info?.suggested_action)
  const infoCategoryRaw = readNonEmptyString(info?.category)
  const infoErrorCategory = infoCategoryRaw
    ? (ERROR_INFO_CATEGORY_TO_UI[infoCategoryRaw] ?? infoCategoryRaw)
    : undefined

  const metaErrorMessage = readNonEmptyString(meta.errorMessage ?? meta.error_message)
  const metaErrorCategory = readNonEmptyString(meta.errorCategory ?? meta.error_category)
  const metaErrorClass = readNonEmptyString(meta.errorClass ?? meta.error_class)
  const metaSuggestedAction = readNonEmptyString(meta.suggestedAction ?? meta.suggested_action)
  const metaErrorExtras = pickErrorExtras(
    (meta.errorExtras ?? meta.error_extras) as Record<string, unknown> | undefined,
  ) ?? pickErrorExtras(meta)
  const infoErrorExtras = pickErrorExtras(info)
  const isErrorMessage = meta.isErrorMessage === true
    || (!!infoErrorClass && infoErrorClass !== 'ABORT')

  const rawErrorClass = infoErrorClass
    || metaErrorClass
    || (isErrorMessage && (infoErrorCategory || metaErrorCategory)
      ? CATEGORY_TO_ERROR_CLASS[infoErrorCategory || metaErrorCategory || '']
      : undefined)
  const errorCategory = infoErrorCategory || metaErrorCategory
  const errorMessage = infoErrorMessage || metaErrorMessage
  const errorClass = normalizeErrorClass(rawErrorClass, errorMessage)
  const suggestedAction = infoSuggestedAction || metaSuggestedAction
  // error_info_json 优先（切会话正典）；metadata 活态兼容。
  const validExtras = infoErrorExtras ?? metaErrorExtras

  if (errorMessage || errorCategory || errorClass || isErrorMessage) {
    // 只在有结构化 extras 时才把字段附加到结果上——避免给所有错误消息无脑加
    // `errorExtras: undefined` 字段，那样会破坏 messageError.test.ts 的旧 toEqual
    // 断言（用 toEqual 对比的对象语义是"未声明 == undefined"），同时让纯 metadata
    // 错误（device_offline 等）的 result 保持精简。
    return {
      errorCategory,
      errorMessage,
      errorClass,
      suggestedAction,
      isErrorMessage,
      ...(validExtras ? { errorExtras: validExtras } : {}),
    }
  }

  const blocks = asBlockList(message.content_blocks_json)
  const metadataBlock = findLatestMetadataBlock(blocks)
  const blockErrorMessage = readNonEmptyString(metadataBlock?.error_message)
  const blockErrorCategory = readNonEmptyString(metadataBlock?.error_category)

  return {
    errorCategory: blockErrorCategory,
    errorMessage: blockErrorMessage,
  }
}
