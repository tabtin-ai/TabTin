/**
 * errorClassMap — DONE event 的 error_class 到用户友好文案的映射。
 *
 * H2-B 将 error_class / suggested_action 写入 message metadata，
 * 本模块把 error_class 映射成 i18n 化的标题 + 建议 + 严重等级，
 * 供 MessageBubble 渲染结构化错误卡片。
 */

export type ErrorSeverity = 'error' | 'warning'

export interface ErrorClassInfo {
  title: string
  suggestion: string
  severity: ErrorSeverity
  retryable: boolean
  suggestedAction?: string
  /**
   * 供 ErrorClassCard 用 `<Trans>` 渲染内联链接（如打开执行限制）。
   * 有值时 `suggestion` 仍是去标签后的纯文本兜底。
   */
  suggestionKey?: string
}

interface ErrorClassConfig {
  titleKey: string
  suggestionKey: string
  severity: ErrorSeverity
  retryable: boolean
}

// 键名与后端 error_class 值严格对齐，禁止前端自行归一化大小写。
// lower_snake 键名（iteration_budget_exhausted 等）反映后端历史命名。
const ERROR_CLASS_CONFIG: Record<string, ErrorClassConfig> = {
  LLM_PROVIDER_ERROR: {
    titleKey: 'errorClass.LLM_PROVIDER_ERROR.title',
    suggestionKey: 'errorClass.LLM_PROVIDER_ERROR.suggestion',
    severity: 'error',
    retryable: true,
  },
  // 模型调用失败的泛化错误。网络/流断开必须走 NETWORK_ERROR 语义类，避免把
  // provider overload / upstream model failure 显示成客户端网络异常。
  LLM_ERROR: {
    titleKey: 'errorClass.LLM_ERROR.title',
    suggestionKey: 'errorClass.LLM_ERROR.suggestion',
    severity: 'warning',
    retryable: true,
  },
  NETWORK_ERROR: {
    titleKey: 'errorClass.NETWORK_ERROR.title',
    suggestionKey: 'errorClass.NETWORK_ERROR.suggestion',
    severity: 'warning',
    retryable: true,
  },
  AUTH_ERROR: {
    titleKey: 'errorClass.AUTH_ERROR.title',
    suggestionKey: 'errorClass.AUTH_ERROR.suggestion',
    severity: 'error',
    retryable: false,
  },
  SERVER_ERROR: {
    titleKey: 'errorClass.SERVER_ERROR.title',
    suggestionKey: 'errorClass.SERVER_ERROR.suggestion',
    severity: 'error',
    retryable: true,
  },
  LLM_CODEX_LOGIN_REQUIRED: {
    titleKey: 'errorClass.LLM_CODEX_LOGIN_REQUIRED.title',
    suggestionKey: 'errorClass.LLM_CODEX_LOGIN_REQUIRED.suggestion',
    severity: 'warning',
    retryable: false,
  },
  // Wave 3：模型能力不匹配（虚拟 errorClass，不来自后端 raw error_class 字段）。
  //
  // **路由方式**：getErrorClassInfo 在见到 `LLM_ERROR + suggestedAction='switch_model'`
  // 时把卡片配置改成本条——避免渲染"网络连接异常"标题（语义错配）。这是前端纯
  // 视觉路由，不污染后端 error_class 协议字段。
  //
  // 触发场景：用户上传图片让模型分析，切换到不支持图片输入的模型（如
  // MiniMax-Text-01）→ 后端 wire_adapter `_normalize_images` 抛
  // `CapabilityGateError(reason='image_not_supported')` → SSE error chunk 标记
  // `extras.stage='capability_gate'` → proxy-provider 透传到 AgentError.details
  // → error-classifier `mapBackendErrorTypeToCategory` 返回 suggestedAction='switch_model'
  // → 本路由渲染中文标题"模型能力不匹配" + "换模型"按钮（点击触发 model picker）。
  LLM_CAPABILITY_GATE: {
    titleKey: 'errorClass.LLM_CAPABILITY_GATE.title',
    suggestionKey: 'errorClass.LLM_CAPABILITY_GATE.suggestion',
    severity: 'error',
    retryable: false,
  },
  LLM_DOCUMENT_LIMIT: {
    titleKey: 'errorClass.LLM_DOCUMENT_LIMIT.title',
    suggestionKey: 'errorClass.LLM_DOCUMENT_LIMIT.suggestion',
    severity: 'error',
    retryable: false,
  },
  // Wave 3：图片下载失败（虚拟 errorClass，后端给 LLM_ERROR + error_type=image_fetch_*
  // 时由 getErrorClassInfo 路由到本类）。
  //
  // 触发场景：用户上传 5 张截图发给 Agent，OSS 因网络抖动 / 限流让其中 2 张
  // image_fetch_timeout / image_fetch_http_error → 后端 SSE error chunk
  // `extras.stage='image_fetch'` → 前端识别后渲染"图片下载失败"标题 + "重新上传"
  // 引导（语义化，区别于通用"网络连接异常"）。
  LLM_IMAGE_FETCH_FAILED: {
    titleKey: 'errorClass.LLM_IMAGE_FETCH_FAILED.title',
    suggestionKey: 'errorClass.LLM_IMAGE_FETCH_FAILED.suggestion',
    severity: 'error',
    retryable: true,
  },
  // ：视频附件服务端读不到 / 上传失败（虚拟 errorClass）。
  LLM_VIDEO_FETCH_FAILED: {
    titleKey: 'errorClass.LLM_VIDEO_FETCH_FAILED.title',
    suggestionKey: 'errorClass.LLM_VIDEO_FETCH_FAILED.suggestion',
    severity: 'error',
    retryable: true,
  },
  // ：当前模型不支持视频输入（虚拟 errorClass）。
  LLM_VIDEO_CAPABILITY_GATE: {
    titleKey: 'errorClass.LLM_VIDEO_CAPABILITY_GATE.title',
    suggestionKey: 'errorClass.LLM_VIDEO_CAPABILITY_GATE.suggestion',
    severity: 'error',
    retryable: false,
  },
  CONTEXT_OVERFLOW: {
    titleKey: 'errorClass.CONTEXT_OVERFLOW.title',
    suggestionKey: 'errorClass.CONTEXT_OVERFLOW.suggestion',
    severity: 'error',
    retryable: false,
  },
  TOOL_EXECUTION_ERROR: {
    titleKey: 'errorClass.TOOL_EXECUTION_ERROR.title',
    suggestionKey: 'errorClass.TOOL_EXECUTION_ERROR.suggestion',
    severity: 'error',
    retryable: true,
  },
  TOOL_ERROR: {
    titleKey: 'errorClass.TOOL_EXECUTION_ERROR.title',
    suggestionKey: 'errorClass.TOOL_EXECUTION_ERROR.suggestion',
    severity: 'error',
    retryable: true,
  },
  TOOL_TIMEOUT: {
    titleKey: 'errorClass.TOOL_EXECUTION_ERROR.title',
    suggestionKey: 'errorClass.TOOL_EXECUTION_ERROR.suggestion',
    severity: 'error',
    retryable: true,
  },
  PERMISSION_DENIED: {
    titleKey: 'errorClass.PERMISSION_ERROR.title',
    suggestionKey: 'errorClass.PERMISSION_ERROR.suggestion',
    severity: 'warning',
    retryable: false,
  },
  PERMISSION_TIMEOUT: {
    titleKey: 'errorClass.PERMISSION_ERROR.title',
    suggestionKey: 'errorClass.PERMISSION_ERROR.suggestion',
    severity: 'warning',
    retryable: true,
  },
  iteration_budget_exhausted: {
    titleKey: 'errorClass.iteration_budget_exhausted.title',
    suggestionKey: 'errorClass.iteration_budget_exhausted.suggestion',
    severity: 'warning',
    retryable: false,
  },
  token_budget_exhausted: {
    titleKey: 'errorClass.token_budget_exhausted.title',
    suggestionKey: 'errorClass.token_budget_exhausted.suggestion',
    severity: 'warning',
    retryable: false,
  },
  BUDGET_EXHAUSTED: {
    titleKey: 'errorClass.BUDGET_EXHAUSTED.title',
    suggestionKey: 'errorClass.BUDGET_EXHAUSTED.suggestion',
    severity: 'error',
    retryable: false,
  },
  // ：触达执行上限（步数硬切）——与 iteration_budget 同属「上限墙」，
  // 不展示重试（上限未变会立刻再撞墙）。缺映射时会落 DEFAULT retryable=true。
  MAX_TURNS_EXCEEDED: {
    titleKey: 'errorClass.MAX_TURNS_EXCEEDED.title',
    suggestionKey: 'errorClass.MAX_TURNS_EXCEEDED.suggestion',
    severity: 'warning',
    retryable: false,
  },
  // 运行级预算守卫撞墙——「已达本次运行的用量上限、已中止」的优雅终止，不是钱包
  // 余额不足，也不是系统报错。用 severity=warning（浅色，不报红）。
  // ：retryable=false——触达上限不应诱导重试；引导去设置调高后继续发消息。
  // 注：credits 与 token 两种运行墙上游都合并为 MAX_CREDITS_EXCEEDED，故文案取
  // 通用「用量上限」口径，不写死 credits，避免 token 墙时措辞不符。
  MAX_CREDITS_EXCEEDED: {
    titleKey: 'errorClass.MAX_CREDITS_EXCEEDED.title',
    suggestionKey: 'errorClass.MAX_CREDITS_EXCEEDED.suggestion',
    severity: 'warning',
    retryable: false,
  },
  RATE_LIMITED: {
    titleKey: 'errorClass.RATE_LIMITED.title',
    suggestionKey: 'errorClass.RATE_LIMITED.suggestion',
    severity: 'warning',
    retryable: true,
  },
  // agent-runtime DONE.error_class 用 LLM_RATE_LIMIT；与 RATE_LIMITED 同文案。
  LLM_RATE_LIMIT: {
    titleKey: 'errorClass.RATE_LIMITED.title',
    suggestionKey: 'errorClass.RATE_LIMITED.suggestion',
    severity: 'warning',
    retryable: true,
  },
  INTERNAL: {
    titleKey: 'errorClass.INTERNAL.title',
    suggestionKey: 'errorClass.INTERNAL.suggestion',
    severity: 'error',
    retryable: true,
  },
  DOOM_LOOP_DETECTED: {
    titleKey: 'errorClass.tool_loop_terminated.title',
    suggestionKey: 'errorClass.tool_loop_terminated.suggestion',
    severity: 'warning',
    retryable: true,
  },
  LLM_KEY_EXHAUSTED: {
    titleKey: 'errorClass.LLM_KEY_EXHAUSTED.title',
    suggestionKey: 'errorClass.LLM_KEY_EXHAUSTED.suggestion',
    severity: 'error',
    retryable: false,
  },
  // PRD-04 Wave 5 三次收尾任务 2b：用户主动中止显式渲染轻量卡片（severity=warning），
  // 让用户明确知道"已中止"而非误以为系统出错；retryable=true 联动重试按钮（任务 2a）。
  ABORT: {
    titleKey: 'errorClass.ABORT.title',
    suggestionKey: 'errorClass.ABORT.suggestion',
    severity: 'warning',
    retryable: true,
  },
  //  / ：流式文本复读硬停——runtime 静默 DONE（error:false），前端需
  // warning「已自动停止」而非落 UNKNOWN「出了点问题」。
  text_loop_terminated: {
    titleKey: 'errorClass.text_loop_terminated.title',
    suggestionKey: 'errorClass.text_loop_terminated.suggestion',
    severity: 'warning',
    retryable: true,
  },
  //  / ：工具失败/复读硬停，与 text_loop 同属优雅终止。
  tool_loop_terminated: {
    titleKey: 'errorClass.tool_loop_terminated.title',
    suggestionKey: 'errorClass.tool_loop_terminated.suggestion',
    severity: 'warning',
    retryable: true,
  },
  // ：结算后余额不足等计费失败。流式正文已写出时走 ErrorClassCard（保留回复），
  // 若未录入本表会落入 UNKNOWN「出了点问题」，与 toast / 去充值按钮语义打架。
  LLM_BILLING_ERROR: {
    titleKey: 'errorClass.LLM_BILLING_ERROR.title',
    suggestionKey: 'errorClass.LLM_BILLING_ERROR.suggestion',
    severity: 'error',
    retryable: false,
  },
  // 虚拟 class：由 resolveSemanticErrorClass 按 error_category / error_type 路由。
  LLM_BILLING_ORG_INSUFFICIENT: {
    titleKey: 'errorClass.LLM_BILLING_ORG_INSUFFICIENT.title',
    suggestionKey: 'errorClass.LLM_BILLING_ORG_INSUFFICIENT.suggestion',
    severity: 'error',
    retryable: false,
  },
  LLM_BILLING_BUDGET_EXCEEDED: {
    titleKey: 'errorClass.LLM_BILLING_BUDGET_EXCEEDED.title',
    suggestionKey: 'errorClass.LLM_BILLING_BUDGET_EXCEEDED.suggestion',
    severity: 'error',
    retryable: false,
  },
}

