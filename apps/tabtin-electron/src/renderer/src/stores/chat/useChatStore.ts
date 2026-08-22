/** @store-category session */

/**
 * Chat Agent Store
 *
 * 管理 Chat Agent 的状态：会话、消息、UI 状态等
 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from '../persist-key-registry'
import { getChatClient } from '../../services/chatApi'
import { getSessionController, hasRuntimeBridge, type AbortRunResult } from '../../services/agentService'
import { installChatStorePorts } from './chatStoreBootstrap'
import { buildReviewMessage } from './reviewMessage'
import { createMessageCacheActions, type MessageCacheStore } from './messages/messageCacheSlice'
import { registerResetAction } from '../sessionResetRegistry'
import { setReconnectHandler, getChatClientInstance } from '../../services/chatClientSingleton'
import { onDeviceStatusMessage } from '../deviceStatusEvents'
import { reconcileSessionMessages } from '../../services/sessionFreshness'
import { markSessionsSuspended } from '../../services/sessionSuspended'
import { useSessionFreshnessStore } from '../useSessionFreshnessStore'
import { useWsConnectionStore } from '../useWsConnectionStore'
import type { ChatSession, ChatMessage } from '@tabtin/chat-client'
import { useAuthStore } from '../useAuthStore'
import i18n from '@/i18n'
import type { ChatSessionTokenUsage } from '@/utils/chatSessionTokenUsage'
import { trackChatTelemetry } from './execution/chatTelemetry'
import { streamingContent } from './execution/streamingContent'
import { resolveComposerStopMode } from './messages/actions/composerStopDecision'
import {
  getSessionRunProjection,
  isSessionBusy,
} from './execution/sessionRunProjection'
import {
  getActiveRunBinding,
  noteAbortedRunId,
  snapshotInterruptedBinding,
} from './execution/activeRunBinding'
import { reconcileSessionRunState } from './execution/sessionRunReconcile'
import { cleanup as cleanupSeqTracker } from './stream/handlers/seqTracker'
import { markAbortRequested } from './stream/handlers/abortGrace'
import { markRunSuperseded } from './stream/handlers/supersededRuns'
import type {
  AgentModeName,
  ApprovalModeName,
  ApprovalRequestState,
  AskUserRequestState,
  ChatReplyTarget,
} from './shared/types'
import {
  createModePreferenceActionsForStore,
  type SetAgentModeOptions,
} from './session/slices/modePreferenceSlice'
import { createUiActions, type UiStore } from './ui/uiSlice'
import {
  createSessionPointerActions,
  type SessionPointerStore,
} from './session/slices/sessionPointerSlice'
import { createNavigationActions, type NavigationStore } from './messages/navigationSlice'
import { createStoreLifecycleActions } from './session/actions/storeLifecycleAction'
import { createCheckpointActions } from './checkpoint/slices/checkpointSlice'
import type { CheckpointStore } from './checkpoint/slices/checkpointSlice'
import { narrowGet, narrowSet, type AssertSliceOf } from './shared/sliceAdapters'
import type { DiffFileEntry } from '../../components/chat/checkpoint/CheckpointDiffSheet'
import { createSessionCrudActions } from './session/slices/sessionCrudSlice'
import type { SessionCrudStore, SessionSelectionOptions } from './session/slices/sessionCrudSlice'
import { createSendMessageAction } from './messages/actions/sendMessageAction'
import {
  createHostPendingSendActions,
  type HostPendingSendStore,
} from './messages/hostPending/hostPendingSendSlice'
import {
  createInterruptHostPendingActions,
  type InterruptHostPendingStore,
} from './messages/actions/interruptHostPendingAction'
import {
  createCancelHostPendingActions,
  type CancelHostPendingStore,
} from './messages/actions/cancelHostPendingAction'
import { bumpSessionSidebarOnSend as bumpSidebarOnSend } from './session/bumpSessionSidebarOnSend'
import { createAbortStreamActions, type AbortStreamStore } from './messages/actions/abortStreamAction'
import type {
  SendMessageOptions,
  SendMessageStore,
  SendSubmissionResult,
} from './messages/actions/sendMessageAction'
import { createApprovalActions } from './hitl/slices/approvalSlice'
import type { ApprovalSliceStore, PerToolApprovalDecision } from './hitl/slices/approvalSlice'
import { createAskUserActions } from './hitl/slices/askUserSlice'
import type { AskUserSliceStore } from './hitl/slices/askUserSlice'
import { recordHitlResolvedKey } from './hitl/handlers/hitlStreamHandlers'
import { createContextSyncActions } from './session/slices/contextSyncSlice'
import type { ContextSyncStore } from './session/slices/contextSyncSlice'
import { createSessionLifecycleAction } from './session/actions/sessionLifecycleAction'
import { createSessionPrefetchAction } from './session/actions/sessionPrefetchAction'
import type {
  PrefetchSessionForDraftParams,
  SessionPrefetchStore,
} from './session/actions/sessionPrefetchAction'
import type {
  EnsureSessionForSpaceOptions,
  EnsureSessionForSpaceResult,
  SessionCreateTrigger,
  SessionLifecycleStore,
} from './session/actions/sessionLifecycleAction'
import { toast } from '@tabtin/smartsheet-ui/toast'
import * as chatExtraApi from '../../services/chatExtraApi'
import type { RecoveryPlanConfirmation } from './checkpoint/recoveryPlan'
import { preventSleep, allowSleep } from '../../services/powerService'
import { logger, createLogger } from '@/utils/logger'
import { resolveSpaceExecutionPath, resolveActiveSpaceId } from '@utils/resolveSpaceExecutionPath'
import { resolveSessionExecutionPath } from './utils/resolveSessionCodeRoot'

const log = createLogger('Chat')

const EMPTY_CHAT_SESSIONS: ChatSession[] = []

/**
 * ：checkpoint / FileHistory 路径解析入口——由"全局 active Space 根"
 * 收紧到"具体 sessionId 的执行根"。有 sessionId 且该会话存在活跃代码根绑定时，
 * `resolveSessionExecutionPath` 优先返回绑定根（bound root 与 canonical
 * workingDir 不同时，checkpoint 全部以 bound root 运行，绝不静默落回主目录）；
 * 无绑定 / 无 sessionId 时原样回落 `resolveSpaceExecutionPath()`——非 worktree
 * 会话行为与改动前完全一致。
 */
function resolveCheckpointExecutionPath(sessionId?: string | null): Promise<string | null> {
  if (!sessionId) return resolveSpaceExecutionPath()
  return resolveSessionExecutionPath(sessionId)
}

const _resolveSpacePath = resolveCheckpointExecutionPath

// Types and INITIAL_RUN_STATE are now imported directly from chat/types.ts by consumers

export interface ChatState extends HostPendingSendStore, InterruptHostPendingStore, CancelHostPendingStore, MessageCacheStore {
  // ==================== UI 状态 ====================
  /** Chat 面板是否打开 */
  isPanelOpen: boolean
  /** Chat 面板宽度 */
  panelWidth: number

  // ==================== 数据状态 ====================
  /** 会话列表 */
  sessions: ChatSession[]
  /** 按 Space 缓存的会话列表 */
  sessionsBySpaceId: Record<string, ChatSession[]>
  /**
   * sessions 是否已经被首次加载过（任意一个 Space 的 setSpaceSessions 完成即 true）。
   *
   * 用途（PRD §4.13）：workbench restore 的 `subagent_session` 分支据此决定要不要
   * 对 `parentSessionId` 做存在性校验——`false` 期间维持 unknown，避免冷启动
   * 期把所有 subagent tab 误判为 stale（父 session 还没拉回来）。
   */
  sessionsHydrated: boolean
  /** 当前会话 ID */
  currentSessionId: string | null
  /** 按 Space 缓存的当前会话 ID */
  currentSessionIdBySpaceId: Record<string, string | null>
  /**
   * Phase 5：按 workspace scope key 缓存的 session 指针。
   * - desktop:{organization}:{user} → 桌面态 auxiliary chat
   * - conversation:{sessionId} 不在此 map（session 即 key 本身）
   */
  currentSessionIdByWorkspaceKey: Record<string, string | null>
  /**
   * 草稿态执行 Space 指针。
   *
   * Phase 5b：新对话尚未落库时，用户在“执行于”切换的是该草稿的执行目标，
   * 不应再把整个桌面/对话状态强绑到全局 selectedSpace。
   */
  draftExecutionSpaceIdByWorkspaceKey: Record<string, string | null>
  /**
   * 按 sessionId 查 ChatSession 对象（两份 cache 都查）。
   *
   * 历史背景：`sessions` 仅保存当前激活 Space 的列表，跨 Space 查必须兜底
   * 看 `sessionsBySpaceId`。registerChatSessionAccess 已有此实现，本字段
   * 把它公开为 store 方法——外部消费者（detached IPC、subagent_session
   * handler、`useSpaceIdForSession` hook 等）走单一入口，零额外耦合。
   */
  getSessionById: (sessionId: string) => ChatSession | undefined
  /** 按 Space 标记“新建但尚未落库”的草稿会话态 */
  draftSessionBySpaceId: Record<string, boolean>
  /** 按会话缓存的消息列表 */
  messagesBySessionId: Record<string, ChatMessage[]>
  /** 是否正在加载 */
  isLoading: boolean
  /** 按 session 隔离的待审批请求（v0.4 batch 形态：同批 N 条共享 batchId） */
  pendingApprovalBySessionId: Record<string, ApprovalRequestState>
  /** 按 session 隔离的审批提交状态 */
  approvalSubmittingBySessionId: Record<string, boolean>
  /** 获取指定 session 的待审批请求 */
  getPendingApprovalForSession: (sessionId: string | null) => ApprovalRequestState | null
  /** 获取指定 session 的审批提交状态 */
  isSessionApprovalSubmitting: (sessionId: string | null) => boolean
  /** 提交审批（全局，整批同决策） */
  submitApprovalDecision: (decision: 'approve' | 'reject') => Promise<void>
  /** 为指定 session 提交审批（整批同决策） */
  submitApprovalDecisionForSession: (sessionId: string, decision: 'approve' | 'reject') => Promise<void>
  /** 按 session 隔离的待回答问题 */
  pendingAskUserBySessionId: Record<string, AskUserRequestState>
  /** 按 session 隔离的回答提交状态 */
  askUserSubmittingBySessionId: Record<string, boolean>
  /** 获取指定 session 的待回答问题 */
  getPendingAskUserForSession: (sessionId: string | null) => AskUserRequestState | null
  /** 获取指定 session 的回答提交状态 */
  isSessionAskUserSubmitting: (sessionId: string | null) => boolean
  // W4 R3 (2026-05-11): ask 三件套并存——ask_user (choice) / ask_form / request_approval。
  // 三类 submit 各对应一个 wire payload：answers[] / field_values / approved。
  /** 提交 ask_user (choice) 回答（questions[] + 可选自由文本） */
  submitAskUserAnswer: (answers: import('@tabtin/chat-client').AskUserAnswer[]) => Promise<void>
  /** 为指定 session 提交 ask_user (choice) 回答 */
  submitAskUserAnswerForSession: (
    sessionId: string,
    answers: import('@tabtin/chat-client').AskUserAnswer[],
  ) => Promise<void>
  /** 提交 ask_form text_fallback 模式回答 */
  submitAskUserText: (text: string) => Promise<void>
  /** 为指定 session 提交 ask_form text_fallback */
  submitAskUserTextForSession: (sessionId: string, text: string) => Promise<void>
  /** 提交 ask_form fields 模式回答 */
  submitAskUserFieldValues: (fieldValues: Record<string, unknown>) => Promise<void>
  /** 为指定 session 提交 ask_form fields */
  submitAskUserFieldValuesForSession: (
    sessionId: string,
    fieldValues: Record<string, unknown>,
  ) => Promise<void>
  /** 提交 request_approval 决策（true=批准 / false=拒绝） */
  submitAskUserApproval: (approved: boolean) => Promise<void>
  /** 为指定 session 提交 request_approval 决策 */
  submitAskUserApprovalForSession: (sessionId: string, approved: boolean) => Promise<void>
  /** 跳过 AskUser 问题 */
  skipAskUser: () => Promise<void>
  /** 为指定 session 跳过 AskUser 问题 */
  skipAskUserForSession: (sessionId: string) => Promise<void>

