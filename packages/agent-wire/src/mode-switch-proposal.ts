/**
 * Mode Switch Proposal 事件契约
 *
 * `switch_mode` 工具请求切换模式时通过 stream event 通知渲染端，由
 * ModeSwitchProposalCard 展示审批 UI。工具本身不直接改 mode。
 *
 * 通用化：工具是白名单驱动的通用「提议切模式」机制，emit 的 payload
 * 带 `from_mode_id`（来源模式）+ `target_mode_id`（目标模式），二者均可为任意 AgentMode。
 * 本 schema 是 wire-codegen 的生成源（→ fixtures + iOS/Android 生成类型），改动后需重跑
 * `pnpm -F @tabtin/wire-codegen ...`。此处内联 6 个模式字面量（不 import @tabtin/agent-modes，
 * 避免底层 wire 包反向依赖 modes），与 `AGENT_MODE_NAMES`（agent-modes SSoT）保持一致。
 */

import { z } from 'zod';

const AGENT_MODE_IDS = ['ask', 'agent', 'plan', 'study', 'yolo', 'group'] as const;

export const ModeSwitchProposalEventPayloadSchema = z
  .object({
    proposal_id: z.string(),
    target_mode_id: z.enum(AGENT_MODE_IDS),
    /** 提议来源模式；通用化前的旧 payload 无此字段，消费端缺省回退 plan。 */
    from_mode_id: z.enum(AGENT_MODE_IDS).optional(),
    reason: z.string(),
    session_id: z.string().optional(),
  })
  .passthrough();

export type ModeSwitchProposalEventPayload = z.infer<
  typeof ModeSwitchProposalEventPayloadSchema
>;
