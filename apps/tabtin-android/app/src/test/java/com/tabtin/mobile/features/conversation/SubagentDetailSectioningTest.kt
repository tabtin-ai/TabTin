package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.SubagentRunSnapshot
import com.tabtin.mobile.data.model.SubagentTranscriptItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 对齐 iOS `SubagentDetailSectioningTests`：锁住指令 / 中间步骤 / 结果三块投影规则。
 */
class SubagentDetailSectioningTest {

    @Test
    fun runningWithTaskAndStepsHasPendingResult() {
        val snapshot = SubagentRunSnapshot(
            runId = "run-pending",
            status = SubagentRunSnapshot.Status.RUNNING,
            task = "找到 ClientError 定义",
            label = "代码探索",
            transcript = listOf(
                item(id = "t1", kind = SubagentTranscriptItem.Kind.THINKING, text = "先搜类型名"),
                item(id = "tool1", kind = SubagentTranscriptItem.Kind.TOOL, title = "Grep", text = null),
                item(id = "a1", kind = SubagentTranscriptItem.Kind.ASSISTANT, text = null),
            ),
        )

        val sections = SubagentDetailSectioning.sections(snapshot)

        assertEquals("找到 ClientError 定义", sections.instruction)
        assertEquals(listOf("t1", "tool1"), sections.steps.map { it.id })
        assertTrue(sections.steps.none { it.kind == SubagentTranscriptItem.Kind.ASSISTANT })
        assertEquals(emptyList<String>(), sections.result.assistantTexts)
        assertNull(sections.result.terminalConclusion)
        assertNull(sections.result.failureGuidance)
        assertTrue(sections.result.isPendingResult)
    }

    @Test
    fun completedPutsAssistantInResultAndDropsRedundantSummary() {
        val snapshot = SubagentRunSnapshot(
            runId = "run-done",
            status = SubagentRunSnapshot.Status.COMPLETED,
            task = "定位入口",
            summary = "已找到调用入口",
            transcript = listOf(
                item(id = "think", kind = SubagentTranscriptItem.Kind.THINKING, text = "从 ViewModel 往下追"),
                item(id = "tool", kind = SubagentTranscriptItem.Kind.TOOL, title = "Read", text = null),
                item(
                    id = "assistant",
                    kind = SubagentTranscriptItem.Kind.ASSISTANT,
                    text = "入口在 ConversationViewModel",
                ),
                item(id = "sys", kind = SubagentTranscriptItem.Kind.SYSTEM, text = "budget ok"),
            ),
        )

        val sections = SubagentDetailSectioning.sections(snapshot)

        assertEquals("定位入口", sections.instruction)
        assertEquals(
            listOf(
                SubagentTranscriptItem.Kind.THINKING,
                SubagentTranscriptItem.Kind.TOOL,
                SubagentTranscriptItem.Kind.SYSTEM,
            ),
            sections.steps.map { it.kind },
        )
        assertFalse(sections.steps.any { it.kind == SubagentTranscriptItem.Kind.ASSISTANT })
        assertEquals(listOf("入口在 ConversationViewModel"), sections.result.assistantTexts)
        // 已有 assistant 正文时不再叠一层 summary「结果摘要」
        assertNull(sections.result.terminalConclusion)
        assertNull(sections.result.failureGuidance)
        assertFalse(sections.result.isPendingResult)
        assertFalse(sections.result.assistantTexts.any { it.contains("从 ViewModel") })
    }

    @Test
    fun completedWithoutAssistantKeepsSummaryAsConclusion() {
        val snapshot = SubagentRunSnapshot(
            runId = "run-summary-only",
            status = SubagentRunSnapshot.Status.COMPLETED,
            summary = "44",
            transcript = listOf(
                item(id = "think", kind = SubagentTranscriptItem.Kind.THINKING, text = "数文件"),
            ),
        )

        val sections = SubagentDetailSectioning.sections(snapshot)

        assertEquals(emptyList<String>(), sections.result.assistantTexts)
        assertEquals("44", sections.result.terminalConclusion)
        assertFalse(sections.result.isPendingResult)
    }

