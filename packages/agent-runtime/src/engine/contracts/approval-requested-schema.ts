/**
 * ApprovalRequested payload 本地 Zod（ Stage 5c / ）。
 *
 * 覆盖 LocalPermissionHandler emit 前的 fail-fast；字段与
 * `@tabtin/agent-wire` ApprovalRequestedPayloadSchema 对齐（含严格 DecisionReason）。
 * 生产路径不得 import agent-wire；parity 见 `__tests__/approval-schema-parity.test.ts`。
 */

import { z } from 'zod';

import { ApprovalScopeSchema, DecisionReasonSchema } from './decision-reason-schema.js';

const WIRE_RISK_LEVELS = ['low', 'medium', 'high'] as const;

const TO_WIRE_RISK: Record<string, (typeof WIRE_RISK_LEVELS)[number]> = {
  safe: 'low',
  review: 'medium',
  strict: 'high',
  high: 'high',
  critical: 'high',
  low: 'low',
  medium: 'medium',
};

function normalizeToWireRiskLevel(
  input: unknown,
  fallback: (typeof WIRE_RISK_LEVELS)[number] = 'medium',
): (typeof WIRE_RISK_LEVELS)[number] {
  if (typeof input !== 'string') return fallback;
  const key = input.trim().toLowerCase();
  if (!key) return fallback;
  return TO_WIRE_RISK[key] ?? fallback;
}

const ApprovalWireRiskLevelSchema = z.preprocess(
  (val) => normalizeToWireRiskLevel(val, 'medium'),
  z.enum(WIRE_RISK_LEVELS),
);

const ApprovalAskHintSchema = z.object({
  summary: z.string(),
  suggested_scope: ApprovalScopeSchema,
});

const ApprovalSkillContextSchema = z.object({
  skill_id: z.string(),
  source: z.enum(['manual', 'builtin', 'marketplace', 'user_shared']),
  permissions_approved: z.boolean(),
});

const ApprovalBatchContextSchema = z.object({
  batch_id: z.string(),
  current_row_index: z.number().int().nonnegative().optional(),
  total_count: z.number().int().positive().optional(),
  origin_column_id: z.string().optional(),
  memoization_hint: z
    .enum(['first_in_batch', 'memo_hit', 'memo_miss'])
    .optional(),
}).passthrough();

const ApprovalSubagentContextSchema = z.object({
  parent_tool_call_id: z.string().min(1),
  subagent_run_id: z.string().optional(),
  label: z.string().optional(),
}).passthrough();

const ApprovalActionRequestLocalSchema = z.object({
  request_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  tool_name: z.string(),
  tool_namespace: z.string().optional(),
  tool_input: z.unknown(),
  decision_reason: DecisionReasonSchema,
  user_visible_reason: z.string().optional(),
  ask_hint: ApprovalAskHintSchema.optional(),
  allowed_scopes: z.array(ApprovalScopeSchema),
  allowed_outcomes: z.array(z.enum(['allow', 'deny'])),
  risk_level: ApprovalWireRiskLevelSchema,
  skill_context: ApprovalSkillContextSchema.optional(),
  batch_context: ApprovalBatchContextSchema.optional(),
  subagent_context: ApprovalSubagentContextSchema.optional(),
}).passthrough();

export const ApprovalRequestedPayloadSchema = z.object({
  batch_id: z.string().min(1),
  approval_type: z.literal('tool_permission'),
  action_requests: z.array(ApprovalActionRequestLocalSchema).min(1),
  runtime_mode: z.enum(['interactive', 'solo', 'scheduled', 'batch']),
  expires_at: z.number(),
  schema_version: z.literal(1),
  /** ：与 hitl_interaction 落库同源的稳定 UUID（可选，旧 runtime 可不填）。 */
  message_id: z.string().optional(),
}).passthrough();

export type ApprovalRequestedPayload = z.infer<typeof ApprovalRequestedPayloadSchema>;
