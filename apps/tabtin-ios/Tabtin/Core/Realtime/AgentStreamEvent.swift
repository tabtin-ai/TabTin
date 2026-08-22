import Foundation

enum AgentStreamEvent {
    static let actionApprovalRequest = "agent.action.approval_request"
    static let actionApprovalResolved = "agent.action.approval_resolved"
    static let actionApprovalMemoUpdated = "agent.action.approval_memo_updated"
    static let actionApprovalTypes: Set<String> = [
        actionApprovalRequest,
        actionApprovalResolved,
    ]

    /// 旧 action approval 没有 Project execution owner / 脱敏契约，只允许个人
    /// 会话兼容。Project 必须消费 ``agent.stream.approval_requested`` 新协议。
    static func shouldDropLegacyActionApproval(
        _ eventType: String,
        isProjectSession: Bool
    ) -> Bool {
        isProjectSession && actionApprovalTypes.contains(eventType)
    }

    static let lifecycle = "lifecycle"
    static let user = "user"
    /// **C1 范围外（2026-05-13）**：lite-collector 临时桥仍 inject
    /// `agent.stream.assistant(phase='final')` 让 Django relay 写库 ChatMessage；
    /// iOS 不消费这条事件（`StreamManager` dispatcher 已删 assistant case），
    /// 但常量本身保留供 W4c-Django-reconstructor 上线前不出现"幽灵字面量"。
    /// W4c 上线后统一清理。
    static let assistant = "assistant"
    /// **C1 范围外（2026-05-13）**：daemon `query.ts` 仍 emit thinking 步骤事件。
    /// W5 iOS 接 6 件套时把 step 渲染迁到 `content_block_start(thinking)`，再清。
    static let step = "step"
    static let done = "done"
    static let messagePersisted = "message_persisted"
    static let messageCommitted = "message_committed"
    static let todo = "todo"
    static let sshOutput = "ssh_output"
    static let compaction = "compaction"
    static let contextPressure = "context_pressure"
    static let subagentStarted = "subagent_started"
    static let subagentQueued = "subagent_queued"
    static let subagentCompleted = "subagent_completed"
    static let subagentFailed = "subagent_failed"
    static let subagentProgress = "subagent_progress"

    /// content_block 三件套已经过 ws relay 投递到移动端。StreamManager 消费
    /// text_delta / connector_text_delta / thinking_delta 做正文与思考实时上屏；
    /// tool_use(agent/task) 的 input_json_delta 继续用于子 Agent 乐观建卡。
    static let contentBlockStart = "content_block_start"
    static let contentBlockDelta = "content_block_delta"
    static let contentBlockStop = "content_block_stop"
    static let persistError = "persist_error"
    static let systemNotice = "system_notice"
    static let checkpointFailed = "checkpoint_failed"
    static let checkpointSuccess = "checkpoint_success"

    // ── W4.5 第三波 C1（2026-05-13）老协议常量物理删 ──
    // 删除：reasoning / tool / chunk / reviewRequired / contentReset / toolHeartbeat
    // wire 层 `StreamEvents.REASONING/TOOL/CHUNK/REVIEW_REQUIRED/CONTENT_RESET/
    // TOOL_HEARTBEAT` 同步物理删，daemon 0 emit。
    //
    // - reasoning / chunk → 新协议下 `content_block_delta(text_delta /
    //   thinking_delta)` 替代（W5 接 6 件套）。
    // - tool → SYSTEM_NOTICE notice_type='tool_*' 替代（已上线）。
    // - reviewRequired → APPROVAL_REQUESTED batch 替代（W2 已统一）。
    // - contentReset → message_stop(stop_reason='aborted') + 新 message_start 替代。
    // - toolHeartbeat → SYSTEM_NOTICE notice_type='tool_heartbeat' 通用通道替代。
    //
    // W4.5 第二波 B2 物理删 `static let richContent = "rich_content"` ——
    // daemon 0 处真 emit `agent.stream.rich_content`，工具产出统一走
    // ContentBlock `tabtin_rich_content` 块路径（content_block_start +
    // content_block_stop 配对的 detached mini-message，Django reassembler
    // 落库到 ChatMessage.content_blocks_json）。wire 层常量 + Renderer /
    // Android / Django relay 白名单同步清。

