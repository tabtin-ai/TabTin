import { useShallow } from 'zustand/react/shallow'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { useWsConnectionStore } from '@/stores/useWsConnectionStore'
import { useIMStore } from '@/stores/useIMStore'
import { useAuthStore, selectIsAuthenticated } from '@/stores/useAuthStore'
import { getChatClient } from '@/services/chatApi'
import { reconnectCentrifugo } from '@/hooks/useCentrifugoClient'
import { useAgentGatewayStatus } from '@/hooks/useAgentGatewayStatus'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { recoverFromInvalidOrganizationAccess } from '@/services/membershipEventHandler'
import { createLogger } from '@/utils/logger'
import { isOrganizationPermissionMessage } from '@/services/organizationAccessErrors'
import { useTableCollabStore } from '@/stores/useTableCollabStore'
import { useTabDataRuntimeMonitorSnapshot } from '@components/table/table-runtime-monitor'
import { useTabDocRuntimeMonitorSnapshot } from '@components/context-space/tabdoc/tabdoc-runtime-monitor'
import {
  buildConnectionServiceLines,
  maxConnectionTone,
  pickCollabIndicatorMessage,
  type ConnectionServiceLine,
  type WsConnectionIndicatorTone,
} from '@/hooks/connectionServiceStatus'

export type { WsConnectionIndicatorTone, ConnectionServiceLine }

const log = createLogger('WsConnection')

export type WsConnectionIndicatorState =
  | { kind: 'connected' }
  | {
      kind: 'actionable'
      tone: Exclude<WsConnectionIndicatorTone, 'neutral' | 'success'>
      pulse: boolean
      message: string
      actionLabel?: string
      onAction?: () => void
      actionDisabled?: boolean
    }
  | {
      kind: 'informational'
      tone: Exclude<WsConnectionIndicatorTone, 'neutral'>
      pulse: boolean
      message: string
    }

async function recoverIfForegroundOrganizationStale(options?: {
  recoverOnRefreshFailure?: boolean
  markRecoveryInFlightDuringRefresh?: boolean
}): Promise<boolean> {
  const before = useOrganizationStore.getState()
  const activeOrganizationId =
    before.selectedOrganization?.id
    ?? before.lastOpenedOrganizationId

  if (!activeOrganizationId) return false
  const wsStore = useWsConnectionStore.getState()
  const shouldMarkRecoveryInFlight = options?.markRecoveryInFlightDuringRefresh === true
  const wasRecoveryInFlight = wsStore.organizationAccessRecoveryInFlight
  let markedRecoveryInFlight = false
  let markRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  const previousLoadRetryCount = before.loadRetryCount ?? 0

  try {
    if (shouldMarkRecoveryInFlight && !wasRecoveryInFlight) {
      markRecoveryTimer = setTimeout(() => {
        markedRecoveryInFlight = true
        wsStore.setOrganizationAccessRecoveryInFlight(true)
      }, 0)
    }
    await before.loadOrganizations()
  } catch (err) {
    if (markRecoveryTimer) clearTimeout(markRecoveryTimer)
    log.warn('手动重连前刷新组织列表失败，继续按网络重连处理', err)
    if (markedRecoveryInFlight) {
      useWsConnectionStore.getState().setOrganizationAccessRecoveryInFlight(false)
    }
    return false
  }
  if (markRecoveryTimer) clearTimeout(markRecoveryTimer)

  const after = useOrganizationStore.getState()
  const latestOrganizations = after.organizations
  const refreshFailed =
    Boolean(after.lastLoadError) &&
    (after.loadRetryCount ?? 0) > previousLoadRetryCount
  const refreshFailedBecauseOrganizationAccess =
    refreshFailed &&
    isOrganizationPermissionMessage(after.lastLoadError ?? '')
  const stillAccessible = latestOrganizations.some((organization) => organization.id === activeOrganizationId)
  if (stillAccessible && !(options?.recoverOnRefreshFailure && refreshFailedBecauseOrganizationAccess)) {
    if (markedRecoveryInFlight) {
      useWsConnectionStore.getState().setOrganizationAccessRecoveryInFlight(false)
    }
    return false
  }

  if (shouldMarkRecoveryInFlight && !wasRecoveryInFlight && !markedRecoveryInFlight) {
    wsStore.setOrganizationAccessRecoveryInFlight(true)
  }

  log.warn('手动重连发现当前组织已不可访问，转入组织恢复', {
    organizationId: activeOrganizationId,
  })
  await recoverFromInvalidOrganizationAccess(activeOrganizationId)
  return true
}

