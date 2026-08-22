package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.SessionRunState
import com.tabtin.mobile.data.model.SessionRunStatus
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/**
 * 对齐 `packages/agent-wire/.../task-capsule-status-v1.json` fixture。
 */
@RunWith(Parameterized::class)
class TaskCapsuleModelTest(
    private val name: String,
    private val input: TaskCapsuleStatusInput,
    private val expectedStatus: TaskCapsuleStatus,
    private val expectedVisual: TaskCapsuleVisual,
) {
    @Test
    fun `fixture case projects status and visual`() {
        val status = TaskCapsuleModel.resolveStatus(input)
        assertEquals(name, expectedStatus, status)
        assertEquals(name, expectedVisual, TaskCapsuleModel.resolveVisual(status))
        assertEquals(name, expectedStatus.wireKey, status.wireKey)
    }

    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun cases(): List<Array<Any>> = listOf(
            arrayOf(
                "approval · 人工确认优先于 busy",
                TaskCapsuleStatusInput(busy = true, runPhase = TaskCapsuleRunPhase.TOOL_CALLS, pendingApproval = true),
                TaskCapsuleStatus.NEEDS_APPROVAL,
                TaskCapsuleVisual.FULL,
            ),
            arrayOf(
                "answer · 人工回答优先于 busy",
                TaskCapsuleStatusInput(busy = true, runPhase = TaskCapsuleRunPhase.PLANNING, pendingAnswer = true),
                TaskCapsuleStatus.NEEDS_ANSWER,
                TaskCapsuleVisual.FULL,
            ),
            arrayOf(
                "paused · 优先于 busy，且不是 stopped/recovering",
                TaskCapsuleStatusInput(busy = true, runPhase = TaskCapsuleRunPhase.TOOL_CALLS, paused = true),
                TaskCapsuleStatus.PAUSED,
                TaskCapsuleVisual.FULL,
            ),
            arrayOf(
                "paused · 优先于 suspended",
                TaskCapsuleStatusInput(busy = false, paused = true, suspended = true),
                TaskCapsuleStatus.PAUSED,
                TaskCapsuleVisual.FULL,
            ),
            arrayOf(
                "recovering · 连接中断待恢复",
                TaskCapsuleStatusInput(busy = true, runPhase = TaskCapsuleRunPhase.TOOL_CALLS, suspended = true),
                TaskCapsuleStatus.RECOVERING,
                TaskCapsuleVisual.FULL,
            ),
            arrayOf(
                "queue · busy + queuedCount",
                TaskCapsuleStatusInput(busy = true, runPhase = TaskCapsuleRunPhase.DONE, queuedCount = 2),
                TaskCapsuleStatus.QUEUED,
                TaskCapsuleVisual.FULL,
            ),
            arrayOf(
                "error · 终态异常优先于未读 complete",
                TaskCapsuleStatusInput(busy = false, runPhase = TaskCapsuleRunPhase.ERROR, unreadCount = 2),
                TaskCapsuleStatus.ERROR,
                TaskCapsuleVisual.FULL,
            ),
            arrayOf(
                "complete · 未读完成 → full",
                TaskCapsuleStatusInput(busy = false, unreadCount = 1),
                TaskCapsuleStatus.COMPLETE,
                TaskCapsuleVisual.FULL,
            ),
            arrayOf(
                "ready · 仅待命 → mini",
                TaskCapsuleStatusInput(busy = false),
                TaskCapsuleStatus.READY,
                TaskCapsuleVisual.MINI,
            ),
            arrayOf(
                "planningNext · planning + completedToolCalls",
                TaskCapsuleStatusInput(
                    busy = true,
                    runPhase = TaskCapsuleRunPhase.PLANNING,
                    completedToolCalls = 2,
                ),
                TaskCapsuleStatus.PLANNING_NEXT,
                TaskCapsuleVisual.FULL,
            ),
            arrayOf(
                "finishing · synthesizing",
                TaskCapsuleStatusInput(busy = true, runPhase = TaskCapsuleRunPhase.SYNTHESIZING),
                TaskCapsuleStatus.FINISHING,
                TaskCapsuleVisual.FULL,
            ),
        )
    }
}

class TaskCapsuleAdapterTest {
    @Test
    fun `adapt projects planningNext from authoritative run and tool count`() {
        val input = TaskCapsuleAdapterInput(
            runState = SessionRunState(
                runId = "run-1",
                sequence = 1,
                revision = 3L,
                status = SessionRunStatus.RUNNING,
                queueDepth = 0,
                stateChangedAt = "2026-08-01T00:00:00Z",
            ),
            currentPhase = AgentPhase.PLANNING,
            isStreaming = true,
            messages = listOf(
                ChatMessage(
                    id = "a1",
                    role = "assistant",
                    content = "",
                    isStreaming = true,
                    agentSteps = listOf(
                        AgentStep(
                            id = "t1",
                            type = StepType.TOOL_CALL,
                            name = "shell",
                            status = StepStatus.COMPLETED,
                        ),
                    ),
                ),
            ),
        )
        val adapted = TaskCapsuleModel.adapt(input)
        assertEquals(TaskCapsuleStatus.PLANNING_NEXT, TaskCapsuleModel.resolveStatus(adapted))
        assertEquals(1, adapted.completedToolCalls)
    }

    @Test
    fun `unread count projects real assistant message count`() {
        // 毫秒时间戳（≥1e12 不走秒→毫秒换算）
        val seen = 1_700_000_001_000L
        val messages = listOf(
            ChatMessage(id = "u1", role = "user", content = "hi", createdAt = "1700000000500"),
            ChatMessage(id = "a1", role = "assistant", content = "old", createdAt = "1700000000900"),
            ChatMessage(id = "a2", role = "assistant", content = "n1", createdAt = "1700000001500"),
            ChatMessage(id = "a3", role = "assistant", content = "n2", createdAt = "1700000002000"),
        )
        assertEquals(
            2,
            TaskCapsuleModel.resolveUnreadCount(messages, seenUntilTs = seen, hasUnreadReply = true),
        )
        assertEquals(
            0,
            TaskCapsuleModel.resolveUnreadCount(messages, seenUntilTs = seen, hasUnreadReply = false),
        )
        assertEquals(
            1,
            TaskCapsuleModel.resolveUnreadCount(emptyList(), seenUntilTs = 0L, hasUnreadReply = true),
        )
    }
}
