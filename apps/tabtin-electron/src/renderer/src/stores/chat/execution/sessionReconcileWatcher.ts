/**
 * Session reconcile watcher — 心跳兜底对账（命令式，无 React）。
 *
 * 从 `useSessionReconcile` hook 下沉而来：业务逻辑（何时对账、如何对账）归属
 * store 子树，React 侧只保留 `useEffect(() => startSessionReconcileWatcher(id), [id])`
 * 这一层无法下沉的生命周期绑定。
 *
 * 职责：流式执行期间周期性检查 runState 心跳，长时间无心跳（或超总时长）时向
 * 后端拉一次 session-status：
 *   - 后端 `idle` 且前端仍 busy → `endSessionRun`（清 busy + 写 endedAt）并补拉消息；
 *   - 后端 `hitl_waiting` → **不**收口 busy/计时（人还在确认），仅 toast 提示。
 *
 * 本地 Runtime 接管时（`isLocalRuntimeAvailable()`）云端 HTTP reconcile 无意义，
 * 直接 no-op —— 判定口径与 sendMessage / review / askUser slice 完全一致。
 */

import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { isSessionBusy } from './sessionRunProjection'
import { endSessionRun } from '@/stores/chat/stream/handlers/sessionCleanup'
import { fetchSessionStatus } from '@/services/chatExtraApi'
import { markSessionStale } from '@/services/sessionFreshness'
import { isLocalRuntimeAvailable } from '@services/localAgentClient'
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'

const log = createLogger('SessionReconcile')

const HEARTBEAT_TIMEOUT_MS = 60_000
const RECONCILE_INTERVAL_MS = 180_000
const CHECK_INTERVAL_MS = 15_000
const RECONCILE_DEDUPE_MS = 30_000

async function reconcile(sid: string, signal: AbortSignal, lastReconcileAt: { value: number }): Promise<void> {
  // Wave 11：本地 Runtime 接管，云端 session-status HTTP reconcile 无意义。
  // 判定统一走 `isLocalRuntimeAvailable()` SSoT，与 sendMessage / review /
  // askUser slice 保持完全一致（避免跨模块判定漂移）。
  if (isLocalRuntimeAvailable()) return

  const now = Date.now()
  if (now - lastReconcileAt.value < RECONCILE_DEDUPE_MS) return
  lastReconcileAt.value = now

  try {
    const resp = await fetchSessionStatus(sid)

    if (signal.aborted) return

    if (!isSessionBusy(sid)) return

    // ：HITL 等待不是终态——保持 busy/计时，只提示用户去确认。
    if (resp.status === 'hitl_waiting') {
      log.info(`session ${sid}: backend=hitl_waiting while frontend streaming — keep run open`)
      toast({
        id: `reconcile-sync-${sid}`,
        title: i18n.t('chat:reconcile.hitlWaiting', { defaultValue: 'Agent 等待确认，请查看操作请求' }),
      })
      return
    }

    if (resp.status === 'idle') {
      // ：任务结束必须走 endSessionRun（写 endedAt + 清 busy），禁止只 removeStreamingSession。
      log.info(`session ${sid}: backend=idle but frontend still streaming, forcing terminal cleanup`)
      endSessionRun({
        sessionId: sid,
        status: 'cancelled',
        removeStreamingSession: useChatStore.getState().removeStreamingSession,
      })

      toast({
        id: `reconcile-sync-${sid}`,
        title: i18n.t('chat:reconcile.agentCompleted', { defaultValue: 'Agent 已完成任务，结果已同步' }),
      })

      try {
        // ：与全局唯一对账入口同一套逻辑（reason 仅观测）
        const { reconcileSessionMessages } = await import('@/services/sessionFreshness')
        if (signal.aborted) return
        await reconcileSessionMessages(sid, {
          force: true,
          retry: false,
          silentOnError: true,
          reason: 'session-status-heartbeat',
        })
        if (signal.aborted) return
      } catch (err) {
        if (signal.aborted) return
        log.warn('message sync failed:', err)
        markSessionStale(sid, err)
      }
    }
  } catch (err) {
    if (signal.aborted) return
    log.warn('status check failed:', err)
    // status check 失败本身不一定意味着消息缓存 stale，但既然已经走到
    // reconcile（streaming 长时间无心跳），把它标记为 stale 让其它路径
    // 有机会接力修复。
    markSessionStale(sid, err)
  }
}

/**
 * 启动某会话的心跳兜底对账，返回 detach 清理函数。
 *
 * 每个 watcher 生命周期内共享一个 30s 去重窗口（`lastReconcileAt`）与
 * `AbortController`；detach 时 abort 在途请求并清定时器。
 */
export function startSessionReconcileWatcher(sessionId: string): () => void {
  const controller = new AbortController()
  const lastReconcileAt = { value: 0 }

  const timer = setInterval(() => {
    if (!isSessionBusy(sessionId)) return

    const runState = useChatRuntimeStore.getState().runStateBySessionId[sessionId]
    const now = Date.now()
    const heartbeatAge = runState?.lastHeartbeatAt ? now - runState.lastHeartbeatAt : Infinity
    const startAge = runState?.startedAt ? now - runState.startedAt : 0

    if (heartbeatAge > HEARTBEAT_TIMEOUT_MS || startAge > RECONCILE_INTERVAL_MS) {
      void reconcile(sessionId, controller.signal, lastReconcileAt)
    }
  }, CHECK_INTERVAL_MS)

  return () => {
    controller.abort()
    clearInterval(timer)
  }
}
