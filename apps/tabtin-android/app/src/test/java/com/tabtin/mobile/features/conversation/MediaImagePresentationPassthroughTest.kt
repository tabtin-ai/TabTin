package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.BlockPresentation
import com.tabtin.mobile.data.model.BlockPresentationData
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.data.model.StreamEvent
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Task 4：`tool_result.presentation` 透传到 AgentStep / 历史 timeline。
 */
class MediaImagePresentationPassthroughTest {
    @Test
    fun `formal artifact suppresses only its correlated generation preview`() {
        val correlated = AgentStep(
            id = "tool-use-1",
            type = StepType.TOOL_CALL,
            name = "run_terminal_command",
            status = StepStatus.COMPLETED,
            presentationKind = "media_image_generation",
        )
        val other = correlated.copy(id = "tool-use-2")

        assertTrue(shouldSuppressMediaImagePreview(correlated, setOf("tool-use-1")))
        assertFalse(shouldSuppressMediaImagePreview(other, setOf("tool-use-1")))
    }

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun agentStepRecognizesMediaImageGenerationKind() {
        val step = AgentStep(
            id = "t1",
            type = com.tabtin.mobile.data.model.StepType.TOOL_CALL,
            name = "Bash",
            status = StepStatus.COMPLETED,
            presentationKind = "media_image_generation",
            presentationPrompt = "红苹果",
        )
        assertTrue(step.isMediaImageGeneration)
        assertEquals("红苹果", step.presentationPrompt)
        assertFalse(
            step.copy(presentationKind = "other").isMediaImageGeneration,
        )
    }

    @Test
    fun toolResultBlockThroughProjectorSetsIsMediaImageGeneration() {
        val projector = ConversationProjector()
        projector.apply(StreamEvent.MessageStarted(messageId = "m1"))
        projector.apply(
            StreamEvent.ToolUseBlockStarted(
                messageId = "m1",
                index = 0,
                toolCallId = "tool-media-1",
                name = "Bash",
                input = """{"command":"tabtin media image generate --prompt 红苹果"}""",
            ),
        )
        assertTrue(
            projector.apply(
                StreamEvent.ToolResultBlock(
                    messageId = "m1",
                    index = 1,
                    toolUseId = "tool-media-1",
                    output = """{"ok":true,"stored_urls":["https://cdn.example.com/a.png"]}""",
                    isError = false,
                    presentationKind = "media_image_generation",
                    presentationPrompt = "红苹果",
                ),
            ),
        )

        val step = projector.messages
            .single { it.isAssistant }
            .agentSteps
            .orEmpty()
            .single { it.id == "tool-media-1" }

        assertTrue(
            "ToolResultBlock.presentation 经 ConversationProjector 回填后须识别为文生图",
            step.isMediaImageGeneration,
        )
        assertEquals("media_image_generation", step.presentationKind)
        assertEquals("红苹果", step.presentationPrompt)

        val toolBlock = projector.messages
            .single { it.isAssistant }
            .blocksJson
            .orEmpty()
            .firstOrNull { it.id == "tool-media-1" || it.toolUseId == "tool-media-1" }
        assertEquals("media_image_generation", toolBlock?.presentation?.kind)
        assertEquals("红苹果", toolBlock?.presentation?.data?.prompt)
    }

    @Test
    fun toolLifecycleToolCallPresentationShowsGeneratingEarly() {
        val projector = ConversationProjector()
        projector.apply(StreamEvent.MessageStarted(messageId = "m-life"))
        projector.apply(
            StreamEvent.ToolUseBlockStarted(
                messageId = "m-life",
                index = 0,
                toolCallId = "tool-life-1",
                name = "Bash",
                input = """{"command":"tabtin media image generate --prompt 蓝气球"}""",
            ),
        )
        assertTrue(
            projector.apply(
                StreamEvent.ToolCall(
                    id = "tool-life-1",
                    name = "Bash",
                    input = null,
                    output = null,
                    status = StepStatus.RUNNING,
                    presentationKind = "media_image_generation",
                    presentationPrompt = "蓝气球",
                ),
            ),
        )

        val step = projector.messages
            .single { it.isAssistant }
            .agentSteps
            .orEmpty()
            .single { it.id == "tool-life-1" }
        assertTrue(
            "tool_started.presentation 须在 tool_result 前驱动生成中态",
            step.isMediaImageGeneration,
        )
        assertEquals("蓝气球", step.presentationPrompt)
        assertEquals(StepStatus.RUNNING, step.status)
    }

    @Test
    fun historyToolResultPresentationFlowsIntoTimelineAgentStep() {
        val message = ChatMessage(
            id = "hist-1",
            role = "assistant",
            content = "",
            blocksJson = listOf(
                BlockItem(
                    type = "tool_use",
                    index = 0,
                    id = "tool-hist-1",
                    name = "Bash",
                    status = "completed",
                ),
                BlockItem(
                    type = "tool_result",
                    index = 1,
                    toolUseId = "tool-hist-1",
                    content = """{"ok":true,"stored_urls":["https://cdn.example.com/b.png"]}""",
                    isError = false,
                    presentation = BlockPresentation(
                        kind = "media_image_generation",
                        data = BlockPresentationData(prompt = "蓝气球"),
                    ),
                ),
            ),
        )

        val items = assistantTimelineItems(message, displayText = "")
        val tool = items.filterIsInstance<AssistantTimelineItem.Tool>().single()
        assertTrue(tool.step.isMediaImageGeneration)
        assertEquals("蓝气球", tool.step.presentationPrompt)
        assertEquals(StepStatus.COMPLETED, tool.step.status)
    }

    @Test
    fun decodesNestedPresentationFromContentBlocksJson() {
        val payload = """
            {
              "type": "tool_result",
              "tool_use_id": "tool-decode-1",
              "content": "{\"ok\":true}",
              "is_error": false,
              "presentation": {
                "kind": "media_image_generation",
                "data": {
                  "prompt": "橙猫",
                  "command": "tabtin media image generate"
                }
              }
            }
        """.trimIndent()

        val block = json.decodeFromString<BlockItem>(payload)
        assertEquals("media_image_generation", block.presentation?.kind)
        assertEquals("橙猫", block.presentation?.data?.prompt)
        assertEquals("tabtin media image generate", block.presentation?.data?.command)
    }
}
