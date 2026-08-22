/**
 * Terminal Context Source
 *
 * 管理终端标签的 ContextItem 数据源。
 * 终端会话是纯前端状态，通过 localStorage 持久化。
 */

import { useMemo, useCallback } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { withPersistSafety } from '@tabtin/shared'
import { contextRegistry } from '@components/context-space/registry/instance'
import type { ContextItem } from '@components/context-space/registry/types'
import i18n from '@/i18n'
import { traceTabRestore } from '@/utils/tabRestoreTrace'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { isConversationScopeKey, isDesktopScopeKey, isImConversationScopeKey } from '@/components/layout/workspaceContextState'

export type TerminalSessionSource = 'user' | 'agent'

export type TerminalSessionStatus = 'active' | 'closed'

export interface TerminalSession {
  id: string
  /**
   * 标签桶 key（grouping key）。Phase 4 起对**用户终端**等于 tabScopeKey
   * （桌面入口=desktop 共享池、对话入口=该对话组）；Agent transcript 与
   * 历史会话仍为真实 spaceId。命名沿用 `spaceId` 仅为兼容既有读取方
   * （overview / sync / handler 都把 map key 当作 `session.spaceId`）。
   */
  spaceId: string
  title: string
  createdAt: number
  source: TerminalSessionSource
  status: TerminalSessionStatus
  closedAt?: number
  cwd?: string
  /**
   * 真实执行 Space（PRD §1.5）。仅"执行 Agent 任务"上下文（对话绑定的执行 Space）
   * 的终端才有值——用于 spawn 时设置 `TABTIN_SPACE_ID` 让 shell 内 CLI 知道在哪个
   * Space 执行。桌面/本地沙箱终端无执行绑定 → undefined（不向 shell 注入 Space）。
   * 与 `spaceId`（标签桶 key）解耦：桶 key 可能是 desktop/conversation scope，
   * 而执行 Space 始终是真实 Space id。
   */
  executionSpaceId?: string
}

// 空数组的稳定引用，避免每次渲染创建新数组
const EMPTY_SESSIONS: TerminalSession[] = []

/**
 * closed 会话保留策略（PRD §5.5「已决策」）——跨 Agent 终端总览与
 * `useTerminalSessionStore` 的 persist merge 共用同一套常量，保证
 * 「7 天 TTL + 每 Space 50 条上限」对**用户终端与 Agent transcript 一致生效**。
 */
export const CLOSED_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
export const MAX_CLOSED_PER_SPACE = 50

/**
 * 对单个 Space 的会话列表施加 closed 保留策略：
 *   1. 丢弃 closed 超过 TTL 的会话（active 永远保留）。
 *   2. 剩余 closed 仍超 50 条时，按 closedAt 倒序只留最近 50 条。
 *
 * 输出顺序：active 在前、closed 在后（仅在触发上限裁剪时重排；否则保持入参顺序）。
 * 这里只负责「留哪些」，展示排序由调用方决定。
 */
export function applyClosedRetention(
  sessions: TerminalSession[],
  now: number = Date.now(),
): TerminalSession[] {
  const cleaned = sessions.filter((s) => {
    if (s.status !== 'closed') return true
    const closedAt = s.closedAt ?? s.createdAt
    return (now - closedAt) < CLOSED_SESSION_TTL_MS
  })
  const closed = cleaned.filter((s) => s.status === 'closed')
  if (closed.length <= MAX_CLOSED_PER_SPACE) return cleaned
  const active = cleaned.filter((s) => s.status !== 'closed')
  closed.sort((a, b) => (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt))
  return [...active, ...closed.slice(0, MAX_CLOSED_PER_SPACE)]
}

/**
 * 对内存态 `transcriptsById` 中某个 Space 的 transcript 施加 `applyClosedRetention`
 * （7 天 TTL + 每 Space 50 条）并**真删**淘汰项，返回新的 map（无变化时返回原引用）。
 *
 * transcriptsById 按 sessionId 扁平存储；这里先按 spaceId 收集该组 → 复用同一套
 * 保留策略算出「留哪些」→ 把不在保留集里的 transcript 从 map 删除。active 永远保留。
 */
