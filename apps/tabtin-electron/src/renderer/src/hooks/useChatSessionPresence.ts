/**
 * useChatSessionPresence — 主窗口前台会话 presence 上报
 *
 * 已登录且用户正聚焦、可见地查看 `useChatStore.currentSessionId` 时，
 * 经 Gateway 私有事件 `chat.session.presence` 上报；在场时后端不生成
 * 该 session 的 HITL 收件箱通知。
 *
 * 约束：
 * - 无本地伪造 lease；WS 未 ready 不缓存待发
 * - 失败等下一次 30s refresh 或 Gateway reconnect 补报
 * - detached IM / chat 窗口不得挂载本 hook
 */

import { useEffect } from 'react'
import {
  ChatSessionPresenceEvents,
  ChatSessionPresenceTiming,
} from '@tabtin/ws-gateway-client'
import { getChatClient } from '@/services/chatApi'
import {
  resolvePresenceSessionId,
  type PresenceViewState,
} from '@/services/chatSessionPresence'
import { useChatStore } from '@stores/chat/useChatStore'
import { createLogger } from '@/utils/logger'

export {
  resolvePresenceSessionId,
  shouldSuppressAgentOsNotification,
  shouldSuppressHitlOsNotification,
  type PresenceViewState,
} from '@/services/chatSessionPresence'

const log = createLogger('ChatSessionPresence')

const REFRESH_MS = ChatSessionPresenceTiming.RECOMMENDED_REFRESH_SECONDS * 1000
const READY_PROBE_MS = 500
const MAX_READY_PROBES = 30

type PresenceWriteJob = () => void | Promise<void>

/**
 * 主窗 presence 是单例语义：React StrictMode 的 effect replay 会出现两个短暂
 * 并存的 hook 闭包，但后一个 mount 必须排在前一个 cleanup clear 之后。
 *
 * 这里只共享写入顺序，不共享用户、session 或任何 presence 状态。
 */
let globalPresenceWriteTail: Promise<void> = Promise.resolve()

function logSafely(
  level: 'debug' | 'info' | 'warn',
  message: string,
  context?: unknown,
): void {
  try {
    log[level](message, context)
  } catch {
    // 诊断日志本身绝不能中断 presence 写队列。
  }
}

function enqueueGlobalPresenceWrite(job: PresenceWriteJob): void {
  // 每次赋值都以 terminal catch 收口：包括 request 以外的 Gateway / logger 异常。
  globalPresenceWriteTail = globalPresenceWriteTail
    .then(() => job())
    .catch(() => {
      logSafely('warn', 'presence write job failed')
    })
}

function readDocumentViewState(): Pick<PresenceViewState, 'hasFocus' | 'visibilityState'> {
  if (typeof document === 'undefined') {
    return { hasFocus: false, visibilityState: 'hidden' }
  }
  return {
    hasFocus: document.hasFocus(),
    visibilityState: document.visibilityState,
  }
}

function truncateId(value: string | null | undefined): string {
  if (!value) return '-'
  return value.length <= 8 ? value : value.slice(0, 8)
}

export interface UseChatSessionPresenceOptions {
  /** 仅主窗 + 已认证；detached 窗口必须传 false */
  enabled: boolean
}

