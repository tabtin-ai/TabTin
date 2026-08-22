/**
 * lifecycle 终态 → 系统通知 / 会话已读 的门闩。
 *
 * 终态始终送到主进程；主进程以来源 BrowserWindow 的原生状态决定是否静默，
 * 并仅在确认用户确实正在查看时回告 renderer 标记会话已读。
 */

import { SystemNotification } from '@/services/systemNotification'
import { shouldSuppressAgentOsNotification } from '@/services/chatSessionPresence'
import { useSessionReadStore } from '@/stores/useSessionReadStore'
import { getChatStoreCallbacks } from '../../shared/storeAccessRegistry'

export type LifecycleTerminalNotifyPhase = 'end' | 'error' | 'terminated' | 'session_interrupted'

export interface LifecycleTerminalNotifyInput {
  phase: LifecycleTerminalNotifyPhase
  sessionId: string
  spaceId?: string
  sessionTitle?: string
  notifyPrefix: string
  messageId?: string
  /** 与 IM 投影共用的稳定消息身份 */
  messageRef?: string
  /** 本地 lifecycle 与服务端通知共享的执行关联身份。 */
  dedupRef?: string
  /** phase=error 时的正文 */
  errorBody?: string
  /** phase=terminated 时的正文 */
  interruptedBody?: string
  /** phase=session_interrupted 时的正文 */
  sessionInterruptedBody?: string
  completedTitle: string
  completedBody: string
  errorTitle: string
  interruptedTitle: string
}

function readPresenceForSession(eventSessionId: string): boolean {
  const doc = typeof document !== 'undefined' ? document : null
  return shouldSuppressAgentOsNotification({
    eventSessionId,
    currentSessionId: getChatStoreCallbacks()?.getCurrentSessionId() ?? null,
    hasFocus: doc?.hasFocus() ?? false,
    visibilityState: doc?.visibilityState ?? 'hidden',
  })
}

/** 前台正看该会话时清未读；供 session 刷新后的 last_message_at 竞态再 ack 一次。 */
export function ackLifecycleSessionViewedIfPresent(sessionId: string): boolean {
  if (!readPresenceForSession(sessionId)) return false
  useSessionReadStore.getState().markViewed(sessionId)
  return true
}

/**
 * 终态通知：当前会话携带原生焦点抑制与已读回告意图，其余会话直接通知。
 */
export function emitOrAckLifecycleTerminalNotification(
  input: LifecycleTerminalNotifyInput,
): 'notified' {
  const isCurrentSession =
    getChatStoreCallbacks()?.getCurrentSessionId() === input.sessionId
  const common = {
    sessionId: input.sessionId,
    spaceId: input.spaceId,
    messageId: input.messageId,
    messageRef: input.messageRef,
    dedupRef: input.dedupRef,
    suppressWhenSourceWindowFocused: isCurrentSession,
    markSessionViewedWhenSuppressed: true,
  }

  if (input.phase === 'end') {
    SystemNotification.agentCompleted({
      title: `${input.notifyPrefix}${input.completedTitle}`,
      body: input.completedBody,
      ...common,
    })
  } else if (input.phase === 'error') {
    SystemNotification.agentError({
      title: `${input.notifyPrefix}${input.errorTitle}`,
      body: input.errorBody || input.completedBody,
      ...common,
    })
  } else if (input.phase === 'terminated') {
    SystemNotification.agentInterrupted({
      title: `${input.notifyPrefix}${input.interruptedTitle}`,
      body: input.interruptedBody || input.completedBody,
      ...common,
    })
  } else {
    SystemNotification.agentSessionInterrupted({
      title: `${input.notifyPrefix}${input.interruptedTitle}`,
      body: input.sessionInterruptedBody || input.interruptedBody || input.completedBody,
      ...common,
    })
  }

  return 'notified'
}
