/**
 * useConnectionRecovery — 全局连接恢复 Hook
 *
 * 职责：
 * 1. 监听 Agent Gateway 连接状态，重连成功后自动恢复所有 REST Store 数据
 * 2. 监听 navigator online 事件，主动唤醒 Gateway 重连
 * 3. 监听 document visibilitychange，页面重新可见时检查连接状态
 * 4. visibility/online 触发时若当前 session 处于 stale 态，主动调用
 *    ensureSessionFresh 收敛 —— 覆盖"Agent Gateway 一直 ready 但中途某次 sync
 *    失败导致 stale"的窄场景，与 setReconnectHandler 的批量同步互补。
 * 5. Agent Gateway 持续非 ready 超过 SUSPEND_DEBOUNCE_MS 后，
 *    把仍在 streaming 的 session 标记为 suspended——给 UI（reconnect
 *    toast / tab dot / status icon）准确反馈"Agent 可能仍在后台执行"，
 *    重连后由 setReconnectHandler / useSessionReconcile / sessionCleanup
 *    根据 server 真实状态自然清除。
 *
 * 挂载位置：AppLayout（全局唯一）
 */

import { useEffect, useRef } from 'react'
import { useAgentGatewayStore, type AgentGatewayStatus } from '@/stores/useAgentGatewayStore'
import { useWsConnectionStore } from '@/stores/useWsConnectionStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useDeviceStore, ensureDeviceRegistered } from '@/stores/useDeviceStore'
import { useChannelStore } from '@/stores/useChannelStore'
import { useNotificationStore } from '@/stores/useNotificationStore'
import { useTrackerStore } from '@/stores/useTrackerStore'
import { getChatClient } from '@/services/chatApi'
import { isGatewayMembershipReadyForOrganization } from '@/services/gatewayOrganizationMembership'
import { reconnectCentrifugo } from '@/hooks/useCentrifugoClient'
import { useIMStore } from '@/stores/useIMStore'
import { markSessionsSuspended } from '@/services/sessionSuspended'
import { createLogger } from '@/utils/logger'
import { getNativeFilePickerQuietDelayMs } from '@/utils/nativeFilePickerGuard'

const log = createLogger('ConnectionRecovery')

const RECOVERY_RETRY_DELAYS = [2_000, 5_000, 10_000]
const GATEWAY_MEMBERSHIP_RECONNECT_DELAYS = [300, 1_000]

/**
 * 断连超过此时长才把 streaming session 标记为 suspended。
 *
 * 设计取舍：
 * - 太短（<1s）→ 抖动断连会闪烁 suspended 图标，干扰用户
 * - 太长（>10s）→ 用户已经感知断网很久了，suspended 反馈来得太晚
 *
 * 3 秒是经验值：覆盖 99% 抖动断连不显示，又能在用户开始 panic 前给出
 * "Agent 仍在后台执行"的视觉确认。
 */
const SUSPEND_DEBOUNCE_MS = 3_000
let reconnectAfterAgentRecoveryUnsub: (() => void) | null = null

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type RecoveryTask = {
  name: string
  fn: (organizationId: string) => Promise<void>
}

const RECOVERY_TASKS: RecoveryTask[] = [
  {
    name: 'organizations',
    fn: () => useOrganizationStore.getState().loadOrganizations(),
  },
  {
    name: 'spaces',
    fn: (wid) => useSpaceStore.getState().loadSpaces(wid),
  },
  {
    name: 'devices',
    fn: async (wid) => {
      // /#363：Agent Gateway 恢复后若设备尚未注册（启动竞争 / 瞬时失败），先补注册
      // （内部去重，成功后自动启动心跳），再刷新设备列表。
      const deviceStore = useDeviceStore.getState()
      if (!deviceStore.registered) {
        await deviceStore.registerCurrentDevice(wid)
      }
      await useDeviceStore.getState().loadDevices(wid)
    },
  },
  {
    name: 'channels',
    fn: (wid) => useChannelStore.getState().fetchAccounts(wid),
  },
  {
    name: 'notifications',
    fn: () => useNotificationStore.getState().loadUnreadCount(),
  },
  {
    name: 'trackers',
    fn: async (wid) => {
      // Tracker 列表跟着当前激活 Space 走；无激活 Space 则 skip。
      const activeSpaceId = useSpaceStore.getState().selectedSpace?.id
      if (!activeSpaceId) return
      await useTrackerStore.getState().loadTasks(wid, activeSpaceId, undefined, { force: true })
    },
  },
  {
    name: 'active-chat-session',
    fn: async () => {
      const { useChatStore } = await import('@/stores/chat/useChatStore')
      const sessionId = useChatStore.getState().currentSessionId
      if (sessionId) {
        await useChatStore.getState().syncSessionMessagesFromServer(sessionId)
      }
    },
  },
  {
    // ：丢 activity 后靠 REST SWR 自愈已加载 Space 的会话列表。
    name: 'chat-session-lists',
    fn: async (organizationId) => {
      const { reconcileLoadedChatSessionLists } = await import(
        '@/stores/chat/session/reconcileLoadedChatSessionLists'
      )
      await reconcileLoadedChatSessionLists(organizationId)
    },
  },
]

