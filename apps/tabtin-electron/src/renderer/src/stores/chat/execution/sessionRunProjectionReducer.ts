import type {
  ChatSessionRunState,
  ChatSessionRunStatus,
} from '@tabtin/chat-client'

export type SessionRunProjectionSource =
  | 'event'
  | 'reconcile'
  | 'server-snapshot'
  | 'server-event'
  | 'runtime-sync'

export interface SessionRunProjection {
  /** 合并服务端事实与本地临时覆盖后的 busy 结果。 */
  busy: boolean
  /** runtime FIFO 中仍可识别的本地 run id。 */
  queuedRunIds: string[]
  /** 最近一次影响有效投影的来源。 */
  source: SessionRunProjectionSource
  /** 最近一次有效写入时间（仅用于诊断/对账新鲜度，不参与版本比较）。 */
  lastSyncAt: number
  /** 是否已见过新服务端的 run_state 字段；null 表示尚无权威历史 run。 */
  hasServerSnapshot: boolean
  /** 服务端按 sequence/revision 单调合并后的当前事实。 */
  authoritativeRunState: ChatSessionRunState | null
  /** 本机尚未被服务端增量确认的即时覆盖。 */
  localStatus: ChatSessionRunStatus | null
  /** 首个 lifecycle/ACK 到达后绑定的服务端 run_id。 */
  localRunId: string | null
  /** 派发时即可稳定获得的 client_message_id。 */
  localDispatchToken: string | null
  /**
   * ：本地 host 已推送过 `agent.stream.run_sync` 时的 busy 镜像。
   * null = 尚未收到（远端会话仅靠 server run_state）；非 null 时 busy 只认此值。
   */
  runtimeBusy: boolean | null
  /** 每 session 已应用的最大 run_sync.seq；丢弃更旧包。 */
  runtimeSyncSeq: number
}

export type SessionRunProjectionAction =
  | {
      type: 'server-snapshot' | 'server-event'
      runState: ChatSessionRunState | null
      now: number
    }
  | {
      type: 'runtime-sync'
      runId: string | null
      status: 'idle' | 'running' | 'queued'
      seq: number
      queuedRunIds: string[]
      busy: boolean
      now: number
    }
  | {
      /** 本机丢包兜底：改 runtimeBusy 但不占用 host seq。 */
      type: 'runtime-mirror-override'
      runId: string | null
      queuedRunIds: string[]
      busy: boolean
      now: number
    }


