/**
 * engine/contracts 第 3 层 —— 模型能力与 LLM Provider 契约。
 *
 * Model Capabilities（PRD §5.1 catalog 能力快照）+ Model Catalog Snapshot
 * （子 Agent 模型自由度）+ Cache Type Derivation + Prompt Cache Dynamic
 * Boundary re-export + LLM Provider（LLMRequest / LLMResponseChunk /
 * ContentBlockEnvelopeHint / RetryAttemptInfo）。
 *
 * 分层规则见 wire-protocol.ts 头注释；本层只允许 import conversation /
 * wire-protocol。
 */

import type {
  MessageUsage,
  MessageStopReason,
  UsageReport,
  WireContentBlock,
  ContentBlockDeltaPayload,
} from './wire-payloads.js';
import type { MessageParam, SystemBlock, ToolParam } from './conversation.js';

// ─── Model Capabilities ─────────────────────────────────────────────
// PRD §5.1：从 Django catalog 获取的模型能力数据。替代两端宿主的硬编码
// MODEL_CONTEXT_WINDOWS 表，让 context window / output reserve / 缓存策略
// 跟随 catalog 真实值动态变化，新增模型无需发版。

export interface ModelCapabilities {
  contextWindowTokens: number;
  maxOutputTokens: number;
  maxInputTokens: number;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
  supportsPromptCaching: boolean;
  cacheType: 'explicit' | 'implicit' | 'none';
  /**
   * 历史 reasoning（thinking）回传策略。
   * - `drop`（默认 / undefined）：不把历史 reasoning 回传给上游。适用于 Claude
   *   （需 signature 另一条路）、OpenAI o 系列（不可回传）、旧 deepseek-reasoner
   *   （输入 reasoning 会 400）等——即现状  行为。
   * - `preserve_for_tools`：对**含 tool_calls 的 assistant 消息**保留并回传
   *   `reasoning_content`。DeepSeek V4 implicit thinking：工具轮不回传 reasoning
   *   上游会 400（`The reasoning_content in the thinking mode must be passed back`）。
   * - `preserve`：所有 assistant 消息都回传 `reasoning_content`（Kimi K3 /
   *   K2.7-code 等「保留式思考始终开启」模型；多轮与工具轮均要求原样回传）。
   */
  reasoningHistoryPolicy?: 'drop' | 'preserve_for_tools' | 'preserve';
}

/**
 * Catalog 不可达 / 缓存未命中 / IPC 未传能力数据时的保守默认值。
 * 32k context + 8k output：对 8k 窗口模型仍偏大，但不会像 128k 那样
 * 导致压缩永远不触发 → API 413/400。绝大多数现役模型 ≥ 32k。
 */
export const FALLBACK_MODEL_CAPABILITIES: ModelCapabilities = {
  contextWindowTokens: 32_000,
  maxOutputTokens: 8_192,
  maxInputTokens: 32_000,
  supportsVision: false,
  supportsFunctionCalling: true,
  supportsPromptCaching: false,
  cacheType: 'none',
};

// ─── Model Catalog Snapshot（子 Agent 模型自由度 · Phase 3/4） ───────────
// 宿主（Electron / Daemon）在 createRuntimeForSession 时从 Django
// `/services/llm/catalog`（按派单成员 tier 过滤后）拉取的「可用模型菜单」快照。
// runtime 据此：(1) 给主 Agent 渲染语义化模型清单（agent 工具 description）；
// (2) 派子 Agent 时按子模型解析能力（不再继承父）；(3) 命中目录才放行、命不中
// 确定性降级。**目录已是 tier 过滤后的结果**——子 Agent 自选只能在目录内选，
// 因此天然不绕过既有 max_model_tier（详见 PRD §4.5.4）。

export interface ModelCatalogEntry {
  /**
   * 发给 provider 的规范模型 id（= Django `LLMModel.model_name`）。
   * 也是主 Agent 在 agent 工具 `model` 参数里应填的值。
   */
  id: string;
  /** 人类可读显示名，仅用于渲染清单（缺省回落 id）。 */
  displayName?: string;
  /**
   * 该模型可被引用的别名（如历史 tier 词 `sonnet`/`opus`/`haiku`，或简写）。
   * 解析时 id / displayName / aliases 都参与匹配，鼓励主 Agent 填规范 id。
   */
  aliases?: string[];
  /** 从 Django catalog 解析出的该模型完整能力快照（按子模型解析的来源）。 */
  capabilities: ModelCapabilities;
  /**
   * 自动生成的语义用途标签（如「便宜/快」「长上下文」「视觉」「强/贵」）。
   * 来源：Django catalog 的 `usage_hint`（从 capabilities_config + 成本档自动
   * 派生，不让运营手写自由文案）。仅用于给主 Agent 选型的人话提示。
   */
  usageHint?: string;
  /** provider scope：`global`（平台）/ `organization` / `user`（BYOK）。 */
  providerScope?: string;
}