  /** 提交 per-tool 级别决策（含 scope + rejection_message） */
  submitApprovalDecisions: (decisions: PerToolApprovalDecision[]) => Promise<void>
  /** 为指定 session 提交 per-tool 级别决策 */
  submitApprovalDecisionsForSession: (
    sessionId: string,
    decisions: PerToolApprovalDecision[],
  ) => Promise<void>
  /**
   * ：放弃当前 session 的审批并恢复 Composer 输入。
   *
   * - `reason='expired'`：审批倒计时归零自动调入（ApprovalPanel.onExpired）。
   * - `reason='manual'`：用户在 submitError 旁点"放弃审批"按钮调入。
   * 清 pendingApprovalBySessionId[sessionId]，主 composer 退出待确认态。
   */
  dismissApproval: (reason?: 'expired' | 'manual') => void
  /** 为指定 session 放弃审批（同 dismissApproval 但显式传 sessionId） */
  dismissApprovalForSession: (sessionId: string, reason?: 'expired' | 'manual') => void

  // ==================== 运行时状态（已迁移至 useChatRuntimeStore） ====================
  // agentSteps, toolEvents, assistantEvents, subagentRuns, runState,
  // todos, externalAgent, permissionRequests, agentMode
  // → 见 useChatRuntimeStore.ts


  // ==================== Agent Mode ====================
  /** 当前 Agent 交互模式 */
  agentMode: AgentModeName
  /** 切换 Agent 交互模式（草稿态须显式传入 opaque draftScopeKey） */
  setAgentMode: (mode: AgentModeName, options?: SetAgentModeOptions) => void

  // ==================== Approval Mode（ 三档审批策略） ====================
  /** 旧版审批档全局默认；当前主路径使用 approvalModeBySessionId 当前会话覆盖。 */
  approvalMode: ApprovalModeName
  /** 当前会话审批档覆盖；随 chat store 持久化，避免同一对话刷新后丢档。 */
  approvalModeBySessionId: Record<string, ApprovalModeName>
  /**
   * 旧版对话级审批档切换入口；当前 UI 改由 Agent 权限 drawer 写入
   * useChatRuntimeStore.approvalModeBySessionId。
   */
  setApprovalMode: (mode: ApprovalModeName) => void

  // ==================== UI 操作 ====================
  /** 切换面板开关 */
  togglePanel: () => void
  /** 设置面板宽度 */
  setPanelWidth: (width: number) => void

  // ==================== 会话管理 ====================
  /** 创建新会话 */
  createSession: (
    spaceId: string,
    organizationId?: string,
    modelId?: string,
    lifecycleOptions?: { trigger?: SessionCreateTrigger },
  ) => Promise<void>
  /**
   * 唯一建会话入口：复用本 Space 指针 / 合并 in-flight / 否则 provision。
   * 草稿预建与首发发送共用。
   */
  ensureSessionForSpace: (
    spaceId: string,
    organizationId?: string,
    modelId?: string,
    options?: EnsureSessionForSpaceOptions,
  ) => Promise<EnsureSessionForSpaceResult>
  /** 草稿 episode 后台预建真实 session（ 单槽；保留欢迎态） */
  prefetchSessionForDraft: (params: PrefetchSessionForDraftParams) => Promise<void>
  /** 加载会话列表（默认排除 Tracker per_run session，详见隐患 5 / 方案 ①） */
  loadSessions: (
    spaceId: string,
    organizationId?: string,
    options?: { excludeAgentMentionSessions?: boolean },
  ) => Promise<void>
  /**
   * 隐患 5 / 方案 ①（charter v1.8 §6.7 主侧栏分桶）：
   * 懒加载 Tracker per_run ChatSession 列表。
   * ChatSessionSwitcher 的「自动化任务执行记录」折叠分组首次展开时调用。
   */
  loadTrackerRunSessions: (
    spaceId: string,
    organizationId?: string,
    opts?: { force?: boolean },
  ) => Promise<void>
  /** 已 fetch 的 Tracker per_run ChatSession（按 spaceId 缓存） */
  trackerRunSessionsBySpaceId: Record<string, ChatSession[]>
  /** 后端 list_sessions 默认响应里的 tracker_run_count，供折叠分组 header 显示数量 */
  trackerRunCountBySpaceId: Record<string, number | null>
  /** 侧栏查询明确排除的 TabChat `@Agent` 内部会话 ID */
  excludedAgentMentionSessionIdsBySpaceId: Record<string, string[]>
  /** Tracker per_run 列表加载中 */
  trackerRunLoadingBySpaceId: Record<string, boolean>
  /** Tracker per_run 列表加载错误（可点 retry） */
  trackerRunErrorBySpaceId: Record<string, string | null>
  /** Tracker per_run 列表是否已 fetched 过（命中缓存判定） */
  trackerRunLoadedBySpaceId: Record<string, boolean>
  /**
   * TS-29：把一条「带外」Tracker Run 的 ChatSession 合并进分桶（去重、不覆盖）。
   * 供 enterChatSession 从 Tracker 详情页跳入 Run 会话时调用，确保 ChatPanel
   * 生命周期能识别该 session、不把它当未知会话踢回草稿态。
   */
  upsertTrackerRunSession: (spaceId: string, session: ChatSession) => void
  /**
   * Project 其他成员新建会话的 WS 推送落地。
   * 仅对已加载过的 sessionsBySpaceId 桶 prepend；桶未加载时跳过。
   */
  upsertSessionInSpace: (spaceId: string, session: ChatSession) => void
  /**
   * 把会话钉进 Space 桶（overlay + upsert），避免 reconcileSpacePointer
   * 因列表滞后把刚点开的 Project 任务会话打回草稿。
   */
  pinSessionInSpace: (spaceId: string, session: ChatSession) => void
  /** 仅将指定 session 的消息加载到 messagesBySessionId 缓存，不切换全局 session。供分屏 pane 使用。 */
  loadSessionMessages: (sessionId: string) => Promise<void>
  /** 加载更多历史消息（向上滚动时触发） */
  loadMoreMessages: (sessionId: string) => Promise<void>
  /** 各会话是否还有更早的消息可以加载 */
  hasMoreBySessionId: Record<string, boolean>
  /** 各会话是否正在加载更多消息 */
  isLoadingMoreBySessionId: Record<string, boolean>
  /** 选择会话 */
  selectSession: (
    spaceId: string,
    sessionId: string,
    options?: SessionSelectionOptions,
  ) => Promise<void>
  /** 重命名会话 */
  renameSession: (spaceId: string, sessionId: string, title: string) => Promise<void>
  /** 归档会话（从主会话列表移除） */
  deleteSession: (spaceId: string, sessionId: string) => Promise<void>
  /** ：归档确认后立刻从侧栏下架 */
  beginOptimisticArchive: (spaceId: string, sessionId: string) => boolean
  rollbackOptimisticArchive: (spaceId: string, sessionId: string) => void
  /**
   * ：放弃创建 / 预建过期时立即清掉未发消息的空会话
   */
  discardAbandonedEmptySessions: (input: {
    sessionIds: readonly string[]
    reason: 'draft_cancel' | 'prefetch_stale'
    draftSessionPhase?: 'open' | 'sending' | null
    sessionSpaceById?: Record<string, string | undefined>
  }) => void
  /** 永久删除会话（仅用于归档管理） */
  deleteSessionPermanently: (spaceId: string, sessionId: string) => Promise<void>
  /** 获取归档会话列表 */
  listArchivedSessions: (spaceId: string, organizationId?: string, limit?: number) => Promise<ChatSession[]>
  /**
   * 查看归档会话（不改 status，可继续聊；归档会话可继续聊的口径）
   */
  viewArchivedSession: (spaceId: string, session: ChatSession) => Promise<void>
  /** 取消归档：重新置为 active，回到主会话列表 */
  restoreSession: (spaceId: string, sessionId: string) => Promise<ChatSession>
  /** 正在 fork 的会话 ID（防重复点击） */
  forkingSessionId: string | null
  /** Fork 会话（创建分支会话，包含到 fork 点为止的完整历史） */
  forkSession: (spaceId: string, sessionId: string, messageId?: string) => Promise<ChatSession | null>
  unforkSession: (spaceId: string, sessionId: string) => Promise<ChatSession | null>
  /** 生成会话标题 */
  generateTitle: (sessionId: string, force?: boolean) => Promise<void>


