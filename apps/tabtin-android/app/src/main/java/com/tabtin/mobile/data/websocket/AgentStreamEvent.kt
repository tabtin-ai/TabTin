package com.tabtin.mobile.data.websocket

public object AgentStreamEvent {
    public const val LIFECYCLE: String = "lifecycle"
    public const val USER: String = "user"
    /**
     * **C1 范围外（2026-05-13）**：lite-collector 临时桥仍 inject
     * `agent.stream.assistant(phase='final')` 让 Django relay 写库 ChatMessage；
     * Android 不消费这条事件（StreamManager dispatcher 已删 ASSISTANT case），
     * 但常量本身保留供 W4c-Django-reconstructor 上线前不出现"幽灵字面量"。
     */
    public const val ASSISTANT: String = "assistant"
    /**
     * **C1 范围外（2026-05-13）**：daemon `query.ts` 仍 emit thinking 步骤事件。
     * W6 Android 接 6 件套时把 step 渲染迁到 `content_block_start(thinking)`，再清。
     */
    public const val STEP: String = "step"
    public const val DONE: String = "done"
    public const val MESSAGE_PERSISTED: String = "message_persisted"
    public const val MESSAGE_COMMITTED: String = "message_committed"
    public const val TODO: String = "todo"
    public const val SSH_OUTPUT: String = "ssh_output"
    public const val COMPACTION: String = "compaction"
    public const val CONTEXT_PRESSURE: String = "context_pressure"
    public const val SUBAGENT_STARTED: String = "subagent_started"
    /** 子 Agent 进 BudgetTracker 排队等 active 槽位——独立于 started 的一条事件。 */
    public const val SUBAGENT_QUEUED: String = "subagent_queued"
    public const val SUBAGENT_COMPLETED: String = "subagent_completed"
    public const val SUBAGENT_FAILED: String = "subagent_failed"
    public const val SUBAGENT_PROGRESS: String = "subagent_progress"
    public const val SUBAGENT_STREAM_EVENT: String = "subagent_stream_event"

    // ── Anthropic 6 件套（W3 起 Django relay 转发到 thread topic；见后端
    //    `agent_protocol/constants.py RELAY_ALLOWED_SHORT_NAMES`）──
    // Android 当前**只窄接** `content_block_start` 里 `block.type=='tool_use' &&
    // name∈{agent,task,Task}` 的子 Agent 派发块（源 A，用于子 Agent 卡乐观渲染）。
    // 其余 content_block / message 事件本期一律忽略（不碰主对话渲染，主对话正文
    // 仍走老 `step` / `message_persisted` 路径），等 Wave 5/6 接完整 BlockTimeline
    // 后自然并入。显式列出常量是为了让 `content_block_delta`（1000 token/s 高频）
    // 走 mapEnvelopeToEvent 的 null 分支、不落 `else → Log.d` 高频刷屏。
    public const val MESSAGE_START: String = "message_start"
    public const val MESSAGE_DELTA: String = "message_delta"
    public const val MESSAGE_STOP: String = "message_stop"
    public const val CONTENT_BLOCK_START: String = "content_block_start"
    public const val CONTENT_BLOCK_DELTA: String = "content_block_delta"
    public const val CONTENT_BLOCK_STOP: String = "content_block_stop"
    public const val PERSIST_ERROR: String = "persist_error"
    public const val SYSTEM_NOTICE: String = "system_notice"
    public const val CHECKPOINT_FAILED: String = "checkpoint_failed"
    public const val CHECKPOINT_SUCCESS: String = "checkpoint_success"