// ─── Cache Type Derivation (PRD §5.1.1) ─────────────────────────────
// 从 provider 名称和 capabilities_config 推导 cacheType。
// 两端宿主（Electron / Daemon）在构建 ModelCapabilities 时共用此函数，
// 确保推导逻辑不在宿主间漂移。

export const EXPLICIT_CACHE_PROVIDERS = new Set([
  'claude', 'anthropic', 'qwen',
]);

export const IMPLICIT_CACHE_PROVIDERS = new Set([
  'openai', 'deepseek', 'gemini', 'grok', 'moonshot',
  'zhipu', 'bytedance', 'dashscope', 'kimi', 'inclusionai',
]);

/**
 * 从 provider 名称推导 prompt cache 策略。
 *
 * - explicit：Claude / Qwen — 必须在 system blocks 上显式标注 cache_control。
 * - implicit：OpenAI / DeepSeek / Gemini 等 — provider 自动缓存前缀，无需客户端标注。
 * - none：未知 provider — 不发缓存指令（保守安全）。
 *
 * `capabilitiesConfig.supports_prompt_caching === true` 可作为 override：
 * 即使 provider 不在上述集合中，Django catalog 显式声明支持缓存也走 explicit。
 */
export function deriveCacheType(
  providerName: string | undefined,
  capabilitiesConfig?: Record<string, unknown>,
): 'explicit' | 'implicit' | 'none' {
  if (!providerName) return 'none';
  const name = providerName.toLowerCase();
  if (EXPLICIT_CACHE_PROVIDERS.has(name)) return 'explicit';
  if (capabilitiesConfig?.supports_prompt_caching === true) return 'explicit';
  if (IMPLICIT_CACHE_PROVIDERS.has(name)) return 'implicit';
  return 'none';
}

// ─── Reasoning History Policy Derivation ────────────────────────────
// 与 deriveCacheType 同款：按 provider 名 + capabilities_config 推导历史 reasoning
// 回传策略。默认 drop（安全侧，等价现状）；仅 implicit-thinking + 工具会 400 的
// provider 走 preserve_for_tools。

export const PRESERVE_REASONING_FOR_TOOLS_PROVIDERS = new Set([
  'deepseek',
  // 智谱官方：交错思考 + 工具必须回传 reasoning_content（与 DeepSeek 同一条路径）。
  'zhipu',
  // BYOK GLM Coding Plan 的 catalog provider_key，不能只认 zhipu。
  'zhipu_coding_plan',
]);

/**
 * 推导历史 reasoning 回传策略。
 *
 * - `preserve`：Kimi K3 等保留式思考始终开启——所有 assistant 消息必须回传
 *   `reasoning_content`。
 * - `preserve_for_tools`：DeepSeek / 智谱等——工具轮必须回传
 *   `reasoning_content`，否则上游 400 或后续轮空转。
 * - `drop`（默认）：其余全部 provider 保持现状（ 不回传）。
 *
 * `capabilitiesConfig.reasoning_history_roundtrip` 可作为 override（`preserve` /
 * `preserve_for_tools`）：即使 provider 不在集合中，Django catalog 显式声明也生效。
 */
export function deriveReasoningHistoryPolicy(
  providerName: string | undefined,
  capabilitiesConfig?: Record<string, unknown>,
): 'drop' | 'preserve_for_tools' | 'preserve' {
  const roundtrip = capabilitiesConfig?.reasoning_history_roundtrip;
  if (roundtrip === 'preserve') {
    return 'preserve';
  }
  if (roundtrip === 'preserve_for_tools') {
    return 'preserve_for_tools';
  }
  if (providerName && PRESERVE_REASONING_FOR_TOOLS_PROVIDERS.has(providerName.toLowerCase())) {
    return 'preserve_for_tools';
  }
  return 'drop';
}

// ─── Prompt Cache: Dynamic Boundary ──────────────────────────────────
// 宿主构建 system prompt 时在静态段与动态段之间插入此标记。
// runtime 的显式缓存策略据此确定 BP2（静态段末尾）断点位置。
// 若 system prompt 不含此标记，BP2 自动跳过，只用 BP1+BP3+BP4。
// E1 资源化：SSoT 已迁到 `packages/agent-runtime/src/prompts/engine/dynamic-boundary.ts`；
// 本处 import + 同名 re-export，让模块内部和历史消费者都能继续使用原 import 路径。
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../prompts/engine/dynamic-boundary.js';
export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY };

// ─── LLM Provider ───────────────────────────────────────────────────
// Single interface for all LLM calls. The only production implementation
// is TabTinProxyProvider — all calls (platform + BYOK) go through Django.

