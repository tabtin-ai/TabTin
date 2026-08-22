/**
 * rollbackRegistry — 回退 actions 的注册汇合点（零依赖 leaf，）。
 *
 * checkpointSlice 创建 store actions（带 per-session enqueue 串行化）后注册到
 * 这里；hub/index.ts 的 SessionController 门面经此调用——两侧都只依赖本 leaf，
 * 避免「hub/index ↔ slice」互相 import 成环（同 messageWriteGate 的 provider
 * 模式）。回退的**唯一执行路径**始终是 slice actions（enqueue 序列化），门面
 * 不绕过它。
 */

import type { ChatAttachment } from '@/components/chat/types'
import type { ResourceRestoreInfo } from '@/services/chatExtraApi'

export interface RollbackActions {
  rollbackToCheckpoint: (
    messageId: string,
    sessionId?: string,
    resourceRestorePlan?: ResourceRestoreInfo[],
  ) => Promise<void>
  restoreAndEdit: (
    messageId: string,
    newContent: string,
    attachments?: ChatAttachment[],
    contextBlocks?: Array<Record<string, unknown>>,
    sessionId?: string,
  ) => Promise<void>
  unrevertSession: (sessionId?: string | null) => Promise<void>
  rollbackAgentRun: (agentRunId: string) => Promise<void>
}

/**
 * 回退 actions 的单例注册表：checkpointSlice 注册，SessionController 门面取用。
 * 全局唯一一份状态，class 只为给这份状态一个明确宿主（与 streamControlPorts /
 * runtimeStoreAccess 风格统一）。
 */
class RollbackRegistry {
  private actions: RollbackActions | null = null

  /** 由 checkpointSlice（createCheckpointActions 末尾）注册。 */
  register(actions: RollbackActions): void {
    this.actions = actions
  }

  get(): RollbackActions | null {
    return this.actions
  }
}

export const rollbackRegistry = new RollbackRegistry()
