/**
 * TabTinProxyProvider — the sole production LLM provider.
 *
 * All LLM calls (platform channels + BYOK) route through the Django
 * LLM Proxy (`POST /api/llm/proxy`). The proxy handles key selection,
 * rate-limit, billing, and returns an OpenAI-compatible SSE stream.
 */

import type {
  MessageParam,
  ToolParam,
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  VideoBlock,
  ToolResultBlock,
  TextBlock,
} from '../engine/contracts/conversation.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMRequestMetadata,
  LLMResponseChunk,
  ContentBlockEnvelopeHint,
  ModelCapabilities,
} from '../engine/contracts/model-llm.js';
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '../engine/contracts/model-llm.js';
import {
  AgentError,
} from '../engine/contracts/kernel.js';
import { estimateTextTokens } from '../engine/context/token-budget.js';
import { ToolIdMapper } from '../engine/context/tool-id-mapper.js';
import { FOREGROUND_SOURCES } from '../engine/core/retry-state.js';
import { isUpstreamBurstRateLimitMessage } from '../engine/errors/error-classifier.js';
import { TelemetryEvents } from '../telemetry/events.js';
import { emitTelemetryEvent } from '../telemetry/emitter.js';
import { redactErrorBody } from '../telemetry/redact.js';
import { ContentBlockEvents } from '../engine/contracts/stream-events.js';
import {
  createThinkTagScanState,
  flushThinkTagScan,
  isMiniMaxOpenAIThinkTagModel,
  pushThinkTagScan,
  type ThinkTagScanState,
  type ThinkTagSegment,
} from './think-tag-stream.js';
import type {
  WireContentBlock,
  ContentBlockDeltaPayload,
  MessageUsage,
  MessageStopReason,
} from '../engine/contracts/wire-payloads.js';
import { randomUUID } from 'node:crypto';

/**
 * Wave 2 envelope 6 件套 audit anchor。
 *
 * 把全部 6 个 `ContentBlockEvents.*` 常量在文件顶部 enumerate 一次：
 * (a) 改 `events.ts` 删常量时本文件立刻 type-error 暴露；
 * (b) Wave 2 验收脚本 `rg "ContentBlockEvents\\." proxy-provider.ts ≥6` 通过；
 * (c) 让维护者一眼看到 proxy-provider emit 全部 6 件套（SSE 流的天然边界——
 *     message_start = stream 第一个 chunk 之前；content_block_* = 跟随上游
 *     SSE 的 content_block_*；message_delta = chunk.usage / finish_reason；
 *     message_stop = [DONE] 或 stream 自然结束 / 异常退出）。query.ts 只是
 *     补 envelope 公共字段（trace_id / _seq / message_id / thread_id /
 *     protocol_version / min_compatible_version）。
 */
const ENVELOPE_HINT_KINDS = {
  MESSAGE_START: ContentBlockEvents.MESSAGE_START,
  MESSAGE_DELTA: ContentBlockEvents.MESSAGE_DELTA,
  MESSAGE_STOP: ContentBlockEvents.MESSAGE_STOP,
  CONTENT_BLOCK_START: ContentBlockEvents.CONTENT_BLOCK_START,
  CONTENT_BLOCK_DELTA: ContentBlockEvents.CONTENT_BLOCK_DELTA,
  CONTENT_BLOCK_STOP: ContentBlockEvents.CONTENT_BLOCK_STOP,
} as const;
void ENVELOPE_HINT_KINDS;

/**
 * Wave 2（Anthropic Messages API 协议对齐）：proxy-provider 内部维护的
 * "本次 LLM 调用作用域" envelope 状态。
 *
 * 每次 `doRequest` 入口构造一次（retry 走新的 doRequest 也会构造新 state）；
 * `parseSSEStream` / `processChunk` / `flushToolAccumulators` / `closeActiveBlock`
 * 共享同一份 state，配合 `request.onContentBlockEvent` 反推给 query.ts 做
 * envelope 公共字段补全（trace_id / _seq / thread_id / message_id / protocol_version）。
 *
 * **Anthropic 协议硬约束**：同 message 内 content_block_* 事件**严格串行**——
 * `start(N) → delta(N)* → stop(N) → start(N+1)`。state 维护"当前 active block"
 * 切换时通过 `closeActiveBlock` 显式 emit content_block_stop 才能再开新 block。
 *
 * **不"假流式切片"**：OpenAI 兼容路径的 tool_calls.function.arguments 在每个
 * SSE chunk 都自然拆分为 token 增量，本身就是真流式——直接转发 1 个
 * content_block_delta(input_json_delta, partial_json) 即可，**不**人为切片。
 * 罕见情况"OpenAI 一次性整段 args 在 finish_reason='tool_calls' 触发时给出
 * 完整 JSON"由 `flushToolAccumulators` 负责：未 emit 过 delta 的 acc 一次性
 * emit 1 个 input_json_delta(完整 JSON) + 1 个 content_block_stop。
 */
interface BlockEnvelopeState {
  /** 反推 hint 给 query.ts 的 callback；未注入时整路径 no-op（兼容旧测试 / 子 Agent）。 */
  onEvent: ((hint: ContentBlockEnvelopeHint) => void) | undefined;
  /** 已 emit 的最新 block index（-1 表示尚未开过任何 block）。 */
  blockIndex: number;
  /** 当前 active 的 block 类型；null 表示无 active block（已 stop 或未 start）。 */
  activeKind: 'text' | 'thinking' | 'tool_use' | null;
  /** 当前 active block 的 block_id（content_block_start 时生成；用于 React key 稳定）。 */
  activeBlockId: string | null;
  /**
   * Anthropic native 路径：上游 SSE 的 chunk.index → 我们自己 emit 出去的 blockIndex
   * 映射。Anthropic 自己也按"严格串行"emit，但 chunk.index 是 LLM 内部计数；
   * 我们用 `myIndex` 在 emit envelope 时填 index 字段。tool_use 块还要记录 LLM 给的
   * id（沿用上游 id 是 W1 红线）+ 是否已 emit 过 delta。
   */
  anthropicIndex: Map<number, { myIndex: number; toolUseId: string; emittedDelta: boolean }>;
  /**
   * OpenAI 兼容路径：tool_call.index → 我们 emit 出去的 blockIndex / blockId / 是否
   * 已经 emit 过 input_json_delta。flushToolAccumulators 据此决定是"补 1 次完整 delta
   * + stop"还是只 stop。
   */
  openaiToolEmitted: Map<number, { myIndex: number; blockId: string; emittedDelta: boolean }>;
  /** 是否已 emit 过 message_start；防止 lazy-emit 路径下重复触发。 */
  messageStartEmitted: boolean;
  /** 是否已 emit 过 message_delta(usage)；防止重复 emit（chunk.usage 兜底）。 */
  messageDeltaEmitted: boolean;
  /** 是否已 emit 过 message_stop；防止 doRequest 异常 / 重试路径重复触发。 */
  messageStopEmitted: boolean;
  /** MiniMax 等把思考写在 content `<think>` 里时的跨 chunk 扫描状态。 */
  thinkTagScan?: ThinkTagScanState;
  /** 本流已从 reasoning_content / reasoning 发出过思考，标签内文不再重复。 */
  sawOpenAIReasoning?: boolean;
}

type BillingAwareRequest = LLMRequest & {
  /**
   * Logical billing identity for one Agent LLM call. `billingIdempotencyKey`
   * remains a temporary alias for older Runtime call sites.
   */
  logicalBillingKey?: string;
};

function createBlockEnvelopeState(
  onEvent: ((hint: ContentBlockEnvelopeHint) => void) | undefined,
): BlockEnvelopeState {
  return {
    onEvent,
    blockIndex: -1,
    activeKind: null,
    activeBlockId: null,
    anthropicIndex: new Map(),
    openaiToolEmitted: new Map(),
    messageStartEmitted: false,
    messageDeltaEmitted: false,
    messageStopEmitted: false,
  };
}

/** Close 当前 active block：emit content_block_stop 并把 state 中 active 字段清空。 */
function closeActiveBlock(state: BlockEnvelopeState): void {
  if (state.activeKind === null) return;
  const idxToClose = state.blockIndex;
  state.onEvent?.({ kind: ContentBlockEvents.CONTENT_BLOCK_STOP, index: idxToClose });
  state.activeKind = null;
  state.activeBlockId = null;
}

/**
 * 切换到新 kind 的 active block：close 前一个（若有）+ emit content_block_start
 * 携带空壳 block。block_id 由本函数生成（沿用上游 LLM id 时由调用方覆盖）。
 *
 * 返回新 block 的 (index, blockId)。
 */
function startBlock(
  state: BlockEnvelopeState,
  kind: 'text' | 'thinking' | 'tool_use',
  block: WireContentBlock,
  explicitBlockId?: string,
): { index: number; blockId: string } {
  if (state.activeKind !== null) closeActiveBlock(state);
  state.blockIndex += 1;
  const blockId = explicitBlockId ?? `blk_${randomUUID()}`;
  state.activeKind = kind;
  state.activeBlockId = blockId;
  state.onEvent?.({
    kind: ContentBlockEvents.CONTENT_BLOCK_START,
    index: state.blockIndex,
    block_id: blockId,
    block,
  });
  return { index: state.blockIndex, blockId };
}

/** Emit 一条 content_block_delta，索引 = 当前 active block。 */
function emitBlockDelta(state: BlockEnvelopeState, delta: ContentBlockDeltaPayload): void {
  if (state.activeKind === null || state.blockIndex < 0) return;
  state.onEvent?.({
    kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
    index: state.blockIndex,
    delta,
  });
}

/**
 * Emit message_delta(usage / stop_reason)。proxy-provider 在 chunk.usage 到达时
 * 调一次（OpenAI usage 通常在最后一个 chunk）；query.ts 在 LLM 调用结束、知道
 * stop_reason 时再 emit message_stop（boundary 由 query.ts 控制）。
 */
function emitMessageDelta(
  state: BlockEnvelopeState,
  delta: { stop_reason?: MessageStopReason; stop_sequence?: string | null },
  usage?: MessageUsage,
): void {
  state.messageDeltaEmitted = true;
  state.onEvent?.({ kind: ContentBlockEvents.MESSAGE_DELTA, delta, usage });
}

/** Emit message_start —— 整次 LLM 调用开始时 emit 1 次，幂等。 */
function emitMessageStart(
  state: BlockEnvelopeState,
  upstream_message_id?: string,
  upstream_model?: string,
): void {
  if (state.messageStartEmitted) return;
  state.messageStartEmitted = true;
  state.onEvent?.({
    kind: ContentBlockEvents.MESSAGE_START,
    ...(upstream_message_id ? { upstream_message_id } : {}),
    ...(upstream_model ? { upstream_model } : {}),
  });
}

/** Emit message_stop —— 整次 LLM 调用结束 / 异常退出时 emit 1 次，幂等。 */
function emitMessageStop(state: BlockEnvelopeState): void {
  if (state.messageStopEmitted) return;
  closeActiveBlock(state);
  state.messageStopEmitted = true;
  state.onEvent?.({ kind: ContentBlockEvents.MESSAGE_STOP });
}

// ─── Config ──────────────────────────────────────────────────────────

export interface ProxyProviderConfig {
  proxyUrl: string;
  /** Static token string or async getter for fresh tokens (supports token refresh). */
  deviceToken: string | (() => Promise<string>);
  agentId?: string;
  /**
   * 业务对话 thread ID（落 `session_id` 字段透传给 wire / proxy）。
   * §17.6 D4：从原 `sessionId` 改名 `threadId`，让命名跟物理含义匹配。
   * 注意：wire 层的 `session_id` HTTP body key 与 `X-TabTin-Session-Id` header
   * 名**不动**（外部 proxy 契约，改名牵动 server 侧）—— 只改本接口字段名。
   */
  threadId?: string;
  /** Organization ID for billing attribution. Required for all non-BYOK LLM calls. */
  organizationId?: string | (() => string | undefined);
  /** Timeout for the entire request in ms (default: 300_000 = 5 min) */
  timeoutMs?: number;
  /** Max retries for retryable errors — 429/502/503/529/network (default: 10) */
  maxRetries?: number;
  /**
   * Base delay for exponential backoff (ms). Default = 500.
   *
   * 暴露这个旋钮的主要动机是 CI 稳定性（H16 Wave 2g）：tests 里设 1～10ms
   * 避免真实 backoff 撞 vitest 默认 5s test timeout；生产默认 500ms 不变。
   *
   * 实际 sleep：`baseDelayMs * 2 ** attempt` + up to `jitterRatio` 抖动，
   * 上限被 `maxDelayMs`（32s 内置常量）钳制。
   */
  retryBaseDelayMs?: number;
  /** Extended thinking token budget. When set, requests include thinking config */
  thinkingBudgetTokens?: number;
  /** Canonical model request params selected by the user; Django maps them per provider. */
  requestParamOverrides?: Record<string, string | number | boolean | null>
    | (() => Record<string, string | number | boolean | null> | undefined);
  /**
   * PRD §5.5：模型能力快照，决定 prompt cache 策略。
   * - `cacheType: 'explicit'` → Claude/Qwen：4 断点 cache_control
   * - `cacheType: 'implicit'` → OpenAI/DeepSeek 等：不加 cache_control，保持前缀稳定
   * - `cacheType: 'none'` / undefined → 不做缓存处理
   */
  modelCapabilities?: ModelCapabilities;
  /**
   * 当前模型是否使用 BYOK（用户自有 API Key）。宿主从模型配置的
   * `provider_scope`（`'organization' | 'user'` 为 BYOK）判定后注入。
   *
   * 消费者：`handleHttpError` 503 分支把此值写入 `details.isByok`，
   * 让 `error-classifier` 的 `LLM_KEY_EXHAUSTED` 分支区分 BYOK 与
   * 平台通道，给用户展示准确的文案。
   */
  isByokMode?: boolean;
  /**
   * 当前会话选中的上下文档位 ID（如 'standard' / 'long_1m'）。
   * 留空 / undefined = 走模型默认档（后端 `is_default=true` 或第一档）。
   *
   * 由宿主从 ChatSession.context_tier_id 读取后注入。每次发请求时才
   * 取值，所以支持函数形式以便在切档后立即生效（无需重建 provider）。
   *
   * 透传链路：buildHeaders → `X-TabTin-Context-Tier` → Django proxy
   * → `tiered_pricing.tiers[i].extra_headers`（如 `anthropic-beta`）
   * → 上游 ZenMux/Claude → 1M 上下文。
   */
  contextTierId?: string | (() => string | undefined);
}

