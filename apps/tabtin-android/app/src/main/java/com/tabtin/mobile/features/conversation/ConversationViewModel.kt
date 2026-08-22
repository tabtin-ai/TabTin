package com.tabtin.mobile.features.conversation

import android.content.Context
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.AttachmentStatus
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.ConversationAgentMode
import com.tabtin.mobile.data.model.ConversationApprovalMode
import com.tabtin.mobile.data.model.ConversationDraftScope
import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import com.tabtin.mobile.data.model.LlmModel
import com.tabtin.mobile.data.model.MessageBlock
import com.tabtin.mobile.data.model.ModeSwitchProposal
import com.tabtin.mobile.data.model.PlanProposal
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.SubagentFailureType
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.data.model.StreamEvent
import com.tabtin.mobile.data.model.AgentTodoItem
import com.tabtin.mobile.data.model.shouldRefreshPromotionCredit
import com.tabtin.mobile.data.model.AskFormRequest
import com.tabtin.mobile.data.model.AskUserQuestion
import com.tabtin.mobile.data.model.PlanApprovalSnapshot
import com.tabtin.mobile.data.model.RequestApprovalRequest
import com.tabtin.mobile.data.model.HitlResolutionAccess
import com.tabtin.mobile.data.model.ResourceRestoreItem
import com.tabtin.mobile.data.model.ResourceRestoreResponse
import com.tabtin.mobile.data.model.ReviewRequestState
import com.tabtin.mobile.data.model.RollbackPreviewResponse
import com.tabtin.mobile.data.model.SessionReadState
import com.tabtin.mobile.data.model.SessionRunState
import com.tabtin.mobile.data.model.SessionRunStatus
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.SubagentTranscriptItem
import com.tabtin.mobile.data.model.canSelectContextTier
import com.tabtin.mobile.data.model.catalogThinkingCapability
import com.tabtin.mobile.data.model.isSendableChatModel
import com.tabtin.mobile.data.model.resolveActiveContextTierId
import com.tabtin.mobile.data.model.resolveActiveThinkingMode
import com.tabtin.mobile.data.model.resolveConversationChatModel
import com.tabtin.mobile.data.model.thinkingMode
import com.tabtin.mobile.data.model.toOutboundMessageBlock
import com.tabtin.mobile.data.repository.ChatCheckpointRepository
import com.tabtin.mobile.data.repository.ChatRepository
import com.tabtin.mobile.data.repository.LoadMessagesResult
import com.tabtin.mobile.data.repository.ConversationDraftInput
import com.tabtin.mobile.data.repository.ConversationDraftSessionCoordinator
import com.tabtin.mobile.data.repository.ConversationDraftStore
import com.tabtin.mobile.data.repository.ConversationRuntimeConfigurationStore
import com.tabtin.mobile.data.repository.LlmRepository
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.OutgoingMessageQueueRepository
import com.tabtin.mobile.data.repository.OutgoingQueuePolicy
import com.tabtin.mobile.data.repository.PendingInteractionRepository
import com.tabtin.mobile.data.repository.PendingInteractionUpdate
import com.tabtin.mobile.data.repository.OutgoingHistoryEvidence
import com.tabtin.mobile.data.repository.QueuedOutgoingMessage
import com.tabtin.mobile.data.repository.QueuedOutgoingMessageStatus
import com.tabtin.mobile.data.repository.SessionReadAckStore
import com.tabtin.mobile.data.repository.SessionReadStateStore
import com.tabtin.mobile.data.repository.SessionRunStateStore
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.data.repository.isPersistedDeliveryFailure
import com.tabtin.mobile.sentry.SentryContextProvider
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import com.tabtin.mobile.data.websocket.AckResult
import com.tabtin.mobile.data.websocket.BillingEventHandler
import com.tabtin.mobile.data.websocket.StreamManager
import com.tabtin.mobile.data.websocket.WSConnectionState
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.features.space.AgentAvatarPreset
import com.tabtin.mobile.features.workbench.WorkbenchFocusTarget
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

// W4 (2026-05-11): ask 三件套合一为单 ask_user。
// 删除 fields / fieldsTextFallback 字段——只剩 questions[] 形态。
public data class PendingAskUser(
    val sessionId: String,
    val messageId: String?,
    val hitlRequestId: String?,
    val questions: List<AskUserQuestion>,
    val title: String? = null,
    val resolutionAccess: HitlResolutionAccess = HitlResolutionAccess.Unrestricted,
)

/**
 * Wave 4 I8：UI 层 plan.exit 审批面板的状态。
 * 创建于 plan_approval_required；提交（[ConversationViewModel.submitPlanApproval]）/
 * 收到匹配 requestId 的 approval_resolved 时清空。
 */
public data class PendingPlanApproval(
    val requestId: String,
    val sessionId: String,
    val planDocumentId: String,
    val planSnapshot: PlanApprovalSnapshot? = null,
    val hintAllowedPrompts: List<String> = emptyList(),
)

/**
 * v0.4 W1.5-轮 4：UI 层批量审批面板的状态（仅 tool_permission；plan_exit 已删除）。
 * payload 升格为 batch + N 条 actionRequest——同 session 一张面板列 N 条；
 * 后到的批次替换前一个（与 Electron ApprovalPanel 形态一致）。
 */
public data class PendingApproval(
    /** v0.4：批 id（runtime UUID）；同 batch 多条 actionRequest 共享 */
    val batchId: String,
    /** v0.4：唯一值 'tool_permission'（保留 discriminator 字段供未来扩展） */
    val approvalType: String,
    /** v0.4：N >= 1 的 action 数组 */
    val actionRequests: List<com.tabtin.mobile.data.model.ApprovalActionRequest>,
    val runtimeMode: String?,
    val expiresAtMs: Long?,
    /** 旧 agent.action.approval_request 来源：非空时提交走 agent.action.approval_response。 */
    val actionApprovalId: String? = null,
    val actionThreadId: String? = null,
    val resolutionAccess: HitlResolutionAccess = HitlResolutionAccess.Unrestricted,
)

public data class PendingAskForm(
    val sessionId: String,
    val request: AskFormRequest,
    val resolutionAccess: HitlResolutionAccess = HitlResolutionAccess.Unrestricted,
)

public data class PendingRequestApproval(
    val sessionId: String,
    val request: RequestApprovalRequest,
    val resolutionAccess: HitlResolutionAccess = HitlResolutionAccess.Unrestricted,
)

/**
 * Wave 4 S2/A2：用户消息进入编辑模式时的状态。
 * 一次只允许一条消息处于编辑态（与 Electron `UserMessageEditMode` 单例语义一致）。
 */
public data class EditingMessageState(
    val messageId: String,
    val originalContent: String,
    val originalBlocks: List<com.tabtin.mobile.data.model.BlockItem>?,
)

/** 编辑重发在用户确认前后共用的一份草稿与影响状态。 */
public data class EditResendState(
    val targetMessageId: String,
    val editedContent: String,
    val keptBlocks: List<MessageBlock>?,
    val preview: RollbackPreviewResponse? = null,
    val isLoadingPreview: Boolean = true,
    val isExecuting: Boolean = false,
    val errorMessage: String? = null,
    /** 服务端时间线已经缩短；关闭失败面板时应把草稿交还 Composer。 */
    val rollbackApplied: Boolean = false,
)

public data class ConversationUiState(
    val messages: List<ChatMessage> = emptyList(),
    /**
     * 子 Agent 原文消息。主时间线会滤掉 `subagent_run_id`，但工作台要扫它们的产物。
     * 对齐 iOS `ConversationViewModel.subagentRuns`。
     */
    val subagentTranscriptMessages: List<ChatMessage> = emptyList(),
    val isLoading: Boolean = false,
    val isLoadingMore: Boolean = false,
    val hasMore: Boolean = false,
    val isSending: Boolean = false,
    val errorMessage: String? = null,
    val isStreaming: Boolean = false,
    val isPaused: Boolean = false,
    /** 当前会话的服务端权威运行态；流式气泡仍由 projector 管理。 */
    val runState: SessionRunState? = null,
    /** 当前用户的服务端权威阅读水位。 */
    val readState: SessionReadState? = null,
    val isPauseControlPending: Boolean = false,
    /** A server-accepted stop is still waiting for the terminal stream event. */
    val isCancelControlPending: Boolean = false,
    val connectionInterrupted: Boolean = false,
    val currentPhase: AgentPhase = AgentPhase.IDLE,
    val currentToolName: String? = null,
    val pendingAskUser: PendingAskUser? = null,
    val pendingAskForm: PendingAskForm? = null,
    val pendingRequestApproval: PendingRequestApproval? = null,
    val pendingReview: ReviewRequestState? = null,
    /**
     * Wave 1 review 必修：HITL（AskUser/Review）正在提交。
     * 提升到 ViewModel 后，提交失败（Failed）时面板会从 disabled/loading 恢复，
     * 用户能重试；以前各 Panel 内部 `var isSubmitting by remember`，在失败回调
     * 没有 reset 信号时会永久卡住。
     */
    val hitlSubmitting: Boolean = false,
    val agentTodos: List<AgentTodoItem> = emptyList(),
    val billingBlocked: Boolean = false,
    val memberLimitBlocked: Boolean = false,
    val memberLimitReason: String? = null,
    /** Wave 4 I8：plan.exit 审批面板状态 */
    val pendingPlanApproval: PendingPlanApproval? = null,
    /** Wave 4 I9：弱三合一 tool_permission 审批面板状态 */
    val pendingApproval: PendingApproval? = null,
    /** Wave 4 S2/A2：当前编辑的消息（一次最多一条） */
    val editingMessage: EditingMessageState? = null,
    /** 编辑重发必须先预览确认，不能从编辑框直接执行回退。 */
    val editResend: EditResendState? = null,
    val queuedOutgoingMessages: List<QueuedOutgoingMessage> = emptyList(),
    /** Composer 模型与运行配置（对齐 iOS ComposerSettingsBar）。 */
    val availableModels: List<LlmModel> = emptyList(),
    val currentModel: LlmModel? = null,
    val isLoadingModels: Boolean = false,
    /** 切换尚未获服务端确认时，不允许下一条任务沿用旧模型发送。 */
    val isSwitchingModel: Boolean = false,
    /** 模型切换失败时在仍打开的选择抽屉内展示，不与发送错误混用。 */
    val modelSwitchErrorMessage: String? = null,
    val modelLoadFailed: Boolean = false,
    /** 会话级上下文档位意图（Catalog context_tiers → Session context_tier_id）。 */
    val contextTierId: String? = null,
    /** 会话级思考强度意图（v2 model_param_overrides.thinking_mode）。 */
    val thinkingMode: String? = null,
    val runtimeConfiguration: ConversationRuntimeConfiguration = ConversationRuntimeConfiguration(),
    /** 组织是否允许本轮采用自动或完全访问审批。 */
    val permitsRelaxedApproval: Boolean = false,
    /** 当前会话后续轮次的执行 Agent（Composer 切换 / 乐观发送）。 */
    val executionAgentId: String? = null,
    /** PUT /chat/sessions/{id} agent_id 切换进行中。 */
    val isSwitchingAgent: Boolean = false,
    /** 历史回复的实际执行者；只由消息自身的 agent_id 解析，不能从会话当前 Agent 推断。 */
    val messageAgentNamesById: Map<String, String> = emptyMap(),
    /** 历史 assistant 消息执行者的头像与显示名；来自组织 Agent 目录。 */
    val messageAgentFacesById: Map<String, AgentFace> = emptyMap(),
    /** 对齐 Electron compactionInProgress：流式压缩中在时间线末尾展示扫光 pill。 */
    val compactionInProgress: Boolean = false,
    /**
     * ：撤回未答轮次后把原文交还 Composer（对齐 iOS cancel() 的 restoredText）。
     * ConversationView 消费后调 [ConversationViewModel.consumeComposerRestoreText]。
     */
    val pendingComposerRestoreText: String? = null,
    /** 编辑重发已改写时间线后失败时，与文字一起交还的原消息非文本块。 */
    val pendingComposerRestoreBlocks: List<MessageBlock>? = null,
)

internal fun ConversationUiState.rollbackFailedModelSwitch(
    previousModel: LlmModel?,
    previousContextTierId: String?,
    previousThinkingMode: String?,
    message: String,
): ConversationUiState = copy(
    currentModel = previousModel,
    contextTierId = previousContextTierId,
    thinkingMode = previousThinkingMode,
    isSwitchingModel = false,
    modelSwitchErrorMessage = message,
    errorMessage = message,
)

/**
 * Wave 6 A3：ChatBubble / MessageContextMenuHost 触发"从此消息 Fork"后
 * 由 ConversationViewModel 通过 [ConversationViewModel.forkRequests] 上报给
 * 宿主屏幕（AgentDetailScreen），由宿主调用 AgentDetailViewModel.forkSession
 * 完成真正的 API 请求 + session 列表变更。
 *
 * 为什么不直接在 ConversationViewModel 里调 Repository：
 *  - session 列表的 source-of-truth 是 AgentDetailViewModel（这里仅管单个对话的流）；
 *  - fork 成功后要切到新 session 才"有价值"，这是宿主屏幕的协调职责；
 *  - 参照 iOS ConversationScreen.onSessionForked 由 AgentDetailScreen.switchTo 接管的分工。
 */
public data class ForkRequestEvent(val sessionId: String, val messageId: String)

/** A USER mirror proves persistence, but does not prove that an assistant run ever started. */
internal fun StreamEvent.countsAsAssistantProgressForSendWatchdog(): Boolean =
    this !is StreamEvent.ObservedUserMessage

/** Never replace the durable idempotency key with a projector-local/server-merged message id. */
internal fun resolveAcknowledgedClientEventId(
    stableClientEventId: String,
    acknowledgedClientEventId: String?,
): String = acknowledgedClientEventId?.takeIf { it.isNotBlank() } ?: stableClientEventId

/** Exact source correlation closes the durable row, so no later around poll is useful. */
internal fun shouldFinishOutgoingReconciliation(evidence: OutgoingHistoryEvidence): Boolean =
    evidence == OutgoingHistoryEvidence.EXECUTION_STARTED

/**
 * 乐观 assistant 占位用的执行 Agent：优先会话级缓存（不随 loadSession 清 snapshot 一起丢），
 * 再回落当前 Session 快照。对齐 iOS `executionAgentId`。
 */
internal fun resolveOptimisticExecutionAgentId(
    executionAgentId: String?,
    snapshotAgentId: String?,
): String? = executionAgentId?.takeIf { it.isNotBlank() }
    ?: snapshotAgentId?.takeIf { it.isNotBlank() }