export function pruneTranscriptsForSpace(
  transcriptsById: Record<string, TerminalSession>,
  spaceId: string,
  now: number = Date.now(),
): Record<string, TerminalSession> {
  const ofSpace = Object.values(transcriptsById).filter((t) => t.spaceId === spaceId)
  if (ofSpace.length === 0) return transcriptsById
  const retained = new Set(applyClosedRetention(ofSpace, now).map((t) => t.id))
  let changed = false
  const result: Record<string, TerminalSession> = { ...transcriptsById }
  for (const t of ofSpace) {
    if (!retained.has(t.id)) {
      delete result[t.id]
      changed = true
    }
  }
  return changed ? result : transcriptsById
}

const summarizeTerminalSessions = (sessionsBySpace: Record<string, TerminalSession[]>) => ({
  spaces: Object.entries(sessionsBySpace).map(([spaceId, sessions]) => ({
    spaceId,
    sessions: sessions.map(session => ({
      id: session.id,
      title: session.title,
      status: session.status,
      source: session.source,
      cwd: session.cwd ?? null,
      createdAt: session.createdAt,
      closedAt: session.closedAt ?? null,
    })),
  })),
})

const withSessionAliases = (
  spaceId: string,
  session: Omit<TerminalSession, 'spaceId'>,
): TerminalSession => ({
  ...session,
  spaceId,
})

const withSessionMaps = (sessionsBySpace: Record<string, TerminalSession[]>) => ({
  sessionsBySpace,
})

interface TerminalSessionState {
  sessionsBySpace: Record<string, TerminalSession[]>
  addSpaceSession: (spaceId: string, sessionId: string, title?: string, source?: TerminalSessionSource, cwd?: string, executionSpaceId?: string) => void
  removeSpaceSession: (spaceId: string, sessionId: string) => void
  markSpaceSessionClosed: (spaceId: string, sessionId: string) => void
  updateSpaceSessionCwd: (spaceId: string, sessionId: string, cwd: string) => void
  rehomeScopeSessions: (fromScopeKey: string, toScopeKey: string) => number
  getSessionsBySpace: (spaceId: string) => TerminalSession[]
  /**
   * 按 sessionId 跨所有桶定位会话（grouping key 可能是 desktop/conversation scope
   * 或真实 spaceId）。供 handler / resolveTabItem 在不知道桶 key 时定位会话所在桶。
   * sessionId 全局唯一，扫描有界（closed 保留策略限制每桶上限），非热路径。
   */
  getSessionEntry: (sessionId: string) => { key: string; session: TerminalSession } | null
}

interface AgentTerminalTranscriptState {
  transcriptsById: Record<string, TerminalSession>
  upsertTranscript: (spaceId: string, sessionId: string, title?: string, cwd?: string) => void
  markTranscriptClosed: (spaceId: string, sessionId: string) => void
  removeTranscript: (sessionId: string) => void
}

