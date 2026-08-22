/**
 * Zod schemas for `agent.stream.*` payloads.
 *
 * 设备端本地 runtime 经 relay_events 批量回传这些事件，Backend 落库后转发给
 * Frontend；Frontend 渲染管线直接消费。
 *
 * **协议层归零（W4.5 第三波 C1，2026-05-13）**
 *
 * `StreamAssistantSchema` / `StreamReasoningSchema` / `StreamToolSchema` 及其
 * 配套 `AssistantPhaseSchema` / `ToolPhaseSchema` 已物理删除——daemon 0 emit、
 * Renderer / iOS / Android listener 同步清。详见 `events.ts` 顶部 docblock。
 *
 * 保留的"非 LLM 事件"schema：lifecycle / done / system_notice / compaction 等；
 * 这些不属本期 Anthropic 协议对齐范围，继续按现状沿用。
 * ：plan / mode stream schema 已物理删。
 *
 * **C1 范围外保留**：`StepStatusSchema` / `StreamStepSchema` 仍保留——daemon
 * `query.ts` 还 emit thinking 步骤的 `agent.stream.step` 事件给 W5/W6 mobile
 * 渲染步骤卡片用。详见 `events.ts::StreamEvents.STEP` JSDoc 与 §0.6 跟踪项。
 *
 * **新协议（Anthropic Messages API 风）schema 在 `stream-content-block.ts`**：
 *   - `ContentBlockSchema`（22 case discriminated union）
 *   - `MessageStart/Delta/Stop` + `ContentBlockStart/Delta/Stop` 6 件套
 */

import { z } from 'zod';
import { SourceMetaSchema } from './common.js';
// P2（2026-04-22）：UsageReport / Plan / Risk 已统一从 contracts 包导出，
// wire 这里不再保留重复定义。
import {
  RiskLevelSchema,
  UsageReportSchema,
} from '@tabtin/contracts/agent';

// ─── Lifecycle ───────────────────────────────────────────────────────

export const LifecyclePhaseSchema = z.enum([
  'start',
  'end',
  'error',
  'turn_start',
  'turn_end',
  'permission_timeout',
  'permission_timeout_warning',
  'permission_timeout_pause',
  'idle_timeout',
  'terminated',
  'heartbeat',
  'session_resume_failed',
  'retrying',
  'session_interrupted',
]);

export type LifecyclePhase = z.infer<typeof LifecyclePhaseSchema>;

const LifecycleToolDurationSchema = z.object({
  tool_name: z.string(),
  tool_call_id: z.string(),
  duration_ms: z.number(),
  status: z.enum(['completed', 'failed']),
});

export const StreamLifecycleSchema = z.object({
  phase: LifecyclePhaseSchema,
  status: z.string().optional(),
  detail: z.string().optional().nullable(),
  error_message: z.string().optional(),
  run_id: z.string().optional(),
  trace_id: z.string().optional(),
  turn_id: z.string().optional(),
  iteration: z.number().optional(),
  started_at: z.number().optional(),
  ended_at: z.number().optional(),
  duration_ms: z.number().optional(),
  tool_call_count: z.number().optional(),
  tool_duration_ms: z.number().optional(),
  tool_durations: z.array(LifecycleToolDurationSchema).optional(),
  reason: z.string().optional(),
  request_id: z.string().optional(),
  tool_name: z.string().optional(),
  active_tool_calls: z.number().optional(),
  uptime_seconds: z.number().optional(),
}).merge(SourceMetaSchema.partial());

export type StreamLifecycle = z.infer<typeof StreamLifecycleSchema>;

// ─── Assistant / Reasoning / Tool ────────────────────────────────────
//
// W4.5 第三波 C1 物理删除（2026-05-13）：
//   - AssistantPhaseSchema / StreamAssistantSchema
//   - StreamReasoningSchema
//   - ToolPhaseSchema / StreamToolSchema
//
// 新协议下由 ContentBlockSchema 的 `text` / `thinking` / `redacted_thinking` /
// `tool_use` 块 + content_block_start/delta/stop 三件套整体替代。
// 详见文件顶部 docblock。

// ─── Done ────────────────────────────────────────────────────────────

