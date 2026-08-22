/**
 * Store lifecycle orchestration — reset / purgeOrganizationSpaces（ 分层重构）。
 *
 * 两个跨全域的生命周期编排：
 *   - reset：登出 / 切账号时清空整个 chat store（联动 runtime store.reset + LRU + 离线队列）
 *   - purgeOrganizationSpaces：用户被移出 organization 时，剔除该 org 名下所有 space 及其
 *     session/message/streaming/HITL/tracker 派生状态（保持 LRU accessOrder 不变量）
 *
 * 从 useChatStore 抽出为独立 use-case action；LRU 经 messageCacheSlice 导出的 helper 操作。
 */

import type { ChatSession } from '@tabtin/chat-client'
import type { AgentModeName, ApprovalModeName } from '../../shared/types'
import { createLogger } from '@/utils/logger'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import { useWsConnectionStore } from '../../../useWsConnectionStore'
import {
  removeSpacesFromAccessOrder,
  removeSessionsFromAccessOrder,
  resetCacheAccessOrder,
} from '../../messages/messageCacheSlice'
import { clearAllFailedMessageEditResend } from '../../messages/actions/failedMessageEditResend'
import { clearAllLocallySubmittedSessions } from '../locallySubmittedSessionRegistry'
import { resetDraftMessageSessionState } from '../draftMessageSessionCoordinator'
import { clearAllDraftPrefetchLatches } from './sessionPrefetchAction'
import { invalidateSessionProvisionGeneration } from './sessionLifecycleAction'

const logger = createLogger('Chat')

/** 登出 / reset 时清理历史离线队列持久化残留（功能已移除）。 */
function clearLegacyOfflineQueueStorage(): void {
  try {
    sessionStorage.removeItem('tabtin:messageQueue')
  } catch { /* noop */ }
  try {
    indexedDB.deleteDatabase('tabtin-offline-queue')
  } catch { /* noop */ }
}

interface LifecycleRootState {
  sessionsBySpaceId: Record<string, ChatSession[]>
  currentSessionIdBySpaceId: Record<string, unknown>
  draftSessionBySpaceId: Record<string, unknown>
  messagesBySessionId: Record<string, unknown>
  pendingApprovalBySessionId: Record<string, unknown>
  approvalSubmittingBySessionId: Record<string, unknown>
  pendingAskUserBySessionId: Record<string, unknown>
  askUserSubmittingBySessionId: Record<string, unknown>
  trackerRunSessionsBySpaceId: Record<string, unknown>
  trackerRunCountBySpaceId: Record<string, unknown>
  trackerRunLoadingBySpaceId: Record<string, unknown>
  trackerRunErrorBySpaceId: Record<string, unknown>
  trackerRunLoadedBySpaceId: Record<string, unknown>
}

export interface StoreLifecycleStore {
  purgeOrganizationSpaces: (
    organizationId: string,
    knownSpaceIds?: readonly string[],
  ) => void
  reset: () => void
}