// ─── Retry Configuration ─────────────────────────────────────────────

const GATEWAY_CUT_STATUS = 502

const RETRY_CONFIG = {
  maxRetries: 8,
  initialDelayMs: 500,
  maxDelayMs: 32_000,
  jitterRatio: 0.25,
  retryableStatuses: new Set([429, GATEWAY_CUT_STATUS, 503, 529]),
} as const;

const MAX_529_BEFORE_FALLBACK = 3;

// ─── OpenAI-compatible request types (internal) ──────────────────────

interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * 历史 reasoning 回传（仅 `reasoningHistoryPolicy: 'preserve_for_tools'` +
   * 含 tool_calls 的 assistant 消息）。DeepSeek V4 思考模式工具轮必需，否则上游 400。
   */
  reasoning_content?: string;
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'video_url'; video_url: { url: string } }
  /** Moonshot / Kimi 等 OpenAI-compat 文档 part。 */
  | {
      type: 'file';
      file_url: { url: string };
      file_name?: string;
    };

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface CacheControl {
  type: 'ephemeral';
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  cache_control?: CacheControl;
}

interface OpenAISystemBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  /**
   * 有 tools 时必须显式声明。客户端沉默时 Django wire_adapter 会按
   * `parallel_default` 注入；通义 / Gemini 等会写成 false，模型一轮只出一个工具。
   */
  parallel_tool_calls?: boolean;
  system?: string | OpenAISystemBlock[];
  max_tokens: number;
  temperature?: number;
  stream: true;
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
  model_param_overrides?: Record<string, string | number | boolean | null>;
  [key: string]: unknown;
}

/**
 * 把一个 canonical 参数覆盖写到请求体顶层。
 *
 * **只接受顶层字段名。** 早先这里会把 `reasoning.effort` 这类点分隔 key 展开成
 * 嵌套对象，但 Django proxy 用白名单构造 upstream_body，嵌套键既不在白名单里、
 * 也不被 `_merge_model_param_overrides` 识别，展开结果一路被丢弃 —— 客户端在
 * 假装支持一个服务端不认的契约。
 *
 * 收敛后的分工：客户端只发扁平 canonical 值（顶层字段 + `model_param_overrides`
 * 原样上报），厂商侧的嵌套形态由服务端 wire_adapter 按模型能力生成（那里已有
 * `extra_body.*` 的 nested 解析先例）。
 */
function setRequestParamOverride(
  body: OpenAIRequestBody,
  path: string,
  value: string | number | boolean | null,
): void {
  const key = path.trim();
  if (!key) return;
  if (key.includes('.')) {
    // 不再展开:静默展开会让"配了却不生效"变成看不见的问题。
    // key 仍随 model_param_overrides 上报,服务端可据此排查配置。
    console.warn(
      `[ProxyProvider] 忽略嵌套 param_path "${key}"：客户端只发顶层 canonical 值，`
      + '厂商嵌套形态由服务端 wire_adapter 生成',
    );
    return;
  }
  if (value === null) delete body[key];
  else body[key] = value;
}