export interface RetryAttemptInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  statusCode?: number;
  errorMessage: string;
  /** True when retrying after a stream stall (partial content already emitted). */
  isStallRetry?: boolean;
}

export interface LLMRequest {
  model: string;
  messages: MessageParam[];
  tools?: ToolParam[];
  /**
   * 工具调用策略（OpenAI 词汇，Django wire_adapter 按上游能力归一/降级：
   * required → Anthropic {type:'any'}；不支持时降 auto + downgrade event）。
   * 由 beforeModel 钩子经 `restrictToolsForTurn(..., { forceCall: true })` 写入；
   * 默认策略栈不再写（登录墙已迁 Access Barrier HITL）。
   */
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  system?: string | SystemBlock[];
  maxTokens: number;
  temperature?: number;
  /**
   * 用户停止 / host abort 信号。provider 必须把它挂到底层 `fetch`（及 SSE
   * reader），不能只靠消费侧 checkAbort——否则本地 loop 退出后上游仍继续烧 token。
   */
  signal?: AbortSignal;
  /** Identifies the caller: '_main_chat' | '_compact' | '_summary_judge' | '_sub_agent' | '_digest' */
  requestSource?: string;
  /**
   * Stable logical-call key used only for billing deduplication.
   * HTTP retries and a replay of the same Agent job must reuse this value.
   */
  billingIdempotencyKey?: string;
  /** Called before each retry sleep so the caller can surface progress to the user. */
  onRetryAttempt?: (info: RetryAttemptInfo) => void;
  /**
   * Wave 2（Anthropic Messages API 协议对齐）：上游 SSE 解析时调用的 callback。
   *
   * proxy-provider 把每个 LLM 输出的 ContentBlock 生命周期事件
   * （content_block_start / delta / stop + message_delta usage）翻译成"半成品
   * envelope hint"通过此 callback 反推给 query.ts；query.ts 在 buffer 里把
   * 半成品补全 envelope 公共字段（trace_id / _seq / thread_id / message_id /
   * protocol_version / min_compatible_version）后 yield 出去。
   *
   * 设计取舍：不把 LLMProvider 接口改为 yield 完整 envelope event，是因为
   * (1) provider 不知道 message_id / trace_id（query.ts 才有 message-level boundary
   * 的控制权——retry 时 doRequest 调多次但 message_id 恒定）；
   * (2) provider 不应承担 _seq 单调性，跨 LLM 调用 _seq 必须连续；
   * (3) provider 仍 yield LLMResponseChunk 给 query.ts 内部状态机做累积——
   * 重复 emit 一次完整 envelope 会让 query.ts 既消费 chunk 又消费 envelope，
   * 双源真相相互打架。
   *
   * proxy-provider 内部状态机维护 blockIndex / activeBlockKind，按
   * Anthropic 协议硬约束严格串行 emit（content_block_stop(N) → start(N+1)）。
   *
   * Callback 必须 synchronous（不能 await）——proxy-provider 用 forEach 风格
   * 调用，hint 入 query.ts 的 buffer，下一个 chunk 进入 for-await 循环时
   * flush。
   */
  onContentBlockEvent?: (hint: ContentBlockEnvelopeHint) => void;
}

