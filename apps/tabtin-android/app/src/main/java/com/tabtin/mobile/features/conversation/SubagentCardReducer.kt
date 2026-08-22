package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.data.model.SubagentRunSnapshot
import com.tabtin.mobile.data.model.SubagentRunStats
import com.tabtin.mobile.data.model.SubagentToolStep
import com.tabtin.mobile.data.model.SubagentTranscriptItem

/**
 * 子 Agent 卡片 upsert 的**纯函数核心**（无副作用 / 不依赖 ViewModel / Hilt / Compose）。
 *
 * 从 `ConversationViewModel.upsertSubagentRun` 提纯出来——「双数据源乐观渲染」的合并规则
 * （源 A content_block_start tool_use(agent) → 乐观卡；源 B subagent_started 按
 * `parent_tool_call_id` 锚点原地顶替；progress/completed/failed 按 runId 命中）全部收敛在此，
 * 供单测直接喂事件序列验证「乐观建卡 → 顶替不重复 → progress 命中 → 乱序防御 → legacy」。
 *
 * 对齐 iOS `ChatMessageService.applySubagentUpsert`。ViewModel 只剩「拿 assistant 的
 * agentSteps → 调本 reducer → 写回」的薄壳，逻辑单一真相源在此。
 */
internal object SubagentCardReducer {

    /**
     * 源 A（乐观）：content_block_start 里 tool_use(agent) 块到达，按 [toolCallId]（= block.id）
     * 锚定本地合成乐观卡（PENDING/「启动中」+ isOptimistic）。
     *
     * 乱序兜底：源 B 已先到并把此卡升级为真实 run（非乐观、runId 已是真实值）时，源 A 后到
     * （content_block_* 迟到 / 重复源 A）不得把它降级回 PENDING——直接保持现状。
     */
    fun applyOptimisticStarted(
        steps: List<AgentStep>,
        toolCallId: String,
        task: String?,
    ): List<AgentStep> = applyUpsert(
        steps = steps,
        primaryStepId = "subagent-$toolCallId",
        matchRunId = null,
        matchToolCallId = toolCallId,
    ) { snap ->
        val alreadyRealRun = !snap.isOptimistic &&
            snap.runId.isNotBlank() && snap.runId != toolCallId
        if (alreadyRealRun) {
            snap
        } else {
            snap.copy(
                runId = snap.runId.ifBlank { toolCallId },
                parentToolCallId = toolCallId,
                task = readable(task) ?: snap.task,
                status = SubagentRunSnapshot.Status.PENDING,
                isOptimistic = true,
            )
        }
    }

    /**
     * 源 B：subagent_started 到达。带 [parentToolCallId] 时用同一 stepId 命中源 A 乐观卡并
     * 原地升级（写真实 [runId]、RUNNING、清 isOptimistic）、不新建第二张；缺失（legacy）退回
     * 按 runId 锚点建卡（旧行为）。
     */
    fun applyStarted(
        steps: List<AgentStep>,
        runId: String,
        parentToolCallId: String?,
        label: String?,
        task: String?,
        startedAt: Double?,
    ): List<AgentStep> = applyUpsert(
        steps = steps,
        primaryStepId = if (parentToolCallId != null) "subagent-$parentToolCallId" else "subagent-$runId",
        matchRunId = runId,
        matchToolCallId = parentToolCallId,
    ) { snap ->
        snap.copy(
            runId = runId,
            parentToolCallId = parentToolCallId ?: snap.parentToolCallId,
            label = readable(label) ?: snap.label,
            task = readable(task) ?: snap.task,
            startedAt = startedAt ?: snap.startedAt,
            status = SubagentRunSnapshot.Status.RUNNING,
            isOptimistic = false,
        )
    }

    /**
     * 源 B：subagent_queued。带 [parentToolCallId] 时优先用它命中源 A 乐观卡（queued 多在
     * started 前、源 A 之后到达）——**必须**这样，否则只按真实 [runId] 命中会与乐观卡（按
     * toolCallId 锚定）错开、另建一张重复卡。缺失（legacy）时退回按 runId 锚点建卡。
     *
     * 置 QUEUED 只在「尚未开跑」（PENDING/QUEUED）时生效，已 RUNNING / 终态不被排队事件降级。
     */
    fun applyQueued(
        steps: List<AgentStep>,
        runId: String,
        parentToolCallId: String?,
        label: String?,
        task: String?,
    ): List<AgentStep> = applyUpsert(
        steps = steps,
        primaryStepId = if (parentToolCallId != null) "subagent-$parentToolCallId" else "subagent-$runId",
        matchRunId = runId,
        matchToolCallId = parentToolCallId,
    ) { snap ->
        val downgradeGuarded = snap.status == SubagentRunSnapshot.Status.RUNNING ||
            snap.status == SubagentRunSnapshot.Status.COMPLETED ||
            snap.status == SubagentRunSnapshot.Status.FAILED ||
            snap.status == SubagentRunSnapshot.Status.CANCELLED
        snap.copy(
            runId = runId,
            parentToolCallId = parentToolCallId ?: snap.parentToolCallId,
            label = readable(label) ?: snap.label,
            task = readable(task) ?: snap.task,
            status = if (downgradeGuarded) snap.status else SubagentRunSnapshot.Status.QUEUED,
            isOptimistic = false,
        )
    }