function metadataFromRequestParamOverrides(
  overrides?: Record<string, string | number | boolean | null>,
): Pick<LLMRequestMetadata, 'reasoningEffort' | 'serviceTier'> {
  if (!overrides) return {};
  const reasoning = typeof overrides.reasoning_effort === 'string'
    ? overrides.reasoning_effort.trim()
    : '';
  const serviceTier = typeof overrides.service_tier === 'string'
    ? overrides.service_tier.trim()
    : '';
  return {
    ...(reasoning ? { reasoningEffort: reasoning } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

// ─── SSE chunk shape (partial) ──────────────────────────────────────

interface SSEDelta {
  content?: string | null;
  tool_calls?: SSEToolCallDelta[];
  reasoning_content?: string | null;
  reasoning?: string | null;
}

interface SSEToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface SSEChoice {
  index: number;
  delta: SSEDelta;
  finish_reason: string | null;
}

interface SSEChunk {
  id?: string;
  object?: string;
  choices?: SSEChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // Anthropic native SSE fields (when proxy forwards raw format)
  type?: string;
  /**
   * Anthropic native delta 字段。
   * - thinking_delta：thinking 内容增量（已支持）
   * - text_delta：文本内容增量
   * - input_json_delta：tool_use args 流式增量（Widget Wave 1，RFC §4.1）
   *   `partial_json` 是 JSON 片段，可能不完整；上游会逐 token 吐出
   */
  delta?: {
    type?: string;
    thinking?: string;
    text?: string;
    partial_json?: string;
    /** Wave 2：thinking block 的 signature_delta 增量（Anthropic native 路径）。 */
    signature?: string;
    /** Wave 2：Anthropic native message_delta 字段。 */
    stop_reason?: string;
    stop_sequence?: string | null;
  };
  content_block?: { type?: string; id?: string; name?: string };
  /** Anthropic content_block_start / content_block_delta / content_block_stop 的 index */
  index?: number;
  /**
   * W0(v0.2.1)新增:LLMProxy 后端在 stream 内任何 ProxyError /
   * ImageFetchError / 上游 4xx/5xx / timeout 都会 yield 一条
   * `data: {"error": {...}}` chunk 加 `data: [DONE]` 收尾。
   *
   * 后端来源:
   *   - apps/services/llm/services/proxy_service.py:proxy_stream_events
   *     的 except 分支(ProxyError / ImageFetchError / httpx.ReadTimeout /
   *     httpx.HTTPStatusError / Exception)
   *   - apps/services/llm/proxy_api.py:_stream_error_response
   *     view 层 4 处早期错误也走 SSE 流(model_not_found / 配置失败 /
   *     billing 失败 / 流响应创建失败)
   *
   * `message` 已经是中文 user 文案,可直接渲染到 ChatPanel 系统气泡。
   * `technical_detail` 给 admin / 日志 / "查看技术详情" 折叠看(英文)。
   *
   * Wave 3 R-W2-F：`extras` 透传后端 wire_adapter 在 SSE error chunk 上附带的
   * **结构化诊断字段**（`stage` / `reason` / `host` / `failed_count` /
   * `total_count` 等），让前端 error-classifier.fromProxySSE 能基于 stage 做
   * 更精确分类（如 capability_gate vs upstream_error），同时让 telemetry /
   * 失败诊断面板拿到完整原始数据。Renderer 把这块字段一并写到
   * `AgentError.details` 上。
   */
  error?: {
    message?: string;
    user_message?: string;
    type?: string;
    code?: string;
    status?: number;
    technical_detail?: string;
    error_category?: string;
    extras?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

// ─── Tool-call accumulator ──────────────────────────────────────────

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

interface RetryAttemptContext {
  delayMs: number;
  statusCode: number | undefined;
  errorMessage: string;
  isStallRetry: boolean;
}

type UsageResponsePayload = NonNullable<LLMResponseChunk['usage']>;

type CapabilityEventType = 'capability_downgrade' | 'capability_warning';

interface SSEParseContext {
  toolAccumulators: Map<number, ToolCallAccumulator>;
  anthropicToolBlocks: Map<number, { id: string; name: string }>;
  envelopeState: BlockEnvelopeState;
  /** 单次 LLM SSE 流内的 model tool id → TabTin `tu_*` 映射 */
  toolIdMapper: ToolIdMapper;
}

interface SSELineResult {
  currentEventType: string;
  shouldStop: boolean;
}

// ─── Provider ───────────────────────────────────────────────────────

// 整次 LLM 请求（含 SSE streaming）的墙钟上限。
//
// 2026-06-05 dogfood：TabSlide / pitch deck 这类任务会让模型连续生成很大的
// tool input（例如 12 页 slide.html 的 write_file 参数）。旧 300_000ms 会在
// 模型仍持续输出 input_json_delta 时把请求 abort，表现为子 Agent
// `LLM call failed: This operation was aborted`，CLI 还没真正执行。30min 对齐
// 子 Agent 默认执行上限；真正断流仍由 STALL_TIMEOUT_MS（30s 无数据）兜底。
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** 首字节前：空连接 / 立刻断流，30s 够判死。 */
export const INITIAL_STALL_TIMEOUT_MS = 30_000;
/**
 * 已收到 SSE 字节后：glm 等思考模型会在计划文案和 tool_use 之间停几十秒，
 * 30s 会把活流砍掉再整段重拉，界面堆重复「我来做个网站」。
 */
export const MIDSTREAM_STALL_TIMEOUT_MS = 120_000;

export function resolveStallTimeoutMs(hasReceivedStreamByte: boolean): number {
  return hasReceivedStreamByte ? MIDSTREAM_STALL_TIMEOUT_MS : INITIAL_STALL_TIMEOUT_MS;
}

/** @deprecated 仅兼容旧注释/测试文案；实际超时见 resolveStallTimeoutMs */
const STALL_TIMEOUT_MS = INITIAL_STALL_TIMEOUT_MS;

/**
 * 单次 LLM 调用（含全部重试 attempt）的**总墙钟上限**。
 *
 * 背景（无人值守 stall 实测）：单 attempt 已有 `DEFAULT_TIMEOUT_MS`(5min) 兜底，
 * `STALL_TIMEOUT_MS`(30s) 拦「完全无字节」。但「慢速 runaway 流」（上游每 <30s
 * 吐一个 token、永不结束）+ 5min abort 被判 retryable → 重试 → 新一轮 5min 流 …
 * 跨 attempt 累加可达十几分钟，`query.ts` 的 `for await` 始终拿不到正常结束、
 * 永不 `endMessage()` → Django 收不到 `message_stop` → assistant 不落库，最终只能
 * 等 Django forward 的 1800s 外层超时砍断（实测 run d743b9c5 持续 content_block_delta
 * 11+ 分钟、message_ids 全程 0）。
 *
 * 这里给 createStream 的整条重试循环加总时长上限：超过即按 **non-retryable** 终止，
 * 让 query.ts catch 走 `endMessage` → emit `message_stop` → 落库已生成的 partial，
 * 把「挂死 30 分钟」压到本上限内、且结果不再全丢。默认 12 分钟（远大于正常单轮
 * LLM 生成，几乎不会误伤合法长输出）；可用 env `TABTIN_MAX_STREAM_WALL_MS` 调。
 */
const DEFAULT_MAX_TOTAL_STREAM_WALL_MS = 12 * 60 * 1000;

function resolveMaxTotalStreamWallMs(): number {
  const raw = Number(process.env.TABTIN_MAX_STREAM_WALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_TOTAL_STREAM_WALL_MS;
}

const BYOK_ERROR_TYPES = new Set([
  'byok_provider_unavailable',
  'byok_rate_limit_exceeded',
  'byok_quota_exhausted',
  'byok_invalid_key',
]);

const SSE_ERROR_CORE_KEYS = new Set([
  'message',
  'user_message',
  'type',
  'code',
  'status',
  'technical_detail',
  'extras',
]);

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 上游 LLM function name 兼容规范——OpenAI / Anthropic / Moonshot / 主流
 * OpenAI-compatible 代理都强制 `^[a-zA-Z0-9_-]+$` 且长度 ≤ 64。任何点号 / 中文
 * / 特殊字符都会被上游以 HTTP 400 "function name is invalid" 拒绝（Moonshot
 * 实测报文见 WA-F 紧急修复 · 2026-04-19）。
 *
 * 这里做**本地前置校验**：
 * - SSE 上游 400 在 openai-stream 语义里会被某些代理以空 stream + 异常 Content-
 *   Length 返回，导致 reader 静默卡到 STALL_TIMEOUT_MS 才超时——用户感知"对话
 *   卡 30s 没响应"。
 * - 提前在 build body 阶段拦截并抛带 tool name 的 AgentError，开发者第一时间
 *   能看到违规工具名；非 retryable，不会陷入无意义重试。
 * - canonical key 里的冒号（如 `user:code-style-check`）是 skills_read 的
 *   **参数值**，不走 function name 规范，不在本校验范围。
 */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 已退役、且**不得再喂回模型**的历史 FC 名。命中即改写为 `unknown_tool`。
 *
 * ⚠️ 本名单只能收录**当前 registry 里不存在**的名字（ 事故）：
 * 2026-05-04（e958ac8e0）这里曾收录 `read_file` / `write_file` / `delete_file`，
 * 后来三者复用为在役 canonical 工具名（tabcode-adapter 7 件套），名单未同步——
 * 导致每轮请求把模型历史里的成功 `write_file` 调用改写成 `unknown_tool`，
 * kimi-k2.6 看到「自己调了不存在的工具却成功了」陷入纠错死循环（11 连发
 * 同 input write_file，烧 13 分钟直到用户手动 abort）。
 *
 * 防漂移：`tool-description-audit.test.ts` 断言本名单与全量在役 registry
 * 交集为空；改动本名单或复活旧工具名时该测试会失败。
 *
 * @internal 仅导出给 audit 测试；业务代码不要直接引用。
 */
export const RETIRED_MESSAGE_TOOL_NAMES = new Set([
  'bash',
  'web_fetch',
  'plan_exit',
]);

/**
 * 出口防御纵深：对 OpenAI 格式 messages 的 tool_calls.function.name 做兜底净化。
 *
 * **背景（dogfood P0 修复 2026-04-30）**：
 * - 入口 `select-recent-history.ts:sanitizeHistoricalToolName` 已对历史
 *   ToolUseBlock.name 净化（仍存在的点号旧名 → 当前 canonical 名；退休旧名 →
 *   `unknown_tool`）
 * - 但万一未来有第二条历史装填路径（譬如 daemon 直接读 jsonl 而不经过
 *   select-recent-history）绕过入口净化，messages 内的 tool_calls 仍可能
 *   含点号工具名，被 LLM 上游 400 reject（同 dogfood P0 错误模式）
 *
 * **行为设计**（与入口 sanitize 对称）：
 * - 自动 in-place 修复 + 收集 warnings（不抛错）
 * - caller 侧把 warnings 打 telemetry 让我们能监测到 bypass 发生
 * - 跟 `request.tools` 校验（throw）行为不同：messages 是用户历史数据
 *   不可控，throw 会让无辜请求挂；自动 sanitize + warning 是合理折中
 *
 * **复杂度**：每轮请求 O(N_messages × N_tool_calls)，纯字符串扫描，
 * 不影响 hot path。
 *
 * **导出说明**：仅供单元测试访问；外部不应直接调用，由 buildRequestBody
 * 在出口统一接入。如未来需要给其他 provider 复用，可提取到独立 utils。
 *
 * @internal
 */
export function sanitizeOpenAIMessageToolCalls(
  messages: OpenAIMessage[],
): { sanitized: OpenAIMessage[]; warnings: { from: string; to: string }[] } {
  const warnings: { from: string; to: string }[] = [];
  if (!messages?.length) return { sanitized: messages, warnings };
  for (const msg of messages) {
    if (!msg?.tool_calls?.length) continue;
    for (const tc of msg.tool_calls) {
      const name = tc?.function?.name;
      if (typeof name !== 'string' || !name) continue;
      const safe = sanitizeMessageToolName(name);
      if (safe === null) continue;
      tc.function.name = safe;
      warnings.push({ from: name, to: safe });
    }
  }
  return { sanitized: messages, warnings };
}

function sanitizeMessageToolName(name: string): string | null {
  if (TOOL_NAME_RE.test(name)) {
    return RETIRED_MESSAGE_TOOL_NAMES.has(name) ? 'unknown_tool' : null;
  }

  // 与 select-recent-history.ts 的 sanitizeHistoricalToolName 行为对称：
  // 非法字符替换为 `_`，截断到 64；空字符串 fallback 'unknown_tool'
  const candidate = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return candidate && !RETIRED_MESSAGE_TOOL_NAMES.has(candidate)
    ? candidate
    : 'unknown_tool';
}

export class TabTinProxyProvider implements LLMProvider {
  /** 最近一次 billing 尾帧的实际扣费金额（credits）。BYOK 时为 0。 */
  private _lastBillingCredits = 0;
  /** 最近一次 billing 尾帧的扣费状态：'success' | 'failed' | 'byok_exempt' */
  private _lastChargeStatus: string | undefined;
  private _usageReceived = false;
  private consecutive529Count = 0;

  constructor(private config: ProxyProviderConfig) {}

  async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
    const body = this.buildRequestBody(request);
    const maxRetries = this.config.maxRetries ?? RETRY_CONFIG.maxRetries;
    const t0 = Date.now();
    console.warn(`[E2E][LLM] createStream START model=${request.model} msgCount=${request.messages?.length ?? 0} source=${request.requestSource}`);

    // Wave 2：本次 LLM 调用的 envelope state（content_block 三件套 + message_delta 累积）。
    // attempt 之间 reset：失败 attempt 已 emit 的 envelope 视为"作废"——query.ts 的
    // stall_retry pending 路径会在下一个 success chunk 到达时 emit `message_stop
    // (stop_reason='aborted')` + 新一轮 `message_start` 把作废 message 收口（新协议
    // 下 CONTENT_RESET 的等价行为）。proxy-provider 不主动 emit 跨 attempt 收口事件。
    const envelopeState = createBlockEnvelopeState(request.onContentBlockEvent);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        this.resetAttemptEnvelopeState(envelopeState);
        const token = await this.resolveToken();
        const headers = this.buildHeaders(request, token, attempt);
        if (attempt > 0) console.warn(`[E2E][LLM] retry attempt=${attempt}`);
        yield* this.doRequest(body, headers, envelopeState, attempt, request.signal);
        // 流自然结束：兜底 close 残留 active block（绝大多数 provider 会主动发
        // content_block_stop / [DONE]，此处是防御）。
        closeActiveBlock(envelopeState);
        this.consecutive529Count = 0;
        console.warn(`[E2E][LLM] createStream DONE elapsed=${Date.now() - t0}ms`);
        return;
      } catch (err) {
        this.handle529State(err, request);

        // 总墙钟上限：跨 attempt 累计超时即终止（non-retryable），防「慢速 runaway 流
        // 反复重试」无限拖（详见 MAX_TOTAL_STREAM_WALL_MS 注释）。放在重试判定前，
        // 让它优先于「还能再重试」的判断生效。
        this.throwIfTotalWallTimeExceeded(err, request, attempt, Date.now() - t0);

        if (!isRetryableError(err) || attempt >= maxRetries) {
          this.emitRetryExhaustedIfNeeded(err, request, attempt, maxRetries);
          throw err;
        }

        const retryContext = this.buildRetryAttemptContext(err, attempt);
        this.emitRetryAttemptTelemetry(retryContext, request, attempt, maxRetries);
        this.notifyRetryAttempt(retryContext, request, attempt, maxRetries);
        await sleep(retryContext.delayMs);
      }
    }
  }

  getRequestMetadata(_request: LLMRequest): LLMRequestMetadata {
    const contextTierId = typeof this.config.contextTierId === 'function'
      ? this.config.contextTierId()
      : this.config.contextTierId;
    return {
      providerChannel: this.config.isByokMode ? 'byok_proxy' : 'platform_proxy',
      ...(this.config.isByokMode !== undefined ? { isByokMode: this.config.isByokMode } : {}),
      ...(contextTierId ? { contextTierId } : {}),
      ...metadataFromRequestParamOverrides(this.resolveRequestParamOverrides()),
    };
  }

  private resetAttemptEnvelopeState(envelopeState: BlockEnvelopeState): void {
    // 重置 envelope state：上一轮 attempt 已 emit 的 content_block_* 由 query.ts
    // 通过 stall_retry 路径处理；这里清本地累积器 + 重置 message 级 flag，让
    // attempt N+1 重新 emit message_start（视为新一次 LLM 输出）。attempt N
    // 失败时 finally 已 emit `message_delta(aborted) + message_stop` 关闭旧 message，
    // 故 attempt N+1 的新 message_id 由 query.ts 据 hint 重新生成。
    envelopeState.blockIndex = -1;
    envelopeState.activeKind = null;
    envelopeState.activeBlockId = null;
    envelopeState.anthropicIndex.clear();
    envelopeState.openaiToolEmitted.clear();
    envelopeState.messageStartEmitted = false;
    envelopeState.messageDeltaEmitted = false;
    envelopeState.messageStopEmitted = false;
    if (envelopeState.thinkTagScan) {
      envelopeState.thinkTagScan = createThinkTagScanState();
    }
    envelopeState.sawOpenAIReasoning = false;
  }

  private handle529State(err: unknown, request: LLMRequest): void {
    if (!(err instanceof AgentError) || err.statusCode !== 529) {
      this.consecutive529Count = 0;
      return;
    }

    if (!shouldRetry529ForSource(request.requestSource)) {
      emitTelemetryEvent(TelemetryEvents.ERROR_529_BACKGROUND_BAIL, {
        model: request.model,
        requestSource: request.requestSource,
      });
      throw new AgentError('529 overload — background task bailing', 'LLM_ERROR', {
        statusCode: 529,
        retryable: false,
        details: { needsFallback: false, backgroundBail: true },
      });
    }

    this.consecutive529Count++;
    if (this.consecutive529Count < MAX_529_BEFORE_FALLBACK) return;
    throw new AgentError('529 overload threshold reached', 'LLM_ERROR', {
      statusCode: 529,
      retryable: false,
      details: { needsFallback: true },
    });
  }

  private throwIfTotalWallTimeExceeded(
    err: unknown,
    request: LLMRequest,
    attempt: number,
    elapsedMs: number,
  ): void {
    const maxWallMs = resolveMaxTotalStreamWallMs();
    if (elapsedMs <= maxWallMs) return;

    emitTelemetryEvent(TelemetryEvents.ERROR_RETRY_EXHAUSTED, {
      attempts: attempt + 1,
      model: request.model,
      statusCode: err instanceof AgentError ? err.statusCode : undefined,
    });
    console.warn(`[E2E][LLM] createStream WALL-TIMEOUT elapsed=${elapsedMs}ms cap=${maxWallMs}ms — terminating (non-retryable)`);
    throw new AgentError(
      `LLM stream exceeded total wall-time budget (${Math.round(elapsedMs / 1000)}s > ${Math.round(maxWallMs / 1000)}s); terminating to avoid unbounded hang`,
      'LLM_ERROR',
      { retryable: false, details: { wallTimeout: true, elapsedMs } },
    );
  }

  private emitRetryExhaustedIfNeeded(
    err: unknown,
    request: LLMRequest,
    attempt: number,
    maxRetries: number,
  ): void {
    if (attempt < maxRetries || !isRetryableError(err)) return;
    emitTelemetryEvent(TelemetryEvents.ERROR_RETRY_EXHAUSTED, {
      attempts: attempt + 1,
      model: request.model,
      statusCode: err instanceof AgentError ? err.statusCode : undefined,
    });
  }

  private buildRetryAttemptContext(err: unknown, attempt: number): RetryAttemptContext {
    const baseDelayMs = this.config.retryBaseDelayMs ?? RETRY_CONFIG.initialDelayMs;
    let delayMs = baseDelayMs * 2 ** attempt;
    const retryAfter = parseRetryAfterMs(err);
    if (retryAfter !== null) delayMs = Math.max(delayMs, retryAfter);
    delayMs = Math.min(delayMs, RETRY_CONFIG.maxDelayMs);
    delayMs += Math.random() * delayMs * RETRY_CONFIG.jitterRatio;

    return {
      delayMs,
      statusCode: err instanceof AgentError ? err.statusCode : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
      isStallRetry: err instanceof AgentError && err.details?.stall === true,
    };
  }

  private emitRetryAttemptTelemetry(
    retryContext: RetryAttemptContext,
    request: LLMRequest,
    attempt: number,
    maxRetries: number,
  ): void {
    if (retryContext.isStallRetry) {
      emitTelemetryEvent(TelemetryEvents.ERROR_STALL_DETECTED, {
        model: request.model,
        attempt: attempt + 1,
      });
    }

    emitTelemetryEvent(TelemetryEvents.ERROR_RETRY_ATTEMPT, {
      attempt: attempt + 1,
      maxRetries,
      delayMs: Math.round(retryContext.delayMs),
      statusCode: retryContext.statusCode,
      model: request.model,
      requestSource: request.requestSource,
    });
  }

  private notifyRetryAttempt(
    retryContext: RetryAttemptContext,
    request: LLMRequest,
    attempt: number,
    maxRetries: number,
  ): void {
    if (!request.onRetryAttempt) return;
    request.onRetryAttempt({
      attempt: attempt + 1,
      maxRetries,
      delayMs: Math.round(retryContext.delayMs),
      statusCode: retryContext.statusCode,
      errorMessage: retryContext.errorMessage,
      isStallRetry: retryContext.isStallRetry,
    });
  }

  getLastBillingCredits(): number {
    return this._lastBillingCredits;
  }

  getLastChargeStatus(): string | undefined {
    return this._lastChargeStatus;
  }

  // ─── Internal: single request attempt ─────────────────────────────

  private async *doRequest(
    body: OpenAIRequestBody,
    headers: Record<string, string>,
    envelopeState: BlockEnvelopeState,
    attempt: number,
    externalSignal?: AbortSignal,
  ): AsyncIterable<LLMResponseChunk> {
    this._usageReceived = false;
    if (externalSignal?.aborted) {
      throw new AgentError('Run aborted', 'ABORT');
    }
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    // 用户停止 vs 本请求超时：共用 fetch controller；用 externalSignal.aborted 区分。
    const onExternalAbort = (): void => {
      controller.abort(externalSignal?.reason);
    };
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const reqT0 = Date.now();
    console.warn(`[E2E][LLM] HTTP POST ${this.config.proxyUrl} timeout=${timeoutMs}ms`);

    let response: Response;
    try {
      response = await fetch(this.config.proxyUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - reqT0;
      console.warn(`[E2E][LLM] HTTP response status=${response.status} elapsed=${elapsedMs}ms`);
      const requestId = response.headers.get('x-tabtin-request-id') ?? undefined;
      this.emitLlmTimingTelemetry({
        phase: 'proxy_http_response',
        elapsedMs,
        requestId,
        attempt,
        model: body.model,
      });
      yield {
        type: 'timing',
        timing: {
          source: 'proxy_provider',
          phase: 'proxy_http_response',
          elapsed_ms: elapsedMs,
          request_id: requestId,
          attempt,
          model: body.model,
          extras: { http_status: response.status },
        },
      };
    } catch (err) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      if (isFetchAbortError(err)) {
        if (externalSignal?.aborted) {
          throw new AgentError('Run aborted', 'ABORT');
        }
        throw new AgentError('LLM request timed out', 'LLM_ERROR', {
          retryable: true,
          details: { timeoutMs },
        });
      }
      throw new AgentError(
        `LLM proxy unreachable: ${err instanceof Error ? err.message : String(err)}`,
        'LLM_ERROR',
        { retryable: true, details: { networkError: true } },
      );
    }

    if (!response.ok) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      await this.handleHttpError(response, body);
    }

    try {
      yield* this.parseSSEStream(response, envelopeState, body.model, externalSignal);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private emitLlmTimingTelemetry(args: {
    phase: string;
    durationMs?: number;
    elapsedMs?: number;
    requestId?: string;
    attempt?: number;
    model: string;
    extras?: Record<string, unknown>;
  }): void {
    emitTelemetryEvent(
      TelemetryEvents.LLM_TIMING,
      {
        phase: args.phase,
        model: args.model,
        source: 'proxy_provider',
        ...(typeof args.durationMs === 'number' ? { duration_ms: Math.round(args.durationMs) } : {}),
        ...(typeof args.elapsedMs === 'number' ? { elapsed_ms: Math.round(args.elapsedMs) } : {}),
        ...(args.requestId ? { request_id: args.requestId } : {}),
        ...(typeof args.attempt === 'number' ? { attempt: args.attempt } : {}),
        ...(args.extras ? { extras: args.extras } : {}),
      },
      {
        ...(this.config.threadId ? { session_id: this.config.threadId } : {}),
        ...(this.config.agentId ? { agent_id: this.config.agentId } : {}),
      },
    );
  }

  // ─── SSE stream parsing ───────────────────────────────────────────

  private async *parseSSEStream(
    response: Response,
    envelopeState: BlockEnvelopeState,
    model: string,
    externalSignal?: AbortSignal,
  ): AsyncIterable<LLMResponseChunk> {
    const body = response.body;
    if (!body) {
      throw new AgentError('Empty response body from LLM proxy', 'LLM_ERROR');
    }

    const context: SSEParseContext = {
      toolAccumulators: new Map<number, ToolCallAccumulator>(),
      // Widget Wave 1：Anthropic native tool_use 块的 (id, name) 索引——
      // content_block_start 时记录、content_block_delta 时复用、content_block_stop 时清理。
      anthropicToolBlocks: new Map<number, { id: string; name: string }>(),
      envelopeState,
      // ：上游 `{name}_{n}` 会在长会话回绕撞号；本流内映射为 TabTin 权威 id。
      toolIdMapper: new ToolIdMapper(),
    };
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType = '';
    let firstBodyByteAt: number | undefined;
    let hasReceivedStreamByte = false;
    const parseStartedAt = Date.now();

    const readWithStallCheck = (): Promise<{ done: boolean; value?: Uint8Array }> =>
      new Promise((resolve, reject) => {
        const stallTimeoutMs = resolveStallTimeoutMs(hasReceivedStreamByte);
        const timer = setTimeout(() => {
          reader.cancel().catch(() => {});
          reject(
            new AgentError(
              `LLM stream stalled (no data for ${stallTimeoutMs / 1000}s)`,
              'LLM_ERROR',
              { retryable: true, details: { retryable: true, stall: true } },
            ),
          );
        }, stallTimeoutMs);
        reader.read().then(
          (result) => { clearTimeout(timer); resolve(result); },
          (err: unknown) => {
            clearTimeout(timer);
            if (err instanceof AgentError) {
              reject(err);
              return;
            }
            // 用户停止会 abort fetch → reader.read 以 AbortError 拒绝；不可当断网重试。
            // 本请求超时 abort 也是 AbortError，但 externalSignal 未 aborted → 走 timeout。
            if (externalSignal?.aborted) {
              reject(new AgentError('Run aborted', 'ABORT'));
              return;
            }
            if (isFetchAbortError(err)) {
              reject(new AgentError('LLM request timed out', 'LLM_ERROR', {
                retryable: true,
                details: { timeout: true },
              }));
              return;
            }
            //  P0：流中途断网 / 连接被杀时，undici 抛的是原生错误
            // （`TypeError: terminated`、cause=ECONNRESET/ENETDOWN 等），不是
            // AgentError → isRetryableError 第一行直接判 non-retryable，整轮
            // 立即失败，重试机制根本没启动——网络恢复后自然"不继续输出"。
            // 这里包成 retryable + stall 语义：stall=true 让 query.ts 走既有
            // stall-retry 恢复路径（重试成功后重置 partial 累积 + 切新 message
            // 边界），connectionLost=true 供 telemetry 与真·30s 无数据 stall
            // 区分。真正的不可恢复场景仍由重试预算 / 总墙钟上限兜底终止。
            reject(
              new AgentError(
                `LLM stream connection lost: ${err instanceof Error ? err.message : String(err)}`,
                'LLM_ERROR',
                {
                  retryable: true,
                  details: {
                    retryable: true,
                    stall: true,
                    connectionLost: true,
                    networkError: true,
                  },
                },
              ),
            );
          },
        );
      });

    // Wave 2 envelope: 整次 LLM 调用最早 emit 一次 message_start。
    // upstream_message_id / upstream_model 这里还没拿到（要等第一个 chunk），所以
    // 先 emit "光秃秃"的 message_start（hint 仅含 kind），query.ts 接 hint 时
    // 已用 randomUUID 给 message_id 兜底。后续如果首个 chunk 拿到上游 id，
    // 通过 query.ts 的 message_delta / message_stop 路径携带出去（暂未启用，
    // 为简化保持 W2 范围内 message_id 即 randomUUID）。
    emitMessageStart(envelopeState);
    if (isMiniMaxOpenAIThinkTagModel(model)) {
      envelopeState.thinkTagScan ??= createThinkTagScanState();
    }

    try {
      for (;;) {
        const { done, value } = await readWithStallCheck();
        if (done) break;
        if (value && value.byteLength > 0) hasReceivedStreamByte = true;
        if (firstBodyByteAt === undefined) {
          firstBodyByteAt = Date.now();
          const elapsedMs = firstBodyByteAt - parseStartedAt;
          const requestId = response.headers.get('x-tabtin-request-id') ?? undefined;
          this.emitLlmTimingTelemetry({
            phase: 'proxy_http_response_to_first_sse_byte',
            elapsedMs,
            requestId,
            model,
          });
          yield {
            type: 'timing',
            timing: {
              source: 'proxy_provider',
              phase: 'proxy_http_response_to_first_sse_byte',
              elapsed_ms: elapsedMs,
              request_id: requestId,
              model,
            },
          };
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const lineResult = yield* this.processSSELine(line, currentEventType, context);
          currentEventType = lineResult.currentEventType;
          if (lineResult.shouldStop) return;
        }
      }

      yield* this.processTrailingSSEBuffer(buffer, context);

      yield* this.flushOpenAIThinkTagHold(envelopeState);
      yield* this.flushToolAccumulators(context.toolAccumulators, envelopeState);
      // Wave 2 envelope: stream 自然结束（无 [DONE] 标记，少数兼容路径下会发生），
      // 也要 emit message_stop。emitMessageStop 已是幂等（messageStopEmitted 守卫），
      // 所以即使前面 [DONE] 路径已经 emit 过，这里再次调用是 no-op。
      emitMessageStop(envelopeState);
    } finally {
      // 异常路径下补 message_delta(stop_reason) + message_stop 收口。
      // ：仅用户 abort（externalSignal.aborted）打 `aborted`；
      // 账单/解析/stall 等业务失败打 `error`，避免 UI 把空壳当「用户中断」藏掉。
      // 幂等守卫 `messageStopEmitted` 保证正常退出路径已 emit 过的不会重复触发。
      // 用户 abort / for-await 早退：主动 cancel reader，真正关掉上游 body，
      // 而不是只 releaseLock（否则 HTTP 可能仍挂着继续收 SSE）。
      try { await reader.cancel(); } catch { /* already closed / cancelled */ }
      try { reader.releaseLock(); } catch { /* may be locked after stall cancel */ }
      if (!envelopeState.messageStopEmitted) {
        const stopReason = externalSignal?.aborted ? 'aborted' : 'error';
        emitMessageDelta(envelopeState, { stop_reason: stopReason });
        emitMessageStop(envelopeState);
      }
    }
  }

  private *processSSELine(
    line: string,
    currentEventType: string,
    context: SSEParseContext,
  ): Generator<LLMResponseChunk, SSELineResult, undefined> {
    const trimmed = line.trim();
    if (trimmed.startsWith(':')) {
      yield* this.processSSEComment(trimmed);
      return { currentEventType, shouldStop: false };
    }
    if (trimmed === '') return { currentEventType: '', shouldStop: false };
    if (trimmed.startsWith('event:')) {
      return { currentEventType: trimmed.slice(6).trim(), shouldStop: false };
    }
    if (!trimmed.startsWith('data:')) return { currentEventType, shouldStop: false };

    const payload = trimmed.slice(5).trim();
    if (currentEventType === 'tabtin.billing') {
      yield* this.processBillingEvent(payload);
      return { currentEventType: '', shouldStop: false };
    }
    if (isCapabilityEventType(currentEventType)) {
      yield* processCapabilityEvent(currentEventType, payload);
      return { currentEventType: '', shouldStop: false };
    }

    return yield* this.processSSEDataPayload(payload, context);
  }

  private *processSSEComment(commentLine: string): Generator<LLMResponseChunk, void, undefined> {
    const prefix = ': tabtin_timing ';
    if (!commentLine.startsWith(prefix)) return;
    try {
      const payload = JSON.parse(commentLine.slice(prefix.length)) as {
        phase?: unknown;
        duration_ms?: unknown;
        elapsed_ms?: unknown;
        request_id?: unknown;
        model?: unknown;
        extras?: unknown;
      };
      if (typeof payload.phase !== 'string' || payload.phase.length === 0) return;
      yield {
        type: 'timing',
        timing: {
          source: 'django_proxy',
          phase: payload.phase,
          ...(typeof payload.duration_ms === 'number' ? { duration_ms: payload.duration_ms } : {}),
          ...(typeof payload.elapsed_ms === 'number' ? { elapsed_ms: payload.elapsed_ms } : {}),
          ...(typeof payload.request_id === 'string' ? { request_id: payload.request_id } : {}),
          ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
          ...(payload.extras && typeof payload.extras === 'object'
            ? { extras: payload.extras as Record<string, unknown> }
            : {}),
        },
      };
    } catch {
      // Ignore malformed diagnostics comments; model streaming must stay fail-open.
    }
  }

  private *processBillingEvent(payload: string): Generator<LLMResponseChunk, void, undefined> {
    type BillingTailPayload = {
      credits_charged?: number;
      charge_status?: string;
      error_category?: string;
      is_byok?: boolean;
      usage?: { total_tokens?: number };
    };
    let billing: BillingTailPayload | null = null;
    try {
      billing = JSON.parse(payload) as BillingTailPayload;
    } catch { /* ignore malformed billing */ }
    if (!billing) return;

    const charged = typeof billing.credits_charged === 'number'
      ? billing.credits_charged : 0;
    this._lastBillingCredits = charged;
    this._lastChargeStatus = billing.charge_status;
    if (charged > 0) {
      yield { type: 'usage' as const, usage: { cost_usd: charged, charge_status: billing.charge_status } };
    } else if (billing.charge_status === 'failed') {
      yield { type: 'usage' as const, usage: { cost_usd: 0, charge_status: 'failed' } };
      // 默认按结算基础设施失败处理（schema 漂移 / DB 写失败等）；
      // 仅当尾帧显式带余额/预算类 error_category 时才走不可重试的充值引导。
      const errorCategory = typeof billing.error_category === 'string' && billing.error_category.trim()
        ? billing.error_category.trim()
        : 'billing_charge_failed';
      throw buildBillingTailFailureError(errorCategory);
    } else if (billing.charge_status) {
      // P1-1: BYOK 等路径 charged=0 但 charge_status 有值（如 'byok_exempt'），仍需透传
      yield { type: 'usage' as const, usage: { cost_usd: 0, charge_status: billing.charge_status } };
    }
  }

  private *processSSEDataPayload(
    payload: string,
    context: SSEParseContext,
  ): Generator<LLMResponseChunk, SSELineResult, undefined> {
    if (payload === '[DONE]') {
      yield* this.flushToolAccumulators(context.toolAccumulators, context.envelopeState);
      // Wave 2 envelope: 干净结束路径——emit message_stop 收尾。
      emitMessageStop(context.envelopeState);
      return { currentEventType: '', shouldStop: true };
    }

    let chunk: SSEChunk;
    try {
      chunk = JSON.parse(payload) as SSEChunk;
    } catch {
      return { currentEventType: '', shouldStop: false };
    }

    yield* this.processChunk(chunk, context);
    return { currentEventType: '', shouldStop: false };
  }

  private *processTrailingSSEBuffer(
    buffer: string,
    context: SSEParseContext,
  ): Generator<LLMResponseChunk, void, undefined> {
    const trimmed = buffer.trim();
    if (!trimmed.startsWith('data:')) return;

    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return;
    try {
      const chunk = JSON.parse(payload) as SSEChunk;
      yield* this.processChunk(chunk, context);
    } catch {
      // ignore malformed trailing data
    }
  }

  // ─── Chunk → LLMResponseChunk mapping ─────────────────────────────

  private *processChunk(
    chunk: SSEChunk,
    context: SSEParseContext,
  ): Iterable<LLMResponseChunk> {
    // ── W0 (v0.2.1):后端 LLMProxy 在 stream 内任何错误(ProxyError /
    // ImageFetchError / 上游 4xx/5xx / timeout / 内部异常)都 yield 一条
    // `{ error: { message, type, status, technical_detail } }` chunk + [DONE]。
    // 早先版本的客户端不识别这条分支,导致 reader 等不到 stop / usage,触发 30s
    // STALL_TIMEOUT_MS 然后进入指数退避重试(默认 8 次),累计可达 1m54s
    // (dogfood session `97f046f1-...` 现象)。
    //
    // 修复:识别后立刻抛 AgentError,让 react loop 走错误路径。
    // 账单 / 业务终态仍 non-retryable；429/502/503/529 由 isRetryableError 放行退避。
    this.throwIfProxySSEError(chunk);

    yield* this.processAnthropicNativeChunk(
      chunk,
      context.anthropicToolBlocks,
      context.envelopeState,
      context.toolIdMapper,
    );

    const choice = chunk.choices?.[0];

    if (choice) {
      yield* this.processOpenAIChoice(
        choice,
        context.toolAccumulators,
        context.envelopeState,
        context.toolIdMapper,
      );
    }

    yield* this.processUsageChunk(chunk, context.envelopeState);
  }

  private throwIfProxySSEError(chunk: SSEChunk): void {
    if (!chunk.error) return;

    const userMessage = readString(chunk.error.user_message)
      ?? readString(chunk.error.message)
      ?? 'LLM proxy error';
    const extras = collectProxySSEErrorExtras(chunk.error);
    const errorType = resolveProxySSEErrorType(chunk.error, extras);
    const status = chunk.error.status;
    const isUpstreamRateLimit = isProxySSEUpstreamRateLimitError(
      errorType,
      status,
      userMessage,
    );
    const errorCode = isProxySSEBillingError(errorType)
      ? 'LLM_BILLING_ERROR'
      : isUpstreamRateLimit
        ? 'LLM_RATE_LIMIT'
        : 'LLM_ERROR';
    const resolvedStatus = isUpstreamRateLimit ? (status ?? 429) : status;
    const transientOverload = resolvedStatus !== undefined
      && RETRY_CONFIG.retryableStatuses.has(resolvedStatus);
    const gatewayCut = resolvedStatus === GATEWAY_CUT_STATUS
      && errorCode !== 'LLM_BILLING_ERROR';

    // Wave 3 R-W2-F：把后端 SSE error chunk 上的结构化 extras 字段透传到
    // AgentError.details；固定字段写在 spread 后，避免 extras 同名键污染本地契约。
    throw new AgentError(userMessage, errorCode, {
      statusCode: resolvedStatus,
      retryable: transientOverload && errorCode !== 'LLM_BILLING_ERROR',
      details: {
        ...extras,
        user_message: userMessage,
        technical_detail: chunk.error.technical_detail,
        error_type: errorType,
        fromProxySSE: true,
        ...(gatewayCut
          ? { retryable: true, stall: true, connectionLost: true, networkError: true }
          : {}),
      },
    });
  }

  private *processAnthropicNativeChunk(
    chunk: SSEChunk,
    anthropicToolBlocks: Map<number, { id: string; name: string }>,
    envelopeState: BlockEnvelopeState,
    toolIdMapper: ToolIdMapper,
  ): Generator<LLMResponseChunk, void, undefined> {
    yield* this.processAnthropicThinkingDelta(chunk, envelopeState);
    this.processAnthropicSignatureDelta(chunk, envelopeState);
    yield* this.processAnthropicTextDelta(chunk, envelopeState);
    this.processAnthropicToolStart(chunk, anthropicToolBlocks, envelopeState, toolIdMapper);
    yield* this.processAnthropicToolDelta(chunk, anthropicToolBlocks, envelopeState);
    this.processAnthropicToolStop(chunk, anthropicToolBlocks, envelopeState);
    this.processAnthropicMessageDelta(chunk, envelopeState);
  }

  private *processAnthropicThinkingDelta(
    chunk: SSEChunk,
    envelopeState: BlockEnvelopeState,
  ): Generator<LLMResponseChunk, void, undefined> {
    if (chunk.type !== 'content_block_delta' || chunk.delta?.type !== 'thinking_delta' || !chunk.delta.thinking) return;

    yield { type: 'thinking', text: chunk.delta.thinking };
    // Wave 2 envelope: 自动切到 thinking active block + emit thinking_delta。
    if (envelopeState.activeKind !== 'thinking') {
      startBlock(envelopeState, 'thinking', { type: 'thinking', thinking: '', signature: '' });
    }
    emitBlockDelta(envelopeState, { type: 'thinking_delta', thinking: chunk.delta.thinking });
  }

  private processAnthropicSignatureDelta(chunk: SSEChunk, envelopeState: BlockEnvelopeState): void {
    if (chunk.type !== 'content_block_delta'
        || chunk.delta?.type !== 'signature_delta'
        || typeof chunk.delta.signature !== 'string'
        || envelopeState.activeKind !== 'thinking') return;
    emitBlockDelta(envelopeState, { type: 'signature_delta', signature: chunk.delta.signature });
  }

  private *processAnthropicTextDelta(
    chunk: SSEChunk,
    envelopeState: BlockEnvelopeState,
  ): Generator<LLMResponseChunk, void, undefined> {
    if (chunk.type !== 'content_block_delta'
        || chunk.delta?.type !== 'text_delta'
        || typeof chunk.delta.text !== 'string'
        || chunk.delta.text.length === 0
        || chunk.choices) return;

    yield { type: 'text_delta', text: chunk.delta.text };
    if (envelopeState.activeKind !== 'text') {
      startBlock(envelopeState, 'text', { type: 'text', text: '' });
    }
    emitBlockDelta(envelopeState, { type: 'text_delta', text: chunk.delta.text });
  }

  private processAnthropicToolStart(
    chunk: SSEChunk,
    anthropicToolBlocks: Map<number, { id: string; name: string }>,
    envelopeState: BlockEnvelopeState,
    toolIdMapper: ToolIdMapper,
  ): void {
    if (chunk.type !== 'content_block_start'
        || chunk.content_block?.type !== 'tool_use'
        || typeof chunk.index !== 'number') return;

    const id = toolIdMapper.allocate(chunk.content_block.id);
    const name = chunk.content_block.name ?? '';
    anthropicToolBlocks.set(chunk.index, { id, name });
    const { index: myIdx } = startBlock(
      envelopeState,
      'tool_use',
      { type: 'tool_use', id, name, input: {} },
      id,
    );
    envelopeState.anthropicIndex.set(chunk.index, {
      myIndex: myIdx,
      toolUseId: id,
      emittedDelta: false,
    });
  }

  private *processAnthropicToolDelta(
    chunk: SSEChunk,
    anthropicToolBlocks: Map<number, { id: string; name: string }>,
    envelopeState: BlockEnvelopeState,
  ): Generator<LLMResponseChunk, void, undefined> {
    if (chunk.type !== 'content_block_delta'
        || chunk.delta?.type !== 'input_json_delta'
        || typeof chunk.delta.partial_json !== 'string'
        || typeof chunk.index !== 'number') return;

    const meta = anthropicToolBlocks.get(chunk.index);
    if (!meta || !chunk.delta.partial_json) return;
    yield {
      type: 'tool_use_delta',
      toolUseDelta: {
        id: meta.id,
        name: meta.name,
        argDelta: chunk.delta.partial_json,
      },
    };
    this.emitAnthropicToolInputDelta(chunk.index, chunk.delta.partial_json, envelopeState);
  }

  private emitAnthropicToolInputDelta(
    chunkIndex: number,
    partialJson: string,
    envelopeState: BlockEnvelopeState,
  ): void {
    const tracked = envelopeState.anthropicIndex.get(chunkIndex);
    if (!tracked
        || envelopeState.activeKind !== 'tool_use'
        || envelopeState.blockIndex !== tracked.myIndex) return;
    emitBlockDelta(envelopeState, { type: 'input_json_delta', partial_json: partialJson });
    tracked.emittedDelta = true;
  }

  private processAnthropicToolStop(
    chunk: SSEChunk,
    anthropicToolBlocks: Map<number, { id: string; name: string }>,
    envelopeState: BlockEnvelopeState,
  ): void {
    if (chunk.type !== 'content_block_stop' || typeof chunk.index !== 'number') return;

    anthropicToolBlocks.delete(chunk.index);
    const tracked = envelopeState.anthropicIndex.get(chunk.index);
    if (tracked
        && envelopeState.activeKind === 'tool_use'
        && envelopeState.blockIndex === tracked.myIndex) {
      closeActiveBlock(envelopeState);
    }
    envelopeState.anthropicIndex.delete(chunk.index);
  }

  private processAnthropicMessageDelta(chunk: SSEChunk, envelopeState: BlockEnvelopeState): void {
    if (chunk.type !== 'message_delta') return;

    const stopReason = (chunk as unknown as { delta?: { stop_reason?: string; stop_sequence?: string | null } })
      .delta?.stop_reason;
    const stopSequence = (chunk as unknown as { delta?: { stop_reason?: string; stop_sequence?: string | null } })
      .delta?.stop_sequence ?? null;
    const usageRaw = (chunk as unknown as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
    const usage: MessageUsage | undefined = usageRaw && typeof usageRaw.input_tokens === 'number' && typeof usageRaw.output_tokens === 'number'
      ? {
          input_tokens: usageRaw.input_tokens,
          output_tokens: usageRaw.output_tokens,
          ...(usageRaw.cache_read_input_tokens != null
            ? { cache_read_input_tokens: usageRaw.cache_read_input_tokens } : {}),
          ...(usageRaw.cache_creation_input_tokens != null
            ? { cache_creation_input_tokens: usageRaw.cache_creation_input_tokens } : {}),
        }
      : undefined;
    closeActiveBlock(envelopeState);
    emitMessageDelta(envelopeState, { stop_reason: stopReason, stop_sequence: stopSequence }, usage);
  }

  private *processOpenAIChoice(
    choice: SSEChoice,
    toolAccumulators: Map<number, ToolCallAccumulator>,
    envelopeState: BlockEnvelopeState,
    toolIdMapper: ToolIdMapper,
  ): Generator<LLMResponseChunk, void, undefined> {
    yield* this.processOpenAITextDeltas(choice.delta, envelopeState);
    yield* this.processOpenAIToolCalls(choice.delta, toolAccumulators, envelopeState, toolIdMapper);
    yield* this.processOpenAIFinishReason(choice, toolAccumulators, envelopeState);
  }

  private *processOpenAITextDeltas(
    delta: SSEDelta,
    envelopeState: BlockEnvelopeState,
  ): Generator<LLMResponseChunk, void, undefined> {
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning) {
      envelopeState.sawOpenAIReasoning = true;
      yield* this.emitOpenAITextOrThinking('thinking', reasoning, envelopeState);
    }

    if (!delta.content) return;
    if (!envelopeState.thinkTagScan) {
      yield* this.emitOpenAITextOrThinking('text', delta.content, envelopeState);
      return;
    }
    for (const segment of pushThinkTagScan(envelopeState.thinkTagScan, delta.content)) {
      if (segment.kind === 'thinking' && envelopeState.sawOpenAIReasoning) continue;
      yield* this.emitOpenAITextOrThinking(segment.kind, segment.text, envelopeState);
    }
  }

  private *flushOpenAIThinkTagHold(
    envelopeState: BlockEnvelopeState,
  ): Generator<LLMResponseChunk, void, undefined> {
    if (!envelopeState.thinkTagScan) return;
    for (const segment of flushThinkTagScan(envelopeState.thinkTagScan)) {
      yield* this.emitOpenAITextOrThinking(segment.kind, segment.text, envelopeState);
    }
  }

  private *emitOpenAITextOrThinking(
    kind: ThinkTagSegment['kind'],
    text: string,
    envelopeState: BlockEnvelopeState,
  ): Generator<LLMResponseChunk, void, undefined> {
    if (!text) return;
    if (kind === 'thinking') {
      yield { type: 'thinking', text };
      if (envelopeState.activeKind !== 'thinking') {
        startBlock(envelopeState, 'thinking', { type: 'thinking', thinking: '', signature: '' });
      }
      emitBlockDelta(envelopeState, { type: 'thinking_delta', thinking: text });
      return;
    }
    yield { type: 'text_delta', text };
    if (envelopeState.activeKind !== 'text') {
      startBlock(envelopeState, 'text', { type: 'text', text: '' });
    }
    emitBlockDelta(envelopeState, { type: 'text_delta', text });
  }

  private *processOpenAIToolCalls(
    delta: SSEDelta,
    toolAccumulators: Map<number, ToolCallAccumulator>,
    envelopeState: BlockEnvelopeState,
    toolIdMapper: ToolIdMapper,
  ): Generator<LLMResponseChunk, void, undefined> {
    if (!delta.tool_calls) return;
    for (const tc of delta.tool_calls) {
      yield* this.processOpenAIToolCall(tc, toolAccumulators, envelopeState, toolIdMapper);
    }
  }

  private *processOpenAIToolCall(
    tc: SSEToolCallDelta,
    toolAccumulators: Map<number, ToolCallAccumulator>,
    envelopeState: BlockEnvelopeState,
    toolIdMapper: ToolIdMapper,
  ): Generator<LLMResponseChunk, void, undefined> {
    const acc = getOrCreateToolAccumulator(tc, toolAccumulators, toolIdMapper);
    updateToolAccumulator(acc, tc, toolIdMapper);

    if (tc.function?.arguments) {
      yield {
        type: 'tool_use_delta',
        toolUseDelta: {
          id: acc.id,
          name: acc.name,
          argDelta: tc.function.arguments,
        },
      };
    }

    const tracked = this.ensureOpenAIToolBlock(tc.index, acc, envelopeState);
    if (!tc.function?.arguments) return;
    emitBlockDelta(envelopeState, {
      type: 'input_json_delta',
      partial_json: tc.function.arguments,
    });
    tracked.emittedDelta = true;
  }

  private ensureOpenAIToolBlock(
    toolCallIndex: number,
    acc: ToolCallAccumulator,
    envelopeState: BlockEnvelopeState,
  ): { myIndex: number; blockId: string; emittedDelta: boolean } {
    const tracked = envelopeState.openaiToolEmitted.get(toolCallIndex);
    if (!tracked) {
      const blockIdSeed = acc.id || `tool_${toolCallIndex}`;
      const { index: myIdx, blockId } = startBlock(
        envelopeState,
        'tool_use',
        { type: 'tool_use', id: acc.id, name: acc.name, input: {} },
        blockIdSeed,
      );
      const nextTracked = { myIndex: myIdx, blockId, emittedDelta: false };
      envelopeState.openaiToolEmitted.set(toolCallIndex, nextTracked);
      return nextTracked;
    }

    if (envelopeState.activeKind === 'tool_use' && envelopeState.blockIndex === tracked.myIndex) {
      return tracked;
    }
    const { index: myIdx } = startBlock(
      envelopeState,
      'tool_use',
      { type: 'tool_use', id: acc.id, name: acc.name, input: {} },
      tracked.blockId,
    );
    tracked.myIndex = myIdx;
    return tracked;
  }

  private *processOpenAIFinishReason(
    choice: SSEChoice,
    toolAccumulators: Map<number, ToolCallAccumulator>,
    envelopeState: BlockEnvelopeState,
  ): Generator<LLMResponseChunk, void, undefined> {
    if (!choice.finish_reason) return;
    yield* this.flushOpenAIThinkTagHold(envelopeState);
    if (choice.finish_reason === 'tool_calls') {
      yield* this.flushToolAccumulators(toolAccumulators, envelopeState);
      yield { type: 'stop', stopReason: 'tool_use' };
      closeActiveBlock(envelopeState);
      emitMessageDelta(envelopeState, { stop_reason: 'tool_use' });
    } else if (choice.finish_reason === 'stop') {
      yield { type: 'stop', stopReason: 'end_turn' };
      closeActiveBlock(envelopeState);
      emitMessageDelta(envelopeState, { stop_reason: 'end_turn' });
    } else if (choice.finish_reason === 'length') {
      yield { type: 'stop', stopReason: 'max_tokens' };
      closeActiveBlock(envelopeState);
      emitMessageDelta(envelopeState, { stop_reason: 'max_tokens' });
    }
  }

  private *processUsageChunk(
    chunk: SSEChunk,
    envelopeState: BlockEnvelopeState,
  ): Generator<LLMResponseChunk, void, undefined> {
    if (!chunk.usage || this._usageReceived) return;
    this._usageReceived = true;

    const usage = normalizeSSEUsage(chunk.usage);
    yield {
      type: 'usage',
      usage: buildResponseUsagePayload(chunk.usage, usage),
    };

    const cached = usage.cacheRead ?? 0;
    if (cached > 0) {
      yield { type: 'cache_stats', cachedTokens: cached };
    }

    emitMessageDelta(envelopeState, {}, buildMessageUsagePayload(chunk.usage, usage));
  }

  private *flushToolAccumulators(
    accumulators: Map<number, ToolCallAccumulator>,
    envelopeState: BlockEnvelopeState,
  ): Iterable<LLMResponseChunk> {
    for (const [tcIndex, acc] of accumulators) {
      let input: unknown;
      try {
        input = JSON.parse(acc.arguments);
      } catch {
        input = acc.arguments;
      }
      yield {
        type: 'tool_use',
        toolUse: { id: acc.id, name: acc.name, input },
      };

      // Wave 2 envelope: 处理该 tcIndex 对应的 tool_use 块收尾。
      const tracked = envelopeState.openaiToolEmitted.get(tcIndex);
      if (!tracked) {
        // 罕见路径：从未在 processChunk 里 emit 过 start —— OpenAI 一次性把
        // args 整段塞在 finish_reason='tool_calls' 触发前的最后一个 chunk 里
        // （或某些 provider 直接在 [DONE] 前才 flush）。这里补 1 个 start +
        // 1 个完整 input_json_delta + 1 个 stop。**注意：完整 args 一次性 emit
        // 不是"假流式切片"**——这是真实的"一次性整段"形态如实反映。
        const blockIdSeed = acc.id || `tool_${tcIndex}`;
        startBlock(
          envelopeState,
          'tool_use',
          { type: 'tool_use', id: acc.id, name: acc.name, input: {} },
          blockIdSeed,
        );
        if (acc.arguments) {
          emitBlockDelta(envelopeState, {
            type: 'input_json_delta',
            partial_json: acc.arguments,
          });
        }
        closeActiveBlock(envelopeState);
      } else if (envelopeState.activeKind === 'tool_use'
                 && envelopeState.blockIndex === tracked.myIndex) {
        // 该块仍是 active —— close 之（emit content_block_stop）。
        closeActiveBlock(envelopeState);
      }
      // 已记录但 active 已被切换走（前面切换时已 emit 过 stop）—— 不重复 emit。
      envelopeState.openaiToolEmitted.delete(tcIndex);
    }
    accumulators.clear();
  }

  // ─── HTTP error mapping ───────────────────────────────────────────

  /**
   * 将 HTTP 错误映射为 `AgentError`。
   *
   * 埋点（H1-E）：
   *   - `api.error.400`：status === 400（参数错误，PRD §7.3 北极星指标来源）
   *   - `api.error.4xx`：其他 4xx（403/404/405 等），方便区分业务 vs 参数错误
   *   对于 402/429/503/5xx 这些业务/运营状态码，**不发** api.error.* 埋点
   *   （它们有各自专属的 AgentErrorCode，指标由 BillingUsageEvent / RateLimit 视图覆盖）。
   *
   * 业务逻辑与原实现等价——只是在 throw 之前读一次 body 用于埋点 + 错误字段补充。
   */
  private async handleHttpError(
    response: Response,
    requestBody: OpenAIRequestBody,
  ): Promise<never> {
    const status = response.status;
    const retryAfter = response.headers.get('retry-after') ?? undefined;
    const billingError = response.headers.get('x-tabtin-billing-error');
    const errorBodyText = await readHttpErrorBody(response);
    this.emitHttpErrorTelemetry(status, errorBodyText, requestBody);
    throwHttpStatusError(status, retryAfter, billingError, errorBodyText, this.config.isByokMode ?? false);
  }

  private emitHttpErrorTelemetry(
    status: number,
    errorBodyText: string,
    requestBody: OpenAIRequestBody,
  ): void {
    if (status === 400) {
      this.emitApiErrorTelemetry(TelemetryEvents.API_ERROR_400, status, errorBodyText, requestBody);
      return;
    }
    if (status >= 400 && status < 500 && status !== 402 && status !== 429 && status !== 403) {
      // 403 在产品语义上属于"无权限"，由 policy 层覆盖，不算 api 错误
      this.emitApiErrorTelemetry(TelemetryEvents.API_ERROR_4XX, status, errorBodyText, requestBody);
    }
  }

  private emitApiErrorTelemetry(
    event: typeof TelemetryEvents.API_ERROR_400 | typeof TelemetryEvents.API_ERROR_4XX,
    status: number,
    errorBodyText: string,
    requestBody: OpenAIRequestBody,
  ): void {
    const fp = redactErrorBody(errorBodyText);
    emitTelemetryEvent(
      event,
      {
        status,
        model: requestBody.model,
        ...fp,
      },
      {
        ...(this.config.threadId ? { session_id: this.config.threadId } : {}),
        ...(this.config.agentId ? { agent_id: this.config.agentId } : {}),
      },
    );
  }

  // ─── Request building ─────────────────────────────────────────────

  private async resolveToken(): Promise<string> {
    const t = this.config.deviceToken;
    return typeof t === 'function' ? await t() : t;
  }

  private buildHeaders(request: LLMRequest, token: string, attemptIndex = 0): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (this.config.agentId) h['X-TabTin-Agent-Id'] = this.config.agentId;
    // wire 协议头名 `X-TabTin-Session-Id` 不动（外部 proxy 契约），值改用 threadId
    if (this.config.threadId) h['X-TabTin-Session-Id'] = this.config.threadId;
    if (request.requestSource) h['X-TabTin-Request-Source'] = request.requestSource;
    const logicalBillingKey = this.resolveLogicalBillingKey(request);
    if (logicalBillingKey) {
      const attemptBillingKey = `${logicalBillingKey}:attempt:${attemptIndex}`;
      h['X-TabTin-Billing-Idempotency-Key'] = attemptBillingKey;
      h['X-TabTin-Billing-Logical-Key'] = logicalBillingKey;
      h['X-TabTin-Billing-Attempt-Key'] = attemptBillingKey;
      h['X-TabTin-Billing-Attempt-Index'] = String(attemptIndex);
    }
    const wt = typeof this.config.organizationId === 'function'
      ? this.config.organizationId()
      : this.config.organizationId;
    if (wt) h['X-TabTin-Organization-Id'] = wt;
    const tier = typeof this.config.contextTierId === 'function'
      ? this.config.contextTierId()
      : this.config.contextTierId;
    if (tier) h['X-TabTin-Context-Tier'] = tier;
    return h;
  }

  private resolveLogicalBillingKey(request: LLMRequest): string | undefined {
    const billingAwareRequest = request as BillingAwareRequest;
    return billingAwareRequest.logicalBillingKey ?? request.billingIdempotencyKey;
  }

  private buildRequestBody(request: LLMRequest): OpenAIRequestBody {
    const body: OpenAIRequestBody = {
      model: request.model,
      messages: this.convertMessages(request.messages, this.reasoningHistoryPolicy()),
      max_tokens: request.maxTokens,
      stream: true,
    };

    if (request.tools?.length) {
      for (const tool of request.tools) {
        if (typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) {
          throw new AgentError(
            `Invalid tool name: ${JSON.stringify(tool.name)} — must match ^[a-zA-Z0-9_-]{1,64}$ ` +
              `(LLM upstream strict regex; use snake_case or dashes, no dots, no CJK, no spaces).`,
            'LLM_ERROR',
            { toolName: tool.name, invalidToolName: true },
          );
        }
      }
      body.tools = request.tools.map(convertTool);
      // 仅带工具时透传 tool_choice（无 tools 的 tool_choice 上游会 400；
      // undefined 会被 JSON 序列化丢弃）。Django proxy 原样透传，
      // wire_adapter 按上游能力归一/降级。
      body.tool_choice = request.toolChoice;
      // 显式打开并行：wire_adapter 尊重客户端值，并负责 Anthropic
      // `disable_parallel_tool_use` 反向映射。不传则部分模型被注入 false。
      body.parallel_tool_calls = true;
    }

    // 出口防御纵深（dogfood P0 修复 2026-04-30）：messages 内 tool_calls 兜底净化。
    // 入口 select-recent-history.ts 已 sanitize，但万一有第二条历史装填路径
    // 绕过入口（譬如 daemon 直接读 jsonl），出口再校验一次。
    // 跟 request.tools 校验（throw）不同 —— messages 是用户历史数据不可控，
    // throw 会让无辜请求挂；自动 sanitize + telemetry warning 是合理折中。
    const { warnings } = sanitizeOpenAIMessageToolCalls(body.messages);
    if (warnings.length > 0) {
      for (const w of warnings) {
        // 走 console.warn —— 本仓 proxy-provider 上下文目前没有显式 telemetry
        // emitter；warning 至少进 stderr / electron main log，让我们能监测到
        // bypass 真实发生。后续接入 telemetryEmitter 时改为正式事件。
        console.warn(
          `[proxy-provider] sanitized non-conformant tool name in messages: ` +
            `${JSON.stringify(w.from)} → ${JSON.stringify(w.to)} ` +
            `(history sanitize bypass detected — investigate which load path skipped sanitizeHistoricalToolName)`,
        );
      }
    }

    if (request.system) {
      body.system =
        typeof request.system === 'string'
          ? [{ type: 'text' as const, text: request.system }]
          : request.system.map((b): OpenAISystemBlock => ({ type: 'text', text: b.text }));
    }

    // Provider-aware cache strategy (PRD §5.5.1)
    // - 'explicit' → Claude/Qwen: 4 breakpoint cache_control
    // - 'implicit' → OpenAI/DeepSeek: no cache_control, prefix stability only
    // - 'none'     → no cache handling
    // - undefined  → old host didn't pass capabilities; fall back to explicit
    //                to preserve the previous unconditional cache_control behavior
    const cacheType = this.config.modelCapabilities?.cacheType;
    if (cacheType === 'explicit' || cacheType === undefined) {
      applyExplicitCache(body);
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    this.applyModelParamOverrides(body);
    this.applyThinkingConfig(body, request);

    body.messages = sanitizeToolPairing(body.messages);

    return body;
  }

  /**
   * 附加 extended thinking 配置。强制工具轮（tool_choice: 'required'）
   * **显式关闭** thinking：Kimi/Anthropic 均规定强制工具调用与思考互斥
   * （上游 400 "tool_choice 'required' is incompatible with thinking enabled"）。
   * 注意 kimi-k2.6 等思考模型 thinking 是**服务端默认开启**——省略字段不等于
   * 关闭（taobao2 dogfood 2026-07-22 实测仍 400），必须显式发 `{type:'disabled'}`
   * （Kimi 官方文档支持；不支持 reasoning 参数的模型由 Django wire_adapter
   * `_normalize_reasoning_param` 统一剥掉）。该轮只需模型产出一个工具调用，无需深思考。
   */
  private applyThinkingConfig(body: OpenAIRequestBody, request: LLMRequest): void {
    if (request.toolChoice === 'required') {
      delete body.reasoning_effort;
      delete body.model_param_overrides;
      body.thinking = { type: 'disabled' };
      return;
    }
    // 只认扁平 canonical key。`reasoning.effort` 这类嵌套 key 服务端不识别
    // ，不能让一个不生效的覆盖抑制掉会生效的 thinking budget。
    const hasExplicitReasoningOverride = Object.keys(body.model_param_overrides ?? {}).some(
      (key) => key === 'reasoning_effort',
    );
    if (hasExplicitReasoningOverride) return;
    if (!this.config.thinkingBudgetTokens) return;
    body.thinking = {
      type: 'enabled',
      budget_tokens: this.config.thinkingBudgetTokens,
    };
  }

  private applyModelParamOverrides(body: OpenAIRequestBody): void {
    const overrides = this.resolveRequestParamOverrides();
    if (!overrides) return;
    const normalized: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (!key) continue;
      if (
        value === null
        || typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'boolean'
      ) {
        normalized[key] = value;
        setRequestParamOverride(body, key, value);
      }
    }
    if (Object.keys(normalized).length > 0) {
      body.model_param_overrides = normalized;
    }
  }

  private resolveRequestParamOverrides(): Record<string, string | number | boolean | null> | undefined {
    return typeof this.config.requestParamOverrides === 'function'
      ? this.config.requestParamOverrides()
      : this.config.requestParamOverrides;
  }

  // ─── Message format conversion ────────────────────────────────────

  /** 当前模型的历史 reasoning 回传策略（隔离 optional-chain，避免调用点增复杂度）。 */
  private reasoningHistoryPolicy(): 'drop' | 'preserve_for_tools' | 'preserve' | undefined {
    return this.config.modelCapabilities?.reasoningHistoryPolicy;
  }

  private convertMessages(
    messages: MessageParam[],
    reasoningHistoryPolicy?: 'drop' | 'preserve_for_tools' | 'preserve',
  ): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];
    const supportsVision = this.config.modelCapabilities?.supportsVision !== false;

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        if (msg.role === 'user' && msg.content.trim().length === 0) continue;
        result.push({ role: msg.role, content: msg.content });
        continue;
      }

      const blocks = msg.content as ContentBlock[];

      if (msg.role === 'assistant') {
        result.push(convertAssistantMessage(blocks, reasoningHistoryPolicy));
      } else if (msg.role === 'user') {
        const toolResults = blocks.filter(
          (b): b is ToolResultBlock => b.type === 'tool_result',
        );
        const textBlocks = blocks.filter(
          (b): b is TextBlock => b.type === 'text',
        );
        const imageBlocks = blocks.filter(
          (b): b is ImageBlock => b.type === 'image',
        );
        const videoBlocks = blocks.filter(
          (b): b is VideoBlock => b.type === 'video',
        );
        const documentBlocks = blocks.filter(
          (b): b is DocumentBlock => b.type === 'document',
        );

        for (const tr of toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string'
              ? tr.content
              : tr.content
                  .filter((c): c is TextBlock => c.type === 'text')
                  .map((c) => c.text)
                  .join('\n'),
          });
        }

        const parts: OpenAIContentPart[] = [];
        for (const tb of textBlocks) {
          parts.push({ type: 'text', text: tb.text });
        }
        for (const ib of imageBlocks) {
          if (shouldForwardImageBlockToModel(ib, supportsVision)) {
            parts.push(convertImageBlock(ib));
          } else {
            parts.push({
              type: 'text',
              text: imageBlockFallbackText(ib, supportsVision ? 'unreachable_url' : 'unsupported_vision'),
            });
          }
        }
        for (const vb of videoBlocks) {
          parts.push(convertVideoBlock(vb));
        }
        for (const db of documentBlocks) {
          parts.push(convertDocumentBlock(db));
        }

        if (parts.length > 0) {
          const onlyBlankText = parts.every(
            (part) => part.type === 'text' && part.text.trim().length === 0,
          );
          if (!onlyBlankText) {
            result.push({
              role: 'user',
              content: parts.length === 1 && parts[0].type === 'text'
                ? (parts[0] as { type: 'text'; text: string }).text
                : parts,
            });
          }
        }
      }
    }

    return result;
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────

