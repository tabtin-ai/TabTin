/**
 * Session CRUD slice — loadSessions, loadSessionMessages, selectSession,
 * renameSession, deleteSession, deleteSessionPermanently, listArchivedSessions,
 * restoreSession, generateTitle.
 *
 * createSession is in chat/actions/sessionLifecycleAction.ts (extracted in Round 3).
 */

import type { ChatSession, ChatMessage, ChatClient } from '@tabtin/chat-client'
import { resolveSessionScopeId } from '@tabtin/app-shell'
import { trackChatTelemetry } from '../../execution/chatTelemetry'
import {
  buildCheckpointMapFromMessages,
} from './sessionRuntimeState'
import { useChatSplitStore } from '../../../useChatSplitStore'
import { useSpaceContextTabsStore } from '../../../useSpaceContextTabsStore'
import {
  getCachedMessages,
  cacheMessages,
  appendCachedMessages,
  touchSessionMeta,
  clearSessionCache,
} from '../../messages/messageCache'
import { restoreRuntimeStateFromHistory } from '../../stream/handlers/historyRestoreHelper'
import {
  evictChatStoreSessionData,
  evictChatStoreSessionDataBatch,
} from '../utils/evictSessionData'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import { mergeRestoredSessionAgentMode } from '../sessionAgentModeRestore'
import { isAgentModeName } from '../../shared/types'
import { useSessionReadStore } from '../../../useSessionReadStore'
import { markSessionFresh, markSessionStale } from '@/services/sessionFreshness'
import { getSessionMessagesFacade } from '@/services/agentService/sessionMessages'
import { sortMessagesForTimeline } from '@/stores/chat/domain/messageTimelineOrder'
import {
  hydrateLocalTranscriptWithContinuationSnapshot,
  listLatestSessionMessages,
  mergeTranscriptPreservingShareSnapshot,
} from '../localTranscriptContinuation'
import { isLocalRuntimeAvailable } from '@/services/localAgentClient'
import {
  hasLocalTranscript,
  readLocalTranscript,
  enrichWithServerMetadata,
  forkLocalSessionArchive,
} from '@/services/localTranscript'
import {
  mergeTranscriptPreservingExternalArchive,
  preserveLiveRuntimeOnTranscriptMerge,
} from '@components/onboarding/external-import/mergeExternalArchiveMessages'
import { sortSessionsByActivity } from '@/utils/chat-session-sort'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { logger } from '@/utils/logger'
import i18n from '@/i18n'
import { requestTitleGenerationOnce } from '../../messages/actions/titleGenerationDedupe'
import {
  isContextInjectionMessage,
  isRegularUserMessage,
} from '../../messages/utils/semanticMessageCount'
import { ensureGroupRuntimeSynced } from '../../group/groupRuntimeSessionSync'
import { markSessionManualTitle } from './manualTitleGuard'
import type { DraftScopePointerOptions } from './sessionPointerSlice'
import { resolveChatSessionListQuery } from '../utils/chatSessionScope'
import { clearSessionCodeRoot } from '@/services/sessionCodeRootBinding'
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore'
import { mergeServerSpaceSessionSnapshot } from '../mergeServerSpaceSessionSnapshot'
import {
  selectAbandonedEmptySessions,
  type AbandonedEmptyDiscardReason,
} from '../discardAbandonedEmptySessions'
import {
  beginProvisionalSessionDiscard,
  completeProvisionalSessionDiscard,
} from '../provisionalSessionHost'
import { isDraftSessionReleased } from '../draftSession'
import { clearSessionLocalModelPreference } from '../sessionLocalModelPreference'
import { useSessionAccessStore } from '../sessionAccessStore'
import {
  commitSpaceSessionListMerge,
  getObservedServerSessionIds,
  getSpaceSessionListEpoch,
  recordSpaceSessionListMutation,
  replaceObservedServerSessionIds,
} from '../spaceSessionListWriteGate'

export { markSessionManualTitle, shouldApplyGeneratedTitleUpdate } from './manualTitleGuard'

/**
 * 选择会话仍走统一的 session pointer；共享信息只是该会话请求所需的授权上下文。
 */
export interface SessionSelectionOptions extends DraftScopePointerOptions {
  sharedAccess?: {
    shareId: string
    organizationId?: string | null
    workspaceId?: string | null
    workspaceName?: string
    ownerUserId?: string
    ownerDisplayName?: string
  }
  /**
   * 普通会话默认按历史分页契约加载第一页；从续接卡新建出来的任务需要直接
   * 展示冻结快照的最近上下文，因此显式请求最新页。
   */
  initialMessagePage?: 'default' | 'latest'
}

/**
 * ：本机会话正文以 runtime transcript（messages.jsonl）为唯一权威。
 *
 * 冷启动后判据只能靠**主进程探盘** messages.jsonl：盘上有非空 transcript → 本机会话，
 * 读 transcript 覆盖为权威；否则返回 null，调用方回落 DB 只读（观察端 / 跨设备）。
 * 热路径 sync 按内容态保留未落库消息，不再依赖内存态来源标志。
 *
 * 返回 null 的情形：非本地 runtime（HTTP 编排）/ 盘上无数据 / 重建为空 / 读盘失败——
 * 一律让调用方走既有 DB 路径，绝不因本地读失败而空屏。
 */
async function tryLoadLocalTranscript(
  sessionId: string,
  ctx: { organizationId?: string; spaceId?: string },
): Promise<ChatMessage[] | null> {
  if (!isLocalRuntimeAvailable()) return null
  try {
    if (!(await hasLocalTranscript(sessionId, ctx))) return null
    const msgs = await readLocalTranscript(sessionId, ctx)
    if (!msgs || msgs.length === 0) return null
    return sortMessagesForTimeline(msgs)
  } catch (err) {
    logger.warn('[localTranscript] load failed; falling back to DB', { sessionId, err })
    return null
  }
}

/** ：服务端拒绝读私有 session 时的错误识别（403/404 / NOT_FOUND / FORBIDDEN）。 */
export { isSessionShareArchiveConflict } from '../isSessionShareArchiveConflict'

export function isSessionAccessDeniedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as {
    statusCode?: unknown
    code?: unknown
    response?: { code?: unknown; status?: unknown }
    message?: unknown
  }
  const status = e.statusCode ?? e.response?.status
  if (status === 403 || status === 404) return true
  const code = e.code ?? e.response?.code
  if (code === 'NOT_FOUND' || code === 'FORBIDDEN' || code === 'PERMISSION_DENIED') return true
  if (code === 403 || code === 404) return true
  if (typeof e.message === 'string') {
    const msg = e.message.toUpperCase()
    if (msg.includes('NOT_FOUND') || msg.includes('FORBIDDEN') || msg.includes('PERMISSION_DENIED')) {
      return true
    }
  }
  return false
}

export interface SessionCrudDeps {
  getChatClient: () => ChatClient
  resolveActiveSpaceId: () => string | null
  emptySessions: ChatSession[]
  /**
   * Called when a cached session is selected. Returns `true` if the callback
   * initiated its own full server sync (e.g. crash-recovery for reverted
   * sessions), in which case `selectSession` skips its normal background sync
   * to avoid a limit race.
   */
  reconcileRevertedSession?: (sessionId: string) => boolean
}

export interface SessionCrudStore {
  sessions: ChatSession[]
  sessionsBySpaceId: Record<string, ChatSession[]>
  currentSessionId: string | null
  currentSessionIdBySpaceId: Record<string, string | null>
  messagesBySessionId: Record<string, ChatMessage[]>
  hasMoreBySessionId: Record<string, boolean>
  isLoadingMoreBySessionId: Record<string, boolean>
  isLoading: boolean
  forkingSessionId: string | null
  checkpointsBySessionId: Record<string, Record<string, string>>
  lastContextSyncFingerprintBySessionId: Record<string, string>
  pendingApprovalBySessionId: Record<string, import('../../shared/types').ApprovalRequestState>
  approvalSubmittingBySessionId: Record<string, boolean>
  pendingAskUserBySessionId: Record<string, import('../../shared/types').AskUserRequestState>
  askUserSubmittingBySessionId: Record<string, boolean>
  // ── 隐患 5 / 方案 ①（charter v1.8 §6.7 主侧栏分桶）─────────────────────
  // ChatSessionSwitcher 的「自动化任务执行记录」折叠分组采用懒加载:默认 loadSessions
  // 走 include_tracker_runs=false 拿普通会话(同时拿到 trackerRunCount),分组首次
  // 展开时调 loadTrackerRunSessions 走 include_tracker_runs=true 单独 fetch
  // Tracker session,缓存到 trackerRunSessionsBySpaceId 复用。
  trackerRunSessionsBySpaceId: Record<string, ChatSession[]>
  trackerRunCountBySpaceId: Record<string, number | null>
  excludedAgentMentionSessionIdsBySpaceId: Record<string, string[]>
  trackerRunLoadingBySpaceId: Record<string, boolean>
  trackerRunErrorBySpaceId: Record<string, string | null>
  trackerRunLoadedBySpaceId: Record<string, boolean>

  hydrateFromCache: (sessionId: string, messages: ChatMessage[]) => void
  applyLoadedMessages: (sessionId: string, messages: ChatMessage[]) => void
  reconcileFromServer: (sessionId: string, fetchEpoch: number, fresh: ChatMessage[], opts?: { advanceWatermark?: boolean; syncWatermark?: string }) => { changed: boolean; newCount: number; dropped: boolean }
  prependOlderMessages: (sessionId: string, older: ChatMessage[]) => void
  clearSessionMessages: (sessionId: string) => void
  setSpaceSessions: (spaceId: string, sessions: ChatSession[], syncCurrent?: boolean) => void
  setCurrentSessionForSpace: (
    spaceId: string,
    sessionId: string | null,
    syncCurrent?: boolean,
    options?: DraftScopePointerOptions,
  ) => void
  updateSessionTitleInCaches: (
    sessionId: string,
    title: string,
    opts?: { bumpUpdatedAt?: boolean },
  ) => void
  updateSessionInCaches: (sessionId: string, patch: Partial<ChatSession>) => void
  /**
   * 本地创建路径（createSession / TabChat 升级任务响应）把会话写入
   * sessionsBySpaceId 桶。跨成员 ``agent.user.session_created`` 已停用。
   */
  upsertSessionInSpace: (spaceId: string, session: ChatSession) => void
  /**
   * 把会话钉进 Space 桶（overlay + upsert），避免 reconcileSpacePointer
   * 因「不在 active 列表」把刚点开的 Project 任务会话打回草稿。
   */
  pinSessionInSpace: (spaceId: string, session: ChatSession) => void
  selectSession: (
    spaceId: string,
    sessionId: string,
    options?: SessionSelectionOptions,
  ) => Promise<void>
  listArchivedSessions: (spaceId: string, organizationId?: string, limit?: number) => Promise<ChatSession[]>
  /**
   * 查看归档会话（不改 status）：写入侧栏缓存钉住 + select，可继续聊。
   * 与 restoreSession（取消归档回主列表）刻意分开——归档会话可点开继续的口径。
   */
  viewArchivedSession: (spaceId: string, session: ChatSession) => Promise<void>
  restoreSession: (spaceId: string, sessionId: string) => Promise<ChatSession>
  /**
   * ：归档确认后立刻从侧栏下架；失败时 rollbackOptimisticArchive。
   */
  beginOptimisticArchive: (spaceId: string, sessionId: string) => boolean
  rollbackOptimisticArchive: (spaceId: string, sessionId: string) => void
  /**
   * ：放弃创建 / 预建过期时立即清掉未发消息的空会话。
   * 先同步移出 store + 墓碑，再异步软归档，避免与单槽 reuse 竞态。
   */
  discardAbandonedEmptySessions: (input: {
    sessionIds: readonly string[]
    reason: AbandonedEmptyDiscardReason
    draftSessionPhase?: 'open' | 'sending' | null
    sessionSpaceById?: Record<string, string | undefined>
  }) => void
}