export const useTerminalSessionStore = create<TerminalSessionState>()(
  persist(
    (set, get) => ({
      ...withSessionMaps({}),

      addSpaceSession: (spaceId, sessionId, title, source = 'user', cwd, executionSpaceId) => {
        set((state) => {
          const existing = state.sessionsBySpace[spaceId] ?? EMPTY_SESSIONS
          if (existing.some((session) => session.id === sessionId)) {
            return state
          }
          const newSession = withSessionAliases(spaceId, {
            id: sessionId,
            title: title || i18n.t('label.terminal', { ns: 'context' }),
            createdAt: Date.now(),
            source,
            status: 'active',
            cwd,
            executionSpaceId,
          })
          traceTabRestore('terminalSessions:add', { spaceId, sessionId, title: newSession.title, source, cwd: cwd ?? null, executionSpaceId: executionSpaceId ?? null })
          return withSessionMaps({
            ...state.sessionsBySpace,
            [spaceId]: [...existing, newSession],
          })
        })
      },

      removeSpaceSession: (spaceId, sessionId) => {
        set((state) => {
          const existing = state.sessionsBySpace[spaceId] ?? EMPTY_SESSIONS
          const next = existing.filter((session) => session.id !== sessionId)
          if (next.length === existing.length) {
            return state
          }
          return withSessionMaps({
            ...state.sessionsBySpace,
            [spaceId]: next,
          })
        })
      },

      markSpaceSessionClosed: (spaceId, sessionId) => {
        set((state) => {
          const existing = state.sessionsBySpace[spaceId] ?? EMPTY_SESSIONS
          const index = existing.findIndex((session) => session.id === sessionId)
          if (index === -1 || existing[index].status === 'closed') return state
          const next = [...existing]
          next[index] = withSessionAliases(spaceId, {
            ...next[index],
            status: 'closed',
            closedAt: Date.now(),
          })
          traceTabRestore('terminalSessions:markClosed', { spaceId, sessionId })
          return withSessionMaps({
            ...state.sessionsBySpace,
            [spaceId]: next,
          })
        })
      },

      updateSpaceSessionCwd: (spaceId, sessionId, cwd) => {
        set((state) => {
          const existing = state.sessionsBySpace[spaceId] ?? EMPTY_SESSIONS
          const index = existing.findIndex((session) => session.id === sessionId)
          if (index === -1 || existing[index].cwd === cwd) return state
          const next = [...existing]
          next[index] = withSessionAliases(spaceId, { ...next[index], cwd })
          return withSessionMaps({
            ...state.sessionsBySpace,
            [spaceId]: next,
          })
        })
      },

      rehomeScopeSessions: (fromScopeKey, toScopeKey) => {
        if (!fromScopeKey || !toScopeKey || fromScopeKey === toScopeKey) return 0
        const source = get().sessionsBySpace[fromScopeKey]
        if (!source?.length) return 0
        let moved = 0
        set((state) => {
          const target = state.sessionsBySpace[toScopeKey] ?? EMPTY_SESSIONS
          const targetIds = new Set(target.map((session) => session.id))
          const additions = source
            .filter((session) => !targetIds.has(session.id))
            .map((session) => ({ ...session, spaceId: toScopeKey }))
          moved = additions.length
          const next = { ...state.sessionsBySpace, [toScopeKey]: [...target, ...additions] }
          delete next[fromScopeKey]
          return withSessionMaps(next)
        })
        return moved
      },

      getSessionsBySpace: (spaceId) => {
        return get().sessionsBySpace[spaceId] ?? EMPTY_SESSIONS
      },

      getSessionEntry: (sessionId) => {
        const bySpace = get().sessionsBySpace
        for (const [key, sessions] of Object.entries(bySpace)) {
          const session = sessions.find((s) => s.id === sessionId)
          if (session) return { key, session }
        }
        return null
      },
    }),
    withPersistSafety({
      name: 'terminal-sessions',
      storage: createJSONStorage(() => localStorage),
      merge: (_persisted, current) => {
        if (!_persisted || typeof _persisted !== 'object') return current
        const persisted = _persisted as {
          sessionsBySpace?: Record<string, unknown[]>
          sessions?: Record<string, unknown[]>
        }
        const raw = persisted.sessionsBySpace ?? persisted.sessions
        if (!raw || typeof raw !== 'object') return current
        const now = Date.now()
        const migrated: Record<string, TerminalSession[]> = {}
        for (const [key, arr] of Object.entries(raw)) {
          if (!Array.isArray(arr)) continue
          const sessions = arr.map((item: unknown) => {
            const record = item as Record<string, unknown>
            const sid = String(record.id ?? '')
            const spaceId = String(
              (record as { spaceId?: string }).spaceId
                ?? (record as { projectId?: string }).projectId
                ?? key,
            )
            return withSessionAliases(spaceId, {
              id: sid,
              title: String(record.title ?? ''),
              createdAt: Number(record.createdAt ?? 0),
              source: (record.source === 'agent' ? 'agent' : sid.startsWith('agent-') ? 'agent' : 'user') as TerminalSessionSource,
              status: (record.status === 'closed' ? 'closed' : 'active') as TerminalSessionStatus,
              closedAt: record.status === 'closed' ? Number(record.closedAt ?? record.createdAt ?? 0) : undefined,
              cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
              // Phase 4：执行 Space 绑定。历史会话无此字段 → undefined（reopen 时
              // spawn 不注入 Space，与升级前行为一致；历史桶迁移到 scope 口径属 4b）。
              executionSpaceId: typeof (record as { executionSpaceId?: string }).executionSpaceId === 'string'
                ? (record as { executionSpaceId?: string }).executionSpaceId
                : undefined,
            })
          })
          // ER-2: 丢弃超 TTL 的 closed + 裁剪到每 Space 上限（与跨 Agent 总览共用 applyClosedRetention）
          migrated[key] = applyClosedRetention(sessions, now)
        }
        traceTabRestore('terminalSessions:merge', summarizeTerminalSessions(migrated))
        return {
          ...current,
          ...withSessionMaps(migrated),
        }
      },
    }),
  ),
)

