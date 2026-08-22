package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.StreamEvent
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ：Agent 文生图等后台命令终结时，客户端 relay 合成 role="user" 的
 * wire mini-message（message_start + content_block_start(tool_result 终态) +
 * content_block_stop + message_stop）。Android 侧要求：
 * - 合成 mini-message 不认建空 assistant 气泡（幽灵气泡，永远无内容块）；
 * - 终态由 ToolResultBlock 按 toolUseId 回填既有工具卡 output；
 * - 解析器能从终态 output 的嵌套 stdout 里剥出成品图 URL；
 * - 正常 role="assistant" / 缺省 role 的 message_start 建气泡行为不回归。
 */
class BackgroundTerminalMiniMessageTest {

    private val imageUrl = "https://cdn.example.com/bg-terminal.png"

    /** 终态 tool_result content：外层 shell 结果，stdout 内嵌 CLI 的 ok/data/result_urls。 */
    private fun terminalContent(): String {
        val inner = """{"ok":true,"data":{"result_urls":["$imageUrl"]}}"""
        // JVM 单测不能用 org.json.JSONObject.quote（Android stub）；用 kotlinx 编码 stdout 字符串。
        val quotedInner = Json.encodeToString(inner)
        return """{"status":"completed","_terminal_update":true,"stdout":$quotedInner,"exit_code":0}"""
    }

    @Test
    fun synthesizedUserMiniMessageDoesNotCreateGhostBubble() {
        val projector = ConversationProjector()
        // 原始 run：assistant 气泡 + 文生图工具卡（转后台前已存在）。
        projector.apply(StreamEvent.MessageStarted(messageId = "m1", role = "assistant"))
        projector.apply(
            StreamEvent.ToolUseBlockStarted(
                messageId = "m1",
                index = 0,
                toolCallId = "tool-bg-1",
                name = "Bash",
                input = """{"command":"tabtin media image generate --prompt 红苹果"}""",
            ),
        )
        val sizeBefore = projector.messages.size

        // 后台终结时的合成序列：role="user" message_start 不得认建气泡。
        val startedConsumed = projector.apply(
            StreamEvent.MessageStarted(
                messageId = "synth-1",
                role = "user",
                modelId = "tabtin-tool-runtime",
            ),
        )
        assertTrue("跳过的 MessageStarted 也须消费事件，避免落入 legacy 兜底再次认建", startedConsumed)
        assertEquals(sizeBefore, projector.messages.size)
        assertTrue(projector.messages.none { it.serverId == "synth-1" })

        // 终态 tool_result 按 toolUseId 回填既有工具卡。
        val content = terminalContent()
        assertTrue(
            projector.apply(
                StreamEvent.ToolResultBlock(
                    messageId = "synth-1",
                    index = 0,
                    toolUseId = "tool-bg-1",
                    output = content,
                    isError = false,
                ),
            ),
        )
        assertEquals(sizeBefore, projector.messages.size)

        val step = projector.messages
            .single { it.isAssistant }
            .agentSteps
            .orEmpty()
            .single { it.id == "tool-bg-1" }
        assertEquals(content, step.output)
        assertEquals(
            com.tabtin.mobile.data.model.StepStatus.COMPLETED,
            step.status,
        )

        // 终态必须原地更新既有工具块：合成信封的 messageId 与工具块所属消息不同，
        // 若按信封 id 做 block key 会复制出第二张同 toolUseId 工具块（一张转圈一张终态）。
        val toolBlocks = projector.messages
            .single { it.isAssistant }
            .blocksJson
            .orEmpty()
            .filter { it.type == "tool_use" }
        assertEquals(1, toolBlocks.size)
        assertEquals(content, toolBlocks.single().resultText)

        // 合成 message_stop 命中跳过登记集合 → 安静消费（返回 true，
        // 不落 ViewModel legacy 兜底 endStreamingState() 拆台当前流式气泡）。
        assertTrue(projector.apply(StreamEvent.MessageStopped(messageId = "synth-1")))
        assertEquals(sizeBefore, projector.messages.size)
        assertTrue(projector.messages.none { it.serverId == "synth-1" })
    }