const DEFAULT_CONFIG: ErrorClassConfig = {
  titleKey: 'errorClass.UNKNOWN.title',
  suggestionKey: 'errorClass.UNKNOWN.suggestion',
  severity: 'error',
  retryable: true,
}

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string

/**
 * Wave 3：把"errorClass + 后端额外信号"路由到一个**虚拟 errorClass key**，
 * 让 getErrorClassInfo 渲染语义化标题。返回 null 表示不路由，仍用原 errorClass。
 *
 * 路由优先级（**stage 优先**——结构化诊断字段比 suggestedAction 更可靠）：
 *   1. errorClass='LLM_ERROR' + extras.stage='image_fetch' → LLM_IMAGE_FETCH_FAILED
 *      （图片下载失败，与 capability_gate 互斥）
 *   2. errorClass='LLM_ERROR' + extras.stage='capability_gate' → LLM_CAPABILITY_GATE
 *      （模型能力不匹配——后端 wire_adapter 抛 CapabilityGateError 时 stage 必有此值）
 *   3. errorClass='LLM_ERROR' + suggestedAction='switch_model' → LLM_CAPABILITY_GATE
 *      （兜底——若后端 SSE error chunk 漏写 stage 字段，前端仍能按
 *      classifier 推导出的 suggestedAction='switch_model' 路由到正确卡片）
 *
 * **stage 优先级高于 suggestedAction** 的设计理由：stage 来自后端 wire_adapter
 * 的"事实陈述"（这次 error 发生在 capability_gate 阶段）；而 suggestedAction 是
 * error-classifier.ts 基于 error_type 推导出的"建议动作"——后者依赖 type 字段
 * 准确路由。事实优先于推导。
 *
 * 后端不会修改 raw error_class（保持 LLM_ERROR 兼容性）；由前端把"语义"
 * 通过 stage / suggestedAction 这些字段反推出来。这样未来后端引入新分类时
 * 前端不需要等后端 deploy 才能改卡片。
 */