const RUN_STATUSES = new Set<ChatSessionRunStatus>([
  'queued',
  'running',
  'waiting_user',
  'paused',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

const ACTIVE_STATUSES = new Set<ChatSessionRunStatus>([
  'queued',
  'running',
  'waiting_user',
  'paused',
  'cancelling',
])

const TERMINAL_STATUSES = new Set<ChatSessionRunStatus>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** Gateway / HTTP 边界的最小运行时校验，拒绝畸形状态污染单调投影。 */
export function isChatSessionRunState(value: unknown): value is ChatSessionRunState {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return (
    typeof state.run_id === 'string'
    && state.run_id.length > 0
    && Number.isSafeInteger(state.sequence)
    && (state.sequence as number) >= 0
    && Number.isSafeInteger(state.revision)
    && (state.revision as number) >= 0
    && typeof state.status === 'string'
    && RUN_STATUSES.has(state.status as ChatSessionRunStatus)
    && Number.isSafeInteger(state.queue_depth)
    && (state.queue_depth as number) >= 0
    && isNullableString(state.started_at)
    && typeof state.state_changed_at === 'string'
    && state.state_changed_at.length > 0
    && isNullableString(state.ended_at)
    && isNullableString(state.stop_reason)
    && isNullableString(state.error_class)
    && isNullableString(state.waiting_interaction_id)
  )
}

export function isTerminalRunStatus(status: ChatSessionRunStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function isActiveRunStatus(status: ChatSessionRunStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

/**
 * 判断 incoming 是否能推进 current。
 *
 * sequence 先判轮次，revision 再判同轮版本；同轮终态不可回到活跃态，即使迟到
 * start 携带了更高 revision，也不能复活已经结束的 run。
 */
export function shouldAcceptSessionRunState(
  current: ChatSessionRunState | null,
  incoming: ChatSessionRunState,
): boolean {
  if (!current) return true
  if (incoming.sequence !== current.sequence) {
    return incoming.sequence > current.sequence
  }
  if (incoming.run_id !== current.run_id) return false
  if (isTerminalRunStatus(current.status) && isActiveRunStatus(incoming.status)) {
    return false
  }
  return incoming.revision > current.revision
}

/** 从两个已验证状态中选择单调更新后应该保留的一个。 */
export function selectNewerSessionRunState(
  current: ChatSessionRunState | null,
  incoming: ChatSessionRunState,
): ChatSessionRunState {
  return shouldAcceptSessionRunState(current, incoming) ? incoming : current ?? incoming
}

function deriveProjection(
  state: Omit<SessionRunProjection, 'busy'>,
): SessionRunProjection {
  // ：一旦 host 推送过 run_sync，busy 只镜像 runtimeBusy，不再被
  // lifecycle/terminal/乐观/self-heal/stale server active 二次推断。
  if (state.runtimeBusy !== null) {
    return {
      ...state,
      busy: state.runtimeBusy,
    }
  }
  const effectiveStatus = state.localStatus ?? state.authoritativeRunState?.status ?? null
  return {
    ...state,
    busy: (effectiveStatus ? isActiveRunStatus(effectiveStatus) : false)
      || state.queuedRunIds.length > 0,
  }
}

function initialProjection(source: SessionRunProjectionSource, now: number): SessionRunProjection {
  return {
    busy: false,
    queuedRunIds: [],
    source,
    lastSyncAt: now,
    hasServerSnapshot: false,
    authoritativeRunState: null,
    localStatus: null,
    localRunId: null,
    localDispatchToken: null,
    runtimeBusy: null,
    runtimeSyncSeq: 0,
  }
}

export function doesSessionRunIdentityMatch(
  projection: SessionRunProjection,
  runId: string | null,
  dispatchToken: string | null,
): boolean {
  if (dispatchToken && projection.localDispatchToken) {
    return dispatchToken === projection.localDispatchToken
  }
  if (runId && projection.localRunId) {
    return runId === projection.localRunId
  }
  if (runId && projection.localDispatchToken && !projection.localRunId) {
    return false
  }
  if (runId && projection.authoritativeRunState) {
    return runId === projection.authoritativeRunState.run_id
  }
  if (
    !runId
    && !dispatchToken
    && (projection.localRunId || projection.localDispatchToken)
  ) {
    return false
  }
  return true
}

/**
 * 会话运行投影的纯 reducer。
 *
 * 返回原对象代表动作被拒绝/去重；返回 undefined 代表旧后端兼容路径已回到完全
 * idle，可从 runtime map 中删除。所有时间由 action 注入，便于跨端 fixture 重放。
 */
export function reduceSessionRunProjection(
  current: SessionRunProjection | undefined,
  action: SessionRunProjectionAction,
): SessionRunProjection | undefined {
  const base = current ?? initialProjection(
    action.type === 'server-event' ? 'server-event'
      : action.type === 'server-snapshot' ? 'server-snapshot'
        : action.type === 'runtime-sync' ? 'runtime-sync'
          : 'reconcile',
    action.now,
  )

  if (action.type === 'server-snapshot' || action.type === 'server-event') {
    if (action.runState === null) {
      // null 没有版本，不能覆盖已经收到的非空事实；它只标记“新后端、无历史投影”。
      if (base.authoritativeRunState || base.hasServerSnapshot) return current
      return deriveProjection({
        ...base,
        source: base.localStatus ? base.source : action.type,
        lastSyncAt: action.now,
        hasServerSnapshot: true,
      })
    }
    if (!shouldAcceptSessionRunState(base.authoritativeRunState, action.runState)) {
      return current
    }
    const advancesSequence = base.authoritativeRunState !== null
      && action.runState.sequence > base.authoritativeRunState.sequence
    const serverStartsNewRun = base.authoritativeRunState === null || advancesSequence
    const snapshotStartsNewRun = action.type === 'server-snapshot'
      && advancesSequence
    const localTerminalBlocksSameRunActive = base.localStatus !== null
      && isTerminalRunStatus(base.localStatus)
      && isActiveRunStatus(action.runState.status)
      && base.authoritativeRunState?.sequence === action.runState.sequence
    // ：本机 host 已 run_sync idle 后，同轮迟到的观察面 interrupted
    // 不得清掉本地完成态，也不能成为展示终态。
    const localHostIdleBlocksSameRunInterrupt = base.runtimeBusy === false
      && action.runState.status === 'interrupted'
      && !advancesSequence
    const serverMatchesLocal = serverStartsNewRun
      || (
        base.localRunId !== null
          ? action.runState.run_id === base.localRunId
          : base.localDispatchToken === null
      )
    const shouldClearLocal = (
      action.type === 'server-event' || snapshotStartsNewRun
    ) && serverMatchesLocal
      && !localTerminalBlocksSameRunActive
      && !localHostIdleBlocksSameRunInterrupt
    return deriveProjection({
      ...base,
      source: shouldClearLocal || !base.localStatus
        ? action.type
        : base.source,
      lastSyncAt: action.now,
      hasServerSnapshot: true,
      authoritativeRunState: action.runState,
      // 实时增量代表服务端已确认更新，可收掉同轮本地临时覆盖；HTTP snapshot
      // 可能落后于刚发生的本地动作，因此保留本地 overlay 等后续增量确认。
      localStatus: shouldClearLocal ? null : base.localStatus,
      localRunId: shouldClearLocal ? null : base.localRunId,
      localDispatchToken: shouldClearLocal ? null : base.localDispatchToken,
      queuedRunIds: shouldClearLocal ? [] : base.queuedRunIds,
    })
  }

  if (action.type === 'runtime-sync') {
    if (action.seq <= base.runtimeSyncSeq) return current
    const localStatus: ChatSessionRunStatus | null = !action.busy
      ? 'completed'
      : action.status === 'queued'
        ? 'queued'
        : 'running'
    return deriveProjection({
      ...base,
      source: 'runtime-sync',
      lastSyncAt: action.now,
      runtimeBusy: action.busy,
      runtimeSyncSeq: action.seq,
      localStatus,
      localRunId: action.runId,
      queuedRunIds: action.queuedRunIds,
      // dispatch token 不再参与 busy；保留既有值供身份匹配副作用。
    })
  }

  if (action.type === 'runtime-mirror-override') {
    const localStatus: ChatSessionRunStatus | null = !action.busy
      ? 'completed'
      : action.queuedRunIds.length > 0
        ? 'queued'
        : 'running'
    return deriveProjection({
      ...base,
      source: 'reconcile',
      lastSyncAt: action.now,
      runtimeBusy: action.busy,
      localStatus,
      localRunId: action.runId,
      queuedRunIds: action.queuedRunIds,
    })
  }

  return current
}

export function getEffectiveSessionRunStatus(
  projection: SessionRunProjection | undefined,
): ChatSessionRunStatus | null {
  if (!projection) return null
  if (projection.runtimeBusy === false) {
    const local = projection.localStatus
    if (local && isTerminalRunStatus(local) && local !== 'interrupted') {
      return local
    }
    const authoritative = projection.authoritativeRunState?.status ?? null
    if (authoritative === 'interrupted') {
      return local ?? 'completed'
    }
  }
  return projection.localStatus ?? projection.authoritativeRunState?.status ?? null
}
