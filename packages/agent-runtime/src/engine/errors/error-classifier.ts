/**
 * Unified error classifier — single entry point for mapping any thrown error
 * to a structured `ClassifiedError` with user-facing Chinese messages.
 *
 * Classifies API errors for `classifyAPIError` (22+ branches) adapted to our
 * Django Proxy → ZenMux → upstream architecture.
 *
 * Consumers: query.ts inner catch, query.ts outer catch, future telemetry.
 */

import {
  AgentError,
} from '../contracts/kernel.js';
import type {
  AgentErrorCode,
} from '../contracts/kernel.js';

// ─── Public Types ────────────────────────────────────────────────────

export type ErrorCategory =
  | 'rate_limit'
  | 'billing'
  | 'organization_insufficient_credits'
  | 'auth'
  | 'context_overflow'
  | 'server_error'
  | 'network'
  | 'tool_error'
  | 'permission'
  | 'budget_exceeded'
  | 'byok_provider_unavailable'
  | 'byok_rate_limit_exceeded'
  | 'byok_quota_exhausted'
  | 'byok_invalid_key'
  | 'doom_loop'
  | 'abort'
  | 'internal';

export type SuggestedAction =
  | 'retry_later'
  | 'switch_model'
  | 'shorten_context'
  | 'check_billing'
  | 'relogin'
  | 'contact_support'
  | 'none';

export interface ClassifiedError {
  code: AgentErrorCode;
  statusCode?: number;
  retryable: boolean;
  retryAfterMs?: number;
  userMessage: string;
  suggestedAction: SuggestedAction;
  category: ErrorCategory;
  showAsAssistant: boolean;
  originalError: unknown;
}

// ─── Classification Entry Point ──────────────────────────────────────

export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof AgentError) {
    return classifyAgentError(error);
  }

  const statusCode = extractStatusCode(error);
  const message = error instanceof Error ? error.message : String(error ?? '');

  if (statusCode != null) {
    return classifyByStatusCode(statusCode, message, error);
  }

  if (isPtlMessage(message)) {
    return makeClassified(error, {
      code: 'CONTEXT_OVERFLOW',
      category: 'context_overflow',
      statusCode: 413,
      retryable: false,
      suggestedAction: 'shorten_context',
      showAsAssistant: false,
      userMessage: '对话上下文超出当前模型限制，建议新开会话或精简附件后重试',
    });
  }

  if (isNetworkError(error)) {
    return makeClassified(error, {
      code: 'LLM_ERROR',
      category: 'network',
      retryable: true,
      suggestedAction: 'retry_later',
      showAsAssistant: true,
      userMessage: '网络连接不稳定，请检查网络后重试',
    });
  }

  return makeClassified(error, {
    code: 'INTERNAL',
    category: 'internal',
    retryable: false,
    suggestedAction: 'contact_support',
    showAsAssistant: true,
    userMessage: '遇到了意外问题，请重试。如果持续出现，请联系客服',
  });
}

// ─── Error Reporting Gate ────────────────────────────────────────────

/**
 * 可预期的业务/用户侧错误分类——**不应**上报到错误监控。
 *
 * 背景：run 收口 catch（ElectronAgentHost / DaemonAgentHost）此前无差别上报，
 * 把大量用户可预期的业务态（余额不足 / 限流 / 上下文超限 / 登录过期 / 用户
 * 主动中止 …）刷进错误监控，淹没真正的意外异常、真出线上问题时监控半瞎。
 * 这些业务态前端已有对应 UI 卡片引导用户处理，无需工程介入，故不上报。
 *
 * agent-runtime 保持 telemetry-SDK 中立：这里只按语义判定"是否值得上报"，
 * 具体上报到哪（Sentry 等）由 host 决定。
 */
const NON_REPORTABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'abort', // 用户主动停止
  'billing', // 个人余额不足
  'organization_insufficient_credits', // 组织钱包余额不足
  'budget_exceeded', // 单次运行算力额度用尽
  'rate_limit', // 限流 / 过载
  'context_overflow', // 上下文超出模型限制
  'auth', // 登录状态过期
  'permission', // 权限拒绝 / 授权超时
  'byok_provider_unavailable',
  'byok_rate_limit_exceeded',
  'byok_quota_exhausted',
  'byok_invalid_key',
  'network', // 网络波动（可重试）
]);