/**
 * Agent 命令 transcript 的隐藏索引。
 *
 * 这里不进入 `sessionsBySpace`，因此不会被 `useTerminalContextSource` 暴露成
 * Space 标签。用户点击工具卡片里的打开按钮时，再把对应 session materialize
 * 到 `useTerminalSessionStore`。
 */
export const useAgentTerminalTranscriptStore = create<AgentTerminalTranscriptState>()(
  (set) => ({
    transcriptsById: {},

    upsertTranscript: (spaceId, sessionId, title, cwd) => {
      set((state) => {
        const existing = state.transcriptsById[sessionId]
        const next = withSessionAliases(spaceId, {
          id: sessionId,
          title: title || existing?.title || i18n.t('label.agentTerminal', { ns: 'context' }),
          createdAt: existing?.createdAt ?? Date.now(),
          source: 'agent',
          status: existing?.status ?? 'active',
          closedAt: existing?.closedAt,
          cwd: cwd || existing?.cwd,
        })
        return {
          transcriptsById: {
            ...state.transcriptsById,
            [sessionId]: next,
          },
        }
      })
    },

    markTranscriptClosed: (spaceId, sessionId) => {
      set((state) => {
        const existing = state.transcriptsById[sessionId]
        if (!existing || existing.status === 'closed') return state
        const next = {
          ...state.transcriptsById,
          [sessionId]: withSessionAliases(spaceId, {
            ...existing,
            status: 'closed',
            closedAt: Date.now(),
          }),
        }
        // B5：closed 后立刻对该 Space 的 transcript 施加同套保留策略（7天/50条）真删，
        // 堵住内存态 transcriptsById 单调增长（removeTranscript 无生产调用方）。
        return { transcriptsById: pruneTranscriptsForSpace(next, spaceId) }
      })
    },

    removeTranscript: (sessionId) => {
      set((state) => {
        if (!(sessionId in state.transcriptsById)) return state
        const next = { ...state.transcriptsById }
        delete next[sessionId]
        return { transcriptsById: next }
      })
    },
  }),
)

/** 标签桶 key（conversation:/desktop:），不是真实 Space id。 */
export function isTerminalTabScopeKey(value: string | null | undefined): boolean {
  return isConversationScopeKey(value) || isDesktopScopeKey(value) || isImConversationScopeKey(value)
}

/**
 * 解析 Agent 终端卡片「查看终端」应切换到的真实 execution Space。
 * `TerminalSession.spaceId` 可能是 scope 桶 key，真实 Space 在 executionSpaceId。
 */
export function resolveTerminalSessionSpaceId(options: {
  sessionFromStore?: Pick<TerminalSession, 'spaceId' | 'executionSpaceId'> | null
  hiddenTranscriptSpaceId?: string | null
  spaceIdProp?: string | null
  sessionId?: string | null
}): string | null {
  const { sessionFromStore, hiddenTranscriptSpaceId, spaceIdProp, sessionId } = options

  if (sessionFromStore?.executionSpaceId) {
    return sessionFromStore.executionSpaceId
  }

  const storeSpaceId = sessionFromStore?.spaceId
  if (storeSpaceId && !isTerminalTabScopeKey(storeSpaceId)) {
    return storeSpaceId
  }

  if (hiddenTranscriptSpaceId) return hiddenTranscriptSpaceId
  if (spaceIdProp) return spaceIdProp
  return deriveAgentTerminalSpaceId(sessionId)
}

