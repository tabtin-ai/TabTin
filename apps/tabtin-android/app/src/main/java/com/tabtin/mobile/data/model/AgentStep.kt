package com.tabtin.mobile.data.model

public enum class StepType(public val value: String) {
    TOOL_CALL("tool_call"),
    STEP("step"),
    SUBAGENT("subagent"),
    REASONING("reasoning"),
    THINKING("thinking"),
    COMPACTION("compaction"),
    LIFECYCLE("lifecycle"),
    SYSTEM_NOTICE("system_notice"),
}

public enum class StepStatus(public val value: String) {
    RUNNING("running"),
    COMPLETED("completed"),
    FAILED("failed");

    public companion object {
        public fun fromString(s: String): StepStatus =
            entries.firstOrNull { it.value == s } ?: RUNNING
    }
}

public enum class AgentPhase {
    IDLE, PLANNING, EXECUTING, DONE, ERROR
}

public data class AgentStep(
    val id: String,
    val type: StepType,
    val name: String,
    val status: StepStatus,
    val input: String? = null,
    val output: String? = null,
    val durationMs: Int? = null,
    val noticeType: String? = null,
    /**
     * Wave 6 S7：子 Agent 进度快照。仅 `type == StepType.SUBAGENT` 时非空。
     * 由 `ConversationViewModel.upsertSubagentRun` 在子 Agent 事件到达时聚合式更新——
     * 「双数据源」乐观渲染：源 A（content_block_start tool_use(agent)）按 `parentToolCallId`
     * 锚点先合成乐观卡（稳定 id =`subagent-{toolCallId}`），源 B（subagent_started）到达后
     * 原地升级填真实 runId、不新建第二张卡；legacy 无 parent_tool_call_id 时退回 `subagent-{runId}`。
     * UI 层 `AgentStepsView` 检测 `subagent != null` → 渲染 SubagentProgressCard。
     */
    val subagent: SubagentRunSnapshot? = null,
    /** `tool_result.presentation.kind`；文生图为 `media_image_generation`。 */
    val presentationKind: String? = null,
    /** `tool_result.presentation.data.prompt`（截断预览，可空）。 */
    val presentationPrompt: String? = null,
) {
    val isMediaImageGeneration: Boolean
        get() = presentationKind == "media_image_generation"
}
