/**
 * ：全部终止 / 异常 errorClass 的气泡呈现矩阵。
 * 覆盖两条源：活态 metadata（DONE）与正典 error_info_json（message_stop 落库）。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { deriveMessageErrorModel } from '@stores/chat/presentation/messageBubble/deriveMessageErrorModel'
import { getErrorClassInfo } from '@utils/chat/messageErrorClassMap'

const t = (key: string) => key

function deriveFromMetadata(meta: Record<string, unknown>, isInterrupted = false) {
  const message = {
    id: 'ai-1',
    role: 'assistant',
    content: '半截',
    metadata: meta,
    created_at: '2026-07-20T00:00:00.000Z',
  } as ChatMessage

  return deriveMessageErrorModel({
    message,
    displayContent: '半截',
    isUser: false,
    isInterrupted,
    t,
  })
}

function deriveFromErrorInfo(
  errorInfo: Record<string, unknown>,
  isInterrupted = false,
) {
  const message = {
    id: 'ai-1',
    role: 'assistant',
    content: '半截',
    metadata: {},
    error_info_json: errorInfo,
    created_at: '2026-07-20T00:00:00.000Z',
  } as ChatMessage

  return deriveMessageErrorModel({
    message,
    displayContent: '半截',
    isUser: false,
    isInterrupted,
    t,
  })
}

/** 与 live RUN_TERMINATION_LIVE_CASES 对齐的全量异常类。 */
const CARD_CASES = [
  ['text_loop_terminated', 'errorClass.text_loop_terminated.title', 'warning'],
  ['tool_loop_terminated', 'errorClass.tool_loop_terminated.title', 'warning'],
  ['MAX_CREDITS_EXCEEDED', 'errorClass.MAX_CREDITS_EXCEEDED.title', 'warning'],
  ['LLM_PROVIDER_ERROR', 'errorClass.LLM_PROVIDER_ERROR.title', 'error'],
  ['LLM_ERROR', 'errorClass.LLM_ERROR.title', 'warning'],
  ['NETWORK_ERROR', 'errorClass.NETWORK_ERROR.title', 'warning'],
  ['CONTEXT_OVERFLOW', 'errorClass.CONTEXT_OVERFLOW.title', 'error'],
  ['TOOL_EXECUTION_ERROR', 'errorClass.TOOL_EXECUTION_ERROR.title', 'error'],
  ['iteration_budget_exhausted', 'errorClass.iteration_budget_exhausted.title', 'warning'],
  ['token_budget_exhausted', 'errorClass.token_budget_exhausted.title', 'warning'],
  ['BUDGET_EXHAUSTED', 'errorClass.BUDGET_EXHAUSTED.title', 'error'],
  ['RATE_LIMITED', 'errorClass.RATE_LIMITED.title', 'warning'],
  ['INTERNAL', 'errorClass.INTERNAL.title', 'error'],
  ['LLM_KEY_EXHAUSTED', 'errorClass.LLM_KEY_EXHAUSTED.title', 'error'],
] as const

