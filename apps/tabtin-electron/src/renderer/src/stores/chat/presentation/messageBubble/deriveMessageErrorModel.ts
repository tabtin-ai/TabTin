import type { ChatMessage } from '@tabtin/chat-client'
import { BILLING_ERROR_CATEGORIES } from '@utils/chat/billingErrorCategories'
import { getErrorClassInfo, type ErrorClassInfo } from '@utils/chat/messageErrorClassMap'
import type { Translate } from './messageBubbleModelTypes'
import { resolveMessageErrorState } from '@utils/chat/messageError'

export interface MessageErrorState {
  errorCategory?: string
  errorMessage?: string
  errorClass?: string
  suggestedAction?: string
  isErrorMessage: boolean
  errorExtras?: Record<string, unknown>
}

export interface DeriveMessageErrorModelInput {
  message: ChatMessage
  displayContent: string
  isUser: boolean
  isInterrupted: boolean
  t: Translate
  /**
   * 错误卡是当前失败轮的动作入口，不是历史印章。
   * 缺省视为「仍是最后一条助手消息」，兼容只测映射的单测。
   */
  isLastAssistantMsg?: boolean
  /** 会话已在跑下一轮（含错误卡续跑）时，当前失败卡应收起。 */
  isStreaming?: boolean
}

export interface MessageErrorDerivedModel {
  errorMessage?: string
  errorClass?: string
  errorClassInfo: ErrorClassInfo | null
  hasAbortErrorCard: boolean
  /** ：已有终止卡时压制 block「已中断/内容被截断」，避免双提示。 */
  suppressBlockPartialReason: boolean
  shouldRenderInterruptedBadge: boolean
  errorClassSkipContent: boolean
  isBillingError: boolean
}

/** 终止卡已覆盖语义时，不再叠 block partial 文案。 */
const SUPPRESS_PARTIAL_ERROR_CLASSES = new Set([
  'ABORT',
  'text_loop_terminated',
  'tool_loop_terminated',
  'MAX_CREDITS_EXCEEDED',
  'MAX_TURNS_EXCEEDED',
  'iteration_budget_exhausted',
  'token_budget_exhausted',
  'BUDGET_EXHAUSTED',
])

/**
 * 有专用 ErrorClassCard 的运行/配额墙 / 结算后计费失败：即使 errorCategory
 * 落在 billing 集合，也优先 ErrorClassCard，避免被 BillingErrorCard 整卡替换
 * （ A′；#8296 结算后需保留已流式写出的正文）。
 */
const PREFER_ERROR_CLASS_OVER_BILLING = new Set([
  'MAX_CREDITS_EXCEEDED',
  'MAX_TURNS_EXCEEDED',
  'iteration_budget_exhausted',
  'token_budget_exhausted',
  'BUDGET_EXHAUSTED',
  'LLM_BILLING_ERROR',
])

/** 信封层 runtime_failed 等不能盖住结算真因（organization_insufficient_credits…）。 */
const NON_BILLING_ENVELOPE_CATEGORIES = new Set([
  'runtime_failed',
  'server_error',
  'protocol_error',
  'timeout',
  'aborted',
])

function mergeErrorCategoryIntoExtras(
  errorCategory: string | undefined,
  errorExtras: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = { ...(errorExtras ?? {}) }
  const hasStructuredCategoryKey = ['error_category', 'error_type', 'backend_error_type']
    .some((key) => {
      const value = extras[key]
      return typeof value === 'string'
        && value.trim().length > 0
        && !NON_BILLING_ENVELOPE_CATEGORIES.has(value.trim())
    })
  if (!hasStructuredCategoryKey && errorCategory) {
    extras.error_category = errorCategory
  }
  return Object.keys(extras).length > 0 ? extras : undefined
}

