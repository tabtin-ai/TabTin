/**
 * Session Pointer slice — 自包含的会话指针与列表缓存写入（ 分层重构）。
 *
 * 从 useChatStore 抽出**只读写会话指针 / 会话列表缓存**的原子 action：
 *   - 当前会话指针：per-space / per-workspace
 *   - 草稿态：draftSessionBySpaceId / draftExecutionSpaceIdByWorkspaceKey
 *   - 列表缓存字段更新：title / 任意字段 / token usage（单调合并）
 *   - getSessionById（普通会话 + Tracker Run 会话统一查找）
 *
 * 刻意不含 setSpaceSessions —— 它同时操作 Space LRU（_spaceAccessOrder）与消息级
 * LRU（_sessionAccessOrder）+ 批量 evict，跨 session/message 两域，留待 message/cache
 * 那一刀连同共享 LRU 模块一起抽。本 slice 的状态初始值仍由 useChatStore 顶层声明
 * （与 setSpaceSessions 共享同组 session-list 字段）。
 */

import type { ChatSession } from '@tabtin/chat-client'
import { resolveSessionScopeId } from '@tabtin/app-shell'
import type { ChatSessionTokenUsage } from '@/utils/chatSessionTokenUsage'
import { UPDATABLE_MONOTONIC_TOKENS } from '@/utils/chatSessionTokenUsage'
import { sortSessionsByActivity } from '@/utils/chat-session-sort'
import { buildConversationSessionScopeKey } from '@components/layout/workspaceContextState'
import { resetDraftPrefetchMessage } from '../actions/sessionPrefetchAction'
import {
  getDraftMessageByScopeKey,
  mutateDraftMessageMetadata,
} from '../draftMessage'
import {
  beginDraftMessageSession,
  cancelDraftMessageSessionByScopeKey,
} from '../draftMessageSessionCoordinator'
import { getDraftSessionBySessionId } from '../draftSession'
import { isConversationDraftScopeKey } from '@/lib/conversationDraftScopeKey'
import {
  buildDraftMessageMetadataFromLegacy,
  resolveConversationDraftScopeKey,
} from '../draftMessageLegacyAdapter'
import { recordSpaceSessionListMutation } from '../spaceSessionListWriteGate'
import { applySessionRunStateSnapshot } from '../../execution/sessionRunProjection'

interface SessionPointerRootState {
  sessions: ChatSession[]
  sessionsBySpaceId: Record<string, ChatSession[]>
  trackerRunSessionsBySpaceId: Record<string, ChatSession[]>
  currentSessionId: string | null
  currentSessionIdBySpaceId: Record<string, string | null>
  currentSessionIdByWorkspaceKey: Record<string, string | null>
  draftExecutionSpaceIdByWorkspaceKey: Record<string, string | null>
  draftSessionBySpaceId: Record<string, boolean>
}

/** Composer / Panel 显式传入的 opaque draft scope + 产品元数据 */
export interface DraftScopePointerOptions {
  draftScopeKey?: string | null
  organizationId?: string | null
  /** 仅显式真实 execution Workspace id */
  executionWorkspaceId?: string | null
  projectId?: string | null
  agentId?: string | null
  /**
   * 切执行 Workspace 时为 true：只更新 draftMessage 元数据并重置预建指针，
   * 不 begin 新 draftMessage（避免冲掉 Mode/Agent/Model/Tier 意图，）。
   */
  preserveDraftMessageIntent?: boolean
}

/**
 * 切历史时解析应 cancel 的 draft scope：
 * 优先显式 key；否则用 draftExecution 映射到 conversation:draft:*；
 * 最后才 legacy host fallback（不得用 execution B 猜 Project scope A）。
 */
function resolveDraftScopeKeysToCancel(
  state: SessionPointerRootState,
  legacyHostId: string,
  explicit?: string | null,
): string[] {
  if (explicit && isConversationDraftScopeKey(explicit)) {
    return [explicit]
  }
  const mapped: string[] = []
  for (const [wsKey, hostId] of Object.entries(state.draftExecutionSpaceIdByWorkspaceKey)) {
    if (hostId === legacyHostId && isConversationDraftScopeKey(wsKey)) {
      mapped.push(wsKey)
    }
  }
  if (mapped.length > 0) return mapped
  const fallback = resolveConversationDraftScopeKey({
    legacyExecutionHostId: legacyHostId,
  })
  return fallback ? [fallback] : []
}

