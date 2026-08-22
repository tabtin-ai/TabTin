/**
 * sessionRunProjection — 会话执行态的单一客户端投影。
 *
 *  busy 写入口（仅此三处）：
 * 1. 本机：`applyRuntimeRunSync`（`agent.stream.run_sync`，busy = status !== idle）
 * 2. 本机丢包：`applyRunReconcile` → `runtime-mirror-override`（仅本机托管 get-state）
 * 3. 远控 / 旁观：`applySessionRunStateSnapshot` / `Event`（服务端 `run_state`）
 *
 * 禁止：lifecycle / terminal / 乐观发送 / message_start / MESSAGE_QUEUED 写 busy。
 */

import type {
  ChatSession,
} from '@tabtin/chat-client'
import {
  AgentRunSyncPayloadSchema,
  isAgentRunSyncBusy,
  type AgentRunSyncPayload,
} from '@tabtin/agent-wire'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { createLogger } from '@/utils/logger'
import {
  doesSessionRunIdentityMatch,
  getEffectiveSessionRunStatus,
  isChatSessionRunState,
  reduceSessionRunProjection,
  type SessionRunProjection,
  type SessionRunProjectionAction,
} from './sessionRunProjectionReducer'
import { bindActiveRun } from './activeRunBinding'

export type {
  SessionRunProjection,
  SessionRunProjectionAction,
  SessionRunProjectionSource,
} from './sessionRunProjectionReducer'
export {
  doesSessionRunIdentityMatch,
  getEffectiveSessionRunStatus,
  isActiveRunStatus,
  isChatSessionRunState,
  isTerminalRunStatus,
  reduceSessionRunProjection,
  selectNewerSessionRunState,
  shouldAcceptSessionRunState,
} from './sessionRunProjectionReducer'

const log = createLogger('SessionRunProjection')

/** ：投影 busy→idle 钩子（busy-retain 释放观察意图）。 */
type ProjectionIdleListener = (sessionId: string) => void
const idleListeners = new Set<ProjectionIdleListener>()

/** 登记「某 session 投影变为 idle」回调；返回取消函数。 */
export function onSessionRunProjectionIdle(listener: ProjectionIdleListener): () => void {
  idleListeners.add(listener)
  return () => {
    idleListeners.delete(listener)
  }
}

/** Test-only：验证 HMR/test reset 没有累积 idle listener。 */
export function __getProjectionIdleListenerCountForTest(): number {
  return idleListeners.size
}

function notifyProjectionIdle(sessionId: string): void {
  for (const listener of idleListeners) {
    try {
      listener(sessionId)
    } catch (err) {
      log.warn('projection idle listener failed', {
        sessionId: sessionId.slice(0, 8),
        err,
      })
    }
  }
}

function applyProjectionAction(
  sessionId: string,
  action: SessionRunProjectionAction,
): boolean {
  if (!sessionId) return false
  const previous = useChatRuntimeStore.getState().runProjectionBySessionId?.[sessionId]
  const next = reduceSessionRunProjection(previous, action)
  if (next === previous) return false

  useChatRuntimeStore.setState((state) => {
    const map = state.runProjectionBySessionId ?? {}
    if (!next) {
      if (!map[sessionId]) return state
      const updated = { ...map }
      delete updated[sessionId]
      return { runProjectionBySessionId: updated }
    }
    return {
      runProjectionBySessionId: {
        ...map,
        [sessionId]: next,
      },
    }
  })

  if (previous?.busy && !next?.busy) {
    notifyProjectionIdle(sessionId)
  }
  return true
}

function hasRunStateField(session: ChatSession): boolean {
  return Object.prototype.hasOwnProperty.call(session, 'run_state')
}

/**
 * HTTP 会话快照入口。
 *
 * 缺键代表旧后端，不改当前投影；显式 null 只记录“新后端但无历史 run”，不能
 * 覆盖已经从实时事件收到的非空事实。
 */
export function applySessionRunStateSnapshot(session: ChatSession): boolean {
  if (!hasRunStateField(session)) return false
  const runState = session.run_state ?? null
  if (runState !== null && !isChatSessionRunState(runState)) {
    log.warn('ignored invalid run_state snapshot', {
      sessionId: session.id.slice(0, 8),
    })
    return false
  }
  return applyProjectionAction(session.id, {
    type: 'server-snapshot',
    runState,
    now: Date.now(),
  })
}

/** `chat.session.run_state.updated` 的唯一写入口。 */
export function applySessionRunStateEvent(
  sessionId: string,
  runState: unknown,
): boolean {
  if (!isChatSessionRunState(runState)) {
    log.warn('ignored invalid run_state event', {
      sessionId: sessionId.slice(0, 8),
    })
    return false
  }
  const accepted = applyProjectionAction(sessionId, {
    type: 'server-event',
    runState,
    now: Date.now(),
  })
  if (accepted) {
    log.info('applied run_state event', {
      sessionId: sessionId.slice(0, 8),
      runId: runState.run_id.slice(0, 8),
      sequence: runState.sequence,
      revision: runState.revision,
      status: runState.status,
    })
  } else {
    log.debug('ignored duplicate or stale run_state event', {
      sessionId: sessionId.slice(0, 8),
      runId: runState.run_id.slice(0, 8),
      sequence: runState.sequence,
      revision: runState.revision,
      status: runState.status,
    })
  }
  return accepted
}

// ── 写入方 1：host run_sync（ 唯一本地 busy 权威镜像）────────