    /// `plan_create` 工具落库成功后 emit 的 **非阻断** plan 草稿事件。
    /// 协议源：`packages/agent-wire/src/plan-proposal.ts PlanProposalEventPayloadSchema`
    /// 字段：`plan_document_id` / `session_id?` / `plan_name` / `overview` / `todos[]` /
    /// `description_markdown`。
    /// UI：chat 流里插入一条 `role=system` 的 inline `PlanProposalCard`（执行 + 打开文档）。
    /// LLM 不参与「该不该执行」——「执行」由用户点卡片触发 `POST /api/plan/exit`。
    /// 旧 `plan_approval_required` HITL 链路（含 `localrt.plan_approval_response` 回执）
    /// 已随 runtime `plan_exit` 工具下线整体删除。
    static let planProposal = "plan_proposal"

    /// v0.4 W1.5-轮 4：批量审批请求（仅 `tool_permission`；plan_exit 已删除）。
    /// 协议源：`packages/agent-wire/src/approval.ts ApprovalRequestedPayloadSchema`
    /// payload 形态：`{ batch_id, approval_type='tool_permission', action_requests[], runtime_mode, expires_at, schema_version=1 }`
    /// UI：`UnifiedApprovalPanel`（一张面板列 N 条 actionRequest）。
    /// 提交回执：WS `localrt.user_response`，
    /// `payload.response = { batch_id, decisions: [{tool_call_id, outcome, scope?, request_id}, ...] }`
    static let approvalRequested = "approval_requested"

    /// v0.4 W1.5-轮 4：批量审批已被解析（用户决策 / 超时 / rollback 取消等）。
    /// payload 形态：`{ batch_id, decisions[], rollback_event_id?, schema_version=1 }`
    /// UI：按 batchId 命中本地 pending 面板 dismiss。
    static let approvalResolved = "approval_resolved"

    /// 2026-06-16 协议纠正：ask 三件套并非合一——`ask_user_required` /
    /// `ask_form_required` / `request_approval_required` **三事件并存**
    /// （SSoT `packages/agent-wire/src/events.ts`、`approval.ts`）。三者都走单 request
    /// HITL 管道（回执 `localrt.user_response`），但 payload / 回执形态不同：
    ///   - `ask_user_required`：`{ questions[] }` → 回执 `{ answers }`
    ///   - `ask_form_required`：`{ title, fields[] }` → 回执 `{ field_values }`
    ///   - `request_approval_required`：`{ title, rationale, risk_level }` → 回执 `{ approved }`
    /// 三者公共信封都带 runtime 自动注入的 `request_id`（回执主键）。
    static let askUserRequired = "ask_user_required"
    static let askFormRequired = "ask_form_required"
    static let requestApprovalRequired = "request_approval_required"
    /// ask_user / ask_form / request_approval 的统一终态事件。
    /// payload: { request_id, interrupt_id?, outcome, schema_version }
    static let singleHitlResolved = "single_hitl_resolved"

    /// plan 模式下 Agent 调 `switch_mode` 请求切到 agent 模式时的 **非阻断** 提案事件。
    /// 协议源：`packages/agent-runtime/src/tools/mode-tools.ts` → `packages/agent-wire/src/
    /// mode-switch-proposal.ts ModeSwitchProposalEventPayloadSchema`
    /// 字段：`proposal_id` / `target_mode_id='agent'` / `reason` / `session_id?`。
    /// UI：chat 流里插入一条 `role=system` 的 inline `ModeSwitchProposalCard`（切换 / 忽略）。
    /// 移动端「切换」等价于手动切模式 + 发 continuation 消息（daemon 下一轮按 agent_mode 跑）；
    /// proposal_id 的服务端校验 / HITL 取消 / reminder 注入是 runtime host 内存态，移动端无
    /// 等价 execute 通道（仅 Electron IPC），记为已知限制（见 mobile-issues-overview MB-20）。
    static let modeSwitchProposal = "mode_switch_proposal"

    /// Anthropic message 边界与累计 usage。WireDecoder 已按 SSoT 解码；
    /// message_delta 的 stop_reason / usage 会在 message_stop 时按 message_id 收敛。
    static let messageStart = "message_start"
    static let messageDelta = "message_delta"
    static let messageStop = "message_stop"
    /// 子 Agent 内层实时 transcript 的包装事件。
    static let subagentStreamEvent = "subagent_stream_event"
    /// Monitor 进程状态快照；当前 runtime 可能不 emit，但客户端保留强类型契约。
    static let monitorStatus = "monitor_status"

    static let prefix = "agent.stream."

    static func fullType(_ event: String) -> String {
        return "\(prefix)\(event)"
    }
}