    /**
     * check_agent_id 派发排除收尾：撤掉某 [toolCallId] 对应的**仍处于乐观态**的子 Agent 卡。
     * 只删 isOptimistic 卡——真实派发（已被 subagent_started 升级）绝不误删。
     */
    fun removeOptimistic(
        steps: List<AgentStep>,
        toolCallId: String,
    ): List<AgentStep> = steps.filterNot { step ->
        step.type == StepType.SUBAGENT &&
            step.subagent?.isOptimistic == true &&
            (step.subagent.parentToolCallId == toolCallId ||
                step.subagent.runId == toolCallId ||
                step.id == "subagent-$toolCallId")
    }

    /** 源 B：subagent_progress，按 [runId] 命中已升级卡，累积进度（toolHistory 为空不覆盖已有）。 */
    fun applyProgress(
        steps: List<AgentStep>,
        runId: String,
        stepCount: Int?,
        latestTool: String?,
        latestSuccess: Boolean?,
        elapsedMs: Int?,
        toolHistory: List<SubagentToolStep>,
    ): List<AgentStep> = applyUpsert(
        steps = steps,
        primaryStepId = "subagent-$runId",
        matchRunId = runId,
        matchToolCallId = null,
    ) { snap ->
        val nextStatus = if (snap.status == SubagentRunSnapshot.Status.COMPLETED ||
            snap.status == SubagentRunSnapshot.Status.FAILED ||
            snap.status == SubagentRunSnapshot.Status.CANCELLED
        ) {
            snap.status
        } else {
            SubagentRunSnapshot.Status.RUNNING
        }
        snap.copy(
            status = nextStatus,
            stepCount = stepCount ?: snap.stepCount,
            latestTool = latestTool ?: snap.latestTool,
            latestSuccess = latestSuccess ?: snap.latestSuccess,
            elapsedMs = elapsedMs ?: snap.elapsedMs,
            toolHistory = snap.toolHistory,
        )
    }

    /** 源 B：subagent_completed，按 [runId] 命中，置 COMPLETED + 保留 stats。 */
    fun applyCompleted(
        steps: List<AgentStep>,
        runId: String,
        label: String?,
        task: String?,
        summary: String?,
        endedAt: Double?,
        stats: SubagentRunStats?,
    ): List<AgentStep> = applyUpsert(
        steps = steps,
        primaryStepId = "subagent-$runId",
        matchRunId = runId,
        matchToolCallId = null,
    ) { snap ->
        snap.copy(
            status = SubagentRunSnapshot.Status.COMPLETED,
            label = readable(label) ?: snap.label,
            task = readable(task) ?: snap.task,
            summary = summary ?: snap.summary,
            endedAt = endedAt ?: snap.endedAt,
            stats = stats ?: snap.stats,
        )
    }

    /** 源 B：subagent_failed，按 [runId] 命中，置 FAILED/CANCELLED + 保留 stats。 */
    fun applyFailed(
        steps: List<AgentStep>,
        runId: String,
        label: String,
        task: String?,
        error: String,
        cancelled: Boolean,
        endedAt: Double?,
        stats: SubagentRunStats?,
        nowEpochSeconds: Double = System.currentTimeMillis() / 1000.0,
    ): List<AgentStep> = applyUpsert(
        steps = steps,
        primaryStepId = "subagent-$runId",
        matchRunId = runId,
        matchToolCallId = null,
    ) { snap ->
        snap.copy(
            status = if (cancelled) SubagentRunSnapshot.Status.CANCELLED
                else SubagentRunSnapshot.Status.FAILED,
            label = readable(label) ?: snap.label,
            task = readable(task) ?: snap.task,
            error = error,
            cancelled = cancelled,
            endedAt = endedAt ?: snap.endedAt ?: nowEpochSeconds,
            stats = stats ?: snap.stats,
        )
    }