/**
 * 该分类的错误是否值得上报到错误监控。
 *
 * 口径（2026-07-08 产品确认，）：仅"意外 / 需工程排查"类上报。
 * 采用**跳过白名单**——列出的预期业务态不报，其余（含 `internal` /
 * `server_error` / `tool_error` / `doom_loop` 及未来新增 category）默认上报，
 * 保证不漏真错误。
 */
export function isReportableRunError(category: ErrorCategory): boolean {
  return !NON_REPORTABLE_CATEGORIES.has(category);
}

// ─── AgentError Classification ───────────────────────────────────────

function classifyAgentError(err: AgentError): ClassifiedError {
  for (const classify of AGENT_ERROR_CLASSIFIERS) {
    const classified = classify(err);
    if (classified) return classified;
  }

  return makeClassified(err, {
    code: err.code,
    category: 'internal',
    statusCode: err.statusCode,
    retryable: err.retryable,
    suggestedAction: 'contact_support',
    showAsAssistant: true,
    userMessage: '遇到了意外问题，请重试。如果持续出现，请联系客服',
  });
}

type AgentErrorClassifier = (err: AgentError) => ClassifiedError | null;

const AGENT_ERROR_CLASSIFIERS: AgentErrorClassifier[] = [
  classifyProxySseAgentError,
  classifyAbortAgentError,
  classifyRateLimitAgentError,
  classifyBillingSettlementAgentError,
  classifyBillingAgentError,
  classifyAuthAgentError,
  classifyContextOverflowAgentError,
  classifyBadRequestAgentError,
  classifyKeyExhaustedAgentError,
  classifyServerAgentError,
  classifyNetworkAgentError,
  classifyToolAgentError,
  classifyPermissionAgentError,
  classifyBudgetAgentError,
  classifyDoomLoopAgentError,
];

/** 火山方舟 / 豆包 burst 限流原文指纹。proxy-provider 共用。 */
const UPSTREAM_BURST_RATE_LIMIT_RE =
  /request burst|system protection triggered|slow down traffic growth/i;

/** 上游 burst / RPM 限流的用户可见文案（与 wire_adapter rate_limited 模板对齐）。 */
export const UPSTREAM_RATE_LIMIT_USER_MESSAGE =
  '该模型暂无法使用，请稍后重试或更换模型';

/** 识别火山 / 豆包 burst 限流英文原文（供 classifier / proxy-provider 共用）。 */
export function isUpstreamBurstRateLimitMessage(message: string): boolean {
  return UPSTREAM_BURST_RATE_LIMIT_RE.test(message);
}

function classifyProxySseAgentError(err: AgentError): ClassifiedError | null {
  const sc = err.statusCode;

  // ── W0 (v0.2.1):后端 LLMProxy SSE error chunk 已经渲染好中文文案,
  // 直接采用,不要再用前端通用文案覆盖(否则用户看不到主机名 / 模型名 / 状态码)。
  // 来源:apps/services/llm/wire_adapter/error_messages.py 渲染的 user_message。
  // 见 packages/agent-runtime/src/providers/proxy-provider.ts:processChunk
  // chunk.error 分支(W0)。
  if (err.details?.fromProxySSE === true) {
    const fromBackendMsg = typeof err.details?.user_message === 'string'
      ? err.details.user_message
      : err.message;
    const errType = typeof err.details?.error_type === 'string'
      ? err.details.error_type
      : '';

    // ：火山 / 豆包 burst 或后端专属 upstream_rate_limited，勿落到
    // LLM_ERROR「网络连接异常」。普通 upstream_error + 429 仍走下方通用分支
    // （保持 suggestedAction=retry_later，见 ）。
    if (
      !errType.startsWith('byok_')
      && (
        errType === 'upstream_rate_limited'
        || isUpstreamBurstRateLimitMessage(fromBackendMsg)
      )
    ) {
      return makeClassified(err, {
        code: 'LLM_RATE_LIMIT',
        category: 'rate_limit',
        statusCode: sc ?? 429,
        retryable: true,
        suggestedAction: 'switch_model',
        showAsAssistant: true,
        userMessage: UPSTREAM_RATE_LIMIT_USER_MESSAGE,
      });
    }

    // 路由后端 error_type 到合适的 category / suggestedAction 让 Renderer 渲染
    // 出对应卡片(BillingErrorCard 等)。映射缺失时走 internal 兜底。
    const { category, suggestedAction } = mapBackendErrorTypeToCategory(errType);
    // 瞬态过载（429/529/503）对 UI 标记为可稍后重试；账单类仍 non-retryable。
    // provider 层的实际重试由 isRetryableError 单独判定。
    const transientOverload =
      sc === 429 || sc === 529 || sc === 503;
    // W0-fix Major 4:保留 err.code 而非硬编码 LLM_ERROR,因为
    // proxy-provider 已根据 errorType 把 budget/insufficient/freeze 映射
    // 为 LLM_BILLING_ERROR — Renderer 的 BillingErrorCard 依赖此 code
    // 才能渲染余额 / 充值 UI。硬编码 LLM_ERROR 会让计费错误退化成通用气泡。
    return makeClassified(err, {
      code: err.code,
      category,
      statusCode: sc,
      retryable: transientOverload,
      suggestedAction: transientOverload ? 'retry_later' : suggestedAction,
      showAsAssistant: true,
      userMessage: fromBackendMsg,
    });
  }
  return null;
}