function useDelayedDisconnect(agentGatewayStatus: string, networkOnline: boolean): boolean {
  const [showDisconnected, setShowDisconnected] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const isDisconnected = !networkOnline || agentGatewayStatus !== 'ready'
    if (isDisconnected) {
      if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          setShowDisconnected(true)
        }, 3_000)
      }
    } else {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setShowDisconnected(false)
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [agentGatewayStatus, networkOnline])

  return showDisconnected
}

const EMPTY_LOADED_ORG_IDS: string[] = []

export function useWsConnectionStatus() {
  const { t } = useTranslation('common')
  const agentGatewayStatus = useAgentGatewayStatus()
  const { status: gwStatus, authFailed: gwAuthFailed, reconnectAttempt, lastSyncCount, networkOnline, organizationAccessBlocked, organizationAccessBlockedName, organizationAccessRecoveryInFlight } = useWsConnectionStore(useShallow(state => ({
    status: state.status,
    authFailed: state.authFailed,
    reconnectAttempt: state.reconnectAttempt,
    lastSyncCount: state.lastSyncCount,
    networkOnline: state.networkOnline,
    organizationAccessBlocked: state.organizationAccessBlocked,
    organizationAccessBlockedName: state.organizationAccessBlockedName,
    organizationAccessRecoveryInFlight: state.organizationAccessRecoveryInFlight,
  })))
  const { connectionStatus: imStatus, authFailed: imAuthFailed, sessionKicked } = useIMStore(useShallow(state => ({
    connectionStatus: state.connectionStatus,
    authFailed: state.authFailed,
    sessionKicked: state.sessionKicked,
  })))
  // 只订 id：避免整对象引用抖动；spaceLoadError 在渲染期派生，禁止闭包进 useShallow selector
  // （React 19 要求 getSnapshot 连续两次 Object.is 相等，selector 内 map/??[] 会炸 Maximum update depth）
  const selectedOrganizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? null)
  const {
    spaces,
    spacesLoading,
    loadErrorByOrganizationId,
    lastLoadError,
    spaceError,
    lastLoadedOrganizationId,
    loadedOrganizationIds,
  } = useSpaceStore(useShallow(state => ({
    spaces: state.spaces,
    spacesLoading: state.isLoading,
    loadErrorByOrganizationId: state.loadErrorByOrganizationId,
    lastLoadError: state.lastLoadError ?? null,
    spaceError: state.error ?? null,
    lastLoadedOrganizationId: state.lastLoadedOrganizationId ?? null,
    // 禁止 `?? []`：每次 getSnapshot 新数组会让 React 19 判定 snapshot 未缓存
    loadedOrganizationIds: state.loadedOrganizationIds ?? EMPTY_LOADED_ORG_IDS,
  })))
  const spaceLoadError = selectedOrganizationId
    ? loadErrorByOrganizationId?.[selectedOrganizationId] ?? null
    : lastLoadError ?? spaceError

  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const showDisconnected = useDelayedDisconnect(agentGatewayStatus, networkOnline)
  const agentGatewayReady = agentGatewayStatus === 'ready'
  // 订 tables 引用本身，再 memo 派生；勿在 selector 里 map 出新对象（useShallow 对数组元素是 Object.is）
  //  已先做同构修法；此处保留并与 space selector 稳定化一并收口
  const collabTables = useTableCollabStore(state => state.tables)
  const tableCollabStatuses = useMemo(
    () => Object.values(collabTables).map(({ status, connectionStatus, isOnline, isFallback, syncModeReason }) => ({
      status,
      connectionStatus,
      isOnline,
      isFallback,
      syncModeReason,
    })),
    [collabTables],
  )
  const tabDataRuntime = useTabDataRuntimeMonitorSnapshot()
  const tabDocRuntime = useTabDocRuntimeMonitorSnapshot()

  const [reconnecting, setReconnecting] = useState(false)
  const prevAgentGatewayStatusRef = useRef(agentGatewayStatus)
  const prevImStatusRef = useRef(imStatus)
  const imWasConnectedRef = useRef(false)
  const authRetryCountRef = useRef(0)
  const lastRecoveredAtRef = useRef(0)
  const autoOrganizationRecoveryKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isAuthenticated) {
      imWasConnectedRef.current = false
    }
  }, [isAuthenticated])

  useEffect(() => {
    const prevAgentGateway = prevAgentGatewayStatusRef.current
    const prevIm = prevImStatusRef.current
    prevAgentGatewayStatusRef.current = agentGatewayStatus
    prevImStatusRef.current = imStatus

    const gwRecovered =
      (prevAgentGateway === 'connecting' || prevAgentGateway === 'recovering' || prevAgentGateway === 'idle') &&
      agentGatewayReady
    const imRecovered =
      imWasConnectedRef.current &&
      (prevIm === 'disconnected' || prevIm === 'connecting') &&
      imStatus === 'connected'

    if (imStatus === 'connected') {
      imWasConnectedRef.current = true
    }

    if (
      (gwRecovered || imRecovered) &&
      agentGatewayReady &&
      imStatus === 'connected'
    ) {
      if (Date.now() - lastRecoveredAtRef.current < 60_000) {
        return
      }
      lastRecoveredAtRef.current = Date.now()
      setReconnecting(false)
      authRetryCountRef.current = 0
      const syncInfo = lastSyncCount > 0
        ? t('ws.recoveredWithSync', 'Agent 服务连接已恢复，同步了 {{count}} 条新消息', { count: lastSyncCount })
        : t('ws.recovered', 'Agent 服务连接已恢复')
      toast({ title: syncInfo })
      useWsConnectionStore.getState().setLastSyncCount(0)
    }
  }, [agentGatewayReady, agentGatewayStatus, imStatus, lastSyncCount, t])

  useEffect(() => {
    if (imStatus === 'connected') {
      autoOrganizationRecoveryKeyRef.current = null
      return
    }
    if (
      !isAuthenticated ||
      !networkOnline ||
      !agentGatewayReady ||
      imStatus !== 'disconnected' ||
      !imWasConnectedRef.current ||
      organizationAccessRecoveryInFlight ||
      organizationAccessBlocked ||
      gwAuthFailed ||
      imAuthFailed
    ) {
      return
    }

    const state = useOrganizationStore.getState()
    const activeOrganizationId =
      state.selectedOrganization?.id
      ?? state.lastOpenedOrganizationId
    if (!activeOrganizationId) return
    if (autoOrganizationRecoveryKeyRef.current === activeOrganizationId) return

    autoOrganizationRecoveryKeyRef.current = activeOrganizationId
    void recoverIfForegroundOrganizationStale({
      markRecoveryInFlightDuringRefresh: true,
    })
  }, [
    gwAuthFailed,
    agentGatewayReady,
    imAuthFailed,
    imStatus,
    isAuthenticated,
    networkOnline,
    organizationAccessBlocked,
    organizationAccessRecoveryInFlight,
  ])

  const handleManualReconnect = useCallback(async () => {
    if (reconnecting) return
    setReconnecting(true)
    log.info('用户手动触发网关重连')
    try {
      const recoveredOrganization = await recoverIfForegroundOrganizationStale({
        recoverOnRefreshFailure: true,
      })
      if (recoveredOrganization) return

      const ok = await getChatClient().getGateway().connect()
      if (!ok) {
        log.warn('手动重连网关返回失败')
        toast({ title: t('ws.reconnectFailed', '重连失败，请稍后重试'), variant: 'destructive' })
        return
      }
      reconnectCentrifugo()
      log.info('手动重连网关成功')
    } catch (err) {
      log.error('手动重连网关异常', err)
      toast({ title: t('ws.reconnectFailed', '重连失败，请稍后重试'), variant: 'destructive' })
    } finally {
      setReconnecting(false)
    }
  }, [reconnecting, t])

  const handleAuthRetry = useCallback(async () => {
    authRetryCountRef.current += 1
    if (authRetryCountRef.current > 2) {
      void useAuthStore.getState().logout()
      return
    }
    useWsConnectionStore.getState().clearAuthFailed()
    await handleManualReconnect()
  }, [handleManualReconnect])

  const suppressImStatusForEmptyOrganization =
    Boolean(selectedOrganizationId) &&
    !spacesLoading &&
    !spaceLoadError &&
    (lastLoadedOrganizationId === selectedOrganizationId ||
      loadedOrganizationIds.includes(selectedOrganizationId ?? '')) &&
    !spaces.some(space => space.organization_id === selectedOrganizationId)

  const serviceLines = buildConnectionServiceLines({
    networkOnline,
    imStatus,
    imWasConnected: imWasConnectedRef.current,
    agentGatewayStatus,
    tableCollabStatuses,
    tabDataCollabStatus: tabDataRuntime?.metrics?.collabStatus ?? null,
    tabDataCollabConnectionStatus: tabDataRuntime?.metrics?.collabConnectionStatus ?? null,
    tabDataCollabOnline: tabDataRuntime?.metrics?.isCollabOnline ?? null,
    tabDataCollabFallback: tabDataRuntime?.metrics?.isCollabFallback ?? false,
    tabDataCollabSyncModeReason:
      tableCollabStatuses.find((item) => item.isFallback)?.syncModeReason ?? null,
    tabDocCollaborating: tabDocRuntime?.metrics?.isCollaborating ?? false,
    tabDocCollabStatus: tabDocRuntime?.metrics?.collabStatus ?? null,
    tabDocCollabConnectionStatus: tabDocRuntime?.metrics?.collabConnectionStatus ?? null,
    tabDocEventStreamStatus: tabDocRuntime?.metrics?.eventStreamStatus ?? null,
    tabDocCollabFallback: tabDocRuntime?.metrics?.isFallback ?? false,
  }, t)
  const collabLine = serviceLines.find((line) => line.id === 'collab')
  const serviceTone = maxConnectionTone(serviceLines.map((line) => line.tone))

  const resolveIndicatorState = (): WsConnectionIndicatorState | null => {
    if (!isAuthenticated) return null

    if (organizationAccessRecoveryInFlight) {
      return {
        kind: 'informational',
        tone: 'warning',
        pulse: true,
        message: t('ws.organizationSwitching', '正在切换到可用组织...'),
      }
    }

    if (organizationAccessBlocked) {
      return {
        kind: 'informational',
        tone: 'destructive',
        pulse: false,
        message: t('ws.organizationAccessBlocked', '无法访问组织「{{name}}」，请在左侧选择其他组织', {
          name: organizationAccessBlockedName ?? t('organization:unnamed', '组织'),
        }),
      }
    }

    if (gwAuthFailed || imAuthFailed) {
      const shouldRelogin = authRetryCountRef.current >= 2
      return {
        kind: 'actionable',
        tone: 'destructive',
        pulse: false,
        message: t('ws.authExpired', '登录已过期，请重新登录'),
        actionLabel: reconnecting
          ? t('ws.retrying', '重试中...')
          : shouldRelogin
            ? t('ws.relogin', '重新登录')
            : t('ws.retry', '重试连接'),
        onAction: handleAuthRetry,
        actionDisabled: reconnecting,
      }
    }

    if (agentGatewayStatus === 'recovering') {
      return {
        kind: 'informational',
        tone: 'warning',
        pulse: true,
        message: t('ws.networkRecovering', '网络恢复中，消息和 Agent 通知可能稍有延迟'),
      }
    }

    if (!networkOnline && showDisconnected) {
      return {
        kind: 'informational',
        tone: 'destructive',
        pulse: true,
        message: t('ws.networkOffline', '网络已断开，请检查网络连接'),
      }
    }

    if ((agentGatewayStatus === 'idle' || agentGatewayStatus === 'connecting') && showDisconnected) {
      return {
        kind: 'informational',
        tone: 'warning',
        pulse: true,
        message: t('ws.serviceAgentGatewayConnecting', '本地 Agent 网关连接中…'),
      }
    }

    if (!agentGatewayReady && showDisconnected) {
      return {
        kind: 'actionable',
        tone: 'warning',
        pulse: true,
        message: t('ws.disconnected', 'Agent 服务连接已断开，正在尝试重连...'),
        actionLabel: reconnecting
          ? t('ws.reconnecting_short', '重连中...')
          : t('ws.manualReconnect', '手动重连'),
        onAction: handleManualReconnect,
        actionDisabled: reconnecting,
      }
    }

    if (
      agentGatewayReady &&
      imWasConnectedRef.current &&
      imStatus === 'disconnected' &&
      !suppressImStatusForEmptyOrganization
    ) {
      return {
        kind: 'actionable',
        tone: 'destructive',
        pulse: true,
        message: t('ws.imDisconnected', '消息服务连接中断，新消息通知可能延迟'),
        actionLabel: reconnecting
          ? t('ws.reconnecting_short', '重连中...')
          : t('ws.manualReconnect', '手动重连'),
        onAction: handleManualReconnect,
        actionDisabled: reconnecting,
      }
    }

    if (
      agentGatewayReady &&
      imWasConnectedRef.current &&
      imStatus === 'connecting' &&
      !suppressImStatusForEmptyOrganization
    ) {
      return {
        kind: 'informational',
        tone: 'warning',
        pulse: true,
        message: t('ws.imReconnecting', '消息服务重连中，新消息通知可能延迟'),
      }
    }

    const collabIndicator = collabLine ? pickCollabIndicatorMessage(collabLine, t) : null
    if (collabIndicator) {
      return {
        kind: 'informational',
        tone: collabIndicator.tone,
        pulse: true,
        message: collabIndicator.message,
      }
    }

    return { kind: 'connected' }
  }

  const indicatorState = resolveIndicatorState()

  const tone: WsConnectionIndicatorTone =
    indicatorState?.kind === 'connected'
      ? (serviceTone === 'neutral' ? 'success' : serviceTone)
      : indicatorState?.kind === 'actionable' || indicatorState?.kind === 'informational'
        ? indicatorState.tone
        : 'neutral'

  const pulse =
    indicatorState?.kind === 'connected'
      ? serviceTone === 'warning' || serviceTone === 'destructive'
      : indicatorState?.kind === 'actionable' || indicatorState?.kind === 'informational'
        ? indicatorState.pulse
        : false

  const connectedLabel = t('ws.connectedSummary', '连接正常')

  return {
    isAuthenticated,
    indicatorState,
    serviceLines,
    serviceTone,
    tone,
    pulse,
    connectedLabel,
    handleManualReconnect,
    handleAuthRetry,
    reconnecting,
    imWasConnectedRef,
    showDisconnected,
    gwStatus,
    imStatus,
    networkOnline,
    reconnectAttempt,
    sessionKicked,
  }
}
