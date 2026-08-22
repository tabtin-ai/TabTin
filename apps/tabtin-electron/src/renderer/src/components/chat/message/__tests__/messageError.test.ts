import { describe, expect, it } from 'vitest'

import { resolveMessageErrorState } from '@utils/chat/messageError'

describe('resolveMessageErrorState', () => {
  it('#9048：billingErrorResolved 后不再暴露余额不足错误态', () => {
    const result = resolveMessageErrorState({
      metadata: {
        errorCategory: 'organization_insufficient_credits',
        errorClass: 'LLM_BILLING_ORG_INSUFFICIENT',
        errorMessage: '组织可用点券余额不足',
        isErrorMessage: true,
        billingErrorResolved: true,
      },
    })

    expect(result).toEqual({})
  })

  it('优先读取运行时 metadata 中的错误信息', () => {
    const result = resolveMessageErrorState({
      metadata: {
        errorCategory: 'device_busy',
        errorMessage: 'daemon unreachable',
      },
      content_blocks_json: [
        {
          type: 'metadata',
          error_message: 'stale message',
        },
      ],
    })

    // resolveMessageErrorState 在命中 metadata 错误分支时固定返回 5 字段
    // （含 isErrorMessage / errorClass / suggestedAction，即使为 false / undefined）。
    // vitest 4 toEqual 对 `false` 字段严格匹配，所以期望显式写出全部字段——
    // toMatchObject 的"包含即可"语义会掩盖未来添加 unintended 字段的回归。
    expect(result).toEqual({
      errorCategory: 'device_busy',
      errorMessage: 'daemon unreachable',
      errorClass: undefined,
      suggestedAction: undefined,
      isErrorMessage: false,
    })
  })

  it('Wave 3：metadata 含 errorExtras（stage / reason / host）时一并透传', () => {
    const result = resolveMessageErrorState({
      metadata: {
        errorClass: 'LLM_ERROR',
        errorMessage: '模型不支持图片',
        errorExtras: {
          stage: 'capability_gate',
          reason: 'image_not_supported',
          host: 'oss.example.com',
        },
        suggestedAction: 'switch_model',
      },
    })

    expect(result.errorExtras).toEqual({
      stage: 'capability_gate',
      reason: 'image_not_supported',
      host: 'oss.example.com',
    })
    expect(result.errorClass).toBe('LLM_ERROR')
    expect(result.suggestedAction).toBe('switch_model')
  })

  it('metadata.errorExtras.backend_error_type 透传到错误卡语义路由', () => {
    const result = resolveMessageErrorState({
      metadata: {
        errorClass: 'LLM_ERROR',
        errorExtras: {
          backend_error_type: 'upstream_rate_limited',
        },
      },
    })

    expect(result.errorExtras).toEqual({
      backend_error_type: 'upstream_rate_limited',
    })
  })

  it('LLM_ERROR + Codex 登录提示映射为专属错误卡', () => {
    const result = resolveMessageErrorState({
      metadata: {
        isErrorMessage: true,
        errorClass: 'LLM_ERROR',
        errorMessage: 'LLM call failed: 请先在「订阅套餐」中登录 ChatGPT，才能使用 Codex 模型。',
      },
    })

    expect(result.errorClass).toBe('LLM_CODEX_LOGIN_REQUIRED')
    expect(result.errorMessage).toBe('LLM call failed: 请先在「订阅套餐」中登录 ChatGPT，才能使用 Codex 模型。')
  })

  it('LLM_ERROR + 火山 burst 原文映射为 RATE_LIMITED', () => {
    const result = resolveMessageErrorState({
      metadata: {
        isErrorMessage: true,
        errorClass: 'LLM_ERROR',
        errorMessage:
          'System protection triggered by request burst. Please slow down traffic growth '
          + 'and increase requests gradually before retrying.',
      },
    })

    expect(result.errorClass).toBe('RATE_LIMITED')
  })

  it('errorCategory=rate_limit 映射为 RATE_LIMITED', () => {
    const result = resolveMessageErrorState({
      metadata: {
        isErrorMessage: true,
        errorCategory: 'rate_limit',
        errorMessage: '该模型暂无法使用，请稍后重试或更换模型',
      },
    })

    expect(result.errorClass).toBe('RATE_LIMITED')
  })

  it('Wave 3：metadata.errorExtras 不是 object（被污染成 string / array）时安全降级为 undefined', () => {
    const r1 = resolveMessageErrorState({
      metadata: {
        errorClass: 'LLM_ERROR',
        errorMessage: 'x',
        errorExtras: 'corrupted-string' as unknown as Record<string, unknown>,
      },
    })
    const r2 = resolveMessageErrorState({
      metadata: {
        errorClass: 'LLM_ERROR',
        errorMessage: 'x',
        errorExtras: ['array', 'leak'] as unknown as Record<string, unknown>,
      },
    })

    // 两种污染数据都不应导致 errorExtras 字段误传给下游 getErrorClassInfo——
    // 后者会 try 读取 stage 触发 TypeError。降级为不返回该字段更安全。
    expect(r1.errorExtras).toBeUndefined()
    expect(r2.errorExtras).toBeUndefined()
  })

  it('fallback 到落库 metadata block 中的错误信息', () => {
    const result = resolveMessageErrorState({
      metadata: undefined,
      content_blocks_json: [
        {
          type: 'metadata',
          error_category: 'runtime_failed',
          error_message: 'tool execution failed',
        },
      ],
    })

    expect(result).toEqual({
      errorCategory: 'runtime_failed',
      errorMessage: 'tool execution failed',
    })
  })

  it('没有 metadata block 时不再从 tool_call 错误推断消息级错误状态', () => {
    const result = resolveMessageErrorState({
      metadata: undefined,
      content_blocks_json: [
        {
          type: 'tool_call',
          tool_name: 'Shell',
          error: true,
          output: 'permission denied',
        },
      ],
    })

    expect(result).toEqual({
      errorCategory: undefined,
      errorMessage: undefined,
    })
  })

  it('#6116：error_info_json 优先于 metadata.errorClass（切会话落库源）', () => {
    const result = resolveMessageErrorState({
      error_info_json: {
        error_class: 'tool_loop_terminated',
        category: 'runtime_failed',
        partial_reason: 'message_stop_fallback',
      },
      metadata: {
        errorClass: 'UNKNOWN',
        errorMessage: 'stale done metadata',
      },
    })

    expect(result.errorClass).toBe('tool_loop_terminated')
    expect(result.errorCategory).toBe('runtime_failed')
    // error_info 无 error_message 时仍可读 metadata 文案（活态兼容）
    expect(result.errorMessage).toBe('stale done metadata')
    expect(result.isErrorMessage).toBe(true)
  })

  it('#6116：仅 error_info_json.ABORT 时暴露 errorClass，不标 isErrorMessage', () => {
    const result = resolveMessageErrorState({
      error_info_json: {
        error_class: 'ABORT',
        category: 'aborted',
        partial_reason: 'aborted',
      },
    })

    expect(result).toEqual({
      errorCategory: 'aborted',
      errorMessage: undefined,
      errorClass: 'ABORT',
      suggestedAction: undefined,
      isErrorMessage: false,
    })
  })

  it('#6116：error_info_json.stage 透传到 errorExtras（图片拉取语义路由）', () => {
    const result = resolveMessageErrorState({
      error_info_json: {
        error_class: 'LLM_ERROR',
        stage: 'image_fetch',
        partial_reason: 'message_stop_fallback',
      },
    })
    expect(result.errorClass).toBe('LLM_ERROR')
    expect(result.errorExtras).toEqual({ stage: 'image_fetch' })
  })

  it('#6116：error_info_json.error_extras.backend_error_type 透传到错误卡语义路由', () => {
    const result = resolveMessageErrorState({
      error_info_json: {
        error_class: 'LLM_ERROR',
        error_extras: {
          backend_error_type: 'upstream_error',
        },
        partial_reason: 'message_stop_fallback',
      },
    })

    expect(result.errorClass).toBe('LLM_ERROR')
    expect(result.errorExtras).toEqual({
      backend_error_type: 'upstream_error',
    })
  })
})