  // ==================== 消息管理 ====================
  /** 发送消息（支持附件 + 上下文引用） */
  sendMessage: (message: string, streaming?: boolean, attachments?: import('../../components/chat/types').ChatAttachment[], contextBlocks?: Array<Record<string, unknown>>, targetSessionId?: string, options?: SendMessageOptions) => Promise<SendSubmissionResult>
  /** 中止流式输出。传入 sessionId 只中止指定 session，不传则中止全部。默认 Stop：已发送不恢复。 */
  abortStream: (sessionId?: string) => void
  /**
   * 停止并编辑（改口）：撤回本轮用户消息及之后半截助手，再把原始输入回填 Composer。
   * 主 Composer 单一 Stop 在「尚无实质输出」时内部调用；也可供其它改口入口复用。
   */
  abortStreamForUserEdit: (sessionId: string) => Promise<void>
  /**
   * 主 Composer 单一 Stop：按本轮是否已有助手实质输出，决定只停答或撤回并回填。
   */
  abortStreamFromComposer: (sessionId: string) => Promise<void>
  /** 中止流式输出并等待后端 run cancel 完成 */
  abortStreamAndWait: (timeoutMs?: number, sessionId?: string | null) => Promise<{ cancelRequested: boolean; cancelCompleted: boolean }>
  /** 手动触发指定 session 的消息同步（供异常恢复路径、检查点补偿等调用） */
  syncSessionMessagesFromServer: (sessionId: string) => Promise<number>
  /** 仅移除前端 streaming 状态；可选择是否同时清理 seq-gap 补同步 */
  removeStreamingSession: (
    sessionId: string,
    options?: {
      clearSeqGapSync?: boolean
      runId?: string | null
      dispatchToken?: string | null
    },
  ) => void
  /**
   * W7c P0-2：把 session 标记为 streaming 状态。
   *
   * 既有 IPC 路径在 sendMessageAction 内部通过闭包持有此函数；W7c 观察端
   * 订阅器（renderer hooks/useObserverStreamMirror.ts）也需要 — 当观察端
   * 收到 lifecycle.start 等事件时同步把 UI 切到"streaming"，否则用户在
   * 镜像视图里看不到"Agent 正在工作"的反馈。导出后两端共用同一实现。
   */
  addStreamingSession: (sessionId: string, runId?: string | null) => void

  // ==================== 上下文同步 ====================
  /** 最近一次成功同步的上下文指纹（按会话） */
  lastContextSyncFingerprintBySessionId: Record<string, string>
  /** 同步当前标签上下文到 Chat（含所有打开标签及分屏组信息） */
  syncContext: (
    spaceId?: string | null,
    appType?: string | null,
    appMeta?: Record<string, unknown> | null,
    openTabs?: Array<{type: string; id: string; title?: string; active?: boolean; group_id?: string}> | null,
    options?: { force?: boolean; targetSessionId?: string },
  ) => Promise<void>
  // ==================== 检查点管理 ====================
  /** 正在执行恢复操作的 sessionId（null = 无） */
  restoringSessionId: string | null
  /** 恢复操作当前所处阶段，用于 RestoreOverlay 分步文案 */
  restoringPhase: import('./checkpoint/slices/checkpointSlice').RestoringPhase | null
  /** 按 session 标记恢复操作是否被用户中断，用于显示持久提示 */
  restoreInterruptedBySessionId: Record<string, boolean>
  /** 按 session 标记回退态是否由「编辑并重发」产生（true 时不弹回退横幅，） */
  editResendRevertBySessionId: Record<string, boolean>
  /** 按 session 记录用户已折叠的回退提示版本，避免同一次成功回退反复占位 */
  revertBannerCollapsedBySessionId: Record<string, string>
  /** sessionId → { messageId → commitHash } 映射（per-session checkpoint 缓存） */
  checkpointsBySessionId: Record<string, Record<string, string>>
  /** 按 session 记录回滚前的安全检查点 hash（可用于撤销回滚） */
  lastSafetyCheckpointBySessionId: Record<string, string>
  /** 按 session 跟踪连续创建检查点失败次数 */
  checkpointFailCountBySessionId: Record<string, number>
  /** 按 session 跟踪 checkpoint 健康状态（healthy / warning / error） */
  checkpointHealthBySessionId: Record<string, import('./checkpoint/slices/checkpointSlice').CheckpointHealth>
  /**
   * Per-session checkpoint pending context 队列（专题：Checkpoint 产品对齐 / Gap 1 / ）。
   *
   * sendMessage baseline 阶段拿到 spaceId / baselineHashPromise 后 **enqueue**；
   * lifecycle.end 按 FIFO **consume**——避免同会话连发时后一轮覆盖前一轮 baseline。
   *
   * Fail-soft：队列空则跳过 createCheckpoint，由可归因日志暴露（禁止静默）。
   */
  checkpointPendingContextBySessionId: Record<string, Array<{
    spaceId?: string
    baselineHashPromise: Promise<string | undefined>
    userLocalMessageId?: string
    userClientMessageId?: string
    userServerMessageId?: string
  }>>
  /** enqueue pending context（kickoff 时调用；同会话可堆积多条） */
  setCheckpointPendingContext: (sessionId: string, ctx: {
    spaceId?: string
    baselineHashPromise: Promise<string | undefined>
    userLocalMessageId?: string
    userClientMessageId?: string
    userServerMessageId?: string
  }) => void
  /** FIFO 消费一条 pending（lifecycle.end 使用）；队列空返回 undefined */
  consumeCheckpointPendingContext: (sessionId: string) => {
    spaceId?: string
    baselineHashPromise: Promise<string | undefined>
    userLocalMessageId?: string
    userClientMessageId?: string
    userServerMessageId?: string
  } | undefined
  /** 清空该 session 全部 pending（驱逐 / reset / 回滚兜底） */
  clearCheckpointPendingContext: (sessionId: string) => void

  /** 创建检查点（agent run 完成后调用） */
  createCheckpoint: (sessionId: string, messageId: string, stateIndexHint?: number, meta?: { spaceId?: string; agentRunId?: string; baselineHash?: string; kind?: 'agent_turn_done' | 'error_compensation' | 'manual' }) => Promise<void>
  /** 用户手动创建 Space 快照（不绑定消息锚点） */
  createManualCheckpoint: (sessionId?: string | null) => Promise<void>
  /** 撤销回滚：恢复文件到回滚前状态，重新加载全部消息 */
  unrevertSession: (sessionId?: string | null) => Promise<void>
  /**
   * 获取某个 checkpoint 相对于当前工作区的文件变更列表。
   * ：可选 `sessionId`——传入时按该会话的执行根（绑定优先）解析路径；
   * 缺省时回落全局 active Space 根，行为与改动前一致。
   */
  getCheckpointDiff: (checkpointHash: string, sessionId?: string | null) => Promise<DiffFileEntry[]>
  /** 编辑消息并恢复：回滚对话+文件 → 重新发送 */
  restoreAndEdit: (messageId: string, newContent: string, attachments?: import('../../components/chat/types').ChatAttachment[], contextBlocks?: Array<Record<string, unknown>>, sessionId?: string) => Promise<void>
  /** 仅回退到指定检查点（不重新发送消息） */
  rollbackToCheckpoint: (messageId: string, sessionId?: string, resourceRestorePlan?: chatExtraApi.ResourceRestoreInfo[]) => Promise<void>
  /** 回退预览状态（展示 RewindPreviewPanel 时使用） */
  rewindPreview: import('./checkpoint/slices/checkpointSlice').RewindPreviewState | null
  /** 请求回退预览（触发 RewindPreviewPanel 展示） */
  requestRewindPreview: (sessionId: string | null, targetMessageId: string, mode: 'rollback' | 'editAndResend', editContent?: string, editAttachments?: import('../../components/chat/types').ChatAttachment[], editContextBlocks?: Array<Record<string, unknown>>, resendIntent?: 'edit' | 'resend') => void
  /** 取消回退预览 */
  cancelRewindPreview: () => void
  /**  self-heal：回退命中 404「目标消息不存在」时，强制从服务端重拉消息+重建 checkpoint 映射 */
  resyncMessagesAfterMissingTarget: (sessionId: string | null) => Promise<void>
  /** 确认回退预览并执行 */
  confirmRewindPreview: (confirmation: RecoveryPlanConfirmation) => Promise<void>
  retryFailedResourceRestore: (sessionId?: string | null) => Promise<void>
  resourceRetryCountBySessionId: Record<string, number>
  /** 按 agent_run_id 回滚 AI 一轮操作涉及的资源（不截断对话消息） */
  rollbackAgentRun: (agentRunId: string) => Promise<void>
  /** Daemon checkpoint 失败时由 WS 事件处理器调用，累计 failCount（per-file 迁移期不再驱动 checkpointHealth/告警） */
  reportCheckpointFailure: (sessionId: string) => void
  /** Daemon checkpoint 成功时由 WS 事件处理器调用，清零 failCount */
  reportCheckpointSuccess: (sessionId: string) => void
  /** 崩溃恢复：检查 session 是否在崩溃期间被后端回滚，如有则同步消息 */
  reconcileSessionState: (sessionId: string) => boolean