export interface SessionPointerStore {
  setCurrentSessionForSpace: (
    spaceId: string,
    sessionId: string | null,
    syncCurrent?: boolean,
    options?: DraftScopePointerOptions,
  ) => void
  setCurrentSessionForWorkspace: (workspaceKey: string, sessionId: string | null, syncCurrent?: boolean) => void
  setDraftExecutionSpaceForWorkspace: (workspaceKey: string, spaceId: string | null) => void
  startDraftSessionForSpace: (
    spaceId: string,
    syncCurrent?: boolean,
    options?: DraftScopePointerOptions,
  ) => void
  clearDraftSessionForSpace: (spaceId: string) => void
  /**
   * 只清前台全局会话选中（`currentSessionId`）。
   * 不碰 per-Space 记忆 / 消息缓存桶——切组织硬重置用；切回原组织仍可 restore。
   */
  clearForegroundSessionSelection: () => void
  updateSessionTitleInCaches: (sessionId: string, title: string, opts?: { bumpUpdatedAt?: boolean }) => void
  updateSessionInCaches: (sessionId: string, patch: Partial<ChatSession>) => void
  updateSessionTokenUsageInCaches: (sessionId: string, usage: ChatSessionTokenUsage) => void
  getSessionById: (sessionId: string) => ChatSession | undefined
}

export interface SessionPointerDeps {
  /** 与 sessionCrudSlice 同源：判定 upsert 是否同步进当前激活 `sessions` 视图。 */
  resolveActiveSpaceId: () => string | null
}

