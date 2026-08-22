import type { TFunction } from 'i18next'
import { CollabConnectionStatus, CollabStatus } from '@tabtin/collab-core'
import type { AgentGatewayStatus } from '@/stores/useAgentGatewayStore'

export type WsConnectionIndicatorTone = 'neutral' | 'success' | 'warning' | 'destructive'

export type ConnectionServiceId =
  | 'network'
  | 'messaging'
  | 'agentGateway'
  | 'collab'

export type ConnectionServiceLine = {
  id: ConnectionServiceId
  label: string
  detail: string
  tone: WsConnectionIndicatorTone
}

type TranslateFn = TFunction<'common'>

const TONE_RANK: Record<WsConnectionIndicatorTone, number> = {
  neutral: 0,
  success: 1,
  warning: 2,
  destructive: 3,
}

export function maxConnectionTone(
  tones: WsConnectionIndicatorTone[],
): WsConnectionIndicatorTone {
  return tones.reduce<WsConnectionIndicatorTone>(
    (current, tone) => (TONE_RANK[tone] > TONE_RANK[current] ? tone : current),
    'neutral',
  )
}

function collabStatusTone(status: string | CollabStatus | null | undefined): WsConnectionIndicatorTone {
  switch (status) {
    case CollabStatus.SYNCED:
    case 'synced':
      return 'success'
    case CollabStatus.CONNECTING:
    case CollabStatus.SYNCING:
    case 'connecting':
    case 'syncing':
      return 'warning'
    case CollabStatus.DISCONNECTED:
    case CollabStatus.FORCE_CLOSED:
    case 'disconnected':
    case 'force-closed':
      return 'destructive'
    default:
      return 'neutral'
  }
}

function collabStatusLabel(status: string | CollabStatus | null | undefined, t: TranslateFn): string {
  switch (status) {
    case CollabStatus.INITIAL:
    case 'initial':
      return t('collab.statusInitial')
    case CollabStatus.CONNECTING:
    case 'connecting':
      return t('collab.statusConnecting')
    case CollabStatus.SYNCING:
    case 'syncing':
      return t('collab.statusSyncing')
    case CollabStatus.SYNCED:
    case 'synced':
      return t('collab.statusSynced')
    case CollabStatus.DISCONNECTED:
    case 'disconnected':
      return t('collab.statusDisconnected')
    case CollabStatus.FORCE_CLOSED:
    case 'force-closed':
      return t('collab.statusForceClosed')
    default:
      return t('ws.serviceCollabIdle', '未打开协作文档')
  }
}

export type TableCollabServiceStatus = {
  status: CollabStatus | null
  /** Provider 连接生命周期；stuck-connecting 表示握手持久挂起 */
  connectionStatus?: string | null
  isOnline: boolean
  isFallback?: boolean
  syncModeReason?: string | null
}

export type ConnectionServiceInputs = {
  networkOnline: boolean
  imStatus: 'disconnected' | 'connecting' | 'connected'
  imWasConnected: boolean
  agentGatewayStatus: AgentGatewayStatus
  tableCollabStatuses: TableCollabServiceStatus[]
  tabDataCollabStatus: string | null
  tabDataCollabConnectionStatus?: string | null
  tabDataCollabOnline: boolean | null
  tabDataCollabFallback?: boolean
  tabDataCollabSyncModeReason?: string | null
  tabDocCollaborating: boolean
  /** Y.js CollabStatus；优先于 eventStreamStatus 驱动「协作同步」行 */
  tabDocCollabStatus: string | null
  tabDocCollabConnectionStatus?: string | null
  tabDocEventStreamStatus: string | null
  tabDocCollabFallback: boolean
}

const EXPECTED_LEGACY_REASONS = new Set([
  'field_visibility_restricted',
  'flag_disabled',
  'module_not_migrated',
])

function isExpectedCollabFallback(
  isFallback: boolean | undefined,
  syncModeReason: string | null | undefined,
): boolean {
  if (!isFallback) return false
  if (!syncModeReason) return true
  return EXPECTED_LEGACY_REASONS.has(syncModeReason) || syncModeReason === 'collab_unavailable'
}

/** ：握手持久挂起——status 恒为 CONNECTING，必须靠 connectionStatus 区分 */
function isStuckConnecting(connectionStatus: string | null | undefined): boolean {
  return connectionStatus === CollabConnectionStatus.STUCK_CONNECTING
}

function isHealthyTableStartupStatus(
  status: string | CollabStatus | null | undefined,
  connectionStatus: string | null | undefined,
  syncModeReason: string | null | undefined,
): boolean {
  if (connectionStatus === CollabConnectionStatus.RECONNECTING) return false
  const isStartupStatus =
    status == null ||
    status === CollabStatus.INITIAL ||
    status === 'initial' ||
    status === CollabStatus.CONNECTING ||
    status === 'connecting' ||
    status === CollabStatus.SYNCING ||
    status === 'syncing'
  if (!isStartupStatus) return false

  const isHealthyConnection =
    connectionStatus == null ||
    connectionStatus === CollabConnectionStatus.IDLE ||
    connectionStatus === CollabConnectionStatus.CONNECTING ||
    connectionStatus === CollabConnectionStatus.CONNECTED
  if (!isHealthyConnection) return false

  return syncModeReason == null || syncModeReason === 'collab_unavailable'
}

