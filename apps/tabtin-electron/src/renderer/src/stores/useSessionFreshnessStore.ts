/** @store-category session */

/**
 * Session Freshness Store
 *
 * 管理每个 chat session 的"消息缓存新鲜度"状态机，让所有同步路径
 * （reconnect handler / selectSession / loadSessionMessages / useSessionReconcile
 * 心跳兜底）共享同一份 truth：
 *
 * ```
 *   fresh ──(time elapsed | external mutation)──→ stale ──(sync ok)──→ fresh
 *                                                    │
 *                                                    └──(sync fail)──→ stale + failureCount++
 * ```
 *
 * 设计目标：
 * 1. 失败的 sync 不再被 console.warn 吞掉就完事——失败的 session 会被打上
 *    stale 标记，后续任何路径（用户切回来 / loadMessages / 心跳）都能据此
 *    识别"这份缓存不可信，绕过 IDB 走 server"。
 * 2. reconnect handler 中下游的 checkpoint 补偿、HITL 清理可以基于
 *    isFresh(sid) 跳过 stale session，避免拿过期数据继续做错决策。
 * 3. in-flight dedup：当某个 session 正在 syncing 时，并发的同步请求会复用
 *    in-flight Promise（由 `sessionFreshness.ts` service 负责），store 层只
 *    需要忠实记录状态机即可。
 *
 * 不做的事：
 * - 不持久化。这是当前会话内对"消息列表是否最新"的视图，跨刷新无意义；
 *   重启即视所有 session 为 stale，自然走第一次 load 即可。
 * - 不存消息本体。消息归 `useChatStore.messagesBySessionId` 管，本 store 只
 *   存"那份缓存可不可信"的 metadata。
 * - 不直接跑请求。具体的 sync 逻辑由 `services/sessionFreshness.ts` 承担，
 *   本 store 只暴露状态机 API。
 */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'

/** 默认 fresh TTL：30 秒内同步成功的数据视为 fresh，无需立即重拉 */
const DEFAULT_FRESH_TTL_MS = 30_000

export type SessionFreshnessStatus = 'fresh' | 'stale' | 'syncing'

export interface SessionFreshnessError {
  /** envelope `error.code` / `ChatAPIError.code` */
  code?: string
  /** HTTP status；fetch 层失败统一为 0 */
  status?: number
  /** 人类可读 message，仅用于日志/telemetry，不展示给用户 */
  message: string
}

export interface SessionFreshnessEntry {
  status: SessionFreshnessStatus
  /** 最近一次 markFresh 的时间戳（ms） */
  lastSyncedAt: number | null
  /** 最近一次发起 sync（无论成败）的时间戳（ms） */
  lastAttemptAt: number | null
  /** 连续失败次数。markFresh 时归零 */
  failureCount: number
  /** 最近一次失败的错误描述（仅用于诊断） */
  lastError?: SessionFreshnessError
}

interface SessionFreshnessStore {
  freshnessBySessionId: Record<string, SessionFreshnessEntry>

  /** 标记 session 进入 syncing 状态（fresh→syncing 或 stale→syncing） */
  markSyncing: (sessionId: string) => void
  /** 标记同步成功，归零 failureCount，清掉 lastError */
  markFresh: (sessionId: string, syncedAt?: number) => void
  /** 标记同步失败，递增 failureCount，记录 lastError */
  markStale: (sessionId: string, error?: SessionFreshnessError) => void

  getEntry: (sessionId: string) => SessionFreshnessEntry | undefined
  /**
   * 该 session 是否 fresh。
   * fresh 定义：status === 'fresh' 且 lastSyncedAt 距今 ≤ maxAgeMs。
   * 没有任何记录的 session 视为 not fresh（首次需要拉）。
   */
  isFresh: (sessionId: string, maxAgeMs?: number) => boolean
  /** 是否处于 stale 态（含未知）。已知 fresh 或正在 syncing 都不算 stale */
  isStale: (sessionId: string) => boolean
  /** 列出所有 stale session id（不含 syncing 中的） */
  getStaleSessionIds: () => string[]

  /** 删除某个 session 的记录（session 被删除时调用） */
  clearSession: (sessionId: string) => void
  /** 全部清空（登出 / teardown） */
  reset: () => void
}

export const useSessionFreshnessStore = create<SessionFreshnessStore>((set, get) => ({
  freshnessBySessionId: {},

  markSyncing: (sessionId) =>
    set((state) => {
      const prev = state.freshnessBySessionId[sessionId]
      const next: SessionFreshnessEntry = {
        status: 'syncing',
        lastSyncedAt: prev?.lastSyncedAt ?? null,
        lastAttemptAt: Date.now(),
        failureCount: prev?.failureCount ?? 0,
        lastError: prev?.lastError,
      }
      return {
        freshnessBySessionId: {
          ...state.freshnessBySessionId,
          [sessionId]: next,
        },
      }
    }),

  markFresh: (sessionId, syncedAt) =>
    set((state) => {
      const ts = syncedAt ?? Date.now()
      const next: SessionFreshnessEntry = {
        status: 'fresh',
        lastSyncedAt: ts,
        lastAttemptAt: ts,
        failureCount: 0,
        lastError: undefined,
      }
      return {
        freshnessBySessionId: {
          ...state.freshnessBySessionId,
          [sessionId]: next,
        },
      }
    }),

  markStale: (sessionId, error) =>
    set((state) => {
      const prev = state.freshnessBySessionId[sessionId]
      const next: SessionFreshnessEntry = {
        status: 'stale',
        lastSyncedAt: prev?.lastSyncedAt ?? null,
        lastAttemptAt: Date.now(),
        failureCount: (prev?.failureCount ?? 0) + 1,
        lastError: error,
      }
      return {
        freshnessBySessionId: {
          ...state.freshnessBySessionId,
          [sessionId]: next,
        },
      }
    }),

  getEntry: (sessionId) => get().freshnessBySessionId[sessionId],

  isFresh: (sessionId, maxAgeMs = DEFAULT_FRESH_TTL_MS) => {
    const entry = get().freshnessBySessionId[sessionId]
    if (!entry || entry.status !== 'fresh' || !entry.lastSyncedAt) return false
    return Date.now() - entry.lastSyncedAt <= maxAgeMs
  },

  isStale: (sessionId) => {
    const entry = get().freshnessBySessionId[sessionId]
    return entry?.status === 'stale'
  },

  getStaleSessionIds: () => {
    const map = get().freshnessBySessionId
    return Object.keys(map).filter((sid) => map[sid]?.status === 'stale')
  },

  clearSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.freshnessBySessionId)) return state
      const { [sessionId]: _omitted, ...rest } = state.freshnessBySessionId
      return { freshnessBySessionId: rest }
    }),

  reset: () => set({ freshnessBySessionId: {} }),
}))

registerResetAction('session-freshness', 'reset', () =>
  useSessionFreshnessStore.getState().reset(),
)