export function useChatSessionPresence({ enabled }: UseChatSessionPresenceOptions): void {
  useEffect(() => {
    if (!enabled) return

    let disposed = false
    let leaving = false
    let desiredSessionId: string | null = null
    let desiredGeneration = 0
    let lastPublishedSessionId: string | null | undefined
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let readyProbeTimer: ReturnType<typeof setTimeout> | null = null
    let readyProbeCount = 0
    let reconnectHandler: (() => void) | null = null
    let gateway: ReturnType<ReturnType<typeof getChatClient>['getGateway']> | null = null

    const getGateway = () => {
      if (gateway) return gateway
      try {
        gateway = getChatClient().getGateway()
        return gateway
      } catch {
        return null
      }
    }

    const isGatewayReady = (): boolean => {
      const gw = getGateway()
      if (!gw) return false
      try {
        return gw.isConnected()
      } catch {
        logSafely('warn', 'presence readiness check failed')
        return false
      }
    }

    const stopHeartbeat = () => {
      if (heartbeatTimer != null) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
    }

    const stopReadyProbe = () => {
      if (readyProbeTimer != null) {
        clearTimeout(readyProbeTimer)
        readyProbeTimer = null
      }
      readyProbeCount = 0
    }

    /**
     * 所有 effect 实例共享同一条 promise 链：
     * - 同实例中尚未执行的旧意图会被 generation 跳过；
     * - 已开始的旧写入完成后，较新的 clear / session 一定随后写入。
     *
     * 因此任何可见性或会话切换的最终意图都会覆盖较旧的 Redis presence。
     */
    const enqueuePresence = (
      sessionId: string | null,
      reason: string,
      opts: { force?: boolean } = {},
    ): void => {
      desiredSessionId = sessionId
      const generation = ++desiredGeneration

      enqueueGlobalPresenceWrite(async () => {
        if (generation !== desiredGeneration) {
          logSafely('debug', 'skip stale presence intent', { reason })
          return
        }

        const gw = getGateway()
        if (!gw) {
          logSafely('warn', 'gateway unavailable', { reason })
          return
        }
        if (!isGatewayReady()) {
          logSafely('debug', 'skip presence; gateway not ready', { reason })
          if (sessionId !== null && !disposed && !leaving) scheduleReadyProbe()
          return
        }

        if (!opts.force && lastPublishedSessionId === sessionId) {
          return
        }

        try {
          const response = await gw.request(ChatSessionPresenceEvents.PRESENCE, {
            session_id: sessionId,
          })
          if (!response?.ok) {
            logSafely('warn', 'presence failed', {
              reason,
              action: sessionId ? 'set' : 'clear',
              session: truncateId(sessionId),
              error: response?.error?.code ?? response?.type ?? 'unknown',
            })
            return
          }

          lastPublishedSessionId = sessionId
          if (sessionId) {
            logSafely('info', 'presence set', { reason, session: truncateId(sessionId) })
          } else {
            logSafely('info', 'presence clear', { reason })
          }
        } catch {
          logSafely('warn', 'presence request threw', {
            reason,
            action: sessionId ? 'set' : 'clear',
            session: truncateId(sessionId),
          })
        }
      })
    }

    const syncPresence = (
      reason: string,
      opts: { force?: boolean } = {},
    ): void => {
      if (disposed || leaving) {
        logSafely('debug', 'skip presence after lifecycle end', { reason })
        return
      }

      const desired = resolvePresenceSessionId({
        currentSessionId: useChatStore.getState().currentSessionId,
        ...readDocumentViewState(),
      })

      if (desired) {
        startHeartbeat()
      } else {
        stopHeartbeat()
        stopReadyProbe()
      }
      enqueuePresence(desired, reason, opts)
    }

    const startHeartbeat = () => {
      if (heartbeatTimer != null || leaving || disposed) return
      // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- App 主窗级 presence 租约必须跨 Space 切换续期，不能被 hot Space 生命周期取消。
      heartbeatTimer = setInterval(() => {
        syncPresence('heartbeat', { force: true })
      }, REFRESH_MS)
    }

    const scheduleReadyProbe = () => {
      if (readyProbeTimer != null || desiredSessionId === null || disposed || leaving) return
      if (isGatewayReady()) return

      const probe = () => {
        readyProbeTimer = null
        if (disposed || leaving || desiredSessionId === null) return
        if (isGatewayReady()) {
          readyProbeCount = 0
          syncPresence('ready-probe', { force: true })
          return
        }
        readyProbeCount += 1
        if (readyProbeCount >= MAX_READY_PROBES) {
          logSafely('warn', 'presence readiness probe timed out', { attempts: readyProbeCount })
          return
        }
        readyProbeTimer = setTimeout(probe, READY_PROBE_MS)
      }

      readyProbeTimer = setTimeout(probe, READY_PROBE_MS)
    }

    const onFocus = () => { syncPresence('focus', { force: true }) }
    const onBlur = () => { syncPresence('blur', { force: true }) }
    const onVisibility = () => { syncPresence('visibility', { force: true }) }
    const onPageHide = () => {
      leaving = true
      stopHeartbeat()
      stopReadyProbe()
      enqueuePresence(null, 'pagehide', { force: true })
    }

    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- App 主窗级 presence 租约必须跨 Space 切换持续感知焦点，不能被 hot Space 生命周期取消。
    window.addEventListener('focus', onFocus)
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- App 主窗级 presence 租约必须跨 Space 切换持续感知失焦，不能被 hot Space 生命周期取消。
    window.addEventListener('blur', onBlur)
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- App 主窗级 presence 租约必须跨 Space 切换持续感知可见性，不能被 hot Space 生命周期取消。
    document.addEventListener('visibilitychange', onVisibility)
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- App 主窗级 presence 租约必须跨 Space 切换处理离开清理，不能被 hot Space 生命周期取消。
    window.addEventListener('pagehide', onPageHide)

    const unsubscribeSession = useChatStore.subscribe((state, prev) => {
      if (state.currentSessionId === prev.currentSessionId) return
      syncPresence('session-change', { force: true })
    })

    try {
      gateway = getGateway()
      reconnectHandler = () => {
        if (disposed || leaving) return
        logSafely('info', 'presence reconnect')
        syncPresence('reconnect', { force: true })
      }
      gateway?.onReconnectedEvent(reconnectHandler)
    } catch (err) {
      logSafely('warn', 'failed to attach reconnect listener', err)
    }

    syncPresence('mount', { force: true })

    return () => {
      disposed = true
      stopHeartbeat()
      stopReadyProbe()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      unsubscribeSession()

      if (reconnectHandler && gateway) {
        try {
          gateway.offReconnectedEvent(reconnectHandler)
        } catch {
          /* gateway may already be gone */
        }
      }

      // 不等待 React cleanup：写队列会在进行中的 set 后补发 clear。
      // 若从未 ready，则 job 直接跳过，不会伪造或缓存 presence。
      enqueuePresence(null, 'unmount', { force: true })
    }
  }, [enabled])
}