    // ── W4.5 第三波 C1（2026-05-13）老协议常量物理删 ──
    // 删除：REASONING / TOOL / CHUNK / REVIEW_REQUIRED / CONTENT_RESET / TOOL_HEARTBEAT
    // wire 层 `StreamEvents.REASONING/TOOL/CHUNK/REVIEW_REQUIRED/CONTENT_RESET/
    // TOOL_HEARTBEAT` 同步物理删，daemon 0 emit。
    //
    // - REASONING / CHUNK → 新协议 `content_block_delta(text_delta / thinking_delta)` 替代
    // - TOOL → SYSTEM_NOTICE notice_type='tool_*' 替代（已上线）
    // - REVIEW_REQUIRED → APPROVAL_REQUESTED batch 替代（W2 已统一）
    // - CONTENT_RESET → message_stop(stop_reason='aborted') + 新 message_start 替代
    // - TOOL_HEARTBEAT → SYSTEM_NOTICE notice_type='tool_heartbeat' 通用通道替代
    // W4.5 第二波 B2 物理删 `public const val RICH_CONTENT: String = "rich_content"` ——
    // daemon 0 处真 emit `agent.stream.rich_content`，工具产出统一走 ContentBlock
    // `tabtin_rich_content` 块（content_block_start + content_block_stop 配对的
    // detached mini-message，由 Django reassembler 落库到 ChatMessage.content_blocks_json）。
    // wire 层常量 + Renderer / iOS / Django relay 白名单同步清。
    //
    // **既存技术债（不属本次 B2 改动，登记 §0.6 跟踪）**：
    // Android `BlockItem.isRichContent` 当前仅判 `type == "rich_content"`，但
    // Django 落库形态已转为 `type == "tabtin_rich_content"`（嵌套 payload 内含
    // widget_id / code / image_url / tool_call_id 等字段）——`ChatMessage.richContentBlocks`
    // 过滤器会把这类持久化块整体过滤掉，富内容卡片不会进入 `RichContentSection`。
    // 这是 Wave 6 Android 接 6 件套真流式之前的既存分叉，需在 §0.6 单列跟踪 mobile
    // BlockItem 形态归一（在 API 解码层或 BlockItem 层把 `tabtin_rich_content` +
    // 嵌套 payload 摊平到 `rich_content` + 顶层字段，与桌面 `legacyBlocksAdapter` 对齐）。

    // Wave 4 (HITL 补全) / v0.4 W1.5-轮 4：与 packages/agent-wire/src/events.ts 严格对齐。
    //   plan_approval_required —— legacy；plan-approval 整套已下线（W11），runtime 不再发，
    //     保留常量供历史 trace event 反序列化兼容
    //     payload: { request_id, session_id?, plan_document_id, plan_snapshot?, hint_allowed_prompts? }
    //     schema 源：packages/agent-wire/src/plan-approval.ts PlanApprovalRequestEventPayloadSchema
    //   approval_requested —— PRD 05 v0.4 批量审批事件（仅 tool_permission；plan_exit 已删）
    //   approval_resolved  —— 与 approval_requested 对称的解析事件（allow / deny / cancelled / expired / cancelled_by_rollback）
    //     schema 源：packages/agent-wire/src/approval.ts ApprovalRequestedPayloadSchema / ApprovalResolvedPayloadSchema
    public const val PLAN_APPROVAL_REQUIRED: String = "plan_approval_required"
    public const val PLAN_PROPOSAL: String = "plan_proposal"
    public const val MODE_SWITCH_PROPOSAL: String = "mode_switch_proposal"
    public const val APPROVAL_REQUESTED: String = "approval_requested"
    public const val APPROVAL_RESOLVED: String = "approval_resolved"

    // W4 R3（2026-05-11）：ask 三件套并存。
    // - ASK_USER_REQUIRED：ask_user 工具（multi-choice）
    // - ASK_FORM_REQUIRED：ask_form 工具（多字段填表，TabTin HITL 扩展）
    // - REQUEST_APPROVAL_REQUIRED：request_approval 工具（已决方案审批）
    // schema 源：packages/agent-wire/src/approval.ts
    public const val ASK_USER_REQUIRED: String = "ask_user_required"
    public const val ASK_FORM_REQUIRED: String = "ask_form_required"
    public const val REQUEST_APPROVAL_REQUIRED: String = "request_approval_required"
    public const val SINGLE_HITL_RESOLVED: String = "single_hitl_resolved"

    public const val PREFIX: String = "agent.stream."

    public fun fullType(event: String): String = "$PREFIX$event"
}
