package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.data.model.SubagentRunSnapshot
import com.tabtin.mobile.data.model.SubagentTranscriptItem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 对齐 iOS `SubagentHistoryRehydrationTests`：冷启动从父 tool_result marker +
 * 子消息 blocks 恢复 SUBAGENT 卡与 transcript；live 非空 transcript 不被 archive 覆盖。
 */
class SubagentHistoryRehydrationTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    @Test
    fun extractAndStripSubagentIdMarker() {
        val raw = "统计完成：44\n\n[子 Agent ID: run-abc-123]"
        assertEquals("run-abc-123", SubagentHistoryRehydration.extractSubagentRunId(raw))
        assertEquals("统计完成：44", SubagentHistoryRehydration.stripSubagentIdMarker(raw))
        assertNull(SubagentHistoryRehydration.extractSubagentRunId("无标记"))
    }

    @Test
    fun deriveRunFromParentToolUseAndResult() {
        val parent = ChatMessage(
            id = "msg-parent",
            role = "assistant",
            serverId = "msg-parent",
            persistedId = "msg-parent",
            createdAt = "2023-11-14T22:13:20Z",
            blocksJson = listOf(
                BlockItem(
                    type = "tool_use",
                    id = "agent_0",
                    name = "agent",
                    index = 0,
                    input = jsonElement("""{"prompt":"数文件","description":"测试子代理 1"}"""),
                ),
                BlockItem(
                    type = "tool_result",
                    toolUseId = "agent_0",
                    content = "44\n\n[子 Agent ID: child-1]",
                    isError = false,
                ),
            ),
        )

        val runs = SubagentHistoryRehydration.deriveRuns(listOf(parent))

        assertEquals(1, runs.size)
        assertEquals("child-1", runs[0].runId)
        assertEquals("agent_0", runs[0].parentToolCallId)
        assertEquals("数文件", runs[0].snapshot.task)
        assertEquals("测试子代理 1", runs[0].snapshot.label)
        assertEquals(SubagentRunSnapshot.Status.COMPLETED, runs[0].snapshot.status)
        assertEquals("44", runs[0].snapshot.summary)
    }

    @Test
    fun `history accepts display aliases and falls back to readable task`() {
        val parent = ChatMessage(
            id = "aliases",
            role = "assistant",
            blocksJson = listOf(
                BlockItem(
                    type = "tool_use",
                    id = "agent-title",
                    name = "agent",
                    input = jsonElement(
                        """{"title":"6f4dc2aa-889f-4503-9197-5a0e12345678","task":"model_cursor-code\n汇总竞品调研"}""",
                    ),
                ),
                BlockItem(
                    type = "tool_result",
                    toolUseId = "agent-title",
                    content = "完成\n\n[子 Agent ID: child-title]",
                ),
            ),
        )

        val run = SubagentHistoryRehydration.deriveRuns(listOf(parent)).single()

        assertEquals("汇总竞品调研", run.snapshot.task)
        assertNull(run.snapshot.label)
        val applied = SubagentHistoryRehydration.applyToMessages(listOf(parent), emptyList())
        assertEquals("汇总竞品调研", applied.single().agentSteps?.single()?.name)
    }

    @Test
    fun checkAgentDoesNotDeriveRun() {
        val message = ChatMessage(
            id = "msg-check",
            role = "assistant",
            blocksJson = listOf(
                BlockItem(
                    type = "tool_use",
                    id = "agent_check",
                    name = "agent",
                    input = jsonElement("""{"check_agent_id":"child-1"}"""),
                ),
                BlockItem(
                    type = "tool_result",
                    toolUseId = "agent_check",
                    content = "ok\n\n[子 Agent ID: child-1]",
                    isError = false,
                ),
            ),
        )

        assertTrue(SubagentHistoryRehydration.deriveRuns(listOf(message)).isEmpty())
    }

    @Test
    fun transcriptFromChildAndApplyToMessages() {
        val parent = ChatMessage(
            id = "parent",
            role = "assistant",
            serverId = "parent",
            blocksJson = listOf(
                BlockItem(
                    type = "tool_use",
                    id = "agent_0",
                    name = "agent",
                    input = jsonElement(
                        """{"prompt":"You are a file statistician","description":"测试子代理 1"}""",
                    ),
                ),
                BlockItem(
                    type = "tool_result",
                    toolUseId = "agent_0",
                    content = "44\n\n[子 Agent ID: child-99]",
                    isError = false,
                ),
            ),
        )
        val child = ChatMessage(
            id = "child-msg",
            role = "assistant",
            content = "44",
            subagentRunId = "child-99",
            createdAt = "2026-08-05T09:00:00Z",
            blocksJson = listOf(
                BlockItem(type = "thinking", thinking = "先 ls 再统计", index = 0),
                BlockItem(
                    type = "tool_use",
                    id = "bash_1",
                    name = "run_terminal_command",
                    index = 1,
                    input = jsonElement("""{"command":"ls"}"""),
                ),
                BlockItem(
                    type = "tool_result",
                    toolUseId = "bash_1",
                    content = "a.txt\nb.txt",
                    isError = false,
                    index = 2,
                ),
                BlockItem(type = "text", text = "44", index = 3),
            ),
        )

        val applied = SubagentHistoryRehydration.applyToMessages(
            messages = listOf(parent),
            childMessages = listOf(child),
        )

        val step = applied.single().agentSteps?.singleOrNull()
        assertNotNull(step)
        assertEquals(StepType.SUBAGENT, step!!.type)
        assertEquals("subagent-agent_0", step.id)
        val snap = step.subagent!!
        assertEquals("child-99", snap.runId)
        assertEquals("You are a file statistician", snap.task)
        assertEquals("测试子代理 1", snap.label)
        assertEquals("44", snap.summary)
        assertFalse(snap.transcript.isEmpty())
        assertTrue(snap.transcript.any { it.kind == SubagentTranscriptItem.Kind.THINKING })
        assertTrue(snap.transcript.any { it.kind == SubagentTranscriptItem.Kind.TOOL })
        assertTrue(
            snap.transcript.any {
                it.kind == SubagentTranscriptItem.Kind.ASSISTANT && it.text == "44"
            },
        )
    }

    @Test
    fun reconcileDoesNotOverwriteLiveTranscript() {
        val liveSnap = SubagentRunSnapshot(
            runId = "child-1",
            status = SubagentRunSnapshot.Status.RUNNING,
            parentToolCallId = "agent_0",
            transcript = listOf(
                SubagentTranscriptItem(
                    id = "live-think",
                    kind = SubagentTranscriptItem.Kind.THINKING,
                    title = "思考",
                    text = "直播思考",
                    isFinal = false,
                ),
            ),
        )
        val existingParent = ChatMessage(
            id = "p",
            role = "assistant",
            serverId = "p",
            agentSteps = listOf(
                AgentStep(
                    id = "subagent-agent_0",
                    type = StepType.SUBAGENT,
                    name = "live",
                    status = StepStatus.RUNNING,
                    subagent = liveSnap,
                ),
            ),
        )
        val archiveParent = ChatMessage(
            id = "p",
            role = "assistant",
            serverId = "p",
            blocksJson = listOf(
                BlockItem(
                    type = "tool_use",
                    id = "agent_0",
                    name = "agent",
                    input = jsonElement("""{"prompt":"任务"}"""),
                ),
                BlockItem(
                    type = "tool_result",
                    toolUseId = "agent_0",
                    content = "done\n\n[子 Agent ID: child-1]",
                    isError = false,
                ),
            ),
        )
        val child = ChatMessage(
            id = "c",
            role = "assistant",
            subagentRunId = "child-1",
            blocksJson = listOf(BlockItem(type = "text", text = "历史正文")),
        )

        val applied = SubagentHistoryRehydration.applyToMessages(
            messages = listOf(archiveParent),
            childMessages = listOf(child),
            existingMessages = listOf(existingParent),
        )

        val snap = applied.single().agentSteps!!.single().subagent!!
        assertEquals(SubagentRunSnapshot.Status.COMPLETED, snap.status)
        assertEquals("直播思考", snap.transcript.first().text)
        assertEquals("任务", snap.task)
    }

    @Test
    fun assistantTimelineItemsEmitsSubagentStep() {
        val snap = SubagentRunSnapshot(
            runId = "child-1",
            label = "测试子代理 1",
            task = "数文件",
            status = SubagentRunSnapshot.Status.COMPLETED,
            parentToolCallId = "agent_0",
            summary = "44",
        )
        val message = ChatMessage(
            id = "parent",
            role = "assistant",
            blocksJson = listOf(
                BlockItem(type = "tool_use", id = "agent_0", name = "agent"),
                BlockItem(
                    type = "tool_result",
                    toolUseId = "agent_0",
                    content = "44\n\n[子 Agent ID: child-1]",
                ),
            ),
            agentSteps = listOf(
                AgentStep(
                    id = "subagent-agent_0",
                    type = StepType.SUBAGENT,
                    name = "测试子代理 1",
                    status = StepStatus.COMPLETED,
                    subagent = snap,
                ),
            ),
        )

        val items = assistantTimelineItems(message, displayText = "")
        val tool = items.filterIsInstance<AssistantTimelineItem.Tool>().single()
        assertEquals(StepType.SUBAGENT, tool.step.type)
        assertEquals("child-1", tool.step.subagent?.runId)
    }

    /** ：live 乐观卡只有 agentSteps、blocksJson 无 tool_use 时仍须出现在时间线。 */
    @Test
    fun assistantTimelineItemsEmitsOrphanLiveSubagentStep() {
        val snap = SubagentRunSnapshot(
            runId = "tool-call-1",
            label = null,
            task = "数文件",
            status = SubagentRunSnapshot.Status.PENDING,
            parentToolCallId = "tool-call-1",
            isOptimistic = true,
        )
        val message = ChatMessage(
            id = "parent-live",
            role = "assistant",
            blocksJson = listOf(
                BlockItem(type = "thinking", thinking = "先派个子代理"),
                BlockItem(type = "text", text = "正在处理"),
            ),
            agentSteps = listOf(
                AgentStep(
                    id = "subagent-tool-call-1",
                    type = StepType.SUBAGENT,
                    name = "数文件",
                    status = StepStatus.RUNNING,
                    subagent = snap,
                ),
            ),
        )

        val items = assistantTimelineItems(message, displayText = "正在处理")
        val tools = items.filterIsInstance<AssistantTimelineItem.Tool>()
        assertEquals(1, tools.size)
        assertEquals(StepType.SUBAGENT, tools.single().step.type)
        assertEquals(SubagentRunSnapshot.Status.PENDING, tools.single().step.subagent?.status)
        assertTrue(items.any { it is AssistantTimelineItem.Thinking })
        assertTrue(items.any { it is AssistantTimelineItem.Text })
    }

    private fun jsonElement(raw: String): JsonElement = json.parseToJsonElement(raw)
}
