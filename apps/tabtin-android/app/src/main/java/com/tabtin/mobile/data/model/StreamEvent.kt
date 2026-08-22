package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

public sealed class StreamEvent {
    /** 当前会话的实时订阅已经由服务端确认，可安全开始做跨端阅读水位确认。 */
    public data object SubscriptionReady : StreamEvent()
    public data class OutgoingExecutionStarted(val sourceClientEventId: String) : StreamEvent()
    public data class LifecycleChanged(val phase: AgentPhase, val runId: String?) : StreamEvent()
    public data class MessageStarted(
        val messageId: String?,
        /** `message_start.agent_id`：当前这一条回复的权威执行 Agent。 */
        val agentId: String? = null,
        val runId: String? = null,
        val modelId: String? = null,
        val modelName: String? = null,
        val sourceClientEventId: String? = null,
        /**
         * `message_start.role`：正常助手回复为 "assistant"。后台命令（如文生图 CLI）
         * 终结时客户端 relay 的终态 mini-message 为 "user"，投影层据此跳过气泡认建。
         * 旧事件不带该字段时为 null，按既有行为处理。
         */
        val role: String? = null,
    ) : StreamEvent()
    public data class TextBlockDelta(
        val messageId: String?,
        val index: Int,
        val text: String,
    ) : StreamEvent()
    public data class CitationBlockDelta(
        val messageId: String?,
        val index: Int,
        val citation: kotlinx.serialization.json.JsonElement,
    ) : StreamEvent()
    public data class ThinkingBlockDelta(
        val messageId: String?,
        val index: Int,
        val text: String,
        val completed: Boolean = false,
    ) : StreamEvent()
    public data class ToolUseBlockStarted(
        val messageId: String?,
        val index: Int,
        val toolCallId: String,
        val name: String,
        val input: String? = null,
    ) : StreamEvent()
    public data class ToolUseBlockUpdated(
        val messageId: String?,
        val index: Int,
        val toolCallId: String,
        val name: String,
        val input: String,
    ) : StreamEvent()
    public data class ToolUseBlockCompleted(
        val messageId: String?,
        val index: Int,
        val toolCallId: String,
        val name: String,
        val input: String?,
    ) : StreamEvent()
    public data class ToolResultBlock(
        val messageId: String?,
        val index: Int,
        val toolUseId: String,
        val output: String?,
        val isError: Boolean,
        val presentationKind: String? = null,
        val presentationPrompt: String? = null,
    ) : StreamEvent()
    public data class RichContentBlockReceived(
        val messageId: String?,
        val index: Int,
        val block: BlockItem,
    ) : StreamEvent()
    public data class ContextRefBlockReceived(
        val messageId: String?,
        val index: Int,
        val block: BlockItem,
    ) : StreamEvent()
    public data class AttachmentBlockReceived(
        val messageId: String?,
        val index: Int,
        val block: BlockItem,
    ) : StreamEvent()
    public data class MessageStopped(
        val messageId: String?,
        val persistedId: String? = null,
        /** ：来自 message_delta.stop_reason 或 message_stop；ABORT 时为 aborted。 */
        val stopReason: String? = null,
        /** ：来自 message_stop.error_info.error_class。 */
        val errorClass: String? = null,
        /** ：来自 message_stop.error_info.category。 */
        val errorCategory: String? = null,
    ) : StreamEvent()
    public data class ObservedUserMessage(
        val id: String,
        val content: String,
        val clientEventId: String? = null,
        val serverMessageId: String? = null,
        val senderUserId: String? = null,
        val senderDisplayName: String? = null,
        val triggeredBy: String? = null,
    ) : StreamEvent()
    public data class ChunkAppended(val content: String, val fullContent: String) : StreamEvent()
    public data class Reasoning(val content: String, val fullContent: String) : StreamEvent()
    public data class ToolCall(
        val id: String,
        val name: String,
        val input: String?,
        val output: String?,
        val status: StepStatus,
        val durationMs: Int? = null,
        /** lifecycle / tool_result 的 presentation.kind；文生图为 media_image_generation。 */
        val presentationKind: String? = null,
        val presentationPrompt: String? = null,
    ) : StreamEvent()
    public data class StepUpdate(val id: String, val description: String, val status: StepStatus) : StreamEvent()
    public data class SystemNotice(val id: String, val content: String, val noticeType: String?) : StreamEvent()
    /** `agent.stream.compaction` phase=start/end；UI 展示「正在压缩上下文…」pill。 */
    public data class Compaction(
        val phase: String,
        val mode: String? = null,
    ) : StreamEvent()
    public data class MessagePersisted(
        val messageId: String,
        val content: String,
        val messageIds: List<MessageIdMapping> = emptyList(),
    ) : StreamEvent()
    public data class MessageCommitted(
        val messageId: String,
        val serverId: String?,
        val partial: Boolean = false,
    ) : StreamEvent()
    public data class Done(
        val messageId: String?,
        val content: String,
        val taskId: String? = null,
        val sourceClientEventId: String? = null,
        val isError: Boolean = false,
        val errorClass: String? = null,
        val suggestedAction: String? = null,
        val errorCategory: String? = null,
        val errorCode: String? = null,
        val errorMessage: String? = null,
        /** ：agent.stream.done.stop_reason；用户 Stop 时为 aborted。 */
        val stopReason: String? = null,
        /**
         * ：服务端对未答轮次撤回的权威结果（可选）。
         * true=已物理删除 → 客户端豁免终态对账；false=复判拒绝 → 正常 reconcile 回拉；
         * null=旧后端未下发该字段。
         */
        val withdrawApplied: Boolean? = null,
    ) : StreamEvent()
    public data class Error(val error: AppError) : StreamEvent()
    /**
     * Wave 6 S7：扩充子 Agent 事件字段。对齐 iOS [StreamEvent.subagentStarted]。
     * 服务端 `agent.stream.subagent_started` payload 可能带 label / task / started_at，
     * 以前只读 name（label），其它字段被 ViewModel 形成 subagent card 时缺失。
     */
    public data class SubagentStarted(
        val id: String,
        /** 取 payload.label；向后兼容读 payload.name。 */
        val label: String?,
        val task: String?,
        val startedAt: Double?,
        /**
         * 源 B 顶替锚点：父 LLM `tool_use(agent)` 块 id（payload.parent_tool_call_id，
         * = 源 A content_block_start 的 `block.id`，见 `agent-tool.ts:818`）。主 Agent 直接
         * 派的子 = 该值；嵌套孙 Agent = 上一层子的 tool_use id。缺失（legacy）时退回按 runId 建卡。
         */
        val parentToolCallId: String? = null,
    ) : StreamEvent()