  // ==================== 消息定位（通用） ====================
  /**
   * 跳转到指定 session 的指定消息并高亮。
   *
   * options（PRD 3.5 / 统一搜索 Wave 3）：
   * - highlight: 锚定后是否高亮 1.5s（默认 true）
   * - highlightTerms: 命中关键词；Wave 3 只透传到 store，二次高亮列入 R3-xx
   * - loadContextWindow: 期望加载窗口总条数（默认 DEFAULT_CONTEXT_WINDOW_SIZE）。
   *   目标不在窗口时经后端 around= 端点加载其上下文窗口再定位。
   */
  scrollToMessage: (
    sessionId: string,
    messageId: string,
    options?: {
      highlight?: boolean
      highlightTerms?: string[]
      loadContextWindow?: number
    },
  ) => void
  /**
   * 跨 session 跳转到指定消息（增强版：按需加载时间窗口）。
   *
   * 用于版本面板/checkpoint 卡片/checkpoint_context 联动跳转：
   * 当目标消息不在当前会话已加载窗口内时，经后端 around= 端点加载其上下文窗口再定位。
   */
  navigateToMessage: (sessionId: string, messageId: string) => Promise<void>
  /** 当前需要滚动定位的消息 ID（MessageList 消费后自动清除） */
  scrollTargetMessageId: string | null
  /**
   *  引用回复：每个 session 当前 composer 选中的引用目标（发送后清空）。
   * 按 sessionId 隔离，切 session 各自保留自己的草稿引用态。
   */
  replyTargetBySessionId: Record<string, ChatReplyTarget | null>
  /** 设置某 session 的引用目标（消息气泡「引用」按钮触发） */
  setReplyTarget: (sessionId: string, target: ChatReplyTarget) => void
  /** 清除某 session 的引用目标（用户点 X / 发送完成后） */
  clearReplyTarget: (sessionId: string) => void
  /**
   * 锚定后是否在目标消息上播放 1.5s 高亮 pulse（PRD 3.5）。
   * 默认 true；为 false 时 MessageList 仅滚动定位不加高亮。
   */
  scrollTargetHighlight: boolean
  /**
   * 命中关键词（多个）；MessageBubble 可根据该字段做二次高亮。
   * Wave 3 暂不在 MessageBubble 内消费此字段（成本/收益评估见 R3-xx）。
   */
  scrollTargetHighlightTerms: string[] | null
  /** 清除滚动目标（MessageList 消费后调用） */
  clearScrollTarget: () => void

  // ==================== 消息写入：逻辑内聚的业务 action ====================
  // 对 messagesBySessionId 的所有写入按业务事件命名，逻辑内聚在 store（find/dedup/
  // patch/截断/合并/门控）。裸 set/updateSessionMessages 为私有原语，不对外暴露。
  /** 用户发出的消息进入本地时间线（乐观气泡）。 */
  appendOutgoingMessage: (sessionId: string, message: ChatMessage) => void
  /** 注入系统 / 摘要 / HITL 气泡（按 id 去重，不重复插入）。 */
  injectSystemMessage: (sessionId: string, message: ChatMessage) => void
  /** 注入错误气泡（按 content + isErrorMessage 去重）。 */
  injectErrorBubble: (sessionId: string, message: ChatMessage) => void
  /** 观察端注入 user 消息（多键去重）。 */
  upsertObservedUserMessage: (sessionId: string, message: ChatMessage) => void
  /** HITL 气泡：命中占位则就地改写，否则追加。 */
  upsertHitlBubble: (sessionId: string, placeholderMessageId: string | null | undefined, bubble: ChatMessage) => void
  /** 流式建壳 / 观察端补齐：按 id 幂等，已存在不动。 */
  ensureAssistantMessage: (sessionId: string, message: ChatMessage) => void
  /** 按 id 追加或替换一条消息。 */
  upsertMessage: (sessionId: string, message: ChatMessage) => void
  /** 删除一条消息（失败气泡 / 本地系统气泡）。 */
  removeMessage: (sessionId: string, messageId: string) => void
  /** 批量删除多条消息。 */
  removeMessages: (sessionId: string, messageIds: readonly string[]) => void
  /** 改口截断：撤回锚点消息及其后全部内容。 */
  truncateFromMessage: (sessionId: string, anchor: { localMessageId?: string; clientMessageId?: string }) => void
  /** 单条按 id patch（find 在 store，字段变换由 patcher 给）。 */
  patchMessageById: (sessionId: string, messageId: string, patcher: (message: ChatMessage) => ChatMessage) => void
  /** 落库 id 回填：补 metadata.message_id = 服务端 id。 */
  linkServerMessageId: (sessionId: string, localMessageId: string, serverId: string) => void
  /** 分页：去重后前插更早的历史消息。 */
  prependOlderMessages: (sessionId: string, older: ChatMessage[]) => void
  /** 清空本会话消息。 */
  clearSessionMessages: (sessionId: string) => void
  /** 从 IDB 缓存水合。 */
  hydrateFromCache: (sessionId: string, messages: ChatMessage[]) => void
  /** 首屏加载 / 切会话落地已加载页。 */
  applyLoadedMessages: (sessionId: string, messages: ChatMessage[]) => void
  /** 服务端对账：merge + epoch 门控 + 写 + cache 内聚，返回结果供维护 freshness/分页。 */
  reconcileFromServer: (sessionId: string, fetchEpoch: number, fresh: ChatMessage[], opts?: { advanceWatermark?: boolean; syncWatermark?: string }) => { changed: boolean; newCount: number; dropped: boolean }
  /** 回退：权威整表替换（含结构性变更登记），返回落地列表。 */
  replaceFromRollback: (sessionId: string, serverMessages: ChatMessage[]) => ChatMessage[]
  /** 回退：截断后写回（含 rewind summary）。 */
  applyRollbackTruncation: (sessionId: string, messages: ChatMessage[]) => void
  /** 应用 checkpoint 决策摘要（按 messageId 或 checkpointId 定位），返回是否命中。 */
  applyCheckpointDecisionSummary: (sessionId: string, locator: { messageId?: string; checkpointId?: string }, decisionSummary: NonNullable<NonNullable<ChatMessage['checkpoint_record']>['context_summary']>['decision_summary']) => boolean
  /** 重绑消息 id（synthetic user 落库后 client_event_id → server_id 收敛）。 */
  rebindMessageIds: (sessionId: string, idPairs: ReadonlyArray<readonly [oldId: string, newId: string]>) => void
  /** 子 Agent live/归档消息并入父时间线。 */
  mergeSubagentMessages: (sessionId: string, toStoreMessage: (dm: ChatMessage) => ChatMessage, incoming: ChatMessage[], mode: 'live' | 'flush' | 'seed') => void
  /** 设置指定 Space 的会话列表 */
  setSpaceSessions: (spaceId: string, sessions: ChatSession[], syncCurrent?: boolean) => void
  /** 设置指定 Space 当前选中的会话 ID */
  setCurrentSessionForSpace: (
    spaceId: string,
    sessionId: string | null,
    syncCurrent?: boolean,
    options?: {
      draftScopeKey?: string | null
      organizationId?: string | null
      executionWorkspaceId?: string | null
      projectId?: string | null
      agentId?: string | null
    },
  ) => void
  /** Phase 5：设置指定 workspace scope 的 session 指针（desktop auxiliary chat） */
  setCurrentSessionForWorkspace: (workspaceKey: string, sessionId: string | null, syncCurrent?: boolean) => void
  /** 设置指定 workspace 草稿的执行 Space。 */
  setDraftExecutionSpaceForWorkspace: (workspaceKey: string, spaceId: string | null) => void
  /** 进入指定宿主的“新会话草稿态”（显式 draftScopeKey 优先于 legacy host） */
  startDraftSessionForSpace: (
    spaceId: string,
    syncCurrent?: boolean,
    options?: {
      draftScopeKey?: string | null
      organizationId?: string | null
      executionWorkspaceId?: string | null
      projectId?: string | null
      agentId?: string | null
    },
  ) => void
  /** 清除指定 Space 的“新会话草稿态” */
  clearDraftSessionForSpace: (spaceId: string) => void
  /**
   * 只清前台全局会话选中（`currentSessionId`）。
   * 不碰 per-Space 记忆 / 消息缓存桶——切组织硬重置用。
   */
  clearForegroundSessionSelection: () => void
  /**
   * 更新会话列表缓存中某个会话的标题。
   *
   * 默认 `bumpUpdatedAt=false`——后台 LLM 自动生成标题 (WS title_updated)
   * 不该把老会话提到"今天"分组。用户手动 rename / fork 写回这种"用户活动"
   * 路径要显式 `bumpUpdatedAt: true`。详见实现处的 JSDoc。
   */
  updateSessionTitleInCaches: (
    sessionId: string,
    title: string,
    opts?: { bumpUpdatedAt?: boolean },
  ) => void
  /** 更新会话列表缓存中某个会话的任意字段 */
  updateSessionInCaches: (sessionId: string, patch: Partial<ChatSession>) => void
  /** 更新会话列表缓存中某个会话的 token usage */
  updateSessionTokenUsageInCaches: (sessionId: string, usage: ChatSessionTokenUsage) => void

  // ==================== 重置 ====================
  /** 重置所有状态 */
  reset: () => void
  /**
   * Wave 3: 清理指定 organization 名下所有 space 的会话、消息、流式状态。
   *
   * 调用场景：`organization.membership_changed` 事件处理器 —— 用户被移出 organization
   * 时清除相关本地缓存。
   *
   * 必须由 store 自管以保证内部 LRU accessOrder（_spaceAccessOrder /
   * _sessionAccessOrder）与缓存快照一致；外部 setState 直接改
   * sessionsBySpaceId 会把僵尸 spaceId 留在 accessOrder，导致
   * MAX_CACHED_AGENT_SPACES 失守。
   *
   * 同步联动 useChatRuntimeStore.evictSessionBatch 清理 runtime 级状态。
   */
  purgeOrganizationSpaces: (
    organizationId: string,
    knownSpaceIds?: readonly string[],
  ) => void
}

// Helper functions imported from chat/helpers.ts (see import block above)


// 消息/Space 列表双 LRU（_sessionAccessOrder / _spaceAccessOrder）+ 上限
// → chat/messages/messageCacheSlice.ts（purge/reset 经导出的 helper 操作）

/**
 * Evict all per-session runtime data for a given sessionId.
 * Returns a partial state update — only includes maps where the session actually had data.
 */