/**
 * 将 runtime assistant ContentBlock[] 转为 OpenAI-compat 消息。
 *
 * **跨轮 thinking 默认不回传**：
 * - 入口 `select-recent-history.ts` 装填时默认丢弃 thinking block
 * - 本函数是出口防御纵深：fork / jsonl 等绕过装填的路径仍可能带 thinking
 * - thinking 是单轮推理痕迹，通常不是可回传对话内容；Claude extended thinking 的
 *   signature 无法经本路径 round-trip，旧 deepseek-reasoner 输入 reasoning 会 400
 *
 * **例外 `reasoningHistoryPolicy: 'preserve_for_tools'`（DeepSeek V4）**：思考模式下
 * 发生工具调用的 assistant 消息，其 reasoning **必须**随 `reasoning_content` 回传，
 * 否则上游 400。故仅当 policy=preserve_for_tools **且**该消息含 tool_calls 时，把
 * thinking 文本映射为 `reasoning_content`。
 *
 * **例外 `reasoningHistoryPolicy: 'preserve'`（Kimi K3 / K2.7-code）**：保留式思考
 * 始终开启，多轮与工具轮都必须原样回传 `reasoning_content`。
 *
 * @internal 导出仅供单元测试；生产路径由 convertMessages → buildRequestBody 调用
 */