    /**
     * 源 A（乐观）：主 LLM 流里 `content_block_start` 携带 `block.type=='tool_use' &&
     * name∈{agent,task,Task}` 的子 Agent 派发块——比源 B（`subagent_started` 绕 relay）
     * 早一拍到达。StreamManager 窄接此一类 content_block，ConversationViewModel 据此本地
     * 合成乐观卡（status=PENDING/「启动中」+ isOptimistic）消除「派子任务→空白窗口」。
     * [toolCallId] = `block.id`（LLM 原生 id，**非** envelope 的 block_id），与源 B 的
     * parent_tool_call_id 同值，用于后续顶替。[task] 为 start 时 input 里能直接提取的任务
     * 摘要（多数情况 start 时 input 为空，留 null 等源 B 的 task 补）。
     */
    public data class SubagentOptimisticStarted(
        val toolCallId: String,
        val task: String?,
    ) : StreamEvent()

    /**
     * 服务端 `subagent_queued`：子 Agent 进 BudgetTracker 排队等 active 槽位。独立于
     * `subagent_started`，多数在 started 之前到达。只把「尚未开跑」的卡置 QUEUED，
     * 已 RUNNING / 终态不被排队事件降级（对齐 iOS `applySubagent(.queued)`）。
     */
    public data class SubagentQueued(
        val id: String,
        val label: String?,
        val task: String?,
        /**
         * 顶替锚点：父 LLM `tool_use(agent)` 块 id（payload.parent_tool_call_id，= 源 A
         * content_block_start 的 block.id）。queued 多在 started 前、源 A 之后到达——必须按此
         * 命中源 A 乐观卡原地置 QUEUED，否则只按 runId 命中会另建一张卡造成重复（issue 复盘）。
         */
        val parentToolCallId: String? = null,
    ) : StreamEvent()

