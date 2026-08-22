/**
 * Session Freshness Service
 *
 * 消息对账**唯一入口**：`reconcileSessionMessages`。
 * - 拉取：始终最新一页（limit 100）
 * - 合并：始终本地为底的 identity upsert（`mergeMessagesFromServer`）
 * - `reason` 仅日志 / telemetry，不参与分支
 *
 * 禁止：forceFullLatest、以服务端页为底的整包替换、按 reason 分套 merge。
 *
 * 回退截断是结构性写（checkpoint / replaceFromRollback），不是本入口的特例。
 */

import {
  useSessionFreshnessStore,
  type SessionFreshnessError,
} from '@/stores/useSessionFreshnessStore'
import { getChatClientInstance } from './chatClientSingleton'
import { getSessionMessagesFacade } from './agentService/sessionMessages'
import { readSessionMessages, reconcileServerMessages } from './agentService/messageWriteGate'
import { ChatAPIError } from '@tabtin/chat-client'
import { reconcileHitlPanelsFromMessages } from '@/stores/chat/hitl/handlers/hitlMessageReconcile'
import { createLogger } from '@/utils/logger'

const log = createLogger('SessionFreshness')

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 9_000]
const NO_RETRY_DELAYS_MS: readonly number[] = []
/** 拉「最新页」用的 before 游标（与 chat API 约定一致）。 */
const LATEST_PAGE_BEFORE_CURSOR = '00000000-0000-0000-0000-000000000000'
const RECONCILE_PAGE_SIZE = 100

let _retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS

export interface SessionFreshSyncResult {
  newCount: number
  changed: boolean
  /**
   * 写回被消息写入权威丢弃（：fetch 期间发生回退截断等结构性变更，或回退管线
   * 进行中）。丢弃 = 本次 sync 没有对齐成功，freshness 标 stale 待下次重来。
   */
  dropped?: boolean
}

export interface ReconcileSessionMessagesOptions {
  /** 跳过 isFresh 检查，强制发起一次同步 */
  force?: boolean
  /**
   * 是否启用指数退避重试。reconnect handler 默认开启；
   * 用户主动路径（审批 watchdog 等）建议关闭。默认 true。
   */
  retry?: boolean
  /** 自定义 fresh TTL（ms），见 `useSessionFreshnessStore.isFresh` */
  ttlMs?: number
  /** 失败时是否吞掉异常（默认 true） */
  silentOnError?: boolean
  /** 是否推进服务端同步水位。默认 true。 */
  advanceWatermark?: boolean
  /**
   * 仅日志 / telemetry。禁止据此分支不同 merge 或 fetch。
   */
  reason?: string
}

/** @deprecated 使用 ReconcileSessionMessagesOptions；保留别名以免外部 import 断裂。 */
export type EnsureSessionFreshOptions = ReconcileSessionMessagesOptions

const _inFlight = new Map<string, Promise<SessionFreshSyncResult>>()

/**
 * 消息对账唯一入口。
 *
 * @returns 新增消息数等；silentOnError 失败时返回 `{ newCount: 0, changed: false }`
 */
export async function reconcileSessionMessages(
  sessionId: string,
  options: ReconcileSessionMessagesOptions = {},
): Promise<SessionFreshSyncResult> {
  if (!sessionId) return { newCount: 0, changed: false }

  const {
    force = false,
    retry = true,
    ttlMs,
    silentOnError = true,
    advanceWatermark = true,
    reason,
  } = options

  const freshnessStore = useSessionFreshnessStore.getState()

  if (!force && freshnessStore.isFresh(sessionId, ttlMs)) {
    return { newCount: 0, changed: false }
  }

  const inFlightKey = `${sessionId}:${advanceWatermark ? 'advance' : 'hold'}`
  const inFlight = _inFlight.get(inFlightKey)
  if (inFlight) return inFlight

  const client = getChatClientInstance()
  if (!client) {
    if (silentOnError) return { newCount: 0, changed: false }
    throw new Error('chat client not initialized')
  }

  freshnessStore.markSyncing(sessionId)
  if (reason) {
    log.info('reconcileSessionMessages', { session: sessionId.slice(0, 8), reason })
  }

  const promise = (async () => {
    try {
      const result = await _syncWithRetry(client, sessionId, retry, { advanceWatermark })
      reconcileHitlPanelsFromMessages(sessionId, readSessionMessages(sessionId))
      if (result.dropped) {
        useSessionFreshnessStore.getState().markStale(sessionId, {
          message: 'server merge dropped by message authority (local structural mutation in flight)',
        })
      } else {
        useSessionFreshnessStore.getState().markFresh(sessionId)
      }
      return result
    } catch (err) {
      const normalized = normalizeSyncError(err)
      useSessionFreshnessStore.getState().markStale(sessionId, normalized)
      if (silentOnError) {
        log.warn(`sync failed sid=${sessionId}`, normalized)
        return { newCount: 0, changed: false }
      }
      throw err
    } finally {
      _inFlight.delete(inFlightKey)
    }
  })()

  _inFlight.set(inFlightKey, promise)
  return promise
}