function classifyAbortAgentError(err: AgentError): ClassifiedError | null {
  const sc = err.statusCode;
  if (err.code === 'ABORT') {
    return makeClassified(err, {
      code: 'ABORT',
      category: 'abort',
      statusCode: sc,
      retryable: false,
      suggestedAction: 'none',
      showAsAssistant: false,
      userMessage: '',
    });
  }
  return null;
}

function classifyRateLimitAgentError(err: AgentError): ClassifiedError | null {
  const sc = err.statusCode;
  // ：旧包 / 非 fromProxySSE 路径仍可能漏出火山 burst 英文原文。
  if (isUpstreamBurstRateLimitMessage(err.message)) {
    return makeClassified(err, {
      code: 'LLM_RATE_LIMIT',
      category: 'rate_limit',
      statusCode: sc ?? 429,
      retryable: true,
      retryAfterMs: err.retryAfterMs,
      suggestedAction: 'switch_model',
      showAsAssistant: true,
      userMessage: UPSTREAM_RATE_LIMIT_USER_MESSAGE,
    });
  }
  if (sc === 529 || err.message.includes('overloaded_error') || err.message.includes('overload')) {
    return makeClassified(err, {
      code: 'LLM_ERROR',
      category: 'rate_limit',
      statusCode: 529,
      retryable: true,
      retryAfterMs: err.retryAfterMs,
      suggestedAction: 'retry_later',
      showAsAssistant: false,
      userMessage: '模型服务暂时过载，请稍后重试',
    });
  }
  if (sc === 429 || err.code === 'LLM_RATE_LIMIT') {
    const retrySeconds = err.retryAfterMs != null
      ? Math.ceil(err.retryAfterMs / 1000)
      : null;
    return makeClassified(err, {
      code: 'LLM_RATE_LIMIT',
      category: 'rate_limit',
      statusCode: 429,
      retryable: true,
      retryAfterMs: err.retryAfterMs,
      suggestedAction: 'retry_later',
      showAsAssistant: true,
      userMessage: retrySeconds != null
        ? `服务繁忙，预计 ${retrySeconds} 秒后恢复`
        : '服务繁忙，请稍后再试',
    });
  }
  return null;
}

function classifyBillingSettlementAgentError(err: AgentError): ClassifiedError | null {
  // tabtin.billing 尾帧结算基础设施失败：模型已出结果，但写计费事件失败。
  // 不是余额不足——可重试，勿渲染「去充值」。
  const errorType = typeof err.details?.error_type === 'string' ? err.details.error_type : '';
  const errorCategory = typeof err.details?.error_category === 'string'
    ? err.details.error_category
    : '';
  const fromBillingTail = err.details?.fromBillingTail === true;
  const isSettlementInfra =
    errorType === 'billing_charge_failed'
    || errorCategory === 'billing_charge_failed'
    || (fromBillingTail && err.code === 'LLM_ERROR' && err.details?.chargeStatus === 'failed');
  if (!isSettlementInfra) return null;
  return makeClassified(err, {
    code: 'LLM_ERROR',
    category: 'server_error',
    statusCode: err.statusCode,
    retryable: true,
    suggestedAction: 'retry_later',
    showAsAssistant: true,
    userMessage: '服务结算异常，请稍后重试',
  });
}