    /**
     * `agent(check_agent_id=...)` 是纯状态查询、不派发新子 Agent，却同样以 `tool_use(agent)`
     * 块流式到达——源 A 会先给它建一张乐观卡，且后续没有 started/completed 收尾，卡片会僵在
     * 「启动中」。content_block_stop 时若判定累积 input 为 check 调用，用本事件把这张 **仍处于
     * 乐观态** 的卡撤掉（对齐 iOS/Electron `isSubagentDispatchInput`，）。
     */
    public data class SubagentDispatchDismissed(
        val toolCallId: String,
    ) : StreamEvent()
    /**
     * Wave 6 S7 / 跨端协议验证：补 summary / endedAt / stats 字段。原 `result` 字段被
     * summary 替代但 runtime 旧 payload 仍可能 emit `result`，handler 会二选一。
     *
     * stats 字段对齐 Electron `SubagentCardData.stats`（`agent-tool.ts SUBAGENT_COMPLETED`
     * 出 `stats.{duration_ms, input_tokens, output_tokens, total_tokens, credits_consumed}`），
     * 与 iOS [StreamEvent.subagentCompleted] 同口径。
     */
    public data class SubagentCompleted(
        val id: String,
        val label: String?,
        val task: String?,
        val summary: String?,
        val endedAt: Double?,
        val stats: SubagentRunStats? = null,
    ) : StreamEvent()
    /**
     * Wave 6 跨端协议验证：SUBAGENT_FAILED 也带 ended_at + stats（见
     * `agent-tool.ts` 行 660-669），原实现完全丢弃，导致回放历史时长漂移、
     * 计费透明度缺失。本轮与 SUBAGENT_COMPLETED 走同一解析路径。
     */
    public data class SubagentFailed(
        val id: String,
        val label: String,
        val task: String?,
        val error: String,
        val failureType: SubagentFailureType,
        val endedAt: Double?,
        val stats: SubagentRunStats? = null,
    ) : StreamEvent()
    /**
     * Wave 6 S7：progress 扩充 latestSuccess / elapsedMs / toolHistory。
     * toolHistory 为空时不覆盖已有历史（事件乱序/补发场景）。
     */
    public data class SubagentProgress(
        val id: String,
        val latestTool: String?,
        val stepCount: Int?,
        val latestSuccess: Boolean?,
        val elapsedMs: Int?,
        val toolHistory: List<SubagentToolStep>,
    ) : StreamEvent()
    /**
     * `agent.stream.subagent_stream_event` 的内层事件。payload.child_event 是子 Agent
     * 自己的一条 `agent.stream.*` envelope；StreamManager 使用每个 run 独立的 accumulator
     * 先解成现有 StreamEvent，再由 ViewModel 写入子 Agent transcript，避免污染主会话流。
     */
    public data class SubagentStreamEvent(
        val runId: String,
        val parentRunId: String?,
        val subagentChain: List<String>,
        val childEvent: StreamEvent,
    ) : StreamEvent()
    public data class TodoUpdate(val todos: List<AgentTodoItem>) : StreamEvent()
    public data class AskUser(
        val messageId: String?,
        /**
         * HITL 请求 ID，用于 `localrt.user_response` 回执。
         * 取自 envelope payload 的 request_id → interrupt_id → message_id（首个非空）。
         */
        val hitlRequestId: String?,
        val questions: List<AskUserQuestion>,
        val title: String? = null,
        val resolutionAccess: HitlResolutionAccess = HitlResolutionAccess.Unrestricted,
    ) : StreamEvent()
    public data class AskFormRequired(
        val request: AskFormRequest,
        val resolutionAccess: HitlResolutionAccess = HitlResolutionAccess.Unrestricted,
    ) : StreamEvent()
    public data class RequestApprovalRequired(
        val request: RequestApprovalRequest,
        val resolutionAccess: HitlResolutionAccess = HitlResolutionAccess.Unrestricted,
    ) : StreamEvent()
    /** ask_user / ask_form / request_approval 共用的 request_id 终态。 */
    public data class SingleHitlResolved(
        val requestId: String,
        val outcome: String?,
    ) : StreamEvent()
    public data class CheckpointFailed(val sessionId: String) : StreamEvent()
    public data class CheckpointSuccess(val sessionId: String) : StreamEvent()
    public data class ReviewRequired(val request: ReviewRequestState) : StreamEvent()
    /**
     * Wave 1：lifecycle.phase=permission_timeout_warning/pause/timeout 抽出的语义事件。
     * UI 层据此更新被审批 tool 的等待状态指示（暂停/已过期）。当前 ConversationViewModel
     * 暂未消费，保留事件类型保证 StreamManager 编译通过且未来扩展可直接落地。
     */
    public data class PermissionStatusUpdate(
        val requestId: String,
        val expired: Boolean,
        val paused: Boolean,
    ) : StreamEvent()
    // W4.5 第二波 B2 物理删 `public data class RichContentReceived(...)` ——
    // 老 `agent.stream.rich_content` 事件 daemon 0 emit，工具产出统一走
    // ContentBlock `tabtin_rich_content` 块（content_block_start +
    // content_block_stop 配对，由服务端 reassembler 落库到
    // ChatMessage.content_blocks_json）。Android 流式期暂未消费 6 件套，仅靠
    // `done` 后 message_persisted 拉持久化——既存技术债见
    // `AgentStreamEvent.kt` 中 `RICH_CONTENT` 注释。
    public data object ContentReset : StreamEvent()
    public data object ConnectionInterrupted : StreamEvent()
    public data object ConnectionRestored : StreamEvent()
    public data class RunCompletedInBackground(val runId: String, val status: String) : StreamEvent()
    public data class NeedsResync(val sessionId: String) : StreamEvent()