const NON_BILLING_ENVELOPE_CATEGORIES = new Set([
  'runtime_failed',
  'server_error',
  'protocol_error',
  'timeout',
  'aborted',
])

const VIDEO_FETCH_ERROR_TYPES = new Set([
  'video_unreadable',
  'video_unsupported_url',
  'video_upload_failed',
  'video_oversize',
])

function readBillingCategoryKey(extras: Record<string, unknown> | undefined): string {
  // 先读 error_type（结算真因），再读 error_category；跳过信封层泛化 category。
  for (const key of ['error_type', 'backend_error_type', 'error_category'] as const) {
    const value = extras?.[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || NON_BILLING_ENVELOPE_CATEGORIES.has(trimmed)) continue
    return trimmed
  }
  return ''
}

function resolveBillingSemanticErrorClass(
  extras: Record<string, unknown> | undefined,
): string {
  const category = readBillingCategoryKey(extras)
  if (category === 'organization_insufficient_credits') {
    return 'LLM_BILLING_ORG_INSUFFICIENT'
  }
  if (category === 'budget_exceeded') {
    return 'LLM_BILLING_BUDGET_EXCEEDED'
  }
  return 'LLM_BILLING_ERROR'
}

function resolveLlmErrorCategoryClass(
  extras: Record<string, unknown> | undefined,
): string | null {
  const category = typeof extras?.error_category === 'string'
    ? extras.error_category.trim()
    : undefined
  const errorType = typeof extras?.error_type === 'string'
    ? extras.error_type.trim()
    : (typeof extras?.backend_error_type === 'string' ? extras.backend_error_type.trim() : undefined)
  const categoryClass: Record<string, string> = {
    auth: 'AUTH_ERROR',
    network: 'NETWORK_ERROR',
    network_error: 'NETWORK_ERROR',
    protocol_error: 'NETWORK_ERROR',
    timeout: 'NETWORK_ERROR',
    connection_lost: 'NETWORK_ERROR',
    stream_stalled: 'NETWORK_ERROR',
    rate_limit: 'RATE_LIMITED',
    rate_limited: 'RATE_LIMITED',
    provider_overloaded: 'RATE_LIMITED',
    upstream_rate_limited: 'RATE_LIMITED',
    upstream_error: 'LLM_PROVIDER_ERROR',
    upstream_timeout: 'LLM_PROVIDER_ERROR',
    server_error: 'SERVER_ERROR',
    tool_error: 'TOOL_ERROR',
    permission: 'PERMISSION_DENIED',
    internal: 'INTERNAL',
  }
  const errorTypeClass: Record<string, string> = {
    network_error: 'NETWORK_ERROR',
    network_failed: 'NETWORK_ERROR',
    connection_lost: 'NETWORK_ERROR',
    stream_stalled: 'NETWORK_ERROR',
    provider_overloaded: 'RATE_LIMITED',
    upstream_rate_limited: 'RATE_LIMITED',
    upstream_error: 'LLM_PROVIDER_ERROR',
    upstream_timeout: 'LLM_PROVIDER_ERROR',
  }
  if (category && categoryClass[category]) return categoryClass[category]
  if (errorType && errorTypeClass[errorType]) return errorTypeClass[errorType]
  return null
}