/**
 * 错误归因 class 字符串 (FR-06 / FR-15)。
 *
 * 取值与 `@tabtin/agent-runtime` 的 `AgentErrorCode` 联合类型对齐（FR-06）：
 * `LLM_ERROR` / `LLM_BILLING_ERROR` / `LLM_RATE_LIMIT` /
 * `LLM_KEY_EXHAUSTED` / `TOOL_ERROR` / `TOOL_TIMEOUT` /
 * `PERMISSION_DENIED` / `PERMISSION_TIMEOUT` / `CONTEXT_OVERFLOW` /
 * `MAX_TURNS_EXCEEDED` / `MAX_CREDITS_EXCEEDED` / `DOOM_LOOP_DETECTED` /
 * `ABORT` / `INTERNAL`。
 *
 * **FR-15 IterationBudget 新增的"优雅终止"枚举值**（与 `error: false`
 * 配对，前端展示"已完成（达上限）"而非红色错误）：
 * - `iteration_budget_exhausted` — 触达 `EngineConfig.maxTurns` 比例上限
 * - `token_budget_exhausted` — 触达 `BudgetTracker.maxTotalTokens` 比例上限
 *
 * 与 `MAX_TURNS_EXCEEDED` / `MAX_CREDITS_EXCEEDED`（`error: true` 硬错误）的
 * 区别：FR-15 是 PRD Q3 决策 E"双通路兜底"路径——iteration 70/90/100% +
 * token 85/95/100% 三档，到 grace 时 LLM 强制做最后总结，到 terminate 时
 * `error: false` 优雅退出，与硬断报错严格区分。
 *
 * 这里**故意**留作 `string` 而不是 `enum`：
 * - Wire schema 不强约束 enum，避免 Runtime 端新增枚举值时旧消费者校验失败；
 * - Runtime 端的 `AgentErrorCode` 联合类型 + IterationBudget 的两个新枚举值
 *   仍是真相源，编译期保证写入侧合法；
 * - 前端 / mobile 等消费者按已知值分支展示文案，未知值走 default。
 *
 * **消费者迁移指南**：避免对完整 `done` payload 使用 `z.object({...}).strict()`，
 * 否则未来 Runtime 增字段会 break。优先使用 `.strip` 默认行为或 `.passthrough()`，
 * 并且对 `error_class` 维护一张**已知值 → 文案** 映射表，未知值落 default 文案。
 *
 * **前端展示分组建议**（H3-A FR-15 配套）：
 * - `error: true && error_class ∈ AgentErrorCode` → 红色错误，按
 *   `suggested_action` 给出重试 / 切换模型建议
 * - `error: false && error_class === 'iteration_budget_exhausted' /
 *   'token_budget_exhausted'` → 灰色提示"对话已完成（达上限）"，提供
 *   "继续追问"或"新开会话"操作（与上方两类视觉区分）
 * - `error_class` 缺省 → 当前最常见的 happy path，无特殊提示
 *
 * 详见 PRD §6.1（向后兼容）+ 遗留项 L8（前端 PM 文案审）+
 * 总控 §10 LH2-B1（mobile DONE 不读 error_class，迁移升级跟进）。
 */
export const StreamDoneSchema = z.object({
  content: z.string().optional(),
  error: z.boolean().optional(),
  error_message: z.string().optional(),
  /**
   * FR-06 错误归因 class，仅在 `error: true` 时有意义。值域见上方 docstring。
   * 旧消费者无此字段也不影响展示（向后兼容）。
   */
  error_class: z.string().optional(),
  /**
   * FR-06 人类可读的下一步建议（中文优先，回落英文）。
   * 不强约束格式，前端可按需要重写为本地化文案；缺省时按 `error_class`
   * 自行映射默认文案。
   */
  suggested_action: z.string().optional(),
  /**
   * FR-06 / FR-10 关联：Runtime 为本次 query 分配的 trace_id。
   * H2-A 接通 AdminDash 后会用此 id 在 `ExecutionTrace` 表中关联 span。
   * 当前 H2-B 阶段仅由 Runtime 写入；H2-A 完成后 relay/Backend 端复用即可。
   */
  trace_id: z.string().optional(),
  agent_type: z.string().optional(),
  usage: UsageReportSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
}).merge(SourceMetaSchema.partial());

export type StreamDone = z.infer<typeof StreamDoneSchema>;

// ─── Step ────────────────────────────────────────────────────────────
//
// W4.5 第三波 C1 范围外保留：daemon `query.ts` 仍 emit `agent.stream.step`
// （thinking 步骤 running/done 信号），W5/W6 mobile 仍消费用以渲染步骤卡片。
// 新协议下"步骤分组"语义由 BlockTimeline 客户端按 ContentBlock 顺序自然承接
// （v2 §3.5.1.b）；待 W5/W6 完成 6 件套接管 + 移除 mobile handleStep 后再清。
//
// ：StreamPlanSchema / StreamModeSchema 已物理删（agent.stream.plan /
// agent.stream.mode 全仓 0 emit）。