async function executeRecovery(organizationId: string): Promise<boolean> {
  const results = await Promise.allSettled(
    RECOVERY_TASKS.map((task) =>
      task.fn(organizationId).catch((err) => {
        log.warn(`${task.name} failed:`, err)
        throw err
      }),
    ),
  )

  const failed = RECOVERY_TASKS.filter((_, i) => results[i].status === 'rejected')
  if (failed.length === 0) {
    log.info('all stores recovered successfully')
    return true
  }

  log.warn(
    `${failed.length}/${RECOVERY_TASKS.length} stores failed:`,
    failed.map((t) => t.name),
  )

  for (let retry = 0; retry < RECOVERY_RETRY_DELAYS.length; retry++) {
    await new Promise((r) => setTimeout(r, RECOVERY_RETRY_DELAYS[retry]))

    const agentGatewayStatus = useAgentGatewayStore.getState().status
    if (agentGatewayStatus !== 'ready') {
      log.warn('Agent Gateway disconnected during retry, aborting')
      return false
    }

    const retryResults = await Promise.allSettled(
      failed.map((task) => task.fn(organizationId)),
    )

    const stillFailed = failed.filter((_, i) => retryResults[i].status === 'rejected')
    if (stillFailed.length === 0) {
      log.info(`all stores recovered after retry ${retry + 1}`)
      return true
    }

    failed.length = 0
    failed.push(...stillFailed)
  }

  log.error(
    'some stores failed to recover after all retries:',
    failed.map((t) => t.name),
  )
  return false
}

async function isAgentGatewayRecovering(): Promise<boolean> {
  try {
    const status = await (window as any).tabtin?.agentGateway?.getStatus?.()
    return status === 'recovering'
  } catch {
    return false
  }
}

function scheduleReconnectAfterAgentGatewayRecovery(): void {
  if (reconnectAfterAgentRecoveryUnsub) return

  const agentGateway = (window as any).tabtin?.agentGateway
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    reconnectAfterAgentRecoveryUnsub?.()
    reconnectAfterAgentRecoveryUnsub = null
    tryReconnectGateway()
  }

  const unsub = agentGateway?.onStatusChange?.((status: string) => {
    if (status !== 'recovering') finish()
  })
  reconnectAfterAgentRecoveryUnsub = typeof unsub === 'function' ? unsub : null

  void agentGateway?.getStatus?.()
    .then((status: string) => {
      if (status !== 'recovering') finish()
    })
    .catch(() => {
      finish()
    })
}

async function tryReconnectGatewayWhenAvailable(): Promise<void> {
  try {
    if (await isAgentGatewayRecovering()) {
      log.info('agent gateway is recovering after resume, skipping renderer reconnect')
      scheduleReconnectAfterAgentGatewayRecovery()
      return
    }
    const gw = getChatClient().getGateway()
    if (gw.getConnectionStatus() !== 'ready') {
      await gw.connect()
    }
  } catch {
    // ChatClient may not be initialized yet
  }
}

export function tryReconnectGateway(): void {
  void tryReconnectGatewayWhenAvailable()
}

/**
 * 切到 Agent Gateway membership 快照里还没有的 organization 时，软重连刷新服务端上下文。
 *
 * REST 组织列表可能已包含新组织，但周期 membership sync（~60s）尚未把它写入
 * `organization_ctx.all_ids`；此时立刻 subscribe 会 WS_1005。重新握手走 auth 全量
 * 拉 membership，避免等下一轮同步（ 诊断包 11:41:59 → 11:42:49 空窗）。
 */