function resolveAttachmentErrorClass(
  stage: string | undefined,
  errorType: string | undefined,
): string | null {
  if (stage === 'image_fetch') return 'LLM_IMAGE_FETCH_FAILED'
  if (errorType && VIDEO_FETCH_ERROR_TYPES.has(errorType)) return 'LLM_VIDEO_FETCH_FAILED'
  if (errorType === 'video_not_supported') return 'LLM_VIDEO_CAPABILITY_GATE'
  return null
}

function resolveSemanticErrorClass(
  errorClass: string,
  suggestedAction: string | undefined,
  extras: Record<string, unknown> | undefined,
): string {
  // ：计费类按 category 细分，避免组织余额不足仍显示泛化「账户余额不足」。
  if (errorClass === 'LLM_BILLING_ERROR') {
    return resolveBillingSemanticErrorClass(extras)
  }

  if (errorClass !== 'LLM_ERROR') return errorClass

  const stage = typeof extras?.stage === 'string' ? extras.stage : undefined
  const errorType = typeof extras?.error_type === 'string'
    ? extras.error_type
    : (typeof extras?.backend_error_type === 'string' ? extras.backend_error_type : undefined)

  // ：附件下载 / 能力门按 stage + error_type 细分。
  const attachmentClass = resolveAttachmentErrorClass(stage, errorType)
  if (attachmentClass) return attachmentClass

  if (errorType === 'too_many_documents') return 'LLM_DOCUMENT_LIMIT'

  if (stage === 'capability_gate') return 'LLM_CAPABILITY_GATE'

  if (suggestedAction === 'switch_model') return 'LLM_CAPABILITY_GATE'

  return resolveLlmErrorCategoryClass(extras) ?? errorClass
}

