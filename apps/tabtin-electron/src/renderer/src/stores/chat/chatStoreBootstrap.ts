/**
 * chatStoreBootstrap — 组合根的「端口注册」装配（ 阶段C）。
 *
 * 把原先散在 useChatStore.ts 末尾的一批反向访问 callbacks / provider 注册收进
 * 一个显式入口 `installChatStorePorts()`，由 useChatStore module body 末尾调用一次
 * （彼时 useChatStore 已 export 完成）。这样组合根本体只做 create+persist 装配，
 * 「谁把 store 能力注入给 chatApi / hub / messageWriteGate / model store」这件事
 * 集中一处、可一眼看全。
 *
 * 注：与 useChatStore 存在循环 import——但本模块只在 `installChatStorePorts()` 被调用
 * 时才访问 useChatStore（延迟到 module 装配完成后），加载期不触碰，故安全。
 */
import { useChatStore } from './useChatStore'
import { useChatRuntimeStore } from '../useChatRuntimeStore'
import {
  applySessionRunStateEvent,
  isSessionBusy,
} from './execution/sessionRunProjection'
import { buildReviewMessage } from './reviewMessage'
import { createStreamMessageHandler } from './stream/handlers/streamMessageHandler'
import { handleSeqGapControl } from './stream/handlers/observerSeqGap'
import { runtimeStoreAccess } from '@/services/agentService/runtimeStoreAccess'
import { streamControlPorts } from '@/services/agentService/streamControlPorts'
import { shouldApplyGeneratedTitleUpdate as shouldApplyGeneratedTitleUpdateBase } from './session/slices/manualTitleGuard'
import {
  registerChatStoreCallbacks,
  registerChatSessionAccess,
  registerHitlStoreAccess,
} from './shared/storeAccessRegistry'
import {
  registerRestoringSessionProvider,
  registerSessionMessagesReader,
  registerServerMessagesReconciler,
} from '@/services/agentService/messageWriteGate'
import {
  setAbandonedEmptySessionDiscarder,
  setDraftSessionModeApplier,
} from './session/draftMessageSessionCoordinator'
import { bindModePreferenceSessionModeApplier } from './session/slices/modePreferenceSlice'
import type { AgentModeName } from './shared/types'

/**
 * 注册组合根对外暴露的所有反向访问端口。必须在 useChatStore export 完成后调用一次。
 * 按注入目标分组为几个小步骤，便于一眼看清「谁把 store 能力注入给谁」。
 */
export function installChatStorePorts(): void {
  installAgentServiceStreamPorts()
  installChatApiCallbacks()
  installMessageWriteGatePorts()
  installHitlStorePort()
  installModelSessionPort()
  installDraftMessageModePorts()
}

/**
 * ：Mode 写入 DI——避免 modePreferenceSlice / draftMessage 静态拉 sessionAgentMode
 * （sessionAgentMode → useChatStore 会成环）。直接写 runtime store，与 setSessionAgentMode 同语义。
 */
function installDraftMessageModePorts(): void {
  const applySessionMode = (sessionId: string, mode: AgentModeName) => {
    useChatRuntimeStore.setState((state) => ({
      agentModeBySessionId: {
        ...state.agentModeBySessionId,
        [sessionId]: mode,
      },
    }))
  }
  bindModePreferenceSessionModeApplier(applySessionMode)
  setDraftSessionModeApplier(applySessionMode)
  // ：放弃草稿 / begin 新 episode 时清未发消息的预建空会话
  setAbandonedEmptySessionDiscarder((input) => {
    useChatStore.getState().discardAbandonedEmptySessions(input)
  })
}

/** agentService hub / streamSources 侧：stream handler 工厂 + control 帧端口。 */
function installAgentServiceStreamPorts(): void {
  //  阶段B：把入站 stream handler 工厂注入 agentService hub（hub 不静态 import
  // store 层 createStreamMessageHandler）。在此注册可避开「早加载链静态拉进
  // streamMessageHandler → useChatStore」的加载环（见 runtimeStoreAccess 注释）。
  runtimeStoreAccess.registerStreamHandlerFactory((deps) => createStreamMessageHandler(deps))

  streamControlPorts.register({ handleSeqGapControl })
}

