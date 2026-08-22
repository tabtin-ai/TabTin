package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ：中性中断判定 / 空壳隐藏 / runtime 诊断过滤。
 */
class AssistantInterruptTest {

    @Test
    fun interruptedByStopReasonOrErrorClass() {
        assertTrue(
            isAssistantInterruptedMessage(
                ChatMessage(id = "a1", role = "assistant", stopReason = "aborted"),
            ),
        )
        assertTrue(
            isAssistantInterruptedMessage(
                ChatMessage(id = "a2", role = "assistant", errorClass = "ABORT"),
            ),
        )
        assertTrue(
            isNeutralInterruption(
                ChatMessage(id = "a3", role = "assistant", errorCategory = "aborted"),
            ),
        )
        assertFalse(
            isAssistantInterruptedMessage(
                ChatMessage(id = "a4", role = "assistant", errorClass = "LLM_ERROR"),
            ),
        )
        assertFalse(
            isAssistantInterruptedMessage(
                ChatMessage(id = "u1", role = "user", stopReason = "aborted"),
            ),
        )
    }

    @Test
    fun runtimeAbortDiagnosticMatched() {
        assertTrue(isRuntimeAbortDiagnostic("Run aborted by user."))
        assertTrue(isRuntimeAbortDiagnostic("run aborted by user"))
        assertTrue(isRuntimeAbortDiagnostic("对话已中止"))
        assertFalse(isRuntimeAbortDiagnostic("已经开始回复"))
        assertFalse(isRuntimeAbortDiagnostic(""))
    }

    @Test
    fun substanceIgnoresDiagnosticOnlyContent() {
        val diagnosticOnly = ChatMessage(
            id = "a1",
            role = "assistant",
            content = "Run aborted by user.",
            errorClass = "ABORT",
            stopReason = "aborted",
        )
        assertFalse(assistantMessageHasSubstance(diagnosticOnly))
        assertTrue(isEmptyInterruptedAssistantShell(diagnosticOnly))

        val withBody = ChatMessage(
            id = "a2",
            role = "assistant",
            content = "半截回复",
            errorClass = "ABORT",
            stopReason = "aborted",
        )
        assertTrue(assistantMessageHasSubstance(withBody))
        assertFalse(isEmptyInterruptedAssistantShell(withBody))
        assertTrue(isNeutralInterruption(withBody))
    }

    @Test
    fun emptyShellKeepsNonAbortTerminalErrorsVisible() {
        val billingShell = ChatMessage(
            id = "a1",
            role = "assistant",
            content = "",
            errorClass = "BUDGET_EXHAUSTED",
        )
        assertFalse(isEmptyInterruptedAssistantShell(billingShell))

        val emptyAbort = ChatMessage(
            id = "a2",
            role = "assistant",
            content = "",
            errorClass = "ABORT",
            stopReason = "aborted",
        )
        assertTrue(isEmptyInterruptedAssistantShell(emptyAbort))
    }

    @Test
    fun toolBlockCountsAsSubstanceEvenWhenTextEmpty() {
        val withTool = ChatMessage(
            id = "a1",
            role = "assistant",
            content = "",
            errorClass = "ABORT",
            stopReason = "aborted",
            blocksJson = listOf(
                BlockItem(type = "tool_use", id = "t1", name = "read_file"),
            ),
        )
        assertTrue(assistantMessageHasSubstance(withTool))
        assertFalse(isEmptyInterruptedAssistantShell(withTool))
        assertEquals(true, isNeutralInterruption(withTool))
    }
}