function resolveEffectiveSuggestedAction(
  semanticClass: string,
  suggestedAction: string | undefined,
): string | undefined {
  //  / ：步数 / 用量墙不挂「重试」或「去充值」；改为打开执行限制。
  if (
    semanticClass === 'MAX_CREDITS_EXCEEDED'
    || semanticClass === 'MAX_TURNS_EXCEEDED'
  ) {
    return 'open_execution_limits'
  }
  // 其它预算类优雅终止：仍抹掉透传动作，避免误导 CTA。
  if (
    semanticClass === 'iteration_budget_exhausted'
    || semanticClass === 'token_budget_exhausted'
    || semanticClass === 'BUDGET_EXHAUSTED'
  ) {
    return undefined
  }
  if (semanticClass === 'LLM_CODEX_LOGIN_REQUIRED') return undefined
  if (semanticClass === 'LLM_DOCUMENT_LIMIT') return undefined
  if (semanticClass === 'LLM_VIDEO_FETCH_FAILED') return 'retry_later'
  if (semanticClass === 'LLM_VIDEO_CAPABILITY_GATE') return 'switch_model'
  return suggestedAction
}

/**
 * 根据 error_class 获取用户友好的错误信息。
 *
 * @param errorClass - DONE payload 中的 error_class 字段
 * @param suggestedAction - metadata 中的 suggestedAction（后端填写时优先使用）
 * @param t - i18next 翻译函数（namespace 应为 'chat'）
 * @param extras - 可选：后端 SSE error chunk 透传的 extras（含 stage / reason
 *   / host 等结构化字段）。Wave 3 起用 stage 字段路由到 LLM_IMAGE_FETCH_FAILED
 *   等虚拟 errorClass，让卡片标题与"实际错因"对齐。
 * @returns 映射后的错误信息，errorClass 为空时返回 null
 */