/**
 * ：流终态丢失 / ACK 早于 terminal 后的停页补齐——先本机 transcript，再 HTTP。
 * 与 selectSession 同口径；唯一入口（watchdog / reconcile / query ACK 共用）。
 */
export async function hydrateAfterLostStream(
  sessionId: string,
  options: { reason: string },
): Promise<void> {
  if (!sessionId) return
  const { reason } = options

  try {
    const { isLocalRuntimeAvailable } = await import('@/services/localAgentClient')
    if (isLocalRuntimeAvailable()) {
      const { useChatStore } = await import('@/stores/chat/useChatStore')
      const {
        hasLocalTranscript,
        readLocalTranscript,
        enrichWithServerMetadata,
      } = await import('@/services/localTranscript')
      const { resolveSessionScopeId } = await import('@tabtin/app-shell')
      const state = useChatStore.getState()
      const session = state.sessions.find((s) => s.id === sessionId)
        ?? Object.values(state.sessionsBySpaceId ?? {}).flat().find((s) => s.id === sessionId)
      const ctx = {
        organizationId: session?.organization_id ?? undefined,
        spaceId: (session ? resolveSessionScopeId(session) : undefined) ?? undefined,
      }
      if (await hasLocalTranscript(sessionId, ctx)) {
        const local = await readLocalTranscript(sessionId, ctx)
        if (local && local.length > 0) {
          const existing = state.messagesBySessionId[sessionId] ?? []
          const enriched = enrichWithServerMetadata(local, existing)
          const {
            hydrateLocalTranscriptWithContinuationSnapshot,
            listLatestSessionMessages,
          } = await import('@/stores/chat/session/localTranscriptContinuation')
          const client = getChatClientInstance()
          const hydrated = client
            ? await hydrateLocalTranscriptWithContinuationSnapshot({
              local: enriched,
              prior: existing,
              session,
              listLatest: () => listLatestSessionMessages(client, sessionId),
            })
            : { messages: enriched, usedServerSnapshot: false }
          useChatStore.getState().applyLoadedMessages(sessionId, hydrated.messages)
          log.info('hydrateAfterLostStream: applied local transcript', {
            session: sessionId.slice(0, 8),
            reason,
            count: hydrated.messages.length,
            usedServerSnapshot: hydrated.usedServerSnapshot,
          })
        }
      }
    }
  } catch (err) {
    log.warn('hydrateAfterLostStream: local transcript failed (will try server)', {
      session: sessionId.slice(0, 8),
      reason,
      err,
    })
  }

  await reconcileSessionMessages(sessionId, {
    force: true,
    retry: false,
    silentOnError: true,
    reason,
  })
}

/** 避开 send/reconcile 刚收口时的投影竞态；busy 又被新 run 点亮则跳过。 */
export const LOST_STREAM_HYDRATE_DELAY_MS = 600

/**
 * ：延迟一拍后 hydrate（watchdog idle settle / reconcile force_idle 共用）。
 * ACK 即时路径直接调 `hydrateAfterLostStream`，不走这里。
 */
export function scheduleLostStreamHydrate(sessionId: string, reason: string): void {
  if (!sessionId) return
  void (async () => {
    await new Promise((resolve) => setTimeout(resolve, LOST_STREAM_HYDRATE_DELAY_MS))
    const { isSessionBusy } = await import('@/stores/chat/execution/sessionRunProjection')
    if (isSessionBusy(sessionId)) return
    await hydrateAfterLostStream(sessionId, { reason })
  })().catch((err) => {
    log.warn('scheduleLostStreamHydrate failed (non-blocking)', {
      session: sessionId.slice(0, 8),
      reason,
      err,
    })
  })
}

/**
 * 兼容旧名：返回新增条数。内部只走 `reconcileSessionMessages`。
 */