function classifyBillingAgentError(err: AgentError): ClassifiedError | null {
  const sc = err.statusCode;
  if (sc === 402 || err.code === 'LLM_BILLING_ERROR'
      || err.message.includes('credit balance') || err.message.includes('budget exceeded')) {
    const errorType = typeof err.details?.error_type === 'string' ? err.details.error_type : '';
    const errorCategory = typeof err.details?.error_category === 'string'
      ? err.details.error_category
      : '';
    const categoryKey = errorType || errorCategory;
    if (categoryKey === 'organization_insufficient_credits') {
      return makeClassified(err, {
        code: 'LLM_BILLING_ERROR',
        category: 'organization_insufficient_credits',
        statusCode: sc ?? 402,
        retryable: false,
        suggestedAction: 'check_billing',
        showAsAssistant: true,
        userMessage: '组织钱包余额不足，请充值后继续使用',
      });
    }
    if (categoryKey === 'budget_exceeded' || err.message.includes('budget exceeded')) {
      return makeClassified(err, {
        code: 'LLM_BILLING_ERROR',
        category: 'budget_exceeded',
        statusCode: sc ?? 402,
        retryable: false,
        suggestedAction: 'check_billing',
        showAsAssistant: true,
        userMessage: '组织预算已用尽，请调整预算后继续',
      });
    }
    return makeClassified(err, {
      code: 'LLM_BILLING_ERROR',
      category: 'billing',
      statusCode: sc ?? 402,
      retryable: false,
      suggestedAction: 'check_billing',
      showAsAssistant: true,
      userMessage: '账户余额不足，请充值后继续',
    });
  }
  return null;
}

function classifyAuthAgentError(err: AgentError): ClassifiedError | null {
  const sc = err.statusCode;
  if (sc === 401 || sc === 403) {
    return makeClassified(err, {
      code: 'LLM_ERROR',
      category: 'auth',
      statusCode: sc,
      retryable: false,
      suggestedAction: 'relogin',
      showAsAssistant: true,
      userMessage: '登录状态已过期，请重新登录后继续',
    });
  }
  return null;
}

function classifyContextOverflowAgentError(err: AgentError): ClassifiedError | null {
  const sc = err.statusCode;
  if (sc === 413 || err.code === 'CONTEXT_OVERFLOW' || isPtlMessage(err.message)) {
    return makeClassified(err, {
      code: 'CONTEXT_OVERFLOW',
      category: 'context_overflow',
      statusCode: sc ?? 413,
      retryable: false,
      suggestedAction: 'shorten_context',
      showAsAssistant: false,
      userMessage: '对话上下文超出当前模型限制，建议新开会话或精简附件后重试',
    });
  }
  return null;
}

function classifyBadRequestAgentError(err: AgentError): ClassifiedError | null {
  const sc = err.statusCode;
  if (sc === 400) {
    if (/tool_use.*without tool_result/i.test(err.message)) {
      return makeClassified(err, {
        code: 'LLM_ERROR',
        category: 'internal',
        statusCode: 400,
        retryable: false,
        suggestedAction: 'none',
        showAsAssistant: false,
        userMessage: '',
      });
    }
    if (/invalid model/i.test(err.message)) {
      return makeClassified(err, {
        code: 'LLM_ERROR',
        category: 'internal',
        statusCode: 400,
        retryable: false,
        suggestedAction: 'switch_model',
        showAsAssistant: true,
        userMessage: '当前模型不可用，请切换其他模型',
      });
    }
    return makeClassified(err, {
      code: 'LLM_ERROR',
      category: 'internal',
      statusCode: 400,
      retryable: false,
      suggestedAction: 'contact_support',
      showAsAssistant: true,
      userMessage: '遇到了意外问题，请重试。如果持续出现，请联系客服',
    });
  }
  return null;
}

function classifyKeyExhaustedAgentError(err: AgentError): ClassifiedError | null {
  const sc = err.statusCode;
  if (err.code === 'LLM_KEY_EXHAUSTED') {
    const isByok = err.details?.isByok === true;
    return makeClassified(err, {
      code: 'LLM_KEY_EXHAUSTED',
      category: isByok ? 'billing' : 'server_error',
      statusCode: sc,
      retryable: !isByok,
      suggestedAction: isByok ? 'check_billing' : 'retry_later',
      showAsAssistant: true,
      userMessage: isByok
        ? '你的 API Key 额度已用完，请更换 Key'
        : '服务暂时繁忙，请稍后重试。如果持续出现，请尝试切换 AI 模型',
    });
  }
  return null;
}

