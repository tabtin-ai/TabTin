/**
 * DONE / 错误 / usage / persist 协议 payload 构造器。
 *
 * 自 query.ts 抽出——纯 payload 构造，与 ReAct 主循环解耦。所有错误
 * DONE 走 buildErrorDonePayload 统一带 FR-06 error_class / suggested_action；
 * IterationBudget / 硬熔断走各自 error:false 的 payload；usage 由 buildUsagePayload
 * 统一（含 last_* anchor 字段）。
 */
import type { ErrorInfo, UsageReport } from '../contracts/wire-payloads.js';
import { PersistMessageEvent } from '../../event/events/persist-events.js';
import {
  AgentError,
} from '../contracts/kernel.js';
import type {
  StreamEvent,
} from '../contracts/wire-protocol.js';
import type {
  ContentBlock,
} from '../contracts/conversation.js';
import type {
  AgentErrorCode,
  EngineState,
} from '../contracts/kernel.js';
import type { BudgetTracker } from '../guards/budget-tracker.js';
import type { ClassifiedError } from '../errors/error-classifier.js';
import {
  budgetTriggerToErrorClass,
  suggestedActionForBudgetExhausted,
} from '../guards/iteration-budget.js';
import type { IterationBudgetTrigger } from '../guards/iteration-budget.js';

export type HardStopSource = 'tool_failure' | 'tool_repetition' | 'text_repetition';

/** ：与 buildHardStopDonePayload.error_class 对齐，供 message_stop.error_info。 */
export function hardStopErrorClass(source: HardStopSource): string {
  return source === 'text_repetition' ? 'text_loop_terminated' : 'tool_loop_terminated';
}

/**
 * ：异常终止走正常消息链路——`message_stop.error_info` 落库为
 * `ChatMessage.error_info_json`。不写用户可见的 runtime 英文兜底文案（硬停
 * 静默；ABORT 由前端灰色徽标表达）。
 */
export function buildHardStopMessageStopErrorInfo(source: HardStopSource): ErrorInfo {
  return {
    error_class: hardStopErrorClass(source),
    category: 'runtime_failed',
    partial_reason: 'message_stop_fallback',
  };
}

export function buildBudgetExceededMessageStopErrorInfo(errorClass: string): ErrorInfo {
  return {
    error_class: errorClass,
    category: 'budget_exceeded',
    partial_reason: 'message_stop_fallback',
  };
}

export function buildAbortMessageStopErrorInfo(): ErrorInfo {
  return {
    error_class: 'ABORT',
    category: 'aborted',
    partial_reason: 'aborted',
  };
}

/** 映射错误类终止：关信封时写入与 DONE.error_class 对齐的 error_info。 */
export function buildMappedErrorMessageStopErrorInfo(args: {
  errorClass: string;
  category?: ErrorInfo['category'];
  errorMessage?: string;
  partialReason?: ErrorInfo['partial_reason'];
}): ErrorInfo {
  return {
    error_class: args.errorClass,
    category: args.category ?? 'runtime_failed',
    partial_reason: args.partialReason ?? 'message_stop_fallback',
    ...(args.errorMessage ? { error_message: args.errorMessage } : {}),
  };
}

/** 将分类结果转换为 message_stop / persist_message 共用的结构化终态错误。 */
export function buildClassifiedTerminalErrorInfo(args: {
  classified: ClassifiedError;
  errorClass: string;
  errorMessage: string;
  partialReason: ErrorInfo['partial_reason'];
}): ErrorInfo {
  const originalDetails = args.classified.originalError instanceof AgentError
    ? args.classified.originalError.details
    : undefined;
  const errorExtras = pickErrorExtras(originalDetails);
  const classifiedCategory = args.classified.category;
  return {
    error_class: args.errorClass,
    error_message: args.errorMessage,
    suggested_action: args.classified.suggestedAction,
    category: classifiedCategory === 'abort'
      ? 'aborted'
      : classifiedCategory === 'budget_exceeded'
        ? 'budget_exceeded'
        : 'runtime_failed',
    partial_reason: args.partialReason,
    error_extras: {
      classified_category: classifiedCategory,
      ...(errorExtras ?? {}),
    },
  };
}