export function convertAssistantMessage(
  blocks: ContentBlock[],
  reasoningHistoryPolicy: 'drop' | 'preserve_for_tools' | 'preserve' = 'drop',
): OpenAIMessage {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push((block as { text: string }).text);
    } else if (block.type === 'thinking') {
      thinkingParts.push((block as { thinking?: string }).thinking ?? '');
    } else if (block.type === 'tool_use') {
      const tu = block as { id: string; name: string; input: unknown };
      toolCalls.push({
        id: tu.id,
        type: 'function',
        function: {
          name: tu.name,
          arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input),
        },
      });
    }
  }

  const msg: OpenAIMessage = { role: 'assistant' };
  if (textParts.length) msg.content = textParts.join('');
  if (toolCalls.length) msg.tool_calls = toolCalls;
  const reasoning = pickRoundtripReasoning(reasoningHistoryPolicy, toolCalls.length, thinkingParts);
  if (reasoning) msg.reasoning_content = reasoning;
  if (!msg.content && !msg.tool_calls) msg.content = '';
  return msg;
}

/**
 * 决定 assistant 消息是否回传 reasoning_content。
 * - `preserve`：始终回传（有 thinking 文本时）
 * - `preserve_for_tools`：仅当该消息含 tool_calls
 * - `drop`：不回传
 */
