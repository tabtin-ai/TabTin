/**
 * SystemNotification — 统一系统通知发送入口（渲染进程）
 *
 * 封装 tabtin.notification.show()，提供类型安全的通知发送方法。
 *
 * Wave 4（PRD §4.7）：personal:{userId} 频道现已 24/7 跨 Organization 推送。
 * 未传 organizationId 时**不再**自动 fallback 到当前前台 organization（这种兜底在
 * Wave 4 之前因为 Centrifugo 切换 organization 重连而被掩盖；Wave 4 后会让
 * 跨 organization 通知点击跳到错误的团队）。改为：
 * - `payload.organizationId` 缺失：保留为 undefined（仅作为通知 metadata）
 * - `navigateTo.organizationId` 缺失：保留为 undefined → 主进程通知点击 handler
 *   按 `navigateTo.id`（如 conversation/session id）反查正确 organization
 */

import type {
  NavigateTarget,
  ToastFallbackPolicy,
} from '../../../main/services/notification/types'
import { useSpaceStore } from '@stores/useSpaceStore'

type Priority = 'urgent' | 'high' | 'normal' | 'low'

export interface SystemNotificationPayload {
  type: string
  title: string
  body: string
  priority?: Priority
  organizationId?: string
  spaceId?: string
  sessionId?: string
  metadata?: Record<string, any>
  navigateTo?: NavigateTarget
  silent?: boolean
  desktopDelivery?: 'never' | 'unfocused' | 'always'
  mirrorToCenter?: boolean
  toastFallback?: ToastFallbackPolicy
}

function resolveSpaceId(): string | undefined {
  try {
    return useSpaceStore.getState()?.selectedSpace?.id ?? undefined
  } catch {
    return undefined
  }
}

function send(payload: SystemNotificationPayload): void {
  if (typeof window === 'undefined' || !window.tabtin?.notification) return
  // Wave 4：不再 fallback `payload.organizationId` 到当前前台 organization。
  // personal 频道事件可属任意 organization，错位 fallback 会让跨 organization 通知
  // 跳转到错误团队。caller 必须显式传入或保留 undefined。
  // 注意：「顶层 organizationId 自动传到 navigateTo」是合理 fallback（caller
  // 显式知道 organizationId 时希望它出现在 navigateTo 里），保留。
  const spaceId = payload.spaceId
  if (payload.navigateTo) {
    const targetSpaceId = payload.navigateTo.spaceId ?? spaceId
    const navigateOrganizationId = payload.navigateTo.organizationId ?? payload.organizationId
    payload.navigateTo = {
      ...payload.navigateTo,
      ...(navigateOrganizationId ? { organizationId: navigateOrganizationId } : {}),
      ...(targetSpaceId ? { spaceId: targetSpaceId } : {}),
    }
  }
  window.tabtin.notification.show(payload)
}

interface AgentNotificationOpts {
  title: string
  body: string
  organizationId?: string
  spaceId?: string
  sessionId?: string
  /** 可选：点击后定位到触发通知的消息 */
  messageId?: string
  /** 可选：与 IM 投影共用的稳定消息身份 */
  messageRef?: string
  /** 同一次执行在本地 lifecycle 与服务端持久通知之间共享的去重身份。 */
  dedupRef?: string
  /** 当前会话通知交给主进程按原生来源窗口焦点做最终抑制。 */
  suppressWhenSourceWindowFocused?: boolean
  /** 原生焦点确认抑制后，把该会话标记为已读。 */
  markSessionViewedWhenSuppressed?: boolean
}

function sendAgentNotification(type: string, priority: Priority, opts: AgentNotificationOpts): void {
  // Wave 5（P1 修）：跨 Organization 通知的 spaceId 必须以 caller 显式传入为准，
  // 不能 fallback 到 resolveSpaceId()（当前选中 space）。
  // 原因：跨 Organization Agent 任务通知点击应跳到目标 organization 的对应 space，
  // 若 fallback 到当前选中 space 会让点击通知导航到错误的上下文（用户在
  // Organization B 时收到 Organization A 的通知，spaceId 会被错误兜底为 B 的当前 space）。
  // 仅在没有 caller 提供 organizationId（同 organization 内本地通知）时保留 fallback。
  const { messageRef, dedupRef, ...notificationOpts } = opts
  const spaceId = opts.spaceId ?? (opts.organizationId ? undefined : resolveSpaceId())
  send({
    type,
    priority,
    ...notificationOpts,
    spaceId,
    metadata: messageRef || dedupRef
      ? {
          ...(messageRef ? { message_ref: messageRef } : {}),
          ...(dedupRef ? { dedup_ref: dedupRef } : {}),
        }
      : undefined,
    navigateTo: opts.sessionId
      ? {
          type: 'chat-session',
          id: opts.sessionId,
          spaceId,
          ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
          ...(opts.messageId ? { messageId: opts.messageId } : {}),
        }
      : undefined,
  })
}