    /**
     * Wave 4 I8：plan.exit 工具发起的 plan 审批请求。
     * 协议源：packages/agent-wire/src/plan-approval.ts PlanApprovalRequestEventPayloadSchema
     * 必填：requestId / planDocumentId
     * UI 行为参照 Electron PlanApprovalNotice.tsx + PlanApprovalDialog
     * 提交回执：localrt.plan_approval_response（W7a Daemon 严格 camelCase）
     */
    public data class PlanApprovalRequired(
        val requestId: String,
        /** 一般为当前 chat session（与 thread_id 对应）；服务端可不带，Android 用 activeSessionId 兜底 */
        val sessionId: String?,
        val planDocumentId: String,
        /** 服务端预填的 plan 快照（name / overview / todos / description_markdown） */
        val planSnapshot: PlanApprovalSnapshot? = null,
        val hintAllowedPrompts: List<String> = emptyList(),
    ) : StreamEvent()

    public data class PlanProposalReceived(
        val proposal: PlanProposal,
    ) : StreamEvent()

    public data class ModeSwitchProposalReceived(
        val proposal: ModeSwitchProposal,
    ) : StreamEvent()

    /**
     * v0.4 W1.5-轮 4：批量审批请求（仅 tool_permission；plan_exit 已删除）。
     * 协议源：packages/agent-wire/src/approval.ts ApprovalRequestedPayloadSchema
     *
     * payload 升格为 batch_id + action_requests[]：mobile UI 一张面板列 N 条
     * actionRequest，整批同 outcome 提交（个体逐条勾选 / 不同 outcome 登记 §9
     * 留待后续 mobile UX wave）。
     *
     * 提交回执：WS `localrt.user_response`，response payload 形态：
     *   `{ batch_id, decisions: [{tool_call_id, outcome, scope?, request_id}, ...] }`
     * 与 wire `LocalRtUserResponsePayloadSchema` 严格对齐；纯 batch 形态，
     * **不带** `approved` 兼容字段（D6 一刀切）。
     */
    public data class ApprovalRequested(
        /** v0.4：批 id（runtime UUID）；同 batch 多条 actionRequest 共享 */
        val batchId: String,
        /** v0.4：唯一值 'tool_permission'（保留 discriminator 字段供未来扩展） */
        val approvalType: String,
        /** v0.4：N >= 1 的 action 数组，UI 列出每条让用户能审视具体审批的工具 */
        val actionRequests: List<ApprovalActionRequest>,
        /** 'interactive' | 'solo' | 'scheduled' | 'batch' */
        val runtimeMode: String?,
        /** 过期时间（ms epoch）；UI 倒计时用 */
        val expiresAtMs: Long?,
        /** 旧 agent.action.approval_request 来源：非空时提交走 agent.action.approval_response。 */
        val actionApprovalId: String? = null,
        val actionThreadId: String? = null,
        val resolutionAccess: HitlResolutionAccess = HitlResolutionAccess.Unrestricted,
    ) : StreamEvent()

