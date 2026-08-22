/**
 * engine/contracts 第 1 层 —— wire 协议观测契约。
 *
 * Stream Events（`agent.stream.*` 事件形态）+ ContentBlock envelope 6 件套 +
 * LLM Call Snapshot（debug observability）+ System Section Registry。
 * payload 形状由本地 `wire-payloads.ts` 持有（ Stage 5a），
 * 字段与 `@tabtin/agent-wire` 字节对齐；Zod 校验仍在 wire / host。
 *
 * 分层规则（ 批次 14）：contracts 内 7 层只允许后层 import 前层——
 * wire-protocol ← conversation ← model-llm ← tools ← hitl ←
 * context-capability ← kernel。本文件是第 1 层，不 import 任何兄弟契约。
 * 守卫：`scripts/check-engine-layering.mjs`。
 */

import type {
  StreamEventType,
  StreamLifecycle,
  StreamStep,
  StreamDone,
  CompactionStats,
  MessageStart as WireMessageStart,
  MessageDelta as WireMessageDelta,
  MessageStop as WireMessageStop,
  ContentBlockStart as WireContentBlockStart,
  ContentBlockDelta as WireContentBlockDelta,
  ContentBlockStop as WireContentBlockStop,
} from './wire-payloads.js';

/**
 * detached mini-message 的 block / delta 类型。
 * 让 kernel / hook-runner 的通用 `emitDetachedMiniMessage` 原语从本地 contracts
 * 引用，而不依赖 `@tabtin/agent-wire`（ Stage 5a）。
 */
export type DetachedMiniMessageBlock = WireContentBlockStart['block'];
export type DetachedMiniMessageDelta = WireContentBlockDelta['delta'];

// ─── System Section Registry (Phase 1 · Debug Observability) ─────────
// 所有动态注入段的统一名称注册表与元数据接口。
// query.ts 的 appendSection 据此为每个注入段生成 XML comment 格式的
// section marker，后续 Phase 2 的 LLM call snapshot 据此提供分段元数据。

// SYSTEM_SECTION_NAMES：所有 section name 的中心枚举。
//
// 阶段 1.5 治理（2026-05-20）：key 和 value 同步对齐 SECTION_REGISTRY id
// （prompt-contract 包），ESLint section-name-match 规则按属性 key 查 registry。
// 调用方写 SYSTEM_SECTION_NAMES.convergence_hint 即可命中。
//
// 阶段 2.2 清理（2026-05-20）：删除 notes_hint / doom_loop_hint（C.2 历史死
// 路径，写入者已删，对应 hint 字段 + query.ts 注入代码全部下线）。
//
// 例外（marker 类、非 hook 段，无对应 registry id，ESLint 白名单跳过）：
//   - base_prompt, custom_rules：sectionRegistry.push 的元数据 marker
export const SYSTEM_SECTION_NAMES = {
  // ─── marker 类（非 hook 段，无对应 registry id；ESLint 白名单）───
  base_prompt: 'base_prompt',
  custom_rules: 'custom_rules',
  // W3 (2026-05-10): `condense` / `condense_in_progress` section names
  // removed alongside the `summarize_context` tool — the orchestrator no
  // longer injects "please call summarize_context" prompts. Names kept in
  // git history; runtime no longer references them.
  // ─── key+value 对齐 SECTION_REGISTRY id ───
  convergence_hint: 'convergence_hint',
  /** 静态段：全部 skill 名称索引（query 无关、跨轮稳定、可缓存）。 */
  skills_index: 'skills_index',
  skills_listing: 'skills_listing',
  /** Project Task execution anchor; only emitted with a complete task context. */
  project_task_context: 'project_task_context',
  /** 静态段：已挂载 MCP server + 工具名索引（query 无关、跨轮稳定、可缓存）。 */
  mcp_servers: 'mcp_servers',
  /** 静态段：tabtin CLI 命令名索引（按 domain 分组，query 无关、跨轮稳定、可缓存）。 */
  cli_commands: 'cli_commands',
  /** 静态段：runtime 原生 tool-call metadata 契约。 */
  tool_call_metadata: 'tool_call_metadata',
  budget_warn_system: 'budget_warn_system',
  budget_grace_system: 'budget_grace_system',
  /**
   * W3 Stall detection nudge (FR-?). 当 LLM 连续用同一工具撞同一类错误时，
   * runtime 注入此段引导它考虑 ask_question / 换思路 / 文字总结收尾。
   * 与 budget_warn / budget_grace 正交：前者按比例触发，本段按 streak 计数触发。
   * 详见 `engine/tool-failure-tracker.ts`。
   */
  stall_detection: 'stall_detection',
  /**
   * Wave 6 Repetition detection nudge (sibling of `stall_detection`).
   * 当 LLM 在 30s 窗口内对同 (tool, inputDigest) 反复成功 emit 时，runtime
   * 注入此段提醒 "Do NOT re-issue the same tool with the same input"。
   * 与 stall_detection 正交：前者看失败 streak，本段看成功复读总计数。
   * 详见 `engine/tool-repetition-tracker.ts`。
   */
  repetition_detection: 'repetition_detection',
} as const;