import { CHAT_STORE_SESSION_KEYS as _CHAT_STORE_SESSION_KEYS } from './session/utils/evictSessionData'
import { useChatRuntimeStore } from '../useChatRuntimeStore'
// ：注册 runtime → messages 的 content blocks 桥（messageBlocks 模块级
// setContentBlocksBridge）+ 入口反序列化原语。消息进入 messagesBySessionId 时把落库
// 序列化形态 content_blocks_json 一次性反序列化进 committed + message.blocks（保 arrival_seq），
// 之后所有块读路径只认 message.blocks，读时不再回退读 content_blocks_json。
import { endSessionRun } from './stream/handlers/sessionCleanup'

// 消息定位（scroll/navigate）+ 引用回复 + DEFAULT_CONTEXT_WINDOW_SIZE
// → chat/messages/navigationSlice.ts；重导出常量以保持 chatSessionNavigation 等外部 import 契约。
export { DEFAULT_CONTEXT_WINDOW_SIZE } from './messages/navigationSlice'

const CANCEL_SYNC_DELAY_MS = 1_500

/**
 * Post-abort cleanup: mark agent steps as cancelled, update RunState,
 * clear HITL state, then schedule a message sync to pick up the
 * backend-persisted partial reply.
 */
function performCancelCleanup(
  sessionId: string,
  removeStreamingSession: (sid: string, options?: { clearSeqGapSync?: boolean }) => void,
  clearHitlState: (sessionId: string) => void,
): void {
  // ：abort 收口走 endSessionRun（写 endedAt + 清 busy）
  endSessionRun({
    sessionId,
    status: 'cancelled',
    removeStreamingSession,
  })
  clearHitlState(sessionId)
  useChatStore.getState().clearHostPendingSends(sessionId)
}

function scheduleCancelSync(sessionId: string): void {
  // 用 setTimeout 延迟到模块加载完毕之后；setTimeout 回调执行时 module
  // 已完全初始化，直接引用顶部的 `useChatStore` 即可（live binding）。
  // 之前用 dynamic import('./useChatStore') 是没必要的自循环，被 madge 标为
  // self-import。
  setTimeout(() => {
    useChatStore.getState().syncSessionMessagesFromServer(sessionId).catch(() => {})
  }, CANCEL_SYNC_DELAY_MS)
}

/**
 * abort 路径的 HITL 面板清理（abortStream / abortStreamAndWait 共用）。
 *
 * ：清面板前记墓碑——用户中止 run 即「这些交互已了结」，服务端 PendingInteraction
 * 翻终态有延迟窗口，不记墓碑的话随后的 cancel sync 会从仍是 pending 的 hitl_interaction
 * 消息把面板派生回开（reconcileHitlPanelsFromMessages 的恢复路径）。
 */
