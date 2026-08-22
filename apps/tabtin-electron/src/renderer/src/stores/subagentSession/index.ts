/**
 * useSubagentSessionStore — 子 Agent jsonl 三件套缓存 store（PRD §4.11）
 *
 * 从 useChatRuntimeStore 抽出来的独立 store：
 *   - `subagentSessionDataBySubId`：per-subagentRunId × per-kind（messages/snapshots/events）缓存
 *   - `loadSubagentSession(parentSessionId, subagentRunId, kind, options?)`：拉取 + 5s TTL 缓存
 *   - `clearByParentSession(parentSessionId)`：父 session 删除时清掉相关 entry（避免内存泄漏 + 隐私残留）
 *
 * **为什么独立**：subagent_session tab handler 在 context-space 模块，
 * 让 context-space 直接 import chat 模块的 useChatRuntimeStore 会形成
 * "context-space → chat" 反向依赖。把缓存抽到 stores/subagentSession 之后，
 * chat 与 context-space 都消费它，单向依赖。
 *
 * **runtime 实时进度（subagentRunsBySessionId / cancelSubagentRun /
 * reconcileSubagentRuns）仍留在 useChatRuntimeStore** —— 那部分属于 chat
 * 流式运行时域，与 jsonl 归档读取是两条独立路径。
 */

import { create } from 'zustand'
import { registerResetAction } from '../sessionResetRegistry'

export type SubagentSessionKind = 'messages' | 'snapshots' | 'events'

interface SubagentSessionEntry {
  messages?: {
    lines: unknown[]
    truncated?: boolean
    format?: 'transcript' | 'envelopes'
    loadedAt: number
  }
  snapshots?: { lines: unknown[]; truncated?: boolean; loadedAt: number }
  events?: { lines: unknown[]; truncated?: boolean; loadedAt: number }
  loading?: Partial<Record<SubagentSessionKind, boolean>>
  error?: Partial<Record<SubagentSessionKind, string>>
  /**
   * 反向索引：从子 Agent run 找父 session。`clearByParentSession` 需要它来
   * 一次清掉所有属于某父 session 的 entry，避免 N×全表扫描。
   *
   * 缺省 / 老数据 → undefined：`clearByParentSession` 不会误删（保守不动）。
   */
  parentSessionId?: string
}

interface LoadOptions {
  forceRefresh?: boolean
  organizationId?: string
  spaceId?: string
}

interface SubagentSessionState {
  subagentSessionDataBySubId: Record<string, SubagentSessionEntry>
  loadSubagentSession: (
    parentSessionId: string,
    subagentRunId: string,
    kind: SubagentSessionKind,
    options?: LoadOptions,
  ) => Promise<void>
  /** 清掉某个 run 的全部缓存（含三 kind + loading/error） */
  clearByRunId: (subagentRunId: string) => void
  /** 清掉某个 parent session 下所有子 Agent 的缓存（父 session 删除 / evict 时调） */
  clearByParentSession: (parentSessionId: string) => void
  /** 全清（logout / organization 切换） */
  clear: () => void
}

/**
 * 5 秒 TTL：让用户切 tab 来回切不打主进程，但 running 的子 Agent 仍能拿到
 * 较新数据。已完成 → 5s 内重复打开 Pane 是常见行为，TTL 命中跳过 IPC。
 */
const CACHE_TTL_MS = 5_000

