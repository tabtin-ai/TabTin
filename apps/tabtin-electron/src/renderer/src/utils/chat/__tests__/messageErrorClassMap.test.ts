import { describe, expect, it } from 'vitest'

import { getErrorClassInfo } from '../messageErrorClassMap'

// 伪 t：直接回显 key，便于断言映射到了正确的 i18n 键，而不依赖真实翻译资源。
const t = (key: string) => key

describe('getErrorClassInfo · 执行上限墙不提示重试', () => {
  it('MAX_CREDITS_EXCEEDED → warning、不可重试、打开执行限制', () => {
    const info = getErrorClassInfo('MAX_CREDITS_EXCEEDED', 'check_billing', t)
    expect(info).not.toBeNull()
    expect(info!.severity).toBe('warning')
    expect(info!.retryable).toBe(false)
    expect(info!.suggestedAction).toBe('open_execution_limits')
    expect(info!.suggestionKey).toBe('errorClass.MAX_CREDITS_EXCEEDED.suggestion')
    expect(info!.title).toBe('errorClass.MAX_CREDITS_EXCEEDED.title')
    // 伪 t 原样回显 key；真实 i18n 会去掉 <settingsLink> 标签
    expect(info!.suggestion).toBe('errorClass.MAX_CREDITS_EXCEEDED.suggestion')
  })

  it('MAX_CREDITS_EXCEEDED 抹掉 check_billing，改挂 open_execution_limits', () => {
    const info = getErrorClassInfo('MAX_CREDITS_EXCEEDED', undefined, t)
    expect(info!.retryable).toBe(false)
    expect(info!.suggestedAction).toBe('open_execution_limits')
    expect(info!.suggestionKey).toBe('errorClass.MAX_CREDITS_EXCEEDED.suggestion')
  })

  it('MAX_TURNS_EXCEEDED → warning、不可重试、打开执行限制', () => {
    const info = getErrorClassInfo('MAX_TURNS_EXCEEDED', 'none', t)
    expect(info).not.toBeNull()
    expect(info!.severity).toBe('warning')
    expect(info!.retryable).toBe(false)
    expect(info!.suggestedAction).toBe('open_execution_limits')
    expect(info!.suggestionKey).toBe('errorClass.MAX_TURNS_EXCEEDED.suggestion')
    expect(info!.title).toBe('errorClass.MAX_TURNS_EXCEEDED.title')
  })

  it('iteration_budget_exhausted / token_budget_exhausted 抹掉透传动作', () => {
    const iter = getErrorClassInfo('iteration_budget_exhausted', 'retry_later', t)
    expect(iter!.retryable).toBe(false)
    expect(iter!.suggestedAction).toBeUndefined()

    const token = getErrorClassInfo('token_budget_exhausted', 'retry_later', t)
    expect(token!.retryable).toBe(false)
    expect(token!.suggestedAction).toBeUndefined()
  })
})

describe('getErrorClassInfo · 视频错误分流', () => {
  it('video_unreadable + capability_gate → LLM_VIDEO_FETCH_FAILED，并在宿主层改写为可重试', () => {
    const info = getErrorClassInfo(
      'LLM_ERROR',
      'contact_support',
      t,
      { stage: 'capability_gate', error_type: 'video_unreadable' },
    )
    expect(info).not.toBeNull()
    expect(info!.title).toBe('errorClass.LLM_VIDEO_FETCH_FAILED.title')
    expect(info!.suggestion).toBe('errorClass.LLM_VIDEO_FETCH_FAILED.suggestion')
    expect(info!.retryable).toBe(true)
    expect(info!.suggestedAction).toBe('retry_later')
  })

  it('video_not_supported → LLM_VIDEO_CAPABILITY_GATE，并在宿主层改写为换模型', () => {
    const info = getErrorClassInfo(
      'LLM_ERROR',
      'contact_support',
      t,
      { stage: 'capability_gate', error_type: 'video_not_supported' },
    )
    expect(info!.title).toBe('errorClass.LLM_VIDEO_CAPABILITY_GATE.title')
    expect(info!.retryable).toBe(false)
    expect(info!.suggestedAction).toBe('switch_model')
  })

  it('通用 capability_gate（无 video error_type）仍走 LLM_CAPABILITY_GATE', () => {
    const info = getErrorClassInfo(
      'LLM_ERROR',
      'switch_model',
      t,
      { stage: 'capability_gate' },
    )
    expect(info!.title).toBe('errorClass.LLM_CAPABILITY_GATE.title')
  })
})