// ─── FR-06: Error class & suggested action mapping ───────────────────
//
// Runtime 内部抛出 / 写出的所有 done.error 均带 `error_class`（来自
// `AgentErrorCode` 枚举，H1 已稳定，本期不扩展）。`suggested_action`
// 是**机器枚举**（'switch_model' / 'retry_later' / 'check_billing' /
// 'relogin' / 'shorten_context' / 'contact_support' / 'none'），与
// error-classifier.ts 的 `SuggestedAction` 类型严格对齐——前端按枚举做
// 卡片标题路由 + ACTION_LABELS i18n 翻译，**不**在协议字段里携带中文文案。
//
// Wave 3 产品 Review 必修-1：把表从中文文案改成机器枚举，让前端
// `errorClassMap.resolveSemanticErrorClass` 用 `suggestedAction === 'switch_model'`
// 做的路由能正确命中（旧版协议字段写中文 → 路由永远不命中 → 卡片永远落
// 到"网络连接异常"）。中文展示文案改由前端 i18n 表（zh-CN/chat.json
// errorClass.*.suggestion）按 errorClass 查找，与协议字段解耦。

export const ERROR_CLASS_SUGGESTED_ACTION: Record<AgentErrorCode, string> = {
  LLM_ERROR: 'retry_later',
  LLM_BILLING_ERROR: 'check_billing',
  LLM_RATE_LIMIT: 'retry_later',
  LLM_KEY_EXHAUSTED: 'check_billing',
  TOOL_ERROR: 'none',
  TOOL_TIMEOUT: 'none',
  PERMISSION_DENIED: 'none',
  PERMISSION_TIMEOUT: 'retry_later',
  CONTEXT_OVERFLOW: 'shorten_context',
  MAX_TURNS_EXCEEDED: 'none',
  MAX_CREDITS_EXCEEDED: 'check_billing',
  // @deprecated W2.3（D-tech-6）：DoomLoop 整段砍出本期，归后续 Harness
  // 治理专题。保留枚举值是为了维持 H1 已固化的 `AgentErrorCode` 不变。
  DOOM_LOOP_DETECTED: 'none',
  // W4.1（dogfood fix）：Capability 未 bind 到 BackendSession（装配错配）。
  // 不是用户能直接修复的问题，按 contact_support 引导。
  CAP_NOT_BOUND: 'contact_support',
  ABORT: 'none',
  INTERNAL: 'contact_support',
};

export function suggestedActionFor(code: AgentErrorCode): string {
  return ERROR_CLASS_SUGGESTED_ACTION[code] ?? ERROR_CLASS_SUGGESTED_ACTION.INTERNAL;
}

/**
 * PRD-04 Phase 2 + Wave 3：统一构造 DONE payload 中的 usage 对象。
 * 包含基础 token、cache 分项、reasoning、compact 分项、charge_status、by_model。
 *
 * 「context-ring 用量字段」：额外 emit `last_*` 三个字段，从
 * `state._lastUsageAnchor` 取值——这是 LLM provider 在最近一次请求里实报的
 * 完整 input token 数（含 system / tools / messages），与 turn 累加的
 * `input_tokens` 严格区分：
 *
 *   - `input_tokens` = 本 turn 内所有 LLM 调用的 input 累加（计费 / 统计用）；
 *     带 tool_use 的 turn 会随调用次数线性增长。
 *   - `last_input_tokens` = 最近一次 LLM 调用的 input（**当前真实上下文规模**），
 *     UI 端「上下文用量环」的分子来源，作为当前上下文用量分子。
 *
 * 两套语义并存、各取所需；renderer 端 `chatMessageContextUsage` 优先读 last_*，
 * 缺失时才回退到累加值（向下兼容老消息 / 旧 runtime）。
 */
export function nonZeroUsageValue(value: number): number | undefined {
  return value || undefined;
}

export function chargeStatusForUsage(state: EngineState, tracker?: BudgetTracker): string | undefined {
  return tracker?.getChargeStatus() ?? state._lastChargeStatus;
}

export function usageByModelSinceBaseline(
  state: EngineState,
  tracker?: BudgetTracker,
): UsageReport['by_model'] {
  return tracker?.getByModelSince(state._budgetRunBaselineByModel);
}