    @Test
    fun filtersThinkingIterationNoiseFromSteps() {
        val snapshot = SubagentRunSnapshot(
            runId = "run-noise",
            status = SubagentRunSnapshot.Status.RUNNING,
            transcript = listOf(
                item(
                    id = "noise-1",
                    kind = SubagentTranscriptItem.Kind.SYSTEM,
                    title = "Thinking...",
                    text = null,
                ),
                item(id = "think", kind = SubagentTranscriptItem.Kind.THINKING, text = "真正思考"),
                item(
                    id = "noise-2",
                    kind = SubagentTranscriptItem.Kind.SYSTEM,
                    title = "Thinking... (iteration 2)",
                    text = null,
                ),
                item(
                    id = "noise-text-only",
                    kind = SubagentTranscriptItem.Kind.SYSTEM,
                    title = null,
                    text = "Thinking... (iteration 3)",
                ),
                item(
                    id = "tool",
                    kind = SubagentTranscriptItem.Kind.TOOL,
                    title = "run_terminal_command",
                    text = null,
                ),
                item(
                    id = "sys-ok",
                    kind = SubagentTranscriptItem.Kind.SYSTEM,
                    title = "事件",
                    text = "checkpoint ok",
                ),
            ),
        )

        val sections = SubagentDetailSectioning.sections(snapshot)

        assertEquals(listOf("think", "tool", "sys-ok"), sections.steps.map { it.id })
        assertTrue(
            SubagentDetailSectioning.isThinkingIterationNoise(
                item(
                    id = "n",
                    kind = SubagentTranscriptItem.Kind.SYSTEM,
                    title = "thinking (iteration 3)",
                    text = null,
                ),
            ),
        )
        assertFalse(
            SubagentDetailSectioning.isThinkingIterationNoise(
                item(
                    id = "ok",
                    kind = SubagentTranscriptItem.Kind.SYSTEM,
                    title = "事件",
                    text = "x",
                ),
            ),
        )
    }

    @Test
    fun failedPutsErrorInConclusionWithFailureGuidance() {
        val snapshot = SubagentRunSnapshot(
            runId = "run-fail",
            status = SubagentRunSnapshot.Status.FAILED,
            label = "读仓库",
            error = "访问工作区失败",
            transcript = listOf(
                item(id = "err", kind = SubagentTranscriptItem.Kind.ERROR, text = "permission denied"),
                item(
                    id = "assistant",
                    kind = SubagentTranscriptItem.Kind.ASSISTANT,
                    text = "没法继续",
                ),
            ),
        )

        val sections = SubagentDetailSectioning.sections(snapshot)

        assertEquals("读仓库", sections.instruction)
        assertEquals(listOf(SubagentTranscriptItem.Kind.ERROR), sections.steps.map { it.kind })
        assertEquals(listOf("没法继续"), sections.result.assistantTexts)
        assertEquals("访问工作区失败", sections.result.terminalConclusion)
        assertEquals(
            "当前没有独立重试通道；可让父 Agent 根据此结论重新委派。",
            sections.result.failureGuidance,
        )
        assertFalse(sections.result.isPendingResult)
    }

    @Test
    fun instructionFallsBackToLabelThenNull() {
        val labeled = SubagentRunSnapshot(
            runId = "run-label",
            label = "仅有标签",
            task = "   ",
        )
        assertEquals(
            "仅有标签",
            SubagentDetailSectioning.sections(labeled).instruction,
        )

        val empty = SubagentRunSnapshot(runId = "run-empty")
        assertNull(SubagentDetailSectioning.sections(empty).instruction)
    }

    @Test
    fun thinkingAndToolDoNotAppearInAssistantTexts() {
        val snapshot = SubagentRunSnapshot(
            runId = "run-split",
            status = SubagentRunSnapshot.Status.RUNNING,
            transcript = listOf(
                item(
                    id = "think",
                    kind = SubagentTranscriptItem.Kind.THINKING,
                    text = "思考正文不应进结果列表",
                ),
                item(
                    id = "tool",
                    kind = SubagentTranscriptItem.Kind.TOOL,
                    title = "Bash",
                    text = "工具输出也不进",
                ),
                item(id = "rich", kind = SubagentTranscriptItem.Kind.RICH_CONTENT, text = "rich"),
            ),
        )

        val sections = SubagentDetailSectioning.sections(snapshot)

        assertEquals(listOf("think", "tool", "rich"), sections.steps.map { it.id })
        assertEquals(emptyList<String>(), sections.result.assistantTexts)
        assertTrue(sections.result.isPendingResult)
    }

    private fun item(
        id: String,
        kind: SubagentTranscriptItem.Kind,
        title: String? = null,
        text: String?,
    ): SubagentTranscriptItem = SubagentTranscriptItem(
        id = id,
        messageId = null,
        index = null,
        kind = kind,
        title = title,
        text = text,
        inputText = null,
        outputText = null,
        isFinal = true,
        isError = kind == SubagentTranscriptItem.Kind.ERROR,
        toolCallId = null,
    )
}
