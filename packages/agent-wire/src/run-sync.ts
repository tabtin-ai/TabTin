/**
 * ：执行态 busy 同步契约（独立于 lifecycle / tool / terminal 业务事件）。
 *
 * Host / runtime 是状态机唯一权威；本 payload 只做镜像同步。前端不得从
 * lifecycle.end / envelope.terminal / 发送乐观路径推断 busy。
 *
 * `busy` 不入 wire：镜像端一律用 `status !== 'idle'` 推导，避免与 status 冲突。
 */

import { z } from 'zod'

export const AgentRunSyncStatusSchema = z.enum([
  'idle',
  'running',
  'queued',
])

export type AgentRunSyncStatus = z.infer<typeof AgentRunSyncStatusSchema>

export const AgentRunSyncPayloadSchema = z.object({
  session_id: z.string().min(1),
  /** 当前 running 的 run；idle 时为 null；queued 时可为队首或刚入队的 id。 */
  run_id: z.string().min(1).nullable(),
  status: AgentRunSyncStatusSchema,
  /** 每 session 单调递增；镜像端丢弃 seq ≤ 已应用值的包。 */
  seq: z.number().int().nonnegative(),
  queued_run_ids: z.array(z.string().min(1)).default([]),
})

export type AgentRunSyncPayload = z.infer<typeof AgentRunSyncPayloadSchema>

/** 镜像端权威 busy：仅由 status 推导。 */
export function isAgentRunSyncBusy(status: AgentRunSyncStatus): boolean {
  return status !== 'idle'
}