/**
 * 镜像 `agent.stream.run_sync`。按 seq 单调；是本地 Electron host 会话
 * busy 的唯一写入口。lifecycle / terminal / 乐观发送 / self-heal 不得再写 busy。
 */
export function applyRuntimeRunSync(
  sessionId: string,
  payload: AgentRunSyncPayload | unknown,
): boolean {
  const parsed = AgentRunSyncPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    log.warn('ignored invalid run_sync payload', {
      sessionId: sessionId.slice(0, 8),
      issues: parsed.error.issues.slice(0, 3),
    })
    return false
  }
  const data = parsed.data
  if (data.session_id && data.session_id !== sessionId) {
    log.warn('run_sync session_id mismatch', {
      sessionId: sessionId.slice(0, 8),
      payloadSession: data.session_id.slice(0, 8),
    })
    return false
  }
  const busy = isAgentRunSyncBusy(data.status)
  const accepted = applyProjectionAction(sessionId, {
    type: 'runtime-sync',
    runId: data.run_id,
    status: data.status,
    seq: data.seq,
    queuedRunIds: data.queued_run_ids,
    busy,
    now: Date.now(),
  })
  if (accepted) {
    // ：busy 投影与 ActiveRunBinding 同源写 runId（不写 message_id）。
    if (data.run_id && (data.status === 'running' || data.status === 'queued')) {
      bindActiveRun(sessionId, { runId: data.run_id })
    }
    log.info('applied run_sync', {
      sessionId: sessionId.slice(0, 8),
      runId: data.run_id?.slice(0, 8) ?? null,
      status: data.status,
      seq: data.seq,
      busy,
      queued: data.queued_run_ids.length,
    })
  }
  return accepted
}

export interface LocalRunIdentity {
  runId?: string | null
  dispatchToken?: string | null
}

/**
 * 判断一条带身份的异步回调是否仍属于当前运行。
 *
 * lifecycle 终态与 runtime 对账除了改投影，还会清理步骤、计时和流状态；因此必须在
 * 这些副作用发生前拒绝旧 run 的迟到回调，而不能只依赖 reducer 拒绝投影写入。
 */
export function isSessionRunIdentityCurrent(
  sessionId: string,
  identity: LocalRunIdentity,
): boolean {
  const projection = getSessionRunProjection(sessionId)
  if (!projection) return true
  return doesSessionRunIdentityMatch(
    projection,
    identity.runId ?? null,
    identity.dispatchToken ?? null,
  )
}

// ── 写入方 2：本机 get-state 丢包兜底（runtime-mirror-override）────

/**
 * 仅本机托管 session 的丢包兜底：纠偏 `runtimeBusy`。
 * 不占用 host `run_sync.seq`。远控 / 旁观禁止调用（见 sessionRunReconcile）。
 */
export function applyRunReconcile(
  sessionId: string,
  authoritative: { busy: boolean; queuedRunIds: string[] },
  identity: LocalRunIdentity = {},
): void {
  const projection = getSessionRunProjection(sessionId)
  applyProjectionAction(sessionId, {
    type: 'runtime-mirror-override',
    runId: identity.runId !== undefined
      ? identity.runId ?? null
      : projection?.localRunId ?? null,
    queuedRunIds: authoritative.queuedRunIds,
    busy: authoritative.busy,
    now: Date.now(),
  })
}

// ── 读路径 ─────────────────────────────────────────────────────────

/** 命令式读：这条会话当前是否在跑 / 排队。 */
export function isSessionBusy(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  return !!useChatRuntimeStore.getState().runProjectionBySessionId?.[sessionId]?.busy
}

/** React hook：订阅完整投影，供状态图标同时读取权威状态和本地 overlay。 */
export function useSessionRunProjection(
  sessionId: string | null | undefined,
): SessionRunProjection | undefined {
  return useChatRuntimeStore((state) => (
    sessionId ? state.runProjectionBySessionId?.[sessionId] : undefined
  ))
}

/** React hook：兼容只关心 busy 的既有消费方。 */
export function useSessionBusy(sessionId: string | null | undefined): boolean {
  return useChatRuntimeStore((state) => (
    sessionId ? !!state.runProjectionBySessionId?.[sessionId]?.busy : false
  ))
}

/** 读完整投影（对账新鲜度 / 排队 UI 用）。 */
export function getSessionRunProjection(sessionId: string): SessionRunProjection | undefined {
  return useChatRuntimeStore.getState().runProjectionBySessionId?.[sessionId]
}

/** 当前所有 busy（在跑 / 排队）会话 id。 */
export function getBusySessionIds(): string[] {
  const map = useChatRuntimeStore.getState().runProjectionBySessionId ?? {}
  return Object.keys(map).filter((sessionId) => !!map[sessionId]?.busy)
}

/**
 * Gateway 断连后可标 suspended 的会话。
 * 本机 host 仍在推 `run_sync` busy 时，观察通道断开不等于任务挂起。
 */
export function getGatewayDisconnectSuspendSessionIds(): string[] {
  const map = useChatRuntimeStore.getState().runProjectionBySessionId ?? {}
  return Object.keys(map).filter((sessionId) => {
    const projection = map[sessionId]
    return !!projection?.busy && projection.runtimeBusy !== true
  })
}

/** 当前合并后的运行状态；null 表示走旧后端兼容展示。 */
export function getSessionEffectiveRunStatus(sessionId: string) {
  return getEffectiveSessionRunStatus(getSessionRunProjection(sessionId))
}