export const StepStatusSchema = z.enum(['running', 'done', 'error']);

export const StreamStepSchema = z.object({
  step_type: z.string(),
  title: z.string(),
  status: StepStatusSchema,
  step_id: z.string().optional(),
  run_id: z.string().optional(),
  detail: z.string().optional().nullable(),
}).merge(SourceMetaSchema.partial());

export type StreamStep = z.infer<typeof StreamStepSchema>;

// ─── System Notice ──────────────────────────────────────────────────
//
// SYSTEM_NOTICE 是 runtime 出于"自身可观测性 + 用户感知兜底"目的发出的轻量
// 提示事件（与 LLM 真正的 ASSISTANT 输出区分）。`notice_type` 是稳定字面量
// 标识，前端按已知值走 i18n / 视觉分类，未知值落 default 文案——这与 DONE
// `error_class` 同惯例，**不**强约束 enum 以保证 runtime 端新增枚举值时旧
// 消费者不被 schema 校验阻塞。
//
// 已知值清单见 `KNOWN_SYSTEM_NOTICE_TYPES`，新增时同步：
//   1. 本表加常量
//   2. `apps/tabtin-electron/src/renderer/src/i18n/locales/{zh-CN,en-US}/chat.json`
//      在 `systemNotice` 节点下加 `{notice_type}` 子键（参考 `tool_started` /
//      `toolFailureNotice` 等同位 sibling 文案）
//   3. （可选）`systemHandler.ts` 加按类型的结构化字段映射

/**
 * Runtime 发送 SYSTEM_NOTICE 时使用的稳定 `notice_type` 字面量集合。
 *
 * 分五类：
 *  1. **iteration_budget**（FR-15）：双通路兜底升级到 warn / grace / terminate /
 *     grace_tool_blocked 时的提醒。
 *  2. **tool_failure**（W3 stall detector）：连续撞墙到 notice / nudge 阈值。
 *  3. **subagent**（FR-17 子 Agent 治理）：spawn 拒绝 / model 切换。
 *  4. **tool_lifecycle**（W2 二轮 silent-bypass workaround）：工具执行 lifecycle
 *     从老 `agent.stream.tool` 物理迁移到 SYSTEM_NOTICE + notice_type='tool_*'
 *     —— 详见 §六 W2-L4 + `packages/agent-runtime/src/engine/tool-lifecycle-notice.ts`。
 *     **W7 决策点**（§六 W2-L3）：是否要把 tool lifecycle 从 SYSTEM_NOTICE
 *     拆出到专用 `agent.stream.tool_execution` 元事件类型；那时本组常量
 *     可整体迁移到新事件的 enum。在此之前 daemon 仍按 SYSTEM_NOTICE 路径 emit。
 *  5. **misc**：context 压缩 / hook 错误 / crash resume / endConversation 等。
 *
 * **不**用作 zod schema 的 enum 限定——schema 仍是 `z.string().optional()`
 * 以保证向前兼容。本数组是文档 + 前端 catalog 校对用的"已知值清单"。
 */
export const KNOWN_SYSTEM_NOTICE_TYPES = [
  // FR-15 IterationBudget
  'iteration_budget_warn',
  'iteration_budget_grace',
  'iteration_budget_terminate',
  'iteration_budget_grace_tool_blocked',

  // W3 Stall detector (tool failure tracker)
  'tool_failure_notice',
  'tool_failure_nudge',

  // FR-17 子 Agent 治理
  'subagent_spawn_blocked',

  // 其他 runtime / orchestration 通路
  'context_truncated',
  'model_override',
  'model_fallback',
  'budget_exhausted',
  'conversation_terminated',
  'crash_resume_warn',
  'hook_error',
  'run_observation_injected',
  'llm_timing',

  // FR-07 工具入参 schema 校验（默认 severity=silent）：只喂模型纠错，
  // 不向用户弹对话横幅。见 tool-orchestration validateAndMaybeAttachWarning。
  'tool_schema_warn',
  'tool_schema_strict',

  // W2 二轮 silent-bypass workaround：tool execution lifecycle
  // （主路径 tool-orchestration.ts::makeToolLifecycleNotice + pre-started
  //  exec 优化路径 query.ts）。consumer：systemHandler.ts 优先桥接
  //  handleToolLifecycleNotice 重建 toolEvent + agentStep；payload 不全时
  //  回落到 chat.json 内 systemNotice.tool_* 文案做 fallback 显示。
  //  详见 packages/agent-runtime/src/engine/tool-lifecycle-notice.ts。
  'tool_intent_available',
  'tool_started',
  'tool_completed',
  'tool_failed',
  'tool_pre_started_exec_started',
  'tool_pre_started_exec_completed',
  'tool_pre_started_exec_failed',
  // 2026-05-17 streaming tool_progress：foreground 长跑命令期间，
  // ShellCap.execute 通过 PtyManagerBridge 的 onProgress 回调按 5s 或 1KB 触发
  // 一条 SYSTEM_NOTICE 给前端 TerminalCard 实时刷 partial body。
  // payload 形态（passthrough 字段）：
  //   - tool_name / tool_call_id / phase='progress'（lifecycle 兼容字段）
  //   - stdout: string（已截断到 ≤8KB，head + tail 形态）
  //   - output_bytes: number（累积总输出字节，未截断）
  //   - truncated: boolean / captured_at: number（snapshot 元信息）
  // 这条 notice **不进 LLM context**——只走前端 lifecycle event store。
  // 详见 `harness_StreamingToolResult_PRD_2026-05-17.md` B 方案。
  'tool_progress',
] as const;

