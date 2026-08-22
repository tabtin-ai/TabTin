/**
 * SubagentCompletionEnvelope — 主↔子 Agent 终态「完成信封」SSoT（ Wave1）。
 *
 * 前台 tool_result / 后台 NotificationQueue / UI SubagentRun 卡片必须同构消费本形状，
 * 避免三套平行字段漂移（有过程没结果、后台突然塞话、卡片与主 Agent 各说各话）。
 *
 * 身份与排序仍走 stream 信封顶层 `event_id` / `arrival_seq`；本结构是
 * **业务终态契约**，不是跨源去重键。
 */

import { z } from 'zod';

/** 子 Agent 终态（通知 / Manager / UI 对齐）。timeout 单独枚举，UI 可映射到 failed+errorKind。 */
export const SubagentTerminalStatusSchema = z.enum([
  'completed',
  'failed',
  'cancelled',
  'timeout',
]);
export type SubagentTerminalStatus = z.infer<typeof SubagentTerminalStatusSchema>;

/**
 * UI / 产品生命周期（人可见进度卡）。
 * 与 runtime 调度态 `SubagentSchedulerState`（active|queued）刻意区分命名。
 */
export const SubagentLifecycleStatusSchema = z.enum([
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type SubagentLifecycleStatus = z.infer<typeof SubagentLifecycleStatusSchema>;

/** 轻量 stats：前后台均可选填；前台 stream COMPLETED 已有完整 tokens，后台至少有 duration。 */
export const SubagentCompletionStatsSchema = z
  .object({
    duration_ms: z.number().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    credits_consumed: z.number().optional(),
  })
  .passthrough();
export type SubagentCompletionStats = z.infer<typeof SubagentCompletionStatsSchema>;

/**
 * 完成信封：runtime `notifyCompleted`、host enrich deliverables、terminal-core
 * queue payload（再加 parent_thread_id）共用。
 *
 * `deliverables` 保持 opaque——具体 ChildDeliverable 形状归 host，不进 runtime 内核。
 */
export const SubagentCompletionEnvelopeSchema = z.object({
  subagent_run_id: z.string().min(1),
  label: z.string(),
  status: SubagentTerminalStatusSchema,
  summary: z.string(),
  duration_ms: z.number(),
  summary_file_path: z.string().optional(),
  step_count: z.number().optional(),
  error_kind: z.string().optional(),
  /** 子 Agent 内部派发孙任务时，派发者子 Agent 的 run id。顶层派发缺省。 */
  run_id: z.string().optional(),
  /** 派发该后台子任务的 agent tool_use id。 */
  tool_call_id: z.string().optional(),
  parent_tool_call_id: z.string().optional(),
  stats: SubagentCompletionStatsSchema.optional(),
  deliverables: z.array(z.unknown()).optional(),
  /** 是否为后台 detach 子；缺省视为前台（与历史 payload 兼容）。 */
  background: z.boolean().optional(),
});
export type SubagentCompletionEnvelope = z.infer<typeof SubagentCompletionEnvelopeSchema>;

/** NotificationQueue / host 侧：信封 + 父 thread。 */
export const SubagentCompletedNotificationPayloadSchema =
  SubagentCompletionEnvelopeSchema.extend({
    parent_thread_id: z.string().min(1),
  });
export type SubagentCompletedNotificationPayload = z.infer<
  typeof SubagentCompletedNotificationPayloadSchema
>;

export interface BuildSubagentCompletionEnvelopeInput {
  subagent_run_id: string;
  label: string;
  status: SubagentTerminalStatus;
  summary: string;
  duration_ms: number;
  summary_file_path?: string;
  step_count?: number;
  error_kind?: string;
  run_id?: string;
  tool_call_id?: string;
  parent_tool_call_id?: string;
  stats?: SubagentCompletionStats;
  deliverables?: unknown[];
  background?: boolean;
}

/**
 * 构造完成信封业务 payload：剥掉 undefined 可选字段，保证 JSON / XML / tool_result 同源。
 *
 * **镜像** `@tabtin/agent-runtime` 的 `buildChildCompletionEnvelope` 字段集；
 * runtime 禁依赖本包（AH-005），故两端各自持有实现，靠字段名对齐。
 *
 * 注意：terminal-core 另有 `buildSubagentCompletionEnvelope`，那是把本
 * payload 包进 NotificationQueue 外壳；本函数只产出业务字段。
 */
export function createSubagentCompletionPayload(
  input: BuildSubagentCompletionEnvelopeInput,
): SubagentCompletionEnvelope {
  const envelope: SubagentCompletionEnvelope = {
    subagent_run_id: input.subagent_run_id,
    label: input.label,
    status: input.status,
    summary: input.summary,
    duration_ms: input.duration_ms,
  };
  if (input.summary_file_path !== undefined) {
    envelope.summary_file_path = input.summary_file_path;
  }
  if (input.step_count !== undefined) {
    envelope.step_count = input.step_count;
  }
  if (input.error_kind !== undefined) {
    envelope.error_kind = input.error_kind;
  }
  if (input.run_id !== undefined) {
    envelope.run_id = input.run_id;
  }
  if (input.tool_call_id !== undefined) {
    envelope.tool_call_id = input.tool_call_id;
  }
  if (input.parent_tool_call_id !== undefined) {
    envelope.parent_tool_call_id = input.parent_tool_call_id;
  }
  if (input.stats !== undefined) {
    envelope.stats = input.stats;
  }
  if (input.deliverables !== undefined && input.deliverables.length > 0) {
    envelope.deliverables = input.deliverables;
  }
  if (input.background !== undefined) {
    envelope.background = input.background;
  }
  return envelope;
}

/** 终态 → UI lifecycle（timeout 归入 failed，细分类靠 error_kind）。 */
export function terminalStatusToLifecycle(
  status: SubagentTerminalStatus,
): Exclude<SubagentLifecycleStatus, 'pending' | 'queued' | 'running'> {
  if (status === 'timeout') return 'failed';
  return status;
}