    /**
     * v0.4 W1.5-轮 4：批量审批已被解析（用户决策 / 超时 / rollback 取消等）。
     * 协议源：packages/agent-wire/src/approval.ts ApprovalResolvedPayloadSchema
     * payload 形态：{ batch_id, decisions[], rollback_event_id?, schema_version=1 }
     * UI：按 batchId 命中本地 pending 面板 dismiss。
     */
    public data class ApprovalResolved(
        val batchId: String,
        val decisions: List<ApprovalResolvedDecision>,
        val rollbackEventId: String?,
    ) : StreamEvent()
}

public data class MessageIdMapping(
    val clientEventId: String,
    val serverId: String,
)

/**
 * v0.4 W1.5-轮 4：单条 ActionRequest（同 batch 多条共享 batchId）。
 * 字段命名与 wire `ApprovalActionRequestSchema` 对齐。
 */
public data class ApprovalActionRequest(
    val requestId: String,
    val toolCallId: String,
    val toolName: String,
    val toolNamespace: String?,
    val toolInputJson: String?,
    val decisionReasonType: String?,
    /**
     * L-W6-16（2026-05-03 W6 M4）：`decision_reason` 里常用字段的 string 形态提取，
     * 供 UI 按 type 插值到 strings_chat.xml 模板（pattern / path / category / key /
     * server / device_action 等）。不包含 createdAt / specificity / kind / mode 等
     * 非文案字段（未来需要时再加）。
     *
     * 与 iOS `UnifiedActionRequest.decisionReasonFields` 对齐；协议源见
     * `packages/agent-wire/src/approval.ts DecisionReasonSchema`。
     */
    val decisionReasonFields: Map<String, String>?,
    val askHintSummary: String?,
    val askHintSuggestedScope: String?,
    val allowedScopes: List<String>,
    val allowedOutcomes: List<String>,
    val riskLevel: String?,
    val workspaceZone: String?,
)

/**
 * v0.4 W1.5-轮 4：单条 approval_resolved 决策。
 * 字段命名与 wire `ApprovalDecisionSchema` 对齐。
 */
public data class ApprovalResolvedDecision(
    val requestId: String,
    val toolCallId: String,
    val outcome: String,
    val scope: String?,
    val rejectionMessage: String?,
    val patternKey: String?,
    val scopeDescription: String?,
    val decisionKind: String?,
)

/**
 * plan_approval_required.payload.plan_snapshot 的 Android 镜像。
 * 字段命名沿用协议（snake_case 来自 wire；这里转成 Kotlin 风格，
 * 但保持对 wire 字段语义的字面对应）。
 */
public data class PlanApprovalSnapshot(
    val name: String,
    val overview: String,
    val descriptionMarkdown: String,
    val todos: List<PlanApprovalTodo> = emptyList(),
)