export function buildUsagePayload(state: EngineState, tracker?: BudgetTracker): UsageReport {
  const anchor = state._lastUsageAnchor;
  return {
    input_tokens: state.totalInputTokens,
    output_tokens: state.totalOutputTokens,
    cost_usd: nonZeroUsageValue(state.creditsCharged),
    cache_read_input_tokens: nonZeroUsageValue(state.totalCacheReadTokens),
    cache_creation_input_tokens: nonZeroUsageValue(state.totalCacheCreationTokens),
    reasoning_tokens: nonZeroUsageValue(state.totalReasoningTokens),
    compact_input_tokens: nonZeroUsageValue(state.compactInputTokens),
    compact_output_tokens: nonZeroUsageValue(state.compactOutputTokens),
    charge_status: chargeStatusForUsage(state, tracker),
    // P2-1：by_model 与标量字段同口径——根 query 报本 run 增量（减 per-model
    // 基线），子 query / 无基线时回落全量累计（getByModelSince(undefined)）。
    by_model: usageByModelSinceBaseline(state, tracker),
    // 用 `??` 而非 `||`：anchor.inputTokens === 0 是合法值（100% prompt cache
    // hit 的极端场景：provider 把 input 全归到 cache_read），不能被 falsy 兜底
    // 吞掉。renderer `extractMessageUsage` 用 `typeof === 'number'` 严格区分
    // 「字段不存在」（老消息 / 旧 runtime）与「字段是 0」（新数据 + 真 0），
    // 这里必须 SET 真值（含 0）而不是 unset，以维持那条不变量。
    last_input_tokens: anchor?.inputTokens ?? undefined,
    last_cache_read_input_tokens: anchor?.cacheReadTokens ?? undefined,
    last_cache_creation_input_tokens: anchor?.cacheCreationTokens ?? undefined,
  };
}

/**
 *  A1（落库与分发分链路）：构造消息级持久化事件 `agent.stream.persist_message`。
 *
 * 在「一条消息真正完整」的边界调用——把整条已组装好的 ContentBlock[]（assistant
 * 的 text + tool_use + 本轮 tool_result 已 co-locate；或纯文本消息）一次性发出，
 * Django 单次幂等 upsert（assistant 按 message_id == ChatMessage.id）。与 6 件套
 * 解耦：6 件套继续广播给其它端 / 本端 IPC live，本事件**仅持久化**、由 daemon
 * 在 emit 顺序上天然保序，杜绝 relay 乱序丢块 + per-tool_result 多次 update。
 *
 * trace_id 不在此构造器注入——由 query-scoped EventEmitter 在 runtime egress 统一补。
 */
export function buildPersistMessageEvent(args: {
  messageId: string;
  role: 'assistant' | 'user';
  blocks: ContentBlock[];
  /** 与 ToolContext.agentRunId / lifecycle run_id 同源 → ChatMessage.agent_run_id */
  agentRunId: string;
  arrivalSeq: number;
  subagentRunId?: string;
  messageKind?: string;
  stopReason?: string;
  partial?: boolean;
  metadata?: Record<string, unknown>;
  errorInfoJson?: Record<string, unknown>;
  /** 本轮实际模型 id（Codex 字面量或 catalog UUID） */
  modelId?: string;
  /** 展示名快照；可与 modelId 同值 */
  modelName?: string;
}): StreamEvent {
  // 单一构造真相 = `PersistMessageEvent` 类（event/events/persist-events）。本函数是
  // generator 关键路径（loop/completion/compaction）的薄适配，调用点无需感知类。
  return new PersistMessageEvent(args).toStreamEvent();
}

/**
 * 统一构造带 FR-06 字段的 DONE error payload。
 *
 * 所有错误 DONE 路径都走此 helper，避免某个分支漏写 `error_class` /
 * `suggested_action` —— 这是验收标准里"5 类典型错误覆盖"的根本保障。
 *
 * 故意**不**接受 `extras` 之类的开放扩展点：
 *
 * - 让 helper 输出维持稳定 schema（与 wire `StreamDoneSchema` 字段一一对应）；
 * - 调用方若需要附加路径专属字段（如 `termination_reason`），可在调用处用对象
 *   展开，例如 `{ ...buildErrorDonePayload(...), termination_reason: '...' }`，
 *   既显式可见又不污染 helper 签名；
 * - 历史曾设计 `extras?: Record<string, unknown>` 但全文件零调用——属"假扩展点"，
 *   下次新需求出现时再按真实 shape 加 typed 字段（`StreamDoneSchema` 同步扩展）。
 *
 * @param errorClass 必填。从 `AgentErrorCode` 枚举取值。
 * @param errorMessage 必填。开发者可见的英文错误描述（沿用旧字段语义）。
 * @param usage 必填。已积累的 token 用量。
 * @param traceId 必填。本次 query 的 trace_id（H2-A 接通 AdminDash 后用）。
 */
