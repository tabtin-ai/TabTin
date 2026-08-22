/**
 * 子 Agent 完成信封 — runtime 内核自持类型。
 *
 * **故意不 import `@tabtin/agent-wire`**（AH-005：agent-runtime 禁任何 @tabtin/*）。
 * wire 侧 `subagent-completion.ts` 镜像同构字段，供 host / UI / zod 校验；
 * 两边字段漂移由 `tests/completion-envelope-parity.test.ts` 兜住。
 */

export type SubagentTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface SubagentCompletionStats {
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  credits_consumed?: number;
  [key: string]: unknown;
}

/**
 * 完成信封：前台 tool_result / 后台 NotificationQueue / UI 同构消费。
 * `deliverables` 保持 opaque——具体形状归 host。
 */
export interface SubagentCompletionEnvelope {
  subagent_run_id: string;
  label: string;
  status: SubagentTerminalStatus;
  summary: string;
  duration_ms: number;
  summary_file_path?: string;
  step_count?: number;
  error_kind?: string;
  /**
   * 派发该后台子任务的子 Agent run id。顶层主 Agent 派发时缺省；
   * 子 Agent 派孙任务时填当前子 Agent 的 subagentRunId。
   */
  run_id?: string;
  /** 派发该后台子任务的 agent tool_use id。 */
  tool_call_id?: string;
  parent_tool_call_id?: string;
  stats?: SubagentCompletionStats;
  deliverables?: unknown[];
  background?: boolean;
}

export interface BuildChildCompletionEnvelopeParams {
  subagentRunId: string;
  label: string;
  status: SubagentTerminalStatus;
  summary: string;
  durationMs: number;
  stepCount?: number;
  errorKind?: string;
  runId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  stats?: SubagentCompletionStats;
  deliverables?: unknown[];
  background?: boolean;
  summaryFilePath?: string;
}

/** 构造完成信封：剥掉 undefined / 空 deliverables。 */
export function buildChildCompletionEnvelope(
  params: BuildChildCompletionEnvelopeParams,
): SubagentCompletionEnvelope {
  const envelope: SubagentCompletionEnvelope = {
    subagent_run_id: params.subagentRunId,
    label: params.label,
    status: params.status,
    summary: params.summary,
    duration_ms: params.durationMs,
  };
  if (params.summaryFilePath !== undefined) {
    envelope.summary_file_path = params.summaryFilePath;
  }
  if (params.stepCount !== undefined) {
    envelope.step_count = params.stepCount;
  }
  if (params.errorKind !== undefined) {
    envelope.error_kind = params.errorKind;
  }
  if (params.runId !== undefined) {
    envelope.run_id = params.runId;
  }
  if (params.toolCallId !== undefined) {
    envelope.tool_call_id = params.toolCallId;
  }
  if (params.parentToolCallId !== undefined) {
    envelope.parent_tool_call_id = params.parentToolCallId;
  }
  if (params.stats !== undefined) {
    envelope.stats = params.stats;
  }
  if (params.deliverables !== undefined && params.deliverables.length > 0) {
    envelope.deliverables = params.deliverables;
  }
  if (params.background !== undefined) {
    envelope.background = params.background;
  }
  return envelope;
}
