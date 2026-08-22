import { z } from 'zod';

// ─── Permission ──────────────────────────────────────────────────────

export const PermissionDecisionSchema = z.enum([
  'approved',
  'approved_for_session',
  'denied',
  'abort',
]);

export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/**
 * @deprecated  Phase 2：legacy 四档自动批准机制已整体下线——runtime 不再
 * 读写此字段（LocalPermissionHandler 不自动批准任何请求，判决权威是
 * `@tabtin/security-policy` judge() + ApprovalMode 三档）。schema 仅为 wire
 * `permission_mode` optional 字段的向后兼容保留（Django 侧静默丢弃），
 * 禁止新增消费方。
 */
export const PermissionModeSchema = z.enum([
  'default',
  'auto-approve-reads',
  'auto-approve-edits',
  'full-auto',
]);

/** @deprecated 见 PermissionModeSchema——#5394 Phase 2 下线，禁新增消费方。 */
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

const INTERACTIVE_HITL_MS = 30 * 60 * 1000;

export const PERMISSION_TIMEOUTS = {
  WARNING_MS: 60_000,
  PAUSE_MS: 90_000,
  FINAL_MS: INTERACTIVE_HITL_MS,
  FALLBACK_GRACE_MS: 30_000,
  FALLBACK_MS: INTERACTIVE_HITL_MS + 30_000,
  COUNTDOWN_THRESHOLD_S: INTERACTIVE_HITL_MS / 1000,
} as const;

// ─── Turn Lifecycle ──────────────────────────────────────────────────

export const TurnEndStatusSchema = z.enum([
  'completed',
  'failed',
  'cancelled',
]);

export type TurnEndStatus = z.infer<typeof TurnEndStatusSchema>;

// ─── Usage / Token Reporting ─────────────────────────────────────────

/** Wave 3: per-model 分桶中每个模型的用量快照（snake_case 与顶层 UsageReport 对齐）。 */
const PerModelUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number().optional(),
  cache_creation_tokens: z.number().optional(),
  reasoning_tokens: z.number().optional(),
  compact_input_tokens: z.number().optional(),
  compact_output_tokens: z.number().optional(),
  credits: z.number().optional(),
});

/**
 * UsageReport — 一次 LLM 调用 / 一次 query 的累计用量。
 *
 * 包含基础 token 计数、cost、cache 命中、reasoning、compact 分项、计费状态、
 * per-model 分桶。runtime（`buildUsagePayload`）/ Proxy billing 尾帧 / Wallet
 * 计费记账三条路径会消费这些字段。
 *
 * P2（2026-04-22）：此前 schema 只声明 input/output/total/cost_usd 4 字段，但
 * 运行时实际塞入 7+ 扩展字段（cache_read/charge_status/reasoning_tokens 等），
 * 导致 TS 编译期告警与代码层手动 `as Record<string, unknown>` cast。本次扩围
 * 让 schema 与运行时真相一致。详见
 */
export const UsageReportSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  reasoning_tokens: z.number().optional(),
  model: z.string().optional(),
  cost_usd: z.number().optional(),
  charge_status: z.string().optional(),
  compact_input_tokens: z.number().optional(),
  compact_output_tokens: z.number().optional(),
  /** Wave 3: per-model 分桶——key 是完整模型名，value 是该模型的累计用量。 */
  by_model: z.record(z.string(), PerModelUsageSchema).optional(),
  /**
   * `last_input_tokens` / `last_cache_read_input_tokens` / `last_cache_creation_input_tokens`
   * 来自 runtime `state._lastUsageAnchor`，即 **最近一次 LLM provider 响应**
   * 上报的真实 usage（已含 system + tools + messages 全部贡献）。
   *
   * 与 `input_tokens` 等 turn 累加值的关系：
   *   `input_tokens`        = Σ(本 turn 内所有 LLM 调用 input)         —— 计费 / 统计
   *   `last_input_tokens`   = 最后一次 LLM 调用的 input                —— 当前上下文规模
   *
   * 带 tool_use 的多轮调用 turn 中，前者会比后者大 2-3 倍（每轮都把全部历史
   * 重新喂进去）。UI 端「上下文用量环」的分子必须用 last_*，否则会随
   * tool_use 次数线性虚高，导致用户在没真正接近窗口上限时就看到「快满了」
   * 的假告警。公式：input + cache_creation + cache_read，不含 output。
   */
  last_input_tokens: z.number().optional(),
  last_cache_read_input_tokens: z.number().optional(),
  last_cache_creation_input_tokens: z.number().optional(),
});

export type UsageReport = z.infer<typeof UsageReportSchema>;

// ─── Plan Entry ──────────────────────────────────────────────────────

export const PlanEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
});

export type PlanEntry = z.infer<typeof PlanEntrySchema>;

// ─── Risk Assessment ─────────────────────────────────────────────────

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);

export type RiskLevel = z.infer<typeof RiskLevelSchema>;

// ─── Envelope ────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = 1;

export const GatewayRoleSchema = z.enum([
  'user',
  'backend',
  'daemon',
  'admin',
  'electron',
  'web',
  'mobile',
  'channel',
  'device_runtime',
  'open_api',
]);

export type GatewayRole = z.infer<typeof GatewayRoleSchema>;

// ─── Runtime Type (canonical device/runtime identity) ────────────────

export const RuntimeTypeSchema = z.enum([
  'electron',
  'daemon',
  'cloud',
  'mobile',
  'iot',
  'web',
]);

export type RuntimeType = z.infer<typeof RuntimeTypeSchema>;

export const GatewayEnvelopeSchema = z.object({
  v: z.number(),
  type: z.string(),
  request_id: z.string(),
  ts: z.number(),
  device_id: z.string(),
  role: z.string(),
  payload: z.record(z.unknown()),

  event_id: z.string().optional(),
  reply_to: z.string().optional(),
  thread_id: z.string().optional(),
  trace_id: z.string().optional(),
  organization_id: z.string().optional(),
  session_id: z.string().optional(),
  table_id: z.string().optional(),
  instance_id: z.string().optional(),
});

export type GatewayEnvelope = z.infer<typeof GatewayEnvelopeSchema>;

// ─── Focus Snapshot / Task Capsule ───────────────────────────────────

export {
  FOCUS_SNAPSHOT_LIMITS,
  FocusAppMetaSchema,
  FocusTabSchema,
  WorkspaceModeSchema,
  FocusSnapshotSchema,
} from './focus-snapshot.js';

export type {
  FocusAppMeta,
  FocusTab,
  WorkspaceMode,
  FocusSnapshot,
} from './focus-snapshot.js';

export {
  TASK_CAPSULE_STATUS_KEYS,
  TaskCapsuleStatusKindSchema,
  TaskCapsuleRunPhaseSchema,
  TaskCapsuleStatusInputSchema,
  TaskCapsuleVisualKindSchema,
  resolveTaskCapsuleStatus,
  resolveTaskCapsuleVisual,
} from './task-capsule.js';

export type {
  TaskCapsuleStatusKind,
  TaskCapsuleRunPhase,
  TaskCapsuleStatusInput,
  TaskCapsuleVisualKind,
} from './task-capsule.js';