export function deriveAgentTerminalSpaceId(sessionId: string | null | undefined): string | null {
  if (!sessionId?.startsWith('agent-')) return null
  const rest = sessionId.slice('agent-'.length)
  const match = rest.match(/^(.+)-\d{10,17}(?:-[a-z0-9]+)?$/i)
  return match?.[1] || null
}

export interface TerminalContextSourceOptions {
  spaceId?: string
  /**
   * 标签组 scope（Phase 2 引入）。Phase 4 起用户终端按此 key 编组（桌面入口=desktop
   * 共享池、对话入口=该对话组），不再强制按 space.id —— 切执行 Space 时桌面终端池保持稳定。
   * 未传时退化到 spaceId（向后兼容）。
   */
  tabScopeKey?: string
}

export interface TerminalContextSourceResult {
  sessions: TerminalSession[]
  items: ContextItem[]
  createSession: (title?: string, source?: TerminalSessionSource) => { sessionId: string; tabKey: string }
  removeSession: (sessionId: string) => void
}

export interface CreateTerminalSessionInScopeOptions {
  spaceId: string
  storageKey: string
  title?: string
  source?: TerminalSessionSource
  /** 可选起始 cwd；未传时按 scope 规则（conversation → working_dir，desktop → 主进程兜底主目录） */
  cwd?: string
}

export interface OpenTerminalTabInScopeOptions {
  title?: string
}

export function openTerminalTabInScope(
  storageKey: string,
  sessionId: string,
  options: OpenTerminalTabInScopeOptions = {},
): { tabKey: string } {
  const tabKey = contextRegistry.buildTabKey('terminal', sessionId)
  const session = useTerminalSessionStore.getState().getSessionEntry(sessionId)?.session
  const title = session?.title ?? options.title ?? i18n.t('label.terminal', { ns: 'context' })
  useSpaceContextTabsStore.getState().openResourceTab(storageKey, {
    type: 'terminal',
    id: sessionId,
    title,
    meta: {
      createdAt: session?.createdAt,
      source: session?.source ?? 'user',
      status: session?.status ?? 'active',
      cwd: session?.cwd,
    },
  })
  return { tabKey }
}

