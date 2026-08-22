package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentStatusCapsuleCopyTest {
    @Test
    fun `hitl emphasizes attention with pending count subtitle`() {
        val copy = AgentStatusCapsuleCopy.resolve(
            status = TaskCapsuleStatus.NEEDS_APPROVAL,
            context = AgentStatusCapsuleContext(pendingHitlCount = 3),
        )
        assertEquals(CapsuleStatusColor.WARNING, copy.colorRole)
        assertTrue(copy.emphasizesUserAttention)
        assertFalse(copy.isBusy)
        assertEquals(R.string.agent_capsule_pending_items, copy.subtitleResId)
        assertEquals(3, copy.subtitleFormatArg)
        assertNull(copy.subtitleText)
    }

    @Test
    fun `working uses current action subtitle and busy pulse`() {
        val copy = AgentStatusCapsuleCopy.resolve(
            status = TaskCapsuleStatus.WORKING,
            context = AgentStatusCapsuleContext(currentAction = "读取表格"),
        )
        assertEquals(CapsuleStatusColor.ACCENT, copy.colorRole)
        assertTrue(copy.isBusy)
        assertEquals("读取表格", copy.subtitleText)
        assertNull(copy.subtitleResId)
    }

    @Test
    fun `thinking and planningNext share accent busy pulse without status glyph dependency`() {
        val thinking = AgentStatusCapsuleCopy.resolve(status = TaskCapsuleStatus.THINKING)
        val planningNext = AgentStatusCapsuleCopy.resolve(status = TaskCapsuleStatus.PLANNING_NEXT)
        assertTrue(thinking.isBusy)
        assertTrue(planningNext.isBusy)
        assertEquals(CapsuleStatusColor.ACCENT, thinking.colorRole)
        assertEquals(CapsuleStatusColor.ACCENT, planningNext.colorRole)
        assertEquals(R.string.agent_capsule_thinking, thinking.titleResId)
        assertEquals(R.string.agent_capsule_planning_next, planningNext.titleResId)
    }

    @Test
    fun `complete includes unread count arg and result subtitle res`() {
        val copy = AgentStatusCapsuleCopy.resolve(
            status = TaskCapsuleStatus.COMPLETE,
            unreadCount = 2,
        )
        assertEquals(CapsuleStatusColor.SUCCESS, copy.colorRole)
        assertEquals(2, copy.titleFormatArg)
        assertEquals(R.string.agent_capsule_view_full_result, copy.subtitleResId)
        assertFalse(copy.isBusy)
    }

    @Test
    fun `paused is warning without pulse`() {
        val copy = AgentStatusCapsuleCopy.resolve(
            status = TaskCapsuleStatus.PAUSED,
            context = AgentStatusCapsuleContext(currentAction = "等待网络"),
        )
        assertEquals(CapsuleStatusColor.WARNING, copy.colorRole)
        assertFalse(copy.isBusy)
        assertEquals("等待网络", copy.subtitleText)
    }
}

class AgentAwaitingThoughtPhaseTest {
    @Test
    fun `settled tool tail resolves planningNext`() {
        val phase = AgentAwaitingThoughtPresentation.resolvePhase(
            sessionPulseVisible = true,
            isLastAssistantMessage = true,
            timelineItems = listOf(
                AssistantTimelineItem.Tool(
                    AgentStep(
                        id = "tool-1",
                        type = StepType.TOOL_CALL,
                        name = "shell",
                        status = StepStatus.COMPLETED,
                    ),
                ),
            ),
        )
        assertEquals(AgentAwaitingThoughtPhase.PLANNING_NEXT, phase)
    }

    @Test
    fun `empty tail resolves pending`() {
        val phase = AgentAwaitingThoughtPresentation.resolvePhase(
            sessionPulseVisible = true,
            isLastAssistantMessage = true,
            timelineItems = emptyList(),
        )
        assertEquals(AgentAwaitingThoughtPhase.PENDING, phase)
    }

    @Test
    fun `visible thinking blocks awaiting shell`() {
        val phase = AgentAwaitingThoughtPresentation.resolvePhase(
            sessionPulseVisible = true,
            isLastAssistantMessage = true,
            timelineItems = listOf(
                AssistantTimelineItem.Thinking("先梳理结构"),
            ),
        )
        assertEquals(AgentAwaitingThoughtPhase.HIDDEN, phase)
    }

    @Test
    fun `running tool blocks awaiting shell`() {
        val phase = AgentAwaitingThoughtPresentation.resolvePhase(
            sessionPulseVisible = true,
            isLastAssistantMessage = true,
            timelineItems = listOf(
                AssistantTimelineItem.Tool(
                    AgentStep(
                        id = "tool-1",
                        type = StepType.TOOL_CALL,
                        name = "shell",
                        status = StepStatus.RUNNING,
                    ),
                ),
            ),
        )
        assertEquals(AgentAwaitingThoughtPhase.HIDDEN, phase)
    }
}