describe('getErrorClassInfo · LLM_CODEX_LOGIN_REQUIRED', () => {
  it('展示专属登录提示，且不继承 DONE 兜底的 retry_later 动作', () => {
    const info = getErrorClassInfo('LLM_CODEX_LOGIN_REQUIRED', 'retry_later', t)
    expect(info).not.toBeNull()
    expect(info!.severity).toBe('warning')
    expect(info!.retryable).toBe(false)
    expect(info!.title).toBe('errorClass.LLM_CODEX_LOGIN_REQUIRED.title')
    expect(info!.suggestion).toBe('errorClass.LLM_CODEX_LOGIN_REQUIRED.suggestion')
    expect(info!.suggestedAction).toBeUndefined()
  })
})

describe('getErrorClassInfo · LLM_ERROR 按 category 恢复真实语义', () => {
  it('裸 LLM_ERROR 表示模型服务失败，不再误显示为网络异常', () => {
    const info = getErrorClassInfo('LLM_ERROR', undefined, t)
    expect(info).not.toBeNull()
    expect(info!.title).toBe('errorClass.LLM_ERROR.title')
    expect(info!.suggestion).toBe('errorClass.LLM_ERROR.suggestion')
    expect(info!.retryable).toBe(true)
  })

  it.each([
    ['network'],
    ['network_error'],
    ['protocol_error'],
    ['timeout'],
    ['connection_lost'],
    ['stream_stalled'],
  ] as const)('LLM_ERROR + %s 才显示网络异常', (category) => {
    const info = getErrorClassInfo(
      'LLM_ERROR',
      undefined,
      t,
      { error_category: category },
    )
    expect(info!.title).toBe('errorClass.NETWORK_ERROR.title')
    expect(info!.suggestion).toBe('errorClass.NETWORK_ERROR.suggestion')
    expect(info!.retryable).toBe(true)
  })

  it.each([
    ['rate_limit', 'errorClass.RATE_LIMITED.title'],
    ['rate_limited', 'errorClass.RATE_LIMITED.title'],
    ['provider_overloaded', 'errorClass.RATE_LIMITED.title'],
    ['upstream_error', 'errorClass.LLM_PROVIDER_ERROR.title'],
    ['upstream_timeout', 'errorClass.LLM_PROVIDER_ERROR.title'],
  ] as const)('LLM_ERROR + %s 不显示网络异常', (category, titleKey) => {
    const info = getErrorClassInfo(
      'LLM_ERROR',
      undefined,
      t,
      { error_category: category },
    )
    expect(info!.title).toBe(titleKey)
  })

  it.each([
    ['provider_overloaded', 'errorClass.RATE_LIMITED.title'],
    ['upstream_error', 'errorClass.LLM_PROVIDER_ERROR.title'],
    ['upstream_timeout', 'errorClass.LLM_PROVIDER_ERROR.title'],
  ] as const)('LLM_ERROR + error_type=%s 不显示网络异常', (errorType, titleKey) => {
    const info = getErrorClassInfo(
      'LLM_ERROR',
      undefined,
      t,
      { error_type: errorType },
    )
    expect(info!.title).toBe(titleKey)
  })

  it.each([
    ['auth', 'errorClass.AUTH_ERROR.title', false],
    ['server_error', 'errorClass.SERVER_ERROR.title', true],
    ['tool_error', 'errorClass.TOOL_EXECUTION_ERROR.title', true],
    ['permission', 'errorClass.PERMISSION_ERROR.title', false],
    ['internal', 'errorClass.INTERNAL.title', true],
  ] as const)('%s 不再误显示为网络异常', (category, titleKey, retryable) => {
    const info = getErrorClassInfo(
      'LLM_ERROR',
      undefined,
      t,
      { error_category: category },
    )
    expect(info!.title).toBe(titleKey)
    expect(info!.retryable).toBe(retryable)
  })

  it.each([
    ['TOOL_ERROR', 'errorClass.TOOL_EXECUTION_ERROR.title'],
    ['TOOL_TIMEOUT', 'errorClass.TOOL_EXECUTION_ERROR.title'],
    ['PERMISSION_DENIED', 'errorClass.PERMISSION_ERROR.title'],
    ['PERMISSION_TIMEOUT', 'errorClass.PERMISSION_ERROR.title'],
    ['DOOM_LOOP_DETECTED', 'errorClass.tool_loop_terminated.title'],
  ] as const)('%s 有明确提示框映射', (errorClass, titleKey) => {
    expect(getErrorClassInfo(errorClass, undefined, t)!.title).toBe(titleKey)
  })
})