@HiltViewModel
public class ConversationViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val chatRepository: ChatRepository,
    private val chatCheckpointRepository: ChatCheckpointRepository,
    private val llmRepository: LlmRepository,
    private val streamManager: StreamManager,
    private val outgoingQueueRepository: OutgoingMessageQueueRepository,
    private val conversationDraftStore: ConversationDraftStore,
    private val draftSessionCoordinator: ConversationDraftSessionCoordinator,
    private val runtimeConfigurationStore: ConversationRuntimeConfigurationStore,
    public val tokenManager: TokenManager,
    public val attachmentManager: ChatAttachmentManager,
    public val webSocketService: WebSocketService,
    private val billingEventHandler: BillingEventHandler,
    private val pendingInteractionRepository: PendingInteractionRepository,
    private val sentryContextProvider: SentryContextProvider,
    private val organizationRepository: OrganizationRepository,
    private val spaceRepository: SpaceRepository,
    private val sessionRunStateStore: SessionRunStateStore,
    private val sessionReadStateStore: SessionReadStateStore,
    private val sessionReadAckStore: SessionReadAckStore,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ConversationUiState())
    public val uiState: StateFlow<ConversationUiState> = _uiState.asStateFlow()

    public val connectionState: StateFlow<WSConnectionState> = webSocketService.connectionState

    private var currentSessionId: String? = null
    /** 每次 [loadSession] 自增；过期 HTTP 历史只认这一代。 */
    private var sessionLoadGeneration: Long = 0L
    private var streamJob: Job? = null
    private var sessionObserverJob: Job? = null
    private var reconcileJob: Job? = null
    private var sendWatchdogJob: Job? = null
    private var projectorPublishJob: Job? = null
    private var approvalExpirationJob: Job? = null
    /** Owns the global HITL submitting flag so a late ACK cannot unlock a newer submission. */
    private val hitlSubmissionOwnership = HitlSubmissionOwnership()
    private val singleHitlResolutions = SingleHitlResolutionRegistry()
    private var readAckJob: Job? = null
    private var pendingProjectorUpdate: ((ConversationUiState) -> ConversationUiState)? = null
    private var myTaskId: String? = null
    private var receivedSinceSend: Boolean = false
    private var activeAssistantId: String? = null
    private var pendingOptimisticAssistantId: String? = null
    private val assistantIdsByServerMessageId = mutableMapOf<String, String>()
    private val blockProjector = ConversationBlockProjector()
    private val projector = ConversationProjector()
    private val flushingQueueItemIds = mutableSetOf<String>()
    /**
     *  尾事件丢弃窗（仅撤回路径）：cancel 发出时打开，终态事件到达或 ACK 后 2s 宽限关闭。
     * 只拦旧 run 的投影/控制事件，防止本地已抽掉的气泡被迟到 delta / ABORT 镜像加回。
     * 对齐 iOS `discardingCancelledRun` + `cancelledRunIdentity`。
     *
     * 与下方  对账豁免是两条独立生命周期——丢弃窗可先关，豁免须活过 600/1600/3000ms
     * 终态对账窗口，故 **不要** 在 [clearWithdrawnTurnDiscard] 里顺带清豁免标记。
     */
    private var discardingWithdrawnClientEventId: String? = null
    private var discardingWithdrawnTaskId: String? = null
    /**
     *  终态对账豁免（仅撤回路径）：
     * - [pendingWithdrawClientMessageId]：本轮撤回目标 clientMessageId（发出 cancel 时写入）
     * - [withdrawDeleteConfirmed]：收到 `withdraw_applied=true`（ack 或 done）后为 true →
     *   [refreshLatestMessagesWhenSettled] 过滤该 user 及其后内容，不得回灌
     *
     * `withdraw_applied=false` / 超时仍未确认 → 清标记并走正常 reconcile（竞态拒绝时消息回拉）。
     * 新一轮 [startOutgoingStream] / [disposeLocalStream] 与丢弃窗一并清空，避免泄漏到下一轮。
     */
    private var pendingWithdrawClientMessageId: String? = null
    private var withdrawDeleteConfirmed: Boolean = false
    private val pendingDraftDeliveryIds = mutableSetOf<String>()
    private val outgoingReconcileJobs = mutableMapOf<String, Job>()
    private var sendingOutgoing: Boolean = false
    /** 宿主同步的当前 Workbench Focus；Composer 入队瞬间冻结，重试只读队列。 */
    private var workbenchFocusSpaceId: String? = null
    private var workbenchFocusTarget: WorkbenchFocusTarget? = null
    /** 胶囊语音派发中的队列项；ACK 推进到「已送达」时匹配。 */
    private var pendingVoiceQueueId: String? = null
    private val _voiceSendReceipts = MutableSharedFlow<QueuedSendReceipt>(extraBufferCapacity = 8)
    public val voiceSendReceipts: SharedFlow<QueuedSendReceipt> = _voiceSendReceipts.asSharedFlow()
    private var cachedModelOrganizationId: String? = null
    private var cachedCatalogDefaultModelId: String? = null
    /** 目录请求按代际收口，避免旧组织或较早刷新覆盖当前模型余额。 */
    private var chatCatalogLoadGeneration: Long = 0L
    private var chatCatalogLoadJob: Job? = null
    private var chatCatalogLoadOrganizationId: String? = null
    private var chatCatalogLoadExpectedSessionId: String? = null
    private var chatCatalogLoadShowsComposerLoading: Boolean = false
    /** 结算后静默刷新 promotion credit，与 Composer catalog 加载分代际，避免互相作废。 */
    private var promotionCreditRefreshGeneration: Long = 0L
    private var activeRunModelId: String? = null
    /** 当前会话的服务端快照；会话模型不能从入口路由或上一个会话猜测。 */
    private var currentSessionSnapshot: ChatSession? = null
    /**
     * Composer / 会话当前执行 Agent。与 snapshot 解耦：loadSession 会先把 snapshot 置 null，
     * 快发时仍靠此缓存给乐观气泡写 agentId。
     */
    private var executionAgentId: String? = null
    /** 拒绝迟到的模型切换回包覆盖当前选择。 */
    private var modelSwitchGeneration: Long = 0L
    /** 本地刚改过档位 / 思考强度时，避免迟到的 Session GET 回滚意图。 */
    private var hasLocalModelRuntimeIntent = false
    private var modelRuntimeWriteGeneration: Long = 0L
    /**
     * 草稿态（尚无 sessionId）写入本地 draft store 用的执行范围。
     * 首发恢复窗口也会带上，便于改运行设置后仍落盘。
     */
    private var draftPersistenceScope: ConversationDraftScope? = null
    /** 会话内 Composer 草稿：打开时不建 Session，首发才 prepareSession。 */
    private var draftMode: Boolean = false
    private var draftExecutionSpace: Space? = null
    private var draftAgentId: String? = null
    /** 对齐 iOS beginFirstSend：同一轮首发只放行一次。 */
    private var firstSendInFlight: Boolean = false
    /** The user's per-session preference, before the current organization policy clamps it. */
    private var requestedRuntimeConfiguration = ConversationRuntimeConfiguration()
    private var hasStoredRuntimeConfiguration = false
    /**
     * ：本地刚改过 agent_mode 的短脏窗口（elapsedRealtime 截止）。
     * 窗口内 GET 不以服务端覆盖；PATCH 成功后清零，之后以服务端为准。
     */
    private var agentModeLocalDirtyUntilElapsedMs: Long = 0L
    private var agentModeSyncGeneration: Long = 0L
    private var historyHydratedSessionId: String? = null
    private var subscriptionReadySessionId: String? = null
    /** 每个会话 / 组织只加载一次完整 Agent 目录，避免流式刷新重复请求。 */
    private var agentNameLookupScope: Pair<String, String>? = null
    /** Invalidates a late pause / resume / cancel ACK after a newer control action. */
    private var runControlGeneration: Long = 0L

    private companion object {
        private const val TAG = "ConversationViewModel"
        private const val SEND_WATCHDOG_TIMEOUT_MS = 40_000L
        private const val STREAM_PUBLISH_INTERVAL_MS = 50L
        private const val OUTGOING_RECONCILE_ATTEMPTS = 4
        /** ：切工作方式后防 stale GET 覆盖的本地脏窗口。 */
        private const val AGENT_MODE_LOCAL_DIRTY_WINDOW_MS = 15_000L
    }

    init {
        viewModelScope.launch {
            billingEventHandler.billingBlocked.collect { blocked ->
                _uiState.value = _uiState.value.copy(billingBlocked = blocked)
            }
        }
        viewModelScope.launch {
            billingEventHandler.memberLimitBlocked.collect { blocked ->
                _uiState.value = _uiState.value.copy(
                    memberLimitBlocked = blocked,
                    memberLimitReason = if (blocked) billingEventHandler.memberLimitReason.value else null,
                )
            }
        }
        viewModelScope.launch {
            var transportDropped = false
            webSocketService.connectionState.collect { state ->
                val dropped = state is WSConnectionState.Reconnecting ||
                    state == WSConnectionState.Disconnected
                if (dropped) {
                    transportDropped = true
                    return@collect
                }
                if (state == WSConnectionState.Connected) {
                    drainOutgoingQueueIfPossible()
                    // 阅读 ACK 也有本地 outbox。断线时已展示的终态回复不能只等下一次
                    // 进入会话才恢复，否则列表会长期把它标成未读。
                    sessionReadAckStore.flush()
                    if (ConversationReconnectPolicy.shouldResetSeqCursor(transportDropped)) {
                        transportDropped = false
                        currentSessionId?.let(::refreshCommittedMessages)
                    }
                }
            }
        }
        viewModelScope.launch {
            pendingInteractionRepository.updates.collect { update ->
                handlePendingInteractionUpdate(update)
            }
        }
        viewModelScope.launch {
            sessionRunStateStore.updates.collect { update ->
                applyAuthoritativeRunState(update.sessionId, update.runState)
            }
        }
        viewModelScope.launch {
            sessionReadStateStore.updates.collect { update ->
                applyAuthoritativeReadState(update.sessionId, update.readState)
            }
        }
        viewModelScope.launch { sessionReadAckStore.flush() }
        viewModelScope.launch {
            // 组织策略是发送时的安全上限，不修改用户本地记住的偏好。
            organizationRepository.selectedOrganization.collect { org ->
                val permitsRelaxedApproval = org?.settings?.allowMemberYolo == true
                val current = _uiState.value
                _uiState.value = current.copy(
                    permitsRelaxedApproval = permitsRelaxedApproval,
                    runtimeConfiguration = resolveRuntimeConfiguration(permitsRelaxedApproval),
                )
            }
        }
        loadChatModels()
    }

    private val _forkRequests = MutableSharedFlow<ForkRequestEvent>(extraBufferCapacity = 1)
    public val forkRequests: SharedFlow<ForkRequestEvent> = _forkRequests.asSharedFlow()

    public sealed interface CheckpointStreamEvent {
        public data class Failed(val sessionId: String) : CheckpointStreamEvent
        public data class Success(val sessionId: String) : CheckpointStreamEvent
    }
    private val _checkpointStreamEvents = MutableSharedFlow<CheckpointStreamEvent>(extraBufferCapacity = 5)
    public val checkpointStreamEvents: SharedFlow<CheckpointStreamEvent> = _checkpointStreamEvents.asSharedFlow()

    /** 编辑重发成功只给瞬时回执，不复用长期回退横幅。 */
    public data object EditResendCompleted
    private val _editResendEvents = MutableSharedFlow<EditResendCompleted>(extraBufferCapacity = 1)
    public val editResendEvents: SharedFlow<EditResendCompleted> = _editResendEvents.asSharedFlow()

    override fun onCleared() {
        super.onCleared()
        cancelChatCatalogLoad()
        disposeLocalStream()
        stopSessionObserver()
        attachmentManager.clear()
        sentryContextProvider.clearActiveSpace()
    }

    public fun loadSession(
        sessionId: String,
        forceRefresh: Boolean = false,
        spaceId: String? = null,
        organizationId: String? = null,
    ) {
        val isNewSession = sessionId != currentSessionId
        if (!isNewSession && !forceRefresh) return
        if (isNewSession) {
            // Sentry space_id：对齐 iOS ConversationViewModel.startSession，切到新会话时打标。
            // 仅在真正换会话时写入——同会话 forceRefresh（rollback/unrevert）调用方不传
            // spaceId，若无条件写入会把已生效的 tag 误清空。
            sentryContextProvider.setActiveSpace(spaceId)
        }
        // Changing screens must only release local observation. The remote Agent
        // keeps running unless the user explicitly presses Stop.
        disposeLocalStream()
        stopSessionObserver()
        sessionLoadGeneration += 1
        val loadGeneration = sessionLoadGeneration
        currentSessionId = sessionId
        currentSessionSnapshot = null
        // 仅换会话时清执行 Agent；同会话 forceRefresh 保留，避免对账窗口内快发丢身份。
        if (isNewSession) {
            executionAgentId = null
            draftPersistenceScope = null
            // 正式 load 后离开草稿态（首发路径会先置 false；此处防其它入口误留草稿）。
            draftMode = false
            draftExecutionSpace = null
            draftAgentId = null
        }
        modelSwitchGeneration += 1
        hasLocalModelRuntimeIntent = false
        modelRuntimeWriteGeneration += 1
        historyHydratedSessionId = null
        subscriptionReadySessionId = null
        agentNameLookupScope = null
        readAckJob?.cancel()
        readAckJob = null
        cancelChatCatalogLoad()
        attachmentManager.bindSession(
            sessionId,
            organizationId?.takeIf { it.isNotBlank() } ?: tokenManager.organizationId,
        )
        projector.reset(clearMessages = true)
        hitlSubmissionOwnership.clear()
        clearAgentModeLocalDirty()
        agentModeSyncGeneration += 1
        restoreRuntimeConfiguration(sessionId)
        // 模型和运行配置都属于会话事实。模型待服务端 Session 快照返回后再选定，
        // 不能把上一个会话的 Composer 选择带到这里。
        _uiState.value = ConversationUiState(
            isLoading = true,
            availableModels = _uiState.value.availableModels,
            currentModel = null,
            // 切会话时必须重置模型加载态；保留 true 会让 init 阶段的 in-flight 请求
            // 在 sessionId 变更后被作废，却永远等不到第二次 loadChatModels。
            isLoadingModels = false,
            isSwitchingModel = false,
            modelLoadFailed = false,
            contextTierId = null,
            thinkingMode = null,
            runtimeConfiguration = resolveRuntimeConfiguration(_uiState.value.permitsRelaxedApproval),
            permitsRelaxedApproval = _uiState.value.permitsRelaxedApproval,
            executionAgentId = if (isNewSession) null else _uiState.value.executionAgentId,
            isSwitchingAgent = false,
            runState = null,
            readState = null,
        )
        startSessionObserver(sessionId)

        refreshSessionControlState(sessionId)

        viewModelScope.launch {
            reloadOutgoingQueue(sessionId)
            reconcileAcceptedOutgoingMessages(sessionId)
            // 回退 / 撤销回退会缩短或扩展服务端时间线。forceRefresh 时若先灌入旧缓存，
            // 普通历史合并为了保留已分页消息会把已被回退删除的尾部继续留在当前列表，
            // 直到退出会话再进入才消失。因此强制刷新必须只认服务端权威快照。
            if (!forceRefresh) {
                val memoryCached = chatRepository.getCachedMessages(sessionId)
                if (memoryCached != null) {
                    if (canReplaceMessagesFromHistory(sessionId, loadGeneration)) {
                        projector.seed(memoryCached)
                        rememberExecutionAgentIdFromHistory(memoryCached)
                        publishProjector {
                            // 缓存只用于让用户尽快看到历史，远端权威快照尚未回来。保留
                            // isLoading=true，让会话页在同一轮加载结束后再做一次稳定的尾部定位；
                            // UI 只在「loading 且没有消息」时显示 loading，因此不会遮住缓存内容。
                            it.copy(
                                hasMore = chatRepository.hasMore(sessionId),
                            )
                        }
                    }
                } else {
                    val dbCached = chatRepository.getDbCachedMessages(sessionId)
                    if (dbCached != null && canReplaceMessagesFromHistory(sessionId, loadGeneration)) {
                        projector.seed(dbCached)
                        rememberExecutionAgentIdFromHistory(dbCached)
                        publishProjector {
                            // 同内存缓存：数据库历史是预览，不是本次会话的最终权威结果。
                            it.copy(
                                hasMore = true,
                            )
                        }
                    }
                }
            }

            try {
                val result = chatRepository.getMessages(sessionId)
                if (canReplaceMessagesFromHistory(sessionId, loadGeneration)) {
                    val changed = applyHistoryResult(
                        result = result,
                        replace = {
                            if (forceRefresh) projector.replaceWithFocusedHistory(result.messages)
                            else projector.replaceWithHistory(result.messages)
                        },
                    )
                    if (changed || _uiState.value.isLoading) {
                        publishProjector {
                            it.copy(
                        isLoading = false,
                        hasMore = result.hasMore,
                            )
                        }
                    } else {
                        _uiState.value = _uiState.value.copy(isLoading = false, hasMore = result.hasMore)
                    }
                }
                if (canReplaceMessagesFromHistory(sessionId, loadGeneration)) {
                    historyHydratedSessionId = sessionId
                    acknowledgeReadIfContentHydrated(sessionId)
                }
            } catch (e: Exception) {
                if (currentSessionId == sessionId && sessionLoadGeneration == loadGeneration) {
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        errorMessage = if (_uiState.value.messages.isEmpty()) errorMessage(e) else null,
                    )
                }
            }
            drainOutgoingQueueIfPossible()
            hydratePendingInteractions(sessionId)
        }
    }

    /**
     * 将“Session 已建、首条消息尚未入队”的本地草稿转为 durable queue row。
     *
     * 草稿的 clientEventId 是稳定键，因此即使进程恰好在 Room 写入后、草稿删除前退出，
     * 下一次调用也只会读回同一行，不会重复发送或把已 ACK 的队列状态回退。
     */
    public suspend fun enqueuePendingDraftIfPresent(sessionId: String): Boolean {
        if (currentSessionId != sessionId) return false
        val draft = conversationDraftStore.loadForSession(sessionId) ?: return false
        if (!draft.matchesSession(sessionId) || !pendingDraftDeliveryIds.add(draft.draftId)) return false
        try {
            if (tokenManager.accessToken.isNullOrBlank()) {
                _uiState.value = _uiState.value.copy(errorMessage = AppError.NotLoggedIn.toUserMessage(context))
                return false
            }
            if (tokenManager.organizationId != draft.scope.organizationId) {
                _uiState.value = _uiState.value.copy(errorMessage = AppError.NoOrganization.toUserMessage(context))
                return false
            }
            if (_uiState.value.billingBlocked || _uiState.value.memberLimitBlocked) return false

            val blocks = draft.blocks.map { it.toMessageBlock() }
            if (draft.text.isBlank() && blocks.isEmpty()) return false

            val runtimeConfiguration = draft.runtimeConfiguration(
                permitsRelaxedApproval = _uiState.value.permitsRelaxedApproval,
            )
            requestedRuntimeConfiguration = ConversationRuntimeConfiguration.normalizedForStorage(
                rawAgentMode = draft.agentMode,
                rawApprovalMode = draft.approvalMode,
            )
            runtimeConfigurationStore.save(sessionId, requestedRuntimeConfiguration)
            hasStoredRuntimeConfiguration = true
            currentSessionSnapshot = ChatSession(
                id = sessionId,
                organizationId = draft.scope.organizationId,
                agentId = draft.agentId,
                currentModelId = draft.modelId,
                defaultModelId = draft.modelId,
            )
            rememberExecutionAgentId(draft.agentId)
            draftPersistenceScope = draft.scope.takeIf { it.isValid() }
            _uiState.update { state ->
                state.copy(
                    currentModel = state.availableModels.firstOrNull { it.id == draft.modelId } ?: state.currentModel,
                    contextTierId = draft.contextTierId ?: state.contextTierId,
                    thinkingMode = draft.thinkingMode ?: state.thinkingMode,
                    runtimeConfiguration = runtimeConfiguration,
                )
            }
            flushDraftModelRuntimeSettings(
                sessionId = sessionId,
                contextTierId = draft.contextTierId,
                thinkingMode = draft.thinkingMode,
            )

            val queued = enqueueOutgoingMessage(
                sessionId = sessionId,
                content = draft.text,
                blocks = blocks.takeIf { it.isNotEmpty() },
                modelId = draft.modelId,
                runtimeConfiguration = runtimeConfiguration,
                status = QueuedOutgoingMessageStatus.WAITING,
                clientEventId = draft.clientEventId,
            )
            if (queued.sessionId != sessionId) {
                _uiState.value = _uiState.value.copy(errorMessage = context.getString(R.string.error_send_failed))
                return false
            }
            conversationDraftStore.consume(draft.scope, draft.draftId)
            draftPersistenceScope = null
            drainOutgoingQueueIfPossible()
            return true
        } catch (error: Exception) {
            Log.e(TAG, "pending draft queue persist failed session=${sessionId.redactedId()}", error)
            _uiState.value = _uiState.value.copy(errorMessage = context.getString(R.string.error_send_failed))
            return false
        } finally {
            pendingDraftDeliveryIds.remove(draft.draftId)
        }
    }

    private fun isHistoryStreamingActive(): Boolean {
        val state = _uiState.value
        return projector.isStreamingActive ||
            state.isSending ||
            state.isStreaming ||
            state.messages.any { it.isStreaming }
    }

    private fun canApplyHistory(
        sessionId: String,
        generation: Long,
        allowWhileStreaming: Boolean,
    ): Boolean = ConversationSessionLoadGate.accepts(
        requestSessionId = sessionId,
        requestGeneration = generation,
        currentSessionId = currentSessionId,
        currentGeneration = sessionLoadGeneration,
        streamingActive = isHistoryStreamingActive(),
        allowWhileStreaming = allowWhileStreaming,
    )

    private fun canReplaceMessagesFromHistory(
        sessionId: String,
        generation: Long = sessionLoadGeneration,
    ): Boolean = canApplyHistory(
        sessionId = sessionId,
        generation = generation,
        allowWhileStreaming = false,
    )

    private suspend fun hydratePendingInteractions(sessionId: String) {
        val pending = pendingInteractionRepository.refreshSession(sessionId)
        if (currentSessionId != sessionId) return
        pending.asSequence()
            .mapNotNull { it.toStreamEvent(sessionId, tokenManager.userId) }
            .forEach { handleAssistantIndependentEvent(it, sessionId) }
    }

    private fun handlePendingInteractionUpdate(update: PendingInteractionUpdate) {
        val sid = currentSessionId ?: return
        when (update) {
            is PendingInteractionUpdate.Requested -> {
                if (!update.interaction.matchesSession(sid)) return
                update.interaction.toStreamEvent(sid, tokenManager.userId)
                    ?.let { handleAssistantIndependentEvent(it, sid) }
            }
            is PendingInteractionUpdate.Terminal -> {
                if (!update.interaction.matchesSession(sid)) return
                if (isSingleHitlInteractionKind(update.interaction.kind)) {
                    singleHitlResolutions.record(sid, update.interaction.requestKey)
                }
                dismissPendingInteraction(update.interaction.kind, update.interaction.requestKey)
            }
        }
    }

    /**
     * AskUser 可能经 stream、WS interaction_requested、hydrate 多路到达。
     * 同一 hitlRequestId / messageId 幂等跳过，避免面板重复挂载（双重触发）。
     */
    private fun applyAskUser(sessionId: String, event: StreamEvent.AskUser) {
        val requestId = event.hitlRequestId ?: event.messageId
        if (!singleHitlResolutions.shouldAccept(sessionId, requestId)) return
        val current = _uiState.value.pendingAskUser
        if (current != null) {
            val sameRequest = !event.hitlRequestId.isNullOrBlank() &&
                current.hitlRequestId == event.hitlRequestId
            val sameMessage = !event.messageId.isNullOrBlank() &&
                current.messageId == event.messageId
            if (sameRequest || sameMessage) {
                _uiState.value = _uiState.value.copy(
                    pendingAskUser = current.copy(
                        messageId = event.messageId ?: current.messageId,
                        hitlRequestId = event.hitlRequestId ?: current.hitlRequestId,
                        questions = event.questions,
                        title = event.title ?: current.title,
                        resolutionAccess = current.resolutionAccess.merging(event.resolutionAccess),
                    ),
                )
                return
            }
        }
        _uiState.value = _uiState.value.copy(
            pendingAskUser = PendingAskUser(
                sessionId = sessionId,
                messageId = event.messageId,
                hitlRequestId = event.hitlRequestId,
                questions = event.questions,
                title = event.title,
                resolutionAccess = event.resolutionAccess,
            ),
        )
    }

    private fun dismissPendingInteraction(kind: String, requestKey: String) {
        CapsuleInteractionPendingKey.terminalKeys(kind, requestKey).forEach { key ->
            releaseHitlSubmissionForKey(key)
        }
        val state = _uiState.value
        when (kind) {
            "tool_approval" -> {
                val pending = state.pendingApproval ?: return
                if (requestKey != pending.batchId && requestKey != pending.actionApprovalId) return
                approvalExpirationJob?.cancel()
                approvalExpirationJob = null
                _uiState.value = _uiState.value.copy(pendingApproval = null)
            }
            "ask_choice" -> {
                val pending = state.pendingAskUser ?: return
                if (requestKey != pending.hitlRequestId && requestKey != pending.messageId) return
                _uiState.value = _uiState.value.copy(pendingAskUser = null)
            }
            "ask_form" -> {
                val pending = state.pendingAskForm ?: return
                if (requestKey != pending.request.requestId) return
                _uiState.value = _uiState.value.copy(pendingAskForm = null)
            }
            "permission_request" -> {
                val pending = state.pendingRequestApproval ?: return
                if (requestKey != pending.request.requestId) return
                _uiState.value = _uiState.value.copy(pendingRequestApproval = null)
            }
        }
    }

    private fun convergeSingleHitlResolved(sessionId: String, requestId: String) {
        singleHitlResolutions.record(sessionId, requestId)
        val threadId = "chat-session-$sessionId"
        listOf("ask_choice", "ask_form", "permission_request").forEach { kind ->
            pendingInteractionRepository.markResolved(
                kind = kind,
                threadId = threadId,
                requestKey = requestId,
            )
            dismissPendingInteraction(kind, requestId)
        }
    }

    private fun isSingleHitlInteractionKind(kind: String): Boolean =
        kind == "ask_choice" || kind == "ask_form" || kind == "permission_request"

    private fun com.tabtin.mobile.data.model.PendingInteraction.matchesSession(sessionId: String): Boolean {
        return this.sessionId == sessionId || this.threadId == "chat-session-$sessionId"
    }

    private fun startSessionObserver(sessionId: String) {
        sessionObserverJob?.cancel()
        sessionObserverJob = viewModelScope.launch {
            streamManager.observeSession(sessionId).collect { event ->
                if (currentSessionId != sessionId) return@collect
                if (event is StreamEvent.SubscriptionReady) {
                    subscriptionReadySessionId = sessionId
                    acknowledgeReadIfContentHydrated(sessionId)
                    return@collect
                }
                if (shouldDiscardWithdrawnTurnEvent(event)) {
                    // 丢弃窗吞投影，但仍要消费 done 上的 withdraw_applied（ 对账门控）。
                    if (event is StreamEvent.Done) {
                        onWithdrawAppliedSignal(event.withdrawApplied, sessionId)
                    }
                    if (event.isTerminalRunEvent()) {
                        clearWithdrawnTurnDiscard()
                        settleRunControls()
                    }
                    return@collect
                }
                if (event.isTerminalRunEvent()) settleRunControls()
                // USER mirror only proves persistence. It is not assistant progress: keeping the
                // watchdog armed ensures an ACK-without-assistant-stream turn closes its placeholder.
                if (event.countsAsAssistantProgressForSendWatchdog()) receivedSinceSend = true
                if (event is StreamEvent.ObservedUserMessage) {
                    handleObservedUserMessage(event, sessionId)
                    return@collect
                }
                if (event is StreamEvent.NeedsResync) {
                    refreshCommittedMessages(event.sessionId)
                    return@collect
                }
                if (handleAssistantIndependentEvent(event, sessionId)) {
                    return@collect
                }
                if (applyProjectorStreamEvent(event, sessionId)) {
                    return@collect
                }
                val assistantId = assistantIdForStreamEvent(event) ?: run {
                    handleUnclaimedSettledEvent(event, sessionId)
                    return@collect
                }
                handleStreamEvent(event, sessionId, assistantId)
                when (event) {
                    is StreamEvent.Done,
                    is StreamEvent.Error,
                    is StreamEvent.RunCompletedInBackground -> {
                        endStreamingState()
                    }
                    else -> {
                        publishDerivedStreamingState()
                    }
                }
            }
        }
    }

    private fun stopSessionObserver() {
        val observedSessionId = currentSessionId
        val keepStreamTopicAlive = _uiState.value.isStreaming || _uiState.value.messages.any { it.isStreaming }
        sessionObserverJob?.cancel()
        sessionObserverJob = null
        subscriptionReadySessionId = null
        observedSessionId?.let { streamManager.releaseSession(it, keepAlive = keepStreamTopicAlive) }
        reconcileJob?.cancel()
        reconcileJob = null
        sendWatchdogJob?.cancel()
        sendWatchdogJob = null
        approvalExpirationJob?.cancel()
        approvalExpirationJob = null
        readAckJob?.cancel()
        readAckJob = null
        cancelPendingProjectorPublish()
        activeAssistantId = null
        pendingOptimisticAssistantId = null
        assistantIdsByServerMessageId.clear()
        blockProjector.reset()
        projector.reset(clearMessages = false)
    }

    private fun assistantIdForStreamEvent(event: StreamEvent): String? {
        val assistantId = projector.assistantIdFor(event)
        if (assistantId != null) {
            activeAssistantId = assistantId
            val serverMessageId = event.streamMessageId()
            if (!serverMessageId.isNullOrBlank()) {
                assistantIdsByServerMessageId[serverMessageId] = assistantId
            }
            if (pendingOptimisticAssistantId == assistantId && !projector.hasPendingOptimistic) {
                pendingOptimisticAssistantId = null
            }
            publishProjector()
        }
        return assistantId
    }

    private fun StreamEvent.shouldCreateAssistantWithoutMessageId(): Boolean = when (this) {
        is StreamEvent.ChunkAppended,
        is StreamEvent.Reasoning,
        is StreamEvent.ToolCall,
        is StreamEvent.StepUpdate,
        is StreamEvent.SystemNotice,
        is StreamEvent.Error,
        is StreamEvent.ContentReset -> true
        else -> false
    }

    private fun StreamEvent.shouldCreateAssistantForServerMessageId(): Boolean = when (this) {
        is StreamEvent.MessageStarted,
        is StreamEvent.TextBlockDelta,
        is StreamEvent.CitationBlockDelta,
        is StreamEvent.ThinkingBlockDelta,
        is StreamEvent.ToolUseBlockStarted,
        is StreamEvent.ToolUseBlockUpdated,
        is StreamEvent.ToolUseBlockCompleted,
        is StreamEvent.ToolResultBlock,
        is StreamEvent.RichContentBlockReceived,
        is StreamEvent.ContextRefBlockReceived,
        is StreamEvent.AttachmentBlockReceived -> true
        else -> false
    }

    private fun handleUnclaimedSettledEvent(event: StreamEvent, sessionId: String) {
        when (event) {
            is StreamEvent.Done,
            is StreamEvent.MessagePersisted,
            is StreamEvent.MessageStopped -> {
                endStreamingState()
                refreshLatestMessagesWhenSettled(sessionId)
            }
            is StreamEvent.MessageCommitted -> refreshCommittedMessages(sessionId)
            else -> Unit
        }
    }

    private fun handleAssistantIndependentEvent(event: StreamEvent, sessionId: String): Boolean {
        when (event) {
            is StreamEvent.OutgoingExecutionStarted -> {
                completeOutgoingExecutionByClientEvent(sessionId, event.sourceClientEventId)
                return true
            }
            is StreamEvent.Compaction -> {
                _uiState.value = _uiState.value.copy(
                    compactionInProgress = event.phase == "start",
                )
                return true
            }
            is StreamEvent.LifecycleChanged -> {
                _uiState.value = _uiState.value.copy(currentPhase = event.phase)
                return true
            }
            is StreamEvent.AskUser -> {
                val sid = currentSessionId ?: return true
                applyAskUser(sid, event)
                return true
            }
            is StreamEvent.AskFormRequired -> {
                val sid = currentSessionId ?: return true
                if (!singleHitlResolutions.shouldAccept(sid, event.request.requestId)) return true
                val existing = _uiState.value.pendingAskForm
                    ?.takeIf { it.request.requestId == event.request.requestId }
                val access = existing?.resolutionAccess?.merging(event.resolutionAccess)
                    ?: event.resolutionAccess
                _uiState.value = _uiState.value.copy(
                    pendingAskForm = PendingAskForm(sid, event.request, access),
                )
                return true
            }
            is StreamEvent.RequestApprovalRequired -> {
                val sid = currentSessionId ?: return true
                if (!singleHitlResolutions.shouldAccept(sid, event.request.requestId)) return true
                val existing = _uiState.value.pendingRequestApproval
                    ?.takeIf { it.request.requestId == event.request.requestId }
                val access = existing?.resolutionAccess?.merging(event.resolutionAccess)
                    ?: event.resolutionAccess
                _uiState.value = _uiState.value.copy(
                    pendingRequestApproval = PendingRequestApproval(sid, event.request, access),
                )
                return true
            }
            is StreamEvent.SingleHitlResolved -> {
                convergeSingleHitlResolved(sessionId, event.requestId)
                return true
            }
            is StreamEvent.SubagentStreamEvent -> {
                applySubagentStreamEvent(event)
                return true
            }
            is StreamEvent.PermissionStatusUpdate -> return true
            is StreamEvent.PlanApprovalRequired -> {
                val sid = event.sessionId ?: currentSessionId ?: return true
                _uiState.value = _uiState.value.copy(
                    pendingPlanApproval = PendingPlanApproval(
                        requestId = event.requestId,
                        sessionId = sid,
                        planDocumentId = event.planDocumentId,
                        planSnapshot = event.planSnapshot,
                        hintAllowedPrompts = event.hintAllowedPrompts,
                    ),
                    pendingApproval = null,
                )
                return true
            }
            is StreamEvent.PlanProposalReceived -> {
                projector.appendPlanProposal(event.proposal)
                publishProjector()
                return true
            }
            is StreamEvent.ModeSwitchProposalReceived -> {
                projector.appendModeSwitchProposal(event.proposal)
                publishProjector()
                return true
            }
            is StreamEvent.ApprovalRequested -> {
                applyApprovalRequested(event)
                return true
            }
            is StreamEvent.ApprovalResolved -> {
                val resolvedLocalSubmission = releaseHitlSubmissionForKey(
                    CapsuleInteractionPendingKey.resolvedToolApproval(event.batchId),
                )
                val pa = _uiState.value.pendingApproval ?: return true
                if (pa.batchId != event.batchId) return true
                val firstUnusual = event.decisions.firstOrNull { d ->
                    d.outcome != "allow" && d.outcome != "deny"
                }?.outcome
                val externalDismissMsg = when (firstUnusual) {
                    "expired" -> context.getString(R.string.chat_approval_resolved_expired)
                    "cancelled" -> context.getString(R.string.chat_approval_resolved_cancelled)
                    "cancelled_by_rollback" -> context.getString(R.string.chat_approval_resolved_rolled_back)
                    else -> {
                        if (!resolvedLocalSubmission) {
                            context.getString(R.string.chat_approval_resolved_elsewhere)
                        } else null
                    }
                }
                _uiState.value = _uiState.value.copy(
                    pendingApproval = null,
                    errorMessage = externalDismissMsg ?: _uiState.value.errorMessage,
                )
                return true
            }
            is StreamEvent.TodoUpdate -> {
                _uiState.value = _uiState.value.copy(agentTodos = event.todos)
                return true
            }
            is StreamEvent.CheckpointFailed -> {
                _checkpointStreamEvents.tryEmit(CheckpointStreamEvent.Failed(event.sessionId))
                return true
            }
            is StreamEvent.CheckpointSuccess -> {
                _checkpointStreamEvents.tryEmit(CheckpointStreamEvent.Success(event.sessionId))
                return true
            }
            is StreamEvent.ReviewRequired -> {
                _uiState.value = _uiState.value.copy(pendingReview = event.request)
                return true
            }
            is StreamEvent.RunCompletedInBackground -> {
                endStreamingState()
                refreshLatestMessagesWhenSettled(sessionId)
                return true
            }
            StreamEvent.ConnectionInterrupted -> {
                _uiState.value = _uiState.value.copy(connectionInterrupted = true)
                return true
            }
            StreamEvent.ConnectionRestored -> {
                _uiState.value = _uiState.value.copy(connectionInterrupted = false)
                refreshLatestMessagesWhenSettled(sessionId)
                return true
            }
            else -> return false
        }
    }

    private fun applySubagentStreamEvent(event: StreamEvent.SubagentStreamEvent) {
        val update = subagentTranscriptUpdate(event) ?: return
        val targetId = _uiState.value.messages.firstOrNull { msg ->
            msg.agentSteps.orEmpty().any { step ->
                val snap = step.subagent
                snap?.runId == event.runId || snap?.parentToolCallId == event.runId
            }
        }?.id ?: activeAssistantId
            ?: _uiState.value.messages.lastOrNull { it.isAssistant }?.id
            ?: return
        updateAssistant(targetId) { msg ->
            msg.copy(
                agentSteps = SubagentCardReducer.applyTranscript(
                    steps = msg.agentSteps.orEmpty(),
                    runId = event.runId,
                    update = update,
                ),
            )
        }
    }

    private fun subagentTranscriptUpdate(
        event: StreamEvent.SubagentStreamEvent,
    ): SubagentCardReducer.SubagentTranscriptUpdate? {
        val child = event.childEvent
        fun transcriptId(messageId: String?, index: Int?, suffix: String): String =
            "${messageId ?: event.runId}:${index ?: 0}:$suffix"
        return when (child) {
            is StreamEvent.TextBlockDelta -> SubagentCardReducer.SubagentTranscriptUpdate(
                id = transcriptId(child.messageId, child.index, "text"),
                messageId = child.messageId,
                index = child.index,
                kind = SubagentTranscriptItem.Kind.ASSISTANT,
                textDelta = child.text,
            )
            is StreamEvent.ThinkingBlockDelta -> SubagentCardReducer.SubagentTranscriptUpdate(
                id = transcriptId(child.messageId, child.index, "thinking"),
                messageId = child.messageId,
                index = child.index,
                kind = SubagentTranscriptItem.Kind.THINKING,
                title = context.getString(R.string.chat_subagent_transcript_thinking),
                // 流式 delta 用追加；completed 哨兵（空 text）只打终态，避免整段被空串盖掉。
                textDelta = if (child.completed || child.text.isEmpty()) null else child.text,
                isFinal = child.completed,
            )
            is StreamEvent.ToolUseBlockStarted -> SubagentCardReducer.SubagentTranscriptUpdate(
                id = "tool-${child.toolCallId}",
                messageId = child.messageId,
                index = child.index,
                kind = SubagentTranscriptItem.Kind.TOOL,
                title = child.name,
                inputText = child.input,
                toolCallId = child.toolCallId,
            )
            is StreamEvent.ToolUseBlockUpdated -> {
                SubagentCardReducer.SubagentTranscriptUpdate(
                    id = "tool-${child.toolCallId}",
                    messageId = child.messageId,
                    index = child.index,
                    kind = SubagentTranscriptItem.Kind.TOOL,
                    title = child.name,
                    inputText = child.input,
                    toolCallId = child.toolCallId,
                )
            }
            is StreamEvent.ToolUseBlockCompleted -> {
                SubagentCardReducer.SubagentTranscriptUpdate(
                    id = "tool-${child.toolCallId}",
                    messageId = child.messageId,
                    index = child.index,
                    kind = SubagentTranscriptItem.Kind.TOOL,
                    title = child.name,
                    inputText = child.input,
                    isFinal = true,
                    toolCallId = child.toolCallId,
                )
            }
            is StreamEvent.ToolResultBlock -> SubagentCardReducer.SubagentTranscriptUpdate(
                id = "tool-${child.toolUseId}",
                messageId = child.messageId,
                index = child.index,
                kind = SubagentTranscriptItem.Kind.TOOL,
                outputText = child.output,
                isFinal = true,
                isError = child.isError,
                toolCallId = child.toolUseId,
            )
            is StreamEvent.RichContentBlockReceived -> SubagentCardReducer.SubagentTranscriptUpdate(
                id = transcriptId(child.messageId, child.index, "rich"),
                messageId = child.messageId,
                index = child.index,
                kind = SubagentTranscriptItem.Kind.RICH_CONTENT,
                title = child.block.title ?: child.block.kind ?: child.block.type,
                text = child.block.summary ?: child.block.content ?: child.block.text,
                richContent = child.block.normalizedRichContent(),
                isFinal = true,
            )
            is StreamEvent.ContextRefBlockReceived -> SubagentCardReducer.SubagentTranscriptUpdate(
                id = transcriptId(child.messageId, child.index, "context"),
                messageId = child.messageId,
                index = child.index,
                kind = SubagentTranscriptItem.Kind.CONTEXT_REF,
                title = child.block.title ?: child.block.resourceName,
                text = child.block.preview,
                isFinal = true,
            )
            is StreamEvent.SystemNotice -> {
                // 对齐 iOS：Thinking... 迭代占位与空通知不进中间步骤。
                if (isSubagentThinkingIterationNoise(title = null, text = child.content)) null
                else SubagentCardReducer.SubagentTranscriptUpdate(
                    id = "notice-${System.currentTimeMillis()}",
                    messageId = null,
                    index = null,
                    kind = SubagentTranscriptItem.Kind.SYSTEM,
                    title = context.getString(R.string.chat_subagent_transcript_event),
                    text = child.content,
                    isFinal = true,
                )
            }
            is StreamEvent.ToolCall -> SubagentCardReducer.SubagentTranscriptUpdate(
                id = "tool-${child.id}",
                messageId = null,
                index = null,
                kind = SubagentTranscriptItem.Kind.TOOL,
                title = child.name,
                inputText = child.input,
                outputText = child.output,
                isFinal = child.status != StepStatus.RUNNING,
                isError = child.status == StepStatus.FAILED,
                toolCallId = child.id,
            )
            is StreamEvent.Error -> SubagentCardReducer.SubagentTranscriptUpdate(
                id = "error-${System.currentTimeMillis()}",
                messageId = null,
                index = null,
                kind = SubagentTranscriptItem.Kind.ERROR,
                title = context.getString(R.string.chat_subagent_transcript_error),
                text = child.error.toUserMessage(context),
                isFinal = true,
                isError = true,
            )
            is StreamEvent.Done -> child.errorMessage?.let { error ->
                SubagentCardReducer.SubagentTranscriptUpdate(
                    id = "error-${System.currentTimeMillis()}",
                    messageId = child.messageId,
                    index = null,
                    kind = SubagentTranscriptItem.Kind.ERROR,
                    title = context.getString(R.string.chat_subagent_transcript_error),
                    text = error,
                    isFinal = true,
                    isError = true,
                )
            }
            is StreamEvent.AskUser -> subagentNotice(event.runId, context.getString(R.string.chat_subagent_transcript_hitl))
            is StreamEvent.AskFormRequired -> subagentNotice(event.runId, context.getString(R.string.chat_subagent_transcript_hitl))
            is StreamEvent.RequestApprovalRequired -> subagentNotice(event.runId, context.getString(R.string.chat_subagent_transcript_hitl))
            is StreamEvent.TodoUpdate -> subagentNotice(
                event.runId,
                context.getString(R.string.chat_subagent_transcript_todo, child.todos.size),
            )
            is StreamEvent.CheckpointSuccess -> subagentNotice(event.runId, context.getString(R.string.chat_subagent_transcript_checkpoint_ok))
            is StreamEvent.CheckpointFailed -> subagentNotice(event.runId, context.getString(R.string.chat_subagent_transcript_checkpoint_failed))
            // 对齐 iOS `runtimeStep` / lifecycle / message_*：兼容性运行提示与元事件不进内容时间线。
            is StreamEvent.StepUpdate,
            is StreamEvent.LifecycleChanged,
            is StreamEvent.MessageStarted,
            is StreamEvent.MessageStopped,
            is StreamEvent.MessagePersisted,
            is StreamEvent.MessageCommitted,
            is StreamEvent.ChunkAppended,
            is StreamEvent.Reasoning,
            is StreamEvent.CitationBlockDelta,
            is StreamEvent.SubscriptionReady,
            is StreamEvent.NeedsResync,
            is StreamEvent.OutgoingExecutionStarted,
            is StreamEvent.ConnectionInterrupted,
            is StreamEvent.ConnectionRestored,
            is StreamEvent.PermissionStatusUpdate,
            is StreamEvent.ObservedUserMessage,
            is StreamEvent.ContentReset,
            is StreamEvent.AttachmentBlockReceived -> null
            else -> null
        }
    }

    /** `agent.stream.step` / system_notice 的 Thinking… 迭代占位，不是真实思考正文。 */
    private fun isSubagentThinkingIterationNoise(title: String?, text: String?): Boolean {
        val candidates = listOfNotNull(title, text).map { it.trim() }.filter { it.isNotEmpty() }
        return candidates.any { it.lowercase().startsWith("thinking") }
    }

    private fun subagentNotice(
        runId: String,
        text: String,
    ): SubagentCardReducer.SubagentTranscriptUpdate =
        SubagentCardReducer.SubagentTranscriptUpdate(
            id = "notice-$runId-${System.currentTimeMillis()}",
            messageId = null,
            index = null,
            kind = SubagentTranscriptItem.Kind.SYSTEM,
            text = text,
            isFinal = true,
        )

    private fun isClaimableOptimisticAssistant(id: String): Boolean =
        _uiState.value.messages.any { msg ->
            msg.id == id &&
                msg.isAssistant &&
                msg.content.isBlank() &&
                msg.reasoning.isNullOrBlank() &&
                msg.agentSteps.isNullOrEmpty() &&
                msg.blocksJson.isNullOrEmpty()
        }

    private fun StreamEvent.streamMessageId(): String? = when (this) {
        is StreamEvent.MessageStarted -> messageId
        is StreamEvent.TextBlockDelta -> messageId
        is StreamEvent.CitationBlockDelta -> messageId
        is StreamEvent.ThinkingBlockDelta -> messageId
        is StreamEvent.ToolUseBlockStarted -> messageId
        is StreamEvent.ToolUseBlockUpdated -> messageId
        is StreamEvent.ToolUseBlockCompleted -> messageId
        is StreamEvent.ToolResultBlock -> messageId
        is StreamEvent.RichContentBlockReceived -> messageId
        is StreamEvent.ContextRefBlockReceived -> messageId
        is StreamEvent.AttachmentBlockReceived -> messageId
        is StreamEvent.MessageStopped -> messageId
        is StreamEvent.Done -> messageId
        is StreamEvent.MessagePersisted -> messageId
        is StreamEvent.MessageCommitted -> messageId
        else -> null
    }

    private fun handleObservedUserMessage(
        event: StreamEvent.ObservedUserMessage,
        sessionId: String,
    ) {
        projector.appendObservedUserMessage(event.id, event.content)
        publishProjector()
        val identities = setOfNotNull(
            event.id,
            event.clientEventId,
            event.serverMessageId,
        ).filter { it.isNotBlank() }.toSet()
        viewModelScope.launch {
            val persisted = outgoingQueueRepository.markPersisted(sessionId, identities)
            if (persisted.isNotEmpty() && currentSessionId == sessionId) {
                reloadOutgoingQueue(sessionId)
                drainOutgoingQueueIfPossible()
            }
            Log.i(
                TAG,
                "outgoing mirror session=${sessionId.redactedId()} client=${event.clientEventId.redactedId()} " +
                    "message=${event.serverMessageId.redactedId()} persisted=${persisted.size}",
            )
        }
    }

    private fun completeOutgoingExecutionByTask(sessionId: String, taskId: String?) {
        if (taskId.isNullOrBlank()) return
        viewModelScope.launch {
            val completed = outgoingQueueRepository.completeExecution(sessionId, taskId = taskId)
            completed.forEach { id -> outgoingReconcileJobs.remove(id)?.cancel() }
            if (completed.isNotEmpty() && currentSessionId == sessionId) {
                reloadOutgoingQueue(sessionId)
                drainOutgoingQueueIfPossible()
            }
        }
    }

    private fun completeOutgoingExecutionByClientEvent(
        sessionId: String,
        clientEventId: String?,
    ) {
        if (clientEventId.isNullOrBlank()) return
        viewModelScope.launch {
            val completed = outgoingQueueRepository.completeExecution(
                sessionId,
                identities = setOf(clientEventId),
            )
            completed.forEach { id -> outgoingReconcileJobs.remove(id)?.cancel() }
            if (completed.isNotEmpty() && currentSessionId == sessionId) {
                reloadOutgoingQueue(sessionId)
                drainOutgoingQueueIfPossible()
            }
        }
    }

    private fun createAssistantMessage(): String {
        val assistantId = projector.beginAssistant(
            id = "streaming-${System.currentTimeMillis()}",
            agentId = optimisticExecutionAgentId(),
        )
        activeAssistantId = assistantId
        pendingOptimisticAssistantId = assistantId
        publishProjector()
        return assistantId
    }

    private fun optimisticExecutionAgentId(): String? =
        resolveOptimisticExecutionAgentId(executionAgentId, currentSessionSnapshot?.agentId)

    private fun rememberExecutionAgentId(agentId: String?) {
        val normalized = agentId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        executionAgentId = normalized
        _uiState.update { current ->
            if (current.executionAgentId == normalized) current else current.copy(executionAgentId = normalized)
        }
    }

    /** Session 快照未到前，用历史末条 assistant 的 agentId 顶住快发窗口。 */
    private fun rememberExecutionAgentIdFromHistory(messages: List<ChatMessage>) {
        if (!executionAgentId.isNullOrBlank()) return
        rememberExecutionAgentId(
            messages.asReversed().firstOrNull { it.isAssistant && !it.agentId.isNullOrBlank() }?.agentId,
        )
    }

    private fun publishDerivedStreamingState() {
        val anyStreaming = _uiState.value.messages.any { it.isStreaming }
        _uiState.value = if (anyStreaming) {
            _uiState.value.copy(isStreaming = true)
        } else {
            _uiState.value.copy(
                isStreaming = false,
                currentPhase = AgentPhase.IDLE,
                currentToolName = null,
            )
        }
    }

    private fun publishProjector(
        update: (ConversationUiState) -> ConversationUiState = { it },
    ) {
        val base = update(_uiState.value)
        val streamingActive = projector.isStreamingActive
        _uiState.value = base.copy(
            messages = ConversationStreamPublishPolicy.publishedMessages(
                previous = base.messages,
                next = projector.messages,
                isStreaming = streamingActive,
            ),
            isStreaming = streamingActive,
            currentPhase = projector.phase ?: if (projector.isStreamingActive) base.currentPhase else AgentPhase.IDLE,
            currentToolName = if (projector.isStreamingActive) base.currentToolName else null,
        )
        resolveMessageAgentFaces(projector.messages)
    }

    /**
     * 展示层需要组织 Agent 目录中的显示名与头像。结果落地前复核会话与组织，防止迟到回包
     * 覆盖用户已经切换到的组织或会话。
     */
    private fun resolveMessageAgentFaces(messages: List<ChatMessage>) {
        if (messages.none { it.isAssistant && !it.agentId.isNullOrBlank() }) return
        val sessionId = currentSessionId ?: return
        val organizationId = tokenManager.organizationId ?: return
        val scope = sessionId to organizationId
        if (agentNameLookupScope == scope) return
        agentNameLookupScope = scope

        viewModelScope.launch {
            runCatching { spaceRepository.getAgents() }
                .onSuccess { agents ->
                    if (currentSessionId != sessionId || tokenManager.organizationId != organizationId) return@onSuccess
                    val faces = agents.associate { agent ->
                        val avatarUrl = agent.settings?.avatarUrl?.takeIf { it.isNotBlank() }
                        val avatarKey = agent.settings?.avatarKey?.takeIf { it.isNotBlank() }
                            ?: AgentAvatarPreset.GENERAL_ASSISTANT.key.takeIf { avatarUrl == null }
                        agent.id to AgentFace(
                            name = agent.displayName?.takeIf { it.isNotBlank() } ?: agent.name,
                            avatarKey = avatarKey,
                            avatarUrl = avatarUrl,
                        )
                    }
                    _uiState.update { state ->
                        state.copy(
                            messageAgentFacesById = faces,
                            messageAgentNamesById = faces.mapValues { it.value.name },
                        )
                    }
                }
        }
    }


    private fun publishProjectorThrottled(
        update: (ConversationUiState) -> ConversationUiState = { it },
    ) {
        val previous = pendingProjectorUpdate
        pendingProjectorUpdate = if (previous == null) {
            update
        } else {
            { state -> update(previous(state)) }
        }
        if (projectorPublishJob != null) return
        projectorPublishJob = viewModelScope.launch {
            delay(STREAM_PUBLISH_INTERVAL_MS)
            val pending = pendingProjectorUpdate
            projectorPublishJob = null
            pendingProjectorUpdate = null
            publishProjector(pending ?: { it })
        }
    }

    private fun flushPendingProjectorPublish() {
        val pending = pendingProjectorUpdate
        projectorPublishJob?.cancel()
        projectorPublishJob = null
        pendingProjectorUpdate = null
        if (pending != null) publishProjector(pending)
    }

    private fun cancelPendingProjectorPublish() {
        projectorPublishJob?.cancel()
        projectorPublishJob = null
        pendingProjectorUpdate = null
    }

    private fun beginRunControlRequest(): Long {
        runControlGeneration += 1
        return runControlGeneration
    }

    private fun invalidateRunControlRequests() {
        runControlGeneration += 1
    }

    private fun isCurrentRunControlRequest(sessionId: String, generation: Long): Boolean =
        currentSessionId == sessionId && runControlGeneration == generation

    /** Reconcile after an ACK failure without allowing an older GET to undo a newer control action. */
    private fun refreshSessionControlState(
        sessionId: String,
        expectedGeneration: Long = runControlGeneration,
    ) {
        viewModelScope.launch {
            runCatching { chatRepository.getSession(sessionId) }
                .onSuccess { session ->
                    if (isCurrentRunControlRequest(sessionId, expectedGeneration)) {
                        applyServerSessionModel(sessionId, session)
                        applyServerRuntimeConfiguration(
                            sessionId = sessionId,
                            rawAgentMode = session.agentMode,
                            rawApprovalMode = session.approvalMode,
                        )
                        // is_paused 只表示已请求暂停；已抵达只认 run_state.status=paused。
                        session.runState?.let {
                            applyAuthoritativeRunState(
                                sessionId,
                                it,
                                sessionRequestedPause = session.isPaused,
                            )
                        }
                            ?: _uiState.update { it.copy(isPaused = session.isPaused) }
                        session.readState?.let { applyAuthoritativeReadState(sessionId, it) }
                    }
                }
        }
    }

    /** 将服务端 Session 的模型事实投影到已加载的组织模型目录。 */
    private fun applyServerSessionModel(sessionId: String, session: ChatSession) {
        if (currentSessionId != sessionId ||
            _uiState.value.isSwitchingModel ||
            _uiState.value.isSwitchingAgent
        ) {
            return
        }
        currentSessionSnapshot = session
        rememberExecutionAgentId(session.agentId)
        val organizationId = session.organizationId?.takeIf { it.isNotBlank() }
            ?: tokenManager.organizationId?.takeIf { it.isNotBlank() }
            ?: return
        val state = _uiState.value
        val selected = if (cachedModelOrganizationId == organizationId && state.availableModels.isNotEmpty()) {
            resolveConversationChatModel(
                session = session,
                availableModels = state.availableModels,
                catalogDefaultModelId = cachedCatalogDefaultModelId,
            )
        } else {
            null
        }
        if (selected != null) {
            val runtimeProjection = projectModelRuntimeFromSession(
                model = selected,
                session = session,
                preferLocal = hasLocalModelRuntimeIntent,
                localContextTierId = state.contextTierId,
                localThinkingMode = state.thinkingMode,
            )
            _uiState.value = state.copy(
                currentModel = selected,
                contextTierId = runtimeProjection.contextTierId,
                thinkingMode = runtimeProjection.thinkingMode,
                isLoadingModels = false,
            )
        } else {
            if (!hasLocalModelRuntimeIntent) {
                _uiState.update {
                    it.copy(
                        contextTierId = session.contextTierId,
                        thinkingMode = session.modelParamOverrides.thinkingMode(),
                    )
                }
            }
            loadChatModels(forceRefresh = true)
        }
    }

    private data class ModelRuntimeProjection(
        val contextTierId: String?,
        val thinkingMode: String?,
    )

    private fun projectModelRuntimeFromSession(
        model: LlmModel,
        session: ChatSession,
        preferLocal: Boolean,
        localContextTierId: String?,
        localThinkingMode: String?,
    ): ModelRuntimeProjection {
        val tierId = when {
            preferLocal && localContextTierId != null ->
                resolveActiveContextTierId(model, localContextTierId)
            else -> resolveActiveContextTierId(model, session.contextTierId)
        }
        val thinkingCapability = model.catalogThinkingCapability()
        val thinking = if (thinkingCapability == null) {
            null
        } else {
            resolveActiveThinkingMode(
                overrides = if (preferLocal) null else session.modelParamOverrides,
                selectedMode = if (preferLocal) localThinkingMode else session.modelParamOverrides.thinkingMode(),
                capability = thinkingCapability,
            )
        }
        return ModelRuntimeProjection(contextTierId = tierId, thinkingMode = thinking)
    }

    private fun flushDraftModelRuntimeSettings(
        sessionId: String,
        contextTierId: String?,
        thinkingMode: String?,
    ) {
        val tier = contextTierId?.trim()?.takeIf { it.isNotEmpty() }
        val mode = thinkingMode?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
        if (tier == null && mode == null) return
        val generation = ++modelRuntimeWriteGeneration
        viewModelScope.launch {
            if (tier != null) {
                runCatching { chatRepository.switchContextTier(sessionId, tier) }
                    .onFailure { Log.w(TAG, "draft context tier flush failed session=${sessionId.redactedId()}", it) }
            }
            if (mode != null) {
                runCatching {
                    chatRepository.updateModelParams(
                        sessionId = sessionId,
                        thinkingMode = mode,
                        preserving = currentSessionSnapshot?.modelParamOverrides,
                    )
                }.onSuccess { response ->
                    if (currentSessionId == sessionId && generation == modelRuntimeWriteGeneration) {
                        currentSessionSnapshot = currentSessionSnapshot?.copy(
                            modelParamOverrides = response.modelParamOverrides
                                ?: currentSessionSnapshot?.modelParamOverrides,
                        )
                    }
                }.onFailure { Log.w(TAG, "draft thinking mode flush failed session=${sessionId.redactedId()}", it) }
            }
            if (currentSessionId == sessionId && generation == modelRuntimeWriteGeneration) {
                currentSessionSnapshot = currentSessionSnapshot?.copy(
                    contextTierId = tier ?: currentSessionSnapshot?.contextTierId,
                )
            }
        }
    }

    /** 草稿态把运行设置写回本地 draft store（对齐 iOS makeDraftSnapshot）。 */
    private fun persistDraftModelRuntimeSettings(
        contextTierId: String?,
        thinkingMode: String?,
    ) {
        val scope = draftPersistenceScope?.takeIf { it.isValid() } ?: return
        val existing = conversationDraftStore.load(scope) ?: return
        conversationDraftStore.save(
            existing.copy(
                contextTierId = contextTierId?.trim()?.takeIf { it.isNotEmpty() }
                    ?: existing.contextTierId,
                thinkingMode = thinkingMode?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
                    ?: existing.thinkingMode,
            ),
        )
    }

    /**
     * 绑定草稿执行范围，使无 sessionId 时 selectContextTier / selectThinkingMode 能落盘。
     * 通常由宿主在打开「新建会话」草稿页时调用。
     */
    public fun bindDraftPersistenceScope(scope: ConversationDraftScope?) {
        if (currentSessionId != null) return
        draftPersistenceScope = scope?.takeIf { it.isValid() }
    }

    /**
     * 进入会话内草稿态：保存执行 Space / Agent，供首发 [prepareSession] 使用。
     * 已有正式 session 时忽略（首发成功后的 Compose 重绑不会把状态打回草稿）。
     */
    public fun enableDraftMode(executionSpace: Space, agentId: String) {
        if (currentSessionId != null) return
        draftMode = true
        draftExecutionSpace = executionSpace
        val normalizedAgent = agentId.trim().takeIf { it.isNotEmpty() }
        draftAgentId = normalizedAgent
        normalizedAgent?.let(::rememberExecutionAgentId)
        draftScopeFromSpace(executionSpace)?.let { scope ->
            draftPersistenceScope = scope
        }
    }

    /** 草稿页已完成首发并 loadSession 后为 true；Compose 用它避免再次走草稿绑定。 */
    public fun hasActiveSession(): Boolean = currentSessionId != null

    private fun beginFirstSend(): Boolean =
        ConversationDraftFirstSendPolicy.canBeginFirstSend(
            draftMode = draftMode,
            hasSession = currentSessionId != null,
            firstSendInFlight = firstSendInFlight,
        ).also { allowed ->
            if (allowed) firstSendInFlight = true
        }

    private fun finishFirstSend() {
        firstSendInFlight = false
    }

    private fun draftScopeFromSpace(space: Space): ConversationDraftScope? {
        val workspaceId = when {
            space.isExecutionSpace -> space.id
            else -> space.executionSpaceId?.takeIf { it.isNotBlank() }
        } ?: return null
        return ConversationDraftScope(
            organizationId = space.organizationId,
            workspaceId = workspaceId,
            projectId = space.id.takeIf { space.isProject },
        ).takeIf { it.isValid() }
    }

    private fun selectDraftAgent(agentId: String) {
        if (!draftMode || currentSessionId != null || firstSendInFlight) return
        val normalized = agentId.trim().takeIf { it.isNotEmpty() } ?: return
        draftAgentId = normalized
        rememberExecutionAgentId(normalized)
    }

    /**
     * ：无本地 dirty 时以服务端 `agent_mode` 为准（跨端同步）；
     * 服务端空/空白（DB 默认未设置）保持本地偏好，对齐 iOS `applyServerAgentMode`。
     * 审批档仍在「尚无本地偏好」时采用服务端，避免 stale GET 盖掉 in-flight 审批选择。
     * 短 dirty 窗口保护刚切换、尚未 PUT 成功的工作方式。
     */
    private fun applyServerRuntimeConfiguration(
        sessionId: String,
        rawAgentMode: String?,
        rawApprovalMode: String?,
    ) {
        if (currentSessionId != sessionId) return
        val serverAgentModeWire = rawAgentMode?.trim()?.takeIf { it.isNotEmpty() }
        val serverConfig = ConversationRuntimeConfiguration.normalizedForStorage(
            rawAgentMode = serverAgentModeWire,
            rawApprovalMode = rawApprovalMode,
        )
        val agentMode = when {
            hasAgentModeLocalDirty() -> requestedRuntimeConfiguration.agentMode
            // 空值不得经 resolve 落成默认 AGENT，否则会盖掉本地 plan/ask 等偏好。
            serverAgentModeWire == null -> requestedRuntimeConfiguration.agentMode
            else -> serverConfig.agentMode
        }
        val approvalMode = if (hasStoredRuntimeConfiguration) {
            requestedRuntimeConfiguration.approvalMode
        } else {
            serverConfig.approvalMode
        }
        val next = ConversationRuntimeConfiguration(
            agentMode = agentMode,
            approvalMode = approvalMode,
        )
        if (next == requestedRuntimeConfiguration) {
            // Still refresh UI projection (organization clamp may have changed).
            _uiState.update { state ->
                state.copy(
                    runtimeConfiguration = resolveRuntimeConfiguration(state.permitsRelaxedApproval),
                )
            }
            return
        }
        requestedRuntimeConfiguration = next
        if (!hasAgentModeLocalDirty()) {
            runtimeConfigurationStore.save(sessionId, requestedRuntimeConfiguration)
            hasStoredRuntimeConfiguration = runtimeConfigurationStore.load(sessionId) != null
        }
        _uiState.update { state ->
            state.copy(
                runtimeConfiguration = resolveRuntimeConfiguration(state.permitsRelaxedApproval),
            )
        }
    }

    private fun markAgentModeLocalDirty() {
        agentModeLocalDirtyUntilElapsedMs =
            android.os.SystemClock.elapsedRealtime() + AGENT_MODE_LOCAL_DIRTY_WINDOW_MS
    }

    private fun clearAgentModeLocalDirty() {
        agentModeLocalDirtyUntilElapsedMs = 0L
    }

    private fun hasAgentModeLocalDirty(): Boolean =
        android.os.SystemClock.elapsedRealtime() < agentModeLocalDirtyUntilElapsedMs

    private fun restoreRuntimeConfiguration(sessionId: String) {
        val stored = runtimeConfigurationStore.load(sessionId)
        requestedRuntimeConfiguration = stored ?: ConversationRuntimeConfiguration()
        hasStoredRuntimeConfiguration = stored != null
    }

    private fun resolveRuntimeConfiguration(
        permitsRelaxedApproval: Boolean = _uiState.value.permitsRelaxedApproval,
        rawAgentMode: String? = requestedRuntimeConfiguration.agentMode.wireValue,
        rawApprovalMode: String? = requestedRuntimeConfiguration.approvalMode.wireValue,
    ): ConversationRuntimeConfiguration = ConversationRuntimeConfiguration.resolving(
        rawAgentMode = rawAgentMode,
        rawApprovalMode = rawApprovalMode,
        permitsRelaxedApproval = permitsRelaxedApproval,
    )

    private fun persistRuntimeConfiguration() {
        val sessionId = currentSessionId ?: return
        runtimeConfigurationStore.save(sessionId, requestedRuntimeConfiguration)
        hasStoredRuntimeConfiguration = true
    }

    private fun applyAuthoritativeRunState(
        sessionId: String,
        runState: SessionRunState,
        sessionRequestedPause: Boolean = false,
    ) {
        if (currentSessionId != sessionId) return
        _uiState.update {
            val pause = pauseControlAfterRunState(
                runStatus = runState.status,
                currentlyPending = it.isPauseControlPending,
                sessionRequestedPause = sessionRequestedPause,
            )
            it.copy(
                runState = runState,
                isPaused = pause.isPaused,
                isPauseControlPending = pause.isPauseControlPending,
                isCancelControlPending = runState.status == SessionRunStatus.CANCELLING,
            )
        }
        if (runState.isTerminal) {
            settleRunControls()
            scheduleReadAckAfterContentReconcile(sessionId)
        }
    }

    private fun applyAuthoritativeReadState(sessionId: String, readState: SessionReadState) {
        if (currentSessionId != sessionId) return
        _uiState.update { it.copy(readState = readState) }
        if (readState.hasUnreadReply) scheduleReadAckAfterContentReconcile(sessionId)
    }

    /** 内容先经 HTTP 历史对账，再用服务端游标 ACK；避免把尚未展示的回复误标已读。 */
    /**
     * R2-6：对话面板不可见时（工作台 / app-focus）不得推进已读水位，
     * 否则约 600ms 后 complete 胶囊会退回圆圈。
     */
    @Volatile
    private var conversationContentVisible: Boolean = true

    public fun setConversationContentVisible(visible: Boolean) {
        val wasVisible = conversationContentVisible
        conversationContentVisible = visible
        if (visible && !wasVisible) {
            val sid = currentSessionId
            if (!sid.isNullOrBlank()) {
                scheduleReadAckAfterContentReconcile(sid)
            }
        }
    }

    private fun acknowledgeReadIfContentHydrated(sessionId: String) {
        val state = _uiState.value
        if (
            !conversationContentVisible ||
            currentSessionId != sessionId ||
            subscriptionReadySessionId != sessionId ||
            historyHydratedSessionId != sessionId ||
            state.isStreaming ||
            state.messages.any { it.isStreaming }
        ) {
            return
        }
        val candidate = state.readState?.pendingAck(
            sessionId = sessionId,
            mutationId = UUID.randomUUID().toString(),
        ) ?: return
        viewModelScope.launch { sessionReadAckStore.acknowledgeContentDisplayed(candidate) }
    }

    /** 终态事件可早于 assistant 落库；延后一次权威历史对账后才允许推进阅读水位。 */
    private fun scheduleReadAckAfterContentReconcile(sessionId: String) {
        readAckJob?.cancel()
        readAckJob = viewModelScope.launch {
            delay(600L)
            val generation = sessionLoadGeneration
            if (
                !conversationContentVisible ||
                !canReplaceMessagesFromHistory(sessionId, generation)
            ) {
                return@launch
            }
            runCatching {
                chatRepository.getMessages(
                    sessionId = sessionId,
                    preferIncremental = false,
                    preserveCacheOnEmpty = true,
                    advanceWatermark = false,
                )
            }.onSuccess { result ->
                if (
                    !conversationContentVisible ||
                    !canReplaceMessagesFromHistory(sessionId, generation)
                ) {
                    return@onSuccess
                }
                if (result.messages.isNotEmpty()) {
                    val changed = applyHistoryResult(result) {
                        projector.replaceWithHistory(result.messages)
                    }
                    if (changed) publishProjector { it.copy(hasMore = result.hasMore) }
                }
                historyHydratedSessionId = sessionId
                acknowledgeReadIfContentHydrated(sessionId)
            }
        }
    }

    private fun StreamEvent.isTerminalRunEvent(): Boolean =
        this is StreamEvent.Done || this is StreamEvent.Error || this is StreamEvent.RunCompletedInBackground

    /** Terminal events are authoritative: no late control ACK may revive a finished run. */
    private fun settleRunControls() {
        invalidateRunControlRequests()
        _uiState.update {
            it.copy(
                isPaused = false,
                isPauseControlPending = false,
                isCancelControlPending = false,
            )
        }
    }

    private fun clearMySendTracking() {
        sendWatchdogJob?.cancel()
        sendWatchdogJob = null
        myTaskId = null
        receivedSinceSend = false
    }

    private fun startSendWatchdog() {
        sendWatchdogJob?.cancel()
        sendWatchdogJob = viewModelScope.launch {
            delay(SEND_WATCHDOG_TIMEOUT_MS)
            if (receivedSinceSend || !projector.hasPendingOptimistic) return@launch
            val timeoutMessage = context.getString(R.string.error_agent_timeout)
            projector.failPendingOptimistic(timeoutMessage)
            publishProjector {
                it.copy(
                    isSending = false,
                    errorMessage = timeoutMessage,
                )
            }
            clearMySendTracking()
        }
    }

    private fun endStreamingState() {
        cancelPendingProjectorPublish()
        projector.endStreaming()
        blockProjector.reset()
        publishProjector {
            it.copy(
            isSending = false,
            currentPhase = AgentPhase.IDLE,
            currentToolName = null,
            )
        }
        sendWatchdogJob?.cancel()
        sendWatchdogJob = null
        activeAssistantId = null
        pendingOptimisticAssistantId = null
        assistantIdsByServerMessageId.clear()
        drainOutgoingQueueIfPossible()
    }

    private fun ensureActiveAssistantMessage(sessionId: String): String {
        @Suppress("UNUSED_VARIABLE")
        val unusedSessionId = sessionId
        val existing = activeAssistantId
        if (existing != null && projector.messages.any { it.id == existing }) return existing
        return createAssistantMessage()
    }

    public fun loadMore() {
        val sessionId = currentSessionId ?: return
        if (_uiState.value.isLoadingMore || !_uiState.value.hasMore) return
        val oldestId = projector.oldestServerId ?: _uiState.value.messages.firstOrNull()?.effectiveId ?: return
        val generation = sessionLoadGeneration

        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoadingMore = true)
            try {
                val result = chatRepository.loadMoreMessages(sessionId, oldestId)
                if (canApplyHistory(sessionId, generation, allowWhileStreaming = true)) {
                    applyHistoryResult(result) {
                        projector.prependHistory(result.messages) > 0
                    }
                    publishProjector {
                        it.copy(
                        isLoadingMore = false,
                        hasMore = result.hasMore,
                        )
                    }
                }
            } catch (e: Exception) {
                if (canApplyHistory(sessionId, generation, allowWhileStreaming = true)) {
                    _uiState.value = _uiState.value.copy(
                        isLoadingMore = false,
                        errorMessage = errorMessage(e),
                    )
                }
            }
        }
    }

    /**
     * 定位通知携带的持久化消息。即使本地缓存存在，也用 around 向服务端确认消息仍存在
     * 且当前用户可访问；请求次数不随消息年代增长。返回 LazyColumn 实际使用的 row id。
     */
    public suspend fun focusMessage(sessionId: String, messageId: String): String? {
        if (messageId.isBlank()) return null
        _uiState.first { currentSessionId == sessionId && !it.isLoading }
        val generation = sessionLoadGeneration
        if (!canReplaceMessagesFromHistory(sessionId, generation)) return null
        return try {
            val result = chatRepository.getMessagesAround(sessionId, messageId)
            if (!canReplaceMessagesFromHistory(sessionId, generation)) return null
            if (result.messages.none { messageId in it.identityKeys }) return null
            applyHistoryResult(result) {
                projector.replaceWithFocusedHistory(result.messages)
            }
            publishProjector { state ->
                state.copy(
                    isLoading = false,
                    isLoadingMore = false,
                    hasMore = result.hasMore,
                )
            }
            projector.messages.firstOrNull { messageId in it.identityKeys }?.id
        } catch (e: Exception) {
            Log.w(TAG, "focus message failed message=${messageId.redactedId()}", e)
            null
        }
    }

    /**
     * 由 ChatSessionScreen 同步当前 Workbench Focus，供 Composer 入队冻结。
     * 与胶囊 PTT 共用同一 [TaskFocusSnapshot] 投影源。
     */
    public fun updateWorkbenchFocus(spaceId: String?, target: WorkbenchFocusTarget?) {
        workbenchFocusSpaceId = spaceId?.takeIf { it.isNotBlank() }
        workbenchFocusTarget = target
    }

    public fun sendMessage(
        content: String,
        blocks: List<MessageBlock>? = null,
        onPersisted: (() -> Unit)? = null,
        onFailed: (() -> Unit)? = null,
    ) {
        sendMessage(
            ConversationSendRequest(
                content = content,
                blocks = blocks,
                attachmentPolicy = AttachmentPolicy.INCLUDE_COMPOSER,
            ),
            onPersisted = onPersisted,
            onFailed = onFailed,
        )
    }

    /**
     * 统一发送入口。胶囊语音走 [AttachmentPolicy.NONE] + 冻结 Focus，
     * 不读/不清 Composer 草稿附件引用。
     * Composer / [sendWithReferences] 未显式带 Focus 时，入队瞬间投影当前 Workbench。
     *
     * 草稿态（[draftMode] 且尚无 session）：首发走 prepareSession → loadSession →
     * enqueuePendingDraftIfPresent，正文只经 draft store 入队一次，避免双发。
     */
    public fun sendMessage(
        request: ConversationSendRequest,
        onPersisted: (() -> Unit)? = null,
        onFailed: (() -> Unit)? = null,
    ) {
        if (tokenManager.accessToken.isNullOrBlank()) {
            _uiState.value = _uiState.value.copy(errorMessage = AppError.NotLoggedIn.toUserMessage(context))
            onFailed?.invoke()
            return
        }

        if (_uiState.value.billingBlocked) {
            _uiState.value = _uiState.value.copy(
                errorMessage = context.getString(R.string.chat_billing_blocked_hint)
            )
            onFailed?.invoke()
            return
        }

        if (_uiState.value.memberLimitBlocked) {
            val reason = _uiState.value.memberLimitReason
            val msgRes = if (reason == "member_daily_limit")
                R.string.chat_billing_member_daily_limit
            else
                R.string.chat_billing_member_monthly_limit
            _uiState.value = _uiState.value.copy(errorMessage = context.getString(msgRes))
            onFailed?.invoke()
            return
        }

        val includeComposer = request.attachmentPolicy == AttachmentPolicy.INCLUDE_COMPOSER
        if (includeComposer) {
            val hasPendingUploads = attachmentManager.isUploading ||
                attachmentManager.attachments.value.any { it.status == AttachmentStatus.PENDING }
            if (hasPendingUploads) {
                _uiState.value = _uiState.value.copy(errorMessage = AppError.WaitUpload.toUserMessage(context))
                onFailed?.invoke()
                return
            }
        }

        val hasErrorAttachments = includeComposer &&
            attachmentManager.attachments.value.any { it.status == AttachmentStatus.ERROR }
        val sentAttachmentIds = if (includeComposer) {
            attachmentManager.attachments.value
                .filter { it.status == AttachmentStatus.READY }
                .map { it.id }
                .toSet()
        } else {
            emptySet()
        }
        val attachmentBlocks = if (includeComposer) attachmentManager.buildBlocks() else emptyList()
        val allBlocks = (request.blocks.orEmpty() + attachmentBlocks).takeIf { it.isNotEmpty() }

        if (request.content.isBlank() && allBlocks.isNullOrEmpty()) {
            if (hasErrorAttachments) {
                _uiState.value = _uiState.value.copy(errorMessage = AppError.AllAttachmentsFailed.toUserMessage(context))
            }
            onFailed?.invoke()
            return
        }

        val attachmentModel = _uiState.value.currentModel
            ?.takeIf(LlmModel::isSendableChatModel)
            ?: _uiState.value.availableModels.firstOrNull(LlmModel::isSendableChatModel)
        val readyAttachmentTypes = if (includeComposer) {
            attachmentManager.attachments.value
                .filter { it.status == AttachmentStatus.READY }
                .map { it.type }
        } else {
            emptyList()
        }
        if (ComposerSendControlPolicy.hasUnsupportedDocumentAttachment(
                attachmentTypes = readyAttachmentTypes,
                supportsDocumentInput = attachmentModel?.supportsDocumentInput == true,
            )
        ) {
            _uiState.value = _uiState.value.copy(
                errorMessage = context.getString(R.string.chat_document_input_not_supported),
            )
            onFailed?.invoke()
            return
        }

        val sessionId = currentSessionId
        if (sessionId == null) {
            sendDraftFirstMessage(
                request = request,
                allBlocks = allBlocks,
                includeComposer = includeComposer,
                sentAttachmentIds = sentAttachmentIds,
                onPersisted = onPersisted,
                onFailed = onFailed,
            )
            return
        }

        // 入队瞬间冻结；显式 request.focus（胶囊）优先，否则投影当前 Workbench。
        val frozenFocus = ComposerFocusFreeze.resolveForEnqueue(
            requestFocus = request.focus,
            spaceId = workbenchFocusSpaceId,
            target = workbenchFocusTarget,
        )

        viewModelScope.launch {
            val runtimeConfiguration = resolveRuntimeConfiguration()
            val modelId = resolveSendableChatModelId()
            if (currentSessionId != sessionId) {
                onFailed?.invoke()
                return@launch
            }
            if (modelId.isNullOrBlank()) {
                _uiState.value = _uiState.value.copy(
                    errorMessage = context.getString(R.string.chat_model_unavailable),
                )
                onFailed?.invoke()
                return@launch
            }
            try {
                enqueueOutgoingMessage(
                    sessionId = sessionId,
                    content = request.content,
                    blocks = allBlocks,
                    modelId = modelId,
                    runtimeConfiguration = runtimeConfiguration,
                    status = QueuedOutgoingMessageStatus.WAITING,
                    focus = frozenFocus,
                )
                if (includeComposer) {
                    attachmentManager.removeAttachments(sentAttachmentIds, deactivateUploaded = false)
                }
                onPersisted?.invoke()
                Log.i(
                    TAG,
                    "outgoing queued session=${sessionId.redactedId()} blocks=${allBlocks?.size ?: 0} " +
                        "focus=${frozenFocus.appType ?: "none"} status=waiting",
                )
                drainOutgoingQueueIfPossible()
            } catch (error: Exception) {
                Log.e(TAG, "outgoing queue persist failed session=${sessionId.redactedId()} status=failed", error)
                _uiState.value = _uiState.value.copy(
                    errorMessage = context.getString(R.string.error_send_failed),
                )
                onFailed?.invoke()
            }
        }
    }

    /**
     * 草稿首发：prepareSession 把正文写入 draft（含 pendingSessionId）→ loadSession →
     * enqueuePendingDraftIfPresent。不在此处再 enqueueOutgoingMessage，避免同一条双发。
     */
    private fun sendDraftFirstMessage(
        request: ConversationSendRequest,
        allBlocks: List<MessageBlock>?,
        includeComposer: Boolean,
        sentAttachmentIds: Set<String>,
        onPersisted: (() -> Unit)?,
        onFailed: (() -> Unit)?,
    ) {
        if (!draftMode) {
            _uiState.value = _uiState.value.copy(
                errorMessage = AppError.SessionNotLoaded.toUserMessage(context),
            )
            onFailed?.invoke()
            return
        }
        if (!beginFirstSend()) {
            onFailed?.invoke()
            return
        }

        viewModelScope.launch {
            try {
                _uiState.update { it.copy(isSending = true, errorMessage = null) }
                val space = draftExecutionSpace
                if (space == null) {
                    _uiState.update {
                        it.copy(
                            isSending = false,
                            errorMessage = context.getString(R.string.error_send_failed),
                        )
                    }
                    onFailed?.invoke()
                    return@launch
                }
                val agentId = draftAgentId?.takeIf { it.isNotBlank() }
                    ?: executionAgentId?.takeIf { it.isNotBlank() }
                if (agentId.isNullOrBlank()) {
                    _uiState.update {
                        it.copy(
                            isSending = false,
                            errorMessage = context.getString(R.string.error_send_failed),
                        )
                    }
                    onFailed?.invoke()
                    return@launch
                }
                val scope = draftPersistenceScope?.takeIf { it.isValid() }
                    ?: draftScopeFromSpace(space)
                if (scope == null) {
                    _uiState.update {
                        it.copy(
                            isSending = false,
                            errorMessage = context.getString(R.string.error_send_failed),
                        )
                    }
                    onFailed?.invoke()
                    return@launch
                }

                val runtimeConfiguration = resolveRuntimeConfiguration()
                val modelId = _uiState.value.currentModel
                    ?.takeIf(LlmModel::isSendableChatModel)
                    ?.id
                val prepared = draftSessionCoordinator.prepareSession(
                    executionSpace = space,
                    input = ConversationDraftInput(
                        scope = scope,
                        agentId = agentId,
                        text = request.content,
                        modelId = modelId,
                        runtimeConfiguration = runtimeConfiguration,
                        contextTierId = _uiState.value.contextTierId,
                        thinkingMode = _uiState.value.thinkingMode,
                        blocks = allBlocks.orEmpty(),
                    ),
                )

                // Session 已有稳定身份；退出草稿后再 load，避免 Compose 重绑打回草稿。
                draftMode = false
                val newSessionId = prepared.session.id
                loadSession(newSessionId, spaceId = scope.workspaceId)
                val enqueued = enqueuePendingDraftIfPresent(newSessionId)
                if (enqueued) {
                    if (includeComposer) {
                        attachmentManager.removeAttachments(
                            sentAttachmentIds,
                            deactivateUploaded = false,
                        )
                    }
                    onPersisted?.invoke()
                    Log.i(
                        TAG,
                        "draft first-send enqueued session=${newSessionId.redactedId()} " +
                            "blocks=${allBlocks?.size ?: 0}",
                    )
                } else {
                    onFailed?.invoke()
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.e(TAG, "draft first-send prepareSession failed", error)
                // 仅在尚未拿到 Session 时留在草稿，可重试；不崩溃。
                if (currentSessionId == null) {
                    draftMode = true
                }
                _uiState.update {
                    it.copy(
                        isSending = false,
                        errorMessage = error.message?.takeIf { msg -> msg.isNotBlank() }
                            ?: context.getString(R.string.error_send_failed),
                    )
                }
                onFailed?.invoke()
            } finally {
                finishFirstSend()
            }
        }
    }

    /** HITL / paused / 计费阻断入队与自动排空（忙碌允许排队）。对齐 iOS enqueueBlockReason。 */
    public fun enqueueBlockReason(): String? {
        return when (OutgoingEnqueueBlockPolicy.evaluate(currentEnqueueBlockInput())) {
            OutgoingEnqueueBlock.HITL -> context.getString(R.string.agent_capsule_blocked_hitl)
            OutgoingEnqueueBlock.PAUSED -> context.getString(R.string.agent_capsule_blocked_paused)
            OutgoingEnqueueBlock.BILLING -> context.getString(R.string.chat_billing_blocked_hint)
            null -> null
        }
    }

    private fun currentEnqueueBlockInput(): OutgoingEnqueueBlockInput {
        val state = _uiState.value
        return OutgoingEnqueueBlockInput(
            pendingApproval = state.pendingRequestApproval != null ||
                state.pendingApproval != null ||
                state.pendingReview != null ||
                state.pendingPlanApproval != null,
            pendingAnswer = state.pendingAskUser != null || state.pendingAskForm != null,
            paused = state.isPaused,
            billingBlocked = state.billingBlocked,
            memberLimitBlocked = state.memberLimitBlocked,
        )
    }

    /** 胶囊语音专用：HITL/paused/计费/模型缺失阻断并保留 transcript；busy 只排队。 */
    public fun sendCapsuleVoice(
        submission: CapsuleVoiceSubmission,
        onResult: ((receipt: QueuedSendReceipt) -> Unit)? = null,
    ) {
        val state = _uiState.value
        val gate = CapsuleVoiceResultPolicy.evaluateGate(
            CapsuleVoiceGateInput(
                sessionPresent = currentSessionId != null,
                modelPresent = !state.currentModel?.id.isNullOrBlank() ||
                    !state.availableModels.isEmpty(),
                billingBlocked = state.billingBlocked,
                memberLimitBlocked = state.memberLimitBlocked,
                pendingApproval = state.pendingRequestApproval != null ||
                    state.pendingApproval != null ||
                    state.pendingReview != null ||
                    state.pendingPlanApproval != null,
                pendingAnswer = state.pendingAskUser != null || state.pendingAskForm != null,
                paused = state.isPaused,
                busy = state.isStreaming || state.isSending,
            ),
        )
        if (gate != CapsuleVoiceGate.ALLOW_QUEUE) {
            val receipt = QueuedSendReceipt.Blocked(gate)
            _voiceSendReceipts.tryEmit(receipt)
            onResult?.invoke(receipt)
            return
        }
        val sessionId = currentSessionId ?: run {
            val receipt = QueuedSendReceipt.Blocked(CapsuleVoiceGate.BLOCK_SESSION_MISSING)
            onResult?.invoke(receipt)
            return
        }
        val wasBusy = state.isStreaming || state.isSending || sendingOutgoing || projector.isStreamingActive
        viewModelScope.launch {
            val runtimeConfiguration = resolveRuntimeConfiguration()
            val modelId = resolveSendableChatModelId()
            if (currentSessionId != sessionId) return@launch
            if (modelId.isNullOrBlank()) {
                val receipt = QueuedSendReceipt.Blocked(CapsuleVoiceGate.BLOCK_MODEL_MISSING)
                _voiceSendReceipts.tryEmit(receipt)
                onResult?.invoke(receipt)
                return@launch
            }
            // 入队前再验一次 HITL/paused/计费（对齐 iOS）
            if (enqueueBlockReason() != null) {
                val blockedGate = CapsuleVoiceResultPolicy.evaluateGate(
                    CapsuleVoiceGateInput(
                        sessionPresent = true,
                        modelPresent = true,
                        billingBlocked = _uiState.value.billingBlocked,
                        memberLimitBlocked = _uiState.value.memberLimitBlocked,
                        pendingApproval = currentEnqueueBlockInput().pendingApproval,
                        pendingAnswer = currentEnqueueBlockInput().pendingAnswer,
                        paused = _uiState.value.isPaused,
                    ),
                )
                val receipt = QueuedSendReceipt.Blocked(blockedGate)
                _voiceSendReceipts.tryEmit(receipt)
                onResult?.invoke(receipt)
                return@launch
            }
            try {
                val queued = enqueueOutgoingMessage(
                    sessionId = sessionId,
                    content = submission.transcript,
                    blocks = null,
                    modelId = modelId,
                    runtimeConfiguration = runtimeConfiguration,
                    status = QueuedOutgoingMessageStatus.WAITING,
                    focus = submission.frozenFocus,
                )
                pendingVoiceQueueId = queued.id
                val receipt = if (wasBusy) {
                    QueuedSendReceipt.Queued(queued.id)
                } else {
                    QueuedSendReceipt.Persisted(queued.id)
                }
                _voiceSendReceipts.tryEmit(receipt)
                onResult?.invoke(receipt)
                drainOutgoingQueueIfPossible()
            } catch (error: Exception) {
                Log.e(TAG, "capsule voice queue persist failed", error)
                val receipt = QueuedSendReceipt.Failed(
                    context.getString(R.string.error_send_failed),
                )
                _voiceSendReceipts.tryEmit(receipt)
                onResult?.invoke(receipt)
            }
        }
    }

    private fun emitVoiceAcceptedIfPending(queueId: String) {
        if (pendingVoiceQueueId != queueId) return
        pendingVoiceQueueId = null
        _voiceSendReceipts.tryEmit(QueuedSendReceipt.Accepted(queueId))
    }

    private fun startOutgoingStream(
        sessionId: String,
        content: String,
        allBlocks: List<MessageBlock>?,
        modelId: String,
        runtimeConfiguration: ConversationRuntimeConfiguration,
        queuedMessageId: String,
        clientEventId: String,
        focus: ConversationFocusContext? = null,
    ) {
        // 新一轮发送开启前结束撤回丢弃窗与对账豁免，避免误吞/误滤新 run。
        clearWithdrawnTurnDiscard()
        clearWithdrawReconcileExemption()
        val userMsg = projector.appendUserMessage(clientEventId, content, allBlocks)
        val assistantId = if (!projector.isStreamingActive) {
            projector.beginAssistant(
                id = "streaming-${System.currentTimeMillis()}",
                agentId = optimisticExecutionAgentId(),
            )
        } else {
            null
        }
        activeAssistantId = assistantId ?: activeAssistantId
        pendingOptimisticAssistantId = assistantId
        receivedSinceSend = false
        myTaskId = null
        hitlSubmissionOwnership.clear()

        publishProjector {
            it.copy(
            isSending = true,
            errorMessage = null,
            currentPhase = AgentPhase.IDLE,
            agentTodos = TodoHistoryRehydration.retainForNextTurn(it.agentTodos),
            pendingAskUser = null,
            pendingAskForm = null,
            pendingRequestApproval = null,
            pendingReview = null,
            pendingPlanApproval = null,
            pendingApproval = null,
            hitlSubmitting = false,
            )
        }
        chatRepository.cacheAppend(sessionId, userMsg)

        streamJob = viewModelScope.launch {
            markQueuedMessage(queuedMessageId, QueuedOutgoingMessageStatus.SENDING)
            val ack = streamManager.sendMessage(
                sessionId = sessionId,
                message = content,
                blocks = allBlocks,
                modelId = modelId,
                runtimeConfiguration = runtimeConfiguration,
                clientEventId = clientEventId,
                focus = focus,
            )
            when (ack) {
                is AckResult.Ok -> {
                    val ackTaskId = ack.payload.stringValue("task_id")
                    val ackMessageId = ack.payload.stringValue("message_id")
                    val ackClientEventId = resolveAcknowledgedClientEventId(
                        stableClientEventId = clientEventId,
                        acknowledgedClientEventId = ack.payload.stringValue("client_event_id"),
                    )
                    outgoingQueueRepository.recordAcknowledgement(
                        id = queuedMessageId,
                        status = QueuedOutgoingMessageStatus.ACCEPTED,
                        clientEventId = ackClientEventId,
                        serverMessageId = ackMessageId,
                        taskId = ackTaskId,
                    )
                    Log.i(
                        TAG,
                        "outgoing ack session=${sessionId.redactedId()} client=${ackClientEventId.redactedId()} " +
                            "message=${ackMessageId.redactedId()} task=${ackTaskId.redactedId()} status=accepted",
                    )
                    sendingOutgoing = false
                    flushingQueueItemIds.remove(queuedMessageId)
                    emitVoiceAcceptedIfPending(queuedMessageId)
                    if (currentSessionId == sessionId) {
                        myTaskId = ackTaskId
                        _uiState.value = _uiState.value.copy(isSending = false)
                        if (ackTaskId == null) {
                            projector.removeAssistantMessage(assistantId)
                            publishProjector { it.copy(isSending = false) }
                            clearMySendTracking()
                            drainOutgoingQueueIfPossible()
                        } else {
                            startSendWatchdog()
                        }
                        reloadOutgoingQueue(sessionId)
                    }
                    scheduleOutgoingReconciliation(
                        sessionId = sessionId,
                        queueId = queuedMessageId,
                        clientEventId = ackClientEventId,
                        serverMessageId = ackMessageId,
                    )
                }
                else -> {
                    val nak = ack as? AckResult.Nak
                    val persistedFailure = ack.isPersistedDeliveryFailure()
                    val awaitingDevice = !persistedFailure &&
                        nak?.delivery == "persisted" &&
                        OutgoingQueuePolicy.statusForAcknowledgedDelivery(
                            nak.delivery,
                            nak.executionState,
                        ) == QueuedOutgoingMessageStatus.AWAITING_DEVICE
                    val msg = when {
                        awaitingDevice -> nak.errorMessage.trim()
                        persistedFailure -> listOfNotNull(
                            nak?.errorMessage?.trim()?.takeIf { it.isNotBlank() },
                            context.getString(R.string.chat_message_persisted_execution_failed),
                        ).distinct().joinToString("\n")
                        else -> ackToAppError(ack).toUserMessage(context)
                    }
                    val status = when {
                        persistedFailure -> QueuedOutgoingMessageStatus.PERSISTED_EXECUTION_FAILED
                        awaitingDevice -> QueuedOutgoingMessageStatus.AWAITING_DEVICE
                        ack == AckResult.Disconnected ||
                            nak?.errorCode == "SUBSCRIPTION_DISCONNECTED" -> QueuedOutgoingMessageStatus.OFFLINE
                        else -> QueuedOutgoingMessageStatus.FAILED
                    }
                    outgoingQueueRepository.recordAcknowledgement(
                        id = queuedMessageId,
                        status = status,
                        clientEventId = resolveAcknowledgedClientEventId(
                            stableClientEventId = clientEventId,
                            acknowledgedClientEventId = nak?.clientEventId,
                        ),
                        serverMessageId = nak?.messageId,
                        taskId = null,
                        lastError = msg,
                        incrementAttempt = !awaitingDevice,
                    )
                    if (currentSessionId == sessionId) {
                        if (persistedFailure || awaitingDevice) {
                            projector.removeAssistantMessage(assistantId)
                        } else {
                            projector.removeLocalTurn(userMsg.id, assistantId)
                        }
                        publishProjector { it.copy(isSending = false) }
                        reloadOutgoingQueue(sessionId)
                    }
                    Log.w(
                        TAG,
                        "outgoing result session=${sessionId.redactedId()} client=${clientEventId.redactedId()} " +
                            "message=${nak?.messageId.redactedId()} status=${status.name.lowercase()} " +
                            "persisted=$persistedFailure code=${nak?.errorCode ?: "none"} " +
                            "category=${nak?.errorCategory ?: "none"} retryable=${nak?.retryable ?: false} " +
                            "detail=${nak?.errorMessage?.singleLineForLog() ?: "none"}",
                    )
                    sendingOutgoing = false
                    flushingQueueItemIds.remove(queuedMessageId)
                    activeAssistantId = null
                    pendingOptimisticAssistantId = null
                    clearMySendTracking()
                }
            }
        }
    }

    private fun ackToAppError(ack: AckResult): AppError = when (ack) {
        is AckResult.Nak -> {
            if (ack.errorCategory == "subscription") {
                when (ack.errorCode) {
                    "SUBSCRIPTION_TIMEOUT" -> AppError.SubscribeTimedOut
                    "SUBSCRIPTION_DISCONNECTED" -> AppError.SubscribeDisconnected
                    else -> AppError.SubscribeRejected(ack.errorCode, ack.errorMessage)
                }
            } else if (ack.errorCategory != null && ack.errorCategory in AppError.BillingBlocked.CATEGORIES) {
                AppError.BillingBlocked(ack.errorCategory, ack.errorCode, ack.errorMessage)
            } else {
                AppError.AgentExecution(
                    serverMessage = ack.errorMessage,
                    errorClass = ack.errorClass,
                    suggestedAction = ack.suggestedAction,
                    errorCategory = ack.errorCategory,
                    errorCode = ack.errorCode,
                )
            }
        }
        AckResult.Timeout -> AppError.AgentTimeout
        AckResult.Disconnected -> AppError.WsTimeout
        is AckResult.Ok -> AppError.SendFailed()
    }

    private fun reconcileAcceptedOutgoingMessages(sessionId: String) {
        _uiState.value.queuedOutgoingMessages
            .filter { it.isAwaitingExecutionConfirmation }
            .forEach { queued ->
                scheduleOutgoingReconciliation(
                    sessionId = sessionId,
                    queueId = queued.id,
                    clientEventId = queued.clientEventId,
                    serverMessageId = queued.serverMessageId,
                )
            }
    }

    /**
     * ACK means the gateway accepted the request, not that every realtime mirror arrived.
     * Reconcile with a bounded `around` query even while the optimistic stream guard is active;
     * the stable client_event_id makes every retry a lookup, never a new send.
     */
    private fun scheduleOutgoingReconciliation(
        sessionId: String,
        queueId: String,
        clientEventId: String,
        serverMessageId: String?,
    ) {
        if (outgoingReconcileJobs[queueId]?.isActive == true) return
        val generation = sessionLoadGeneration
        var job: Job? = null
        job = viewModelScope.launch {
            try {
                val identities = setOfNotNull(queueId, clientEventId, serverMessageId)
                    .filter { it.isNotBlank() }
                    .toSet()
                val around = serverMessageId?.takeIf { it.isNotBlank() } ?: clientEventId
                repeat(OUTGOING_RECONCILE_ATTEMPTS) { attempt ->
                    if (attempt > 0) delay(1_000L shl (attempt - 1))
                    val reconciliation = try {
                        chatRepository.reconcileMessageAround(sessionId, around, identities)
                    } catch (cancelled: CancellationException) {
                        // task_id/source_client_event_id completion cancels this poller; never downgrade
                        // that exact terminal fact into a request failure or an "unconfirmed" log.
                        throw cancelled
                    } catch (error: Exception) {
                        Log.w(
                            TAG,
                            "outgoing reconcile session=${sessionId.redactedId()} " +
                                "client=${clientEventId.redactedId()} attempt=${attempt + 1} status=request_failed " +
                                "error=${error.javaClass.simpleName}",
                        )
                        null
                    }
                    if (reconciliation != null) {
                        val confirmedIdentities = identities + reconciliation.matchedUser.identityKeys
                        when (reconciliation.evidence) {
                            OutgoingHistoryEvidence.EXECUTION_STARTED -> {
                                outgoingQueueRepository.completeExecution(sessionId, confirmedIdentities)
                            }
                            OutgoingHistoryEvidence.PERSISTED -> {
                                outgoingQueueRepository.markPersisted(sessionId, confirmedIdentities)
                            }
                            OutgoingHistoryEvidence.ABSENT -> Unit
                        }
                        if (canApplyHistory(sessionId, generation, allowWhileStreaming = true)) {
                            if (projector.mergeCommittedHistory(reconciliation.messages)) publishProjector()
                            reloadOutgoingQueue(sessionId)
                            drainOutgoingQueueIfPossible()
                        }
                        Log.i(
                            TAG,
                            "outgoing reconcile session=${sessionId.redactedId()} " +
                                "client=${clientEventId.redactedId()} message=${reconciliation.matchedUser.id.redactedId()} " +
                                "attempt=${attempt + 1} evidence=${reconciliation.evidence.name.lowercase()}",
                        )
                        if (shouldFinishOutgoingReconciliation(reconciliation.evidence)) {
                            return@launch
                        }
                    }
                }
                Log.w(
                    TAG,
                    "outgoing reconcile session=${sessionId.redactedId()} client=${clientEventId.redactedId()} " +
                        "attempts=$OUTGOING_RECONCILE_ATTEMPTS status=unconfirmed",
                )
            } finally {
                if (outgoingReconcileJobs[queueId] === job) outgoingReconcileJobs.remove(queueId)
            }
        }
        outgoingReconcileJobs[queueId] = job
    }

    private fun JsonObject.stringValue(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

    private fun String?.redactedId(): String = this?.takeIf { it.isNotBlank() }?.take(8) ?: "none"

    private fun String.singleLineForLog(): String =
        lineSequence().joinToString(" ") { it.trim() }

    private suspend fun reloadOutgoingQueue(sessionId: String? = currentSessionId) {
        sessionId ?: return
        if (currentSessionId != sessionId) return
        _uiState.value = _uiState.value.copy(
            queuedOutgoingMessages = outgoingQueueRepository.list(sessionId),
        )
    }

    private suspend fun enqueueOutgoingMessage(
        sessionId: String,
        content: String,
        blocks: List<MessageBlock>?,
        modelId: String?,
        runtimeConfiguration: ConversationRuntimeConfiguration,
        status: QueuedOutgoingMessageStatus,
        lastError: String? = null,
        clientEventId: String = UUID.randomUUID().toString(),
        focus: ConversationFocusContext? = null,
    ): QueuedOutgoingMessage {
        val queued = outgoingQueueRepository.enqueue(
            sessionId = sessionId,
            text = content,
            modelId = modelId,
            runtimeConfiguration = runtimeConfiguration,
            blocks = blocks,
            status = status,
            lastError = lastError,
            clientEventId = clientEventId,
            focus = focus,
        )
        reloadOutgoingQueue(sessionId)
        return queued
    }

    private suspend fun markQueuedMessage(
        id: String,
        status: QueuedOutgoingMessageStatus,
        lastError: String? = null,
        incrementAttempt: Boolean = false,
    ) {
        outgoingQueueRepository.updateStatus(id, status, lastError, incrementAttempt)
        reloadOutgoingQueue()
    }

    public fun removeQueuedMessage(id: String) {
        flushingQueueItemIds.remove(id)
        viewModelScope.launch {
            outgoingQueueRepository.dismissLocalRecord(id)
            reloadOutgoingQueue()
            drainOutgoingQueueIfPossible()
        }
    }

    public fun retryQueuedMessage(id: String) {
        viewModelScope.launch {
            val queued = _uiState.value.queuedOutgoingMessages.firstOrNull { it.id == id }
            when (queued?.status) {
                QueuedOutgoingMessageStatus.PERSISTED_EXECUTION_FAILED ->
                    outgoingQueueRepository.retryPersistedExecution(id)
                else -> outgoingQueueRepository.retryUnsent(id)
            }
            reloadOutgoingQueue()
            drainOutgoingQueueIfPossible()
        }
    }

    private fun drainOutgoingQueueIfPossible() {
        val sessionId = currentSessionId ?: return
        if (projector.isStreamingActive || _uiState.value.isStreaming || _uiState.value.isSending || sendingOutgoing) return
        // HITL / paused / 计费阻断自动排空；忙碌由 isStreaming 挡住，只排队。
        if (!OutgoingEnqueueBlockPolicy.canAutoDrain(currentEnqueueBlockInput())) return
        viewModelScope.launch {
            if (!OutgoingEnqueueBlockPolicy.canAutoDrain(currentEnqueueBlockInput())) return@launch
            reloadOutgoingQueue(sessionId)
            val item = _uiState.value.queuedOutgoingMessages
                .firstOrNull { it.isAutoDrainable && it.id !in flushingQueueItemIds }
                ?: return@launch
            flushingQueueItemIds.add(item.id)
            markQueuedMessage(item.id, QueuedOutgoingMessageStatus.SENDING)
            val modelId = item.modelId ?: resolveSendableChatModelId()
            if (modelId.isNullOrBlank()) {
                flushingQueueItemIds.remove(item.id)
                markQueuedMessage(
                    item.id,
                    QueuedOutgoingMessageStatus.FAILED,
                    lastError = context.getString(R.string.chat_model_unavailable),
                    incrementAttempt = true,
                )
                return@launch
            }
            if (projector.isStreamingActive || _uiState.value.isStreaming || _uiState.value.isSending || sendingOutgoing ||
                !OutgoingEnqueueBlockPolicy.canAutoDrain(currentEnqueueBlockInput())
            ) {
                flushingQueueItemIds.remove(item.id)
                markQueuedMessage(item.id, QueuedOutgoingMessageStatus.WAITING)
                return@launch
            }
            sendingOutgoing = true
            startOutgoingStream(
                sessionId = item.sessionId,
                content = item.text,
                allBlocks = item.blocks,
                modelId = modelId,
                runtimeConfiguration = item.resolvingRuntimeConfiguration(
                    permitsRelaxedApproval = _uiState.value.permitsRelaxedApproval,
                ),
                queuedMessageId = item.id,
                clientEventId = item.clientEventId,
                // 重试永远读取队列冻结 Focus，不读此刻 Workbench。
                focus = item.focus,
            )
        }
    }

    private suspend fun resolveSendableChatModelId(): String? {
        val sessionId = currentSessionId ?: return null
        if (currentSessionSnapshot == null) {
            runCatching { chatRepository.getSession(sessionId) }
                .onSuccess { session ->
                    if (currentSessionId == sessionId) applyServerSessionModel(sessionId, session)
                }
                .onFailure { error ->
                    Log.w(TAG, "session model snapshot unavailable session=${sessionId.redactedId()}", error)
                }
        }
        val session = currentSessionSnapshot ?: return null
        val organizationId = session.organizationId?.takeIf { it.isNotBlank() }
            ?: tokenManager.organizationId?.takeIf { it.isNotBlank() }
            ?: return null
        _uiState.value.currentModel?.takeIf(LlmModel::isSendableChatModel)?.let { return it.id }
        if (applyCachedChatCatalogSelection(organizationId)) {
            return _uiState.value.currentModel?.takeIf(LlmModel::isSendableChatModel)?.id
        }
        ensureChatCatalogLoad(
            organizationId = organizationId,
            expectedSessionId = sessionId,
            forceRefresh = false,
            exposeLoadingToComposer = false,
        ).join()
        return _uiState.value.currentModel?.takeIf(LlmModel::isSendableChatModel)?.id
            ?: _uiState.value.availableModels.firstOrNull(LlmModel::isSendableChatModel)?.id
    }

    private fun resolveChatCatalogOrganizationId(): String? =
        currentSessionSnapshot?.organizationId?.takeIf { it.isNotBlank() }
            ?: tokenManager.organizationId?.takeIf { it.isNotBlank() }

    private fun applyCachedChatCatalogSelection(organizationId: String): Boolean {
        val state = _uiState.value
        if (cachedModelOrganizationId != organizationId || state.availableModels.isEmpty()) return false
        _uiState.value = state.copy(
            currentModel = resolveConversationChatModel(
                session = currentSessionSnapshot,
                availableModels = state.availableModels,
                catalogDefaultModelId = cachedCatalogDefaultModelId,
            ),
            isLoadingModels = false,
        )
        return true
    }

    private fun cancelChatCatalogLoad() {
        chatCatalogLoadJob?.cancel()
        chatCatalogLoadJob = null
        chatCatalogLoadOrganizationId = null
        chatCatalogLoadExpectedSessionId = null
        chatCatalogLoadShowsComposerLoading = false
        chatCatalogLoadGeneration += 1
        // 抬代际后旧 Job 的 finally 不再清 UI；这里必须摘掉 Composer 转圈，
        // 否则若后续不再走 loadSession 的整表重建，模型选择会一直转。
        clearComposerModelLoading()
    }

    private fun clearComposerModelLoading() {
        _uiState.update { current ->
            if (current.isLoadingModels) current.copy(isLoadingModels = false) else current
        }
    }

    private fun isChatCatalogLoadStillValid(
        requestGeneration: Long,
        expectedSessionId: String?,
        organizationId: String,
    ): Boolean =
        shouldApplyChatCatalogLoadResult(
            requestGeneration = requestGeneration,
            currentGeneration = chatCatalogLoadGeneration,
            expectedSessionId = expectedSessionId,
            activeSessionId = currentSessionId,
            loadOrganizationId = chatCatalogLoadOrganizationId,
            organizationId = organizationId,
        )

    /**
     * 唯一 chat catalog 拉取入口。Composer 与发送路径共享同一 Job，避免重复请求互相 bump 代际。
     */
    private fun ensureChatCatalogLoad(
        organizationId: String,
        expectedSessionId: String?,
        forceRefresh: Boolean,
        exposeLoadingToComposer: Boolean,
    ): Job {
        val existing = chatCatalogLoadJob
        if (
            shouldShareInFlightChatCatalogLoad(
                forceRefresh = forceRefresh,
                jobActive = existing?.isActive == true,
                jobOrganizationId = chatCatalogLoadOrganizationId,
                jobExpectedSessionId = chatCatalogLoadExpectedSessionId,
                organizationId = organizationId,
                expectedSessionId = expectedSessionId,
            )
        ) {
            if (exposeLoadingToComposer) {
                // Composer 后挂到静默 Job 上时只改全局 flag；finally 必须无条件收口
                // isLoadingModels，不能只看 Job 创建时的 expose（当时可能是 false）。
                chatCatalogLoadShowsComposerLoading = true
                _uiState.update { current ->
                    if (current.isLoadingModels) current else current.copy(isLoadingModels = true, modelLoadFailed = false)
                }
            }
            return requireNotNull(existing) { "in-flight chat catalog job missing" }
        }

        existing?.cancel()
        chatCatalogLoadGeneration += 1
        val requestGeneration = chatCatalogLoadGeneration
        chatCatalogLoadOrganizationId = organizationId
        chatCatalogLoadExpectedSessionId = expectedSessionId
        chatCatalogLoadShowsComposerLoading = exposeLoadingToComposer
        if (exposeLoadingToComposer) {
            _uiState.update { current ->
                current.copy(isLoadingModels = true, modelLoadFailed = false)
            }
        } else {
            // 发送路径接管的静默刷新不应继承上一轮 Composer 转圈。
            clearComposerModelLoading()
        }

        val job = viewModelScope.launch {
            try {
                val catalog = llmRepository.getChatCatalog(organizationId)
                if (!isChatCatalogLoadStillValid(requestGeneration, expectedSessionId, organizationId)) return@launch
                applyChatCatalogLoadSuccess(
                    organizationId = organizationId,
                    sendableModels = catalog.models.filter { it.isSendableChatModel() },
                    catalogDefaultModelId = catalog.defaultModelId,
                )
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                if (!isChatCatalogLoadStillValid(requestGeneration, expectedSessionId, organizationId)) return@launch
                applyChatCatalogLoadFailure()
            } finally {
                if (requestGeneration == chatCatalogLoadGeneration) {
                    // 共享后可能已挂上转圈；结果过期跳过 apply 时也必须收口。
                    clearComposerModelLoading()
                    chatCatalogLoadJob = null
                    chatCatalogLoadShowsComposerLoading = false
                }
            }
        }
        chatCatalogLoadJob = job
        return job
    }

    private fun applyChatCatalogLoadSuccess(
        organizationId: String,
        sendableModels: List<LlmModel>,
        catalogDefaultModelId: String?,
    ) {
        val session = currentSessionSnapshot
        val selected = resolveConversationChatModel(
            session = session,
            availableModels = sendableModels,
            catalogDefaultModelId = catalogDefaultModelId,
        )
        cachedModelOrganizationId = organizationId
        cachedCatalogDefaultModelId = catalogDefaultModelId
        _uiState.update { current ->
            val runtimeProjection = if (selected != null && session != null) {
                projectModelRuntimeFromSession(
                    model = selected,
                    session = session,
                    preferLocal = hasLocalModelRuntimeIntent,
                    localContextTierId = current.contextTierId,
                    localThinkingMode = current.thinkingMode,
                )
            } else if (selected != null) {
                ModelRuntimeProjection(
                    contextTierId = resolveActiveContextTierId(selected, current.contextTierId),
                    thinkingMode = selected.catalogThinkingCapability()?.let { capability ->
                        resolveActiveThinkingMode(null, current.thinkingMode, capability)
                    },
                )
            } else {
                ModelRuntimeProjection(current.contextTierId, current.thinkingMode)
            }
            current.copy(
                availableModels = sendableModels,
                currentModel = selected,
                contextTierId = runtimeProjection.contextTierId,
                thinkingMode = runtimeProjection.thinkingMode,
                isLoadingModels = false,
                modelLoadFailed = resolveChatCatalogLoadFailed(
                    apiFailed = false,
                    sendableModelCount = sendableModels.size,
                ),
            )
        }
    }

    private fun applyChatCatalogLoadFailure() {
        _uiState.update { current ->
            current.copy(
                isLoadingModels = false,
                modelLoadFailed = true,
            )
        }
    }

    /**
     * 拉取 chat catalog 供 Composer 模型切换用。已有 Session 的服务端模型优先，
     * 组织默认模型只用于服务端 Session 没有可发送模型时的回退。
     */
    public fun loadChatModels(forceRefresh: Boolean = false) {
        val organizationId = resolveChatCatalogOrganizationId()
        if (organizationId == null) {
            // 无组织时不能开转圈等一个永远不会回来的请求。
            clearComposerModelLoading()
            return
        }
        if (!forceRefresh && applyCachedChatCatalogSelection(organizationId)) {
            clearComposerModelLoading()
            return
        }
        if (_uiState.value.isLoadingModels && !forceRefresh && chatCatalogLoadJob?.isActive == true) return
        if (_uiState.value.isLoadingModels && chatCatalogLoadJob?.isActive != true) {
            clearComposerModelLoading()
        }
        ensureChatCatalogLoad(
            organizationId = organizationId,
            expectedSessionId = currentSessionId,
            forceRefresh = forceRefresh,
            exposeLoadingToComposer = true,
        )
    }

    /** 成功 DONE 后只更新实际使用模型的点券投影，失败时保留既有目录。 */
    private fun refreshPromotionCreditAfterSettlement(modelId: String?) {
        val organizationId = currentSessionSnapshot?.organizationId?.takeIf { it.isNotBlank() }
            ?: tokenManager.organizationId?.takeIf { it.isNotBlank() }
            ?: return
        val state = _uiState.value
        if (
            state.isLoadingModels ||
            cachedModelOrganizationId != organizationId ||
            !shouldRefreshPromotionCredit(modelId, state.availableModels)
        ) return
        val expectedSessionId = currentSessionId
        promotionCreditRefreshGeneration += 1
        val requestGeneration = promotionCreditRefreshGeneration
        viewModelScope.launch {
            val catalog = runCatching { llmRepository.getChatCatalog(organizationId) }.getOrNull() ?: return@launch
            if (
                requestGeneration != promotionCreditRefreshGeneration ||
                expectedSessionId != currentSessionId ||
                cachedModelOrganizationId != organizationId
            ) return@launch
            val refreshed = catalog.models.firstOrNull { it.id == modelId } ?: return@launch
            _uiState.update { current ->
                val models = current.availableModels.map { model ->
                    if (model.id == modelId) model.copy(promotionCredit = refreshed.promotionCredit) else model
                }
                current.copy(
                    availableModels = models,
                    currentModel = models.firstOrNull { it.id == current.currentModel?.id } ?: current.currentModel,
                )
            }
        }
    }

    public fun selectChatModel(model: LlmModel) {
        val state = _uiState.value
        if (
            !ComposerModelSelectionPolicy.canSelect(
                isSending = state.isSending,
                isStreaming = state.isStreaming || state.messages.any { it.isStreaming },
                isPaused = state.isPaused,
                isSwitchingModel = state.isSwitchingModel,
            ) || !model.isSendableChatModel()
        ) return
        if (model.id == state.currentModel?.id) {
            // 同模型再点：按新模型能力重投影档位 / 思考，保持抽屉可继续进运行设置。
            val projection = reconcileRuntimeForModel(
                model = model,
                preferredTierId = state.contextTierId,
                preferredThinkingMode = state.thinkingMode,
            )
            _uiState.value = state.copy(
                currentModel = model,
                contextTierId = projection.contextTierId,
                thinkingMode = projection.thinkingMode,
                modelSwitchErrorMessage = null,
            )
            return
        }
        val preferredTierId = resolveActiveContextTierId(model, state.contextTierId)
        val preferredThinking = model.catalogThinkingCapability()?.let { capability ->
            resolveActiveThinkingMode(null, state.thinkingMode, capability)
        }
        val previousHasLocalModelRuntimeIntent = hasLocalModelRuntimeIntent
        hasLocalModelRuntimeIntent = true
        val sessionId = currentSessionId
        if (sessionId == null) {
            // 草稿态：只本地冻结，建 session / 首发后再写回。
            _uiState.value = state.copy(
                errorMessage = null,
                modelSwitchErrorMessage = null,
                currentModel = model,
                contextTierId = preferredTierId,
                thinkingMode = preferredThinking,
            )
            persistDraftModelRuntimeSettings(
                contextTierId = preferredTierId,
                thinkingMode = preferredThinking,
            )
            return
        }
        val generation = ++modelSwitchGeneration
        _uiState.value = state.copy(
            isSwitchingModel = true,
            errorMessage = null,
            modelSwitchErrorMessage = null,
            currentModel = model,
            contextTierId = preferredTierId,
            thinkingMode = preferredThinking,
        )
        viewModelScope.launch {
            try {
                val response = chatRepository.switchSessionModel(
                    sessionId = sessionId,
                    modelId = model.id,
                    contextTierId = preferredTierId?.takeIf { model.canSelectContextTier() },
                )
                if (currentSessionId != sessionId || generation != modelSwitchGeneration) return@launch
                val nextModel = state.availableModels.firstOrNull { it.id == response.currentModelId }
                    ?: model
                val nextTier = resolveActiveContextTierId(
                    nextModel,
                    response.contextTierId ?: preferredTierId,
                )
                val nextThinking = nextModel.catalogThinkingCapability()?.let { capability ->
                    resolveActiveThinkingMode(null, preferredThinking, capability)
                }
                currentSessionSnapshot = currentSessionSnapshot?.copy(
                    currentModelId = response.currentModelId,
                    currentModelName = response.currentModelName,
                    contextTierId = nextTier,
                ) ?: ChatSession(
                    id = sessionId,
                    organizationId = tokenManager.organizationId,
                    currentModelId = response.currentModelId,
                    currentModelName = response.currentModelName,
                    contextTierId = nextTier,
                )
                _uiState.update { current ->
                    current.copy(
                        currentModel = nextModel,
                        contextTierId = nextTier,
                        thinkingMode = nextThinking,
                        isSwitchingModel = false,
                        modelSwitchErrorMessage = null,
                    )
                }
                if (nextThinking != null) {
                    runCatching {
                        chatRepository.updateModelParams(
                            sessionId = sessionId,
                            thinkingMode = nextThinking,
                            preserving = currentSessionSnapshot?.modelParamOverrides,
                        )
                    }.onSuccess { responseParams ->
                        if (currentSessionId == sessionId && generation == modelSwitchGeneration) {
                            currentSessionSnapshot = currentSessionSnapshot?.copy(
                                modelParamOverrides = responseParams.modelParamOverrides
                                    ?: currentSessionSnapshot?.modelParamOverrides,
                            )
                        }
                    }.onFailure {
                        Log.w(TAG, "thinking mode write after model switch failed session=${sessionId.redactedId()}", it)
                    }
                }
            } catch (error: Exception) {
                if (currentSessionId == sessionId && generation == modelSwitchGeneration) {
                    hasLocalModelRuntimeIntent = previousHasLocalModelRuntimeIntent
                    val message = errorMessage(error).ifBlank {
                        context.getString(R.string.chat_model_switch_failed)
                    }
                    _uiState.update { current ->
                        current.rollbackFailedModelSwitch(
                            previousModel = state.currentModel,
                            previousContextTierId = state.contextTierId,
                            previousThinkingMode = state.thinkingMode,
                            message = message,
                        )
                    }
                }
            }
        }
    }

    /** 乐观更新当前会话的执行 Agent；失败时回滚。正在运行的轮次仍由服务端运行快照保持原 Agent。 */
    public fun switchSessionAgent(agentId: String) {
        val normalizedAgentId = agentId.trim().takeIf { it.isNotEmpty() } ?: return
        val sessionId = currentSessionId
        if (sessionId == null) {
            // 草稿态无 Session：只改本地 draftAgentId，首发时一并写入 prepareSession。
            selectDraftAgent(normalizedAgentId)
            return
        }
        val state = _uiState.value
        if (state.isSwitchingAgent) return
        val previousAgentId = executionAgentId ?: currentSessionSnapshot?.agentId
        if (normalizedAgentId == previousAgentId) return

        rememberExecutionAgentId(normalizedAgentId)
        _uiState.value = state.copy(
            isSwitchingAgent = true,
            executionAgentId = normalizedAgentId,
            errorMessage = null,
        )
        viewModelScope.launch {
            try {
                val updated = chatRepository.switchSessionAgent(sessionId, normalizedAgentId)
                if (currentSessionId != sessionId) return@launch
                currentSessionSnapshot = updated
                rememberExecutionAgentId(updated.agentId ?: normalizedAgentId)
                _uiState.update { current ->
                    current.copy(
                        isSwitchingAgent = false,
                        executionAgentId = updated.agentId ?: normalizedAgentId,
                    )
                }
            } catch (error: Exception) {
                if (currentSessionId != sessionId) return@launch
                rememberExecutionAgentId(previousAgentId)
                _uiState.update { current ->
                    current.copy(
                        isSwitchingAgent = false,
                        executionAgentId = previousAgentId,
                        errorMessage = errorMessage(error).ifBlank {
                            context.getString(R.string.error_send_failed)
                        },
                    )
                }
            }
        }
    }

    public fun selectContextTier(tierId: String) {
        val state = _uiState.value
        val model = state.currentModel ?: return
        if (!model.canSelectContextTier()) return
        val normalized = resolveActiveContextTierId(model, tierId) ?: return
        if (normalized == state.contextTierId) return
        hasLocalModelRuntimeIntent = true
        _uiState.value = state.copy(contextTierId = normalized, errorMessage = null)
        val sessionId = currentSessionId
        if (sessionId == null) {
            persistDraftModelRuntimeSettings(
                contextTierId = normalized,
                thinkingMode = state.thinkingMode,
            )
            return
        }
        val generation = ++modelRuntimeWriteGeneration
        viewModelScope.launch {
            try {
                val response = chatRepository.switchContextTier(sessionId, normalized)
                if (currentSessionId != sessionId || generation != modelRuntimeWriteGeneration) return@launch
                val confirmed = response.currentTierId ?: normalized
                currentSessionSnapshot = currentSessionSnapshot?.copy(contextTierId = confirmed)
                _uiState.update { it.copy(contextTierId = confirmed) }
            } catch (error: Exception) {
                if (currentSessionId == sessionId && generation == modelRuntimeWriteGeneration) {
                    _uiState.update {
                        it.copy(
                            errorMessage = errorMessage(error).ifBlank {
                                context.getString(R.string.error_send_failed)
                            },
                        )
                    }
                }
            }
        }
    }

    public fun selectThinkingMode(mode: String) {
        val state = _uiState.value
        val capability = state.currentModel?.catalogThinkingCapability() ?: return
        val normalized = mode.trim().lowercase()
        if (normalized !in capability.modes || normalized == state.thinkingMode) return
        hasLocalModelRuntimeIntent = true
        _uiState.value = state.copy(thinkingMode = normalized, errorMessage = null)
        val sessionId = currentSessionId
        if (sessionId == null) {
            persistDraftModelRuntimeSettings(
                contextTierId = state.contextTierId,
                thinkingMode = normalized,
            )
            return
        }
        val generation = ++modelRuntimeWriteGeneration
        viewModelScope.launch {
            try {
                val response = chatRepository.updateModelParams(
                    sessionId = sessionId,
                    thinkingMode = normalized,
                    preserving = currentSessionSnapshot?.modelParamOverrides,
                )
                if (currentSessionId != sessionId || generation != modelRuntimeWriteGeneration) return@launch
                currentSessionSnapshot = currentSessionSnapshot?.copy(
                    modelParamOverrides = response.modelParamOverrides
                        ?: currentSessionSnapshot?.modelParamOverrides,
                )
                _uiState.update { it.copy(thinkingMode = normalized) }
            } catch (error: Exception) {
                if (currentSessionId == sessionId && generation == modelRuntimeWriteGeneration) {
                    _uiState.update {
                        it.copy(
                            errorMessage = errorMessage(error).ifBlank {
                                context.getString(R.string.error_send_failed)
                            },
                        )
                    }
                }
            }
        }
    }

    private fun reconcileRuntimeForModel(
        model: LlmModel,
        preferredTierId: String?,
        preferredThinkingMode: String?,
    ): ModelRuntimeProjection = ModelRuntimeProjection(
        contextTierId = resolveActiveContextTierId(model, preferredTierId),
        thinkingMode = model.catalogThinkingCapability()?.let { capability ->
            resolveActiveThinkingMode(null, preferredThinkingMode, capability)
        },
    )

    public fun selectAgentMode(mode: String) {
        val resolved = ConversationAgentMode.resolve(mode)
        requestedRuntimeConfiguration = requestedRuntimeConfiguration.copy(
            agentMode = resolved,
        )
        persistRuntimeConfiguration()
        markAgentModeLocalDirty()
        _uiState.value = _uiState.value.copy(
            runtimeConfiguration = resolveRuntimeConfiguration(),
        )
        val sessionId = currentSessionId ?: return
        val generation = ++agentModeSyncGeneration
        viewModelScope.launch {
            try {
                val updated = chatRepository.updateSessionAgentMode(
                    sessionId,
                    resolved.wireValue,
                )
                if (currentSessionId != sessionId || generation != agentModeSyncGeneration) return@launch
                clearAgentModeLocalDirty()
                applyServerRuntimeConfiguration(
                    sessionId = sessionId,
                    rawAgentMode = updated.agentMode,
                    rawApprovalMode = updated.approvalMode
                        ?: requestedRuntimeConfiguration.approvalMode.wireValue,
                )
            } catch (_: Exception) {
                // fail-soft：保留本地选择，并延长 dirty，避免窗口过期后被旧服务端值盖回。
                if (currentSessionId == sessionId && generation == agentModeSyncGeneration) {
                    markAgentModeLocalDirty()
                }
            }
        }
    }

    public fun selectApprovalMode(mode: String) {
        val approvalMode = ConversationApprovalMode.resolve(mode)
            ?: ConversationApprovalMode.ALWAYS_ASK
        if (
            approvalMode != ConversationApprovalMode.ALWAYS_ASK &&
            !_uiState.value.permitsRelaxedApproval
        ) {
            return
        }
        requestedRuntimeConfiguration = requestedRuntimeConfiguration.copy(
            approvalMode = approvalMode,
        )
        persistRuntimeConfiguration()
        _uiState.value = _uiState.value.copy(
            runtimeConfiguration = resolveRuntimeConfiguration(),
        )
    }

    public fun addAttachment(uri: android.net.Uri) {
        when (val result = attachmentManager.addAttachment(uri, viewModelScope)) {
            is ChatAttachmentManager.AddResult.Error -> {
                _uiState.value = _uiState.value.copy(errorMessage = result.error.toUserMessage(context))
            }
            is ChatAttachmentManager.AddResult.Success -> { /* ok */ }
        }
    }

    public fun removeAttachment(id: String) {
        attachmentManager.removeAttachment(id)
    }

    public fun retryFailedAttachments() {
        attachmentManager.retryFailed(viewModelScope)
    }

    public fun retrySingleAttachment(id: String) {
        attachmentManager.retrySingle(id, viewModelScope)
    }

    /**
     * 取消单个正在执行 / 排队的子 Agent（best-effort 上行 `subagent.cancel`）。
     * 终态经 `subagent_failed(status=cancelled)` 回流收尾；UI 的「取消中」由卡片本地态兜。
     */
    public fun cancelSubagent(runId: String) {
        val sessionId = currentSessionId
        if (sessionId.isNullOrBlank() || runId.isBlank()) return
        streamManager.cancelSubagent(sessionId, runId)
    }

    /**
     * User-initiated stop. Keep observing until a terminal stream event arrives:
     * a `chat.cancel.ok` only means the server accepted the control command.
     */
    public fun cancelStream() {
        val sessionId = currentSessionId ?: return
        val state = _uiState.value
        val taskId = myTaskId
        if (state.isCancelControlPending ||
            !pauseControlAllowsStop(
                hasActiveRun = state.isStreaming || !taskId.isNullOrBlank(),
                isPaused = state.isPaused,
                pausePending = state.isPauseControlPending,
            )
        ) return

        //  对齐 Electron/iOS：Stop 时若最新一轮尚无实质助手输出，顺带撤回该未答轮次
        // （抽掉时间线 + 原文回填 Composer）；已有输出则只停不撤。对用户不新增概念。
        val latestUserMessage = state.messages.lastOrNull { message ->
            message.isUser && !message.isPushNotification &&
                !message.isCompactionSummary && !message.isInternalContext
        }
        if (latestUserMessage != null &&
            evaluateCanWithdrawUnansweredTurn(state.messages, latestUserMessage.id)
        ) {
            withdrawUnansweredTurn(latestUserMessage.id)
            return
        }

        val generation = beginRunControlRequest()
        _uiState.update {
            it.copy(
                isCancelControlPending = true,
                isPauseControlPending = false,
                errorMessage = null,
            )
        }
        viewModelScope.launch {
            if (!isCurrentRunControlRequest(sessionId, generation)) return@launch
            val ack = streamManager.cancelMessage(sessionId, taskId) {
                isCurrentRunControlRequest(sessionId, generation)
            } ?: return@launch
            if (!isCurrentRunControlRequest(sessionId, generation)) return@launch
            when (ack) {
                is AckResult.Ok -> _uiState.update {
                    // Keep `isCancelControlPending` until done/error reaches the
                    // stream observer. This prevents an accepted request from
                    // being rendered as an already-stopped run.
                    it.copy(isPaused = false, isPauseControlPending = false)
                }
                else -> {
                    _uiState.update {
                        it.copy(
                            isCancelControlPending = false,
                            errorMessage = ackToAppError(ack).toUserMessage(context),
                        )
                    }
                    refreshSessionControlState(sessionId, generation)
                }
            }
        }
    }

    /**
     * /#9597/#9614：撤回未答轮次（仅由 [cancelStream] 在「最新用户消息尚无实质输出」时调用）。
     *
     * 对齐 iOS Composer Stop 的 shouldWithdraw 分支：
     * 1) 本地 projector 抽掉该 user 及其后半截时间线；
     * 2) 发 `chat.cancel` 并带 `withdraw_unanswered=true`（Django chat_cancel 已支持）；
     * 3) 把原文交还 Composer，便于轻量改正后重发（不做 checkpoint 回滚）；
     * 4) 按 ack/done 的 `withdraw_applied` 门控终态对账（已删则豁免，复判拒绝则回拉）。
     */
    public fun withdrawUnansweredTurn(messageId: String) {
        val sessionId = currentSessionId ?: return
        val state = _uiState.value
        if (state.isCancelControlPending) return
        if (!evaluateCanWithdrawUnansweredTurn(state.messages, messageId)) return

        val target = state.messages.firstOrNull { message ->
            message.isUser && (message.id == messageId || messageId in message.identityKeys)
        } ?: return
        val cancelRequest = resolveWithdrawCancelRequest(target)
        val taskId = myTaskId
        val matchingQueue = state.queuedOutgoingMessages.firstOrNull { queued ->
            queued.clientEventId == cancelRequest.clientMessageId ||
                queued.id == cancelRequest.clientMessageId ||
                queued.id == target.id
        }

        val generation = beginRunControlRequest()
        discardingWithdrawnClientEventId = cancelRequest.clientMessageId
        discardingWithdrawnTaskId = taskId?.takeIf { it.isNotBlank() }
        // ：先记 pending；须等 withdraw_applied=true 才确认豁免（缺字段=未确认）。
        pendingWithdrawClientMessageId = cancelRequest.clientMessageId
        withdrawDeleteConfirmed = false
        projector.withdrawUnansweredTurn(messageId)
        matchingQueue?.id?.let { flushingQueueItemIds.remove(it) }
        clearMySendTracking()
        hitlSubmissionOwnership.clear()
        // clearMySendTracking 会清 myTaskId；丢弃键已在上面冻结。
        publishProjector {
            it.copy(
                isSending = false,
                isPaused = false,
                isPauseControlPending = false,
                isCancelControlPending = true,
                errorMessage = null,
                pendingAskUser = null,
                pendingAskForm = null,
                pendingRequestApproval = null,
                pendingReview = null,
                pendingPlanApproval = null,
                pendingApproval = null,
                hitlSubmitting = false,
                editingMessage = null,
                pendingComposerRestoreText = cancelRequest.targetContent.takeIf { text -> text.isNotBlank() },
            )
        }
        matchingQueue?.id?.let { queueId ->
            viewModelScope.launch {
                outgoingQueueRepository.dismissLocalRecord(queueId)
                if (currentSessionId == sessionId) reloadOutgoingQueue(sessionId)
            }
        }
        viewModelScope.launch {
            chatRepository.cacheMessagesSnapshot(sessionId, projector.messages)
        }
        viewModelScope.launch {
            if (!isCurrentRunControlRequest(sessionId, generation)) return@launch
            val ack = streamManager.cancelMessage(
                sessionId = sessionId,
                taskId = taskId,
                clientMessageId = cancelRequest.clientMessageId,
                withdrawUnanswered = true,
                targetContent = cancelRequest.targetContent,
            ) {
                isCurrentRunControlRequest(sessionId, generation)
            } ?: return@launch
            if (!isCurrentRunControlRequest(sessionId, generation)) return@launch
            when (ack) {
                is AckResult.Ok -> {
                    // 本地已抽掉轮次，流式观察侧也会收到 cancel 镜像；立刻放下取消门闩。
                    settleRunControls()
                    // ：ack.payload.withdraw_applied 与 done 同源；先到者生效。
                    onWithdrawAppliedSignal(parseWithdrawApplied(ack.payload), sessionId)
                    // 终态可能早于/晚于 ACK；短宽限后清丢弃窗，防止永久吞事件。
                    // 宽限结束时若仍未确认删除，清 pending（不豁免），维持现状对账。
                    viewModelScope.launch {
                        delay(2_000L)
                        if (discardingWithdrawnClientEventId == cancelRequest.clientMessageId) {
                            clearWithdrawnTurnDiscard()
                        }
                        clearUnconfirmedWithdrawReconcileGate(cancelRequest.clientMessageId)
                    }
                }
                else -> {
                    clearWithdrawReconcileExemption()
                    _uiState.update {
                        it.copy(
                            isCancelControlPending = false,
                            errorMessage = ackToAppError(ack).toUserMessage(context),
                        )
                    }
                    refreshSessionControlState(sessionId, generation)
                }
            }
        }
    }

    public fun consumeComposerRestoreText() {
        if (_uiState.value.pendingComposerRestoreText == null &&
            _uiState.value.pendingComposerRestoreBlocks.isNullOrEmpty()
        ) return
        _uiState.update {
            it.copy(
                pendingComposerRestoreText = null,
                pendingComposerRestoreBlocks = null,
            )
        }
    }

    private fun shouldDiscardWithdrawnTurnEvent(event: StreamEvent): Boolean {
        if (discardingWithdrawnClientEventId.isNullOrBlank() &&
            discardingWithdrawnTaskId.isNullOrBlank()
        ) {
            return false
        }
        // 丢弃窗口只拦旧 run 的投影/控制事件；协作者 USER mirror 与 resync 仍放行。
        return when (event) {
            is StreamEvent.SubscriptionReady,
            is StreamEvent.ObservedUserMessage,
            is StreamEvent.NeedsResync -> false
            else -> true
        }
    }

    private fun clearWithdrawnTurnDiscard() {
        discardingWithdrawnClientEventId = null
        discardingWithdrawnTaskId = null
    }

    private fun clearWithdrawReconcileExemption() {
        pendingWithdrawClientMessageId = null
        withdrawDeleteConfirmed = false
    }

    /** 超时仍未拿到 withdraw_applied=true 时丢掉 pending，避免误豁免后续对账。 */
    private fun clearUnconfirmedWithdrawReconcileGate(clientMessageId: String) {
        if (pendingWithdrawClientMessageId == clientMessageId && !withdrawDeleteConfirmed) {
            pendingWithdrawClientMessageId = null
        }
    }

    /**
     * ：消费 ack / done 上的 `withdraw_applied`。
     * true → 确认豁免终态对账；false → 清标记并主动 reconcile（本地已抽、服务端拒绝删除）；
     * null → 未确认，不改门控（旧后端维持现状）。
     */
    private fun onWithdrawAppliedSignal(withdrawApplied: Boolean?, sessionId: String) {
        if (pendingWithdrawClientMessageId.isNullOrBlank()) return
        when {
            shouldExemptWithdrawnTurnReconcile(withdrawApplied) -> {
                withdrawDeleteConfirmed = true
                // 若对账已在路上，立刻取消，避免竞态回灌。
                reconcileJob?.cancel()
                reconcileJob = null
                // 豁免只需盖住 600/1600/3000ms 终态对账窗；超时后清标记，避免长期挡住无关对账。
                val confirmedFor = pendingWithdrawClientMessageId
                viewModelScope.launch {
                    delay(3_500L)
                    if (withdrawDeleteConfirmed &&
                        pendingWithdrawClientMessageId == confirmedFor
                    ) {
                        clearWithdrawReconcileExemption()
                    }
                }
            }
            withdrawApplied == false -> {
                clearWithdrawReconcileExemption()
                refreshLatestMessagesWhenSettled(sessionId)
            }
            else -> Unit
        }
    }

    /**
     * Release local collection when this ViewModel leaves a session. This must
     * never send `chat.cancel`: a run belongs to its session, not to a screen.
     */
    private fun disposeLocalStream() {
        invalidateRunControlRequests()
        clearWithdrawnTurnDiscard()
        clearWithdrawReconcileExemption()
        val sessionId = currentSessionId
        streamJob?.cancel()
        streamJob = null
        sendingOutgoing = false
        val interruptedQueueIds = flushingQueueItemIds.toSet()
        flushingQueueItemIds.clear()
        if (!sessionId.isNullOrBlank()) {
            // The ACK coroutine was just cancelled, so it cannot repair its SENDING row itself.
            // NonCancellable also covers ViewModel teardown; the durable queue must survive it.
            viewModelScope.launch(NonCancellable) {
                val recoveredCount = outgoingQueueRepository.recoverInterruptedSends(sessionId)
                if (currentSessionId == sessionId) reloadOutgoingQueue(sessionId)
                if (recoveredCount > 0 || interruptedQueueIds.isNotEmpty()) {
                    Log.i(
                        TAG,
                        "outgoing interrupted session=${sessionId.redactedId()} " +
                            "flushing=${interruptedQueueIds.size} recovered=$recoveredCount",
                    )
                }
            }
        }
        clearMySendTracking()
        projector.endStreaming()
        hitlSubmissionOwnership.clear()
        publishProjector {
            it.copy(
            isSending = false,
            pendingAskUser = null,
            pendingAskForm = null,
            pendingRequestApproval = null,
            pendingReview = null,
            pendingPlanApproval = null,
            pendingApproval = null,
            hitlSubmitting = false,
            editingMessage = null,
            isPaused = false,
            isPauseControlPending = false,
            isCancelControlPending = false,
            )
        }
    }

    public fun pauseStream() {
        setPaused(paused = true)
    }

    public fun resumeStream() {
        setPaused(paused = false)
    }

    private fun setPaused(paused: Boolean) {
        val sessionId = currentSessionId ?: return
        val state = _uiState.value
        if (state.isPauseControlPending || state.isCancelControlPending || state.isPaused == paused) return
        val generation = beginRunControlRequest()
        _uiState.update { it.copy(isPauseControlPending = true, errorMessage = null) }
        viewModelScope.launch {
            if (!isCurrentRunControlRequest(sessionId, generation)) return@launch
            val ack = if (paused) {
                streamManager.pauseSession(sessionId) {
                    isCurrentRunControlRequest(sessionId, generation)
                } ?: return@launch
            } else {
                streamManager.resumeSession(sessionId) {
                    isCurrentRunControlRequest(sessionId, generation)
                } ?: return@launch
            }
            if (!isCurrentRunControlRequest(sessionId, generation)) return@launch
            when (ack) {
                is AckResult.Ok -> _uiState.update {
                    val pause = pauseControlAfterAck(
                        requestedPause = paused,
                        ackSucceeded = true,
                        currentlyPaused = it.isPaused,
                        currentlyPending = it.isPauseControlPending,
                    )
                    it.copy(
                        isPaused = pause.isPaused,
                        isPauseControlPending = pause.isPauseControlPending,
                    )
                }
                else -> _uiState.update {
                    val pause = pauseControlAfterAck(
                        requestedPause = paused,
                        ackSucceeded = false,
                        currentlyPaused = it.isPaused,
                        currentlyPending = it.isPauseControlPending,
                    )
                    it.copy(
                        isPaused = pause.isPaused,
                        isPauseControlPending = pause.isPauseControlPending,
                        errorMessage = ackToAppError(ack).toUserMessage(context),
                    )
                }
            }
            if (ack !is AckResult.Ok) refreshSessionControlState(sessionId, generation)
        }
    }

    /**
     * Wave 6 A3 — 从指定消息 Fork 出新会话。
     *
     * 只做一件事：把 requestId 发到 [forkRequests] 让宿主 AgentDetailScreen
     * 调 `AgentDetailViewModel.forkSession(currentSessionId, messageId)`。
     * 这里不直接持有 ChatRepository 调 API，原因见 [ForkRequestEvent] 注释。
     *
     * 与 iOS 协议对齐：`POST /chat/sessions/{sessionId}/fork`，body `{message_id}`。
     */
    public fun requestForkFromMessage(messageId: String) {
        val sid = currentSessionId ?: return
        _forkRequests.tryEmit(ForkRequestEvent(sid, messageId))
    }

    public fun insertLocalSystemMessage(content: String) {
        projector.appendSystemMessage(
            id = "rollback-summary-${System.currentTimeMillis()}",
            content = content,
        )
        publishProjector()
    }

    public fun dismissError() {
        _uiState.value = _uiState.value.copy(errorMessage = null)
    }

    public fun dismissModelSwitchError() {
        _uiState.value = _uiState.value.copy(modelSwitchErrorMessage = null)
    }

    public fun submitAskUser(
        answers: List<AskUserAnswerSelection>,
        expectedStableId: String? = null,
    ) {
        val pending = _uiState.value.pendingAskUser ?: return
        if (!pending.resolutionAccess.canResolve) return
        if (expectedStableId != null) {
            if (
                !CapsuleInteractionPendingKey.matchesAskUser(pending, expectedStableId) ||
                !CapsuleInteractionSubmissionGuard.allowsAskUser(pending, answers)
            ) {
                return
            }
        }
        if (_uiState.value.hitlSubmitting) return
        val sessionId = currentSessionId ?: return
        val requestId = pending.hitlRequestId ?: return run {
            _uiState.value = _uiState.value.copy(errorMessage = context.getString(R.string.chat_ask_submit_failed))
        }

        // UI 层 [AskUserAnswerSelection] → repo 层 [ChatRepository.AskUserAnswerInput]，
        // 两者结构等价，只为分层解耦保留两个类型。Wave 1 最小改动。
        val repoInputs = answers.map { sel ->
            ChatRepository.AskUserAnswerInput(
                questionId = sel.questionId,
                selectedOptions = sel.selectedOptions,
                freeText = sel.freeText,
            )
        }

        val submission = beginHitlSubmission(CapsuleInteractionPendingKey.askUser(pending))
        viewModelScope.launch {
            handleAskUserResult(
                chatRepository.submitAskUserAnswer(sessionId, requestId, repoInputs),
                submitted = pending,
                submission = submission,
            )
        }
    }

    // W4 (2026-05-11): submitAskUserFields / submitAskUserTextFallback 已删除——
    // ask_form 形态下线，只剩 questions[] 单形态。

    public fun skipAskUser() {
        val pending = _uiState.value.pendingAskUser ?: return
        if (!pending.resolutionAccess.canResolve) return
        if (_uiState.value.hitlSubmitting) return
        val sessionId = currentSessionId ?: return
        val requestId = pending.hitlRequestId ?: return run {
            _uiState.value = _uiState.value.copy(pendingAskUser = null)
        }

        val submission = beginHitlSubmission(CapsuleInteractionPendingKey.askUser(pending))
        viewModelScope.launch {
            handleAskUserResult(
                chatRepository.skipAskUser(sessionId, requestId),
                submitted = pending,
                submission = submission,
            )
        }
    }

    public fun submitAskForm(fieldValues: JsonObject) {
        val pending = _uiState.value.pendingAskForm ?: return
        if (!pending.resolutionAccess.canResolve) return
        if (_uiState.value.hitlSubmitting) return
        val submission = beginHitlSubmission(CapsuleInteractionPendingKey.askForm(pending))
        viewModelScope.launch {
            handleAskFormResult(
                chatRepository.submitAskFormAnswer(
                    sessionId = pending.sessionId,
                    hitlRequestId = pending.request.requestId,
                    fieldValues = fieldValues,
                ),
                submitted = pending,
                submission = submission,
            )
        }
    }

    public fun skipAskForm() {
        val pending = _uiState.value.pendingAskForm ?: return
        if (!pending.resolutionAccess.canResolve) return
        if (_uiState.value.hitlSubmitting) return
        val submission = beginHitlSubmission(CapsuleInteractionPendingKey.askForm(pending))
        viewModelScope.launch {
            handleAskFormResult(
                chatRepository.skipAskForm(
                    sessionId = pending.sessionId,
                    hitlRequestId = pending.request.requestId,
                ),
                submitted = pending,
                submission = submission,
            )
        }
    }

    public fun submitRequestApproval(
        approved: Boolean,
        expectedStableId: String? = null,
    ) {
        val pending = _uiState.value.pendingRequestApproval ?: return
        if (!pending.resolutionAccess.canResolve) return
        if (expectedStableId != null) {
            if (
                !CapsuleInteractionPendingKey.matchesRequestApproval(pending, expectedStableId) ||
                !CapsuleInteractionSubmissionGuard.allowsRequestApproval(pending, approved)
            ) {
                return
            }
        }
        if (_uiState.value.hitlSubmitting) return
        val submission = beginHitlSubmission(CapsuleInteractionPendingKey.requestApproval(pending))
        viewModelScope.launch {
            handleRequestApprovalResult(
                chatRepository.submitRequestApproval(
                    sessionId = pending.sessionId,
                    hitlRequestId = pending.request.requestId,
                    approved = approved,
                ),
                submitted = pending,
                submission = submission,
            )
        }
    }

    /**
     * legacy：runtime W1.5 已不再 emit `review_required`，整个 submitReview 路径属于死代码。
     * 保留入口避免 ConversationView 引用失败；新路径走 [submitApproval]。
     *
     * **fail-loud**：万一历史 trace replay / 旧服务端推送了 review_required 触发了
     * pendingReview，本端 dismiss 但**不**向服务端提交决策——HITL 会在服务端 hang
     * 直到超时。给用户一个明确的 errorMessage 提示"路径已废弃，请重启会话"，
     * 避免静默"提交成功"假象。
     */
    public fun submitReview(decision: String) {
        @Suppress("UNUSED_VARIABLE")
        val _unused = decision
        _uiState.value = _uiState.value.copy(
            pendingReview = null,
            errorMessage = context.getString(R.string.chat_review_legacy_path_warning),
        )
    }

    private fun askUserRequestKey(pending: PendingAskUser?): String? = pending?.let {
        it.hitlRequestId ?: it.messageId
    }

    private fun beginHitlSubmission(key: String): HitlSubmissionToken {
        val token = hitlSubmissionOwnership.claim(key)
        _uiState.value = _uiState.value.copy(hitlSubmitting = true)
        return token
    }

    private fun releaseHitlSubmission(token: HitlSubmissionToken): Boolean {
        val released = hitlSubmissionOwnership.release(token)
        if (released) {
            _uiState.value = _uiState.value.copy(hitlSubmitting = false)
        }
        return released
    }

    private fun releaseHitlSubmissionForKey(key: String): Boolean {
        val released = hitlSubmissionOwnership.releaseKey(key)
        if (released) {
            _uiState.value = _uiState.value.copy(hitlSubmitting = false)
        }
        return released
    }

    private fun handleAskUserResult(
        result: ChatRepository.HitlSubmitResult,
        submitted: PendingAskUser,
        submission: HitlSubmissionToken,
    ) {
        if (!releaseHitlSubmission(submission)) return
        val currentMatches = askUserRequestKey(_uiState.value.pendingAskUser) ==
            askUserRequestKey(submitted)
        when (result) {
            ChatRepository.HitlSubmitResult.Success -> {
                markAskUserPendingInteractionResolved(submitted)
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        pendingAskUser = null,
                    )
                }
            }
            is ChatRepository.HitlSubmitResult.AlreadyConsumed -> {
                markAskUserPendingInteractionResolved(submitted)
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        pendingAskUser = null,
                        errorMessage = hitlSubmitMessage(result, R.string.chat_ask_submit_failed),
                    )
                }
            }
            is ChatRepository.HitlSubmitResult.Failed -> {
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        errorMessage = hitlSubmitMessage(result, R.string.chat_ask_submit_failed),
                    )
                }
            }
        }
    }

    private fun handleAskFormResult(
        result: ChatRepository.HitlSubmitResult,
        submitted: PendingAskForm,
        submission: HitlSubmissionToken,
    ) {
        if (!releaseHitlSubmission(submission)) return
        val currentMatches = _uiState.value.pendingAskForm?.request?.requestId ==
            submitted.request.requestId
        when (result) {
            ChatRepository.HitlSubmitResult.Success -> {
                markAskFormPendingInteractionResolved(submitted)
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        pendingAskForm = null,
                    )
                }
            }
            is ChatRepository.HitlSubmitResult.AlreadyConsumed -> {
                markAskFormPendingInteractionResolved(submitted)
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        pendingAskForm = null,
                        errorMessage = hitlSubmitMessage(result, R.string.chat_ask_submit_failed),
                    )
                }
            }
            is ChatRepository.HitlSubmitResult.Failed -> {
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        errorMessage = hitlSubmitMessage(result, R.string.chat_ask_submit_failed),
                    )
                }
            }
        }
    }

    private fun handleRequestApprovalResult(
        result: ChatRepository.HitlSubmitResult,
        submitted: PendingRequestApproval,
        submission: HitlSubmissionToken,
    ) {
        if (!releaseHitlSubmission(submission)) return
        val currentMatches = _uiState.value.pendingRequestApproval?.request?.requestId ==
            submitted.request.requestId
        when (result) {
            ChatRepository.HitlSubmitResult.Success -> {
                markRequestApprovalPendingInteractionResolved(submitted)
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        pendingRequestApproval = null,
                    )
                }
            }
            is ChatRepository.HitlSubmitResult.AlreadyConsumed -> {
                markRequestApprovalPendingInteractionResolved(submitted)
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        pendingRequestApproval = null,
                        errorMessage = hitlSubmitMessage(result, R.string.chat_approval_submit_failed),
                    )
                }
            }
            is ChatRepository.HitlSubmitResult.Failed -> {
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        errorMessage = hitlSubmitMessage(result, R.string.chat_approval_submit_failed),
                    )
                }
            }
        }
    }

    public fun dismissReview() {
        _uiState.value = _uiState.value.copy(pendingReview = null)
    }

    /**
     * Wave 4 I8：提交 plan.exit 审批结果。
     * outcome ∈ { 'approved', 'rejected', 'cancelled' } —— 与 Daemon
     * `PlanApprovalIpcResponsePayloadSchema.outcome` 严格对齐（不是 approval_resolved
     * 的 'allow'/'deny'）。
     */
    public fun submitPlanApproval(
        outcome: String,
        editedPlanMarkdown: String? = null,
        allowedPrompts: List<String>? = null,
    ) {
        val pending = _uiState.value.pendingPlanApproval ?: return
        if (_uiState.value.hitlSubmitting) return
        val prompts = allowedPrompts ?: pending.hintAllowedPrompts.takeIf { it.isNotEmpty() }

        val submission = beginHitlSubmission(planApprovalSubmissionKey(pending))
        viewModelScope.launch {
            val result = chatRepository.submitPlanApproval(
                sessionId = pending.sessionId,
                hitlRequestId = pending.requestId,
                outcome = outcome,
                editedPlanMarkdown = editedPlanMarkdown,
                allowedPrompts = prompts,
            )
            handlePlanApprovalResult(result, pending, submission)
        }
    }

    private fun handlePlanApprovalResult(
        result: ChatRepository.HitlSubmitResult,
        submitted: PendingPlanApproval,
        submission: HitlSubmissionToken,
    ) {
        if (!releaseHitlSubmission(submission)) return
        val currentMatches = _uiState.value.pendingPlanApproval?.requestId == submitted.requestId
        when (result) {
            ChatRepository.HitlSubmitResult.Success -> {
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(pendingPlanApproval = null)
                }
            }
            is ChatRepository.HitlSubmitResult.AlreadyConsumed -> {
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        pendingPlanApproval = null,
                        errorMessage = hitlSubmitMessage(result, R.string.chat_review_submit_failed),
                    )
                }
            }
            is ChatRepository.HitlSubmitResult.Failed -> {
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        errorMessage = hitlSubmitMessage(result, R.string.chat_review_submit_failed),
                    )
                }
            }
        }
    }

    private fun planApprovalSubmissionKey(pending: PendingPlanApproval): String =
        "plan-approval:${pending.requestId}"

    public fun dismissPlanApproval() {
        submitPlanApproval("cancelled")
    }

    public fun executePlanProposal(proposal: PlanProposal) {
        val cardId = "plan_${proposal.planDocumentId}"
        // ：执行不再走 Django /plan/exit——纯客户端行为：切 agent 模式 + 发继续消息。
        // prompt 带 plan 指针（planDocumentId：file 载体=相对路径，document 载体=文档 id），
        // Agent 执行前按指针重读最新内容（file → file_read；document → tabdoc 读取工具），
        // 快照正文仅作兜底展示。同时修复历史 bug：执行后必须切到 agent 模式（此前缺失，
        // 续聊可能仍在 plan 模式）。
        selectAgentMode("agent")
        val nameSuffix = if (proposal.planName.isBlank()) "" else "「${proposal.planName}」"
        val pointer =
            if (proposal.planDocumentId.isBlank()) "" else "plan 指针：`${proposal.planDocumentId}`，"
        val snapshot = proposal.descriptionMarkdown.ifBlank { proposal.overview }
        val body = if (snapshot.isBlank()) {
            "（快照正文为空——请先按指针重读 plan，或用 ask_user 与用户确认要执行的具体内容。）"
        } else {
            snapshot
        }
        val prompt =
            "请按已批准的 Plan${nameSuffix}开始执行。${pointer}执行前先读取 plan 最新内容再动手。\n\n$body"
        projector.markProposalResolved(cardId)
        publishProjector()
        sendMessage(prompt)
    }

    public fun approveModeSwitch(proposal: ModeSwitchProposal) {
        val cardId = "mode_${proposal.proposalId}"
        // 与 iOS / executePlanProposal 对齐：先切 agent，再标已处理并续聊。
        // 只 mark resolved 会让 Composer 留在 Plan，后续 switch_mode 也更容易
        // 撞上 host 侧未结案 pending。
        selectAgentMode("agent")
        projector.markProposalResolved(cardId)
        publishProjector()
        val prompt = if (proposal.reason.isBlank()) {
            "继续执行（已切换到 Agent 模式）"
        } else {
            "继续执行（已切换到 Agent 模式）：${proposal.reason}"
        }
        sendMessage(prompt)
    }

    public fun ignoreProposal(cardId: String) {
        projector.markProposalResolved(cardId)
        publishProjector()
    }

    /**
     * v0.4 W1.5-轮 4：提交批量审批决策（PRD §7.4 / §7.10）。
     *
     * outcome ∈ { 'allow', 'deny', 'cancelled' }：
     *   - 'allow' / 'deny' 走 wire `LocalRtUserResponseDecisionSchema`（按 D6 一刀切）
     *     上行到 Django；scope 仅 'allow' 时才有意义
     *   - 'cancelled' 由 UI 本端 dismiss 处理（不上行）—— wire schema 不接受 cancelled outcome
     *
     * mobile UI 当前简化为"全允/全拒/全取消"语义——每条 decision.outcome 同。
     * 个体逐条选择登记 §9 留待 mobile UX wave。
     */
    public fun submitApproval(
        outcome: String,
        scope: String? = null,
        expectedStableId: String? = null,
    ) {
        val pending = _uiState.value.pendingApproval ?: return
        if (!pending.resolutionAccess.canResolve) return
        if (expectedStableId != null) {
            if (
                !CapsuleInteractionPendingKey.matchesToolApproval(pending, expectedStableId) ||
                !CapsuleInteractionSubmissionGuard.allowsToolApproval(pending, outcome, scope)
            ) {
                return
            }
        }
        if (_uiState.value.hitlSubmitting) return
        val sid = currentSessionId ?: return

        // 'cancelled' 当作本端 dismiss——wire schema 仅接受 allow/deny
        if (outcome == "cancelled") {
            approvalExpirationJob?.cancel()
            approvalExpirationJob = null
            releaseHitlSubmissionForKey(CapsuleInteractionPendingKey.toolApproval(pending))
            _uiState.value = _uiState.value.copy(pendingApproval = null)
            return
        }

        val threadId = pending.actionThreadId ?: "chat-session-$sid"
        pending.actionApprovalId?.let { approvalId ->
            val submission = beginHitlSubmission(CapsuleInteractionPendingKey.toolApproval(pending))
            viewModelScope.launch {
                val result = chatRepository.submitActionApprovalResponse(
                    threadId = threadId,
                    approvalId = approvalId,
                    approved = outcome == "allow",
                    scope = if (outcome == "allow") scope else null,
                )
                handleApprovalResult(
                    result,
                    submitted = pending,
                    sessionId = sid,
                    submission = submission,
                )
            }
            return
        }

        // M4.2 L-W6-30：always-allow 路径同时附带 pattern_key / scope_description /
        // decision_kind 三字段。整体构造交给 ApprovalDecisionPayloadBuilder（与 iOS 同名
        // 文件 + Electron handleAlwaysAllow 三端同构），单测用纯函数断言三字段非空。
        val decisions = com.tabtin.mobile.security.ApprovalDecisionPayloadBuilder.build(
            actionRequests = pending.actionRequests,
            outcome = outcome,
            scope = scope,
        )

        val submission = beginHitlSubmission(CapsuleInteractionPendingKey.toolApproval(pending))
        viewModelScope.launch {
            val result = chatRepository.submitApprovalDecisionsForSession(
                threadId = threadId,
                batchId = pending.batchId,
                decisions = decisions,
            )
            handleApprovalResult(
                result,
                submitted = pending,
                sessionId = sid,
                submission = submission,
            )
        }
    }

    private fun applyApprovalRequested(event: StreamEvent.ApprovalRequested) {
        val existing = _uiState.value.pendingApproval?.takeIf {
            it.batchId == event.batchId && it.actionApprovalId == event.actionApprovalId
        }
        val access = existing?.resolutionAccess?.merging(event.resolutionAccess)
            ?: event.resolutionAccess
        _uiState.value = _uiState.value.copy(
            pendingApproval = PendingApproval(
                batchId = event.batchId,
                approvalType = event.approvalType,
                actionRequests = event.actionRequests,
                runtimeMode = event.runtimeMode,
                expiresAtMs = event.expiresAtMs,
                actionApprovalId = event.actionApprovalId,
                actionThreadId = event.actionThreadId,
                resolutionAccess = access,
            ),
        )
        scheduleApprovalExpiration(event)
    }

    private fun handleApprovalResult(
        result: ChatRepository.HitlSubmitResult,
        submitted: PendingApproval,
        sessionId: String,
        submission: HitlSubmissionToken,
    ) {
        if (!releaseHitlSubmission(submission)) return
        val currentMatches = CapsuleInteractionPendingKey.sameToolApproval(
            _uiState.value.pendingApproval,
            submitted,
        )
        when (result) {
            ChatRepository.HitlSubmitResult.Success -> {
                markPendingInteractionResolved(submitted, sessionId)
                if (currentMatches) {
                    approvalExpirationJob?.cancel()
                    approvalExpirationJob = null
                    _uiState.value = _uiState.value.copy(
                        pendingApproval = null,
                    )
                }
            }
            is ChatRepository.HitlSubmitResult.AlreadyConsumed -> {
                markPendingInteractionResolved(submitted, sessionId)
                if (currentMatches) {
                    approvalExpirationJob?.cancel()
                    approvalExpirationJob = null
                    _uiState.value = _uiState.value.copy(
                        pendingApproval = null,
                        errorMessage = hitlSubmitMessage(result, R.string.chat_review_submit_failed),
                    )
                }
            }
            is ChatRepository.HitlSubmitResult.Failed -> {
                if (currentMatches) {
                    _uiState.value = _uiState.value.copy(
                        errorMessage = hitlSubmitMessage(result, R.string.chat_review_submit_failed),
                    )
                }
            }
        }
    }

    private fun markPendingInteractionResolved(pending: PendingApproval, sessionId: String) {
        pendingInteractionRepository.markResolved(
            kind = "tool_approval",
            threadId = pending.actionThreadId ?: "chat-session-$sessionId",
            requestKey = pending.actionApprovalId ?: pending.batchId,
        )
    }

    private fun markAskUserPendingInteractionResolved(pending: PendingAskUser) {
        val requestKey = pending.hitlRequestId ?: pending.messageId ?: return
        singleHitlResolutions.record(pending.sessionId, requestKey)
        pendingInteractionRepository.markResolved(
            kind = "ask_choice",
            threadId = "chat-session-${pending.sessionId}",
            requestKey = requestKey,
        )
    }

    private fun markAskFormPendingInteractionResolved(pending: PendingAskForm) {
        singleHitlResolutions.record(pending.sessionId, pending.request.requestId)
        pendingInteractionRepository.markResolved(
            kind = "ask_form",
            threadId = "chat-session-${pending.sessionId}",
            requestKey = pending.request.requestId,
        )
    }

    private fun markRequestApprovalPendingInteractionResolved(pending: PendingRequestApproval) {
        singleHitlResolutions.record(pending.sessionId, pending.request.requestId)
        pendingInteractionRepository.markResolved(
            kind = "permission_request",
            threadId = "chat-session-${pending.sessionId}",
            requestKey = pending.request.requestId,
        )
    }

    public fun dismissApproval() {
        approvalExpirationJob?.cancel()
        approvalExpirationJob = null
        _uiState.value.pendingApproval?.let {
            releaseHitlSubmissionForKey(CapsuleInteractionPendingKey.toolApproval(it))
        }
        _uiState.value = _uiState.value.copy(pendingApproval = null)
    }

    private fun scheduleApprovalExpiration(event: StreamEvent.ApprovalRequested) {
        approvalExpirationJob?.cancel()
        approvalExpirationJob = null
        val expiresAtMs = event.expiresAtMs ?: return
        val delayMs = expiresAtMs - System.currentTimeMillis()
        if (delayMs <= 0L) {
            expireApproval(event.batchId)
            return
        }
        approvalExpirationJob = viewModelScope.launch {
            delay(delayMs)
            expireApproval(event.batchId)
        }
    }

    private fun expireApproval(batchId: String) {
        val pending = _uiState.value.pendingApproval ?: return
        if (pending.batchId != batchId) return
        currentSessionId?.let { sessionId ->
            markPendingInteractionResolved(pending, sessionId)
        }
        approvalExpirationJob?.cancel()
        approvalExpirationJob = null
        releaseHitlSubmissionForKey(CapsuleInteractionPendingKey.toolApproval(pending))
        _uiState.value = _uiState.value.copy(
            pendingApproval = null,
        )
    }

    /**
     * Wave 4 S2/A2：开启对某条 user 消息的编辑模式。
     * 一次只允许一条；调用时若有别的消息正在编辑，会被替换。
     */
    public fun beginEditMessage(messageId: String) {
        val msg = _uiState.value.messages.firstOrNull { it.id == messageId } ?: return
        if (!msg.isUser || msg.isPushNotification || msg.isCompactionSummary) return
        if (msg.createdAt == null) {
            _uiState.value = _uiState.value.copy(
                errorMessage = context.getString(R.string.chat_message_edit_wait_persisted),
            )
            return
        }
        _uiState.value = _uiState.value.copy(
            editingMessage = EditingMessageState(
                messageId = messageId,
                originalContent = msg.displayContent,
                originalBlocks = msg.blocksJson,
            ),
            editResend = null,
        )
    }

    public fun cancelEditMessage() {
        if (_uiState.value.editResend?.isExecuting == true) return
        _uiState.value = _uiState.value.copy(editingMessage = null, editResend = null)
    }

    /**
     * Wave 4 S2/A2：编辑后重发。
     *
     * 对齐 Electron/iOS：先回滚此用户消息之后的对话内容，再发送编辑后的内容。
     * 这样 Agent 上下文不会同时看到「原用户消息」和「编辑后消息」两份输入。
     */
    public fun submitEditMessage(newContent: String) {
        val editing = _uiState.value.editingMessage ?: return
        val trimmed = newContent.trim()
        if (trimmed.isEmpty()) return
        // 复用原始非文本 blocks（图片 / 文件 / doc_selection 等），与 Electron
        //   UserMessageEditMode.tsx contextBlocks 拼装逻辑同口径。
        val keptBlocks: List<MessageBlock>? = editing.originalBlocks
            ?.filter { it.type != null && it.type != "text" }
            ?.mapNotNull { it.toOutboundMessageBlock() }
            ?.takeIf { it.isNotEmpty() }

        val sessionId = currentSessionId ?: return
        if (_uiState.value.isSending || _uiState.value.isStreaming) return
        _uiState.value = _uiState.value.copy(
            editResend = EditResendState(
                targetMessageId = editing.messageId,
                editedContent = trimmed,
                keptBlocks = keptBlocks,
            ),
            errorMessage = null,
        )
        loadEditResendPreview(sessionId, editing.messageId)
    }

    private fun loadEditResendPreview(sessionId: String, targetMessageId: String) {
        viewModelScope.launch {
            try {
                val preview = chatCheckpointRepository.rollbackPreview(sessionId, targetMessageId)
                if (currentSessionId != sessionId) return@launch
                val pending = _uiState.value.editResend
                if (pending?.targetMessageId != targetMessageId) return@launch
                _uiState.value = _uiState.value.copy(
                    editResend = pending.copy(
                        preview = preview,
                        isLoadingPreview = false,
                        errorMessage = null,
                    ),
                )
            } catch (error: Exception) {
                if (currentSessionId != sessionId) return@launch
                val pending = _uiState.value.editResend
                if (pending?.targetMessageId != targetMessageId) return@launch
                _uiState.value = _uiState.value.copy(
                    editResend = pending.copy(
                        isLoadingPreview = false,
                        errorMessage = errorMessage(error).ifBlank {
                            context.getString(R.string.checkpoint_preview_timeout)
                        },
                    ),
                )
            }
        }
    }

    public fun retryEditResendPreview() {
        val sessionId = currentSessionId ?: return
        val pending = _uiState.value.editResend ?: return
        if (pending.isExecuting || pending.rollbackApplied) return
        _uiState.value = _uiState.value.copy(
            editResend = pending.copy(
                preview = null,
                isLoadingPreview = true,
                errorMessage = null,
            ),
        )
        loadEditResendPreview(sessionId, pending.targetMessageId)
    }

    public fun dismissEditResendPreview() {
        val pending = _uiState.value.editResend ?: return
        if (pending.isExecuting) return
        _uiState.value = if (pending.rollbackApplied) {
            _uiState.value.copy(
                editingMessage = null,
                editResend = null,
                pendingComposerRestoreText = pending.editedContent,
                pendingComposerRestoreBlocks = pending.keptBlocks,
            )
        } else {
            _uiState.value.copy(editResend = null)
        }
    }

    /** 确认后才进入“回退 → 资源恢复 → 权威替换 → 发送”的不可交换链路。 */
    public fun confirmEditResend(
        excludedResources: Set<String>,
        allowConversationOnly: Boolean,
    ) {
        val sessionId = currentSessionId ?: return
        val pending = _uiState.value.editResend ?: return
        val preview = pending.preview ?: return
        // 对话回退一旦落地，旧预览和旧资源计划都已消费，不能再次执行整条链路。
        // 失败后的安全出口是把保留的文本/附件交还输入框，再由用户发起新操作。
        if (pending.isExecuting || pending.isLoadingPreview || pending.rollbackApplied) return
        if (!preview.canExecuteEditResend(allowConversationOnly)) return
        val previewDecision = preview.editResendPreviewDecision()
        val approvedUnavailableFileReason = if (allowConversationOnly) {
            previewDecision.approvedUnavailableFileReason
        } else {
            null
        }
        val approvedUnrestorableFilePaths = if (allowConversationOnly) {
            previewDecision.approvedUnrestorableFilePaths
        } else {
            emptySet()
        }

        _uiState.value = _uiState.value.copy(
            editResend = pending.copy(isExecuting = true, errorMessage = null),
        )

        viewModelScope.launch {
            // v2 必须覆盖预览计划全集：每项都明确恢复或 skip，不能用“请求里省略”
            // 代替用户确认。后端据此校验完整计划并阻止静默漏项。
            val resourceDecisions = preview.resourceRestorePlan.map { item ->
                val shouldRestore = item.canRestore &&
                    !excludedResources.contains("${item.resourceType}:${item.resourceId}")
                ResourceRestoreItem(
                    resourceType = item.resourceType,
                    resourceId = item.resourceId,
                    action = if (shouldRestore) item.action else "skip",
                    restoreToVersionId = if (shouldRestore) item.restoreToVersionId else null,
                )
            }

            val outcome = executeEditResendTimelineRewrite(
                rollback = {
                    chatCheckpointRepository.rollback(
                        sessionId = sessionId,
                        targetMessageId = pending.targetMessageId,
                        safetySnapshotHash = null,
                        rollbackReason = context.getString(R.string.chat_message_edit_rollback_reason),
                        mode = "editAndResend",
                        previewRevision = preview.previewRevision,
                        filePreviewRevision = preview.filePreviewRevision,
                        acknowledgedFilePreviewReason = approvedUnavailableFileReason,
                        rollbackContractVersion = preview.rollbackContractVersion,
                    )
                },
                restoreResources = {
                    if (resourceDecisions.isEmpty()) {
                        ResourceRestoreResponse(success = true)
                    } else {
                        chatCheckpointRepository.restoreResources(
                            sessionId = sessionId,
                            items = resourceDecisions,
                            previewRevision = preview.previewRevision,
                            rollbackContractVersion = preview.rollbackContractVersion,
                        )
                    }
                },
                refreshAuthoritativeHistory = {
                    refreshMessagesAfterTimelineRewrite(sessionId)
                },
                sendEditedMessage = {
                    persistEditedMessageAfterTimelineRewrite(
                        sessionId = sessionId,
                        content = pending.editedContent,
                        blocks = pending.keptBlocks,
                    )
                },
                approvedUnavailableFileReason = approvedUnavailableFileReason,
                approvedUnrestorableFilePaths = approvedUnrestorableFilePaths,
            )

            when (outcome) {
                is EditResendTimelineRewriteOutcome.Success -> {
                    _uiState.value = _uiState.value.copy(
                        editingMessage = null,
                        editResend = null,
                        errorMessage = null,
                    )
                    _editResendEvents.tryEmit(EditResendCompleted)
                }

                is EditResendTimelineRewriteOutcome.Failure -> {
                    if (currentSessionId != sessionId) return@launch
                    if (outcome.rollbackApplied) {
                        // 即使文件/资源层失败，也要尽力让屏幕反映已经缩短的服务端时间线。
                        refreshMessagesAfterTimelineRewrite(sessionId)
                    }
                    val current = _uiState.value.editResend ?: pending
                    _uiState.value = _uiState.value.copy(
                        editResend = current.copy(
                            isExecuting = false,
                            errorMessage = editResendFailureMessage(outcome),
                            rollbackApplied = outcome.rollbackApplied,
                        ),
                    )
                }
            }
        }
    }

    private suspend fun persistEditedMessageAfterTimelineRewrite(
        sessionId: String,
        content: String,
        blocks: List<MessageBlock>?,
    ): Boolean {
        if (currentSessionId != sessionId) return false
        val result = kotlinx.coroutines.CompletableDeferred<Boolean>()
        sendMessage(
            request = ConversationSendRequest(
                content = content,
                blocks = blocks,
                attachmentPolicy = AttachmentPolicy.NONE,
            ),
            onPersisted = { result.complete(true) },
            onFailed = { result.complete(false) },
        )
        return result.await()
    }

    private suspend fun refreshMessagesAfterTimelineRewrite(sessionId: String): Boolean {
        val generation = sessionLoadGeneration
        if (!canReplaceMessagesFromHistory(sessionId, generation)) return false
        return try {
            val result = chatRepository.getMessages(sessionId)
            if (!canReplaceMessagesFromHistory(sessionId, generation)) return false
            applyHistoryResult(result) {
                projector.replaceWithFocusedHistory(result.messages)
            }
            publishProjector {
                it.copy(
                    hasMore = result.hasMore,
                )
            }
            true
        } catch (error: Exception) {
            Log.w(TAG, "timeline rewrite refresh failed session=${sessionId.redactedId()}", error)
            false
        }
    }

    private fun editResendFailureMessage(
        outcome: EditResendTimelineRewriteOutcome.Failure,
    ): String = when (outcome.stage) {
        EditResendTimelineRewriteOutcome.FailureStage.FILES -> {
            val summary = context.getString(R.string.chat_message_edit_file_restore_failed)
            val reason = when (outcome.fileRestoreReason?.lowercase()) {
                "device_offline", "control_device_offline", "preview_not_delivered", "preview_timeout" ->
                    context.getString(R.string.checkpoint_files_restore_device_offline)
                "execution_context_missing", "no_control_device", "device_fingerprint_missing" ->
                    context.getString(R.string.checkpoint_files_restore_no_device)
                "no_file_history", "desktop_upgrade_required" ->
                    context.getString(R.string.checkpoint_files_restore_no_history)
                "file_snapshot_missing" ->
                    context.getString(R.string.checkpoint_files_restore_snapshot_missing)
                "path_guard_denied" ->
                    context.getString(R.string.checkpoint_files_restore_protected_path)
                "unrestorable_files" ->
                    context.getString(R.string.checkpoint_files_restore_unrestorable)
                "preview_stale", "file_preview_stale" ->
                    context.getString(R.string.checkpoint_files_restore_preview_stale)
                "file_restore_result_unknown", "file_restore_finalize_failed",
                "file_restore_finalize_expired" ->
                    context.getString(R.string.checkpoint_files_restore_result_unknown)
                else -> null
            }
            buildList {
                add(summary)
                reason?.let(::add)
                if (outcome.failedFiles.isNotEmpty()) add(context.getString(
                    R.string.checkpoint_failed_files,
                    outcome.failedFiles.take(3).joinToString(", "),
                ))
            }.joinToString("\n")
        }
        EditResendTimelineRewriteOutcome.FailureStage.RESOURCES -> buildList {
            add(context.getString(R.string.chat_message_edit_resource_restore_failed))
            addAll(outcome.resourceErrors.take(3))
        }.joinToString("\n")
        EditResendTimelineRewriteOutcome.FailureStage.REFRESH ->
            context.getString(R.string.chat_message_edit_refresh_failed)
        EditResendTimelineRewriteOutcome.FailureStage.ROLLBACK,
        EditResendTimelineRewriteOutcome.FailureStage.SEND ->
            errorMessage(outcome.error).ifBlank {
                context.getString(R.string.chat_message_edit_rollback_failed)
            }
    }

    /**
     *  / ：HTTP 历史加载后恢复子 Agent 卡与 transcript。
     * replace 前快照现有 agentSteps，reconcile 时保留 live 非空 transcript。
     */
    private fun applyHistoryResult(
        result: LoadMessagesResult,
        replace: () -> Boolean,
    ): Boolean {
        val existing = projector.messages
        val replaced = replace()
        val rehydrated = SubagentHistoryRehydration.applyToMessages(
            messages = projector.messages,
            childMessages = result.subagentTranscriptMessages,
            existingMessages = existing,
        )
        val stepsChanged = projector.rehydrateSubagentSteps(rehydrated)
        val restoredTodos = TodoHistoryRehydration.deriveLatestTodos(projector.messages)
        val todosChanged = restoredTodos != _uiState.value.agentTodos
        val children = (_uiState.value.subagentTranscriptMessages + result.subagentTranscriptMessages)
            .distinctBy { it.id }
        val childrenChanged = children != _uiState.value.subagentTranscriptMessages
        if (todosChanged || childrenChanged) {
            _uiState.value = _uiState.value.copy(
                agentTodos = if (todosChanged) restoredTodos else _uiState.value.agentTodos,
                subagentTranscriptMessages = children,
            )
        }
        return replaced || stepsChanged || todosChanged || childrenChanged
    }

    public fun sendWithReferences(
        text: String,
        references: List<com.tabtin.mobile.features.workbench.ResourceReference>,
        onPersisted: (() -> Unit)? = null,
    ) {
        val resourceBlocks = references.mapNotNull { it.toMessageBlock() }
        val trimmed = text.trim()
        val content = if (references.isNotEmpty()) {
            val refLabels = references.joinToString("\u3001") { it.label }
            if (trimmed.isEmpty()) context.getString(R.string.chat_ref_about, refLabels)
            else context.getString(R.string.chat_ref_about_with_content, refLabels, trimmed)
        } else trimmed
        sendMessage(content, resourceBlocks.takeIf { it.isNotEmpty() }, onPersisted)
    }

    private fun applyProjectorStreamEvent(event: StreamEvent, sessionId: String): Boolean {
        val projected = when (event) {
            is StreamEvent.MessageStarted,
            is StreamEvent.TextBlockDelta,
            is StreamEvent.CitationBlockDelta,
            is StreamEvent.ThinkingBlockDelta,
            is StreamEvent.ToolUseBlockStarted,
            is StreamEvent.ToolUseBlockUpdated,
            is StreamEvent.ToolUseBlockCompleted,
            is StreamEvent.ToolResultBlock,
            is StreamEvent.RichContentBlockReceived,
            is StreamEvent.ContextRefBlockReceived,
            is StreamEvent.AttachmentBlockReceived,
            is StreamEvent.MessageStopped,
            is StreamEvent.MessagePersisted,
            is StreamEvent.MessageCommitted,
            is StreamEvent.Done,
            is StreamEvent.Error,
            is StreamEvent.ChunkAppended,
            is StreamEvent.Reasoning,
            is StreamEvent.ToolCall,
            is StreamEvent.StepUpdate,
            is StreamEvent.SystemNotice,
            StreamEvent.ContentReset -> projector.apply(event) { it.toUserMessage(context) }
            else -> false
        }
        if (!projected) return false

        when (event) {
            is StreamEvent.MessageStarted -> {
                activeRunModelId = event.modelId
                if (!event.sourceClientEventId.isNullOrBlank()) {
                    completeOutgoingExecutionByClientEvent(sessionId, event.sourceClientEventId)
                } else {
                    completeOutgoingExecutionByTask(sessionId, myTaskId)
                }
            }
            is StreamEvent.Done -> {
                completeOutgoingExecutionByTask(sessionId, event.taskId)
                completeOutgoingExecutionByClientEvent(sessionId, event.sourceClientEventId)
                if (!event.isError) refreshPromotionCreditAfterSettlement(activeRunModelId)
                activeRunModelId = null
                // 非丢弃路径也会带 withdraw_applied（与 ack 二选一先到）。
                onWithdrawAppliedSignal(event.withdrawApplied, sessionId)
            }
            else -> Unit
        }

        when (event) {
            is StreamEvent.Done,
            is StreamEvent.Error -> {
                clearMySendTracking()
                val snapshot = projector.messages
                viewModelScope.launch {
                    chatRepository.cacheMessagesSnapshot(sessionId, snapshot)
                }
                refreshLatestMessagesWhenSettled(sessionId)
            }
            is StreamEvent.MessagePersisted -> refreshLatestMessagesWhenSettled(sessionId)
            is StreamEvent.MessageCommitted -> refreshCommittedMessages(sessionId)
            else -> Unit
        }

        val publishUpdate: (ConversationUiState) -> ConversationUiState = {
            val executing = event is StreamEvent.MessageStarted ||
                event is StreamEvent.TextBlockDelta ||
                event is StreamEvent.CitationBlockDelta ||
                event is StreamEvent.ThinkingBlockDelta ||
                event is StreamEvent.ToolUseBlockStarted ||
                event is StreamEvent.ToolUseBlockUpdated ||
                event is StreamEvent.ToolUseBlockCompleted ||
                event is StreamEvent.ToolResultBlock ||
                event is StreamEvent.RichContentBlockReceived ||
                event is StreamEvent.ContextRefBlockReceived ||
                event is StreamEvent.AttachmentBlockReceived ||
                event is StreamEvent.ChunkAppended ||
                event is StreamEvent.Reasoning ||
                event is StreamEvent.ToolCall ||
                event is StreamEvent.StepUpdate ||
                event is StreamEvent.SystemNotice
            it.copy(
                isSending = if (event is StreamEvent.Done || event is StreamEvent.Error) false else it.isSending,
                currentPhase = if (executing) AgentPhase.EXECUTING else it.currentPhase,
                currentToolName = when {
                    event is StreamEvent.ToolUseBlockStarted -> event.name
                    event is StreamEvent.ToolUseBlockUpdated -> event.name
                    event is StreamEvent.ToolCall && event.status == StepStatus.RUNNING -> event.name
                    event is StreamEvent.Done || event is StreamEvent.Error || event is StreamEvent.MessageStopped -> null
                    else -> it.currentToolName
                },
            )
        }
        if (event.shouldThrottleProjectorPublish()) {
            publishProjectorThrottled(publishUpdate)
        } else {
            flushPendingProjectorPublish()
            publishProjector(publishUpdate)
        }
        return true
    }

    private fun StreamEvent.shouldThrottleProjectorPublish(): Boolean = when (this) {
        is StreamEvent.TextBlockDelta,
        is StreamEvent.CitationBlockDelta,
        is StreamEvent.ThinkingBlockDelta,
        is StreamEvent.ToolUseBlockUpdated,
        is StreamEvent.ChunkAppended,
        is StreamEvent.Reasoning -> true
        else -> false
    }

    private fun handleStreamEvent(event: StreamEvent, sessionId: String, assistantId: String) {
        if (applyProjectorStreamEvent(event, sessionId)) return
        when (event) {
            StreamEvent.SubscriptionReady -> Unit
            is StreamEvent.OutgoingExecutionStarted -> Unit
            is StreamEvent.MessageStarted -> {
                activeAssistantId = assistantId
                if (pendingOptimisticAssistantId == assistantId) pendingOptimisticAssistantId = null
                event.messageId?.let { assistantIdsByServerMessageId[it] = assistantId }
                updateAssistant(assistantId) {
                    it.copy(
                        isStreaming = true,
                        modelName = event.modelName ?: it.modelName,
                        agentRunId = event.runId ?: it.agentRunId,
                    )
                }
                _uiState.value = _uiState.value.copy(isStreaming = true, currentPhase = AgentPhase.EXECUTING)
            }

            is StreamEvent.TextBlockDelta -> {
                updateAssistant(assistantId) { msg ->
                    val projection = blockProjector.appendText(
                        assistantId = assistantId,
                        messageId = event.messageId,
                        index = event.index,
                        text = event.text,
                        existing = msg.blocksJson,
                    )
                    msg.copy(
                        content = projection.content,
                        blocksJson = projection.blocksJson,
                        isStreaming = true,
                    )
                }
            }

            is StreamEvent.CitationBlockDelta -> {
                updateAssistant(assistantId) { msg ->
                    msg.copy(
                        blocksJson = blockProjector.appendCitation(
                            assistantId = assistantId,
                            messageId = event.messageId,
                            index = event.index,
                            citation = event.citation,
                            existing = msg.blocksJson,
                        ),
                        isStreaming = true,
                    )
                }
            }

            is StreamEvent.ThinkingBlockDelta -> {
                updateAssistant(assistantId) {
                    val projection = blockProjector.appendThinking(
                        assistantId = assistantId,
                        messageId = event.messageId,
                        index = event.index,
                        text = event.text,
                        existing = it.blocksJson,
                    )
                    it.copy(
                        reasoning = projection.reasoning,
                        blocksJson = projection.blocksJson,
                        isStreaming = true,
                    )
                }
            }

            is StreamEvent.ToolUseBlockStarted -> {
                upsertToolStep(
                    assistantId = assistantId,
                    messageId = event.messageId,
                    index = event.index,
                    id = event.toolCallId,
                    name = event.name,
                    input = event.input,
                    output = null,
                    status = StepStatus.RUNNING,
                )
            }

            is StreamEvent.ToolUseBlockUpdated -> {
                upsertToolStep(
                    assistantId = assistantId,
                    messageId = event.messageId,
                    index = event.index,
                    id = event.toolCallId,
                    name = event.name,
                    input = event.input,
                    output = null,
                    status = StepStatus.RUNNING,
                )
            }

            is StreamEvent.ToolUseBlockCompleted -> {
                upsertToolStep(
                    assistantId = assistantId,
                    messageId = event.messageId,
                    index = event.index,
                    id = event.toolCallId,
                    name = event.name,
                    input = event.input,
                    output = null,
                    status = StepStatus.COMPLETED,
                )
            }

            is StreamEvent.ToolResultBlock -> {
                if (!applyToolResultByToolUseId(event)) {
                    val existing = _uiState.value.messages
                        .firstOrNull { it.id == assistantId }
                        ?.agentSteps
                        ?.firstOrNull { it.id == event.toolUseId }
                    upsertToolStep(
                        assistantId = assistantId,
                        messageId = event.messageId,
                        index = event.index,
                        id = event.toolUseId,
                        name = existing?.name.orEmpty(),
                        input = existing?.input,
                        output = event.output,
                        status = if (event.isError) StepStatus.FAILED else StepStatus.COMPLETED,
                        presentationKind = event.presentationKind,
                        presentationPrompt = event.presentationPrompt,
                    )
                }
            }

            is StreamEvent.RichContentBlockReceived -> {
                upsertProjectedBlock(assistantId, event.messageId, event.index, event.block)
            }

            is StreamEvent.ContextRefBlockReceived -> {
                upsertProjectedBlock(assistantId, event.messageId, event.index, event.block)
            }

            is StreamEvent.AttachmentBlockReceived -> {
                upsertProjectedBlock(assistantId, event.messageId, event.index, event.block)
            }

            is StreamEvent.MessageStopped -> {
                updateAssistant(assistantId) {
                    it.copy(isStreaming = false, persistedId = event.persistedId ?: it.persistedId)
                }
                if (activeAssistantId == assistantId) activeAssistantId = null
            }

            is StreamEvent.ObservedUserMessage -> {
                handleObservedUserMessage(event, sessionId)
            }

            is StreamEvent.ChunkAppended -> {
                _uiState.value = _uiState.value.copy(currentPhase = AgentPhase.EXECUTING)
                updateAssistant(assistantId) { it.copy(content = event.fullContent) }
            }

            is StreamEvent.Reasoning -> {
                updateAssistant(assistantId) { it.copy(reasoning = event.fullContent) }
            }

            is StreamEvent.ToolCall -> {
                _uiState.value = _uiState.value.copy(
                    currentPhase = AgentPhase.EXECUTING,
                    currentToolName = if (event.status == StepStatus.RUNNING) event.name else null,
                )
                updateAssistant(assistantId) { msg ->
                    val existing = msg.agentSteps.orEmpty().firstOrNull { it.id == event.id }
                    val step = AgentStep(
                        id = event.id,
                        type = StepType.TOOL_CALL,
                        name = event.name,
                        status = event.status,
                        input = event.input ?: existing?.input,
                        output = event.output ?: existing?.output,
                        durationMs = event.durationMs ?: existing?.durationMs,
                        presentationKind = event.presentationKind ?: existing?.presentationKind,
                        presentationPrompt = event.presentationPrompt ?: existing?.presentationPrompt,
                    )
                    val steps = msg.agentSteps.orEmpty().toMutableList()
                    val idx = steps.indexOfFirst { it.id == event.id }
                    if (idx >= 0) steps[idx] = step else steps.add(step)
                    msg.copy(agentSteps = steps)
                }
            }

            is StreamEvent.StepUpdate -> {
                updateAssistant(assistantId) { msg ->
                    val step = AgentStep(event.id, StepType.STEP, event.description, event.status)
                    val steps = msg.agentSteps.orEmpty().toMutableList()
                    val idx = steps.indexOfFirst { it.id == event.id }
                    if (idx >= 0) steps[idx] = step else steps.add(step)
                    msg.copy(agentSteps = steps)
                }
            }

            is StreamEvent.SystemNotice -> {
                updateAssistant(assistantId) { msg ->
                    val step = AgentStep(
                        id = event.id,
                        type = StepType.SYSTEM_NOTICE,
                        name = event.content,
                        status = StepStatus.COMPLETED,
                        noticeType = event.noticeType,
                    )
                    val steps = msg.agentSteps.orEmpty().toMutableList()
                    steps.add(step)
                    msg.copy(agentSteps = steps)
                }
            }

            is StreamEvent.Done -> {
                val finalContent = event.content.ifEmpty {
                    projector.messages.lastOrNull { it.id == assistantId }?.content ?: ""
                }
                val errorMetadata = buildErrorMetadata(
                    errorClass = event.errorClass,
                    suggestedAction = event.suggestedAction,
                    errorCategory = event.errorCategory,
                    errorCode = event.errorCode,
                    errorMessage = event.errorMessage,
                )
                updateAssistant(assistantId) {
                    it.copy(
                        content = finalContent,
                        isStreaming = false,
                        persistedId = event.messageId,
                        errorCategory = event.errorCategory ?: it.errorCategory,
                        errorCode = event.errorCode ?: it.errorCode,
                        errorClass = event.errorClass ?: it.errorClass,
                        suggestedAction = event.suggestedAction ?: it.suggestedAction,
                        metadata = mergeMetadata(it.metadata, errorMetadata),
                    )
                }
                refreshLatestMessagesWhenSettled(sessionId)
            }

            is StreamEvent.MessagePersisted -> {
                updateAssistant(assistantId) {
                    it.copy(
                        persistedId = event.messageId,
                        isStreaming = false,
                    )
                }
                if (activeAssistantId == assistantId) activeAssistantId = null
                refreshLatestMessagesWhenSettled(sessionId)
            }

            is StreamEvent.MessageCommitted -> {
                updateAssistant(assistantId) {
                    it.copy(
                        serverId = event.serverId ?: it.serverId,
                        persistedId = event.serverId ?: it.persistedId,
                    )
                }
                refreshCommittedMessages(sessionId)
            }

            // W4.5 第二波 B2 物理删 `is StreamEvent.RichContentReceived ->` 分支：
            // StreamEvent 上对应 data class 已删——daemon 不再 emit
            // `agent.stream.rich_content`，工具产出走 ContentBlock `tabtin_rich_content`
            // 块路径由 reassembler 在服务端落库到 blocksJson。流式期 Android 暂走 done
            // 后拉取持久化，Wave 6 起接 6 件套真流式时由 BlockTimeline 渲染。

            is StreamEvent.Error -> {
                val err = event.error
                if (err is AppError.BillingBlocked) {
                    updateAssistant(assistantId) {
                        it.copy(
                            content = err.toUserMessage(context),
                            isStreaming = false,
                            errorCategory = err.errorCategory,
                            errorCode = err.errorCode,
                        )
                    }
                } else {
                    val msg = err.toUserMessage(context)
                    updateAssistant(assistantId) {
                        val errorMetadata = if (err is AppError.AgentExecution) {
                            buildErrorMetadata(
                                errorClass = err.errorClass,
                                suggestedAction = err.suggestedAction,
                                errorCategory = err.errorCategory,
                                errorCode = err.errorCode,
                                errorMessage = err.serverMessage,
                            )
                        } else {
                            emptyMap()
                        }
                        it.copy(
                            content = context.getString(R.string.error_prefix, msg),
                            isStreaming = false,
                            errorCategory = if (err is AppError.AgentExecution) err.errorCategory else it.errorCategory,
                            errorCode = if (err is AppError.AgentExecution) err.errorCode else it.errorCode,
                            errorClass = if (err is AppError.AgentExecution) err.errorClass else it.errorClass,
                            suggestedAction = if (err is AppError.AgentExecution) err.suggestedAction else it.suggestedAction,
                            metadata = mergeMetadata(it.metadata, errorMetadata),
                        )
                    }
                }
            }

            is StreamEvent.LifecycleChanged -> {
                _uiState.value = _uiState.value.copy(currentPhase = event.phase)
            }

            is StreamEvent.AskUser -> {
                val sid = currentSessionId ?: return
                applyAskUser(sid, event)
            }

            is StreamEvent.AskFormRequired -> {
                val sid = currentSessionId ?: return
                if (!singleHitlResolutions.shouldAccept(sid, event.request.requestId)) return
                val existing = _uiState.value.pendingAskForm
                    ?.takeIf { it.request.requestId == event.request.requestId }
                val access = existing?.resolutionAccess?.merging(event.resolutionAccess)
                    ?: event.resolutionAccess
                _uiState.value = _uiState.value.copy(
                    pendingAskForm = PendingAskForm(sid, event.request, access),
                )
            }

            is StreamEvent.RequestApprovalRequired -> {
                val sid = currentSessionId ?: return
                if (!singleHitlResolutions.shouldAccept(sid, event.request.requestId)) return
                val existing = _uiState.value.pendingRequestApproval
                    ?.takeIf { it.request.requestId == event.request.requestId }
                val access = existing?.resolutionAccess?.merging(event.resolutionAccess)
                    ?: event.resolutionAccess
                _uiState.value = _uiState.value.copy(
                    pendingRequestApproval = PendingRequestApproval(sid, event.request, access),
                )
            }

            is StreamEvent.SingleHitlResolved -> {
                convergeSingleHitlResolved(sessionId, event.requestId)
            }

            is StreamEvent.SubagentStreamEvent -> {
                applySubagentStreamEvent(event)
            }

            is StreamEvent.PermissionStatusUpdate -> {
                // 当前 UI 暂未消费——参考 §1.6 注释，保留事件分支不会让 ViewModel 抛错。
            }

            is StreamEvent.PlanApprovalRequired -> {
                // Wave 4 I8：弹出 plan 审批面板。session_id 缺失走 currentSessionId 兜底。
                // 互斥：到来新 plan 审批时清掉旧的 pendingApproval，避免双面板叠在 composer 上方让用户分不清先填哪个。
                val sid = event.sessionId ?: currentSessionId ?: return
                _uiState.value = _uiState.value.copy(
                    pendingPlanApproval = PendingPlanApproval(
                        requestId = event.requestId,
                        sessionId = sid,
                        planDocumentId = event.planDocumentId,
                        planSnapshot = event.planSnapshot,
                        hintAllowedPrompts = event.hintAllowedPrompts,
                    ),
                    pendingApproval = null,
                )
            }

            is StreamEvent.ApprovalRequested -> {
                // v0.4 W1.5-轮 4：写入 pendingApproval（已升格为 batch + actionRequests[]）。
                // 同 session 多个并发审批批次走"覆盖"语义——后到的批次替换前一个；
                // 与 Electron ApprovalPanel 当前形态一致。
                applyApprovalRequested(event)
            }

            is StreamEvent.ApprovalResolved -> {
                val resolvedLocalSubmission = releaseHitlSubmissionForKey(
                    CapsuleInteractionPendingKey.resolvedToolApproval(event.batchId),
                )
                // v0.4 W1.5-轮 4：按 batchId 清掉本地 pending 面板（batch 整体 dismiss）。
                // 跨端 fan-out 时即使本端不是决策发起端也会收到本事件——
                // 通过 batchId 命中本地 pending 来 dismiss，不误清不相关批次。
                //
                // **fan-out 提示**（W1.5-轮 4 自修 · 真实用户视角 Review WARNING-3）：
                // 即使所有条目都是 allow/deny（另一端用户决定的），也给"已由另一设备处理"
                // 的明确提示——避免用户看到面板静默消失而困惑。
                // 同 batch 内 N 条 outcome 取第一个非 allow/deny 的作为优先文案；
                // 全 allow/deny 时走"已在另一设备处理"通用提示。
                val pa = _uiState.value.pendingApproval ?: return
                if (pa.batchId != event.batchId) return
                pendingInteractionRepository.markResolved(
                    kind = "tool_approval",
                    threadId = pa.actionThreadId ?: "chat-session-${currentSessionId ?: return}",
                    requestKey = pa.actionApprovalId ?: pa.batchId,
                )
                approvalExpirationJob?.cancel()
                approvalExpirationJob = null
                val firstUnusual = event.decisions.firstOrNull { d ->
                    d.outcome != "allow" && d.outcome != "deny"
                }?.outcome
                val externalDismissMsg = when (firstUnusual) {
                    "expired" -> context.getString(R.string.chat_approval_resolved_expired)
                    "cancelled" -> context.getString(R.string.chat_approval_resolved_cancelled)
                    "cancelled_by_rollback" -> context.getString(R.string.chat_approval_resolved_rolled_back)
                    else -> {
                        // 仅当本端未在提交中（即非本端发起的决策）时显示通用 fan-out 提示
                        if (!resolvedLocalSubmission) {
                            context.getString(R.string.chat_approval_resolved_elsewhere)
                        } else null
                    }
                }
                _uiState.value = _uiState.value.copy(
                    pendingApproval = null,
                    errorMessage = externalDismissMsg ?: _uiState.value.errorMessage,
                )
            }

            // 子 Agent 卡「双数据源」乐观渲染：
            //  - 源 A（content_block_start tool_use(agent)，早到）→ SubagentOptimisticStarted：
            //    本地合成乐观卡（PENDING/「启动中」+ isOptimistic），按 toolCallId 锚点；
            //  - 源 B（subagent_started 绕 relay，晚到）→ 按 parent_tool_call_id 命中乐观卡
            //    原地升级 RUNNING、填真实 runId/task、清 isOptimistic，不新建第二张卡。
            //  - progress / completed / failed（只带 subagent_run_id）→ 按 runId 命中已升级卡。
            // 合并逻辑全部收敛在纯函数 SubagentCardReducer（单一真相源 + 单测锁回归）；
            // ViewModel 分支只做「拿 agentSteps → 调 reducer → 写回」的薄壳。
            is StreamEvent.SubagentOptimisticStarted -> {
                updateAssistant(assistantId) { msg ->
                    msg.copy(
                        agentSteps = SubagentCardReducer.applyOptimisticStarted(
                            msg.agentSteps.orEmpty(), event.toolCallId, event.task,
                        ),
                    )
                }
            }

            is StreamEvent.SubagentStarted -> {
                updateAssistant(assistantId) { msg ->
                    msg.copy(
                        agentSteps = SubagentCardReducer.applyStarted(
                            steps = msg.agentSteps.orEmpty(),
                            runId = event.id,
                            parentToolCallId = event.parentToolCallId,
                            label = event.label,
                            task = event.task,
                            startedAt = event.startedAt,
                        ),
                    )
                }
            }

            is StreamEvent.SubagentQueued -> {
                updateAssistant(assistantId) { msg ->
                    msg.copy(
                        agentSteps = SubagentCardReducer.applyQueued(
                            steps = msg.agentSteps.orEmpty(),
                            runId = event.id,
                            parentToolCallId = event.parentToolCallId,
                            label = event.label,
                            task = event.task,
                        ),
                    )
                }
            }

            is StreamEvent.SubagentDispatchDismissed -> {
                updateAssistant(assistantId) { msg ->
                    msg.copy(
                        agentSteps = SubagentCardReducer.removeOptimistic(
                            msg.agentSteps.orEmpty(), event.toolCallId,
                        ),
                    )
                }
            }

            is StreamEvent.SubagentProgress -> {
                updateAssistant(assistantId) { msg ->
                    msg.copy(
                        agentSteps = SubagentCardReducer.applyProgress(
                            steps = msg.agentSteps.orEmpty(),
                            runId = event.id,
                            stepCount = event.stepCount,
                            latestTool = event.latestTool,
                            latestSuccess = event.latestSuccess,
                            elapsedMs = event.elapsedMs,
                            toolHistory = event.toolHistory,
                        ),
                    )
                }
            }

            is StreamEvent.SubagentCompleted -> {
                updateAssistant(assistantId) { msg ->
                    msg.copy(
                        agentSteps = SubagentCardReducer.applyCompleted(
                            steps = msg.agentSteps.orEmpty(),
                            runId = event.id,
                            label = event.label,
                            task = event.task,
                            summary = event.summary,
                            endedAt = event.endedAt,
                            stats = event.stats,
                        ),
                    )
                }
            }

            is StreamEvent.SubagentFailed -> {
                updateAssistant(assistantId) { msg ->
                    msg.copy(
                        agentSteps = SubagentCardReducer.applyFailed(
                            steps = msg.agentSteps.orEmpty(),
                            runId = event.id,
                            label = event.label,
                            task = event.task,
                            error = event.error,
                            cancelled = event.failureType == SubagentFailureType.CANCELLED,
                            endedAt = event.endedAt,
                            stats = event.stats,
                        ),
                    )
                }
            }

            is StreamEvent.TodoUpdate -> {
                _uiState.value = _uiState.value.copy(agentTodos = event.todos)
            }

            is StreamEvent.CheckpointFailed -> {
                _checkpointStreamEvents.tryEmit(CheckpointStreamEvent.Failed(event.sessionId))
            }
            is StreamEvent.CheckpointSuccess -> {
                _checkpointStreamEvents.tryEmit(CheckpointStreamEvent.Success(event.sessionId))
            }

            is StreamEvent.ReviewRequired -> {
                _uiState.value = _uiState.value.copy(pendingReview = event.request)
            }

            is StreamEvent.RunCompletedInBackground -> {
                updateAssistant(assistantId) { it.copy(isStreaming = false) }
                val generation = sessionLoadGeneration
                viewModelScope.launch {
                    try {
                        val result = chatRepository.getMessages(sessionId)
                        if (canReplaceMessagesFromHistory(sessionId, generation)) {
                            applyHistoryResult(result) { projector.replaceWithHistory(result.messages) }
                            publishProjector {
                                it.copy(
                                hasMore = result.hasMore,
                                )
                            }
                        }
                    } catch (_: Exception) { }
                }
            }

            is StreamEvent.NeedsResync -> {
                val generation = sessionLoadGeneration
                viewModelScope.launch {
                    try {
                        val result = chatRepository.getMessages(event.sessionId)
                        if (canReplaceMessagesFromHistory(event.sessionId, generation)) {
                            applyHistoryResult(result) { projector.replaceWithHistory(result.messages) }
                            publishProjector {
                                it.copy(
                                hasMore = result.hasMore,
                                )
                            }
                        }
                    } catch (_: Exception) { }
                }
            }

            is StreamEvent.ContentReset -> {
                updateAssistant(assistantId) { msg ->
                    val step = AgentStep(
                        "content-reset-${System.currentTimeMillis()}",
                        StepType.SYSTEM_NOTICE,
                        context.getString(R.string.stream_llm_retrying),
                        StepStatus.RUNNING,
                    )
                    val steps = msg.agentSteps.orEmpty().toMutableList().apply { add(step) }
                    msg.copy(content = "", agentSteps = steps)
                }
            }

            is StreamEvent.PlanProposalReceived,
            is StreamEvent.ModeSwitchProposalReceived,
            is StreamEvent.Compaction,
            StreamEvent.ConnectionInterrupted,
            StreamEvent.ConnectionRestored -> { }
        }
    }

    private fun errorMessage(e: Throwable): String =
        if (e is AppError) e.toUserMessage(context) else (e.localizedMessage ?: e.message ?: "")

    private fun buildErrorMetadata(
        errorClass: String?,
        suggestedAction: String?,
        errorCategory: String?,
        errorCode: String?,
        errorMessage: String?,
    ): Map<String, JsonElement> {
        val hasErrorSignal = listOf(
            errorClass,
            suggestedAction,
            errorCategory,
            errorCode,
            errorMessage,
        ).any { !it.isNullOrBlank() }
        if (!hasErrorSignal) return emptyMap()

        return buildMap {
        put("isErrorMessage", JsonPrimitive(true))
        errorClass?.takeIf { it.isNotBlank() }?.let {
            put("errorClass", JsonPrimitive(it))
            put("error_class", JsonPrimitive(it))
        }
        suggestedAction?.takeIf { it.isNotBlank() }?.let {
            put("suggestedAction", JsonPrimitive(it))
            put("suggested_action", JsonPrimitive(it))
        }
        errorCategory?.takeIf { it.isNotBlank() }?.let {
            put("errorCategory", JsonPrimitive(it))
            put("error_category", JsonPrimitive(it))
        }
        errorCode?.takeIf { it.isNotBlank() }?.let {
            put("errorCode", JsonPrimitive(it))
            put("error_code", JsonPrimitive(it))
        }
        errorMessage?.takeIf { it.isNotBlank() }?.let {
            put("errorMessage", JsonPrimitive(it))
            put("error_message", JsonPrimitive(it))
        }
        }
    }

    private fun mergeMetadata(
        existing: Map<String, JsonElement>?,
        extra: Map<String, JsonElement>,
    ): Map<String, JsonElement>? {
        if (extra.isEmpty()) return existing
        return existing.orEmpty() + extra
    }

    private fun hitlSubmitMessage(
        result: ChatRepository.HitlSubmitResult,
        defaultMessageRes: Int,
    ): String {
        return when (result) {
            ChatRepository.HitlSubmitResult.Success -> ""
            is ChatRepository.HitlSubmitResult.AlreadyConsumed ->
                context.getString(R.string.chat_hitl_already_consumed)
            is ChatRepository.HitlSubmitResult.Failed ->
                when (result.errorCode) {
                    "timeout" -> context.getString(R.string.chat_hitl_timeout)
                    "disconnected" -> context.getString(R.string.chat_hitl_disconnected)
                    "already_consumed" -> context.getString(R.string.chat_hitl_already_consumed)
                    null, "", "unknown_nak" ->
                        result.message?.takeIf { it.isNotBlank() }
                            ?: context.getString(R.string.chat_hitl_unknown_nak)
                    else -> result.message?.takeIf { it.isNotBlank() }
                        ?: context.getString(defaultMessageRes)
                }
        }
    }

    private fun upsertToolStep(
        assistantId: String,
        messageId: String? = null,
        index: Int? = null,
        id: String,
        name: String,
        input: String?,
        output: String?,
        status: StepStatus,
        presentationKind: String? = null,
        presentationPrompt: String? = null,
    ) {
        _uiState.value = _uiState.value.copy(
            currentPhase = AgentPhase.EXECUTING,
            currentToolName = if (status == StepStatus.RUNNING) name else null,
        )
        updateAssistant(assistantId) { msg ->
            val steps = msg.agentSteps.orEmpty().toMutableList()
            val idx = steps.indexOfFirst { it.id == id }
            val previous = steps.getOrNull(idx)
            val step = AgentStep(
                id = id,
                type = StepType.TOOL_CALL,
                name = name,
                status = status,
                input = input ?: previous?.input,
                output = output ?: previous?.output,
                durationMs = previous?.durationMs,
                noticeType = previous?.noticeType,
                subagent = previous?.subagent,
                presentationKind = presentationKind ?: previous?.presentationKind,
                presentationPrompt = presentationPrompt ?: previous?.presentationPrompt,
            )
            if (idx >= 0) steps[idx] = step else steps.add(step)
            msg.copy(
                agentSteps = steps,
                blocksJson = blockProjector.upsertTool(
                    assistantId = assistantId,
                    messageId = messageId,
                    index = index,
                    step = step,
                    existing = msg.blocksJson,
                ),
                isStreaming = status == StepStatus.RUNNING || msg.isStreaming,
            )
        }
    }

    private fun applyToolResultByToolUseId(event: StreamEvent.ToolResultBlock): Boolean {
        val target = blockProjector.toolResultTarget(event, _uiState.value.messages) ?: return false
        upsertToolStep(
            assistantId = target.assistantId,
            // 与 ConversationProjector.ToolResultBlock 同口径：复用命中块的原 key
            // messageId 原地回写，避免信封 messageId 与工具块分属不同消息时
            // （ 终态 mini-message / W4.5 跨消息回灌）复制出第二张同
            // toolUseId 工具块。index 为 null 时本参数不参与。
            messageId = target.blockMessageId,
            index = target.index,
            id = event.toolUseId,
            name = target.existingStep?.name.orEmpty(),
            input = target.existingStep?.input,
            output = event.output,
            status = if (event.isError) StepStatus.FAILED else StepStatus.COMPLETED,
            presentationKind = event.presentationKind,
            presentationPrompt = event.presentationPrompt,
        )
        return true
    }

    private fun upsertProjectedBlock(
        assistantId: String,
        messageId: String?,
        index: Int,
        block: com.tabtin.mobile.data.model.BlockItem,
    ) {
        updateAssistant(assistantId) { msg ->
            msg.copy(
                blocksJson = blockProjector.upsertContentBlock(
                    assistantId = assistantId,
                    messageId = messageId,
                    index = index,
                    block = block,
                    existing = msg.blocksJson,
                ),
                isStreaming = true,
            )
        }
    }

    private fun refreshLatestMessagesWhenSettled(sessionId: String) {
        // ：已确认服务端物理删除 → 整段终态对账跳过（防已撤轮次回灌）。
        // false / 字段缺失不会置 withdrawDeleteConfirmed，仍走下方正常拉历史。
        if (withdrawDeleteConfirmed) return
        reconcileJob?.cancel()
        val generation = sessionLoadGeneration
        reconcileJob = viewModelScope.launch {
            for (delayMs in listOf(600L, 1_600L, 3_000L)) {
                delay(delayMs)
                when (
                    ConversationReconnectPolicy.reconcileTick(
                        sessionMatches = currentSessionId == sessionId,
                        generationMatches = sessionLoadGeneration == generation,
                        streamingActive = isHistoryStreamingActive(),
                        allowWhileStreaming = false,
                    )
                ) {
                    ConversationReconnectPolicy.ReconcileTick.Abort -> return@launch
                    ConversationReconnectPolicy.ReconcileTick.SkipWait -> continue
                    ConversationReconnectPolicy.ReconcileTick.Apply -> Unit
                }
                // 延迟窗口内可能迟到 withdraw_applied=true（ack/done 乱序）。
                if (withdrawDeleteConfirmed) return@launch
                try {
                    val result = chatRepository.getMessages(
                        sessionId = sessionId,
                        preferIncremental = false,
                        preserveCacheOnEmpty = true,
                        advanceWatermark = false,
                    )
                    if (
                        !canReplaceMessagesFromHistory(sessionId, generation) ||
                        result.messages.isEmpty()
                    ) {
                        continue
                    }
                    // 拉历史期间若确认了删除：滤掉已撤 user 及其后内容，再收口，不再重试。
                    if (withdrawDeleteConfirmed) {
                        val filtered = historyForWithdrawReconcile(
                            history = result.messages,
                            exemptWithdrawnClientMessageId = pendingWithdrawClientMessageId,
                        )
                        if (filtered.isNotEmpty()) {
                            applyHistoryResult(result) { projector.replaceWithHistory(filtered) }
                            publishProjector { it.copy(hasMore = result.hasMore) }
                        }
                        return@launch
                    }
                    applyHistoryResult(result) { projector.replaceWithHistory(result.messages) }
                    publishProjector {
                        it.copy(
                            hasMore = result.hasMore,
                        )
                    }
                } catch (_: Exception) { }
            }
        }
    }

    private fun refreshCommittedMessages(sessionId: String) {
        reconcileJob?.cancel()
        val generation = sessionLoadGeneration
        reconcileJob = viewModelScope.launch {
            val delays = listOf(0L, 1_000L, 3_000L)
            for ((index, delayMs) in delays.withIndex()) {
                if (delayMs > 0) delay(delayMs)
                if (!canApplyHistory(sessionId, generation, allowWhileStreaming = true)) return@launch
                try {
                    val result = chatRepository.getMessages(
                        sessionId = sessionId,
                        preferIncremental = false,
                        preserveCacheOnEmpty = true,
                        advanceWatermark = false,
                    )
                    if (
                        canApplyHistory(sessionId, generation, allowWhileStreaming = true) &&
                        result.messages.isNotEmpty()
                    ) {
                        val lastAttempt = index == delays.lastIndex
                        val changed = applyHistoryResult(result) {
                            if (lastAttempt && isHistoryStreamingActive()) {
                                projector.replaceWithHistory(
                                    result.messages,
                                    allowWhileStreaming = true,
                                )
                            } else {
                                projector.mergeCommittedHistory(result.messages)
                            }
                        }
                        if (changed) {
                            publishProjector {
                                it.copy(hasMore = result.hasMore)
                            }
                        } else {
                            _uiState.value = _uiState.value.copy(hasMore = result.hasMore)
                        }
                    }
                } catch (_: Exception) { }
            }
        }
    }

    private fun updateAssistant(assistantId: String, update: (ChatMessage) -> ChatMessage) {
        if (projector.updateAssistant(assistantId, update)) {
            publishProjector()
        }
    }
}

/** 草稿入口与首发防重入的纯判定（View / ViewModel / 单测共用）。 */
public object ConversationDraftFirstSendPolicy {
    /** 打开草稿：空 sessionId，或路由显式 startsNewSession。 */
    public fun isDraftEntry(sessionId: String, startsNewSession: Boolean): Boolean =
        sessionId.isBlank() || startsNewSession

    /** 对齐 iOS beginFirstSend：仅草稿、尚未有 Session、且无进行中首发。 */
    public fun canBeginFirstSend(
        draftMode: Boolean,
        hasSession: Boolean,
        firstSendInFlight: Boolean,
    ): Boolean = draftMode && !hasSession && !firstSendInFlight
}