export const SystemNotification = {
  agentCompleted(opts: AgentNotificationOpts) {
    sendAgentNotification('agent.task.completed', 'normal', opts)
  },

  agentError(opts: AgentNotificationOpts) {
    sendAgentNotification('agent.task.error', 'high', opts)
  },

  agentInterrupted(opts: AgentNotificationOpts) {
    sendAgentNotification('agent.task.interrupted', 'low', opts)
  },

  agentSessionInterrupted(opts: AgentNotificationOpts) {
    sendAgentNotification('agent.task.session_interrupted', 'low', opts)
  },

  agentHitlWaiting(opts: AgentNotificationOpts) {
    sendAgentNotification('agent.hitl.waiting', 'urgent', opts)
  },

  trackerCompleted(opts: {
    title: string
    body: string
    organizationId?: string
    spaceId?: string
    trackerId?: string
    /** Wave 6 (charter §4.4):产物 app 推断用,缺省时降级到 Run 详情。 */
    skillKey?: string
  }) {
    const spaceId = opts.spaceId
    // Wave 6 (charter v1.8 §4.4 产物呈现分层):成功 → 默认跳产物 app。
    // 通过 resolveArtifactAppFromSkill 推断;映射不命中 → 降级 type='tracker'。
    let artifactApp: string | undefined
    if (opts.skillKey) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolveArtifactAppFromSkill } = require('./trackerArtifactMap') as {
          resolveArtifactAppFromSkill: (k?: string | null) => string | undefined
        }
        artifactApp = resolveArtifactAppFromSkill(opts.skillKey)
      } catch {
        artifactApp = undefined
      }
    }
    const navigateTo = opts.trackerId
      ? artifactApp
        ? {
            type: 'agentspace-app' as const,
            id: artifactApp,
            spaceId,
            ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
          }
        : {
            type: 'tracker' as const,
            id: opts.trackerId,
            spaceId,
            ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
          }
      : undefined
    send({
      type: 'tracker.run.completed',
      priority: 'normal',
      title: opts.title,
      body: opts.body,
      organizationId: opts.organizationId,
      spaceId,
      navigateTo,
      // Wave 6:metadata 留 skill_key + tracker_id,让 NotificationBell
      // 双按钮场景从 metadata 也能取到。
      metadata: {
        ...(opts.trackerId ? { tracker_id: opts.trackerId } : {}),
        ...(opts.skillKey ? { skill_key: opts.skillKey } : {}),
        tracker_event_status: 'completed',
      },
    })
  },

  trackerFailed(opts: {
    title: string
    body: string
    organizationId?: string
    spaceId?: string
    trackerId?: string
    /** Wave 6 charter §4.4 续作：失败也透传 skill_key，让 metadata 走到 NotificationBell */
    skillKey?: string
  }) {
    const spaceId = opts.spaceId
    send({
      type: 'tracker.run.failed',
      priority: 'high',
      title: opts.title,
      body: opts.body,
      organizationId: opts.organizationId,
      spaceId,
      navigateTo: opts.trackerId
        ? {
            type: 'tracker',
            id: opts.trackerId,
            spaceId,
            ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
          }
        : undefined,
      metadata: {
        ...(opts.trackerId ? { tracker_id: opts.trackerId } : {}),
        ...(opts.skillKey ? { skill_key: opts.skillKey } : {}),
        tracker_event_status: 'failed',
      },
    })
  },

  imMention(opts: { title: string; body: string; conversationId: string; organizationId?: string }) {
    send({
      type: 'im.mention',
      priority: 'high',
      ...opts,
      navigateTo: { type: 'im-conversation', id: opts.conversationId, organizationId: opts.organizationId },
    })
  },

  imAgentTaskUpdate(opts: { title: string; body: string; conversationId: string; organizationId?: string; sessionId?: string; messageRef?: string }) {
    send({
      type: 'im.agent_task_update',
      priority: 'high',
      title: opts.title,
      body: opts.body,
      organizationId: opts.organizationId,
      sessionId: opts.sessionId,
      metadata: opts.messageRef ? { message_ref: opts.messageRef } : undefined,
      navigateTo: opts.sessionId
        ? { type: 'chat-session', id: opts.sessionId, organizationId: opts.organizationId }
        : { type: 'im-conversation', id: opts.conversationId, organizationId: opts.organizationId },
    })
  },

  imMessage(opts: { title: string; body: string; conversationId: string; organizationId?: string; messageRef?: string }) {
    const { messageRef, ...notificationOpts } = opts
    send({
      type: 'im.message',
      priority: 'normal',
      ...notificationOpts,
      metadata: messageRef ? { message_ref: messageRef } : undefined,
      navigateTo: { type: 'im-conversation', id: opts.conversationId, organizationId: opts.organizationId },
    })
  },

  extensionEvent(opts: {
    title: string
    body: string
    organizationId?: string
    spaceId?: string
    priority?: Priority
    navigateTo?: NavigateTarget
    type?: string
    metadata?: Record<string, unknown>
    suppressWhenSourceWindowFocused?: boolean
    desktopDelivery?: 'never' | 'unfocused' | 'always'
    mirrorToCenter?: boolean
    toastFallback?: ToastFallbackPolicy
  }) {
    const spaceId = opts.spaceId
    send({
      type: opts.type || 'extension.event',
      priority: 'normal',
      ...opts,
      spaceId,
    })
  },

  billingBlocked(opts: { title: string; body: string; organizationId?: string }) {
    send({
      type: 'billing.blocked',
      priority: 'urgent',
      ...opts,
    })
  },
}