export function createTerminalSessionInScope({
  spaceId,
  storageKey,
  title,
  source = 'user',
  cwd: cwdOverride,
}: CreateTerminalSessionInScopeOptions): { sessionId: string; tabKey: string } {
  const sessionId = `terminal-${spaceId || 'desktop'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  // Phase 4（PRD §1.5）：终端是全局桌面资源。
  //   - 桌面入口（desktop scope）：新终端落在桌面/本地沙箱——cwd 留空，由主进程
  //     兜底到用户主目录（见 terminal/ipc.ts 的 pty:spawn）；不绑定执行 Space。
  //   - 对话入口（conversation scope）：对话绑定了固定执行 Space，属于"执行 Agent
  //     任务"上下文 → cwd 默认切到该 Space 的 working_dir，并记录 executionSpaceId。
  const isConversationScope = storageKey.startsWith('conversation:')

  const state = useSpaceStore.getState()
  const sp = state.spaces.find(s => s.id === spaceId)
  const agentId = sp?.execution_agent_id ?? sp?.agent_id ?? null
  const agent = agentId
    ? (state.agentCache[agentId] ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null))
    : null

  let startCwd: string | undefined
  let executionSpaceId: string | undefined
  if (isConversationScope) {
    // PRD §11 遥控器模式：working_dir 可能在远程设备，执行终端起在 control_device
    // 上才有意义。桌面沙箱终端在本机主目录、无此问题 → 仅执行上下文校验。
    const currentDeviceId = useDeviceStore.getState().currentDevice?.id ?? null
    const controlDeviceId =
      sp?.control_device_id
      ?? sp?.bound_device_id
      ?? agent?.control_device_id
      ?? agent?.bound_device_id
      ?? null
    const isControl = !!controlDeviceId && controlDeviceId === currentDeviceId
    if (sp?.type === 'workspace' && !isControl) {
      // 创建被拒。沿用现有签名抛异常，上游 toast 提示用户切到对应设备。
      throw new Error('TERMINAL_NOT_ON_CONTROL_DEVICE')
    }
    startCwd = sp?.working_dir || agent?.working_dir || undefined
    executionSpaceId = spaceId || undefined
  }

  if (cwdOverride) {
    startCwd = cwdOverride
  }

  const resolvedTitle = title || i18n.t('label.terminal', { ns: 'context' })
  useTerminalSessionStore.getState().addSpaceSession(
    storageKey,
    sessionId,
    resolvedTitle,
    source,
    startCwd,
    executionSpaceId,
  )
  const { tabKey } = openTerminalTabInScope(storageKey, sessionId, { title: resolvedTitle })
  return { sessionId, tabKey }
}

/**
 * 终止 PTY 进程，兼容旧的 `sessionId-${key}` 子会话格式。
 *
 * 返回值（B3 假停止防护）：`true` 表示**确实在本机 kill 到了**至少一个会话
 * （主进程 `pty:kill` 对存在的本机会话返回 `success:true`）；`false` 表示本机
 * 没有这个会话（如在其他设备 / 已退出），kill 是 no-op。调用方据此决定是报
 * 「已停止」还是「请到对应设备停止」，避免静默 no-op 却弹成功 toast 的「假停止」。
 */
export function killPtySession(sessionId: string): Promise<boolean> {
  const tabtin = window.tabtin
  const kill = tabtin?.pty?.kill
  if (!kill) return Promise.resolve(false)

  const killOne = (id: string): Promise<boolean> => {
    try {
      return Promise.resolve(kill(id))
        .then((r) => r?.success === true)
        .catch(() => false)
    } catch {
      return Promise.resolve(false)
    }
  }

  if (tabtin.pty?.list) {
    return tabtin.pty.list()
      .then((result: { sessions?: string[] }) => {
        const sessions = Array.isArray(result?.sessions) ? result.sessions : []
        const targets = new Set<string>([sessionId])
        sessions.forEach((id: string) => {
          if (id === sessionId || id.startsWith(`${sessionId}-`)) targets.add(id)
        })
        return Promise.all([...targets].map((id) => killOne(id)))
          .then((results) => results.some(Boolean))
      })
      .catch(() => killOne(sessionId))
  }

  return killOne(sessionId)
}

export function useTerminalContextSource({
  spaceId: spaceIdProp,
  tabScopeKey,
}: TerminalContextSourceOptions): TerminalContextSourceResult {
  const spaceId = spaceIdProp ?? ''
  // Phase 4：用户终端的标签桶 key = tabScopeKey（与 Phase 2 标签 scope 对齐），
  // 退化到 spaceId 保持向后兼容。
  const storageKey = tabScopeKey || spaceId
  const sessions = useTerminalSessionStore((state) => state.sessionsBySpace[storageKey] ?? EMPTY_SESSIONS)
  const removeSpaceSession = useTerminalSessionStore((state) => state.removeSpaceSession)

  const items = useMemo<ContextItem[]>(() => {
    const sorted = [...sessions].sort((a, b) => {
      if (a.status === 'closed' && b.status !== 'closed') return 1
      if (a.status !== 'closed' && b.status === 'closed') return -1
      return a.createdAt - b.createdAt
    })
    return sorted.map((session) => ({
      type: 'terminal' as const,
      id: session.id,
      tabKey: contextRegistry.buildTabKey('terminal', session.id),
      title: session.title,
      meta: {
        createdAt: session.createdAt,
        source: session.source,
        status: session.status,
      },
    }))
  }, [sessions])

  const createSession = useCallback((title?: string, source: TerminalSessionSource = 'user') => {
    return createTerminalSessionInScope({
      spaceId,
      storageKey,
      title,
      source,
    })
  }, [spaceId, storageKey])

  const removeSession = useCallback((sessionId: string) => {
    removeSpaceSession(storageKey, sessionId)
  }, [removeSpaceSession, storageKey])

  return useMemo(() => ({
    sessions,
    items,
    createSession,
    removeSession,
  }), [sessions, items, createSession, removeSession])
}