function pickRoundtripReasoning(
  policy: 'drop' | 'preserve_for_tools' | 'preserve',
  toolCallCount: number,
  thinkingParts: string[],
): string {
  if (policy === 'preserve') return thinkingParts.join('');
  if (policy === 'preserve_for_tools' && toolCallCount > 0) return thinkingParts.join('');
  return '';
}

function convertImageBlock(block: ImageBlock): OpenAIContentPart {
  let url: string;
  if (block.source.type === 'base64') {
    url = `data:${block.source.media_type};base64,${block.source.data}`;
  } else {
    url = block.source.url;
  }
  return {
    type: 'image_url',
    image_url: { url, detail: block.detail },
  };
}

function shouldForwardImageBlockToModel(block: ImageBlock, supportsVision: boolean): boolean {
  if (!supportsVision) return false;
  if (block.source.type === 'base64') return true;
  return isModelReachableImageUrl(block.source.url);
}

function isModelReachableImageUrl(url: string): boolean {
  if (url.startsWith('data:')) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost'
    || host === '::1'
    || host.startsWith('127.')
    || host.startsWith('10.')
    || host.startsWith('192.168.')
  ) {
    return false;
  }
  const private172 = /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  return !private172;
}

function imageBlockFallbackText(
  block: ImageBlock,
  reason: 'unsupported_vision' | 'unreachable_url' = 'unsupported_vision',
): string {
  if (block.source.type === 'url' && reason === 'unreachable_url') {
    return `[Image file omitted because the selected model cannot access this image URL: ${block.source.url}]`;
  }
  if (block.source.type === 'url') {
    return `[Image file omitted because the selected model does not support vision input: ${block.source.url}]`;
  }
  if (block.source.type === 'base64') {
    return `[Image file omitted because the selected model does not support vision input: ${block.source.media_type}]`;
  }
  return '[Image file omitted because the selected model does not support vision input.]';
}

