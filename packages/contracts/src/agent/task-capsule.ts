import { z } from 'zod';

/**
 * TaskCapsule —— 跨端任务胶囊状态投影合同。
 *
 * 合同只定义：
 * 1. 投影输入（busy / runPhase / HITL / queue / unread / paused …）
 * 2. canonical status key 列表（含 `paused`）
 * 3. 纯函数投影规则与客户端视觉决策（full / mini / hidden）
 *
 * **后端不下发颜色、尺寸或视觉态**——各端按 status key + 本地视觉规则渲染。
 */

/** Canonical status keys —— Electron / iOS / Android 共用。 */
export const TASK_CAPSULE_STATUS_KEYS = [
  'ready',
  'preparing',
  'queued',
  'thinking',
  'planningNext',
  'working',
  'finishing',
  'needsApproval',
  'needsAnswer',
  'paused',
  'recovering',
  'complete',
  'stopped',
  'error',
] as const;

export const TaskCapsuleStatusKindSchema = z.enum(TASK_CAPSULE_STATUS_KEYS);

export type TaskCapsuleStatusKind = z.infer<typeof TaskCapsuleStatusKindSchema>;

export const TaskCapsuleRunPhaseSchema = z.enum([
  'planning',
  'tool_calls',
  'synthesizing',
  'done',
  'error',
  'cancelled',
]);

export type TaskCapsuleRunPhase = z.infer<typeof TaskCapsuleRunPhaseSchema>;

/**
 * 投影输入。字段语义对齐 Electron `CapsuleStatusInput`，并补 `paused`。
 */
export const TaskCapsuleStatusInputSchema = z.object({
  busy: z.boolean(),
  runPhase: TaskCapsuleRunPhaseSchema.optional(),
  /** 当前 run 已完成、且用户可感知的工具调用数 */
  completedToolCalls: z.number().int().nonnegative().optional(),
  queuedCount: z.number().int().nonnegative().optional(),
  pendingApproval: z.boolean().optional(),
  pendingAnswer: z.boolean().optional(),
  /** 用户主动暂停任务（与 stopped/cancelled、recovering 区分） */
  paused: z.boolean().optional(),
  /** 连接中断待恢复（→ recovering） */
  suspended: z.boolean().optional(),
  unreadCount: z.number().int().nonnegative().optional(),
});

export type TaskCapsuleStatusInput = z.infer<typeof TaskCapsuleStatusInputSchema>;

export const TaskCapsuleVisualKindSchema = z.enum(['full', 'mini', 'hidden']);

export type TaskCapsuleVisualKind = z.infer<typeof TaskCapsuleVisualKindSchema>;

/**
 * 状态优先级：人工介入 → 暂停/连接恢复 → 忙碌 → 终态 → 待命。
 */
function resolveBusyTaskCapsuleStatus(
  input: TaskCapsuleStatusInput,
): TaskCapsuleStatusKind {
  if (input.runPhase === 'planning') {
    return (input.completedToolCalls ?? 0) > 0 ? 'planningNext' : 'thinking';
  }
  if (input.runPhase === 'tool_calls') return 'working';
  if (input.runPhase === 'synthesizing') return 'finishing';
  if ((input.queuedCount ?? 0) > 0) return 'queued';
  return 'preparing';
}

export function resolveTaskCapsuleStatus(
  input: TaskCapsuleStatusInput,
): TaskCapsuleStatusKind {
  if (input.pendingApproval) return 'needsApproval';
  if (input.pendingAnswer) return 'needsAnswer';
  if (input.paused) return 'paused';
  if (input.suspended) return 'recovering';

  if (input.busy) return resolveBusyTaskCapsuleStatus(input);

  if (input.runPhase === 'error') return 'error';
  if (input.runPhase === 'cancelled') return 'stopped';
  if ((input.unreadCount ?? 0) > 0) return 'complete';
  return 'ready';
}

/**
 * 客户端视觉决策（非后端下发）：
 * - 仅 `ready` → mini
 * - 未读 `complete`、`paused` 及其余活跃/终态 → full
 * - `hidden` 预留给宿主层覆盖（本函数默认不产出）
 */
export function resolveTaskCapsuleVisual(
  status: TaskCapsuleStatusKind,
): TaskCapsuleVisualKind {
  if (status === 'ready') return 'mini';
  return 'full';
}