public data class PlanApprovalTodo(
    val id: String,
    val content: String,
    val status: String,
)

public data class PlanProposal(
    val planDocumentId: String,
    val sessionId: String?,
    val planName: String,
    val overview: String,
    val descriptionMarkdown: String,
    val todos: List<PlanProposalTodo> = emptyList(),
)

public data class PlanProposalTodo(
    val id: String,
    val content: String,
    val status: String,
)

@Serializable
public data class PlanExitRequest(
    @SerialName("plan_document_id") val planDocumentId: String,
    val outcome: String,
)

@Serializable
public data class PlanExitResponse(
    @SerialName("approved_plan_markdown") val approvedPlanMarkdown: String? = null,
)

public data class ModeSwitchProposal(
    val proposalId: String,
    val sessionId: String?,
    val targetModeId: String,
    val reason: String,
)

/**
 * W4 (2026-05-11): ask 三件套合一为单 ask_user。
 * - header：可选 chip 标签（≤12 字符）
 * - description：必填，每个 option 的解释
 * - preview：可选预览（mockup / code snippet）
 */
public data class AskUserQuestion(
    val id: String,
    val text: String,
    val options: List<AskUserOption>,
    val allowMultiple: Boolean,
    val allowFreeText: Boolean,
    val header: String? = null,
)

public data class AskUserOption(
    val id: String,
    val label: String,
    val description: String? = null,
    val preview: String? = null,
)

public data class AskFormRequest(
    val requestId: String,
    val title: String,
    val submitLabel: String? = null,
    val fields: List<AskFormField>,
)

public data class AskFormField(
    val key: String,
    val label: String,
    val type: String,
    val description: String? = null,
    val placeholder: String? = null,
    val required: Boolean = false,
    val options: List<AskFormOption> = emptyList(),
)

public data class AskFormOption(
    val id: String,
    val label: String,
    val description: String? = null,
)

public data class RequestApprovalRequest(
    val requestId: String,
    val title: String,
    val rationale: String,
    val riskLevel: String,
    val submitLabel: String? = null,
    val declineLabel: String? = null,
)

public enum class SubagentFailureType { ERROR, CANCELLED, TIMEOUT }

public enum class TodoStatus {
    PENDING, IN_PROGRESS, PAUSED, COMPLETED, CANCELLED;

    public companion object {
        public fun fromString(s: String): TodoStatus = when (s.lowercase()) {
            "in_progress" -> IN_PROGRESS
            "paused" -> PAUSED
            "completed" -> COMPLETED
            "cancelled" -> CANCELLED
            else -> PENDING
        }
    }
}

public data class AgentTodoItem(
    val id: String,
    val content: String,
    val status: TodoStatus,
)

public data class ReviewActionRequest(
    val id: String,
    val toolName: String,
    val toolCallId: String?,
    val arguments: String?,
    val description: String?,
    /** v0.4 W1.5：单条审批 id（从 wire `request_id` 解析；提交决策时按条带回） */
    val requestId: String? = null,
)

public data class ReviewConfig(
    val actionName: String,
    val allowedDecisions: List<String>,
)

public data class ReviewRequestState(
    val threadId: String,
    val interruptId: String?,
    val messageId: String?,
    /**
     * HITL 请求 ID，用于 `localrt.user_response` 回执。
     * 取自 envelope payload 的 request_id → interrupt_id → message_id（首个非空）。
     * v0.4 W1.5：保留作向后兼容；新代码用 [batchId]。
     */
    val hitlRequestId: String?,
    /**
     * v0.4 W1.5：批 id（PRD §7.4 / §7.10）；提交时作 Redis SETNX 仲裁键。
     */
    val batchId: String? = null,
    val actionRequests: List<ReviewActionRequest>,
    val reviewConfigs: List<ReviewConfig>,
    val message: String?,
)

// W4 (2026-05-11): AskUserPresetField / AskUserFieldOption 已删除——ask_form 形态下线，
// 合一后只有 questions[] + options[] 形态。