export type SystemSectionName = typeof SYSTEM_SECTION_NAMES[keyof typeof SYSTEM_SECTION_NAMES];

export interface SystemSection {
  name: SystemSectionName;
  source: string;
  content: string;
  charCount: number;
}

// ─── Stream Events ──────────────────────────────────────────────────
// Local Runtime yields these events via AsyncGenerator.
// They use the same `agent.stream.*` type strings as the existing WS protocol,
// so the Renderer's streamMessageHandler can consume them directly.

export interface StreamEvent {
  type: StreamEventType | string;
  payload: Record<string, unknown>;
}

export interface LifecycleEvent extends StreamEvent {
  type: 'agent.stream.lifecycle';
  payload: StreamLifecycle & Record<string, unknown>;
}

// W4.5 第三波 C1（2026-05-13）：wire 层 `StreamEvents.ASSISTANT/REASONING/TOOL/
// CHUNK/REVIEW_REQUIRED/TOOL_TIMEOUT/TOOL_HEARTBEAT/CONTENT_RESET/TOOL_CALL_ARGS_DELTA`
// 9 个老常量已物理删除（详见 packages/agent-wire/src/events.ts 顶部 docblock）。
// agent-runtime 内部 emit 早在 W2 终态全归零，本期顺手清跨包 consumer + wire 定义。
//
// **C1 范围外保留**：`agent.stream.step` 仍由本文件 StepEvent + query.ts 2 处
// yield 在 daemon 内活跃使用——W5/W6 mobile 仍消费它渲染 thinking 步骤卡片，
// 待 W5/W6 接 6 件套后再做下一轮清理。

export interface StepEvent extends StreamEvent {
  type: 'agent.stream.step';
  payload: StreamStep & Record<string, unknown>;
}

export interface DoneEvent extends StreamEvent {
  type: 'agent.stream.done';
  payload: StreamDone & Record<string, unknown>;
}

export interface CompactionEvent extends StreamEvent {
  type: 'agent.stream.compaction';
  /**
   * FR-11：`stats` 字段对齐 `@tabtin/agent-wire` `CompactionStats` schema。
   * `phase: 'end'` 时由 compaction-orchestrator / query.ts 三个 mode 路径
   * 分别填充 `messages_before/after`、`tokens_before/after`、`tool_uses_retained`。
   *
   * 保留 `& Record<string, unknown>` 让宿主可附加路径专属字段
   * （reactive 的 `summary_length`、recovery_413 的 `tokens_freed` 等）。
   */
  payload: {
    phase: 'start' | 'end';
    mode?: string;
    stats?: CompactionStats & Record<string, unknown>;
  } & Record<string, unknown>;
}

export interface ContextPressureEvent extends StreamEvent {
  type: 'agent.stream.context_pressure';
  payload: {
    pressure: number;
    level: string;
    estimatedTokens: number;
    contextWindow: number;
    model: string;
  } & Record<string, unknown>;
}

export interface SystemNoticeEvent extends StreamEvent {
  type: 'agent.stream.system_notice';
  payload: {
    content: string;
    notice_type?: string;
  } & Record<string, unknown>;
}

// W2 silent-bypass 修复：原本保留的 `ContentResetEvent` 与 `ToolCallArgsDeltaEvent`
// 也整体删除——content_reset 语义已被 `message_start` 自然替代（每次 LLM 调用
// 起新 message_id 即"重置"），tool_call_args_delta 的 transient widget 增量
// 走 `content_block_delta(input_json_delta)`。

// ─── Wave 2 · ContentBlock envelope events ──────────────────────────
//
// query.ts 把 ContentBlockEvents 6 件套作为 StreamEvent yield 出去，envelope
// payload 直接复用 `@tabtin/agent-wire` 的 schema infer 类型（含 protocol_version /
// min_compatible_version / trace_id / _seq / thread_id 等公共字段）。

export interface MessageStartEvent extends StreamEvent {
  type: 'agent.stream.message_start';
  payload: WireMessageStart & Record<string, unknown>;
}

export interface MessageDeltaEvent extends StreamEvent {
  type: 'agent.stream.message_delta';
  payload: WireMessageDelta & Record<string, unknown>;
}