function stuckConnectingDetail(t: TranslateFn): string {
  return t('ws.serviceCollabStuckConnecting', '连接异常，持续重试中（建议重启应用）')
}

export function buildConnectionServiceLines(
  input: ConnectionServiceInputs,
  t: TranslateFn,
): ConnectionServiceLine[] {
  const networkLine: ConnectionServiceLine = {
    id: 'network',
    label: t('ws.serviceNetwork', '网络'),
    detail: input.networkOnline
      ? t('ws.serviceNetworkOnline', '已连接互联网')
      : t('ws.serviceNetworkOffline', '网络已断开'),
    tone: input.networkOnline ? 'success' : 'destructive',
  }

  const messagingTone: WsConnectionIndicatorTone =
    input.imStatus === 'connected'
      ? 'success'
      : input.imWasConnected || input.imStatus === 'connecting'
        ? input.imStatus === 'connecting' ? 'warning' : 'destructive'
        : 'neutral'

  const messagingDetail =
    input.imStatus === 'connected'
      ? t('ws.serviceMessagingConnected', 'Centrifugo 实时消息已连接')
      : input.imStatus === 'connecting'
        ? t('ws.imReconnecting', '消息服务重连中，新消息通知可能延迟')
        : input.imWasConnected
          ? t('ws.imDisconnected', '消息服务连接中断，新消息通知可能延迟')
          : t('ws.serviceMessagingIdle', '尚未连接消息服务')

  const messagingLine: ConnectionServiceLine = {
    id: 'messaging',
    label: t('ws.serviceMessaging', '实时消息'),
    detail: messagingDetail,
    tone: messagingTone,
  }

  const agentGatewayTone: WsConnectionIndicatorTone =
    input.agentGatewayStatus === 'ready'
      ? 'success'
      : input.agentGatewayStatus === 'recovering' || input.agentGatewayStatus === 'connecting'
        ? 'warning'
        : input.agentGatewayStatus === 'idle'
          ? 'neutral'
          : 'warning'

  const agentGatewayDetail =
    input.agentGatewayStatus === 'ready'
      ? t('ws.serviceAgentGatewayReady', '本地 Agent 网关就绪')
      : input.agentGatewayStatus === 'recovering'
        ? t('ws.networkRecovering', '网络恢复中，消息和 Agent 通知可能稍有延迟')
        : input.agentGatewayStatus === 'connecting'
          ? t('ws.serviceAgentGatewayConnecting', '本地 Agent 网关连接中…')
          : t('ws.serviceAgentGatewayIdle', '本地 Agent 网关初始化中…')

  const agentGatewayLine: ConnectionServiceLine = {
    id: 'agentGateway',
    label: t('ws.serviceAgentGateway', 'Agent 网关'),
    detail: agentGatewayDetail,
    tone: agentGatewayTone,
  }

  const collabCandidates: Array<{ tone: WsConnectionIndicatorTone; detail: string }> = []

  for (const table of input.tableCollabStatuses) {
    if (table.syncModeReason === 'access_verification_unavailable') {
      collabCandidates.push({
        tone: 'warning',
        detail: t('ws.serviceCollabAccessVerificationUnavailable', '暂时无法验证表格协作权限'),
      })
      continue
    }
    if (table.syncModeReason === 'permission_denied') {
      collabCandidates.push({
        tone: 'destructive',
        detail: t('ws.serviceCollabPermissionDenied', '无权限访问表格协作'),
      })
      continue
    }
    // 挂起优先于降级归类：stuck_connecting 引发的 legacy 属于故障，不是预期降级
    if (isStuckConnecting(table.connectionStatus)) {
      collabCandidates.push({ tone: 'destructive', detail: stuckConnectingDetail(t) })
      continue
    }
    if (isHealthyTableStartupStatus(table.status, table.connectionStatus, table.syncModeReason)) {
      continue
    }
    if (isExpectedCollabFallback(table.isFallback, table.syncModeReason)) {
      collabCandidates.push({
        tone: 'warning',
        detail: table.syncModeReason === 'field_visibility_restricted'
          ? t('ws.serviceCollabFieldRestricted', '受限字段，使用兼容同步')
          : t('ws.serviceCollabTableFallback', '表格协作降级（兼容同步）'),
      })
      continue
    }
    if (!table.status || table.status === CollabStatus.INITIAL) continue
    collabCandidates.push({
      tone: table.isOnline ? collabStatusTone(table.status) : 'destructive',
      detail: collabStatusLabel(table.status, t),
    })
  }

  if (input.tabDataCollabSyncModeReason === 'access_verification_unavailable') {
    collabCandidates.push({
      tone: 'warning',
      detail: t('ws.serviceCollabAccessVerificationUnavailable', '暂时无法验证表格协作权限'),
    })
  } else if (input.tabDataCollabSyncModeReason === 'permission_denied') {
    collabCandidates.push({
      tone: 'destructive',
      detail: t('ws.serviceCollabPermissionDenied', '无权限访问表格协作'),
    })
  } else if (isStuckConnecting(input.tabDataCollabConnectionStatus)) {
    collabCandidates.push({ tone: 'destructive', detail: stuckConnectingDetail(t) })
  } else if (isHealthyTableStartupStatus(
    input.tabDataCollabStatus,
    input.tabDataCollabConnectionStatus,
    input.tabDataCollabSyncModeReason,
  )) {
    // 表格切换启动期的连接 / syncing / transient fallback 不升级为全局异常。
  } else if (isExpectedCollabFallback(input.tabDataCollabFallback, input.tabDataCollabSyncModeReason)) {
    collabCandidates.push({
      tone: 'warning',
      detail: input.tabDataCollabSyncModeReason === 'field_visibility_restricted'
        ? t('ws.serviceCollabFieldRestricted', '受限字段，使用兼容同步')
        : t('ws.serviceCollabTableFallback', '表格协作降级（兼容同步）'),
    })
  } else if (input.tabDataCollabStatus && input.tabDataCollabOnline === false) {
    collabCandidates.push({
      tone: 'destructive',
      detail: collabStatusLabel(input.tabDataCollabStatus, t),
    })
  } else if (input.tabDataCollabStatus && input.tabDataCollabOnline) {
    collabCandidates.push({
      tone: collabStatusTone(input.tabDataCollabStatus),
      detail: collabStatusLabel(input.tabDataCollabStatus, t),
    })
  }

  // 协作同步 = Y.js 连接态（单人实时写云端也算）；勿用 Gateway event stream 的 idle/connected。
  const tabDocStatus = input.tabDocCollabStatus
  const tabDocActive =
    (tabDocStatus != null
      && tabDocStatus !== CollabStatus.INITIAL
      && tabDocStatus !== 'initial')
    || input.tabDocCollaborating
  if (tabDocActive) {
    if (isStuckConnecting(input.tabDocCollabConnectionStatus)) {
      collabCandidates.push({ tone: 'destructive', detail: stuckConnectingDetail(t) })
    } else {
      const statusForLabel = tabDocStatus ?? input.tabDocEventStreamStatus
      const docTone = input.tabDocCollabFallback
        ? 'warning'
        : collabStatusTone(statusForLabel)
      collabCandidates.push({
        tone: docTone,
        detail: input.tabDocCollabFallback
          ? t('ws.serviceCollabFallback', 'TabDoc 协作降级（本地编辑）')
          : collabStatusLabel(statusForLabel, t),
      })
    }
  }

  const baseLines = [networkLine, messagingLine, agentGatewayLine]

  if (collabCandidates.length === 0) {
    return baseLines
  }

  const collabLine: ConnectionServiceLine = {
    id: 'collab',
    label: t('ws.serviceCollab', '协作同步'),
    detail: collabCandidates
      .sort((left, right) => TONE_RANK[right.tone] - TONE_RANK[left.tone])[0]
      .detail,
    tone: maxConnectionTone(collabCandidates.map((item) => item.tone)),
  }

  return [...baseLines, collabLine]
}