function _clearHitlOnAbort(sid: string): void {
  const s = useChatStore.getState()
  const patch: Record<string, unknown> = {}
  const pendingApproval = s.pendingApprovalBySessionId[sid]
  if (pendingApproval) {
    recordHitlResolvedKey(sid, pendingApproval.batchId)
    const next = { ...s.pendingApprovalBySessionId }; delete next[sid]
    patch.pendingApprovalBySessionId = next
  }
  const pendingAsk = s.pendingAskUserBySessionId[sid]
  if (pendingAsk) {
    recordHitlResolvedKey(sid, pendingAsk.interruptId)
    recordHitlResolvedKey(sid, pendingAsk.toolCallId)
    recordHitlResolvedKey(sid, pendingAsk.messageId)
    const next = { ...s.pendingAskUserBySessionId }; delete next[sid]
    patch.pendingAskUserBySessionId = next
  }
  if (Object.keys(patch).length) useChatStore.setState(patch as Partial<ChatState>)
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => {
      // Zustand's set/get are typed as ChatState, but each slice only needs a subset.
      // narrowGet/narrowSet (chat/sliceAdapters.ts) handle the boundary with
      // `as unknown as` (no `as any`) and properly wrap updater functions.
      // Compile-time assertions (see bottom of this file) verify key subsets.
      // ══ 消息缓存层 → chat/messages/messageCacheSlice.ts ══════════════════
      // 双 LRU + 原语 setSessionMessages/updateSessionMessages + 20 写 action +
      // setSpaceSessions 全部内聚该 slice；提前创建以供下方 ensureMessageWindowLoaded /
      // abort 标记 helper / sendMessageAction 等 deps 复用其原语。
      const messageCacheActions = createMessageCacheActions(get, set)
      const setSessionMessages = messageCacheActions.setSessionMessages
      const updateSessionMessages = messageCacheActions.updateSessionMessages

      // ：中断标记按 ActiveRunBinding，禁止「最后一条 assistant」启发式。
      const _markActiveRunInterrupted = (sid: string, targetRunId?: string | null) => {
        const explicitRunId = targetRunId?.trim() || null
        if (explicitRunId) {
          noteAbortedRunId(sid, explicitRunId)
        }
        const snap = explicitRunId ? getActiveRunBinding(sid).interrupted : snapshotInterruptedBinding(sid)
        const projection = getSessionRunProjection(sid)
        const runId = explicitRunId ?? snap?.runId ?? projection?.localRunId ?? null
        const messageId = snap?.messageId ?? null
        if (!snap && runId) {
          noteAbortedRunId(sid, runId)
        }
        if (!runId && !messageId) return

        updateSessionMessages(sid, prev => {
          let targetId: string | undefined
          if (messageId && prev.some((m) => m.id === messageId && m.role === 'assistant')) {
            targetId = messageId
          } else if (runId) {
            for (let i = prev.length - 1; i >= 0; i -= 1) {
              const m = prev[i]
              if (m.role !== 'assistant') continue
              if ((m as { subagent_run_id?: string }).subagent_run_id) continue
              if (m.agent_run_id === runId) {
                targetId = m.id
                break
              }
            }
          }
          if (!targetId) return prev
          return prev.map((m) => {
            if (m.id !== targetId) return m
            if ((m as { intent?: string }).intent === 'interrupted') return m
            return {
              ...m,
              intent: 'interrupted' as const,
              stop_reason: m.stop_reason ?? 'aborted',
            }
          })
        })
      }

      // ：supersede 用 binding / 投影的 runId，不再扫最后一条 assistant。
      const _markCurrentRunSuperseded = (sid: string, targetRunId?: string | null) => {
        const explicitRunId = targetRunId?.trim()
        if (explicitRunId) {
          markRunSuperseded(sid, explicitRunId)
          return
        }
        const binding = getActiveRunBinding(sid)
        const runId =
          binding.interrupted?.runId
          ?? binding.runId
          ?? getSessionRunProjection(sid)?.localRunId
          ?? null
        if (runId) markRunSuperseded(sid, runId)
      }


      // 自包含会话指针 / 列表缓存写入 + getSessionById → chat/session/slices/sessionPointerSlice.ts
      // 提前创建以便下方 sendMessageAction deps 复用 updateSession*InCaches。
      const sessionPointerActions = createSessionPointerActions(get, set, {
        resolveActiveSpaceId,
      })

      // 消息定位 + 引用回复编排 → chat/messages/navigationSlice.ts
      const navigationActions = createNavigationActions({ get, set, getChatClient, setSessionMessages })

      const addStreamingSession = (_sessionId: string, _runId?: string | null) => {
        //  / ：busy 只镜像 run_sync / run_state。本符号仅为历史调用点
        // 保留的空钩子，禁止再当第二 busy 源。
      }

      const removeStreamingSession = (
        sessionId: string,
        options?: {
          clearSeqGapSync?: boolean
          runId?: string | null
          dispatchToken?: string | null
        },
      ) => {
        //  / ：终态 choke point（lifecycle / abort / 断连）——清 runtime
        // 副作用；busy 由 run_sync / reconcile / run_state 收口，不在此写投影。
        const runtime = useChatRuntimeStore.getState()
        // abortStream 的 session-specific 快路径会直接走本 choke point，不一定先
        // 进入 cleanupSessionOnTerminal。此时用 cancelling 意图写中性 cancelled，
        // 避免 interrupted assistant 被旧消息启发式误画成 failed。
        // ：不再 markRun*；busy 由 run_sync idle / reconcile / run_state 收口。
        runtime.trimToolEventsForSession(sessionId)
        // Widget Wave 3（RFC §五 3.6 + 反思 5）：WS 死链 / reconnect / abortStream
        // 路径**不走** lifecycleHandler，但同样会调本函数清 streamingBySessionId。
        // streaming widget block 残留在 streamingRichBlocks 没人 mark interrupted
        // → RichWidget placeholder 永远转圈。这里兜底 mark 'unknown'：lifecycleHandler
        // 路径已经先 mark 过具体 status（'cancelled'/'error'/'terminated'）的话，
        // store action 内部幂等不覆盖；纯 WS 死链路径用 'unknown' 标记让 UI 显示
        // "已中断"badge 而不是永远转圈。
        runtime.markStreamingWidgetsInterruptedAndClearOthers(sessionId, 'unknown')
        if (options?.clearSeqGapSync !== false) {
          cleanupSeqTracker(sessionId)
        }
      }

      const toAbortWaitResult = (res: AbortRunResult): { cancelRequested: boolean; cancelCompleted: boolean } => ({
        cancelRequested: res.localHit || res.remoteAccepted || res.remoteRequested,
        // StreamManager 只负责断开本地监听；真正的执行取消以 adapter 结果为准。
        // localHit = 已中止本机 runtime；remoteAccepted = Django 已接受 cancel、
        // 已 forward 或写入 durable marker，等待式上层可以继续后续用户动作。
        cancelCompleted: res.localHit || res.remoteAccepted,
      })

      const cancelRuntimeIfNeeded = (_sessionId: string): Promise<AbortRunResult> => {
        //  停止链路收口：改走 agentService——本机 IPC 快
        // 路径 miss（daemon 托管 / 遥控 / forward 在别的设备 / 已释放）时自动
        // 发后端 `chat.cancel { session_id }` 兜底：Django forward 到真正执行
        // 设备 + 写 durable cancel marker。真正取消不再依赖 UI 自愈；
        // streamMessageHandler 的 streaming 自愈仅剩「两路都没停住」的最后
        // 防线。普通 stop 是 fire-and-forget；abortStreamAndWait 会 await 返回值
        // 并把 adapter 命中结果映射给 checkpoint / unrevert 等等待式流程。
        return getSessionController(_sessionId).abort()
          .then((res) => {
            if (!res.localHit) {
              logger.warn('[Chat] 本地 runtime abort 未命中，已走远端 chat.cancel 兜底', {
                sessionId: _sessionId,
                remoteAccepted: res.remoteAccepted,
                remotePublished: res.remotePublished,
              })
            }
            return res
          })
          .catch(() => ({
            localHit: false,
            remoteRequested: false,
            remoteAccepted: false,
            remotePublished: null,
          }))
      }

      // 中止流编排（abortStream 四兄弟）→ chat/messages/actions/abortStreamAction.ts
      // 共享 helper（ActiveRunBinding 中断标记 / cancelRuntimeIfNeeded 等）经 deps 注入。
      const abortStreamActions = createAbortStreamActions({
        get,
        getChatClient,
        removeStreamingSession,
        markActiveRunInterrupted: _markActiveRunInterrupted,
        markCurrentRunSuperseded: _markCurrentRunSuperseded,
        cancelRuntimeIfNeeded,
        toAbortWaitResult,
        performCancelCleanup,
        scheduleCancelSync,
        clearHitlOnAbort: _clearHitlOnAbort,
      })

      /**
       * 更新会话列表缓存中的标题。
       *
       * @param opts.bumpUpdatedAt - 是否同步 bump `updated_at` 字段。
       *   - **true**：用户活动场景——手动 rename、fork 后回写、消息发送 ACK 回填等。
       *     更新 ``updated_at`` 表达"此会话刚有用户行为"，配合 getSessionActivityTs
       *     的 max() 让会话进入"今天"分组。
       *   - **false**（默认）：**后台运维路径**——LLM 异步生成标题完成后通过
       *     ``agent.user.title_updated`` WS 事件落地。这种纯后台行为不该把老会话
       *     提到"今天"分组（用户视觉上会突然"这几个对话怎么都跑到今天来了"）。
       *     这个 case 后端 ``generate_session_title_task`` 也专门用
       *     ``update_fields=['title', 'title_generation_status']`` 不带 updated_at,
       *     前端这层必须配合，否则后端的"不污染分组"设计被 WS 链路写入抹掉。
       */
      // updateSessionTitleInCaches / updateSessionInCaches / updateSessionTokenUsageInCaches
      // → chat/session/slices/sessionPointerSlice.ts（随 ...sessionPointerActions 装配）

      // Checkpoint actions created early so reconcileSessionState can be passed
      // to sessionCrudSlice via deps callback (crash-recovery wiring).
      const checkpointActions = createCheckpointActions(narrowGet<ChatState, CheckpointStore>(get), narrowSet<ChatState, CheckpointStore>(set), {
        resolveSpacePath: _resolveSpacePath,
        getChatClient,
        //  阶段C：回退成功后的重发经此端口接线，checkpoint slice 不再直接 get().sendMessage。
        resendAfterRestore: (content, attachments, contextBlocks, sessionId) =>
          get().sendMessage(content, true, attachments, contextBlocks, sessionId),
        cleanupRuntimeState: (sessionId) => useChatRuntimeStore.getState().evictSession(sessionId),
        cleanupHitlState: (sessionId, removedMessageIds) => {
          const state = get()
          const pendingApproval = state.pendingApprovalBySessionId[sessionId]
          const pendingAskUser = state.pendingAskUserBySessionId[sessionId]
          const patch: Partial<ChatState> = {}
          if (pendingApproval?.messageId && removedMessageIds.has(pendingApproval.messageId)) {
            const { [sessionId]: _, ...restApproval } = state.pendingApprovalBySessionId
            const { [sessionId]: __, ...restApprovalSub } = state.approvalSubmittingBySessionId
            patch.pendingApprovalBySessionId = restApproval
            patch.approvalSubmittingBySessionId = restApprovalSub
          }
          if (pendingAskUser?.messageId && removedMessageIds.has(pendingAskUser.messageId)) {
            const { [sessionId]: _, ...restAsk } = state.pendingAskUserBySessionId
            const { [sessionId]: __, ...restAskSub } = state.askUserSubmittingBySessionId
            patch.pendingAskUserBySessionId = restAsk
            patch.askUserSubmittingBySessionId = restAskSub
          }
          if (Object.keys(patch).length > 0) set(patch)
        },
      })

      return ({
      // ==================== 初始状态 ====================
      // UI 面板（isPanelOpen / panelWidth / togglePanel / setPanelWidth）→ chat/ui/uiSlice.ts
      ...createUiActions(set),
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
      // 隐患 5 / 方案 ①（charter v1.8 §6.7 主侧栏分桶）：Tracker per_run 懒加载状态
      trackerRunSessionsBySpaceId: {},
      trackerRunCountBySpaceId: {},
      excludedAgentMentionSessionIdsBySpaceId: {},
      trackerRunLoadingBySpaceId: {},
      trackerRunErrorBySpaceId: {},
      trackerRunLoadedBySpaceId: {},
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      getPendingApprovalForSession: (sessionId: string | null) => (
        sessionId ? (get().pendingApprovalBySessionId[sessionId] ?? null) : null
      ),
      isSessionApprovalSubmitting: (sessionId: string | null) => (
        sessionId ? (get().approvalSubmittingBySessionId[sessionId] ?? false) : false
      ),
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      getPendingAskUserForSession: (sessionId: string | null) => (
        sessionId ? (get().pendingAskUserBySessionId[sessionId] ?? null) : null
      ),
      isSessionAskUserSubmitting: (sessionId: string | null) => (
        sessionId ? (get().askUserSubmittingBySessionId[sessionId] ?? false) : false
      ),
      // Runtime state (agentSteps, toolEvents, etc.) → useChatRuntimeStore

      // ==================== Agent / Approval Mode（→ session/slices/modePreferenceSlice.ts） ====================
      ...createModePreferenceActionsForStore(get, set),

      // lastContextSyncFingerprintBySessionId 初始值 → chat/session/slices/contextSyncSlice.ts（随 ...createContextSyncActions 装配）

      // ==================== 检查点状态 ====================
      restoringSessionId: null,
      restoringPhase: null,
      restoreInterruptedBySessionId: {},
      editResendRevertBySessionId: {},
      revertBannerCollapsedBySessionId: {},
      checkpointsBySessionId: {},
      lastSafetyCheckpointBySessionId: {},
      checkpointFailCountBySessionId: {},
      checkpointHealthBySessionId: {},
      checkpointPendingContextBySessionId: {},
      setCheckpointPendingContext: (sessionId, ctx) => {
        set(state => {
          const prev = state.checkpointPendingContextBySessionId[sessionId] ?? []
          return {
            checkpointPendingContextBySessionId: {
              ...state.checkpointPendingContextBySessionId,
              [sessionId]: [...prev, ctx],
            },
          }
        })
      },
      consumeCheckpointPendingContext: (sessionId) => {
        let consumed: ChatState['checkpointPendingContextBySessionId'][string][number] | undefined
        set(state => {
          const queue = state.checkpointPendingContextBySessionId[sessionId]
          if (!queue?.length) return state
          const [head, ...rest] = queue
          consumed = head
          const next = { ...state.checkpointPendingContextBySessionId }
          if (rest.length > 0) next[sessionId] = rest
          else delete next[sessionId]
          return { checkpointPendingContextBySessionId: next }
        })
        return consumed
      },
      clearCheckpointPendingContext: (sessionId) => {
        set(state => {
          if (!(sessionId in state.checkpointPendingContextBySessionId)) return state
          const next = { ...state.checkpointPendingContextBySessionId }
          delete next[sessionId]
          return { checkpointPendingContextBySessionId: next }
        })
      },
      resourceRetryCountBySessionId: {},
      rewindPreview: null,

      // ==================== 消息定位 + 引用回复 ====================
      // scrollToMessage / navigateToMessage / clearScrollTarget / setReplyTarget / clearReplyTarget
      // + scrollTarget*/replyTargetBySessionId 状态 → chat/messages/navigationSlice.ts
      ...navigationActions,

      // ==================== Session 查询 ====================
      // 普通会话与 Tracker Run 分桶统一查询；具体优先级由 sessionPointerSlice 管理。
      // registerChatSessionAccess 复用同一个 action，避免不同调用方出现口径分叉。
      // getSessionById → chat/session/slices/sessionPointerSlice.ts（随 ...sessionPointerActions 装配）

      // ==================== 消息缓存层（20 写 action + 原语 + setSpaceSessions）====================
      // → chat/messages/messageCacheSlice.ts（随 ...messageCacheActions 装配）
      ...messageCacheActions,

      // 会话指针/缓存写入 + getSessionById → chat/session/slices/sessionPointerSlice.ts
      ...sessionPointerActions,

      // ==================== UI 操作 ====================
      // togglePanel / setPanelWidth → chat/ui/uiSlice.ts（随 ...createUiActions(set) 装配）

      // ==================== 外部 Agent / Approval ====================
      // → chat/slices/approvalSlice.ts
      // Zustand's set()/get() types are wider than ApprovalSliceStore; safe because ChatState structurally extends ApprovalSliceStore
      ...createApprovalActions(narrowGet<ChatState, ApprovalSliceStore>(get), narrowSet<ChatState, ApprovalSliceStore>(set), { getChatClient }, {
        addStreamingSession,
        updateSessionMessages,
      }),

      // ==================== 用户提问回答 ====================
      // → chat/slices/askUserSlice.ts
      ...createAskUserActions(narrowGet<ChatState, AskUserSliceStore>(get), narrowSet<ChatState, AskUserSliceStore>(set), { getChatClient }, {
        addStreamingSession,
        updateSessionMessages,
      }),

      // ==================== 会话管理 ====================
      // → chat/actions/sessionLifecycleAction.ts
      // Zustand's set()/get() types are wider than SessionLifecycleStore; safe because ChatState structurally extends it
      ...createSessionLifecycleAction(narrowGet<ChatState, SessionLifecycleStore>(get), narrowSet<ChatState, SessionLifecycleStore>(set), {
        getChatClient,
        resolveActiveSpaceId,
        emptySessions: EMPTY_CHAT_SESSIONS,
        onGroupRuntime: (sessionId, groupRuntime) => {
          useChatRuntimeStore.getState().setGroupRuntimeForSession(sessionId, groupRuntime ?? null)
        },
      }),

      // loadSessions, loadSessionMessages, selectSession, renameSession, deleteSession,
      // deleteSessionPermanently, listArchivedSessions, viewArchivedSession,
      // restoreSession, generateTitle
      // → chat/slices/sessionCrudSlice.ts
      // Zustand's set() type is wider than slice's SetFn; safe because ChatState structurally extends SessionCrudStore
      ...createSessionCrudActions(narrowGet<ChatState, SessionCrudStore>(get), narrowSet<ChatState, SessionCrudStore>(set), {
        getChatClient,
        resolveActiveSpaceId,
        emptySessions: EMPTY_CHAT_SESSIONS,
        reconcileRevertedSession: (sessionId) => checkpointActions.reconcileSessionState(sessionId),
      }),

      // ==================== 消息管理 ====================
      // → chat/actions/sendMessageAction.ts
      sendMessage: createSendMessageAction({
        get: narrowGet<ChatState, SendMessageStore>(get),
        set,
        getChatClient,
        updateSessionMessages,
        addStreamingSession,
        removeStreamingSession,
        updateSessionInCaches: sessionPointerActions.updateSessionInCaches,
        updateSessionTokenUsageInCaches: sessionPointerActions.updateSessionTokenUsageInCaches,
        resolveSpacePath: _resolveSpacePath,
        buildReviewMessage,
      }),
      removeStreamingSession,
      // W7c P0-2：暴露给观察端订阅器（useObserverStreamMirror）的同源实现。
      addStreamingSession,

      // 中止流编排（abortStream/ForUserEdit/FromComposer/AndWait）→ chat/messages/actions/abortStreamAction.ts
      ...abortStreamActions,

      syncSessionMessagesFromServer: async (sessionId: string): Promise<number> => {
        const result = await reconcileSessionMessages(sessionId, {
          force: true,
          retry: false,
          silentOnError: false,
          reason: 'syncSessionMessagesFromServer',
        })
        return result.newCount
      },

      // ==================== 上下文同步 ====================
      // ==================== 上下文同步 ====================
      // → chat/slices/contextSyncSlice.ts
      // Zustand's set()/get() types are wider than ContextSyncStore; safe because ChatState structurally extends it
      ...createContextSyncActions(narrowGet<ChatState, ContextSyncStore>(get), narrowSet<ChatState, ContextSyncStore>(set), { getChatClient }),

      prefetchSessionForDraft: (params) => {
        const prefetch = createSessionPrefetchAction(
          narrowGet<ChatState, SessionPrefetchStore>(get),
          {
            ensureSessionForSpace: (...args) => get().ensureSessionForSpace(...args),
            syncContext: (...args) => get().syncContext(...args),
            updateSessionInCaches: (sessionId, patch) => {
              get().updateSessionInCaches(
                sessionId,
                patch as Parameters<ChatState['updateSessionInCaches']>[1],
              )
            },
            patchSessionAgent: (sessionId, agentId) =>
              getChatClient().sessions.update(sessionId, { agent_id: agentId }),
          },
        )
        return prefetch.prefetchSessionForDraft(params)
      },

      // ==================== 检查点管理（→ chat/slices/checkpointSlice.ts） ====================
      // checkpointActions created earlier (above return) to wire reconcileRevertedSession callback
      ...checkpointActions,

      // ：Host 镜像待发区（queued ACK → defer_bubble）
      ...createHostPendingSendActions(get, set),

      // Host 级插队（promote + abort active，不清队；乐观上主时间线）
      ...createInterruptHostPendingActions({
        get,
        markActiveRunInterrupted: _markActiveRunInterrupted,
        markCurrentRunSuperseded: _markCurrentRunSuperseded,
        bumpSessionSidebarOnSend: (sessionId, displayMessage) => {
          bumpSidebarOnSend({
            sessionId,
            displayMessage,
            sessions: get().sessions,
            updateSessionInCaches: (id, patch) => {
              get().updateSessionInCaches(
                id,
                patch as Parameters<ChatState['updateSessionInCaches']>[1],
              )
            },
          })
        },
      }),

      // Host 排队移除 / 撤回编辑（cancel-queued-run + 镜像清理 / prefill）
      ...createCancelHostPendingActions(get),

      // ==================== 生命周期编排（reset / purgeOrganizationSpaces）====================
      // → chat/session/actions/storeLifecycleAction.ts
      ...createStoreLifecycleActions(get, set),

    })
    },
    withPersistSafety<ChatState, Pick<ChatState, 'isPanelOpen' | 'panelWidth' | 'agentMode'>>({
      name: PERSIST_KEYS.chat,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['tabtin-chat-store'])),
      partialize: (state) => ({
        isPanelOpen: state.isPanelOpen,
        panelWidth: state.panelWidth,
        agentMode: state.agentMode,
      }),
      // ：v1 → v2 触发 migrate 做 legacy yolo 归一（zustand 仅在版本号
      // 变化时调 migrate）。
      // ：v3 停止持久化 approvalMode / approvalModeBySessionId；Workspace
      // approval_grant 成为唯一数据源，旧缓存随迁移自然丢弃。
      version: 3,
      //  legacy 归一：旧版持久化的 agentMode='yolo' 迁移为
      // agent + approvalMode='auto'（yolo 档已从任务模式选择器移除）。
      migrate: (persisted: unknown, _version: number): Pick<ChatState, 'isPanelOpen' | 'panelWidth' | 'agentMode'> => {
        const p = persisted as Pick<ChatState, 'isPanelOpen' | 'panelWidth' | 'agentMode'>
        if ((p?.agentMode as string) === 'yolo') {
          return {
            isPanelOpen: p.isPanelOpen,
            panelWidth: p.panelWidth,
            agentMode: 'agent' as AgentModeName,
          }
        }
        return {
          isPanelOpen: p.isPanelOpen,
          panelWidth: p.panelWidth,
          agentMode: p.agentMode,
        }
      },
    })
  )
)