export interface LLMRequestMetadata {
  providerChannel?: string;
  isByokMode?: boolean;
  contextTierId?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

/**
 * Wave 2：proxy-provider 透传给 query.ts 的"半成品 envelope hint"。
 *
 * **kind 字段的字符串值与 `ContentBlockEvents.*` 常量对齐**——proxy-provider 内部
 * `import { ContentBlockEvents } from '@tabtin/agent-runtime/engine'` 后用 `ContentBlockEvents.X`
 * 直接当 kind，让 W2 验收脚本 `rg "ContentBlockEvents\." proxy-provider.ts ≥ 6`
 * 能验证迁移点数；同时让消费端 query.ts 路由时也复用同一组常量，避免硬编码字符串。
 *
 * 业务字段（index / block_id / block / delta）在 hint 里完备；envelope 公共字段
 * （message_id / trace_id / _seq / thread_id / event_type / protocol_version /
 * min_compatible_version 等）由 query.ts 在 emit 时补全。
 *
 * 不是 wire schema 的子集——仅在 packages/agent-runtime 内部跨模块传递。
 */
export type ContentBlockEnvelopeHint =
  | {
      kind: 'agent.stream.message_start';
      /**
       * 上游 LLM 给的 message_id（Anthropic 的 `message.id` / OpenAI 的 chat.completion id）。
       * 没有时为 undefined，由 query.ts 用 randomUUID() 补一个稳定 id；如果上游中途
       * 才给出（比如 Anthropic 的第一帧 SSE 才带 message_id），proxy 等到第一帧后再
       * emit 这条 hint。
       */
      upstream_message_id?: string;
      /** 上游模型 id（vendor 真实返回值，区别于 LLMRequest.model 的请求方期望）。 */
      upstream_model?: string;
    }
  | {
      kind: 'agent.stream.message_delta';
      delta: { stop_reason?: MessageStopReason; stop_sequence?: string | null };
      usage?: MessageUsage;
    }
  | {
      kind: 'agent.stream.message_stop';
    }
  | {
      kind: 'agent.stream.content_block_start';
      index: number;
      block_id: string;
      block: WireContentBlock;
    }
  | {
      kind: 'agent.stream.content_block_delta';
      index: number;
      delta: ContentBlockDeltaPayload;
    }
  | {
      kind: 'agent.stream.content_block_stop';
      index: number;
    };

export interface LLMResponseChunk {
  type:
    | 'text_delta'
    | 'tool_use'
    | 'tool_use_delta'
    | 'thinking'
    | 'usage'
    | 'stop'
    | 'cache_stats'
    | 'capability_event'
    | 'timing';
  /** Incremental text for assistant / thinking */
  text?: string;
  /** Tool use block (partial or complete) */
  toolUse?: {
    id: string;
    name: string;
    input: unknown;
  };
  /**
   * Widget Wave 1 (RFC §4.1)：tool_use args 流式增量。
   *
   * 当 type === 'tool_use_delta' 时携带：
   *   - id：上游 LLM 的 tool_use id（同一 tool_use 期间所有 deltas 共享）
   *   - name：工具名（首次 chunk 已知；后续 deltas 可能 name 为空字符串）
   *   - argDelta：JSON 字符串片段——可能是不完整 JSON（partial JSON），
   *     consumer 累积后再尝试 parse；同步发出的 tool_use chunk 仍会带完整 input
   *
   * 这是 transient UI 事件——不进 conversation history、不写库、不影响最终
   * tool_use chunk 的语义。原 blocks collector 不消费此事件（设计如此）。
   */
  toolUseDelta?: {
    id: string;
    name: string;
    argDelta: string;
  };
  /** Token usage (only on final chunk) */
  usage?: UsageReport;
  /** Stop reason */
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  /** Number of input tokens served from prompt cache (Anthropic / OpenAI cache_control) */
  cachedTokens?: number;
  /**
   * Wave 3：capability 协调事件（capability_downgrade / capability_warning）。
   *
   * 后端 wire_adapter 在请求适配阶段发现"该模型支持图片但不支持 4K 分辨率"
   * 这类**软不匹配**时，通过 SSE `event: capability_downgrade` / `event:
   * capability_warning` 打个事件，proxy 收到后 yield 一条 capability_event
   * chunk，query.ts 转成 `agent.stream.capability_event` 推给前端，前端在
   * ChatPanel 顶部展示"该模型不支持 4K 图片，已自动降为 1K"banner——不打断
   * 对话流，区别于 capability_gate 的硬错（`chunk.error` + 中文 user_message）。
   *
   * 字段约定（与后端 SSE event payload 字段一致）：
   *   - `kind: 'downgrade'` —— 已实际降级（图片转码 / tool 删减 / system 截断）
   *   - `kind: 'warning'`   —— 仅提示但本轮不会改变请求体
   *   - `feature`           —— 受影响的能力名（image / tool / system / json_schema 等）
   *   - `fallback_to`       —— 降级后采用的策略（omit_images / lower_resolution / ...）
   *   - `message`           —— 后端预渲染的中文提示（可直接展示给用户）
   *
   * 设计原则：
   *   - **transient 事件**——不进 conversation history、不写 ChatMessage 表；
   *   - 只服务 UI banner 即时渲染；
   *   - Renderer ChatStore 维护"当前 session 的降级 banner 列表"，可关闭、
   *     可在切模型 / 新会话时清空。
   */
  capabilityEvent?: {
    kind: 'downgrade' | 'warning';
    feature?: string;
    fallback_to?: string;
    message?: string;
    /** 让宿主把后端透传的扩展字段保留下来（telemetry / debug 用），不参与默认 UI。 */
    extras?: Record<string, unknown>;
  };
  /**
   * 端到端计时事件。仅携带阶段名、毫秒值与低敏元数据，禁止放入 prompt、
   * completion、API key、上游 URL 等内容。
   */
  timing?: {
    source: 'runtime' | 'proxy_provider' | 'django_proxy';
    phase: string;
    duration_ms?: number;
    elapsed_ms?: number;
    request_id?: string;
    attempt?: number;
    model?: string;
    extras?: Record<string, unknown>;
  };
}

export interface LLMProvider {
  createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk>;
  getRequestMetadata?(request: LLMRequest): LLMRequestMetadata | undefined;
}