function classifyServerAgentError(err: AgentError): ClassifiedError | null {
  const sc = err.statusCode;
  if (sc != null && sc >= 500) {
    return makeClassified(err, {
      code: 'LLM_ERROR',
      category: 'server_error',
      statusCode: sc,
      retryable: true,
      retryAfterMs: err.retryAfterMs,
      suggestedAction: 'retry_later',
      showAsAssistant: false,
      userMessage: '服务暂时不可用，请稍后重试',
    });
  }
  return null;
}

function classifyNetworkAgentError(err: AgentError): ClassifiedError | null {
  const sc = err.statusCode;
  if (err.details?.networkError === true || err.details?.stall === true) {
    return makeClassified(err, {
      code: 'LLM_ERROR',
      category: 'network',
      statusCode: sc,
      retryable: true,
      suggestedAction: 'retry_later',
      showAsAssistant: true,
      userMessage: '网络连接不稳定，请检查网络后重试',
    });
  }
  return null;
}

function classifyToolAgentError(err: AgentError): ClassifiedError | null {
  if (err.code === 'TOOL_ERROR') {
    return makeClassified(err, {
      code: 'TOOL_ERROR',
      category: 'tool_error',
      retryable: false,
      suggestedAction: 'none',
      showAsAssistant: false,
      userMessage: '',
    });
  }
  if (err.code === 'TOOL_TIMEOUT') {
    return makeClassified(err, {
      code: 'TOOL_TIMEOUT',
      category: 'tool_error',
      retryable: false,
      suggestedAction: 'none',
      showAsAssistant: false,
      userMessage: '',
    });
  }
  return null;
}

function classifyPermissionAgentError(err: AgentError): ClassifiedError | null {
  if (err.code === 'PERMISSION_DENIED') {
    return makeClassified(err, {
      code: 'PERMISSION_DENIED',
      category: 'permission',
      retryable: false,
      suggestedAction: 'none',
      showAsAssistant: false,
      userMessage: '',
    });
  }
  if (err.code === 'PERMISSION_TIMEOUT') {
    return makeClassified(err, {
      code: 'PERMISSION_TIMEOUT',
      category: 'permission',
      retryable: false,
      suggestedAction: 'none',
      showAsAssistant: true,
      userMessage: '等待操作授权超时，请重新发送消息',
    });
  }
  return null;
}

function classifyBudgetAgentError(err: AgentError): ClassifiedError | null {
  if (err.code === 'MAX_TURNS_EXCEEDED') {
    return makeClassified(err, {
      code: 'MAX_TURNS_EXCEEDED',
      category: 'budget_exceeded',
      retryable: false,
      suggestedAction: 'none',
      showAsAssistant: true,
      userMessage: '本次任务步骤较多，已达单次执行上限。你可以继续发消息让 Agent 接着完成',
    });
  }
  if (err.code === 'MAX_CREDITS_EXCEEDED') {
    return makeClassified(err, {
      code: 'MAX_CREDITS_EXCEEDED',
      category: 'budget_exceeded',
      retryable: false,
      suggestedAction: 'check_billing',
      showAsAssistant: true,
      userMessage: '本次运行的算力额度已用完，请检查计费设置或拆分任务',
    });
  }
  return null;
}

function classifyDoomLoopAgentError(err: AgentError): ClassifiedError | null {
  if (err.code === 'DOOM_LOOP_DETECTED') {
    return makeClassified(err, {
      code: 'DOOM_LOOP_DETECTED',
      category: 'doom_loop',
      retryable: false,
      suggestedAction: 'none',
      showAsAssistant: true,
      userMessage: 'Agent 似乎陷入了重复循环，已自动停止。你可以换种方式描述需求再试',
    });
  }
  return null;
}

// ─── Status Code Classification (non-AgentError) ─────────────────────