registerResetAction('chat', 'reset', () => useChatStore.getState().reset())

// failed 消息 GC：清理超过 24h 的 sendStatus='failed' 消息
const _FAILED_GC_INTERVAL_MS = 30 * 60 * 1000
const _MAX_FAILED_AGE_MS = 24 * 60 * 60 * 1000

function _runFailedMessageGC() {
  const now = Date.now()
  const state = useChatStore.getState()
  const msgs = state.messagesBySessionId
  let hasChanges = false
  const cleaned: Record<string, ChatMessage[]> = {}
  for (const [sid, list] of Object.entries(msgs)) {
    const filtered = list.filter(m => {
      const local = m as import('./shared/types').LocalChatMessage
      if (local.sendStatus !== 'failed') return true
      const age = now - new Date(m.created_at).getTime()
      if (!Number.isFinite(age)) return true
      return age < _MAX_FAILED_AGE_MS
    })
    if (filtered.length < list.length) hasChanges = true
    cleaned[sid] = filtered.length < list.length ? filtered : list
  }
  if (hasChanges) {
    useChatStore.setState({ messagesBySessionId: cleaned })
  }
}

setTimeout(_runFailedMessageGC, 5000)
const _failedGcTimer = setInterval(_runFailedMessageGC, _FAILED_GC_INTERVAL_MS)
if (import.meta.hot) {
  import.meta.hot.dispose(() => clearInterval(_failedGcTimer))
}

// Compile-time structural assertions — fail if a slice store has keys missing from ChatState.
// These are pure types (zero runtime cost) and catch key-drift during refactors.
type _AssertUi = AssertSliceOf<UiStore, ChatState>
type _AssertSessionPointer = AssertSliceOf<SessionPointerStore, ChatState>
type _AssertMessageCache = AssertSliceOf<MessageCacheStore, ChatState>
type _AssertAbortStream = AssertSliceOf<AbortStreamStore, ChatState>
type _AssertNavigation = AssertSliceOf<NavigationStore, ChatState>
type _AssertApproval = AssertSliceOf<ApprovalSliceStore, ChatState>
type _AssertAskUser = AssertSliceOf<AskUserSliceStore, ChatState>
type _AssertLifecycle = AssertSliceOf<SessionLifecycleStore, ChatState>
type _AssertCrud = AssertSliceOf<SessionCrudStore, ChatState>
type _AssertSendMsg = AssertSliceOf<SendMessageStore, ChatState>
type _AssertCtxSync = AssertSliceOf<ContextSyncStore, ChatState>
type _AssertCheckpoint = AssertSliceOf<CheckpointStore, ChatState>
type _AssertHostPending = AssertSliceOf<HostPendingSendStore, ChatState>
type _AssertInterruptHostPending = AssertSliceOf<InterruptHostPendingStore, ChatState>
type _AssertCancelHostPending = AssertSliceOf<CancelHostPendingStore, ChatState>

// ：防睡眠由执行态单一投影驱动（取代原 streamingBySessionId 计数）。任一会话
// busy（在跑 / 排队 / 乐观派发 / 对账）→ 阻止系统休眠；投影清空 → 放行。所有投影写
// 入方（乐观派发 / 流事件 / 队列 / 对账）都经由此订阅统一收口，无需各 choke point 自己
// 记数。引用相等短路确保流式高频更新不产生额外开销。
let _sleepPreventedByRun = false
// 生产环境 useChatRuntimeStore 恒有 subscribe；部分单测用局部 mock（无 subscribe），
// 故守卫存在性，避免仅为防睡眠订阅而拖挂无关测试的加载。
if (typeof useChatRuntimeStore?.subscribe === 'function') {
  useChatRuntimeStore.subscribe((state, prev) => {
    if (state.runProjectionBySessionId === prev.runProjectionBySessionId) return
    const anyBusy = Object.values(state.runProjectionBySessionId ?? {})
      .some((projection) => projection.busy)
    if (anyBusy === _sleepPreventedByRun) return
    _sleepPreventedByRun = anyBusy
    if (anyBusy) preventSleep()
    else allowSleep()
  })
}