export async function ensureSessionFresh(
  sessionId: string,
  options: ReconcileSessionMessagesOptions = {},
): Promise<number> {
  const result = await reconcileSessionMessages(sessionId, options)
  return result.newCount
}

/** @deprecated 使用 reconcileSessionMessages */
export async function ensureSessionFreshDetailed(
  sessionId: string,
  options: ReconcileSessionMessagesOptions = {},
): Promise<SessionFreshSyncResult> {
  return reconcileSessionMessages(sessionId, options)
}

/**
 * 仅维护 freshness state，不发起请求。
 * 供 `loadSessionMessages` / `selectSession` 等已有自己加载逻辑的 caller 调用。
 */
export function markSessionFresh(sessionId: string): void {
  if (!sessionId) return
  useSessionFreshnessStore.getState().markFresh(sessionId)
  reconcileHitlPanelsFromMessages(sessionId, readSessionMessages(sessionId))
}

export function markSessionStale(sessionId: string, error?: unknown): void {
  if (!sessionId) return
  useSessionFreshnessStore.getState().markStale(sessionId, error ? normalizeSyncError(error) : undefined)
}

/* ────────────────────────────────────────────────────────────── */

async function _syncWithRetry(
  client: NonNullable<ReturnType<typeof getChatClientInstance>>,
  sessionId: string,
  enableRetry: boolean,
  options: Pick<ReconcileSessionMessagesOptions, 'advanceWatermark'>,
): Promise<SessionFreshSyncResult> {
  const delays = enableRetry ? _retryDelaysMs : NO_RETRY_DELAYS_MS
  let lastErr: unknown
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await _syncSessionOnce(client, sessionId, options)
    } catch (err) {
      lastErr = err

      if (!isRetryableError(err)) {
        if (err instanceof ChatAPIError && err.statusCode === 404) {
          return { newCount: 0, changed: false }
        }
        throw err
      }

      const delay = delays[attempt]
      if (delay === undefined) break
      await sleep(delay)
    }
  }
  throw lastErr
}

/**
 * 单次同步：拉最新页 → upsert merge → 写回 store + IDB cache。
 * 默认推进 watermark：成功对齐后 freshness 可 short-circuit；
 * 旧 forceFullLatest 路径曾 hold 水位（半页校正），统一 upsert 后不再需要。
 */
async function _syncSessionOnce(
  client: NonNullable<ReturnType<typeof getChatClientInstance>>,
  sessionId: string,
  options: Pick<ReconcileSessionMessagesOptions, 'advanceWatermark'> = {},
): Promise<SessionFreshSyncResult> {
  const advanceWatermark = options.advanceWatermark !== false
  const facade = getSessionMessagesFacade(sessionId)
  const fetchEpoch = facade.captureEpoch()

  const response = await client.messages.list(sessionId, {
    limit: RECONCILE_PAGE_SIZE,
    before: LATEST_PAGE_BEFORE_CURSOR,
  })
  const fresh = response?.messages ?? []
  const syncWatermark = response.server_timestamp

  const result = reconcileServerMessages(sessionId, fetchEpoch, fresh, {
    advanceWatermark,
    syncWatermark,
  })
  return { newCount: result.newCount, changed: result.changed, dropped: result.dropped }
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false

  if (err instanceof ChatAPIError) {
    const status = err.statusCode
    if (status === 0 && err.code) return false
    if (status === 0) return true
    if (status >= 500 && status < 600) return true
    if (status === 408 || status === 429) return true
    return false
  }

  if (err.name === 'AbortError') return true
  if (err.name === 'TypeError') return true

  return false
}

function normalizeSyncError(err: unknown): SessionFreshnessError {
  if (err instanceof ChatAPIError) {
    return {
      code: err.code,
      status: err.statusCode,
      message: err.message,
    }
  }
  if (err instanceof Error) {
    return { message: err.message }
  }
  return { message: String(err) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ────────────────────────────────────────────────────────────── */
/* 测试用工具：清空 in-flight 缓存、覆盖重试延迟。仅在 vitest 环境下使用。 */
/* ────────────────────────────────────────────────────────────── */

export function _resetInFlightForTesting(): void {
  _inFlight.clear()
}

export function _setRetryDelaysForTesting(delays: readonly number[] | null): void {
  _retryDelaysMs = delays === null ? DEFAULT_RETRY_DELAYS_MS : delays
}