/**
 * ：VideoBlock → OpenAI-compat `video_url` part（Kimi / Moonshot 等）。
 * @internal 导出仅供单元测试。
 */
export function convertVideoBlock(block: VideoBlock): { type: 'video_url'; video_url: { url: string } } {
  return {
    type: 'video_url',
    video_url: { url: block.source.url },
  };
}

/**
 * ：DocumentBlock → OpenAI-compat `file` + `file_url` part。
 * Django wire_adapter 在 Moonshot 上会按 DocumentCaps.upload_mode=file_extract
 * 改写为 Files API 提取文本（chat/completions 不接受 type:file）。
 * @internal 导出仅供单元测试。
 */
export function convertDocumentBlock(block: DocumentBlock): {
  type: 'file';
  file_url: { url: string };
  file_name?: string;
} {
  let url: string;
  if (block.source.type === 'base64') {
    url = `data:${block.source.media_type};base64,${block.source.data}`;
  } else {
    url = block.source.url;
  }
  return {
    type: 'file',
    file_url: { url },
    ...(block.title ? { file_name: block.title } : {}),
  };
}

function convertTool(tool: ToolParam): OpenAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCapabilityEventType(eventType: string): eventType is CapabilityEventType {
  return eventType === 'capability_downgrade' || eventType === 'capability_warning';
}

function *processCapabilityEvent(
  eventType: CapabilityEventType,
  payload: string,
): Generator<LLMResponseChunk, void, undefined> {
  // Wave 3：把后端 wire_adapter 在 SSE 上发的 capability 事件
  // （`event: capability_downgrade` / `event: capability_warning`）
  // 真正接通到前端 UI——之前只 console.warn 等于 dev tool 才看得到。
  try {
    const payloadObj = JSON.parse(payload) as Record<string, unknown>;
    const extras = collectCapabilityExtras(payloadObj);
    yield {
      type: 'capability_event',
      capabilityEvent: {
        kind: eventType === 'capability_downgrade' ? 'downgrade' : 'warning',
        feature: readCapabilityFeature(payloadObj),
        fallback_to: readCapabilityFallback(payloadObj),
        message: readCapabilityMessage(payloadObj),
        ...(Object.keys(extras).length > 0 ? { extras } : {}),
      },
    };
  } catch { /* malformed payload — ignore，不影响主流 */ }
}

function readCapabilityFeature(payloadObj: Record<string, unknown>): string | undefined {
  return typeof payloadObj.feature === 'string'
    ? payloadObj.feature
    : (typeof payloadObj.capability === 'string' ? payloadObj.capability : undefined);
}

function readCapabilityFallback(payloadObj: Record<string, unknown>): string | undefined {
  if (typeof payloadObj.fallback_to === 'string') return payloadObj.fallback_to;
  const reason = typeof payloadObj.reason === 'string' ? payloadObj.reason : undefined;
  return reason === 'schema_unsupported_fallback_to_prompt_hint'
    || reason === 'json_object_unsupported_fallback_to_prompt_hint'
      ? 'system_prompt_hint'
      : undefined;
}

function readCapabilityMessage(payloadObj: Record<string, unknown>): string | undefined {
  return typeof payloadObj.message === 'string'
    ? payloadObj.message
    : (typeof payloadObj.user_message === 'string' ? payloadObj.user_message : undefined);
}

function collectCapabilityExtras(payloadObj: Record<string, unknown>): Record<string, unknown> {
  // 把已知字段拆出来后，剩余字段全保留到 extras（stage / reason / host 等），
  // 便于 telemetry 与排障；兼容旧后端字段 capability/user_message。
  const knownKeys = new Set([
    'feature',
    'fallback_to',
    'message',
    'capability',
    'user_message',
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payloadObj)) {
    if (!knownKeys.has(k)) extras[k] = v;
  }
  return extras;
}

function collectProxySSEErrorExtras(error: NonNullable<SSEChunk['error']>): Record<string, unknown> {
  const topLevelExtras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (!SSE_ERROR_CORE_KEYS.has(key) && value !== undefined) {
      topLevelExtras[key] = value;
    }
  }
  const nestedExtras = error.extras && typeof error.extras === 'object'
    ? error.extras
    : {};
  return { ...topLevelExtras, ...nestedExtras };
}

function resolveProxySSEErrorType(
  error: NonNullable<SSEChunk['error']>,
  extras: Record<string, unknown>,
): string {
  const backendErrorCategory = readString(extras.error_category);
  return backendErrorCategory && BYOK_ERROR_TYPES.has(backendErrorCategory)
    ? backendErrorCategory
    : readString(error.code) ?? readString(error.type) ?? 'proxy_error';
}

function isProxySSEBillingError(errorType: string): boolean {
  return errorType === 'budget_exceeded'
    || errorType === 'insufficient_credits'
    || errorType === 'organization_insufficient_credits'
    || errorType === 'freeze_failed'
    || BYOK_ERROR_TYPES.has(errorType);
}

/** 火山 / 豆包 burst 或后端 upstream_rate_limited。 */
function isProxySSEUpstreamRateLimitError(
  errorType: string,
  status: number | undefined,
  userMessage: string,
): boolean {
  if (errorType.startsWith('byok_')) return false;
  if (errorType === 'upstream_rate_limited') return true;
  if (isUpstreamBurstRateLimitMessage(userMessage)) return true;
  // 平台侧 HTTP 429（非 BYOK）也按限流码，避免落 LLM_ERROR「网络连接异常」。
  return status === 429;
}

const BILLING_TAIL_BALANCE_ERROR_CATEGORIES = new Set([
  'insufficient_credits',
  'organization_insufficient_credits',
  'budget_exceeded',
  'freeze_failed',
]);

/**
 * tabtin.billing 尾帧 charge_status=failed 的错误语义：
 * - 余额/预算类 → LLM_BILLING_ERROR（不可重试，引导充值/查账单）
 * - 其余（含缺省 billing_charge_failed）→ LLM_ERROR（可重试，不伪装成余额不足）
 */
function buildBillingTailFailureError(errorCategory: string): AgentError {
  const isBalanceOrBudget = BILLING_TAIL_BALANCE_ERROR_CATEGORIES.has(errorCategory);
  if (isBalanceOrBudget) {
    const message = errorCategory === 'budget_exceeded'
      ? '组织预算已用尽，请调整预算后继续。'
      : errorCategory === 'organization_insufficient_credits'
        ? '组织钱包余额不足，请充值后继续使用。'
        : '账户余额不足，请充值后继续。';
    return new AgentError(message, 'LLM_BILLING_ERROR', {
      retryable: false,
      statusCode: 402,
      details: {
        chargeStatus: 'failed',
        error_type: errorCategory,
        error_category: errorCategory,
        fromBillingTail: true,
      },
    });
  }
  return new AgentError(
    'LLM 调用已完成但计费结算失败，请稍后重试。',
    'LLM_ERROR',
    {
      // 流已完成，provider 勿自动重放；UI 由 classifier 标 retry_later 给用户手动重试
      retryable: false,
      details: {
        chargeStatus: 'failed',
        error_type: 'billing_charge_failed',
        error_category: errorCategory || 'billing_charge_failed',
        fromBillingTail: true,
      },
    },
  );
}

function getOrCreateToolAccumulator(
  tc: SSEToolCallDelta,
  toolAccumulators: Map<number, ToolCallAccumulator>,
  toolIdMapper: ToolIdMapper,
): ToolCallAccumulator {
  const existing = toolAccumulators.get(tc.index);
  if (existing) return existing;
  // ：有上游 id 时立刻映射；无 id 时留空，等后续 delta 再 allocate。
  const next = {
    id: tc.id ? toolIdMapper.allocate(tc.id) : '',
    name: tc.function?.name ?? '',
    arguments: '',
  };
  toolAccumulators.set(tc.index, next);
  return next;
}

function updateToolAccumulator(
  acc: ToolCallAccumulator,
  tc: SSEToolCallDelta,
  toolIdMapper: ToolIdMapper,
): void {
  // 部分 provider 首帧无 id、后续才带 id——仅在 acc 仍空时补映射。
  if (tc.id && !acc.id) acc.id = toolIdMapper.allocate(tc.id);
  if (tc.function?.name) acc.name = tc.function.name;
  if (tc.function?.arguments) acc.arguments += tc.function.arguments;
}

async function readHttpErrorBody(response: Response): Promise<string> {
  // 只在"有埋点价值"的 4xx 上读 body；402/429 不读，避免 SSE / binary body 消费副作用
  const status = response.status;
  const shouldReadBody = status >= 400 && status < 500
    && status !== 402 && status !== 429;
  if (!shouldReadBody) return '';
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function throwHttpStatusError(
  status: number,
  retryAfter: string | undefined,
  billingError: string | null,
  errorBodyText: string,
  isByok: boolean,
): never {
  const retryAfterMs = parseRetryAfterHeader(retryAfter);
  if (status === 402) {
    throw new AgentError(
      billingError ?? 'Insufficient credits or budget exceeded',
      'LLM_BILLING_ERROR',
      { statusCode: status, retryable: false, details: { status, billingError } },
    );
  }
  if (status === 429) {
    throwRetryableHttpStatusError('Rate limit exceeded', 'LLM_RATE_LIMIT', status, retryAfter, retryAfterMs);
  }
  if (status === 529) {
    throwRetryableHttpStatusError('LLM overloaded', 'LLM_ERROR', status, retryAfter, retryAfterMs);
  }
  if (status === 503) {
    throw new AgentError('All API keys exhausted', 'LLM_KEY_EXHAUSTED', {
      statusCode: status,
      retryable: true,
      retryAfterMs: retryAfterMs ?? undefined,
      details: { status, retryAfter, isByok },
    });
  }
  if (status >= 500) {
    throwRetryableHttpStatusError(`LLM proxy server error (${status})`, 'LLM_ERROR', status, retryAfter, retryAfterMs);
  }
  throwGenericHttpStatusError(status, errorBodyText);
}

function throwRetryableHttpStatusError(
  message: string,
  code: 'LLM_RATE_LIMIT' | 'LLM_ERROR',
  status: number,
  retryAfter: string | undefined,
  retryAfterMs: number | null,
): never {
  throw new AgentError(message, code, {
    statusCode: status,
    retryable: true,
    retryAfterMs: retryAfterMs ?? undefined,
    details: { status, retryAfter },
  });
}

function throwGenericHttpStatusError(status: number, errorBodyText: string): never {
  const errorSample = errorBodyText ? errorBodyText.slice(0, 500) : '';
  throw new AgentError(
    errorSample
      ? `LLM proxy error (${status}): ${errorSample}`
      : `LLM proxy error (${status})`,
    'LLM_ERROR',
    { statusCode: status, retryable: false, details: { status, ...(errorSample ? { errorBody: errorSample } : {}) } },
  );
}

interface NormalizedSSEUsage {
  inputTokens: number;
  cacheRead: number | undefined;
  cacheCreation: number | undefined;
  reasoningTokens: number | undefined;
}

function normalizeSSEUsage(usage: NonNullable<SSEChunk['usage']>): NormalizedSSEUsage {
  const cacheTokens = readSSECacheTokens(usage);
  const rawInput = usage.prompt_tokens ?? 0;
  return {
    inputTokens: cacheTokens.inputIncludesCache
      ? Math.max(rawInput - (cacheTokens.cacheRead ?? 0) - (cacheTokens.cacheCreation ?? 0), 0)
      : rawInput,
    cacheRead: cacheTokens.cacheRead,
    cacheCreation: cacheTokens.cacheCreation,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? undefined,
  };
}

interface SSECacheTokens {
  cacheRead: number | undefined;
  cacheCreation: number | undefined;
  inputIncludesCache: boolean;
}

function readSSECacheTokens(usage: NonNullable<SSEChunk['usage']>): SSECacheTokens {
  // Anthropic：cache 在顶层；OpenAI：cache 在 prompt_tokens_details 且 prompt_tokens 已含 cache。
  const topCacheRead = usage.cache_read_input_tokens;
  const topCacheCreation = usage.cache_creation_input_tokens;
  const detailsCacheRead = usage.prompt_tokens_details?.cached_tokens;
  const detailsCacheCreation = usage.prompt_tokens_details?.cache_creation_input_tokens;
  const cacheRead = topCacheRead ?? detailsCacheRead ?? undefined;
  const cacheCreation = topCacheCreation ?? detailsCacheCreation ?? undefined;
  return {
    cacheRead,
    cacheCreation,
    inputIncludesCache: topCacheRead == null
      && topCacheCreation == null
      && (detailsCacheRead != null || detailsCacheCreation != null),
  };
}

function buildResponseUsagePayload(
  rawUsage: NonNullable<SSEChunk['usage']>,
  usage: NormalizedSSEUsage,
): UsageResponsePayload {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: rawUsage.completion_tokens,
    total_tokens: rawUsage.total_tokens,
    ...(usage.cacheRead != null && usage.cacheRead > 0 ? { cache_read_input_tokens: usage.cacheRead } : {}),
    ...(usage.cacheCreation != null && usage.cacheCreation > 0 ? { cache_creation_input_tokens: usage.cacheCreation } : {}),
    ...(usage.reasoningTokens != null && usage.reasoningTokens > 0 ? { reasoning_tokens: usage.reasoningTokens } : {}),
  };
}

