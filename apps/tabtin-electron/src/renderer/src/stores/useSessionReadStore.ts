/** @store-category prefs */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'
import { registerResetAction } from './sessionResetRegistry'

const MAX_ENTRIES = 500
const MAX_ACCOUNT_SNAPSHOTS = 10

interface AccountReadSnapshot {
  lastViewedAt: Record<string, string>
  updatedAt: string
}

interface AccountReadSnapshotCache {
  version: 1
  accounts: Record<string, AccountReadSnapshot>
}

interface SessionReadState {
  lastViewedAt: Record<string, string>
  markViewed: (sessionId: string) => void
  markViewedAtIfAbsent: (sessionId: string, viewedAt: string | null | undefined) => void
  isUnread: (sessionId: string, lastMessageAt: string | null | undefined) => boolean
  clearSession: (sessionId: string) => void
  /** 登出前保存当前账号读态；登录时仅由同一账号恢复。 */
  preserveForAccount: (userId: string) => void
  restoreForAccount: (userId: string) => void
  reset: () => void
}

type SessionReadPersistState = Pick<SessionReadState, 'lastViewedAt'>

function normalizeLastViewedAt(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}

  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    .sort((a, b) => a[1].localeCompare(b[1]))

  const capped = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries
  return Object.fromEntries(capped)
}

function normalizeSessionReadPersistState(
  persistedState: unknown,
): SessionReadPersistState {
  const raw = (persistedState ?? {}) as { lastViewedAt?: unknown }
  return {
    lastViewedAt: normalizeLastViewedAt(raw.lastViewedAt),
  }
}

function readAccountSnapshots(): AccountReadSnapshotCache {
  try {
    const raw = localStorage.getItem(PERSIST_KEYS.sessionReadAccounts)
    if (!raw) return { version: 1, accounts: {} }
    const parsed = JSON.parse(raw) as Partial<AccountReadSnapshotCache>
    if (parsed.version !== 1 || !parsed.accounts || typeof parsed.accounts !== 'object') {
      return { version: 1, accounts: {} }
    }

    const accounts = Object.fromEntries(
      Object.entries(parsed.accounts)
        .filter(([userId, snapshot]) =>
          userId.trim() !== ''
          && snapshot
          && typeof snapshot === 'object'
          && typeof (snapshot as AccountReadSnapshot).updatedAt === 'string',
        )
        .map(([userId, snapshot]) => [userId, {
          lastViewedAt: normalizeLastViewedAt((snapshot as AccountReadSnapshot).lastViewedAt),
          updatedAt: (snapshot as AccountReadSnapshot).updatedAt,
        }]),
    )
    return { version: 1, accounts }
  } catch {
    return { version: 1, accounts: {} }
  }
}

function writeAccountSnapshots(cache: AccountReadSnapshotCache): void {
  try {
    localStorage.setItem(PERSIST_KEYS.sessionReadAccounts, JSON.stringify(cache))
  } catch {
    // 存储不可用时保留当前会话内读态；不阻断登出流程。
  }
}

function mergeLastViewedAt(
  existing: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const merged = { ...normalizeLastViewedAt(existing) }
  for (const [sessionId, viewedAt] of Object.entries(normalizeLastViewedAt(incoming))) {
    if (!merged[sessionId] || viewedAt > merged[sessionId]) merged[sessionId] = viewedAt
  }
  return normalizeLastViewedAt(merged)
}

export const useSessionReadStore = create<SessionReadState>()(
  persist<SessionReadState, [], [], SessionReadPersistState>(
    (set, get) => ({
      lastViewedAt: {},

      markViewed: (sessionId) => {
        const now = new Date().toISOString()
        set((state) => {
          const prev = state.lastViewedAt[sessionId]
          const ts = prev && prev > now ? prev : now
          const next = { ...state.lastViewedAt, [sessionId]: ts }
          // LRU 淘汰：超过上限时删除最旧条目
          const keys = Object.keys(next)
          if (keys.length > MAX_ENTRIES) {
            const sorted = keys.sort((a, b) =>
              (next[a] || '').localeCompare(next[b] || ''),
            )
            const toRemove = sorted.slice(0, keys.length - MAX_ENTRIES)
            for (const k of toRemove) delete next[k]
          }
          return { lastViewedAt: next }
        })
        // ：会话读态边界统一触发 Agent 终态铃铛 acknowledge（侧栏/搜索/深链/OS 导航最终都进这里）
        void import('@/services/agentSessionNotificationAck').then(({ acknowledgeAgentSessionNotifications }) => {
          acknowledgeAgentSessionNotifications(sessionId)
        })
        void import('@/services/sessionReadReceipt').then(({ acknowledgeSessionRead }) => {
          acknowledgeSessionRead(sessionId)
        })
      },

      markViewedAtIfAbsent: (sessionId, viewedAt) => {
        if (!viewedAt) return
        set((state) => {
          if (state.lastViewedAt[sessionId]) return state
          return {
            lastViewedAt: normalizeLastViewedAt({
              ...state.lastViewedAt,
              [sessionId]: viewedAt,
            }),
          }
        })
      },

      isUnread: (sessionId, lastMessageAt) => {
        if (!lastMessageAt) return false
        const stored = get().lastViewedAt[sessionId]
        if (!stored) return true
        return new Date(lastMessageAt) > new Date(stored)
      },

      clearSession: (sessionId) => {
        set((state) => {
          const next = { ...state.lastViewedAt }
          delete next[sessionId]
          return { lastViewedAt: next }
        })
      },

      preserveForAccount: (userId) => {
        const normalizedUserId = userId.trim()
        if (!normalizedUserId) return

        const cache = readAccountSnapshots()
        cache.accounts[normalizedUserId] = {
          lastViewedAt: mergeLastViewedAt(
            cache.accounts[normalizedUserId]?.lastViewedAt ?? {},
            get().lastViewedAt,
          ),
          updatedAt: new Date().toISOString(),
        }
        const retained = Object.entries(cache.accounts)
          .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, MAX_ACCOUNT_SNAPSHOTS)
        writeAccountSnapshots({ version: 1, accounts: Object.fromEntries(retained) })
      },

      restoreForAccount: (userId) => {
        const snapshot = readAccountSnapshots().accounts[userId.trim()]
        set((state) => ({
          // 普通重启 / 版本升级时，当前账号尚未被 reset 的读态可能比登出快照更新。
          // 登出再登录时 state 已清空，仍只会恢复匹配账号的快照。
          lastViewedAt: mergeLastViewedAt(state.lastViewedAt, snapshot?.lastViewedAt ?? {}),
        }))
      },

      reset: () => set({ lastViewedAt: {} }),
    }),
    withPersistSafety({
      name: PERSIST_KEYS.sessionRead,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['tabtin-session-read-receipts'])),
      version: 1,
      partialize: (state) => ({ lastViewedAt: state.lastViewedAt }),
      migrate: (persistedState, version) => {
        if (version < 1) {
          return normalizeSessionReadPersistState(persistedState)
        }
        return normalizeSessionReadPersistState(persistedState)
      },
    }),
  ),
)

registerResetAction('sessionReadReceipts', 'reset', () => {
  useSessionReadStore.getState().reset()
})