export function pickCollabIndicatorMessage(
  collabLine: ConnectionServiceLine,
  t: TranslateFn,
): { tone: Exclude<WsConnectionIndicatorTone, 'neutral' | 'success'>; message: string } | null {
  if (collabLine.tone !== 'warning' && collabLine.tone !== 'destructive') {
    return null
  }
  // 预期权限降级：用服务行 detail 原文，勿换成「连接异常 / 正在同步」
  if (
    collabLine.tone === 'warning'
    && (
      collabLine.detail === t('ws.serviceCollabFieldRestricted', '受限字段，使用兼容同步')
      || collabLine.detail === t('ws.serviceCollabTableFallback', '表格协作降级（兼容同步）')
      || collabLine.detail === t('ws.serviceCollabFallback', 'TabDoc 协作降级（本地编辑）')
      || collabLine.detail === t(
        'ws.serviceCollabAccessVerificationUnavailable',
        '暂时无法验证表格协作权限',
      )
    )
  ) {
    return { tone: 'warning', message: collabLine.detail }
  }
  // 挂起故障：保留「建议重启应用」原文，勿换成通用断连文案
  if (collabLine.tone === 'destructive' && collabLine.detail === stuckConnectingDetail(t)) {
    return { tone: 'destructive', message: collabLine.detail }
  }
  if (
    collabLine.tone === 'destructive'
    && collabLine.detail === t('ws.serviceCollabPermissionDenied', '无权限访问表格协作')
  ) {
    return { tone: 'destructive', message: collabLine.detail }
  }
  return {
    tone: collabLine.tone,
    message: collabLine.tone === 'destructive'
      ? t('ws.collabDisconnected', '部分协作文档连接异常，编辑将在重连后同步')
      : t('ws.collabRecovering', '协作文档正在连接或同步'),
  }
}