    fun applyTranscript(
        steps: List<AgentStep>,
        runId: String,
        update: SubagentTranscriptUpdate,
    ): List<AgentStep> = applyUpsert(
        steps = steps,
        primaryStepId = "subagent-$runId",
        matchRunId = runId,
        matchToolCallId = null,
    ) { snap ->
        val transcript = snap.transcript.toMutableList()
        val idx = transcript.indexOfFirst { it.id == update.id }
        if (idx >= 0) {
            val previous = transcript[idx]
            transcript[idx] = previous.copy(
                title = update.title ?: previous.title,
                text = when {
                    update.textDelta != null -> previous.text.orEmpty() + update.textDelta
                    update.text != null -> update.text
                    else -> previous.text
                },
                inputText = update.inputText ?: previous.inputText,
                outputText = update.outputText ?: previous.outputText,
                isFinal = update.isFinal,
                isError = update.isError,
                toolCallId = update.toolCallId ?: previous.toolCallId,
                richContent = update.richContent ?: previous.richContent,
            )
        } else {
            transcript.add(
                SubagentTranscriptItem(
                    id = update.id,
                    messageId = update.messageId,
                    index = update.index,
                    kind = update.kind,
                    title = update.title,
                    text = update.text ?: update.textDelta,
                    inputText = update.inputText,
                    outputText = update.outputText,
                    isFinal = update.isFinal,
                    isError = update.isError,
                    toolCallId = update.toolCallId,
                    richContent = update.richContent,
                )
            )
        }
        snap.copy(runId = snap.runId.ifBlank { runId }, transcript = transcript)
    }

    data class SubagentTranscriptUpdate(
        val id: String,
        val messageId: String?,
        val index: Int?,
        val kind: SubagentTranscriptItem.Kind,
        val title: String? = null,
        val text: String? = null,
        val textDelta: String? = null,
        val inputText: String? = null,
        val outputText: String? = null,
        val isFinal: Boolean = false,
        val isError: Boolean = false,
        val toolCallId: String? = null,
        val richContent: BlockItem? = null,
    )

    /**
     * 通用 upsert：三级查找（runId → parentToolCallId → stepId），命中即原地 update 并
     * **复用已有 AgentStep.id**（源 B 顶替源 A 乐观卡时 id 不变，Compose 不 remount）；
     * 都没命中 → 用 [primaryStepId] 新建。乐观卡 runId 初值为空串占位，源 B 到达写真实 runId。
     */
    private fun applyUpsert(
        steps: List<AgentStep>,
        primaryStepId: String,
        matchRunId: String?,
        matchToolCallId: String?,
        update: (SubagentRunSnapshot) -> SubagentRunSnapshot,
    ): List<AgentStep> {
        val result = steps.toMutableList()
        val idx = result.indexOfFirst { step ->
            if (step.type != StepType.SUBAGENT) return@indexOfFirst false
            val s = step.subagent ?: return@indexOfFirst false
            (matchRunId != null && s.runId.isNotBlank() && s.runId == matchRunId) ||
                (matchToolCallId != null && s.parentToolCallId == matchToolCallId) ||
                step.id == primaryStepId
        }
        val existingSnap = if (idx >= 0) result[idx].subagent else null
        val baseSnap = existingSnap ?: SubagentRunSnapshot(runId = "")
        val snap = update(baseSnap)
        val stepId = if (idx >= 0) result[idx].id else primaryStepId
        val displayName = SubagentDisplayTitle.resolve(snap.label, snap.task).orEmpty()
        val step = AgentStep(
            id = stepId,
            type = StepType.SUBAGENT,
            name = displayName,
            status = mapSubagentStatus(snap.status),
            durationMs = snap.durationMs,
            subagent = snap,
        )
        if (idx >= 0) result[idx] = step else result.add(step)
        return result
    }

    private fun readable(value: String?): String? = SubagentDisplayTitle.sanitize(value)

    /**
     * SubagentRunSnapshot.Status → StepStatus。
     * CANCELLED 映射到 COMPLETED（视觉中性，不红）；PENDING/RUNNING 都走 RUNNING 让转圈正常。
     */
    fun mapSubagentStatus(s: SubagentRunSnapshot.Status): StepStatus = when (s) {
        SubagentRunSnapshot.Status.PENDING,
        SubagentRunSnapshot.Status.QUEUED,
        SubagentRunSnapshot.Status.RUNNING -> StepStatus.RUNNING
        SubagentRunSnapshot.Status.COMPLETED,
        SubagentRunSnapshot.Status.CANCELLED -> StepStatus.COMPLETED
        SubagentRunSnapshot.Status.FAILED -> StepStatus.FAILED
    }
}