describe('deriveMessageErrorModel · 终止呈现矩阵 ', () => {
  describe('metadata（DONE 活态）', () => {
    it('ABORT：无卡、无 Run aborted 文案、有灰色徽标', () => {
      const model = deriveFromMetadata(
        { errorClass: 'ABORT', aborted: true, errorMessage: 'Run aborted by user.' },
        true,
      )
      expect(model.errorClassInfo).toBeNull()
      expect(model.errorMessage).toBeUndefined()
      expect(model.shouldRenderInterruptedBadge).toBe(true)
    })

    it.each(CARD_CASES)('%s → 出卡且非徽标路径', (errorClass, titleKey, severity) => {
      const model = deriveFromMetadata({ errorClass, isErrorMessage: true }, false)
      expect(model.errorClassInfo).not.toBeNull()
      expect(model.errorClassInfo!.title).toBe(titleKey)
      expect(model.errorClassInfo!.severity).toBe(severity)
      expect(model.shouldRenderInterruptedBadge).toBe(false)
      expect(model.hasAbortErrorCard).toBe(false)
    })

    it('LLM_ERROR + capability_gate → 模型能力不匹配卡', () => {
      const model = deriveFromMetadata({
        errorClass: 'LLM_ERROR',
        suggestedAction: 'switch_model',
        errorExtras: { stage: 'capability_gate' },
      })
      expect(model.errorClassInfo!.title).toBe('errorClass.LLM_CAPABILITY_GATE.title')
    })

    it('文档数量超限 → 展示后端返回的具体数量，不提示切换模型', () => {
      const errorMessage = '当前模型单次最多上传 1 个文档，本次共上传 2 个。请减少文档后重试。'
      const model = deriveFromMetadata({
        errorClass: 'LLM_ERROR',
        errorMessage,
        suggestedAction: 'switch_model',
        errorExtras: {
          stage: 'capability_gate',
          error_type: 'too_many_documents',
        },
      })

      expect(model.errorClassInfo).toMatchObject({
        title: 'errorClass.LLM_DOCUMENT_LIMIT.title',
        suggestion: errorMessage,
        suggestedAction: undefined,
      })
    })

    it('LLM_ERROR + image_fetch → 图片下载失败卡', () => {
      const model = deriveFromMetadata({
        errorClass: 'LLM_ERROR',
        errorExtras: { stage: 'image_fetch' },
      })
      expect(model.errorClassInfo!.title).toBe('errorClass.LLM_IMAGE_FETCH_FAILED.title')
    })

    it('LLM_ERROR + network category → 网络异常卡', () => {
      const model = deriveFromMetadata({
        errorClass: 'LLM_ERROR',
        errorExtras: { error_category: 'network_error' },
      })
      expect(model.errorClassInfo!.title).toBe('errorClass.NETWORK_ERROR.title')
    })

    it('LLM_ERROR + backend_error_type=upstream_rate_limited → 限流卡', () => {
      const model = deriveFromMetadata({
        errorClass: 'LLM_ERROR',
        errorExtras: { backend_error_type: 'upstream_rate_limited' },
      })
      expect(model.errorClassInfo!.title).toBe('errorClass.RATE_LIMITED.title')
    })

    it('未映射 class → UNKNOWN 兜底卡（出了点问题）', () => {
      const info = getErrorClassInfo('SOME_UNMAPPED_ERROR_CLASS_6116', undefined, t)
      expect(info!.title).toBe('errorClass.UNKNOWN.title')
      const model = deriveFromMetadata({
        errorClass: 'SOME_UNMAPPED_ERROR_CLASS_6116',
        isErrorMessage: true,
      })
      expect(model.errorClassInfo!.title).toBe('errorClass.UNKNOWN.title')
    })
  })

  describe('error_info_json（message_stop 正典落库）', () => {
    it('ABORT：无卡、有灰色徽标', () => {
      const model = deriveFromErrorInfo(
        { error_class: 'ABORT', category: 'aborted', partial_reason: 'aborted' },
        true,
      )
      expect(model.errorClass).toBe('ABORT')
      expect(model.errorClassInfo).toBeNull()
      expect(model.shouldRenderInterruptedBadge).toBe(true)
    })

    it.each(CARD_CASES)('%s → 仅 error_info_json 出卡', (errorClass, titleKey, severity) => {
      const model = deriveFromErrorInfo({
        error_class: errorClass,
        category: 'runtime_failed',
        partial_reason: 'message_stop_fallback',
      })
      expect(model.errorClassInfo).not.toBeNull()
      expect(model.errorClassInfo!.title).toBe(titleKey)
      expect(model.errorClassInfo!.severity).toBe(severity)
      expect(model.shouldRenderInterruptedBadge).toBe(false)
    })

    it('LLM_ERROR + suggested_action/switch_model → 能力门卡', () => {
      const model = deriveFromErrorInfo({
        error_class: 'LLM_ERROR',
        suggested_action: 'switch_model',
        stage: 'capability_gate',
        partial_reason: 'message_stop_fallback',
      })
      expect(model.errorClassInfo!.title).toBe('errorClass.LLM_CAPABILITY_GATE.title')
    })

    it('正典错误中的文档数量超限 → 恢复具体限制文案', () => {
      const errorMessage = '当前模型单次最多上传 3 个文档，本次共上传 4 个。请减少文档后重试。'
      const model = deriveFromErrorInfo({
        error_class: 'LLM_ERROR',
        error_message: errorMessage,
        suggested_action: 'switch_model',
        stage: 'capability_gate',
        error_type: 'too_many_documents',
        partial_reason: 'message_stop_fallback',
      })

      expect(model.errorClassInfo).toMatchObject({
        title: 'errorClass.LLM_DOCUMENT_LIMIT.title',
        suggestion: errorMessage,
        suggestedAction: undefined,
      })
    })

    it('LLM_ERROR + stage=image_fetch → 图片下载失败卡', () => {
      const model = deriveFromErrorInfo({
        error_class: 'LLM_ERROR',
        stage: 'image_fetch',
        partial_reason: 'message_stop_fallback',
      })
      expect(model.errorClassInfo!.title).toBe('errorClass.LLM_IMAGE_FETCH_FAILED.title')
    })

    it('LLM_ERROR + protocol_error category → 网络异常卡', () => {
      const model = deriveFromErrorInfo({
        error_class: 'LLM_ERROR',
        category: 'protocol_error',
        partial_reason: 'message_stop_fallback',
      })
      expect(model.errorClassInfo!.title).toBe('errorClass.NETWORK_ERROR.title')
    })

    it('LLM_ERROR + error_extras.backend_error_type=upstream_error → 模型服务卡', () => {
      const model = deriveFromErrorInfo({
        error_class: 'LLM_ERROR',
        error_extras: { backend_error_type: 'upstream_error' },
        partial_reason: 'message_stop_fallback',
      })
      expect(model.errorClassInfo!.title).toBe('errorClass.LLM_PROVIDER_ERROR.title')
    })

    it('未映射 class → UNKNOWN', () => {
      const model = deriveFromErrorInfo({
        error_class: 'SOME_UNMAPPED_ERROR_CLASS_6116',
        partial_reason: 'message_stop_fallback',
      })
      expect(model.errorClassInfo!.title).toBe('errorClass.UNKNOWN.title')
    })

    it.each([
      'iteration_budget_exhausted',
      'token_budget_exhausted',
      'BUDGET_EXHAUSTED',
    ] as const)('%s + category=budget_exceeded 不误走 BillingErrorCard', (errorClass) => {
      const model = deriveFromErrorInfo({
        error_class: errorClass,
        category: 'budget_exceeded',
        partial_reason: 'message_stop_fallback',
      })
      expect(model.isBillingError).toBe(false)
      expect(model.errorClassInfo).not.toBeNull()
    })

    // ：结算后余额不足需保留正文，不能被 BillingErrorCard 整卡替换。
    it('LLM_BILLING_ERROR + organization_insufficient_credits 优先 ErrorClassCard', () => {
      const model = deriveFromErrorInfo({
        error_class: 'LLM_BILLING_ERROR',
        category: 'organization_insufficient_credits',
        suggested_action: 'check_billing',
        error_message: '组织钱包余额不足，请充值后继续使用',
      })
      expect(model.isBillingError).toBe(false)
      expect(model.errorClassInfo).not.toBeNull()
      expect(model.errorClassInfo!.title).toBe('errorClass.LLM_BILLING_ORG_INSUFFICIENT.title')
      expect(model.errorClassInfo!.suggestedAction).toBe('check_billing')
    })

    it('LLM_BILLING_ERROR + runtime_failed 信封时仍用 error_type 细分文案', () => {
      const model = deriveMessageErrorModel({
        message: {
          id: 'm-billing-8296',
          role: 'assistant',
          content: '你好',
          content_blocks_json: [],
          error_info_json: {
            error_class: 'LLM_BILLING_ERROR',
            category: 'runtime_failed',
            suggested_action: 'check_billing',
            error_type: 'organization_insufficient_credits',
          },
        } as never,
        displayContent: '你好',
        isUser: false,
        isInterrupted: false,
        t: (key: string) => key,
      })
      expect(model.isBillingError).toBe(false)
      expect(model.errorClassInfo!.title).toBe('errorClass.LLM_BILLING_ORG_INSUFFICIENT.title')
    })
  })

  describe('错误卡只属于当前失败轮 ', () => {
    it('续跑已开始：最后一条失败助手不再出卡', () => {
      const model = deriveMessageErrorModel({
        message: {
          id: 'ai-1',
          role: 'assistant',
          content: '半截',
          metadata: { errorClass: 'LLM_PROVIDER_ERROR', isErrorMessage: true },
          created_at: '2026-07-20T00:00:00.000Z',
        } as ChatMessage,
        displayContent: '半截',
        isUser: false,
        isInterrupted: false,
        t,
        isLastAssistantMsg: true,
        isStreaming: true,
      })
      expect(model.errorClassInfo).toBeNull()
      expect(model.isBillingError).toBe(false)
    })

    it('后面已有新助手轮：历史失败消息不再出卡', () => {
      const model = deriveMessageErrorModel({
        message: {
          id: 'ai-1',
          role: 'assistant',
          content: '半截',
          metadata: { errorClass: 'LLM_PROVIDER_ERROR', isErrorMessage: true },
          created_at: '2026-07-20T00:00:00.000Z',
        } as ChatMessage,
        displayContent: '半截',
        isUser: false,
        isInterrupted: false,
        t,
        isLastAssistantMsg: false,
        isStreaming: false,
      })
      expect(model.errorClassInfo).toBeNull()
    })

    it('仍是最后一轮且未在跑：失败助手照常出卡', () => {
      const model = deriveFromMetadata({ errorClass: 'LLM_PROVIDER_ERROR', isErrorMessage: true })
      expect(model.errorClassInfo).not.toBeNull()
    })
  })
})