setReconnectHandler(async (activeSessionIds) => {
  const store = useChatStore.getState()

  for (const sessionId of activeSessionIds) {
    const threadId = `chat-session-${sessionId}`
    useChatRuntimeStore.getState().reconcileSubagentRuns(sessionId, threadId)
  }

  // 断连前可能有活跃 streaming 的 session，需要在清理前记录以便同步。
  // ：改读执行态单一投影（runProjectionBySessionId），不再依赖已删的影子字段。
  const staleStreamingSessions: string[] = []
  const activeSet = new Set(activeSessionIds)
  const runProjection = useChatRuntimeStore.getState().runProjectionBySessionId ?? {}
  for (const sessionId of Object.keys(runProjection)) {
    if (runProjection[sessionId]?.busy && !activeSet.has(sessionId)) {
      staleStreamingSessions.push(sessionId)
    }
  }

  // ：有本机 runtime bridge 时，下面的 reconcileSessionRunState 在权威 idle
  // 时会走 endSessionRun（写 endedAt）；若此处先 tear busy，对账会因 !projectionBusy
  // 跳过 cleanup，计时定不下来。无 bridge 无法对账，才本地 endSessionRun。
  if (!hasRuntimeBridge()) {
    for (const sessionId of staleStreamingSessions) {
      log.info('WS reconnect: no runtime bridge, ending stale run locally:', { sessionId })
      endSessionRun({
        sessionId,
        status: 'cancelled',
        removeStreamingSession: store.removeStreamingSession,
      })
    }
  } else if (staleStreamingSessions.length > 0) {
    log.info('WS reconnect: deferring stale busy sessions to run-state reconcile', {
      count: staleStreamingSessions.length,
    })
  }

  // 合并 currentSessionId + 分屏 activeSessionIds + 断连前有 streaming 的 session，去重
  const sessionsToSync = new Set(activeSessionIds)
  if (store.currentSessionId) sessionsToSync.add(store.currentSessionId)
  for (const sid of staleStreamingSessions) sessionsToSync.add(sid)

  //  / ：执行态对账只依赖 agentEngine IPC，不依赖 chat client。
  // 必须在 client 空 early-return 之前 await，否则「有 bridge + client 未就绪」
  // 会既不本地停表也不对账，busy/计时卡住。遥控 sessionId miss 仍按 reconcile
  // 边界保留投影（靠 busy-retain / 迟到终态），此处不误清。
  await Promise.all(
    [...sessionsToSync].map((sid) => reconcileSessionRunState(sid, 'ws-reconnect')),
  )

  const client = getChatClientInstance()
  if (!client) return

  // ：走唯一对账入口（指数退避 1s/3s/9s）；失败标 stale。
  const results = await Promise.allSettled(
    [...sessionsToSync].map(sid =>
      reconcileSessionMessages(sid, {
        force: true,
        retry: true,
        silentOnError: false,
        reason: 'ws-reconnect',
      }).then(r => r.newCount),
    ),
  )

  let totalNewMessages = 0
  let failedSessionCount = 0
  for (const [idx, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      totalNewMessages += result.value
    } else {
      const sid = [...sessionsToSync][idx]
      failedSessionCount += 1
      log.warn('WS reconnect sync failed for session:', { sessionId: sid, reason: result.reason })
    }
  }

  if (totalNewMessages > 0 || failedSessionCount > 0) {
    log.info('WS reconnect sync done:', {
      newMessages: totalNewMessages,
      sessions: sessionsToSync.size,
      failedSessions: failedSessionCount,
    })
  }
  useWsConnectionStore.getState().setLastSyncCount(totalNewMessages)

  // suspended 清除判定：sync 后对"已不再 streaming + fresh + 最后一条是 final
  // assistant message"的 session 视为 Agent 已在后台完成 → 清 suspended，给
  // UI 一个准确的"X 个 Agent 已在后台完成"反馈。仍在 streaming 的 session
  // 保留 suspended——server 会通过 WS 继续推流；sync 失败 / 没 final
  // assistant 的 session 也保留——可能 Agent 还在执行 / 中断，等下一轮检查。
  const postSyncStore = useChatStore.getState()
  const postSyncFreshness = useSessionFreshnessStore.getState()
  const suspendedSnapshot = useWsConnectionStore.getState().suspendedSessionIds ?? []
  const completedSuspendedIds: string[] = []
  for (const sid of suspendedSnapshot) {
    if (!sessionsToSync.has(sid)) continue
    if (isSessionBusy(sid)) continue
    if (!postSyncFreshness.isFresh(sid)) continue
    const msgs = postSyncStore.messagesBySessionId[sid] ?? []
    const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
    if (!lastAssistant || lastAssistant.id.startsWith('temp-')) continue
    completedSuspendedIds.push(sid)
  }
  if (completedSuspendedIds.length > 0) {
    markSessionsSuspended(completedSuspendedIds, false)
    log.info('WS reconnect: cleared suspended for completed sessions:', { count: completedSuspendedIds.length })
  }

  if (totalNewMessages > 0) {
    const completedCount = completedSuspendedIds.length
    toast({
      id: 'reconnect-summary',
      title: i18n.t('chat:reconnect.restored', { defaultValue: '连接已恢复' }),
      description: completedCount > 0
        ? i18n.t('chat:reconnect.summaryWithCompleted', {
            defaultValue: `同步了 ${totalNewMessages} 条新消息，${completedCount} 个 Agent 已在后台完成任务`,
            msgCount: totalNewMessages,
            agentCount: completedCount,
          })
        : i18n.t('chat:reconnect.summary', {
            defaultValue: `同步了 ${totalNewMessages} 条新消息`,
            count: totalNewMessages,
          }),
      duration: 8000,
    })
  }

  // D2: Checkpoint 补偿扫描（延迟 500ms 等待可能的 onDone / Resume 事件处理完成）
  await new Promise(r => setTimeout(r, 500))

  const cpStore = useChatStore.getState()
  const freshnessStore = useSessionFreshnessStore.getState()
  for (const sid of sessionsToSync) {
    if (isSessionBusy(sid)) continue
    // sync 失败的 session 缓存可能滞后，基于过期 lastAssistant 写 checkpoint
    // 是有害无益的；交给后续被动恢复路径在数据 fresh 后再补即可。
    if (!freshnessStore.isFresh(sid)) continue

    const msgs = cpStore.messagesBySessionId[sid] ?? []
    const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
    if (!lastAssistant || lastAssistant.id.startsWith('temp-')) continue

    const checkpoints = cpStore.checkpointsBySessionId[sid] ?? {}
    if (lastAssistant.checkpoint_hash) continue
    if (checkpoints[lastAssistant.id]) continue

    const agentRunId = lastAssistant.agent_run_id
    if (!agentRunId) continue

    let spaceId: string | undefined
    for (const [spId, sessions] of Object.entries(cpStore.sessionsBySpaceId)) {
      if (sessions.some(s => s.id === sid)) {
        spaceId = spId
        break
      }
    }

    try {
      await useChatStore.getState().createCheckpoint(sid, lastAssistant.id, undefined, {
        spaceId,
        agentRunId,
      })
    } catch (err) {
      log.warn('ReconnectHandler: checkpoint compensation failed:', { sessionId: sid, err })
    }
  }

  // NEW-5（已移除，）：这里曾按「末条是 assistant 且不在 streaming」启发式清
  // HITL 面板——与旧 pendingInteractions 快照对账同病：拿间接信号猜终态，watchdog
  // 强制 finalize 后会误杀仍在等待的活审批。现在 HITL 面板收敛到 hitl_interaction
  // 消息真相（reconcileHitlPanelsFromMessages，挂在上方 ensureSessionFresh 的
  // sync 成功路径里），重连 sync 后 pending 恢复 / 终态清除自然发生，无需启发式。
})

onDeviceStatusMessage((content) => {
  const store = useChatStore.getState()
  const sessionId = store.currentSessionId
  if (!sessionId) return

  const msg = {
    id: `device-status-${Date.now()}`,
    role: 'system' as const,
    content,
    created_at: new Date().toISOString(),
    agent_type: null,
    intent: null,
  }
  store.injectSystemMessage(sessionId, msg)
})

// ---------------------------------------------------------------------------
// 编译期断言：`evictSessionData.ts.CHAT_STORE_SESSION_KEYS` 必须覆盖
// `ChatState` 上所有 `*BySessionId` 字段（已知豁免：见下方 KnownExclusions）。
// 漏写时编译报错，提示哪个 key 漏了。断言放这里（不放 evictSessionData.ts）
// 是为了让 evictSessionData 不需要 type-only import ChatState，避免循环。
// ---------------------------------------------------------------------------
type _SessionIdKeys = {
  [K in keyof ChatState]: K extends `${string}BySessionId` ? K : never
}[keyof ChatState]

type _EvictionKeys = (typeof _CHAT_STORE_SESSION_KEYS)[number]

type _KnownExclusions = 'messagesBySessionId' | 'sessionsBySpaceId' | 'currentSessionIdBySpaceId' | 'draftSessionBySpaceId'

type _AssertEvictionComplete = Exclude<_SessionIdKeys, _EvictionKeys | _KnownExclusions> extends never
  ? true
  : { error: 'CHAT_STORE_SESSION_KEYS is missing keys'; missing: Exclude<_SessionIdKeys, _EvictionKeys | _KnownExclusions> }

// 触碰一下断言类型，让 TS 编译器不会警告 unused（`as` 强制保留）
const _evictionAssertion: _AssertEvictionComplete = true as _AssertEvictionComplete
void _evictionAssertion

// ---------------------------------------------------------------------------
// 组合根端口装配：把对外反向访问 callbacks / provider 注册收进 chatStoreBootstrap，
// 组合根本体只做 create+persist。必须在 useChatStore export 完成后调用一次（ 阶段C）。
// ---------------------------------------------------------------------------
installChatStorePorts()