export const useSubagentSessionStore = create<SubagentSessionState>((set, get) => ({
  subagentSessionDataBySubId: {},

  loadSubagentSession: async (parentSessionId, subagentRunId, kind, options) => {
    const now = Date.now()
    const existing = get().subagentSessionDataBySubId[subagentRunId]
    const cached = existing?.[kind]
    const forceRefresh = options?.forceRefresh === true

    // 缓存命中且未失败：跳过 IPC
    if (
      !forceRefresh
      && cached
      && now - cached.loadedAt < CACHE_TTL_MS
      && !existing?.error?.[kind]
    ) {
      return
    }
    // 进行中：避免并发重入
    if (existing?.loading?.[kind]) {
      return
    }

    set(state => {
      const prevEntry = state.subagentSessionDataBySubId[subagentRunId] ?? {}
      const prevError = prevEntry.error ?? {}
      const { [kind]: _droppedError, ...keepError } = prevError
      return {
        subagentSessionDataBySubId: {
          ...state.subagentSessionDataBySubId,
          [subagentRunId]: {
            ...prevEntry,
            parentSessionId,
            loading: { ...(prevEntry.loading ?? {}), [kind]: true },
            error: keepError,
          },
        },
      }
    })

    const bridge = window.tabtin?.agentEngine?.readSubagentSession
    if (!bridge) {
      set(state => {
        const prevEntry = state.subagentSessionDataBySubId[subagentRunId] ?? {}
        return {
          subagentSessionDataBySubId: {
            ...state.subagentSessionDataBySubId,
            [subagentRunId]: {
              ...prevEntry,
              parentSessionId,
              loading: { ...(prevEntry.loading ?? {}), [kind]: false },
              error: { ...(prevEntry.error ?? {}), [kind]: 'ipc_unavailable' },
            },
          },
        }
      })
      return
    }

    try {
      const result = await bridge({
        parentSessionId,
        subagentRunId,
        kind,
        organizationId: options?.organizationId,
        spaceId: options?.spaceId,
      })
      set(state => {
        const prevEntry = state.subagentSessionDataBySubId[subagentRunId] ?? {}
        if (result.ok) {
          const nextError = { ...(prevEntry.error ?? {}) }
          delete nextError[kind]
          return {
            subagentSessionDataBySubId: {
              ...state.subagentSessionDataBySubId,
              [subagentRunId]: {
                ...prevEntry,
                parentSessionId,
                [kind]: {
                  lines: result.lines,
                  truncated: result.truncated,
                  ...(kind === 'messages' && result.format ? { format: result.format } : {}),
                  loadedAt: Date.now(),
                },
                loading: { ...(prevEntry.loading ?? {}), [kind]: false },
                error: nextError,
              },
            },
          }
        }
        return {
          subagentSessionDataBySubId: {
            ...state.subagentSessionDataBySubId,
            [subagentRunId]: {
              ...prevEntry,
              parentSessionId,
              loading: { ...(prevEntry.loading ?? {}), [kind]: false },
              error: { ...(prevEntry.error ?? {}), [kind]: result.error },
            },
          },
        }
      })
    } catch (err) {
      // main 端 IPC handler 的失败现在统一走 envelope-error helper（详见
      // `apps/tabtin-electron/src/main/agent/conversation/envelope-error.ts`），错误形态是
      // `{ ok: false, error: { code, message } }`。ipc-shim 把它转成 PlatformIpcError
      // 抛出，renderer 通过 `err.code` 拿到机器可读短码（如 `parent_session_not_alive`
      // / `subagent_not_found` / `file_missing`），ErrorState 的启发式映射就靠它。
      //
      // 优先使用 `err.code`：跨 contextBridge 序列化时由 PlatformIpcError 显式
      // 用 `Object.defineProperty enumerable:true` 保留，renderer catch 实例
      // 上一定可读。code 不可用时 fallback 到 message（兼容老版本 main 端
      // 还没全规范化时的偶发场景）。
      const errCode = (err as { code?: string })?.code
      const errMessage = err instanceof Error ? err.message : String(err)
      const errorKey = errCode && errCode !== 'UNKNOWN_ERROR' && errCode !== 'IPC_REJECT'
        ? errCode
        : `ipc_failed:${errMessage}`
      set(state => {
        const prevEntry = state.subagentSessionDataBySubId[subagentRunId] ?? {}
        return {
          subagentSessionDataBySubId: {
            ...state.subagentSessionDataBySubId,
            [subagentRunId]: {
              ...prevEntry,
              parentSessionId,
              loading: { ...(prevEntry.loading ?? {}), [kind]: false },
              error: { ...(prevEntry.error ?? {}), [kind]: errorKey },
            },
          },
        }
      })
    }
  },

  clearByRunId: (subagentRunId) => {
    set(state => {
      if (!(subagentRunId in state.subagentSessionDataBySubId)) return state
      const next = { ...state.subagentSessionDataBySubId }
      delete next[subagentRunId]
      return { subagentSessionDataBySubId: next }
    })
  },

  clearByParentSession: (parentSessionId) => {
    set(state => {
      const entries = Object.entries(state.subagentSessionDataBySubId)
      const toRemove = entries.filter(([, entry]) => entry.parentSessionId === parentSessionId)
      if (toRemove.length === 0) return state
      const next = { ...state.subagentSessionDataBySubId }
      for (const [runId] of toRemove) {
        delete next[runId]
      }
      return { subagentSessionDataBySubId: next }
    })
  },

  clear: () => {
    set({ subagentSessionDataBySubId: {} })
  },
}))

// organization 切换 / logout 时清空缓存
registerResetAction('subagent-session', 'reset', () => {
  useSubagentSessionStore.getState().clear()
})