export function resolveMessageBubbleErrorState(message: ChatMessage): MessageErrorState {
  const {
    errorCategory,
    errorMessage,
    errorClass,
    suggestedAction,
    isErrorMessage,
    errorExtras,
  } = resolveMessageErrorState(message)

  return {
    errorCategory,
    errorMessage,
    errorClass,
    suggestedAction,
    isErrorMessage: isErrorMessage ?? false,
    errorExtras,
  }
}

function deriveErrorClassSkipContent(input: {
  displayContent: string
  errorMessage?: string
  suggestedAction?: string
  errorClassInfo: ErrorClassInfo | null
  messageContent?: string | null
}): boolean {
  const {
    displayContent,
    errorMessage,
    suggestedAction,
    errorClassInfo,
    messageContent,
  } = input

  if (!errorClassInfo || !displayContent) return false

  const trimmedDisplay = displayContent.trim()
  const trimmedMessage = (messageContent ?? '').trim()

  return trimmedDisplay === (errorMessage ?? '').trim()
    || trimmedDisplay === (suggestedAction ?? '').trim()
    || trimmedDisplay === errorClassInfo.suggestion.trim()
    || trimmedMessage === (errorMessage ?? '').trim()
    || trimmedMessage === (suggestedAction ?? '').trim()
    || /^\[\w+]\s/.test(messageContent ?? '')
}

export function deriveMessageErrorModel(input: DeriveMessageErrorModelInput): MessageErrorDerivedModel {
  const {
    message,
    displayContent,
    isUser,
    isInterrupted,
    t,
    isLastAssistantMsg = true,
    isStreaming = false,
  } = input
  const errorState = resolveMessageBubbleErrorState(message)
  const {
    errorCategory,
    errorMessage,
    errorClass,
    suggestedAction,
    errorExtras,
  } = errorState

  // 把消息 category 并进 extras，供 LLM_ERROR / LLM_BILLING_ERROR 恢复真实语义。
  // 勿用信封 category 覆盖 extras 里已有的更具体 error_type。
  const errorClassExtras = mergeErrorCategoryIntoExtras(errorCategory, errorExtras)
  const mappedErrorClassInfo = getErrorClassInfo(
    errorClass,
    suggestedAction,
    t,
    errorClassExtras,
    errorMessage,
  )
  // ：用户主动停止（ABORT）——无 ErrorClassCard、无 runtime 英文兜底文案，
  // 只保留灰色「已中断」徽标；异常终止（硬停 / 预算墙）才出卡。
  const isUserAbort = !!mappedErrorClassInfo && errorClass === 'ABORT'
  const isCurrentTerminalFailure = !isUser && isLastAssistantMsg && !isStreaming
  const errorClassInfo = isUserAbort || !isCurrentTerminalFailure ? null : mappedErrorClassInfo
  const resolvedErrorMessage = isUserAbort || !isCurrentTerminalFailure ? undefined : errorMessage
  const suppressBlockPartialReason = !!errorClass
    && SUPPRESS_PARTIAL_ERROR_CLASSES.has(errorClass)
  // 有终止卡时不叠徽标；ABORT 无卡，因此徽标照常显示。
  const shouldRenderInterruptedBadge = isInterrupted && !errorClassInfo
  const errorClassSkipContent = deriveErrorClassSkipContent({
    displayContent,
    errorMessage: resolvedErrorMessage,
    suggestedAction,
    errorClassInfo,
    messageContent: message.content,
  })
  const isBillingError = isCurrentTerminalFailure
    && !!errorCategory
    && BILLING_ERROR_CATEGORIES.has(errorCategory)
    && !(errorClass && PREFER_ERROR_CLASS_OVER_BILLING.has(errorClass))

  return {
    errorMessage: resolvedErrorMessage,
    errorClass,
    errorClassInfo,
    // 历史字段名：表示「用户主动 ABORT」，不再表示「要渲染 ABORT 卡」。
    hasAbortErrorCard: isUserAbort,
    suppressBlockPartialReason,
    shouldRenderInterruptedBadge,
    errorClassSkipContent,
    isBillingError,
  }
}