function classifyByStatusCode(
  statusCode: number,
  message: string,
  error: unknown,
): ClassifiedError {
  if (statusCode === 529) {
    return makeClassified(error, {
      code: 'LLM_ERROR',
      category: 'rate_limit',
      statusCode,
      retryable: true,
      suggestedAction: 'retry_later',
      showAsAssistant: false,
      userMessage: '模型服务暂时过载，请稍后重试',
    });
  }
  if (statusCode === 429) {
    return makeClassified(error, {
      code: 'LLM_RATE_LIMIT',
      category: 'rate_limit',
      statusCode,
      retryable: true,
      suggestedAction: 'retry_later',
      showAsAssistant: true,
      userMessage: '服务繁忙，请稍后再试',
    });
  }
  if (statusCode === 413 || isPtlMessage(message)) {
    return makeClassified(error, {
      code: 'CONTEXT_OVERFLOW',
      category: 'context_overflow',
      statusCode,
      retryable: false,
      suggestedAction: 'shorten_context',
      showAsAssistant: false,
      userMessage: '对话上下文超出当前模型限制，建议新开会话或精简附件后重试',
    });
  }
  if (statusCode === 402) {
    return makeClassified(error, {
      code: 'LLM_BILLING_ERROR',
      category: 'billing',
      statusCode,
      retryable: false,
      suggestedAction: 'check_billing',
      showAsAssistant: true,
      userMessage: '账户余额不足，请充值后继续',
    });
  }
  if (statusCode === 401 || statusCode === 403) {
    return makeClassified(error, {
      code: 'LLM_ERROR',
      category: 'auth',
      statusCode,
      retryable: false,
      suggestedAction: 'relogin',
      showAsAssistant: true,
      userMessage: '登录状态已过期，请重新登录后继续',
    });
  }
  if (statusCode >= 500) {
    return makeClassified(error, {
      code: 'LLM_ERROR',
      category: 'server_error',
      statusCode,
      retryable: true,
      suggestedAction: 'retry_later',
      showAsAssistant: false,
      userMessage: '服务暂时不可用，请稍后重试',
    });
  }
  return makeClassified(error, {
    code: 'LLM_ERROR',
    category: 'internal',
    statusCode,
    retryable: false,
    suggestedAction: 'contact_support',
    showAsAssistant: true,
    userMessage: '遇到了意外问题，请重试。如果持续出现，请联系客服',
  });
}

// ─── Token Gap Parsing ───────────────────────────────────────────────

/**
 * Extract token overshoot from PTL error messages.
 * Returns the number of tokens exceeding the limit, or undefined if unparseable.
 */
export function parseTokenGap(errorMessage: string): number | undefined {
  // Anthropic: "prompt is too long: 137500 tokens > 135000 maximum"
  const anthropic = errorMessage.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)\s*max/i);
  if (anthropic) {
    const actual = parseInt(anthropic[1]!.replace(/,/g, ''), 10);
    const limit = parseInt(anthropic[2]!.replace(/,/g, ''), 10);
    if (actual > limit) return actual - limit;
  }
  // OpenAI: "maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens."
  const openai = errorMessage.match(/maximum.*?(\d[\d,]*)\s*tokens.*?resulted.*?(\d[\d,]*)\s*tokens/i);
  if (openai) {
    const limit = parseInt(openai[1]!.replace(/,/g, ''), 10);
    const actual = parseInt(openai[2]!.replace(/,/g, ''), 10);
    if (actual > limit) return actual - limit;
  }
  return undefined;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * 把后端 SSE error chunk 携带的 `error_type` 映射到 ClassifiedError 的
 * `category` + `suggestedAction`。category 决定前端渲染哪个错误卡片
 * (BillingErrorCard / 通用 inline 系统气泡 / ...),suggestedAction 决定
 * "查看技术详情"折叠下方的引导按钮。
 *
 * 来源:apps/services/llm/wire_adapter/error_messages.py 中的 stage 维度。
 * 后端 error_type ≈ ProxyError.error_code(budget_exceeded /
 * insufficient_credits / freeze_failed / model_not_found / image_fetch_*
 * / upstream_error / ...)
 */