export function buildErrorDonePayload(
  errorClass: AgentErrorCode,
  errorMessage: string,
  usage: UsageReport,
  traceId: string,
  classified?: ClassifiedError,
  /**
   * Wave 2 过渡字段：老 `agent.stream.assistant`(final) 携带的字段从这里挂上去——
   * `agent.stream.assistant` 内容流事件已下线，消费方在 W4-W6 跟进期间需要从
   * DONE 事件获取终态 content / client_event_id / 错误 metadata（cost / aborted /
   * isPartialContent 等）。这些字段对应 `buildTerminalAssistantPayload` 的产出，
   * 字段名保持下划线风格（与 wire 层一致；Renderer 内部命名转换由 ChatStore 做）。
   */
  transitionFields?: {
    content?: string;
    client_event_id?: string;
    is_partial_content?: boolean;
    aborted?: boolean;
    error_metadata?: Record<string, unknown>;
  },
): Record<string, unknown> {
  // Wave 3 R-W2-F：把 originalError.details 上的结构化字段（stage / reason /
  // host / failed_count / total_count 等）作为 `error_extras` 透传给前端，
  // 让 ChatStore 写到 message.metadata.errorExtras，再让 MessageBubble 的
  // errorClassMap.getErrorClassInfo 据 stage 路由到"图片下载失败 / 模型能力
  // 不匹配"等语义化卡片标题。**不**复用 metadata.usage 等已有字段——保持
  // schema 干净，未来加新分类字段不会冲突。
  const originalDetails = classified?.originalError instanceof AgentError
    ? classified.originalError.details
    : undefined;
  const errorExtras = pickErrorExtras(originalDetails);

  // Wave 3 产品 Review 必修-1（核心阻断点）：`suggested_action` 字段语义
  // **必须是机器枚举**（'switch_model' / 'retry_later' / 'check_billing'），
  // 不能写成中文 user_message——前端 errorClassMap.resolveSemanticErrorClass
  // 用 `suggestedAction === 'switch_model'` 路由到 LLM_CAPABILITY_GATE 卡片，
  // 写中文会让路由永远不命中，capability_gate 卡片永远显示成"网络连接异常"
  // 而 ACTION_LABELS[suggestedAction] 也取不到"换模型"按钮文案 → 按钮压根
  // 不出现。
  //
  // 用户场景里看到的中文文案改用 error_message 字段透传（已是中文 user_message），
  // 让前端 i18n 自己根据 error_class 渲染卡片标题 + suggestion，不依赖
  // suggested_action 字段携带文案。
  return {
    error: true,
    error_message: errorMessage,
    error_class: errorClass,
    suggested_action: classified?.suggestedAction || suggestedActionFor(errorClass),
    // 与 Django billing_gateway DONE metadata.error_category 同口径：
    // Renderer sendMessageAction / BillingErrorCard 读顶层字段路由计费卡。
    ...(classified?.category ? { error_category: classified.category } : {}),
    trace_id: traceId,
    usage,
    ...(errorExtras ? { error_extras: errorExtras } : {}),
    ...buildErrorDoneTransitionPayload(transitionFields),
  };
}