export async function reconnectGatewayIfOrganizationNotSynced(
  organizationId: string | null | undefined,
): Promise<void> {
  if (!organizationId) return
  let shouldClearRecoveryInFlight = false
  try {
    const client = getChatClient()
    const knownIds = client.getOrganizationIds()
    if (isGatewayMembershipReadyForOrganization(organizationId)) {
      return
    }
    log.info('gateway membership missing target organization, forcing reconnect', {
      organizationId,
      knownIds,
    })
    const wsState = useWsConnectionStore.getState()
    const wasRecoveryInFlight = wsState.organizationAccessRecoveryInFlight
    if (!wasRecoveryInFlight) {
      wsState.setOrganizationAccessRecoveryInFlight(true)
      shouldClearRecoveryInFlight = true
    }
    const gw = client.getGateway()
    for (let attempt = 0; attempt <= GATEWAY_MEMBERSHIP_RECONNECT_DELAYS.length; attempt += 1) {
      const forceReconnect = (gw as { forceReconnect?: () => Promise<boolean> }).forceReconnect
      if (!forceReconnect) gw.close()
      const connected = forceReconnect ? await forceReconnect() : await gw.connect()
      if (connected !== false && isGatewayMembershipReadyForOrganization(organizationId)) {
        return
      }
      if (attempt < GATEWAY_MEMBERSHIP_RECONNECT_DELAYS.length) {
        await wait(GATEWAY_MEMBERSHIP_RECONNECT_DELAYS[attempt])
      }
    }
    log.warn('gateway membership still missing after reconnect attempts', {
      organizationId,
    })
  } catch {
    // ChatClient 可能尚未初始化
  } finally {
    if (shouldClearRecoveryInFlight) {
      useWsConnectionStore.getState().setOrganizationAccessRecoveryInFlight(false)
    }
  }
}

/**
 * 当前 session 若处于 stale，则触发一次后台收敛同步。
 * 用 dynamic import 避免与 useChatStore / sessionFreshness service 形成
 * 循环依赖。失败 silent，不打扰用户。
 */
async function ensureCurrentSessionFreshness(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return

  const [{ useChatStore }, { useSessionFreshnessStore }, { reconcileSessionMessages }] =
    await Promise.all([
      import('@/stores/chat/useChatStore'),
      import('@/stores/useSessionFreshnessStore'),
      import('@/services/sessionFreshness'),
    ])

  const sessionId = useChatStore.getState().currentSessionId
  if (!sessionId) return
  if (!useSessionFreshnessStore.getState().isStale(sessionId)) return

  await reconcileSessionMessages(sessionId, {
    force: false,
    retry: true,
    silentOnError: true,
    reason: 'stale-session-recovery',
  })
}

