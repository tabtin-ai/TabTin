package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.SubagentRunSnapshot
import com.tabtin.mobile.data.model.SubagentTranscriptItem

/**
 * 子代理详情「结果」块：终态结论 + 流式 assistant 正文，与中间步骤分离。
 * 对齐 iOS `SubagentDetailResultSection`。
 */
internal data class SubagentDetailResultSection(
    /** transcript 中 `kind == ASSISTANT` 且 text 非空的条目，按原序提取正文。 */
    val assistantTexts: List<String>,
    /** 终态结论（完成摘要 / 失败错误等）；completed 且已有 assistant 时为 null。 */
    val terminalConclusion: String?,
    /** 失败引导；非失败态为 null。 */
    val failureGuidance: String?,
    /** 未终态且尚无 assistant 正文、也无终态结论 → UI「尚未给出结果」。 */
    val isPendingResult: Boolean,
)

/**
 * 子代理详情三块投影：指令 / 中间步骤 / 结果。
 * 对齐 iOS `SubagentDetailSections`。
 */
internal data class SubagentDetailSections(
    /** `task` 非空优先，否则 `label`，再否则 null（UI 空态）。 */
    val instruction: String?,
    /** transcript 中过程类条目（不含 assistant），按原序。 */
    val steps: List<SubagentTranscriptItem>,
    val result: SubagentDetailResultSection,
)

/**
 * 从 [SubagentRunSnapshot] 投影详情三块。纯函数，不改 snapshot、不暴露独立 toolHistory 列表。
 *
 * 步骤默认以 transcript 为准；不把 toolHistory 并入 steps（避免与流式条目重复或乱序）。
 * 对齐 iOS `SubagentDetailSectioning`。
 */
internal object SubagentDetailSectioning {
    /** 对齐 iOS `SubagentPresentationPolicy` completed 缺省结论（可被本地化覆盖）。 */
    const val DEFAULT_COMPLETED_FALLBACK: String = "子 Agent 已完成，但未提供结果摘要。"

    /** 对齐 iOS `SubagentPresentationPolicy` failed 缺省结论。 */
    const val DEFAULT_FAILED_FALLBACK: String = "子 Agent 执行失败，未返回具体错误。"

    /** 对齐 iOS `SubagentPresentationPolicy` cancelled 缺省结论。 */
    const val DEFAULT_CANCELLED_FALLBACK: String = "已收到子 Agent 取消终态。"

    /** 对齐 iOS 失败引导文案。 */
    const val DEFAULT_FAILURE_GUIDANCE: String =
        "当前没有独立重试通道；可让父 Agent 根据此结论重新委派。"

    private val STEP_KINDS: Set<SubagentTranscriptItem.Kind> = setOf(
        SubagentTranscriptItem.Kind.THINKING,
        SubagentTranscriptItem.Kind.TOOL,
        SubagentTranscriptItem.Kind.RICH_CONTENT,
        SubagentTranscriptItem.Kind.CONTEXT_REF,
        SubagentTranscriptItem.Kind.SYSTEM,
        SubagentTranscriptItem.Kind.ERROR,
    )

    internal fun sections(
        snapshot: SubagentRunSnapshot,
        completedFallback: String = DEFAULT_COMPLETED_FALLBACK,
        failedFallback: String = DEFAULT_FAILED_FALLBACK,
        cancelledFallback: String = DEFAULT_CANCELLED_FALLBACK,
        failureGuidanceText: String = DEFAULT_FAILURE_GUIDANCE,
    ): SubagentDetailSections {
        val assistantTexts = snapshot.transcript.mapNotNull { item ->
            if (item.kind != SubagentTranscriptItem.Kind.ASSISTANT) return@mapNotNull null
            nonEmpty(item.text)
        }
        // 已有 assistant 正文时，completed 的 summary 再挂一层「结果摘要」是冗余；
        // 失败 / 取消仍保留终态结论（错误原因）。
        val presentationConclusion = presentationTerminalConclusion(
            snapshot = snapshot,
            completedFallback = completedFallback,
            failedFallback = failedFallback,
            cancelledFallback = cancelledFallback,
        )
        val terminalConclusion: String? =
            if (snapshot.status == SubagentRunSnapshot.Status.COMPLETED && assistantTexts.isNotEmpty()) {
                null
            } else {
                presentationConclusion
            }
        val failureGuidance: String? =
            if (snapshot.status == SubagentRunSnapshot.Status.FAILED) failureGuidanceText else null
        val isPendingResult = !snapshot.status.isTerminal
            && assistantTexts.isEmpty()
            && nonEmpty(terminalConclusion) == null

        return SubagentDetailSections(
            instruction = SubagentDisplayTitle.sanitize(snapshot.task)
                ?: SubagentDisplayTitle.sanitize(snapshot.label),
            steps = snapshot.transcript.filter {
                it.kind in STEP_KINDS && !isThinkingIterationNoise(it)
            },
            result = SubagentDetailResultSection(
                assistantTexts = assistantTexts,
                terminalConclusion = terminalConclusion,
                failureGuidance = failureGuidance,
                isPendingResult = isPendingResult,
            ),
        )
    }

    /**
     * 旧协议 `agent.stream.step` 的 thinking 迭代占位（如 "Thinking..." /
     * "Thinking... (iteration 2)"）。真正思考由 content_block thinking 承载，
     * 主对话时间线也丢弃这类 step——详情中间步骤同步丢弃。
     */
    internal     fun isThinkingIterationNoise(item: SubagentTranscriptItem): Boolean {
        if (item.kind != SubagentTranscriptItem.Kind.SYSTEM) return false
        // title 或 text 任一以 thinking 开头都视为旧协议迭代占位（Android SystemNotice 常只填 text）。
        val candidates = listOfNotNull(item.title, item.text)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
        return candidates.any { it.lowercase().startsWith("thinking") }
    }

    private fun presentationTerminalConclusion(
        snapshot: SubagentRunSnapshot,
        completedFallback: String,
        failedFallback: String,
        cancelledFallback: String,
    ): String? = when (snapshot.status) {
        SubagentRunSnapshot.Status.COMPLETED ->
            nonEmpty(snapshot.summary) ?: completedFallback
        SubagentRunSnapshot.Status.FAILED ->
            nonEmpty(snapshot.error) ?: failedFallback
        SubagentRunSnapshot.Status.CANCELLED ->
            nonEmpty(snapshot.error) ?: cancelledFallback
        SubagentRunSnapshot.Status.PENDING,
        SubagentRunSnapshot.Status.QUEUED,
        SubagentRunSnapshot.Status.RUNNING -> null
    }

    private val SubagentRunSnapshot.Status.isTerminal: Boolean
        get() = this == SubagentRunSnapshot.Status.COMPLETED
            || this == SubagentRunSnapshot.Status.FAILED
            || this == SubagentRunSnapshot.Status.CANCELLED

    private fun nonEmpty(value: String?): String? {
        val trimmed = value?.trim().orEmpty()
        return trimmed.ifEmpty { null }
    }
}
