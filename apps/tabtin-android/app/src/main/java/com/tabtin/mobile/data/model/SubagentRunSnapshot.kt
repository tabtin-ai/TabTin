package com.tabtin.mobile.data.model

/**
 * Wave 6 S7 — 子 Agent 运行态快照。对齐 iOS [SubagentRunSnapshot] + Electron `SubagentCardData`。
 *
 * 设计决策：
 *  - 状态 snapshot 挂在对应 [AgentStep] 上（type = [StepType.SUBAGENT]）；不单独维护活跃
 *    run 集合。这样历史会话从 `blocks_json` / 持久化的 `agentSteps` 还原后 UI 可直接画卡片。
 *  - 事件乱序友好：每个 subagent 字段使用"非 null 才覆盖"策略——后到的 progress 不会把先到
 *    的 completed summary 清掉。
 *  - [durationMs] 优先取服务端 `stats.duration_ms`，否则 `elapsedMs`，最后回落 started/ended 差。
 */
public data class SubagentRunSnapshot(
    val runId: String,
    val label: String? = null,
    val task: String? = null,
    val status: Status = Status.PENDING,
    /** Unix timestamp，服务端可能是秒或毫秒；消费端按 > 1e12 判定为 ms 做归一化。 */
    val startedAt: Double? = null,
    val endedAt: Double? = null,
    /** SUBAGENT_PROGRESS.elapsed_ms，运行中的累计耗时（ms）。 */
    val elapsedMs: Int? = null,
    /** 累计工具调用步数（含失败）。 */
    val stepCount: Int? = null,
    /** 最近一次工具调用名。running 态 header 显示 "步骤 N · tool_name"。 */
    val latestTool: String? = null,
    /** 最近一次工具调用成功态，UI header 里加个 ✓/✗。 */
    val latestSuccess: Boolean? = null,
    /** 结构化工具历史（展开面板渲染）。 */
    val toolHistory: List<SubagentToolStep> = emptyList(),
    /** completed 时的摘要。 */
    val summary: String? = null,
    /** failed/cancelled 的错误说明。 */
    val error: String? = null,
    /** SUBAGENT_FAILED payload.status == "cancelled" 时走"已取消"语义而非"失败"。 */
    val cancelled: Boolean = false,
    /**
     * Wave 6 跨端协议验证：服务端 `SUBAGENT_COMPLETED` / `SUBAGENT_FAILED` 携带的
     * token / 计费统计。对齐 Electron `SubagentCardData.stats` + iOS
     * `SubagentRunSnapshot.stats`，让计费透明度在移动端也能展示。
     */
    val stats: SubagentRunStats? = null,
    /**
     * 乐观卡锚点 = 父 LLM `tool_use(agent)` 块的 `block.id`（= `SUBAGENT_STARTED.parent_tool_call_id`，
     * 见 `agent-tool.ts:818`）。两条数据源（源 A content_block_start / 源 B subagent_started）
     * 用它对齐到同一张卡：源 A 先到时本地合成乐观卡，源 B 到达后按本字段命中并原地升级，
     * 不新建第二张卡。legacy（源 B 缺 parent_tool_call_id）时为空，退回按 runId 建卡。
     */
    val parentToolCallId: String? = null,
    /**
     * 乐观占位标记：仅由源 A（content_block_start tool_use(agent)）本地合成时为 true，
     * 源 B（subagent_started）到达后清为 false。只在实时流出现——content_block 事件
     * 不进历史持久化还原路径，故历史回看不会造乐观卡（诚实性门禁）。
     */
    val isOptimistic: Boolean = false,
    /**
     * 子 Agent 内层实时 transcript，来自 `subagent_stream_event.child_event`。
     * 与 iOS SubagentRun.transcript 同语义：每个 run 独立折叠自己的正文、思考、
     * 工具调用和系统提示，不写入主消息流。
     */
    val transcript: List<SubagentTranscriptItem> = emptyList(),
) {
    /**
     * QUEUED = 进 BudgetTracker 排队等 active 槽位（服务端独立事件 `subagent_queued`，
     * 非 started 的一个 status）。对齐 iOS `SubagentStatus.queued` + Electron `queued`。
     */
    public enum class Status { PENDING, QUEUED, RUNNING, COMPLETED, FAILED, CANCELLED }

    /**
     * 估算总时长：优先 stats.durationMs（服务端权威值）→ elapsedMs → (endedAt - startedAt)。
     * 与 iOS [SubagentRunSnapshot.durationMs] 决策树一致；只在 stats 缺失时才做客户端兜底。
     */
    val durationMs: Int?
        get() {
            stats?.durationMs?.takeIf { it > 0 }?.let { return it }
            if (elapsedMs != null && elapsedMs > 0) return elapsedMs
            if (startedAt != null && endedAt != null && endedAt > startedAt) {
                val normStart = if (startedAt > 1e12) startedAt / 1000.0 else startedAt
                val normEnd = if (endedAt > 1e12) endedAt / 1000.0 else endedAt
                return ((normEnd - normStart) * 1000.0).toInt()
            }
            return null
        }
}

public data class SubagentTranscriptItem(
    val id: String,
    val messageId: String? = null,
    val index: Int? = null,
    val kind: Kind,
    val title: String? = null,
    val text: String? = null,
    val inputText: String? = null,
    val outputText: String? = null,
    val isFinal: Boolean = false,
    val isError: Boolean = false,
    val toolCallId: String? = null,
    /** 富内容原始块。保留资源身份，供子 Agent 详情与任务工作台共同投影。 */
    val richContent: BlockItem? = null,
) {
    public enum class Kind {
        ASSISTANT,
        THINKING,
        TOOL,
        RICH_CONTENT,
        CONTEXT_REF,
        SYSTEM,
        ERROR,
    }
}

/**
 * Wave 6 跨端协议验证 — 子 Agent token / 计费统计快照。
 * 对齐 Electron `SubagentCardData.stats` 与 iOS [SubagentRunStats]：
 * `{ duration_ms, input_tokens, output_tokens, total_tokens, credits_consumed }`。
 *
 * 单位与服务端一致：duration 是毫秒，token 是数量，credits 是积分（保留为浮点
 * 兼容服务端按浮点累加的 BudgetTracker scope.credits）。
 */
public data class SubagentRunStats(
    val durationMs: Int? = null,
    val inputTokens: Int? = null,
    val outputTokens: Int? = null,
    val totalTokens: Int? = null,
    val creditsConsumed: Double? = null,
) {
    /** 是否包含任何可展示字段。空 stats 不渲染 UI 行，避免出现"消耗 0 点券"误导。 */
    val isEmpty: Boolean
        get() = durationMs == null && inputTokens == null && outputTokens == null
            && totalTokens == null && creditsConsumed == null
}

/**
 * Wave 6 S7 — 子 Agent 工具调用结构化记录。对齐 iOS [SubagentToolStep] + Electron。
 */
public data class SubagentToolStep(
    val toolName: String,
    val toolCallId: String? = null,
    val success: Boolean,
    val elapsedMs: Int,
    val inputSummary: String? = null,
    val outputSummary: String? = null,
    val inputDetail: String? = null,
    val outputDetail: String? = null,
    val error: String? = null,
) {
    /** 稳定 id；UI 列表 key 用。 */
    val stableId: String get() = toolCallId ?: "$toolName-$elapsedMs"
}