export function getErrorClassInfo(
  errorClass: string | undefined,
  suggestedAction: string | undefined,
  t: TranslateFn,
  extras?: Record<string, unknown>,
  errorMessage?: string,
): ErrorClassInfo | null {
  if (!errorClass) return null

  const semanticClass = resolveSemanticErrorClass(errorClass, suggestedAction, extras)
  const config = ERROR_CLASS_CONFIG[semanticClass] ?? DEFAULT_CONFIG

  // 运行预算墙 / 步数上限：不挂「去充值」/「重试」；
  // MAX_* 改挂 open_execution_limits（黄卡内联链到执行限制）。
  // 真·余额不足走 LLM_BILLING_ERROR / organization_insufficient_credits，不受影响。
  //
  // 视频类错误的业务语义留在 Electron 宿主侧：agent-runtime 对未知
  // backend error_type 只做通用兜底，前端根据后端 extras 路由到视频虚拟 class 后，
  // 在这里补齐对应动作，避免把 video_* 白名单下沉进 runtime。
  const effectiveSuggestedAction = resolveEffectiveSuggestedAction(semanticClass, suggestedAction)
  const preciseDocumentLimitMessage = semanticClass === 'LLM_DOCUMENT_LIMIT'
    ? errorMessage?.trim()
    : undefined
  const rawSuggestion = preciseDocumentLimitMessage || (typeof effectiveSuggestedAction === 'string'
    && effectiveSuggestedAction.length > 0
    && !/^[a-z_]+$/.test(effectiveSuggestedAction)
    ? effectiveSuggestedAction
    : t(config.suggestionKey))
  // Trans 标签仅给卡片内联链接用；纯文本路径去掉标签以免露出尖括号。
  const plainSuggestion = rawSuggestion.replace(/<\/?settingsLink>/g, '')

  return {
    title: t(config.titleKey),
    suggestion: plainSuggestion,
    severity: config.severity,
    retryable: config.retryable,
    suggestedAction: effectiveSuggestedAction,
    ...(effectiveSuggestedAction === 'open_execution_limits'
      ? { suggestionKey: config.suggestionKey }
      : {}),
  }
}
