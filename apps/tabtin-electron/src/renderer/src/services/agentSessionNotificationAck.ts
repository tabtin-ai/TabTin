/**
 * Agent 会话终态铃铛已读 — 统一领域入口。
 *
 * 挂在 markViewed / selectSession 完成等「已查看最新消息」边界上，
 * 不依赖铃铛点击。后端权威、幂等；本地 store 保留既有视觉反馈，
 * API 成功后通知主窗刷新权威未读数，WS 推送负责多端收敛。
 */

import { NotificationApiService } from '@services/notificationApi'
import { useNotificationStore } from '@stores/useNotificationStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('AgentSessionNotifAck')

/** acknowledge API 成功后，通知主窗刷新请求发起 organization 的权威未读数。 */
export const ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT =
  'tabtin:agent-session-notif-acknowledge-completed'

const AGENT_TASK_TERMINAL_TYPES = new Set([
  'agent.task.completed',
  'agent.task.error',
  'agent.task.interrupted',
  'agent.task.session_interrupted',
])

function readSessionId(item: { metadata?: Record<string, unknown>; navigate_to?: { id?: string } }): string | undefined {
  const meta = item.metadata
  const fromMeta = meta?.session_id ?? meta?.sessionId
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim()
  const navId = item.navigate_to?.id
  if (typeof navId === 'string' && navId.trim()) return navId.trim()
  return undefined
}

function normalizeOrganizationId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** 本地乐观：仅清当前用户缓存里该 session 的终态卡，不动 HITL。 */
export function markAgentSessionTerminalReadLocal(sessionId: string): number {
  const sid = sessionId.trim()
  if (!sid) return 0

  let marked = 0
  useNotificationStore.setState((state) => {
    let unreadDelta = 0
    const notifications = state.notifications.map((n) => {
      if (n.is_read || !AGENT_TASK_TERMINAL_TYPES.has(n.type)) return n
      if (readSessionId(n) !== sid) return n
      marked += 1
      unreadDelta -= 1
      return { ...n, is_read: true, read_at: n.read_at ?? new Date().toISOString() }
    })
    if (marked === 0) return state
    return {
      notifications,
      unreadCount: Math.max(0, state.unreadCount + unreadDelta),
    }
  })
  return marked
}

/**
 * 统一 acknowledge：保留本地视觉反馈，再调用后端权威接口。
 * 成功后才派发完成事件；失败不回滚「用户确实已读」的本地视觉，
 * 后续 list / WS / 再次 acknowledge 会继续收敛。
 */
export function acknowledgeAgentSessionNotifications(sessionId: string): void {
  const sid = (sessionId || '').trim()
  if (!sid) return

  // 组织归属必须在请求发起时冻结：API 返回前用户可能已经切到其它组织。
  const organizationId = normalizeOrganizationId(
    useNotificationStore.getState().currentOrganizationId,
  )
  markAgentSessionTerminalReadLocal(sid)
  void NotificationApiService.acknowledgeAgentSession(sid)
    .then((count) => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent(ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT, {
            detail: { sessionId: sid, organizationId, count },
          }),
        )
      }
    })
    .catch((err) => {
      log.warn('acknowledgeAgentSession failed', {
        sessionId: sid,
        organizationId,
        error: err,
      })
    })
}