    @Test
    fun syntheticMessageStopDuringLiveStreamKeepsAssistantBubbleIntact() {
        val projector = ConversationProjector()
        // 一轮真对话流式进行中：assistant 气泡 + 文本块 + 文生图后台工具卡。
        projector.apply(StreamEvent.MessageStarted(messageId = "m1", role = "assistant"))
        projector.apply(StreamEvent.TextBlockDelta(messageId = "m1", index = 0, text = "图已转后台，先聊别的。"))
        projector.apply(
            StreamEvent.ToolUseBlockStarted(
                messageId = "m1",
                index = 1,
                toolCallId = "tool-bg-9",
                name = "Bash",
                input = """{"command":"tabtin media image generate --prompt 红苹果"}""",
            ),
        )
        val before = projector.messages.single { it.isAssistant }
        assertTrue(before.isStreaming)
        assertEquals(2, before.blocksJson.orEmpty().size)

        // 后台命令终结，合成 mini-message 完整序列插进正在进行的流。
        val content = terminalContent()
        projector.apply(StreamEvent.MessageStarted(messageId = "synth-9", role = "user"))
        assertTrue(
            projector.apply(
                StreamEvent.ToolResultBlock(
                    messageId = "synth-9",
                    index = 0,
                    toolUseId = "tool-bg-9",
                    output = content,
                    isError = false,
                ),
            ),
        )
        assertTrue(
            "合成 message_stop 必须安静消费；返回 false 会让 ViewModel 兜底 endStreamingState() 拆台当前流",
            projector.apply(StreamEvent.MessageStopped(messageId = "synth-9")),
        )

        // 当前流式气泡未被拆台：仍在 streaming；终态原地更新既有工具块——
        // blocksJson 不多不少（文本 1 + 工具 1），无同 toolUseId 复制块。
        val after = projector.messages.single { it.isAssistant }
        assertTrue(after.isStreaming)
        val afterBlocks = after.blocksJson.orEmpty()
        assertEquals(2, afterBlocks.size)
        assertEquals("图已转后台，先聊别的。", afterBlocks.first { it.type == "text" }.text)
        val toolBlock = afterBlocks.single { it.type == "tool_use" }
        assertEquals("tool-bg-9", toolBlock.toolUseId)
        assertEquals(content, toolBlock.resultText)

        // 路由表与块时间轴仍在：后续 delta 继续 append 到原气泡——不塌缩成单块、不新建气泡。
        assertTrue(projector.apply(StreamEvent.TextBlockDelta(messageId = "m1", index = 0, text = "结果好了喊我。")))
        val continued = projector.messages.single { it.isAssistant }
        assertTrue(continued.isStreaming)
        assertEquals("图已转后台，先聊别的。结果好了喊我。", continued.content)
        assertEquals(2, continued.blocksJson.orEmpty().size)
    }

    @Test
    fun terminalOutputParsesImageUrlFromNestedStdout() {
        val projector = ConversationProjector()
        projector.apply(StreamEvent.MessageStarted(messageId = "m1"))
        projector.apply(
            StreamEvent.ToolUseBlockStarted(
                messageId = "m1",
                index = 0,
                toolCallId = "tool-bg-2",
                name = "Bash",
                input = null,
            ),
        )
        projector.apply(
            StreamEvent.MessageStarted(messageId = "synth-2", role = "user"),
        )
        projector.apply(
            StreamEvent.ToolResultBlock(
                messageId = "synth-2",
                index = 0,
                toolUseId = "tool-bg-2",
                output = terminalContent(),
                isError = false,
            ),
        )

        val output = projector.messages
            .single { it.isAssistant }
            .agentSteps
            .orEmpty()
            .single { it.id == "tool-bg-2" }
            .output
        assertEquals(imageUrl, MediaImageGenerateResultParser.parse(output))
    }

    @Test
    fun assistantRoleMessageStartStillCreatesBubble() {
        val projector = ConversationProjector()
        projector.apply(StreamEvent.MessageStarted(messageId = "m2", role = "assistant"))
        assertTrue(projector.messages.any { it.isAssistant && it.serverId == "m2" })
    }

    @Test
    fun missingRoleMessageStartKeepsLegacyBehavior() {
        val projector = ConversationProjector()
        projector.apply(StreamEvent.MessageStarted(messageId = "m3"))
        assertTrue(projector.messages.any { it.isAssistant && it.serverId == "m3" })
    }

    @Test
    fun truncatedTerminalStdoutStillParsesUrl() {
        // stdout 是截断的 JSON 尾段（不以 `{` 开头、括号不闭合），信封整体仍是合法 JSON；
        // 走截断正则兜底取链，与 Electron 截断口径一致。
        val truncatedTail =
            """"result_urls": ["https://cdn.example.com/tail.png?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Signature=abc"""
        val quoted = Json.encodeToString(truncatedTail)
        val content = """{"status":"completed","_terminal_update":true,"stdout":$quoted}"""
        assertEquals(
            "https://cdn.example.com/tail.png?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Signature=abc",
            MediaImageGenerateResultParser.parse(content),
        )
    }
}