function buildMessageUsagePayload(
  rawUsage: NonNullable<SSEChunk['usage']>,
  usage: NormalizedSSEUsage,
): MessageUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: rawUsage.completion_tokens ?? 0,
    ...(usage.cacheRead != null && usage.cacheRead > 0 ? { cache_read_input_tokens: usage.cacheRead } : {}),
    ...(usage.cacheCreation != null && usage.cacheCreation > 0 ? { cache_creation_input_tokens: usage.cacheCreation } : {}),
  };
}

function isFetchAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError';
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof AgentError)) return false;

  // 用户停止：绝不重试
  if (err.code === 'ABORT') {
    return false;
  }

  // 账单类错误永远不重试（额度/冻结/预算）
  if (err.code === 'LLM_BILLING_ERROR') {
    return false;
  }

  // 计费尾帧结算失败发生在上游已完整返回之后，自动重放会双计费风险
  if (err.details?.fromBillingTail === true) {
    return false;
  }

  // 后端 SSE error chunk：历史上一律 non-retryable（防 retry storm）。
  // 但对明确的瞬态过载（429/529/503）放行 provider 层退避重试——
  // LLM proxy 本身对单 key 429 不重试，且 key 池 size=1 时无轮换。
  if (err.details?.fromProxySSE === true) {
    // 429/529/503 过载，以及发版/网关切断常见的 502，都重开流。
    if (err.statusCode !== undefined) {
      return RETRY_CONFIG.retryableStatuses.has(err.statusCode);
    }
    return false;
  }

  if (err.statusCode !== undefined) {
    return RETRY_CONFIG.retryableStatuses.has(err.statusCode);
  }

  if (err.retryable) return true;
  if (err.details?.networkError === true) return true;
  if (err.details?.retryable === true) return true;

  return false;
}

function parseRetryAfterHeader(raw: string | undefined): number | null {
  if (!raw) return null;

  const seconds = Number(raw);
  if (!isNaN(seconds) && isFinite(seconds)) {
    return seconds * 1000;
  }

  const date = new Date(raw);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return null;
}

function parseRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof AgentError)) return null;

  if (err.retryAfterMs != null) return err.retryAfterMs;

  const raw = err.details?.retryAfter as string | undefined;
  return parseRetryAfterHeader(raw);
}

function shouldRetry529ForSource(requestSource?: string): boolean {
  if (!requestSource) return true;
  const querySource = requestSource === '_main_chat' ? 'user_message' : requestSource;
  return (FOREGROUND_SOURCES as ReadonlySet<string>).has(querySource);
}

/**
 * Last-resort tool pairing sanitizer operating on OpenAI-format messages.
 *
 * Drops orphan `tool` messages (role='tool') whose `tool_call_id` has no
 * matching `tool_calls[].id` in the immediately preceding assistant message,
 * and drops orphan `tool_calls` entries whose id has no matching `tool`
 * response.
 *
 *  观测化兜底：防 400 的修复行为保留（defense-in-depth 不删），但本函数
 * 是配对治理链的**最后一环**——上游有 run 初始装填修复（query.ts
 * `repairMessagePairingInState`）、每轮 beforeModel 配对门
 * （hooks/message-governance.ts `applyPairingGate`）、compact 摘要整备
 * 。走到这里还需要修，说明上游治理漏了配对（bug），因此修复发生时
 * 必须 console.warn + telemetry 带修复计数，让漏网路径可归因。
 */
export function sanitizeToolPairing(messages: OpenAIMessage[]): OpenAIMessage[] {
  let changed = false;
  let orphanToolMessagesDropped = 0;
  let orphanToolCallsDropped = 0;
  const result: OpenAIMessage[] = [];

  let pendingAssistantIndex: number | null = null;
  let pendingToolCalls: OpenAIToolCall[] = [];
  let pendingToolCallIds = new Set<string>();
  let satisfiedToolCallIds = new Set<string>();

  const finalizePendingAssistant = () => {
    if (pendingAssistantIndex === null || pendingToolCalls.length === 0) return;

    const unresolved = pendingToolCalls.filter(tc => !satisfiedToolCallIds.has(tc.id));
    if (unresolved.length === 0) {
      pendingAssistantIndex = null;
      pendingToolCalls = [];
      pendingToolCallIds = new Set();
      satisfiedToolCallIds = new Set();
      return;
    }

    changed = true;
    orphanToolCallsDropped += unresolved.length;
    const assistant = result[pendingAssistantIndex];
    const kept = pendingToolCalls.filter(tc => satisfiedToolCallIds.has(tc.id));
    result[pendingAssistantIndex] = {
      ...assistant,
      tool_calls: kept.length > 0 ? kept : undefined,
      content: assistant.content ?? '',
    };

    pendingAssistantIndex = null;
    pendingToolCalls = [];
    pendingToolCallIds = new Set();
    satisfiedToolCallIds = new Set();
  };

  for (const msg of messages) {
    if (msg.role === 'tool') {
      if (msg.tool_call_id && pendingToolCallIds.has(msg.tool_call_id)) {
        result.push(msg);
        pendingToolCallIds.delete(msg.tool_call_id);
        satisfiedToolCallIds.add(msg.tool_call_id);
      } else {
        changed = true;
        orphanToolMessagesDropped += 1;
      }
      continue;
    }

    finalizePendingAssistant();

    result.push(msg);
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter(tc => !!tc.id) : [];
    if (msg.role === 'assistant' && calls.length > 0) {
      pendingAssistantIndex = result.length - 1;
      pendingToolCalls = calls;
      pendingToolCallIds = new Set(calls.map(tc => tc.id));
      satisfiedToolCallIds = new Set();
    }
  }

  finalizePendingAssistant();

  if (changed) {
    // 走 console.warn —— 与本文件 sanitizeOpenAIMessageToolCalls 的 bypass
    // 告警同一手法：warning 进 stderr / electron main log，可监测到上游
    // 治理漏配对真实发生。
    console.warn(
      `[proxy-provider] tool pairing repaired at provider boundary: ` +
        `dropped ${orphanToolMessagesDropped} orphan tool message(s), ` +
        `${orphanToolCallsDropped} orphan tool_calls entr(ies) ` +
        `(upstream pairing governance missed these — investigate which path ` +
        `bypassed repairMessagePairingInState / applyPairingGate)`,
    );
    emitTelemetryEvent(
      TelemetryEvents.MESSAGE_NORMALIZED,
      {
        level: 'proxy_provider_tool_pairing_sequence',
        orphan_tool_messages_dropped: orphanToolMessagesDropped,
        orphan_tool_calls_dropped: orphanToolCallsDropped,
      },
    );
  }

  return changed ? result : messages;
}

// ─── Prompt Cache: explicit multi-breakpoint strategy (PRD §5.5.2) ──

const CACHE_EPHEMERAL: CacheControl = { type: 'ephemeral' };

/**
 * 显式缓存 4 断点策略（Claude / Qwen via ZenMux）。
 *
 * 按更新频率从低到高分配 ZenMux 允许的最多 4 个 breakpoint：
 *   BP1 — tools 最后一项（几乎不变）
 *   BP2 — system 静态段末尾（很少变）
 *   BP3 — system 动态段末尾（可能每轮变）
 *   BP4 — messages 中**最后一条** user 消息（含 tool_result）—— 当前轮入参的
 *         "前缀末尾"，下一轮 LLM 调用会延伸到下一条 assistant + 下一条 user，
 *         本轮的最后一条 user 在下一轮就是稳定前缀（implicit 缓存命中）。
 *
 * **W4.3 注释 vs 实现对齐**：本注释历史版本写"倒数第二条 user 消息"，但实
 * 现一直是 `findLastUserMessageIndex`（最后一条 user）。多轮迭代后实现行
 * 为已稳定且现成测试覆盖，因此修注释而非修实现，避免破坏既有 cache 行为。
 *
 * BP2 依赖 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记；若 system 中不含标记则跳过。
 * BP4 仅在消息 token 估算 >= MIN_CACHE_TOKENS 时才加，避免短消息浪费断点。
 */
function applyExplicitCache(body: OpenAIRequestBody): void {
  // BP1: tools 最后一项
  if (body.tools?.length) {
    const last = body.tools.length - 1;
    body.tools[last] = { ...body.tools[last], cache_control: CACHE_EPHEMERAL };
  }

  // BP2 + BP3: system blocks
  if (Array.isArray(body.system) && body.system.length > 0) {
    const boundaryIdx = findDynamicBoundaryIndex(body.system);
    if (boundaryIdx > 0) {
      // BP2: 静态段末尾（boundary 前一块）
      body.system[boundaryIdx - 1] = {
        ...body.system[boundaryIdx - 1],
        cache_control: CACHE_EPHEMERAL,
      };
    }
    // BP3: 动态段末尾（system 最后一块）
    const lastSys = body.system.length - 1;
    body.system[lastSys] = {
      ...body.system[lastSys],
      cache_control: CACHE_EPHEMERAL,
    };
  }

  // BP4: messages 中最后一条 user 消息（对话历史前缀末尾）
  // 仅在历史足够长时才加，避免短消息浪费断点
  if (body.messages.length > 0) {
    const lastUserIdx = findLastUserMessageIndex(body.messages);
    if (lastUserIdx >= 0 && estimateMessagesTokens(body.messages) >= MIN_CACHE_TOKENS) {
      applyUserMessageCacheControl(body.messages[lastUserIdx]);
    }
  }
}

/**
 * 找 system blocks 中含 DYNAMIC_BOUNDARY 标记的第一个 block 索引。
 * 返回 -1 表示未找到。
 */
function findDynamicBoundaryIndex(blocks: OpenAISystemBlock[]): number {
  const marker = SYSTEM_PROMPT_DYNAMIC_BOUNDARY.trim();
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].text.includes(marker)) return i;
  }
  return -1;
}

function findLastUserMessageIndex(messages: OpenAIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

/**
 * BP4 阈值：Claude 显式缓存的最小可缓存 token 数。对齐 PRD §5.5.2 的 token
 * 口径（`estimateMessagesTokens >= 1024`）。
 *
 * 旧实现用字符数 `MIN_CACHE_CHARS = 4096` 粗估，对 CJK 失真：中文 ≈1.3 chars/
 * token、英文 ≈4.0 chars/token，统一字符阈值会高估中文所需长度，让中文短对话
 * 迟迟够不到断点而错失缓存。改用 CJK-aware token 估算（复用 token-budget 的
 * estimateTextTokens）后阈值按真实 token 数判定。
 */
const MIN_CACHE_TOKENS = 1024;

/**
 * 单张图片的保守 token 估算。OpenAI `image_url` part 不带尺寸信息，无法精确算
 * （token-budget 的 estimateImageTokens 需要 width/height）；取 Claude 中等图
 * 量级的保守常量，避免纯图 / 图文 user 消息被严重低估而错过 BP4 缓存断点。
 * 偏高估比偏低估安全：BP4 多占一个断点无害，漏掉则整条消息错失缓存。
 */
const IMAGE_TOKEN_ESTIMATE = 1000;

function estimateMessagesTokens(messages: OpenAIMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTextTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part) {
          total += estimateTextTokens(part.text);
        } else if ((part as { type?: string }).type === 'image_url') {
          total += IMAGE_TOKEN_ESTIMATE;
        }
      }
    }
  }
  return total;
}

/**
 * 给 user 消息加 cache_control。
 * OpenAI 兼容格式下，user 消息 content 可以是 string 或 ContentPart[]。
 * ZenMux 透传时在 content part 级别读 cache_control。
 */
function applyUserMessageCacheControl(msg: OpenAIMessage): void {
  if (typeof msg.content === 'string') {
    (msg as unknown as Record<string, unknown>).content = [
      { type: 'text', text: msg.content, cache_control: CACHE_EPHEMERAL },
    ];
  } else if (Array.isArray(msg.content) && msg.content.length > 0) {
    const lastIdx = msg.content.length - 1;
    msg.content[lastIdx] = {
      ...msg.content[lastIdx],
      cache_control: CACHE_EPHEMERAL,
    } as unknown as OpenAIContentPart;
  }
}
