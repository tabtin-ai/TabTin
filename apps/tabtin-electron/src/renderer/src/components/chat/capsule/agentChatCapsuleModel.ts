/**
 * agentChatCapsuleModel —— app-focus 聊天胶囊的纯状态投影。
 *
 * 胶囊只回答「Agent 现在处于哪个阶段」，不复述消息正文。消息仅用于计算
 * 「完成后有几条新回复」，运行阶段继续读取既有 RunState / HITL 单一真相。
 *
 * 状态 key 与优先级的 SSOT 在 `@tabtin/contracts`（resolveTaskCapsuleStatus）；
 * 本文件保留 Electron 侧别名与未读计数投影。
 */

import {
  resolveTaskCapsuleStatus,
  type TaskCapsuleStatusInput,
  type TaskCapsuleStatusKind,
} from '@tabtin/contracts/agent'

export interface CapsuleMessageLike {
  id: string
  role: string
  created_at?: string | number | null
}

export interface CapsuleActivity {
  /** seenUntilTs 之后新增的 assistant 消息数 */
  unreadCount: number
}

/** @see TaskCapsuleStatusKind —— 含跨端正典 `paused` */
export type CapsuleStatusKind = TaskCapsuleStatusKind

/** @see TaskCapsuleStatusInput */
export type CapsuleStatusInput = TaskCapsuleStatusInput

function messageTimestamp(message: CapsuleMessageLike): number {
  const raw = message.created_at
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

export function resolveCapsuleActivity(
  messages: readonly CapsuleMessageLike[],
  seenUntilTs: number,
): CapsuleActivity {
  let unreadCount = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (messageTimestamp(message) > seenUntilTs) unreadCount += 1
  }
  return { unreadCount }
}

/**
 * 状态优先级遵循用户此刻最需要知道的事：
 * 人工介入 → 暂停/连接恢复 → 忙碌 → 终态 → 待命。
 */
export function resolveCapsuleStatus(input: CapsuleStatusInput): CapsuleStatusKind {
  return resolveTaskCapsuleStatus(input)
}

/**
 * 把 SessionRun 有效 status（local overlay / authoritative）映射为胶囊 `paused` 输入。
 * 来源字段：`SessionRunProjection.localStatus` 或
 * `authoritativeRunState.status`（`ChatSessionRunStatus === 'paused'`）。
 */
export function resolveCapsulePausedFromRunStatus(
  effectiveRunStatus: string | null | undefined,
): boolean {
  return effectiveRunStatus === 'paused'
}