function mapBackendErrorTypeToCategory(errorType: string): {
  category: ErrorCategory;
  suggestedAction: SuggestedAction;
} {
  if (isByokErrorType(errorType)) {
    return {
      category: errorType,
      suggestedAction: errorType === 'byok_rate_limit_exceeded'
        ? 'retry_later'
        : 'switch_model',
    };
  }
  // billing 类:让 BillingErrorCard 接管渲染
  if (BILLING_BACKEND_ERROR_TYPES.has(errorType)) {
    return { category: 'billing', suggestedAction: 'check_billing' };
  }
  // 组织钱包余额不足 — 与 'insufficient_credits'(个人余额) 区分:走 BillingErrorCard
  // 的 isOrganization 分支,主 CTA 跳"组织钱包"而非"个人充值",并触发角色感知文案
  // (owner/admin → "前往组织钱包";其他成员 → "联系管理员")。
  // 后端 error_type 来自 apps/services/llm/services/billed_call.py
  // build_precheck_error / billing.py:1160。
  if (errorType === 'organization_insufficient_credits') {
    return { category: 'organization_insufficient_credits', suggestedAction: 'check_billing' };
  }
  // 上游 burst / RPM 限流 → 换模型或稍后重试
  if (errorType === 'upstream_rate_limited') {
    return { category: 'rate_limit', suggestedAction: 'switch_model' };
  }
  // 上游服务异常 → 重试或换 model
  if (UPSTREAM_RETRY_BACKEND_ERROR_TYPES.has(errorType)) {
    return { category: 'server_error', suggestedAction: 'retry_later' };
  }
  // 模型路由问题 → 切换 model
  if (MODEL_SWITCH_BACKEND_ERROR_TYPES.has(errorType)) {
    return { category: 'server_error', suggestedAction: 'switch_model' };
  }
  // Capability gate 拒绝(image / json_schema / tool 等不被当前 model 支持)→
  // 让用户切换到支持该能力的 model(中文文案已含 "换 Claude/GPT-4o" 等指引)。
  // 来源:wire_adapter.request_adapter._normalize_images 抛 CapabilityGateError。
  if (IMAGE_CAPABILITY_BACKEND_ERROR_TYPES.has(errorType)) {
    return { category: 'server_error', suggestedAction: 'switch_model' };
  }
  // 图片下载失败 → 用户重新上传(网络相关)
  if (IMAGE_FETCH_BACKEND_ERROR_TYPES.has(errorType)) {
    return { category: 'network', suggestedAction: 'retry_later' };
  }
  // 配置 / 内部 / 缺 organization_id → 联系客服
  if (INTERNAL_BACKEND_ERROR_TYPES.has(errorType)) {
    return { category: 'internal', suggestedAction: 'contact_support' };
  }
  // 兜底
  return { category: 'internal', suggestedAction: 'contact_support' };
}

const BILLING_BACKEND_ERROR_TYPES = new Set([
  'budget_exceeded',
  'insufficient_credits',
  'freeze_failed',
]);

const UPSTREAM_RETRY_BACKEND_ERROR_TYPES = new Set([
  'upstream_error',
  'upstream_timeout',
]);

const MODEL_SWITCH_BACKEND_ERROR_TYPES = new Set([
  'model_not_found',
  'all_keys_exhausted',
]);

const IMAGE_CAPABILITY_BACKEND_ERROR_TYPES = new Set([
  'image_not_supported',
  'image_input_via_unsupported',
]);

const IMAGE_FETCH_BACKEND_ERROR_TYPES = new Set([
  'image_fetch_timeout',
  'image_fetch_http_error',
  'image_fetch_network_error',
  'image_fetch_failed',
]);

const INTERNAL_BACKEND_ERROR_TYPES = new Set([
  'missing_organization_id',
  'missing_api_base',
]);

function isByokErrorType(errorType: string): errorType is
  | 'byok_provider_unavailable'
  | 'byok_rate_limit_exceeded'
  | 'byok_quota_exhausted'
  | 'byok_invalid_key' {
  return errorType === 'byok_provider_unavailable'
    || errorType === 'byok_rate_limit_exceeded'
    || errorType === 'byok_quota_exhausted'
    || errorType === 'byok_invalid_key';
}

function makeClassified(
  error: unknown,
  partial: Omit<ClassifiedError, 'originalError'>,
): ClassifiedError {
  return { ...partial, originalError: error };
}

function isPtlMessage(msg: string): boolean {
  return /prompt is too long|max.*token.*exceeded|context_length_exceeded/i.test(msg);
}

function extractStatusCode(error: unknown): number | undefined {
  if (error == null) return undefined;
  const e = error as Record<string, unknown>;
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return undefined;
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError && error.message.includes('fetch')) return true;
  if (error instanceof Error && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(error.message)) return true;
  return false;
}