function removeTrackerRunSessionFromCaches(
  state: SessionCrudStore,
  sessionId: string,
): Pick<SessionCrudStore, 'trackerRunSessionsBySpaceId' | 'trackerRunCountBySpaceId'> {
  const trackerRunSessionsBySpaceId: Record<string, ChatSession[]> = {}
  const trackerRunCountBySpaceId = { ...state.trackerRunCountBySpaceId }

  for (const [bucketSpaceId, sessions] of Object.entries(state.trackerRunSessionsBySpaceId ?? {})) {
    const nextSessions = sessions.filter(session => session.id !== sessionId)
    trackerRunSessionsBySpaceId[bucketSpaceId] = nextSessions
    const removedCount = sessions.length - nextSessions.length
    if (removedCount > 0) {
      trackerRunCountBySpaceId[bucketSpaceId] = Math.max(
        0,
        (state.trackerRunCountBySpaceId[bucketSpaceId] ?? sessions.length) - removedCount,
      )
    }
  }

  return { trackerRunSessionsBySpaceId, trackerRunCountBySpaceId }
}

const INITIAL_MESSAGE_PAGE_SIZE = 50

function countVisibleTimelineMessages(messages: ChatMessage[]): number {
  return messages.reduce(
    (count, message) => count + (isContextInjectionMessage(message) ? 0 : 1),
    0,
  )
}

function resolveSessionRecord(
  state: Pick<SessionCrudStore, 'sessions' | 'sessionsBySpaceId'>,
  sessionId: string,
  spaceId?: string | null,
): ChatSession | undefined {
  return state.sessions.find((session) => session.id === sessionId)
    ?? (spaceId ? state.sessionsBySpaceId[spaceId]?.find((session) => session.id === sessionId) : undefined)
    ?? Object.values(state.sessionsBySpaceId ?? {}).flat().find((session) => session.id === sessionId)
}

type MessageListAccess = Parameters<ChatClient['messages']['list']>[2]

async function listInitialMessages(
  client: ChatClient,
  sessionId: string,
  access: MessageListAccess,
  initialMessagePage: SessionSelectionOptions['initialMessagePage'] = 'default',
): Promise<{
  messages: ChatMessage[]
  hasEarlier: boolean
}> {
  const firstPage = await client.messages.list(
    sessionId,
    { limit: INITIAL_MESSAGE_PAGE_SIZE },
    access,
  )
  const firstMessages: ChatMessage[] = firstPage?.messages ?? (Array.isArray(firstPage) ? firstPage : [])
  if (initialMessagePage !== 'latest' || !firstPage?.has_more) {
    return {
      messages: firstMessages,
      hasEarlier: firstPage?.has_more ?? false,
    }
  }

  if (!Number.isFinite(firstPage.total)) {
    throw new Error('messages.list latest page requires total when has_more=true')
  }
  const latestOffset = Math.max(0, Number(firstPage.total) - INITIAL_MESSAGE_PAGE_SIZE)
  if (latestOffset <= 0) {
    return {
      messages: firstMessages,
      hasEarlier: false,
    }
  }
  const latestPage = await client.messages.list(
    sessionId,
    { limit: INITIAL_MESSAGE_PAGE_SIZE, offset: latestOffset },
    access,
  )
  return {
    messages: latestPage?.messages ?? (Array.isArray(latestPage) ? latestPage : []),
    hasEarlier: true,
  }
}

type GetFn = () => SessionCrudStore
type SetFn = (partial: Partial<SessionCrudStore> | ((state: SessionCrudStore) => Partial<SessionCrudStore>)) => void

/** 归档墓碑 TTL：挡住飞行中 list 把刚归档的 session 写回。 */
const PENDING_ARCHIVED_TOMBSTONE_TTL_MS = 60_000
/**
 * 侧栏缓存钉住 TTL：
 * - 查看归档：会话仍是 archived，但要暂时留在 sessionsBySpaceId 里，否则
 *   reconcileSpacePointer 会当成失效指针打回草稿；
 * - 恢复 active：挡住飞行中 loadSessions 把刚写回的会话冲掉。
 */
const PENDING_OVERLAY_SESSION_TTL_MS = 15_000

async function stopBusyHostRunBeforeArchive(sessionId: string): Promise<void> {
  const bridge = window.tabtin?.agentEngine
  if (!bridge?.getState || !bridge?.abortRun) return

  let hostState: { busy?: boolean } | null = null
  try {
    hostState = await bridge.getState({ sessionId })
  } catch (error) {
    logger.warn('[Chat] archive preflight failed to read host state:', { sessionId, error })
    return
  }

  if (hostState?.busy !== true) return

  trackChatTelemetry('session.archive.stop_busy_host_run.start', {
    sessionId,
  }, {
    counterKey: 'session.archive.stop_busy_host_run.start',
    sessionId,
  })

  const result = await bridge.abortRun(sessionId)
  if (result.localHit || result.remoteAccepted) {
    trackChatTelemetry('session.archive.stop_busy_host_run.done', {
      sessionId,
      localHit: result.localHit,
      remoteAccepted: result.remoteAccepted,
      remotePublished: result.remotePublished,
    }, {
      counterKey: 'session.archive.stop_busy_host_run.done',
      sessionId,
    })
    return
  }

  trackChatTelemetry('session.archive.stop_busy_host_run.failed', {
    sessionId,
    remoteRequested: result.remoteRequested,
    remoteAccepted: result.remoteAccepted,
    remotePublished: result.remotePublished,
  }, {
    counterKey: 'session.archive.stop_busy_host_run.failed',
    level: 'warn',
    sessionId,
  })
  throw new Error('任务仍在运行，停止失败后不能归档')
}