export function useConnectionRecovery(): void {
  const prevStatusRef = useRef<AgentGatewayStatus>('idle')
  const recoveryInFlightRef = useRef(false)
  const lastSuccessfulRecoveryRef = useRef(0)

  // Agent Gateway 状态变更 → 触发恢复
  useEffect(() => {
    const unsub = useAgentGatewayStore.subscribe((state) => {
      const prev = prevStatusRef.current
      const next = state.status
      prevStatusRef.current = next

      if (next !== 'ready') return
      if (prev === 'ready' || prev === 'idle') return

      const organizationId = useOrganizationStore.getState().selectedOrganization?.id
      if (!organizationId) return
      if (recoveryInFlightRef.current) return

      if (Date.now() - lastSuccessfulRecoveryRef.current < 60_000) {
        log.debug('skipping recovery (cooldown after successful recovery)')
        return
      }

      log.info(`Agent Gateway recovered (${prev} → ready), starting recovery`)
      recoveryInFlightRef.current = true
      executeRecovery(organizationId).then((allSucceeded) => {
        if (allSucceeded) {
          lastSuccessfulRecoveryRef.current = Date.now()
        }
      }).finally(() => {
        recoveryInFlightRef.current = false

        const imStatus = useIMStore.getState().connectionStatus
        if (imStatus !== 'connected') {
          log.info('triggering Centrifugo reconnect after Agent Gateway recovery')
          reconnectCentrifugo()
        }
      })
    })

    return unsub
  }, [])

  // navigator online/offline → 更新全局网络状态 + 唤醒 Gateway
  useEffect(() => {
    let onlineDebounceTimer: ReturnType<typeof setTimeout> | null = null

    const handleOnline = () => {
      log.info('network online detected')
      useWsConnectionStore.getState().setNetworkOnline(true)
      if (onlineDebounceTimer) clearTimeout(onlineDebounceTimer)
      onlineDebounceTimer = setTimeout(() => {
        onlineDebounceTimer = null
        if (navigator.onLine) {
          log.info('network stable, attempting gateway reconnect')
          tryReconnectGateway()
          // /#363：网络恢复后若设备尚未注册，触发去重注册（成功后自动启动心跳）
          ensureDeviceRegistered()
          void ensureCurrentSessionFreshness()
        }
      }, 3_000)
    }
    const handleOffline = () => {
      log.info('network offline detected')
      useWsConnectionStore.getState().setNetworkOnline(false)
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      if (onlineDebounceTimer) {
        clearTimeout(onlineDebounceTimer)
        onlineDebounceTimer = null
      }
    }
  }, [])

  // visibilitychange → 页面重新可见时检查连接
  useEffect(() => {
    let deferredVisibilityTimer: ReturnType<typeof setTimeout> | null = null

    const runVisibleRecovery = () => {
      const status = useAgentGatewayStore.getState().status
      if (status !== 'ready') {
        log.info('page visible + Agent Gateway not ready, attempting reconnect')
        tryReconnectGateway()
      } else {
        const imStatus = useIMStore.getState().connectionStatus
        if (imStatus !== 'connected') {
          log.info('page visible + Agent Gateway ready but Centrifugo disconnected, triggering reconnect')
          reconnectCentrifugo()
        }
        void ensureCurrentSessionFreshness()
      }
    }

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      const pickerQuietDelay = getNativeFilePickerQuietDelayMs()
      if (pickerQuietDelay > 0) {
        log.debug('page visible during native file picker return, defer connection freshness check')
        if (deferredVisibilityTimer) clearTimeout(deferredVisibilityTimer)
        deferredVisibilityTimer = setTimeout(() => {
          deferredVisibilityTimer = null
          handleVisibility()
        }, pickerQuietDelay)
        return
      }
      runVisibleRecovery()
    }

    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      if (deferredVisibilityTimer) {
        clearTimeout(deferredVisibilityTimer)
        deferredVisibilityTimer = null
      }
    }
  }, [])

  // Agent Gateway 持续非 ready 超过 SUSPEND_DEBOUNCE_MS → 把仍在
  // streaming 的 session 标记为 suspended。这是「断连期间 Agent 后台执行」
  // 语义在客户端的唯一写入路径。
  //
  // 状态机（无状态写法 —— 只看当前 Agent Gateway status，不依赖 prev）：
  //   - status ∈ {ready, idle} → 取消 timer（连接恢复 / 初始态）
  //   - 其他状态 → 启动 timer（如已启动则不重启）
  //   - timer 触发后：再次 check 当前 status 仍非 ready/idle → 写 suspended
  //
  // 不需要在这里做"清除 suspended"——清除路径已经覆盖：
  //   - reconnect handler 完成 sync 后（见 useChatStore.ts setReconnectHandler）
  //   - useSessionReconcile 心跳兜底（server 报 idle 时清）
  //   - cleanupSessionOnTerminal（流终态时必清）
  //   - sendMessageAction（用户继续发消息时清）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const cancelTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    const onSuspendTimerFire = async () => {
      timer = null

      // race 自检：3 秒后状态可能已经变好，避免误标
      const stillDown = useAgentGatewayStore.getState().status
      if (stillDown === 'ready' || stillDown === 'idle') return

      const { getGatewayDisconnectSuspendSessionIds } = await import('@/stores/chat/execution/sessionRunProjection')
      const streamingIds = getGatewayDisconnectSuspendSessionIds()
      if (streamingIds.length === 0) return

      markSessionsSuspended(streamingIds, true)
      log.warn(
        `Agent Gateway down for ${SUSPEND_DEBOUNCE_MS}ms, marked ${streamingIds.length} streaming session(s) as suspended`,
      )
    }

    const reactToStatus = (status: AgentGatewayStatus) => {
      if (status === 'ready' || status === 'idle') {
        cancelTimer()
        return
      }
      if (timer) return
      timer = setTimeout(() => { void onSuspendTimerFire() }, SUSPEND_DEBOUNCE_MS)
    }

    // mount 时立即检查一次当前状态（subscribe 不会立刻 fire）
    let lastStatus = useAgentGatewayStore.getState().status
    reactToStatus(lastStatus)

    const unsub = useAgentGatewayStore.subscribe((state) => {
      if (state.status === lastStatus) return
      lastStatus = state.status
      reactToStatus(state.status)
    })

    return () => {
      unsub()
      cancelTimer()
    }
  }, [])
}
