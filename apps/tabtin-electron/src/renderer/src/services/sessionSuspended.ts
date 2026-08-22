/**
 * Session Suspended Marker — 「断连期间 Agent 仍在后台执行」状态写入入口
 *
 * ## 为什么需要这个 utility
 *
 * 「session 已挂起」的状态在两个 store 里都需要写：
 *
 * - `useWsConnectionStore.suspendedSessionIds`（list）：给 ChatSessionSwitcher
 *   tab dot / SessionStatusIcon / chat-session-status / reconnect toast 用——
 *   这些消费方需要"全局聚合 list"形态。
 * - `useChatRuntimeStore.runStateBySessionId[*].suspended`（per-session bool）：
 *   给 MessageBubble 显示流超时 hint 用——这里需要 per-session 状态。
 *
 * 两个 store 都已经在仓库里被消费，要保持一致；之前 8 处清除路径都是手写
 * 双调用（`removeSuspendedSession` + `updateRunStateForSession({ suspended:
 * false })`），漏写一处就会留下"列表空了 / per-session 还挂着"或反过来的
 * 不一致。本 utility 把双写收成单一入口，强制一致。
 *
 * ## 写入时机
 *
 * - **写 suspended=true**：`useConnectionRecovery` 里监听 WS 进入
 *   disconnected/reconnecting 持续 3s 后，把所有仍在 streaming 的 session
 *   标 suspended（debounce 避免毫秒级抖动闪烁）。
 * - **清 suspended=false**：
 *   - reconnect handler 完成 sync 后，对 server 报 idle 的 session 显式清
 *   - `useSessionReconcile` 心跳兜底：发现 server 已 idle 时清
 *   - `cleanupSessionOnTerminal`：任何终态 (done/error/cancelled) 必清
 *   - `sendMessageAction`：用户继续发消息时清（自然结束挂起态）
 *
 * ## 不该走本 utility 的场景：LRU eviction
 *
 * LRU eviction（`useChatStore.setSessionMessages` / `setSpaceSessions` /
 * `purgeOrganizationSpaces`）已经通过 `useChatRuntimeStore.evictSession[Batch]`
 * **整个删掉** session 的 runState（连带 suspended 字段）。如果之后再调
 * `markSessionSuspended(sid, false)`，`updateRunStateForSession` 会从
 * `INITIAL_RUN_STATE` 复活一个空 runState 条目——不仅没清掉 suspended，
 * 反而泄漏了一个本应不存在的 runState 引用。
 *
 * 所以 LRU eviction 路径仅调 `removeSuspendedSession(sid)` 直接清 ws-store
 * 列表，不走本 utility。语义上也合理：那条路径的命题是「session 已经不
 * 在内存里了」，不是「session 还在但挂起结束了」。
 */

import { useWsConnectionStore } from '@/stores/useWsConnectionStore'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'

/**
 * 标记 / 取消单个 session 的 suspended 态，双写两个 store。
 *
 * @param sessionId 目标 session id
 * @param suspended true = 标记挂起 / false = 清除挂起
 */
export function markSessionSuspended(sessionId: string, suspended: boolean): void {
  if (!sessionId) return

  const wsStore = useWsConnectionStore.getState()
  if (suspended) {
    wsStore.addSuspendedSession(sessionId)
  } else {
    wsStore.removeSuspendedSession(sessionId)
  }

  useChatRuntimeStore.getState().updateRunStateForSession(sessionId, { suspended })
}

/**
 * 批量版本，避免循环里反复 getState。reconnect handler 等批量场景使用。
 */
export function markSessionsSuspended(sessionIds: readonly string[], suspended: boolean): void {
  if (sessionIds.length === 0) return

  const wsStore = useWsConnectionStore.getState()
  const runtimeStore = useChatRuntimeStore.getState()

  for (const sid of sessionIds) {
    if (!sid) continue
    if (suspended) {
      wsStore.addSuspendedSession(sid)
    } else {
      wsStore.removeSuspendedSession(sid)
    }
    runtimeStore.updateRunStateForSession(sid, { suspended })
  }
}