export interface MessageStopEvent extends StreamEvent {
  type: 'agent.stream.message_stop';
  payload: WireMessageStop & Record<string, unknown>;
}

export interface ContentBlockStartEvent extends StreamEvent {
  type: 'agent.stream.content_block_start';
  payload: WireContentBlockStart & Record<string, unknown>;
}

export interface ContentBlockDeltaEvent extends StreamEvent {
  type: 'agent.stream.content_block_delta';
  payload: WireContentBlockDelta & Record<string, unknown>;
}

export interface ContentBlockStopEvent extends StreamEvent {
  type: 'agent.stream.content_block_stop';
  payload: WireContentBlockStop & Record<string, unknown>;
}

/**
 * Wave 2 envelope union——主要给 storage.ts / select-recent-history 等内部模块
 * 做窄类型约束。query.ts 实际 yield 时仍然以 StreamEvent 大杂烩 union 形态走，
 * 保持向后兼容（其他元事件 / 老内容流事件都还是同一根类型）。
 */
export type ContentBlockEnvelopeEvent =
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent;

// ─── LLM Call Snapshot (Phase 2 · Debug Observability) ───────────────
// 每次 LLM 调用前的完整入参快照。yield 为 LLM_REQUEST 事件，由
// SnapshotStorage 持久化到 {sessionDir}/{threadId}/snapshots.jsonl。

export interface LLMCallMessageSummary {
  role: string;
  source:
    | 'context_injection'
    | 'memory_recall'
    | 'agent_profile'
    | 'project_rules'
    | 'lsp_diagnostics'
    | 'tool_eviction_notice'
    | 'mode_reminder'
    | 'mode_transition_reminder'
    | 'active_todos'
    | 'relevant_recall'
    | 'todo_completion_nudge'
    | 'continuation'
    | 'tool_injected'
    | 'tool_result'
    | 'user_input'
    | 'history'
    | 'compaction_summary';
  // 'text' = contentPreview 即纯文本；'blocks' = contentPreview 是 ContentBlock[]
  // 的 JSON 序列化（前端 parse 后按 tool_use / tool_result / image 等类型结构化渲染）。
  format: 'text' | 'blocks';
  contentPreview: string;
  charCount: number;
}

export interface LLMCallToolSummary {
  name: string;
  description: string;
  // 工具的完整 JSON Schema——发给 LLM 的 tool 定义的真实组成部分，占可观 token。
  inputSchema: Record<string, unknown>;
}

export interface LLMCallSectionSummary {
  name: string;
  source: string;
  charCount: number;
  contentPreview: string;
}

// 本次 LLM 调用的模型输出（assistant 回复）。调用前的快照无此字段；调用完成、
// assistant 消息组装好后，以同 (runId, iteration) 再 emit 一次带本字段的快照，
// 消费端按 (runId, iteration) upsert 覆盖。它正是下一轮会进入 history 的内容，
// 因此对「完整查看会进入上下文的全部内容」是必要的一环（尤其末轮输出）。
export interface LLMCallResponse {
  format: 'text' | 'blocks';
  contentPreview: string;
  charCount: number;
  stopReason?: string;
}

export interface LLMCallSnapshot {
  timestamp: number;
  timestampISO: string;
  runId: string;
  iterationId?: string;
  phase?: 'request' | 'response';
  iteration: number;
  model: string;
  providerChannel?: string;
  isByokMode?: boolean;
  contextTierId?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  maxTokens: number;
  temperature?: number;
  requestSource?: string;
  system: {
    sections: LLMCallSectionSummary[];
    charCount: number;
  };
  messages: LLMCallMessageSummary[];
  messageCount: number;
  tools: LLMCallToolSummary[];
  toolCount: number;
  // 模型本次调用的输出；仅在「调用完成后」补发的那条快照里存在（见 LLMCallResponse）。
  response?: LLMCallResponse;
}

export interface LLMRequestEvent extends StreamEvent {
  type: 'agent.stream.llm_request';
  payload: LLMCallSnapshot & Record<string, unknown>;
}

export interface LLMUsageEvent extends StreamEvent {
  type: 'agent.stream.llm_usage';
  payload: {
    timestamp: number;
    timestampISO: string;
    runId: string;
    iterationId: string;
    iteration: number;
    model: string;
    requestSource?: string;
    providerChannel?: string;
    isByokMode?: boolean;
    contextTierId?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    durationMs: number;
    messageCount: number;
    toolCount: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    reasoning_tokens: number;
    credits_charged: number;
    last_input_tokens?: number;
    last_cache_read_input_tokens?: number;
    last_cache_creation_input_tokens?: number;
  } & Record<string, unknown>;
}