export function buildErrorDoneTransitionPayload(transitionFields?: {
  content?: string;
  client_event_id?: string;
  is_partial_content?: boolean;
  aborted?: boolean;
  error_metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (!transitionFields) return payload;
  if (transitionFields.content !== undefined) payload.content = transitionFields.content;
  if (transitionFields.client_event_id) payload.client_event_id = transitionFields.client_event_id;
  if (transitionFields.is_partial_content) payload.is_partial_content = true;
  if (transitionFields.aborted) payload.aborted = true;
  if (transitionFields.error_metadata) payload.error_metadata = transitionFields.error_metadata;
  return payload;
}

/**
 * 从 `AgentError.details` 中挑出"对前端展示有意义"的字段透传，过滤掉内部
 * 字段（fromProxySSE / user_message / technical_detail 已经通过 error_message
 * / suggested_action 等独立字段透传，不重复）。
 *
 * 当前公开字段：stage / reason / host / failed_count / total_count / error_type /
 * topup_reason（LLM 点券自动补充失败原因，供 BillingErrorCard 按角色引导）。
 * 这是 wire_adapter 在 SSE error chunk 上透传的"结构化诊断字段"集合
 * （`apps/services/llm/wire_adapter/error_messages.py`）。
 */
export function pickErrorExtras(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const PUBLIC_KEYS = [
    'stage',
    'reason',
    'host',
    'failed_count',
    'total_count',
    'error_type',
    'provider_error_code',
    'topup_reason',
  ] as const;
  const result: Record<string, unknown> = {};
  for (const k of PUBLIC_KEYS) {
    if (details[k] !== undefined) result[k] = details[k];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 把 `force_final` 路径的 `budgetReason` 映射到 `AgentErrorCode`。
 *
 * 当前一律 `MAX_CREDITS_EXCEEDED`（运行上限黄卡）：`tokens_*` / `credits_*` /
 * 其它守卫 reason 对用户都是「已达运行上限」，勿再落 `INTERNAL`。
 *
 * **W2.3 修订（D-tech-6）**：原 `doom_loop_*` → `DOOM_LOOP_DETECTED` 分支
 * 已删除。若未来 DoomLoopCap 经 `requestForceFinal('doom_loop_*')` 重建，
 * 需在此处恢复 `doom_loop` → `DOOM_LOOP_DETECTED`。
 */
export function mapBudgetReasonToErrorClass(
  _reason: string | undefined,
): AgentErrorCode {
  return 'MAX_CREDITS_EXCEEDED';
}

// ─── FR-15: IterationBudget DONE payload helper ──────────────────────
//
// 与 `buildErrorDonePayload` **故意分开**——IterationBudget 是「优雅
// 终止」（PRD §5.2 FR-15 验收标准明确 `error: false`），不能复用
// `error: true` 的 helper：
//
// - 复用会让前端把"达上限"渲染成红色错误，与"已完成（达上限）"的
//   产品语义不一致；
// - `buildErrorDonePayload` 强类型 `AgentErrorCode`，而本通路用的
//   `iteration_budget_exhausted` / `token_budget_exhausted` 是新枚举
//   值（`StreamDoneSchema.error_class` 是 `z.string()` passthrough，
//   兼容；H1 已固化的 `AgentErrorCode` 不扩展）；
// - 保留独立 helper 让"添加新 budget 通路"（如未来的 cost 通路）
//   只需扩展 `IterationBudgetTrigger` 不影响错误路径。
//
// 字段对照（与 `buildErrorDonePayload` 的差异）：
//   - `error: false`（关键差异）—— 不报红
//   - `content: finalContent` —— grace 期 LLM 输出的最终回复（terminate
//     直接路径下为 ''，前端按 trigger 自行展示"已达上限无最终回复"）
//   - `error_class` —— 'iteration_budget_exhausted' / 'token_budget_exhausted'
//   - `suggested_action` —— 与 FR-06 风格一致的中文兜底文案
//   - `termination_reason` —— 与 `error_class` 同值（前端 `handleDone` 兼容
//     `endConversation.reason` 字段的 fallback 路径，不写则旧 UI 退化为
//     "对话已终止"等无信息文案）
//   - `usage` —— 与 success DONE 一致的字段，便于按"自然结束"vs
//     "达上限结束"做 token 用量对比
export function buildBudgetExhaustedDonePayload(args: {
  trigger: IterationBudgetTrigger;
  finalContent: string;
  usage: UsageReport;
  traceId: string;
  /** Wave 2 过渡字段：消费方从 DONE 拿 client_event_id 替代老 ASSISTANT(final)。 */
  clientEventId?: string;
}): Record<string, unknown> {
  const errorClass = budgetTriggerToErrorClass(args.trigger);
  return {
    error: false,
    content: args.finalContent,
    error_class: errorClass,
    suggested_action: suggestedActionForBudgetExhausted(args.trigger),
    trace_id: args.traceId,
    termination_reason: errorClass,
    usage: args.usage,
    ...(args.clientEventId ? { client_event_id: args.clientEventId } : {}),
  };
}

//  — Tool 循环硬熔断 DONE payload。
//
// 与 `buildBudgetExhaustedDonePayload` 同哲学（`error: false` — 这是"已自动
// 停止"而非报红错误），但语义是"同一工具反复失败 / 复读到硬阈值，runtime 主动
// 掐断本轮防止 token 烧穿"。`error_class` / `termination_reason` 用
// `tool_loop_terminated`（`StreamDoneSchema.error_class` 是 passthrough string，
// 不扩 H1 已固化的 `AgentErrorCode`）作**内部标记**供 telemetry / 前端可选处理。
//
// **产品决策**：terminate 静默收尾——`content: ''` 且**不带**
// `suggested_action` 之类用户可见引导文案。用户已能看到前面工具的报错，runtime
// 不再额外塞"已自动停止"提示（啰嗦且暴露内部机制）。
export function buildHardStopDonePayload(args: {
  source: HardStopSource;
  usage: UsageReport;
  traceId: string;
}): Record<string, unknown> {
  // ：text_repetition 与工具硬停同哲学（error:false 静默收尾），
  // 用独立 error_class 方便 telemetry / Tracker 识别「纯文本退化」路径。
  // ：与 message_stop.error_info.error_class 共用 hardStopErrorClass。
  const errorClass = hardStopErrorClass(args.source);
  return {
    error: false,
    content: '',
    error_class: errorClass,
    trace_id: args.traceId,
    termination_reason: errorClass,
    hard_stop_source: args.source,
    usage: args.usage,
  };
}