export function createStoreLifecycleActions<RootState extends LifecycleRootState>(
  get: () => RootState,
  set: (partial: Partial<RootState> | ((state: RootState) => Partial<RootState>)) => void,
): StoreLifecycleStore {
  return {
    purgeOrganizationSpaces: (organizationId, knownSpaceIds = []) => {
      // 在不破坏 LRU accessOrder 前提下，剔除指定 organization 的所有 space 及其派生状态。
      const state = get()

      // 1) 按每个 space 的 session.organization_id 识别要删除的 space（Space→Org 1:1，用 every 更严谨）。
      const removedSpaceIds = new Set<string>(knownSpaceIds)
      for (const [spaceId, sessionList] of Object.entries(state.sessionsBySpaceId)) {
        if (sessionList.length > 0 && sessionList.every((s) => s.organization_id === organizationId)) {
          removedSpaceIds.add(spaceId)
        }
      }
      if (removedSpaceIds.size === 0) return

      // 2) 同步清 Space LRU accessOrder。
      removeSpacesFromAccessOrder(removedSpaceIds)

      // 3) 收集要 evict 的 sessionId 并同步会话消息 LRU。
      const droppedSessionIds: string[] = []
      for (const spaceId of removedSpaceIds) {
        const sessions = state.sessionsBySpaceId[spaceId] ?? []
        for (const s of sessions) droppedSessionIds.push(s.id)
      }
      if (droppedSessionIds.length > 0) {
        removeSessionsFromAccessOrder(new Set(droppedSessionIds))
      }

      // 4) 原子性地清所有相关 per-space / per-session 派生 map。
      set((prev) => {
        const nextSessionsBySpaceId = { ...(prev.sessionsBySpaceId as Record<string, unknown>) }
        const nextCurrentSessionIdBySpaceId = { ...(prev.currentSessionIdBySpaceId as Record<string, unknown>) }
        const nextDraftSessionBySpaceId = { ...(prev.draftSessionBySpaceId as Record<string, unknown>) }
        const nextMessagesBySessionId = { ...(prev.messagesBySessionId as Record<string, unknown>) }
        const nextPendingApproval = { ...(prev.pendingApprovalBySessionId as Record<string, unknown>) }
        const nextApprovalSub = { ...(prev.approvalSubmittingBySessionId as Record<string, unknown>) }
        const nextPendingAsk = { ...(prev.pendingAskUserBySessionId as Record<string, unknown>) }
        const nextAskSub = { ...(prev.askUserSubmittingBySessionId as Record<string, unknown>) }
        const nextTrackerSessions = { ...(prev.trackerRunSessionsBySpaceId as Record<string, unknown>) }
        const nextTrackerCount = { ...(prev.trackerRunCountBySpaceId as Record<string, unknown>) }
        const nextTrackerLoading = { ...(prev.trackerRunLoadingBySpaceId as Record<string, unknown>) }
        const nextTrackerError = { ...(prev.trackerRunErrorBySpaceId as Record<string, unknown>) }
        const nextTrackerLoaded = { ...(prev.trackerRunLoadedBySpaceId as Record<string, unknown>) }
        for (const spaceId of removedSpaceIds) {
          delete nextSessionsBySpaceId[spaceId]
          delete nextCurrentSessionIdBySpaceId[spaceId]
          delete nextDraftSessionBySpaceId[spaceId]
          delete nextTrackerSessions[spaceId]
          delete nextTrackerCount[spaceId]
          delete nextTrackerLoading[spaceId]
          delete nextTrackerError[spaceId]
          delete nextTrackerLoaded[spaceId]
        }
        for (const sid of droppedSessionIds) {
          delete nextMessagesBySessionId[sid]
          delete nextPendingApproval[sid]
          delete nextApprovalSub[sid]
          delete nextPendingAsk[sid]
          delete nextAskSub[sid]
        }
        return {
          sessionsBySpaceId: nextSessionsBySpaceId,
          currentSessionIdBySpaceId: nextCurrentSessionIdBySpaceId,
          draftSessionBySpaceId: nextDraftSessionBySpaceId,
          messagesBySessionId: nextMessagesBySessionId,
          pendingApprovalBySessionId: nextPendingApproval,
          approvalSubmittingBySessionId: nextApprovalSub,
          pendingAskUserBySessionId: nextPendingAsk,
          askUserSubmittingBySessionId: nextAskSub,
          trackerRunSessionsBySpaceId: nextTrackerSessions,
          trackerRunCountBySpaceId: nextTrackerCount,
          trackerRunLoadingBySpaceId: nextTrackerLoading,
          trackerRunErrorBySpaceId: nextTrackerError,
          trackerRunLoadedBySpaceId: nextTrackerLoaded,
        } as Partial<RootState>
      })

      // 5) 联动 runtime store + WS connection store 清理。
      if (droppedSessionIds.length > 0) {
        useChatRuntimeStore.getState().evictSessionBatch(droppedSessionIds)
        const wsStore = useWsConnectionStore.getState()
        for (const sid of droppedSessionIds) wsStore.removeSuspendedSession(sid)
      }

      logger.debug('[Chat] purgeOrganizationSpaces', {
        organizationId,
        spaces: removedSpaceIds.size,
        sessions: droppedSessionIds.length,
      })
    },

    reset: () => {
      // ：防睡眠随投影清空由订阅自动放行（runtime.reset() 清 runProjectionBySessionId）。
      resetCacheAccessOrder()
      clearLegacyOfflineQueueStorage()
      resetDraftMessageSessionState()
      clearAllFailedMessageEditResend()
      clearAllLocallySubmittedSessions()
      clearAllDraftPrefetchLatches()
      // generation bump：迟到 in-flight 不得写 pointer；勿简单 clear Map 误删新任务
      invalidateSessionProvisionGeneration()
      useChatRuntimeStore.getState().reset()
      set({
        sessions: [],
        sessionsBySpaceId: {},
        sessionsHydrated: false,
        currentSessionId: null,
        currentSessionIdBySpaceId: {},
        currentSessionIdByWorkspaceKey: {},
        draftExecutionSpaceIdByWorkspaceKey: {},
        draftSessionBySpaceId: {},
        messagesBySessionId: {},
        hasMoreBySessionId: {},
        isLoadingMoreBySessionId: {},
        isLoading: false,
        forkingSessionId: null,
        pendingApprovalBySessionId: {},
        approvalSubmittingBySessionId: {},
        pendingAskUserBySessionId: {},
        askUserSubmittingBySessionId: {},
        agentMode: 'agent' as AgentModeName,
        approvalMode: 'always_ask' as ApprovalModeName,
        approvalModeBySessionId: {},
        restoringSessionId: null,
        restoringPhase: null,
        restoreInterruptedBySessionId: {},
        editResendRevertBySessionId: {},
        revertBannerCollapsedBySessionId: {},
        checkpointsBySessionId: {},
        lastContextSyncFingerprintBySessionId: {},
        lastSafetyCheckpointBySessionId: {},
        checkpointFailCountBySessionId: {},
        checkpointHealthBySessionId: {},
        checkpointPendingContextBySessionId: {},
        resourceRetryCountBySessionId: {},
        rewindPreview: null,
        scrollTargetMessageId: null,
        trackerRunSessionsBySpaceId: {},
        trackerRunCountBySpaceId: {},
        trackerRunLoadingBySpaceId: {},
        trackerRunErrorBySpaceId: {},
        trackerRunLoadedBySpaceId: {},
      } as unknown as Partial<RootState>)
      logger.debug('[Chat] Store 已重置')
    },
  }
}