export function createSessionPointerActions<RootState extends SessionPointerRootState>(
  get: () => RootState,
  set: (partial: Partial<RootState> | ((state: RootState) => Partial<RootState>)) => void,
  deps: SessionPointerDeps,
): SessionPointerStore {
  const { resolveActiveSpaceId } = deps
  return {
    setCurrentSessionForSpace: (spaceId, sessionId, syncCurrent = true, options) => {
      if (sessionId) {
        // ：切历史 cancel 显式 / 映射到的 draft scope，禁止用 execution host 猜错 Project scope
        const scopes = resolveDraftScopeKeysToCancel(
          get(),
          spaceId,
          options?.draftScopeKey,
        )
        const bound = getDraftSessionBySessionId(sessionId)
        for (const draftScopeKey of scopes) {
          if (!bound || bound.draftScopeKey !== draftScopeKey) {
            cancelDraftMessageSessionByScopeKey(draftScopeKey)
          }
        }
      }
      set((state) => {
        const nextDraftBySpaceId = { ...state.draftSessionBySpaceId }
        let nextDraftExecution = state.draftExecutionSpaceIdByWorkspaceKey
        if (sessionId) {
          delete nextDraftBySpaceId[spaceId]
          // ：打开/首发建会话时把 conversation:{sessionId} 对齐到该 Space，
          // 防止陈旧 draft 在 key 切换后误导执行目标徽章。
          nextDraftExecution = {
            ...nextDraftExecution,
            [buildConversationSessionScopeKey(sessionId)]: spaceId,
          }
        }
        return {
          currentSessionId: syncCurrent ? sessionId : state.currentSessionId,
          currentSessionIdBySpaceId: {
            ...state.currentSessionIdBySpaceId,
            [spaceId]: sessionId,
          },
          draftSessionBySpaceId: nextDraftBySpaceId,
          draftExecutionSpaceIdByWorkspaceKey: nextDraftExecution,
        } as Partial<RootState>
      })
    },

    setCurrentSessionForWorkspace: (workspaceKey, sessionId, syncCurrent = true) => {
      set((state) => ({
        currentSessionId: syncCurrent ? sessionId : state.currentSessionId,
        currentSessionIdByWorkspaceKey: {
          ...state.currentSessionIdByWorkspaceKey,
          [workspaceKey]: sessionId,
        },
      }) as Partial<RootState>)
    },

    setDraftExecutionSpaceForWorkspace: (workspaceKey, spaceId) => {
      set((state) => ({
        draftExecutionSpaceIdByWorkspaceKey: {
          ...state.draftExecutionSpaceIdByWorkspaceKey,
          [workspaceKey]: spaceId,
        },
      }) as Partial<RootState>)
    },

    startDraftSessionForSpace: (spaceId, syncCurrent = true, options) => {
      set((state) => {
        // ChatPanel reconcile 读的是 execution 桶；host≠execution 时必须一并清空，
        // 否则会 restore 回刚发完的会话（ 二次「新任务」）。
        const executionSpaceId = options?.executionWorkspaceId || spaceId
        const hostCurrent = state.currentSessionIdBySpaceId[spaceId] ?? null
        const executionCurrent = state.currentSessionIdBySpaceId[executionSpaceId] ?? null
        const alreadyDraft = Boolean(state.draftSessionBySpaceId[spaceId])
          && hostCurrent == null
          && executionCurrent == null
        const globalAlreadyCleared = !syncCurrent || state.currentSessionId == null
        // 已在干净草稿态时幂等 no-op，避免重复 set 触发 prefetch / lifecycle。
        if (alreadyDraft && globalAlreadyCleared) {
          return {} as Partial<RootState>
        }
        resetDraftPrefetchMessage(spaceId)
        if (executionSpaceId !== spaceId) {
          resetDraftPrefetchMessage(executionSpaceId)
        }
        const draftScopeKey = (
          options?.draftScopeKey && isConversationDraftScopeKey(options.draftScopeKey)
        )
          ? options.draftScopeKey
          : resolveConversationDraftScopeKey({ legacyExecutionHostId: spaceId })
        const previousExecutionWorkspaceId = draftScopeKey
          ? getDraftMessageByScopeKey(draftScopeKey)?.executionWorkspaceId
          : undefined
        if (draftScopeKey) {
          const metadata = buildDraftMessageMetadataFromLegacy({
            organizationId: options?.organizationId,
            executionWorkspaceId: options?.executionWorkspaceId,
            projectId: options?.projectId,
            agentId: options?.agentId,
          })
          // ：切执行 Workspace 须保留 Mode/Agent/Model/Tier；仅「新任务」才 begin 新 token。
          if (options?.preserveDraftMessageIntent && getDraftMessageByScopeKey(draftScopeKey)) {
            mutateDraftMessageMetadata(draftScopeKey, metadata)
          } else {
            beginDraftMessageSession(draftScopeKey, metadata)
          }
        }
        if (
          previousExecutionWorkspaceId
          && previousExecutionWorkspaceId !== spaceId
          && previousExecutionWorkspaceId !== executionSpaceId
        ) {
          resetDraftPrefetchMessage(previousExecutionWorkspaceId)
        }
        const nextPointers = {
          ...state.currentSessionIdBySpaceId,
          [spaceId]: null,
          ...(executionSpaceId !== spaceId ? { [executionSpaceId]: null } : {}),
          ...(
            previousExecutionWorkspaceId
            && previousExecutionWorkspaceId !== spaceId
            && previousExecutionWorkspaceId !== executionSpaceId
              ? { [previousExecutionWorkspaceId]: null }
              : {}
          ),
        }
        const nextDraft = {
          ...state.draftSessionBySpaceId,
          [spaceId]: true,
        }
        // draft UI 只挂 host；清掉 execution 上误留的旗标，避免双桶
        if (executionSpaceId !== spaceId) {
          delete nextDraft[executionSpaceId]
        }
        return {
          currentSessionId: syncCurrent ? null : state.currentSessionId,
          currentSessionIdBySpaceId: nextPointers,
          draftSessionBySpaceId: nextDraft,
        } as Partial<RootState>
      })
    },

    clearDraftSessionForSpace: (spaceId) => {
      // 仅清 UI draft marker（如删光 preset）。不等于退出 draftMessage，保留 Mode/Agent intent。
      set((state) => {
        if (!state.draftSessionBySpaceId[spaceId]) {
          return {} as Partial<RootState>
        }
        const nextDraftBySpaceId = { ...state.draftSessionBySpaceId }
        delete nextDraftBySpaceId[spaceId]
        return { draftSessionBySpaceId: nextDraftBySpaceId } as Partial<RootState>
      })
    },

    clearForegroundSessionSelection: () => {
      set((state) => {
        if (state.currentSessionId == null) {
          return {} as Partial<RootState>
        }
        return { currentSessionId: null } as Partial<RootState>
      })
    },

    updateSessionTitleInCaches: (sessionId, title, opts) => {
      const bumpUpdatedAt = opts?.bumpUpdatedAt ?? false
      const now = bumpUpdatedAt ? new Date().toISOString() : null
      set((state) => {
        const updateList = (list: ChatSession[]) => (
          list.map((item) => item.id === sessionId
            ? (now ? { ...item, title, updated_at: now } : { ...item, title })
            : item)
        )
        const nextSessionsBySpaceId: Record<string, ChatSession[]> = {}
        Object.entries(state.sessionsBySpaceId).forEach(([spaceId, list]) => {
          nextSessionsBySpaceId[spaceId] = updateList(list)
        })
        const nextTrackerRunSessionsBySpaceId: Record<string, ChatSession[]> = {}
        Object.entries(state.trackerRunSessionsBySpaceId).forEach(([spaceId, list]) => {
          nextTrackerRunSessionsBySpaceId[spaceId] = updateList(list)
        })
        return {
          sessions: updateList(state.sessions),
          sessionsBySpaceId: nextSessionsBySpaceId,
          trackerRunSessionsBySpaceId: nextTrackerRunSessionsBySpaceId,
        } as Partial<RootState>
      })
    },

    /**
     * 按 sessionId patch 双缓存；桶内不存在时按 space 作用域 upsert。
     * lifecycle.end 的 sessions.get 回写依赖此语义——会话若曾被陈旧 list 冲掉，
     * 仍能凭 get 结果重新进入侧栏，而非 silent no-op。
     *
     * 同步进 `sessions` 视图仅当：正在看该会话，或 upsert 的 space 即当前激活 Space。
     * 禁止用「sessions 为空」猜测——否则后台其它 Space 的 get 回写会污染当前视图。
     */
    updateSessionInCaches: (sessionId, patch) => {
      if (Object.prototype.hasOwnProperty.call(patch, 'run_state')) {
        applySessionRunStateSnapshot({ id: sessionId, ...patch } as ChatSession)
      }
      const scopeHint = resolveSessionScopeId({
        space_id: patch.space_id,
        workspace_id: (patch as { workspace_id?: string | null }).workspace_id,
      })
      const isTrackerRunPatch = Boolean(patch.tracker_run)
      // 仅在可能 insert 时预 bump；桶内已有则下面 found=true，epoch 无需动。
      // 若已存在则这次 bump 多一次也无害（只让飞行中的旧 list 失效）。
      if (scopeHint) {
        const snapshot = get()
        if (isTrackerRunPatch) {
          Object.entries(snapshot.sessionsBySpaceId).forEach(([spaceId, list]) => {
            if (list.some(item => item.id === sessionId)) {
              recordSpaceSessionListMutation(
                spaceId,
                'updateSessionInCaches.migrateTrackerRun',
              )
            }
          })
        } else {
          const alreadyPresent = snapshot.sessions.some((item) => item.id === sessionId)
            || Object.values(snapshot.sessionsBySpaceId).some((list) =>
              list.some((item) => item.id === sessionId))
            || Object.values(snapshot.trackerRunSessionsBySpaceId).some((list) =>
              list.some((item) => item.id === sessionId))
          if (!alreadyPresent) {
            recordSpaceSessionListMutation(scopeHint, 'updateSessionInCaches.upsert')
          }
        }
      }

      set((state) => {
        if (isTrackerRunPatch && scopeHint) {
          const existing = Object.values(state.trackerRunSessionsBySpaceId)
            .flat()
            .find(item => item.id === sessionId)
            ?? state.sessions.find(item => item.id === sessionId)
            ?? Object.values(state.sessionsBySpaceId)
              .flat()
              .find(item => item.id === sessionId)
          const trackerSession = {
            ...existing,
            id: sessionId,
            ...patch,
            space_id: patch.space_id ?? scopeHint,
          } as ChatSession
          const nextTrackerRunSessionsBySpaceId = Object.fromEntries(
            Object.entries(state.trackerRunSessionsBySpaceId).map(([spaceId, list]) => [
              spaceId,
              list.filter(item => item.id !== sessionId),
            ]),
          )
          const targetTrackerBucket = nextTrackerRunSessionsBySpaceId[scopeHint] ?? []
          nextTrackerRunSessionsBySpaceId[scopeHint] = sortSessionsByActivity(
            [trackerSession, ...targetTrackerBucket],
          )
          return {
            sessions: state.sessions.filter(item => item.id !== sessionId),
            sessionsBySpaceId: Object.fromEntries(
              Object.entries(state.sessionsBySpaceId).map(([spaceId, list]) => [
                spaceId,
                list.filter(item => item.id !== sessionId),
              ]),
            ),
            trackerRunSessionsBySpaceId: nextTrackerRunSessionsBySpaceId,
          } as Partial<RootState>
        }

        let found = false
        const updateList = (list: ChatSession[]) => (
          list.map((item) => {
            if (item.id !== sessionId) return item
            found = true
            return { ...item, ...patch }
          })
        )
        // ：活动时间变更后必须重排，否则跨端 bump last_message_at 不会置顶。
        const shouldResortForActivity =
          Object.prototype.hasOwnProperty.call(patch, 'last_message_at')
          || Object.prototype.hasOwnProperty.call(patch, 'updated_at')
          || Object.prototype.hasOwnProperty.call(patch, 'created_at')
        const nextSessionsBySpaceId: Record<string, ChatSession[]> = {}
        Object.entries(state.sessionsBySpaceId).forEach(([spaceId, list]) => {
          const updated = updateList(list)
          nextSessionsBySpaceId[spaceId] = shouldResortForActivity
            ? sortSessionsByActivity(updated)
            : updated
        })
        const nextTrackerRunSessionsBySpaceId: Record<string, ChatSession[]> = {}
        Object.entries(state.trackerRunSessionsBySpaceId).forEach(([spaceId, list]) => {
          const updated = updateList(list)
          nextTrackerRunSessionsBySpaceId[spaceId] = shouldResortForActivity
            ? sortSessionsByActivity(updated)
            : updated
        })
        let nextSessions = updateList(state.sessions)
        if (shouldResortForActivity) {
          nextSessions = sortSessionsByActivity(nextSessions)
        }

        if (!found && scopeHint) {
          const inserted = {
            id: sessionId,
            ...patch,
            space_id: patch.space_id ?? scopeHint,
          } as ChatSession
          const bucket = nextSessionsBySpaceId[scopeHint] ?? []
          nextSessionsBySpaceId[scopeHint] = sortSessionsByActivity([inserted, ...bucket])
          const syncActiveView = state.currentSessionId === sessionId
            || resolveActiveSpaceId() === scopeHint
          if (syncActiveView) {
            nextSessions = sortSessionsByActivity([inserted, ...nextSessions])
          }
        }

        return {
          sessions: nextSessions,
          sessionsBySpaceId: nextSessionsBySpaceId,
          trackerRunSessionsBySpaceId: nextTrackerRunSessionsBySpaceId,
        } as Partial<RootState>
      })
    },

    updateSessionTokenUsageInCaches: (sessionId, usage) => {
      set((state) => {
        // 字段清单走共享常量 UPDATABLE_MONOTONIC_TOKENS（chatSessionTokenUsage.ts）——
        // SSoT 让"剔除 / 读取 / 写入"三路径同步。context_tokens 不在活字段集
        // （messages-as-truth 后由 messages 派生），刻意排除以防服务端旧值倒灌。
        const patch = (list: ChatSession[]) =>
          list.map((s) => {
            if (s.id !== sessionId) return s
            const monotonic: Record<string, number | undefined> = {}
            for (const key of UPDATABLE_MONOTONIC_TOKENS) {
              const incoming = usage[key]
              if (incoming == null) continue
              const current = (s as unknown as Record<string, unknown>)[key]
              monotonic[key] = typeof current === 'number' ? Math.max(current, incoming) : incoming
            }
            return { ...s, ...monotonic }
          })
        const nextSessionsBySpaceId: Record<string, ChatSession[]> = {}
        Object.entries(state.sessionsBySpaceId).forEach(([sid, list]) => {
          nextSessionsBySpaceId[sid] = patch(list)
        })
        const nextTrackerRunSessionsBySpaceId: Record<string, ChatSession[]> = {}
        Object.entries(state.trackerRunSessionsBySpaceId).forEach(([sid, list]) => {
          nextTrackerRunSessionsBySpaceId[sid] = patch(list)
        })
        return {
          sessions: patch(state.sessions),
          sessionsBySpaceId: nextSessionsBySpaceId,
          trackerRunSessionsBySpaceId: nextTrackerRunSessionsBySpaceId,
        } as Partial<RootState>
      })
    },

    getSessionById: (sessionId) => {
      const state = get()
      // Tracker Run 桶优先：同一 id 若因 metadata 回填竞态短暂同时存在于主桶，
      // Tracker 桶通常持有更新、更完整的 tracker_run / agent_id 快照。
      for (const list of Object.values(state.trackerRunSessionsBySpaceId)) {
        const found = list.find((s) => s.id === sessionId)
        if (found) return found
      }
      const hit = state.sessions.find((s) => s.id === sessionId)
      if (hit) return hit
      for (const list of Object.values(state.sessionsBySpaceId)) {
        const found = list.find((s) => s.id === sessionId)
        if (found) return found
      }
      return undefined
    },
  }
}
