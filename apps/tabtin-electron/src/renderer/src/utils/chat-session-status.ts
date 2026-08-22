import type {
  ChatSession,
  ChatSessionRunStatus,
} from '@tabtin/chat-client'

/**
 * 侧边栏会话状态只表达用户需要立即辨认的几类结果：
 * 蓝色转圈（运行）、红色感叹号（失败）、蓝色实心点（正常完成未读），以及
 * 等待用户/暂停/断连的明确反馈。正常已读与取消/中断不增加装饰性图标。
 */
export type SessionDisplayStatus =
  | 'streaming'
  | 'suspended'
  | 'pending'
  | 'paused'
  | 'failed'
  | 'neutral'
  | 'draft'
  | 'idle'

function resolveRunStatusDisplay(
  runStatus: ChatSessionRunStatus,
  isSuspended: boolean,
): SessionDisplayStatus {
  switch (runStatus) {
    case 'queued':
    case 'running':
    case 'cancelling':
      return isSuspended ? 'suspended' : 'streaming'
    case 'waiting_user':
      return 'pending'
    case 'paused':
      return 'paused'
    case 'failed':
      return 'failed'
    case 'cancelled':
    case 'interrupted':
      return 'neutral'
    case 'completed':
      return 'idle'
  }
}

/**
 * 纯展示决策。
 *
 * effectiveRunStatus 非空时代表服务端权威事实或更新的本地即时 overlay，必须优先，
 * 不再读取 assistant 消息错误启发式。只有旧后端/历史无投影时才保留原 fallback。
 */
export function resolveSessionDisplayStatus(
  session: ChatSession,
  streamingBySessionId: Record<string, boolean>,
  pendingAskUserBySessionId: Record<string, unknown>,
  pendingApprovalBySessionId: Record<string, unknown>,
  suspendedSessionIds?: string[],
  lastAssistantIsError?: boolean,
  effectiveRunStatus?: ChatSessionRunStatus | null,
): SessionDisplayStatus {
  const isSuspended = suspendedSessionIds?.includes(session.id) === true
  const hasLocalPending = !!(
    pendingAskUserBySessionId[session.id]
    || pendingApprovalBySessionId[session.id]
  )
  if (effectiveRunStatus) {
    // HITL 面板来自当前设备刚收到的实时事件，可能先于服务端 run_state 增量到达。
    // 仅覆盖活跃态；终态事实不允许被残留面板复活。
    if (
      hasLocalPending
      && ['queued', 'running', 'waiting_user', 'paused', 'cancelling']
        .includes(effectiveRunStatus)
    ) {
      return 'pending'
    }
    return resolveRunStatusDisplay(effectiveRunStatus, isSuspended)
  }

  // 旧后端兼容路径：保留本地 runtime/HITL/消息错误判断。
  if (streamingBySessionId[session.id]) return 'streaming'
  if (isSuspended) return 'suspended'
  if (hasLocalPending) return 'pending'
  if (lastAssistantIsError) return 'failed'
  if ((session.message_count ?? 0) === 0) return 'draft'
  return 'idle'
}