describe('getErrorClassInfo · LLM_BILLING_ERROR', () => {
  it('无 category 时不再落入 UNKNOWN，保留去充值动作', () => {
    const info = getErrorClassInfo('LLM_BILLING_ERROR', 'check_billing', t)
    expect(info).not.toBeNull()
    expect(info!.title).toBe('errorClass.LLM_BILLING_ERROR.title')
    expect(info!.suggestion).toBe('errorClass.LLM_BILLING_ERROR.suggestion')
    expect(info!.severity).toBe('error')
    expect(info!.retryable).toBe(false)
    expect(info!.suggestedAction).toBe('check_billing')
  })

  it('organization_insufficient_credits → 组织点券不足文案', () => {
    const info = getErrorClassInfo(
      'LLM_BILLING_ERROR',
      'check_billing',
      t,
      { error_category: 'organization_insufficient_credits' },
    )
    expect(info!.title).toBe('errorClass.LLM_BILLING_ORG_INSUFFICIENT.title')
    expect(info!.suggestion).toBe('errorClass.LLM_BILLING_ORG_INSUFFICIENT.suggestion')
    expect(info!.suggestedAction).toBe('check_billing')
  })

  it('budget_exceeded → 组织预算用尽文案', () => {
    const info = getErrorClassInfo(
      'LLM_BILLING_ERROR',
      'check_billing',
      t,
      { error_type: 'budget_exceeded' },
    )
    expect(info!.title).toBe('errorClass.LLM_BILLING_BUDGET_EXCEEDED.title')
    expect(info!.suggestion).toBe('errorClass.LLM_BILLING_BUDGET_EXCEEDED.suggestion')
  })
})

describe('getErrorClassInfo · 硬停 / ABORT', () => {
  it('text_loop_terminated → warning「已自动停止」、可重试', () => {
    const info = getErrorClassInfo('text_loop_terminated', undefined, t)
    expect(info).not.toBeNull()
    expect(info!.severity).toBe('warning')
    expect(info!.retryable).toBe(true)
    expect(info!.title).toBe('errorClass.text_loop_terminated.title')
    expect(info!.suggestion).toBe('errorClass.text_loop_terminated.suggestion')
  })

  it('tool_loop_terminated → warning「已自动停止」、可重试', () => {
    const info = getErrorClassInfo('tool_loop_terminated', undefined, t)
    expect(info).not.toBeNull()
    expect(info!.severity).toBe('warning')
    expect(info!.retryable).toBe(true)
    expect(info!.title).toBe('errorClass.tool_loop_terminated.title')
  })

  it('ABORT → 映射仍存在（UI 层 derive 会静默不渲染卡）', () => {
    const info = getErrorClassInfo('ABORT', undefined, t)
    expect(info).not.toBeNull()
    expect(info!.severity).toBe('warning')
    expect(info!.retryable).toBe(true)
    expect(info!.title).toBe('errorClass.ABORT.title')
  })
})