/** chatApi → useChatStore 的反向访问 callbacks（chatApi 顶部不静态 import store）。 */
function installChatApiCallbacks(): void {
  registerChatStoreCallbacks({
    //  / ：busy 判定统一读执行态单一投影（isSessionBusy）。影子字段
    // streamingBySessionId 已删除，「会话在不在跑」只有这一处真相。
    isSessionBusy: (sessionId) => isSessionBusy(sessionId),
    applySessionRunStateEvent: (sessionId, runState) =>
      applySessionRunStateEvent(sessionId, runState),
    getStreamingSessionIds: () => {
      const map = useChatRuntimeStore.getState().runProjectionBySessionId ?? {}
      return Object.keys(map).filter((sid) => map[sid]?.busy)
    },
    getCurrentSessionId: () => useChatStore.getState().currentSessionId,
    syncSessionMessagesFromServer: (sessionId) => {
      void useChatStore.getState().syncSessionMessagesFromServer(sessionId)
    },
    getSessionsBySpaceId: () => useChatStore.getState().sessionsBySpaceId,
    updateSessionTitleInCaches: (sessionId, title, opts) =>
      useChatStore.getState().updateSessionTitleInCaches(sessionId, title, opts),
    shouldApplyGeneratedTitleUpdate: (sessionId, title) => {
      const state = useChatStore.getState()
      const session = state.sessions.find(item => item.id === sessionId)
        ?? Object.values(state.sessionsBySpaceId)
          .flatMap(list => list)
          .find(item => item.id === sessionId)
      return shouldApplyGeneratedTitleUpdateBase(sessionId, title, session)
    },
    upsertSessionInSpace: (spaceId, session) =>
      useChatStore.getState().upsertSessionInSpace(spaceId, session),
    injectErrorBubble: (sessionId, message) =>
      useChatStore.getState().injectErrorBubble(sessionId, message),
    upsertObservedUserMessage: (sessionId, message) =>
      useChatStore.getState().upsertObservedUserMessage(sessionId, message),
    linkServerMessageId: (sessionId, localMessageId, serverId) =>
      useChatStore.getState().linkServerMessageId(sessionId, localMessageId, serverId),
    rebindMessageIds: (sessionId, idPairs) =>
      useChatStore.getState().rebindMessageIds(sessionId, idPairs),
  })
}

/** messageWriteGate leaf 的 provider：restoring 判定 / 读消息 / 服务端写回。 */
function installMessageWriteGatePorts(): void {
  //  消息写入门控：回退管线进行中 → 服务端 sync 写回一律丢弃。provider 直读
  // store（单一真相），不在 messageWriteGate 里双写标志位——避免多处 set/clear 漏一处
  // 导致门控永久卡死。
  registerRestoringSessionProvider(
    (sessionId) => useChatStore.getState().restoringSessionId === sessionId,
  )

  // ：把「读某会话消息列表」注入服务层门面（sessionMessages），让 hub 不反向
  // 依赖 store——依赖倒置，store 提供实现，服务层只持接口。
  registerSessionMessagesReader(
    (sessionId) => useChatStore.getState().messagesBySessionId[sessionId] ?? [],
  )

  //  阶段0：把服务端 sync 写回（reconcileFromServer）注入 messageWriteGate leaf，
  // 让 sessionFreshness service 不再静态 import useChatStore（斩 store↔service 环）。
  registerServerMessagesReconciler(
    (sessionId, fetchEpoch, fresh, opts) =>
      useChatStore.getState().reconcileFromServer(sessionId, fetchEpoch, fresh, opts),
  )
}

/** HITL 面板状态读写 + review 文案的 store access 端口。 */
function installHitlStorePort(): void {
  registerHitlStoreAccess({
    getState: () => {
      const state = useChatStore.getState()
      return {
        pendingApprovalBySessionId: state.pendingApprovalBySessionId,
        approvalSubmittingBySessionId: state.approvalSubmittingBySessionId,
        pendingAskUserBySessionId: state.pendingAskUserBySessionId,
        askUserSubmittingBySessionId: state.askUserSubmittingBySessionId,
      }
    },
    applyState: (partial) => {
      useChatStore.setState((state) => {
        const slice = {
          pendingApprovalBySessionId: state.pendingApprovalBySessionId,
          approvalSubmittingBySessionId: state.approvalSubmittingBySessionId,
          pendingAskUserBySessionId: state.pendingAskUserBySessionId,
          askUserSubmittingBySessionId: state.askUserSubmittingBySessionId,
        }
        const patch = typeof partial === 'function' ? partial(slice) : partial
        return patch
      })
    },
    upsertHitlBubble: (sessionId, placeholderMessageId, bubble) =>
      useChatStore.getState().upsertHitlBubble(sessionId, placeholderMessageId, bubble),
    buildReviewMessage,
  })
}

/**
 * useChatModelStore → useChatStore 的会话字段写入端口。
 * switchModel / switchContextTier 写 ChatSession 字段时统一调 setSessionFields，
 * 普通会话与 Tracker Run 会话的缓存同步由 sessionPointerSlice 统一封装。
 */
function installModelSessionPort(): void {
  registerChatSessionAccess({
    getCurrentSessionId: () => useChatStore.getState().currentSessionId,
    // 会话查找口径只保留在 sessionPointerSlice；这里复用 store action，
    // 避免遗漏 trackerRunSessionsBySpaceId 等带外会话桶。
    getSessionById: (sessionId) => useChatStore.getState().getSessionById(sessionId),
    setSessionFields: (sessionId, fields) =>
      useChatStore.getState().updateSessionInCaches(sessionId, fields),
    refreshSessionFromServer: (sessionId) => {
      const state = useChatStore.getState()
      const session = state.getSessionById(sessionId)
      const spaceId = session?.space_id ?? session?.workspace_id
      if (session && spaceId) {
        void state.loadSessions(spaceId, session.organization_id)
      }
    },
  })
}