export function createSessionCrudActions(
  get: GetFn,
  set: SetFn,
  deps: SessionCrudDeps,
) {
  const { getChatClient, resolveActiveSpaceId, emptySessions } = deps
  let selectRequestVersion = 0
  const latestSelectRequestBySessionId = new Map<string, number>()
  // loadSessions 并发去重：同一 space 的服务器请求 in-flight 期间不重复发。
  const inflightSessionLoads = new Set<string>()
  const pendingArchivedSessionIds = new Map<string, number>()
  const pendingOverlaySessions = new Map<string, { spaceId: string; session: ChatSession; markedAt: number }>()
  const optimisticArchiveSnapshots = new Map<string, {
    spaceId: string
    session: ChatSession
    index: number
    wasInMainList: boolean
    didSwitchCurrent: boolean
    autoSelectedSessionId: string | null
    currentSessionId: string | null
    currentSessionIdForSpace: string | null
    trackerRemovals: Array<{ spaceId: string; session: ChatSession; index: number }>
  }>()

  const markSessionArchivedTombstone = (sessionId: string) => {
    pendingArchivedSessionIds.set(sessionId, Date.now())
  }

  const applyCurrentArchiveFocus = (spaceId: string, sessionId: string) => {
    const snapshot = optimisticArchiveSnapshots.get(sessionId)
    set((current: SessionCrudStore) => {
      const sync = resolveActiveSpaceId() === spaceId
      const spaceSessions = current.sessionsBySpaceId[spaceId] ?? emptySessions
      const spaceCurrentId = current.currentSessionIdBySpaceId?.[spaceId] ?? null
      const nextSpaceCurrentId = spaceCurrentId === sessionId
        ? (spaceSessions[0]?.id || null)
        : spaceCurrentId
      const nextCurrentId = sync && current.currentSessionId === sessionId
        ? nextSpaceCurrentId
        : current.currentSessionId
      if (snapshot && (spaceCurrentId === sessionId || (sync && current.currentSessionId === sessionId))) {
        snapshot.didSwitchCurrent = true
        snapshot.autoSelectedSessionId = nextSpaceCurrentId
      }
      if (nextSpaceCurrentId === spaceCurrentId && nextCurrentId === current.currentSessionId) {
        return current
      }
      return {
        currentSessionId: nextCurrentId,
        currentSessionIdBySpaceId: {
          ...current.currentSessionIdBySpaceId,
          [spaceId]: nextSpaceCurrentId,
        },
      }
    })
  }

  const applyOptimisticArchiveRemoval = (
    spaceId: string,
    sessionId: string,
    options?: { switchCurrent?: boolean },
  ): boolean => {
    const switchCurrent = options?.switchCurrent !== false
    if (optimisticArchiveSnapshots.has(sessionId)) {
      if (switchCurrent) applyCurrentArchiveFocus(spaceId, sessionId)
      return true
    }

    const state = get()
    const asSessions = state.sessionsBySpaceId[spaceId] ?? emptySessions
    const index = asSessions.findIndex(session => session.id === sessionId)
    const trackerSessions = state.trackerRunSessionsBySpaceId?.[spaceId] ?? []
    const session = index >= 0
      ? asSessions[index]
      : trackerSessions.find(item => item.id === sessionId)
        ?? resolveSessionRecord(state, sessionId, spaceId)
    if (!session) return false

    const trackerRemovals: Array<{ spaceId: string; session: ChatSession; index: number }> = []
    for (const [bucketSpaceId, sessions] of Object.entries(state.trackerRunSessionsBySpaceId ?? {})) {
      const trackerIndex = sessions.findIndex(item => item.id === sessionId)
      if (trackerIndex >= 0) {
        trackerRemovals.push({ spaceId: bucketSpaceId, session: sessions[trackerIndex], index: trackerIndex })
      }
    }

    const spaceCurrentId = state.currentSessionIdBySpaceId?.[spaceId] ?? null
    const nextSpaceSessionsPreview = asSessions.filter(item => item.id !== sessionId)
    const willSwitchSpace = switchCurrent && spaceCurrentId === sessionId
    const autoSelectedSessionId = willSwitchSpace
      ? (nextSpaceSessionsPreview[0]?.id || null)
      : null

    optimisticArchiveSnapshots.set(sessionId, {
      spaceId,
      session,
      index: index >= 0 ? index : 0,
      wasInMainList: index >= 0,
      didSwitchCurrent: willSwitchSpace,
      autoSelectedSessionId,
      currentSessionId: state.currentSessionId ?? null,
      currentSessionIdForSpace: spaceCurrentId,
      trackerRemovals,
    })

    markSessionArchivedTombstone(sessionId)
    recordSpaceSessionListMutation(spaceId, 'archive')

    set((current: SessionCrudStore) => {
      const sync = resolveActiveSpaceId() === spaceId
      const currentSpaceSessions = current.sessionsBySpaceId[spaceId] ?? emptySessions
      const nextSpaceSessions = currentSpaceSessions.filter(item => item.id !== sessionId)
      const currentSpaceCurrentId = current.currentSessionIdBySpaceId?.[spaceId] ?? null
      const nextSpaceCurrentId = switchCurrent && currentSpaceCurrentId === sessionId
        ? (nextSpaceSessions[0]?.id || null)
        : currentSpaceCurrentId

      return {
        sessions: sync ? nextSpaceSessions : current.sessions,
        sessionsBySpaceId: { ...current.sessionsBySpaceId, [spaceId]: nextSpaceSessions },
        ...removeTrackerRunSessionFromCaches(current, sessionId),
        currentSessionId: sync && switchCurrent && current.currentSessionId === sessionId
          ? nextSpaceCurrentId
          : current.currentSessionId,
        currentSessionIdBySpaceId: {
          ...current.currentSessionIdBySpaceId,
          [spaceId]: nextSpaceCurrentId,
        },
      }
    })
    return true
  }

  const restoreOptimisticArchiveRemoval = (sessionId: string) => {
    const snapshot = optimisticArchiveSnapshots.get(sessionId)
    if (!snapshot) return
    optimisticArchiveSnapshots.delete(sessionId)
    pendingArchivedSessionIds.delete(sessionId)

    set((current: SessionCrudStore) => {
      const existing = current.sessionsBySpaceId[snapshot.spaceId] ?? emptySessions
      const nextSpaceSessions = existing.some(item => item.id === sessionId) || !snapshot.wasInMainList
        ? existing
        : [
            ...existing.slice(0, snapshot.index),
            snapshot.session,
            ...existing.slice(snapshot.index),
          ]
      const sync = resolveActiveSpaceId() === snapshot.spaceId
      const trackerRunSessionsBySpaceId = { ...current.trackerRunSessionsBySpaceId }
      const trackerRunCountBySpaceId = { ...current.trackerRunCountBySpaceId }
      for (const removal of snapshot.trackerRemovals) {
        const bucket = trackerRunSessionsBySpaceId[removal.spaceId] ?? []
        if (bucket.some(item => item.id === removal.session.id)) continue
        trackerRunSessionsBySpaceId[removal.spaceId] = [
          ...bucket.slice(0, removal.index),
          removal.session,
          ...bucket.slice(removal.index),
        ]
        const count = trackerRunCountBySpaceId[removal.spaceId]
        if (typeof count === 'number') {
          trackerRunCountBySpaceId[removal.spaceId] = count + 1
        }
      }
      const spaceCurrentId = current.currentSessionIdBySpaceId?.[snapshot.spaceId] ?? null
      const restoreSpaceCurrent = snapshot.didSwitchCurrent
        && spaceCurrentId === snapshot.autoSelectedSessionId
      const restoreGlobalCurrent = snapshot.didSwitchCurrent
        && sync
        && current.currentSessionId === snapshot.autoSelectedSessionId
      return {
        sessions: sync ? nextSpaceSessions : current.sessions,
        sessionsBySpaceId: { ...current.sessionsBySpaceId, [snapshot.spaceId]: nextSpaceSessions },
        trackerRunSessionsBySpaceId,
        trackerRunCountBySpaceId,
        currentSessionId: restoreGlobalCurrent ? snapshot.currentSessionId : current.currentSessionId,
        currentSessionIdBySpaceId: {
          ...current.currentSessionIdBySpaceId,
          [snapshot.spaceId]: restoreSpaceCurrent
            ? snapshot.currentSessionIdForSpace
            : spaceCurrentId,
        },
      }
    })
  }

  const pinOverlaySession = (spaceId: string, session: ChatSession) => {
    pendingArchivedSessionIds.delete(session.id)
    pendingOverlaySessions.set(session.id, { spaceId, session, markedAt: Date.now() })
  }

  const pruneExpiredOverlays = () => {
    if (pendingOverlaySessions.size === 0) return
    const now = Date.now()
    for (const [id, entry] of pendingOverlaySessions) {
      if (now - entry.markedAt > PENDING_OVERLAY_SESSION_TTL_MS) {
        pendingOverlaySessions.delete(id)
      }
    }
  }

  const pruneExpiredTombstones = () => {
    if (pendingArchivedSessionIds.size === 0) return
    const now = Date.now()
    for (const [id, markedAt] of pendingArchivedSessionIds) {
      if (now - markedAt > PENDING_ARCHIVED_TOMBSTONE_TTL_MS) {
        pendingArchivedSessionIds.delete(id)
      }
    }
  }

  const mergeOverlaySessions = (spaceId: string, sessions: ChatSession[]): ChatSession[] => {
    pruneExpiredOverlays()
    if (pendingOverlaySessions.size === 0) return sessions
    let next = sessions
    for (const [id, entry] of pendingOverlaySessions) {
      if (entry.spaceId !== spaceId) continue
      if (next.some(session => session.id === id)) {
        // 已在列表里：用钉住副本刷新 status/title（查看归档时保持 archived）
        next = next.map(session => (session.id === id ? entry.session : session))
        continue
      }
      next = sortSessionsByActivity([entry.session, ...next])
    }
    return next
  }

  /** 收集同 Space 未过期 overlay，供服务端 list 按 id 合并时钉回。 */
  const collectOverlaySessionsForSpace = (spaceId: string): ChatSession[] => {
    pruneExpiredOverlays()
    if (pendingOverlaySessions.size === 0) return []
    const overlays: ChatSession[] = []
    for (const entry of pendingOverlaySessions.values()) {
      if (entry.spaceId === spaceId) overlays.push(entry.session)
    }
    return overlays
  }

  const collectTombstoneIds = (): Set<string> => {
    pruneExpiredTombstones()
    return new Set(pendingArchivedSessionIds.keys())
  }

  /**
   * ：解析 session 的 org/space 上下文，供主进程探盘定位归档目录（重启后
   * sessions Map 无 live session，靠这俩定位 messages.jsonl）。
   */
  const resolveLocalCtx = (sessionId: string, explicitSpaceId?: string) => {
    const session = get().sessions.find(s => s.id === sessionId)
      ?? Object.values(get().sessionsBySpaceId).flat().find(s => s.id === sessionId)
    return {
      organizationId: session?.organization_id ?? undefined,
      spaceId: resolveSessionScopeId(session) ?? explicitSpaceId,
    }
  }

  /**
   * ：服务端 403/404 时清除已渲染的内存 / IDB 正文，并从 Space 会话桶移除，
   * 停止继续展示私有执行对话。同机 runtime transcript 探盘不在本轮清理范围。
   */
  const purgeUnauthorizedSessionContent = async (
    sessionId: string,
    spaceId?: string | null,
  ): Promise<void> => {
    logger.warn('[Chat] purging unauthorized session content', {
      sessionId: sessionId.slice(0, 8),
      spaceId: spaceId ? spaceId.slice(0, 8) : undefined,
    })
    get().clearSessionMessages(sessionId)
    try {
      await clearSessionCache(sessionId)
    } catch (err) {
      logger.warn('[Chat] clearSessionCache failed during unauthorized purge', { sessionId, err })
    }
    useChatRuntimeStore.getState().evictSession(sessionId)
    set((s: SessionCrudStore) => ({
      ...evictChatStoreSessionData(s, sessionId),
      checkpointsBySessionId: { ...s.checkpointsBySessionId, [sessionId]: {} },
    }))

    const removeFromBucket = (bucketSpaceId: string) => {
      const existing = get().sessionsBySpaceId[bucketSpaceId]
      if (!existing || !existing.some(session => session.id === sessionId)) return
      recordSpaceSessionListMutation(bucketSpaceId, 'purgeUnauthorized')
      const next = existing.filter(session => session.id !== sessionId)
      get().setSpaceSessions(bucketSpaceId, next, resolveActiveSpaceId() === bucketSpaceId)
    }
    if (spaceId) {
      removeFromBucket(spaceId)
    } else {
      for (const bucketSpaceId of Object.keys(get().sessionsBySpaceId)) {
        removeFromBucket(bucketSpaceId)
      }
    }

    if (get().currentSessionId === sessionId) {
      const activeSpaceId = spaceId ?? resolveActiveSpaceId()
      if (activeSpaceId) {
        get().setCurrentSessionForSpace(activeSpaceId, null, true)
      }
      set({ isLoading: false })
    }
  }

  /**
   * ：本机会话的 DB 后台补全——数据来源不变（DB 照拉），但正文以 runtime
   * transcript 为准，只把 DB 的非正文增强字段（usage / checkpoint / model 等）补到
   * 已渲染的 runtime 消息上；绝不用 DB 覆盖 / 删除正文。与观察端的 mergeDelta
   * （服务端权威）区分：这里 runtime 是正文真相源。
   *
   * ：enrich 若遇服务端 403/404，视为无权访问——清除已渲染正文并停止展示；
   * 其它 enrich 失败仍不影响已就绪正文。
   */
  const applyServerMetadataEnrich = async (
    sessionId: string,
    localMessages: ChatMessage[],
    apply: (enriched: ChatMessage[]) => void,
    isLatest: () => boolean = () => true,
    spaceId?: string | null,
  ): Promise<void> => {
    try {
      const client = getChatClient()
      const response = await client.messages.list(sessionId, { limit: 50 })
      if (!isLatest()) return
      const current = get().messagesBySessionId[sessionId] ?? localMessages
      const enriched = enrichWithServerMetadata(current, response?.messages ?? [])
      if (enriched !== current) {
        apply(enriched)
        cacheMessages(sessionId, enriched)
      }
    } catch (err) {
      logger.warn('[localTranscript] metadata enrich failed', { sessionId, err })
      if (isSessionAccessDeniedError(err) && isLatest()) {
        await purgeUnauthorizedSessionContent(sessionId, spaceId)
      }
    }
  }

  const filterTombstonedSessions = (
    sessions: ChatSession[],
    options?: { retireAbsent?: boolean },
  ): ChatSession[] => {
    pruneExpiredTombstones()
    if (pendingArchivedSessionIds.size === 0) return sessions
    const filtered = sessions.filter(session => !pendingArchivedSessionIds.has(session.id))
    // 只根据服务端 list 退休墓碑。本地缓存已经下架过的列表不能当成「服务端已无此 id」。
    if (options?.retireAbsent !== false) {
      for (const id of [...pendingArchivedSessionIds.keys()]) {
        if (!sessions.some(session => session.id === id)) {
          pendingArchivedSessionIds.delete(id)
        }
      }
    }
    return filtered
  }

  const initializeLoadedSessionsReadBaseline = (sessions: ChatSession[]) => {
    const readStore = useSessionReadStore.getState()
    for (const session of sessions) {
      readStore.markViewedAtIfAbsent(
        session.id,
        session.last_message_at ?? session.updated_at ?? session.created_at ?? null,
      )
    }
  }

  /**
   * 真正打服务器的会话列表加载（loadSessions 的 fetch 内核）。
   * `showLoading=false` 时静默刷新（revalidate 路径），不碰全局 isLoading。
   *
   * ：发起前 capture epoch；写回经 commitSpaceSessionListMerge 门控 +
   * 按 id 合并（保留从未被 list 观察过的本地 upsert），禁止陈旧整桶覆盖。
   */
  const fetchSessionsFromServer = async (
    spaceId: string,
    organizationId: string | undefined,
    {
      showLoading,
      excludeAgentMentionSessions,
    }: {
      showLoading: boolean
      excludeAgentMentionSessions: boolean
    },
  ) => {
    const requestKey = `${spaceId}:${excludeAgentMentionSessions ? 'sidebar' : 'default'}`
    if (inflightSessionLoads.has(requestKey)) return
    inflightSessionLoads.add(requestKey)
    if (showLoading && resolveActiveSpaceId() === spaceId) set({ isLoading: true })
    const fetchEpoch = getSpaceSessionListEpoch(spaceId)
    try {
      const client = getChatClient()
      // 隐患 5 / 方案 ①（charter v1.8 §6.7 主侧栏分桶）：默认不要 Tracker
      // per_run session,后端会把它们剔除并附带 tracker_run_count；折叠分组
      // 首次展开时再调 loadTrackerRunSessions 单独 fetch。
      const response = await client.sessions.list({
        ...resolveChatSessionListQuery(spaceId),
        organization_id: organizationId,
        limit: 50,
        status: 'active',
        exclude_agent_mention_sessions: excludeAgentMentionSessions,
        include_tracker_runs: false,
      })
      const {
        sessions,
        tracker_run_count,
        excluded_agent_mention_session_ids = [],
      } = response
      const explicitlyExcludedIds = new Set(excluded_agent_mention_session_ids)
      useChatSplitStore.setState(state => ({
        pinnedSessionsBySpace: {
          ...state.pinnedSessionsBySpace,
          [spaceId]: sessions.filter(session => session.is_pinned === true).map(session => session.id),
        },
      }))
      // await 期间激活 space 可能已切换——覆盖 `sessions`（当前激活列表）前
      // 重新判定，避免响应把别的 space 列表写进当前视图。
      const syncCurrentNow = resolveActiveSpaceId() === spaceId
      const mergeOutcome = commitSpaceSessionListMerge(spaceId, fetchEpoch, () => {
        // 墓碑清理副作用：服务端已不含该 id 时清掉墓碑（与旧 filterTombstonedSessions 一致）
        filterTombstonedSessions(sessions)
        const { sessions: merged, nextObservedServerIds } = mergeServerSpaceSessionSnapshot({
          serverSessions: sessions,
          localSessions: get().sessionsBySpaceId[spaceId] ?? emptySessions,
          observedServerIds: getObservedServerSessionIds(spaceId),
          tombstoneIds: new Set([
            ...collectTombstoneIds(),
            ...explicitlyExcludedIds,
          ]),
          overlaySessions: collectOverlaySessionsForSpace(spaceId),
        })
        replaceObservedServerSessionIds(spaceId, nextObservedServerIds)
        get().setSpaceSessions(spaceId, merged, syncCurrentNow)
        initializeLoadedSessionsReadBaseline(merged)
        set((state: SessionCrudStore) => ({
          trackerRunCountBySpaceId: {
            ...state.trackerRunCountBySpaceId,
            // tracker_run_count 为 null/undefined 表示后端跨库 fallback,前端按"不显示 badge"处理
            [spaceId]: tracker_run_count ?? null,
          },
          ...(excludeAgentMentionSessions
            ? {
                excludedAgentMentionSessionIdsBySpaceId: {
                  ...state.excludedAgentMentionSessionIdsBySpaceId,
                  [spaceId]: excluded_agent_mention_session_ids,
                },
              }
            : {}),
        }))
      })
      if (mergeOutcome === 'stale-epoch') {
        trackChatTelemetry('session.load.stale_dropped', {
          spaceId,
          fetchEpoch,
          currentEpoch: getSpaceSessionListEpoch(spaceId),
        }, { counterKey: 'session.load.stale_dropped' })
      } else {
        logger.log('[Chat] Loaded', sessions.length, 'sessions (tracker_run_count=', tracker_run_count, ')')
        trackChatTelemetry('session.load.done', {
          spaceId,
          count: sessions.length,
          trackerRunCount: tracker_run_count ?? null,
        }, { counterKey: 'session.load.done' })
      }
      if (syncCurrentNow) set({ isLoading: false })
    } catch (error) {
      console.error('[Chat] Failed to load session list:', error)
      trackChatTelemetry('session.load.failed', {
        spaceId,
        message: error instanceof Error ? error.message : String(error),
      }, { counterKey: 'session.load.failed', level: 'error' })
      if (showLoading && resolveActiveSpaceId() === spaceId) set({ isLoading: false })
    } finally {
      inflightSessionLoads.delete(requestKey)
    }
  }

  return {
    /**
     * 加载 space 会话列表——stale-while-revalidate 语义（ 根因之一）。
     *
     * 历史行为是"缓存命中即永久短路"：某 space 列表一旦加载过（哪怕是空列表）
     * 就永远不再请求服务器。个人 workspace 下会话只有本人会建，问题不显；
     * 但 team_space 里其他成员随时可能新建会话（list_sessions 对 team_space
     * 返回全部成员的会话），永久缓存意味着本端永远看不到别人后建的会话。
     *
     * 现改为：缓存命中时**立即用缓存渲染并 resolve**（await 方语义不变、不闪
     * loading），同时后台静默 revalidate——每次挂载 / 切回 space 都会刷新一次。
     * 写回走 epoch 门控 + 按 id 合并，不再整桶覆盖抹掉本地 upsert。
     * WS ``agent.user.session_created`` 负责在线实时 upsert；丢事件时靠进入
     * Space 的 revalidate 兜底。无缓存时行为与旧版一致（等待服务器）。
     */
    loadSessions: async (
      spaceId: string,
      organizationId?: string,
      options?: { excludeAgentMentionSessions?: boolean },
    ) => {
      const cached = get().sessionsBySpaceId[spaceId]
      const excludeAgentMentionSessions = options?.excludeAgentMentionSessions === true
      const shouldSyncCurrent = resolveActiveSpaceId() === spaceId
      trackChatTelemetry('session.load.start', {
        spaceId,
        organizationId,
        cacheHit: cached !== undefined,
      }, { counterKey: 'session.load.start' })

      if (cached !== undefined) {
        // 读写回时用 live 桶，禁止用入口捕获的 stale `cached` 覆盖期间 upsert。
        const live = get().sessionsBySpaceId[spaceId] ?? cached
        get().setSpaceSessions(
          spaceId,
          mergeOverlaySessions(spaceId, filterTombstonedSessions(live, { retireAbsent: false })),
          shouldSyncCurrent,
        )
        if (shouldSyncCurrent) set({ isLoading: false })
        trackChatTelemetry('session.load.cache_hit', {
          spaceId,
          count: live.length,
        }, { counterKey: 'session.load.cache_hit' })
        // 后台 revalidate：不阻塞 caller（导航等路径 await 的是"列表可用"），
        // 拉到新数据后经 merge/epoch 门控写回。
        void fetchSessionsFromServer(spaceId, organizationId, {
          showLoading: false,
          excludeAgentMentionSessions,
        })
        return
      }

      await fetchSessionsFromServer(spaceId, organizationId, {
        showLoading: true,
        excludeAgentMentionSessions,
      })
    },

    /**
     * 隐患 5 / 方案 ①（charter v1.8 §6.7 主侧栏分桶）:懒加载 Tracker per_run
     * ChatSession 列表。ChatSessionSwitcher 的「自动化任务执行记录」折叠分组
     * 首次展开时调用本 action;后续展开/折叠不重复 fetch(除非 force=true 或
     * 上次失败重试)。
     *
     * 缓存策略:
     *   - trackerRunLoadedBySpaceId[spaceId]===true 且无 error → 直接返回缓存
     *   - error 状态下用户点 retry → force=true 重新拉
     *   - loadSessions 重置 sessionsBySpaceId 时不主动重置 tracker 缓存
     *     (用户折叠后切回 Space 不重新 fetch,但 tracker 列表可能略 stale
     *     —— 用 WS tracker.run_completed 事件兜底刷新见后续 Wave)
     */
    loadTrackerRunSessions: async (
      spaceId: string,
      organizationId?: string,
      opts?: { force?: boolean },
    ) => {
      const state = get()
      const force = opts?.force === true
      // 已加载且无错误 → 命中缓存,不重复 fetch
      if (
        !force
        && state.trackerRunLoadedBySpaceId[spaceId] === true
        && !state.trackerRunErrorBySpaceId[spaceId]
      ) {
        return
      }
      // 正在加载中 → 短路,避免并发重复请求
      if (state.trackerRunLoadingBySpaceId[spaceId]) return

      set((s: SessionCrudStore) => ({
        trackerRunLoadingBySpaceId: { ...s.trackerRunLoadingBySpaceId, [spaceId]: true },
        trackerRunErrorBySpaceId: { ...s.trackerRunErrorBySpaceId, [spaceId]: null },
      }))
      trackChatTelemetry('session.tracker_run.load.start', { spaceId, organizationId, force },
        { counterKey: 'session.tracker_run.load.start' })

      try {
        const client = getChatClient()
        const { sessions } = await client.sessions.list({
          ...resolveChatSessionListQuery(spaceId),
          organization_id: organizationId,
          limit: 200,
          status: 'active',
          include_tracker_runs: true,
        })
        set((s: SessionCrudStore) => ({
          trackerRunSessionsBySpaceId: { ...s.trackerRunSessionsBySpaceId, [spaceId]: sessions },
          trackerRunLoadingBySpaceId: { ...s.trackerRunLoadingBySpaceId, [spaceId]: false },
          trackerRunLoadedBySpaceId: { ...s.trackerRunLoadedBySpaceId, [spaceId]: true },
          trackerRunErrorBySpaceId: { ...s.trackerRunErrorBySpaceId, [spaceId]: null },
          // 同步刷新 count(让 header badge 与实际 fetch 到的行数对齐)
          trackerRunCountBySpaceId: { ...s.trackerRunCountBySpaceId, [spaceId]: sessions.length },
        }))
        trackChatTelemetry('session.tracker_run.load.done', { spaceId, count: sessions.length },
          { counterKey: 'session.tracker_run.load.done' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[Chat] Failed to load tracker-run sessions:', error)
        set((s: SessionCrudStore) => ({
          trackerRunLoadingBySpaceId: { ...s.trackerRunLoadingBySpaceId, [spaceId]: false },
          trackerRunErrorBySpaceId: { ...s.trackerRunErrorBySpaceId, [spaceId]: message },
        }))
        trackChatTelemetry('session.tracker_run.load.failed', { spaceId, message },
          { counterKey: 'session.tracker_run.load.failed', level: 'error' })
      }
    },

    /**
     * TS-29：把一条「带外」Tracker Run 的 ChatSession 合并进 trackerRunSessionsBySpaceId 分桶。
     *
     * 背景：自动化 Run 会话被刻意排除出主会话列表（loadSessions 走
     * include_tracker_runs=false），只在「自动化任务执行记录」折叠分组里懒加载。
     * 当用户从 Tracker 详情页直接点「最新执行」跳入这条 Run 会话时，该 session
     * 既不在 sessionsBySpaceId（主列表）也未必在 trackerRunSessionsBySpaceId（分组
     * 没展开过就没拉），导致 ChatPanel 生命周期的「草稿回退」判定把它当成"未知
     * session"踢回草稿态（见 useChatPanelLifecycle.ts 会话初始化 effect）。
     *
     * 本 action 让 enterChatSession 在选中前把目标 session 注入分桶（合并不覆盖、
     * 去重），生命周期判定即可识别它、不回退。only 注入、不触发任何网络请求。
     *
     * ：禁止把 trackerRunLoadedBySpaceId 标为 true——单条注入不等于完整 list
     * 已拉取；否则后续展开会短路，侧栏长期只剩点过的几条。
     */
    upsertTrackerRunSession: (spaceId: string, session: ChatSession) => {
      const snapshot = get()
      Object.entries(snapshot.sessionsBySpaceId).forEach(([bucketSpaceId, sessions]) => {
        if (sessions.some(item => item.id === session.id)) {
          recordSpaceSessionListMutation(
            bucketSpaceId,
            'upsertTrackerRunSession.removeMainListDuplicate',
          )
        }
      })
      set((state: SessionCrudStore) => {
        const trackerRunSessionsBySpaceId = Object.fromEntries(
          Object.entries(state.trackerRunSessionsBySpaceId).map(([bucketSpaceId, sessions]) => [
            bucketSpaceId,
            sessions.filter(item => item.id !== session.id),
          ]),
        )
        const next = [
          session,
          ...(trackerRunSessionsBySpaceId[spaceId] ?? []),
        ]
        trackerRunSessionsBySpaceId[spaceId] = next
        // Tracker Run 不属于普通会话侧栏。若旧缓存或竞态曾把同一 session
        // 注入普通桶，在权威 tracker metadata 到达时一并清理，避免重复展示。
        const sessionsBySpaceId = Object.fromEntries(
          Object.entries(state.sessionsBySpaceId).map(([bucketSpaceId, sessions]) => [
            bucketSpaceId,
            sessions.filter(item => item.id !== session.id),
          ]),
        )
        return {
          sessions: state.sessions.filter(item => item.id !== session.id),
          sessionsBySpaceId,
          trackerRunSessionsBySpaceId,
          trackerRunCountBySpaceId: {
            ...state.trackerRunCountBySpaceId,
            [spaceId]: Math.max(state.trackerRunCountBySpaceId[spaceId] ?? 0, next.length),
          },
        }
      })
    },

    upsertSessionInSpace: (spaceId: string, session: ChatSession) => {
      const existing = get().sessionsBySpaceId[spaceId]
      if (existing === undefined) {
        // 桶尚未加载（常见于 loadSessions 仍在途）：用新会话初始化桶，
        // 避免「频道消息 → Agent 任务」等本地创建路径 upsert 被静默丢弃。
        recordSpaceSessionListMutation(spaceId, 'upsert')
        const shouldSync = resolveActiveSpaceId() === spaceId
        get().setSpaceSessions(spaceId, [session], shouldSync)
        return
      }
      if (existing.some(s => s.id === session.id)) return
      recordSpaceSessionListMutation(spaceId, 'upsert')
      const shouldSync = resolveActiveSpaceId() === spaceId
      get().setSpaceSessions(spaceId, sortSessionsByActivity([session, ...existing]), shouldSync)
    },

    pinSessionInSpace: (spaceId: string, session: ChatSession) => {
      pinOverlaySession(spaceId, session)
      get().upsertSessionInSpace(spaceId, session)
    },

    loadSessionMessages: async (sessionId: string) => {
      if (!sessionId) return
      const memoryCached = get().messagesBySessionId[sessionId]
      if (memoryCached !== undefined) return

      const idbCached = await getCachedMessages(sessionId)
      if (idbCached && idbCached.length > 0) {
        get().hydrateFromCache(sessionId, idbCached)
        touchSessionMeta(sessionId)
      }

      // ：本机会话正文以 runtime transcript 为唯一权威（分屏 / 非当前会话同款）。
      // 续接短记录缺 share_snapshot 时先和缓存/服务端快照合并，避免盖掉原任务。
      const local = await tryLoadLocalTranscript(sessionId, resolveLocalCtx(sessionId))
      if (local && countVisibleTimelineMessages(local) > 0) {
        const spaceId = resolveLocalCtx(sessionId).spaceId
        const prior = get().messagesBySessionId[sessionId] ?? idbCached ?? []
        try {
          const hydrated = await hydrateLocalTranscriptWithContinuationSnapshot({
            local,
            prior,
            session: resolveSessionRecord(get(), sessionId, spaceId),
            listLatest: () => listLatestSessionMessages(getChatClient(), sessionId),
          })
          get().applyLoadedMessages(sessionId, hydrated.messages)
          const hasEarlier = hydrated.hasEarlier
          if (hasEarlier !== undefined) {
            set((state: SessionCrudStore) => ({
              hasMoreBySessionId: { ...state.hasMoreBySessionId, [sessionId]: hasEarlier },
            }))
          }
          markSessionFresh(sessionId)
          cacheMessages(sessionId, hydrated.messages)
          if (!hydrated.usedServerSnapshot) {
            await applyServerMetadataEnrich(
              sessionId,
              hydrated.messages,
              (enriched) => get().applyLoadedMessages(sessionId, enriched),
              () => true,
              spaceId,
            )
          }
          return
        } catch (err) {
          logger.warn('[localTranscript] continuation snapshot hydrate failed', { sessionId, err })
        }
      }

      try {
        const client = getChatClient()
        // ：fetch 前捕获写入权威 epoch；merge + 门控 + 写 + cache 内聚在 reconcileFromServer。
        const fetchEpoch = getSessionMessagesFacade(sessionId).captureEpoch()
        const response = await client.messages.list(sessionId, { limit: 50 })
        const messages: ChatMessage[] = response?.messages ?? (Array.isArray(response) ? response : [])
        // ：与全局对账同一套 upsert
        const result = get().reconcileFromServer(sessionId, fetchEpoch, messages)
        if (result.dropped) {
          markSessionStale(sessionId)
        } else {
          set((state: SessionCrudStore) => ({
            hasMoreBySessionId: { ...state.hasMoreBySessionId, [sessionId]: response?.has_more ?? false },
          }))
          markSessionFresh(sessionId)
        }

        if (response?.show_per_message_cost != null) {
          const { useBillingStore } = await import('@/stores/useBillingStore')
          useBillingStore.getState().setShowPerMessageCost(!!response.show_per_message_cost)
        }
      } catch (error) {
        console.error('[Chat] loadSessionMessages failed:', error)
        markSessionStale(sessionId, error)
        if (isSessionAccessDeniedError(error)) {
          await purgeUnauthorizedSessionContent(sessionId, resolveLocalCtx(sessionId).spaceId)
          return
        }
        if (!idbCached || idbCached.length === 0) {
          get().clearSessionMessages(sessionId)
        }
      }
    },

    loadMoreMessages: async (sessionId: string) => {
      if (!sessionId) return
      const state = get()
      if (state.isLoadingMoreBySessionId[sessionId]) return
      if (state.hasMoreBySessionId[sessionId] === false) return

      const existing = state.messagesBySessionId[sessionId]
      if (!existing || existing.length === 0) return

      const oldestId = existing[0]?.id
      if (!oldestId) return

      set((s: SessionCrudStore) => ({
        isLoadingMoreBySessionId: { ...s.isLoadingMoreBySessionId, [sessionId]: true },
      }))

      try {
        const client = getChatClient()
        // epoch 门控统一经会话消息门面。
        const facade = getSessionMessagesFacade(sessionId)
        // ：fetch 前捕获写入权威 epoch，写回经 commitServerMerge 门控。
        const fetchEpoch = facade.captureEpoch()
        const response = await client.messages.list(sessionId, {
          limit: 30,
          before: oldestId,
        })
        const olderMessages: ChatMessage[] = response?.messages ?? []

        if (olderMessages.length > 0) {
          facade.commitServerMerge(fetchEpoch, () => {
            // 去重 + 时间线重排在 prependOlderMessages 内聚；IDB 只追加实际新增 id。
            const beforeIds = new Set(
              (get().messagesBySessionId[sessionId] ?? []).map((m) => m.id),
            )
            get().prependOlderMessages(sessionId, olderMessages)
            const added = (get().messagesBySessionId[sessionId] ?? [])
              .filter((m) => !beforeIds.has(m.id))
            if (added.length > 0) appendCachedMessages(sessionId, added)
          })
        }

        set((s: SessionCrudStore) => ({
          hasMoreBySessionId: { ...s.hasMoreBySessionId, [sessionId]: response?.has_more ?? false },
          isLoadingMoreBySessionId: { ...s.isLoadingMoreBySessionId, [sessionId]: false },
        }))
      } catch (error) {
        console.error('[Chat] loadMoreMessages failed:', error)
        set((s: SessionCrudStore) => ({
          isLoadingMoreBySessionId: { ...s.isLoadingMoreBySessionId, [sessionId]: false },
        }))
      }
    },

    selectSession: async (
      spaceId: string,
      sessionId: string,
      options?: SessionSelectionOptions,
    ) => {
      const requestVersion = ++selectRequestVersion
      latestSelectRequestBySessionId.set(sessionId, requestVersion)
      const activeSpaceId = resolveActiveSpaceId()
      const shouldSyncCurrent = activeSpaceId === spaceId
      const sharedAccess = options?.sharedAccess
      const initialMessagePage = options?.initialMessagePage ?? 'default'
      if (sharedAccess?.shareId) {
        useSessionAccessStore.getState().setSharedAccess({
          ...sharedAccess,
          sessionId,
        })
      } else {
        useSessionAccessStore.getState().clearSharedAccess(sessionId)
      }
      trackChatTelemetry('session.select.start', { spaceId, sessionId, shouldSyncCurrent },
        { counterKey: 'session.select.start', sessionId })

      const spaceSessions = get().sessionsBySpaceId[spaceId]
      if (shouldSyncCurrent && spaceSessions) {
        set({ sessions: spaceSessions })
      }
      if (shouldSyncCurrent) {
        set({ isLoading: true })
      }
      // /#7067：主链显式传 draftScopeKey，cancel 不得用 execution B 反查 Project A
      get().setCurrentSessionForSpace(spaceId, sessionId, shouldSyncCurrent, options)

      if (!sharedAccess) void ensureGroupRuntimeSynced(sessionId)

      const isLatestRequest = () => latestSelectRequestBySessionId.get(sessionId) === requestVersion

      const applyMessages = (msgs: ChatMessage[], hasMore?: boolean) => {
        if (!isLatestRequest()) return
        get().applyLoadedMessages(sessionId, msgs)
        useSessionReadStore.getState().markViewed(sessionId)
        const ckptMap = buildCheckpointMapFromMessages(msgs)
        const shouldApplyToCurrent = shouldSyncCurrent && get().currentSessionId === sessionId
        if (shouldApplyToCurrent) {
          const restored = restoreRuntimeStateFromHistory(msgs)
          const restoredAgentSteps = restored.agentSteps.length > 0 ? restored.agentSteps : []
          const restoredToolEvents = restored.toolEvents.length > 0 ? restored.toolEvents : []
          set((s: SessionCrudStore) => ({
            isLoading: false,
            checkpointsBySessionId: { ...s.checkpointsBySessionId, [sessionId]: ckptMap },
            lastContextSyncFingerprintBySessionId: {},
          }))
          useChatRuntimeStore.setState(rs => ({
            agentStepsBySessionId: { ...rs.agentStepsBySessionId, [sessionId]: restoredAgentSteps },
            toolEventsBySessionId: { ...rs.toolEventsBySessionId, [sessionId]: restoredToolEvents },
          }))
          // ：待办清单不再恢复到 runtime 状态——TodoPanel / 完成卡都从
          // message.blocks 的 todo block 纯派生（deriveTodoTimeline），
          // 历史消息进 store 后 useTodoTimeline 自然算出，无需在此重放写入。
          // ：优先 ChatSession.agent_mode，再 fallback 消息 metadata。
          const sessionForArchive = get().sessions.find(s => s.id === sessionId)
            ?? get().sessionsBySpaceId[spaceId]?.find(s => s.id === sessionId)
          const sessionModeRaw = sessionForArchive?.agent_mode
          const preferredRestoredMode = isAgentModeName(sessionModeRaw)
            ? sessionModeRaw
            : restored.agentMode
          if (preferredRestoredMode) {
            useChatRuntimeStore.setState(rs => {
              const nextMode = mergeRestoredSessionAgentMode(
                rs.agentModeBySessionId[sessionId],
                preferredRestoredMode,
              )
              if (!nextMode || nextMode === rs.agentModeBySessionId[sessionId]) return rs
              return {
                agentModeBySessionId: {
                  ...rs.agentModeBySessionId,
                  [sessionId]: nextMode,
                },
              }
            })
          }

        }
        if (hasMore !== undefined) {
          set((s: SessionCrudStore) => ({
            hasMoreBySessionId: { ...s.hasMoreBySessionId, [sessionId]: hasMore },
          }))
        }
      }

      const syncInBackground = async () => {
        const client = getChatClient()
        //  / ：背景同步与全局对账同一 reconcileFromServer（含 epoch + cache）。
        const fetchEpoch = getSessionMessagesFacade(sessionId).captureEpoch()
        listInitialMessages(
          client,
          sessionId,
          sharedAccess ? { shareId: sharedAccess.shareId } : undefined,
          initialMessagePage,
        ).then(({ messages: fresh, hasEarlier }) => {
          if (!isLatestRequest()) return
          const result = get().reconcileFromServer(sessionId, fetchEpoch, fresh)
          if (result.dropped) {
            markSessionStale(sessionId)
            return
          }
          const resolved = get().messagesBySessionId[sessionId] ?? fresh
          if (get().currentSessionId === sessionId) {
            // 补 checkpoint / runtime 恢复等副作用（消息已由 reconcile 写入）
            applyMessages(resolved, hasEarlier)
          } else {
            set((s: SessionCrudStore) => ({
              hasMoreBySessionId: { ...s.hasMoreBySessionId, [sessionId]: hasEarlier },
            }))
          }
          markSessionFresh(sessionId)
        }).catch(err => {
          console.warn('[Chat] Background sync failed:', err)
          markSessionStale(sessionId, err)
          if (isSessionAccessDeniedError(err) && isLatestRequest()) {
            void purgeUnauthorizedSessionContent(sessionId, spaceId)
          }
        })
      }

      // ：本机会话读 transcript 作正文权威，DB 照拉只补非正文增强字段。
      const enrichLocalInBackground = (localMessages: ChatMessage[]) => {
        void applyServerMetadataEnrich(
          sessionId,
          localMessages,
          (enriched) => applyMessages(enriched, false),
          isLatestRequest,
          spaceId,
        )
      }

      const applyLocalTranscript = async (
        localMessages: ChatMessage[],
        prior: readonly ChatMessage[],
      ): Promise<boolean> => {
        try {
          const hydrated = await hydrateLocalTranscriptWithContinuationSnapshot({
            local: localMessages,
            prior,
            session: resolveSessionRecord(get(), sessionId, spaceId),
            listLatest: () => listLatestSessionMessages(
              getChatClient(),
              sessionId,
              sharedAccess ? { shareId: sharedAccess.shareId } : undefined,
            ),
          })
          if (!isLatestRequest()) return true
          applyMessages(hydrated.messages, hydrated.hasEarlier)
          cacheMessages(sessionId, hydrated.messages)
          markSessionFresh(sessionId)
          if (!hydrated.usedServerSnapshot) {
            enrichLocalInBackground(hydrated.messages)
          }
        } catch (err) {
          logger.warn('[localTranscript] continuation snapshot hydrate failed', { sessionId, err })
          if (!isLatestRequest()) return true
          applyMessages(mergeTranscriptPreservingShareSnapshot(localMessages, prior))
          markSessionStale(sessionId, err)
        }
        return true
      }

      const localCtx = resolveLocalCtx(sessionId, spaceId)

      try {
        let cached = initialMessagePage === 'latest'
          ? undefined
          : get().messagesBySessionId[sessionId]
        if (!cached) {
          if (initialMessagePage !== 'latest') {
            const idbCached = await getCachedMessages(sessionId)
            if (!isLatestRequest()) return
            if (idbCached && idbCached.length > 0) {
              cached = idbCached
              touchSessionMeta(sessionId)
              trackChatTelemetry('session.select.idb_cache_hit', { sessionId, messageCount: idbCached.length },
                { counterKey: 'session.select.idb_cache_hit', sessionId })
            }
          }
        }

        if (cached) {
          applyMessages(cached)
          trackChatTelemetry('session.select.cache_hit', { sessionId, messageCount: cached.length },
            { counterKey: 'session.select.cache_hit', sessionId })
          // 本机会话：IDB 快照仅作首屏加速，runtime transcript 到手后覆盖为权威。
          // 续接新任务（latest）以服务端快照为准，不把本机空/隐藏 transcript 当权威。
          const local = (sharedAccess || initialMessagePage === 'latest')
            ? null
            : await tryLoadLocalTranscript(sessionId, localCtx)
          if (!isLatestRequest()) return
          if (local && countVisibleTimelineMessages(local) > 0) {
            // ：runtime transcript 是正文权威，但旧 block 记录可能尚无 agent_id。
            // 切回会话前的内存 / IDB cache 已由 server merge 补过轮级身份，先把这类
            // 非正文元数据补回 local，避免权威正文覆盖时让 TurnAgentBadge 消失。
            // O1 / ：transcript 不含本机注入的外来行/横幅/边界，覆盖前从 cache 插回。
            // ：await 期间流式仍在写——必须用此刻 live 快照，不能用 await 前的陈旧 cached；
            // 并保住 live blocks / 尚未落盘的流式行，避免切回后 mid-string 起笔。
            const liveNow = get().messagesBySessionId[sessionId] ?? cached
            const mergedLocal = mergeTranscriptPreservingExternalArchive(local, liveNow)
            const withSnapshots = mergeTranscriptPreservingShareSnapshot(mergedLocal, liveNow)
            const withLiveBlocks = preserveLiveRuntimeOnTranscriptMerge(withSnapshots, liveNow)
            const enrichedLocal = enrichWithServerMetadata(withLiveBlocks, liveNow)
            await applyLocalTranscript(enrichedLocal, liveNow)
            return
          }
          const reconciled = deps.reconcileRevertedSession?.(sessionId) ?? false
          if (!reconciled) {
            syncInBackground()
          }
          return
        }

        // 无缓存：先试本机 transcript（冷启动直读盘，根治  重启丢指令）。
        // 续接新任务或本机只有隐藏 briefing/契约时，回落服务端快照，避免空首屏。
        const local = (sharedAccess || initialMessagePage === 'latest')
          ? null
          : await tryLoadLocalTranscript(sessionId, localCtx)
        if (!isLatestRequest()) return
        if (local && countVisibleTimelineMessages(local) > 0) {
          await applyLocalTranscript(local, get().messagesBySessionId[sessionId] ?? [])
          trackChatTelemetry('session.select.done', { sessionId, messageCount: local.length, source: 'local' },
            { counterKey: 'session.select.done', sessionId })
          return
        }

        const client = getChatClient()
        //  / ：首屏无缓存同样走 reconcileFromServer（空本地时 merge 会 hydrate）。
        const fetchEpoch = getSessionMessagesFacade(sessionId).captureEpoch()
        const { messages, hasEarlier } = await listInitialMessages(
          client,
          sessionId,
          sharedAccess ? { shareId: sharedAccess.shareId } : undefined,
          initialMessagePage,
        )
        if (!isLatestRequest()) return
        const result = get().reconcileFromServer(sessionId, fetchEpoch, messages)
        if (result.dropped) {
          markSessionStale(sessionId)
        } else {
          const resolved = get().messagesBySessionId[sessionId] ?? messages
          applyMessages(resolved, hasEarlier)
          markSessionFresh(sessionId)
        }
        trackChatTelemetry('session.select.done', { sessionId, messageCount: messages.length },
          { counterKey: 'session.select.done', sessionId })
      } catch (error) {
        console.error('[Chat] Failed to load messages:', error)
        markSessionStale(sessionId, error)
        if (!isLatestRequest()) return
        if (isSessionAccessDeniedError(error)) {
          await purgeUnauthorizedSessionContent(sessionId, spaceId)
          trackChatTelemetry('session.select.denied', {
            sessionId, message: error instanceof Error ? error.message : String(error),
          }, { level: 'warn', counterKey: 'session.select.denied', sessionId })
          return
        }
        get().clearSessionMessages(sessionId)
        if (shouldSyncCurrent) {
          if (get().currentSessionId !== sessionId) return
          set((s: SessionCrudStore) => ({
            isLoading: false,
            checkpointsBySessionId: { ...s.checkpointsBySessionId, [sessionId]: {} },
            lastContextSyncFingerprintBySessionId: {},
          }))
        }
        trackChatTelemetry('session.select.failed', {
          sessionId, message: error instanceof Error ? error.message : String(error),
        }, { level: 'error', counterKey: 'session.select.failed', sessionId })
      }
    },

    renameSession: async (spaceId: string, sessionId: string, title: string): Promise<void> => {
      const nextTitle = title.trim()
      if (!nextTitle) {
        throw new Error('Session title cannot be empty')
      }

      trackChatTelemetry('session.rename.start', { spaceId, sessionId }, { counterKey: 'session.rename.start', sessionId })
      try {
        const client = getChatClient()
        const updatedSession = await client.sessions.update(sessionId, { title: nextTitle })
        markSessionManualTitle(sessionId, updatedSession.title || nextTitle)
        const patch: Partial<ChatSession> = {
          ...updatedSession,
          title_is_default: false,
          title_generation_status: updatedSession.title_generation_status ?? 'done',
        }
        if (updatedSession.last_message_preview == null) {
          delete patch.last_message_preview
        }
        get().updateSessionInCaches(sessionId, patch)
        trackChatTelemetry('session.rename.done', { spaceId, sessionId }, { counterKey: 'session.rename.done', sessionId })
        logger.log('[Chat] Session renamed:', sessionId)
      } catch (error) {
        console.error('[Chat] Failed to rename session:', error)
        trackChatTelemetry('session.rename.failed', {
          spaceId,
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        }, { counterKey: 'session.rename.failed', level: 'error', sessionId })
        throw error
      }
    },

    discardAbandonedEmptySessions: (input: {
      sessionIds: readonly string[]
      reason: AbandonedEmptyDiscardReason
      draftSessionPhase?: 'open' | 'sending' | null
      sessionSpaceById?: Record<string, string | undefined>
    }) => {
      const state = get()
      const candidates = selectAbandonedEmptySessions({
        sessionIds: input.sessionIds,
        sessionsBySpaceId: state.sessionsBySpaceId,
        messagesBySessionId: state.messagesBySessionId,
        draftSessionPhase: input.draftSessionPhase,
        sessionSpaceById: input.sessionSpaceById,
        isDraftSessionReleased,
      })
      if (candidates.length === 0) return

      const client = getChatClient()
      for (const { sessionId, spaceId } of candidates) {
        void (async () => {
          if (!await beginProvisionalSessionDiscard(sessionId)) return
          try {
            await client.sessions.delete(sessionId)
            await completeProvisionalSessionDiscard(sessionId, true)
            markSessionArchivedTombstone(sessionId)
            recordSpaceSessionListMutation(spaceId, 'archive')
            set((prev: SessionCrudStore) => {
              const sessionsBySpaceId = { ...prev.sessionsBySpaceId }
              sessionsBySpaceId[spaceId] = (sessionsBySpaceId[spaceId] ?? emptySessions)
                .filter((session) => session.id !== sessionId)
              const nextMessagesBySessionId = { ...prev.messagesBySessionId }
              delete nextMessagesBySessionId[sessionId]
              const clearSpacePointer = prev.currentSessionIdBySpaceId[spaceId] === sessionId
              const currentSessionIdBySpaceId = clearSpacePointer
                ? { ...prev.currentSessionIdBySpaceId, [spaceId]: null }
                : prev.currentSessionIdBySpaceId
              const activeSpaceId = resolveActiveSpaceId()
              return {
                sessionsBySpaceId,
                messagesBySessionId: nextMessagesBySessionId,
                ...(clearSpacePointer ? { currentSessionIdBySpaceId } : {}),
                ...(prev.currentSessionId === sessionId ? { currentSessionId: null } : {}),
                ...(activeSpaceId === spaceId
                  ? { sessions: sessionsBySpaceId[spaceId] ?? emptySessions }
                  : {}),
                ...evictChatStoreSessionDataBatch(prev, [sessionId]),
              }
            })
            useChatRuntimeStore.getState().evictSession(sessionId)
            useSessionReadStore.getState().clearSession(sessionId)
            clearSessionLocalModelPreference(sessionId)
            trackChatTelemetry('session.abandoned_empty.deleted', {
              spaceId,
              sessionId,
              reason: input.reason,
            }, { counterKey: 'session.abandoned_empty.deleted', sessionId })
            logger.log('[Chat] Abandoned empty session deleted:', sessionId, input.reason)
          } catch (error) {
            await completeProvisionalSessionDiscard(sessionId, false)
            trackChatTelemetry('session.abandoned_empty.delete_failed', {
              spaceId,
              sessionId,
              reason: input.reason,
              message: error instanceof Error ? error.message : String(error),
            }, {
              counterKey: 'session.abandoned_empty.delete_failed',
              level: 'warn',
              sessionId,
            })
            logger.warn('[Chat] Abandoned empty session delete failed:', sessionId, error)
          }
        })()
      }
    },

    beginOptimisticArchive: (spaceId: string, sessionId: string) => {
      return applyOptimisticArchiveRemoval(spaceId, sessionId, { switchCurrent: false })
    },

    rollbackOptimisticArchive: (_spaceId: string, sessionId: string) => {
      restoreOptimisticArchiveRemoval(sessionId)
    },

    deleteSession: async (spaceId: string, sessionId: string) => {
      let persisted = false
      try {
        const client = getChatClient()
        applyOptimisticArchiveRemoval(spaceId, sessionId)
        await stopBusyHostRunBeforeArchive(sessionId)
        await client.sessions.update(sessionId, { status: 'archived' })
        persisted = true
        optimisticArchiveSnapshots.delete(sessionId)

        set((state: SessionCrudStore) => evictChatStoreSessionData(state, sessionId))
        useChatRuntimeStore.getState().evictSession(sessionId)

        useChatSplitStore.getState().cleanupDeletedSession(spaceId, sessionId)
        useSessionReadStore.getState().clearSession(sessionId)
        // PRD §4.2 / §4.13：父 session 删除后清掉工作台里残留的 subagent_session
        // 标签，避免 ghost tab（用户感受：删了对话还能看到该对话派出去的子 Agent
        // 标签，点进去是 error 态）。clearOrphanSubagentTabs 内部走 batchCloseTab，
        // 与用户手动 × 关闭等效。
        useSpaceContextTabsStore.getState().clearOrphanSubagentTabs(spaceId, sessionId)
        // 桌面/对话边界 Phase 2（PRD §5「删对话即清其标签 scope」）：对话标签组跟随
        // 对话生命周期。删会话时清掉该对话的 conversation scope 标签桶（tabOrder/
        // items/active/display），避免 localStorage 无界泄漏。
        useSpaceContextTabsStore.getState().clearSpaceTabs(`conversation:${sessionId}`)

        logger.log('[Chat] Session archived:', sessionId)
        trackChatTelemetry('session.archive.done', { spaceId, sessionId }, { counterKey: 'session.archive.done', sessionId })
      } catch (error) {
        if (!persisted) {
          restoreOptimisticArchiveRemoval(sessionId)
        }
        console.error('[Chat] Failed to archive session:', error)
        trackChatTelemetry('session.archive.failed', { spaceId, sessionId, message: error instanceof Error ? error.message : String(error) }, { counterKey: 'session.archive.failed', level: 'error', sessionId })
        throw error
      }
    },

    deleteSessionPermanently: async (spaceId: string, sessionId: string) => {
      try {
        const client = getChatClient()
        markSessionArchivedTombstone(sessionId)
        recordSpaceSessionListMutation(spaceId, 'deletePermanent')
        await client.sessions.delete(sessionId)

        set((state: SessionCrudStore) => {
          const activeASId = resolveActiveSpaceId()
          const sync = activeASId === spaceId
          const asSessions = state.sessionsBySpaceId[spaceId] ?? emptySessions
          const nextAsSessions = asSessions.filter(s => s.id !== sessionId)
          const asCurrId = state.currentSessionIdBySpaceId[spaceId] ?? null
          const nextAsCurrId = asCurrId === sessionId ? (nextAsSessions[0]?.id || null) : asCurrId
          const nextMessagesBySession = { ...state.messagesBySessionId }
          delete nextMessagesBySession[sessionId]
          const nextCheckpointsBySession = { ...state.checkpointsBySessionId }
          delete nextCheckpointsBySession[sessionId]

          return {
            sessions: sync ? nextAsSessions : state.sessions,
            sessionsBySpaceId: { ...state.sessionsBySpaceId, [spaceId]: nextAsSessions },
            ...removeTrackerRunSessionFromCaches(state, sessionId),
            currentSessionId: sync ? nextAsCurrId : state.currentSessionId,
            currentSessionIdBySpaceId: { ...state.currentSessionIdBySpaceId, [spaceId]: nextAsCurrId },
            messagesBySessionId: nextMessagesBySession,
            checkpointsBySessionId: nextCheckpointsBySession,
            ...evictChatStoreSessionData(state, sessionId),
          }
        })
        useChatRuntimeStore.getState().evictSession(sessionId)

        useChatSplitStore.getState().cleanupDeletedSession(spaceId, sessionId)
        useSessionReadStore.getState().clearSession(sessionId)
        clearSessionLocalModelPreference(sessionId)
        useSpaceContextTabsStore.getState().clearOrphanSubagentTabs(spaceId, sessionId)
        // 桌面/对话边界 Phase 2（PRD §5「删对话即清其标签 scope」）：同 deleteSession，
        // 永久删除时一并清掉该对话的 conversation scope 标签桶。
        useSpaceContextTabsStore.getState().clearSpaceTabs(`conversation:${sessionId}`)
        // 会话代码根：永久删除时清 renderer 镜像 + main Map + 本机 sidecar（await 落盘）
        useSessionBoundCodeRootStore.getState().clearBindingsForSession(sessionId)
        try {
          await clearSessionCodeRoot(sessionId)
        } catch (err) {
          logger.warn('[Chat] clearSessionCodeRoot after permanent delete failed:', err)
        }

        logger.log('[Chat] Session permanently deleted:', sessionId)
        trackChatTelemetry('session.delete.done', { spaceId, sessionId }, { counterKey: 'session.delete.done', sessionId })
      } catch (error) {
        console.error('[Chat] Failed to permanently delete session:', error)
        trackChatTelemetry('session.delete.failed', { spaceId, sessionId, message: error instanceof Error ? error.message : String(error) }, { counterKey: 'session.delete.failed', level: 'error', sessionId })
        throw error
      }
    },

    listArchivedSessions: async (spaceId: string, organizationId?: string, limit = 200): Promise<ChatSession[]> => {
      const client = getChatClient()
      const { sessions } = await client.sessions.list({
        ...resolveChatSessionListQuery(spaceId),
        organization_id: organizationId,
        limit,
        status: 'archived',
      })
      return sessions
    },

    /**
     * ：查看归档会话——不改 status，只打开正文并可继续聊。
     * 钉进 sessionsBySpaceId，避免 reconcileSpacePointer 因「不在 active 列表」打回草稿。
     */
    viewArchivedSession: async (spaceId: string, session: ChatSession): Promise<void> => {
      const sessionId = session.id
      trackChatTelemetry('session.view_archived.start', { spaceId, sessionId }, {
        counterKey: 'session.view_archived.start',
        sessionId,
      })
      try {
        const overlay: ChatSession = { ...session, status: session.status || 'archived' }
        pinOverlaySession(spaceId, overlay)
        get().upsertSessionInSpace(spaceId, overlay)
        await get().selectSession(spaceId, sessionId)
        get().setCurrentSessionForSpace(spaceId, sessionId, true)
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve())
        })
        get().setCurrentSessionForSpace(spaceId, sessionId, true)
        logger.log('[Chat] Archived session opened for viewing:', sessionId)
        trackChatTelemetry('session.view_archived.done', { spaceId, sessionId }, {
          counterKey: 'session.view_archived.done',
          sessionId,
        })
      } catch (error) {
        console.error('[Chat] Failed to view archived session:', error)
        trackChatTelemetry('session.view_archived.failed', {
          spaceId,
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        }, { counterKey: 'session.view_archived.failed', level: 'error', sessionId })
        throw error
      }
    },

    /**
     * ：取消归档——`PUT status=active` 写回主列表（与 deleteSession 对称）。
     */
    restoreSession: async (spaceId: string, sessionId: string): Promise<ChatSession> => {
      trackChatTelemetry('session.restore.start', { spaceId, sessionId }, { counterKey: 'session.restore.start', sessionId })
      try {
        const client = getChatClient()
        pendingArchivedSessionIds.delete(sessionId)
        const updatedSession = await client.sessions.update(sessionId, { status: 'active' })
        pinOverlaySession(spaceId, updatedSession)
        recordSpaceSessionListMutation(spaceId, 'restore')

        set((state: SessionCrudStore) => {
          const sync = resolveActiveSpaceId() === spaceId
          const existing = state.sessionsBySpaceId[spaceId] ?? emptySessions
          const nextSpaceSessions = existing.some(s => s.id === sessionId)
            ? existing.map(s => (s.id === sessionId ? updatedSession : s))
            : sortSessionsByActivity([updatedSession, ...existing])
          return {
            sessions: sync ? nextSpaceSessions : state.sessions,
            sessionsBySpaceId: { ...state.sessionsBySpaceId, [spaceId]: nextSpaceSessions },
          }
        })

        logger.log('[Chat] Session restored:', sessionId)
        trackChatTelemetry('session.restore.done', { spaceId, sessionId }, { counterKey: 'session.restore.done', sessionId })
        return updatedSession
      } catch (error) {
        console.error('[Chat] Failed to restore session:', error)
        trackChatTelemetry('session.restore.failed', {
          spaceId,
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        }, { counterKey: 'session.restore.failed', level: 'error', sessionId })
        throw error
      }
    },

    unforkSession: async (spaceId: string, sessionId: string): Promise<ChatSession | null> => {
      const existing = get().sessions.find((item) => item.id === sessionId)
        ?? (get().sessionsBySpaceId[spaceId] || []).find((item) => item.id === sessionId)
      const parentId = existing?.forked_from_id ?? null
      trackChatTelemetry('session.unfork.start', { spaceId, sessionId, parentId }, {
        counterKey: 'session.unfork.start',
        sessionId,
      })
      try {
        const client = getChatClient()
        const updated = await client.sessions.unfork(sessionId)
        const clearLineage = {
          forked_from_id: null as string | null,
          fork_point_message_id: null as string | null,
        }
        const patchList = (list: ChatSession[]) => list.map((item) => {
          if (item.id === sessionId) {
            // 服务端若未带 message_count（null），保留列表缓存原值，避免误判为草稿铅笔
            const nextMessageCount = updated.message_count ?? item.message_count
            return {
              ...item,
              ...updated,
              ...clearLineage,
              message_count: nextMessageCount,
            }
          }
          if (parentId && item.id === parentId) {
            return {
              ...item,
              fork_count: Math.max(0, (item.fork_count ?? 1) - 1),
            }
          }
          return item
        })
        set((state) => {
          const spaceSessionsMap: Record<string, ChatSession[]> = {}
          Object.entries(state.sessionsBySpaceId).forEach(([sid, list]) => {
            spaceSessionsMap[sid] = patchList(list)
          })
          return {
            sessions: patchList(state.sessions),
            sessionsBySpaceId: spaceSessionsMap,
          }
        })
        trackChatTelemetry('session.unfork.done', { spaceId, sessionId, parentId }, {
          counterKey: 'session.unfork.done',
          sessionId,
        })
        toast({ title: i18n.t('chat:session.unforkSuccessToast', { defaultValue: '已弹出为独立对话' }), duration: 2500 })
        return updated
      } catch (error) {
        console.error('[Chat] Failed to unfork session:', error)
        toast({
          title: i18n.t('chat:session.unforkFailedToast', { defaultValue: '弹出失败，请重试' }),
          variant: 'destructive',
        })
        trackChatTelemetry('session.unfork.failed', {
          spaceId,
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        }, { counterKey: 'session.unfork.failed', level: 'error', sessionId })
        return null
      }
    },

    forkSession: async (spaceId: string, sessionId: string, messageId?: string): Promise<ChatSession | null> => {
      if (get().forkingSessionId) {
        toast({ title: i18n.t('chat:session.forkInProgressToast'), duration: 2000 })
        return null
      }
      set({ forkingSessionId: sessionId })
      trackChatTelemetry('session.fork.start', { spaceId, sessionId, messageId }, { counterKey: 'session.fork.start', sessionId })
      try {
        const clickedMessage = messageId
          ? get().messagesBySessionId[sessionId]?.find((message) => message.id === messageId)
          : undefined
        const clickedMessageMetadata = (
          clickedMessage?.metadata
          && typeof clickedMessage.metadata === 'object'
        )
          ? clickedMessage.metadata as Record<string, unknown>
          : undefined
        const derivedServerMessageId = typeof clickedMessageMetadata?.message_id === 'string'
          ? clickedMessageMetadata.message_id
          : undefined
        const client = getChatClient()
        const newSession = await client.sessions.fork(
          sessionId,
          messageId
            ? {
                fork_anchor_message_id: messageId,
                ...(derivedServerMessageId ? { message_id: derivedServerMessageId } : {}),
              }
            : undefined,
        )
        recordSpaceSessionListMutation(spaceId, 'fork')
        const sessions = get().sessions
        //  / ：云端 fork 后立刻分叉本机归档（tool id remap）。失败不阻断云端结果。
        //  曾误删此调用，导致 fork 后发消息从零建半截 transcript，切回时按  覆盖掉历史。
        const sourceOrgId = sessions.find((s) => s.id === sessionId)?.organization_id
          ?? newSession.organization_id
          ?? undefined
        try {
          const localFork = await forkLocalSessionArchive(sessionId, newSession.id, {
            spaceId,
            organizationId: sourceOrgId,
            // Agent Host transcript 是 fork anchor 的 SSoT；服务端 fork 点是派生结果。
            forkAnchorMessageId: messageId ?? undefined,
            // ：同步 fork 时与云端共用同一张 tool id 表
            toolIdRemap: newSession.tool_id_remap ?? undefined,
          })
          if (localFork?.copied) {
            logger.log(
              '[Chat] Local session archive forked:',
              sessionId,
              '->',
              newSession.id,
              `remappedToolIds=${localFork.remappedToolIds}`,
              `truncated=${localFork.truncatedAtForkPoint}`,
            )
          }
        } catch (localErr) {
          console.warn('[Chat] Local session fork skipped/failed:', localErr)
        }

        const spaceSessionsMap = { ...get().sessionsBySpaceId }
        const spaceSessions = spaceSessionsMap[spaceId] || []

        const bumpForkCount = (s: typeof sessions[number]) =>
          s.id === sessionId ? { ...s, fork_count: (s.fork_count ?? 0) + 1 } : s
        const next = [newSession, ...sessions.map(bumpForkCount)]
        const nextSpace = [newSession, ...spaceSessions.map(bumpForkCount)]
        spaceSessionsMap[spaceId] = nextSpace

        set({
          sessions: next,
          sessionsBySpaceId: spaceSessionsMap,
        })

        await get().selectSession(spaceId, newSession.id)

        if (newSession.warnings?.length) {
          for (const warning of newSession.warnings) {
            toast({ title: warning, duration: 6000 })
          }
        }

        const isLargeFork = (newSession.message_count ?? 0) > 200
        if (isLargeFork || newSession.fork_copy_status === 'pending') {
          toast({ title: i18n.t('chat:session.forkLargeInProgressToast'), duration: 5000 })
          const pollMessages = async (retries = 8, interval = 2000) => {
            for (let i = 0; i < retries; i++) {
              await new Promise(r => setTimeout(r, interval))
              try {
                const client = getChatClient()
                const response = await client.messages.list(newSession.id, { limit: 1 })
                const msgs = response?.messages ?? []
                if (msgs && msgs.length > 0) {
                  await get().selectSession(spaceId, newSession.id)
                  toast({ title: i18n.t('chat:session.forkMessagesReadyToast'), duration: 2000 })
                  return
                }
                const refreshed = await client.sessions.get(newSession.id).catch(() => null)
                if (refreshed?.fork_copy_status === 'failed') {
                  toast({ title: i18n.t('chat:session.forkFailedToast'), variant: 'destructive', duration: 5000 })
                  return
                }
                if (refreshed?.fork_copy_status === 'complete') {
                  await get().selectSession(spaceId, newSession.id)
                  toast({ title: i18n.t('chat:session.forkMessagesReadyToast'), duration: 2000 })
                  return
                }
              } catch { /* retry */ }
            }
            toast({ title: i18n.t('chat:session.forkMessagesStillCopyingToast'), duration: 5000 })
          }
          void pollMessages()
        } else {
          toast({ title: i18n.t('chat:session.forkSuccessToast'), duration: 3000 })
        }

        trackChatTelemetry('session.fork.done', {
          spaceId,
          sourceSessionId: sessionId,
          newSessionId: newSession.id,
          messageCount: newSession.message_count,
        }, { counterKey: 'session.fork.done', sessionId: newSession.id })
        logger.log('[Chat] Session forked:', sessionId, '->', newSession.id)
        return newSession
      } catch (error) {
        console.error('[Chat] Failed to fork session:', error)
        toast({ title: i18n.t('chat:session.forkFailedToast'), variant: 'destructive' })
        trackChatTelemetry('session.fork.failed', { spaceId, sessionId, message: error instanceof Error ? error.message : String(error) }, { counterKey: 'session.fork.failed', level: 'error', sessionId })
        return null
      } finally {
        set({ forkingSessionId: null })
      }
    },

    generateTitle: async (sessionId: string, force = false) => {
      // ：必须携带用户正文；从本地消息取首条真实 user，不读库兜底。
      const messages = get().messagesBySessionId[sessionId] ?? []
      const firstUser = messages.find((m) => isRegularUserMessage(m))
      const userMessage = (firstUser?.content ?? '').trim()
      if (!userMessage) {
        logger.warn('[Chat] generateTitle skipped: no user message text session=%s', sessionId.slice(0, 8))
        return
      }
      try {
        const fired = requestTitleGenerationOnce({
          sessionId,
          userMessage,
          shouldTrigger: () => true,
          getChatClient,
          force,
        })
        logger.log(
          '[Chat] generateTitle fired=%s force=%s session=%s',
          fired,
          force,
          sessionId.slice(0, 8),
        )
      } catch (error) {
        console.error('[Chat] Failed to generate title:', error)
      }
    },
  }
}