export type KnownSystemNoticeType = (typeof KNOWN_SYSTEM_NOTICE_TYPES)[number];

/**
 * `agent.stream.system_notice` payload schema。
 *
 * - `content`：必填，给用户看的文案（i18n 后的中文 / 模型选择的语言）。
 *   runtime 端总是中文（与 iteration-budget grace / W3 stall notice 同惯例），
 *   前端可用 `notice_type` 模板覆盖（详见 `KNOWN_SYSTEM_NOTICE_TYPES`）。
 * - `notice_type`：可选字面量，详见上方常量清单。schema 不强约束 enum 保证
 *   向前兼容。
 * - `severity`：可选，`'silent'` 让前端忽略不展示；缺省按 notice_type 归类。
 * - 其他字段：`.passthrough()` 允许（结构化补充字段如 `tool` / `error_kind` /
 *   `streak` / `current_children` 等，由各 notice_type 定义自己的 contract）。
 */
export const StreamSystemNoticeSchema = z
  .object({
    content: z.string(),
    notice_type: z.string().optional(),
    severity: z.string().optional(),
  })
  .passthrough()
  .merge(SourceMetaSchema.partial());

export type StreamSystemNotice = z.infer<typeof StreamSystemNoticeSchema>;

// ─── Compaction ──────────────────────────────────────────────────────

export const CompactionPhaseSchema = z.enum(['start', 'end']);

/**
 * FR-11 压缩前后快照字段。所有字段都是**可选**，便于以下场景：
 *
 * - `phase: 'start'` 时全部缺省（统计未完成）；
 * - 旧版本 Runtime / orchestration 路径仅 emit 部分字段时不至于被 schema 拒绝；
 * - 未来扩展（如 `summary_tokens`）只追加字段不破坏现状。
 *
 * `messages_*` 数组长度差与 `tokens_*` token 估算差合在一起，前端
 * `handleCompaction` 据此向用户展示更精准的"压缩了多少"文案。
 *
 * `tool_uses_retained` 用于辨识"本次压缩保留了几个 tool_use" —— 是 reactive
 * vs auto vs emergency 区分价值的关键指标（auto 通常 retain 更多，
 * emergency_blocking 几乎清零）。
 */
export const CompactionStatsSchema = z.object({
  messages_before: z.number().optional(),
  messages_after: z.number().optional(),
  tokens_before: z.number().optional(),
  tokens_after: z.number().optional(),
  tokens_freed: z.number().optional(),
  tool_uses_retained: z.number().optional(),
  /** Runtime reactive 路径专用——summary 字符长度。 */
  summary_length: z.number().optional(),
}).passthrough();

/**
 * `agent.stream.compaction` event payload schema (FR-11)。
 *
 * `mode` 用 `string` 而非 enum：
 * - 兼容 `@tabtin/agent-runtime` 的 `CompactionMode` 联合类型 (auto / native /
 *   micro / reactive / emergency_blocking / recovery_413 / hard_trim)；
 * - 允许云端 orchestration 历史路径的 `auto_condense` / `emergency` 字面量
 *   （前端 miscHandler 自行映射）。
 */
export const StreamCompactionSchema = z.object({
  phase: CompactionPhaseSchema,
  mode: z.string().optional(),
  stats: CompactionStatsSchema.optional(),
}).merge(SourceMetaSchema.partial());

export type CompactionPhase = z.infer<typeof CompactionPhaseSchema>;
export type CompactionStats = z.infer<typeof CompactionStatsSchema>;
export type StreamCompaction = z.infer<typeof StreamCompactionSchema>;
