package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.data.model.StreamEvent
import com.tabtin.mobile.data.wire.buildChatCancelPayload
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ：未答轮次撤回 — 判定、时间线抽除、chat.cancel 载荷。
 * （只写不跑；由父代理统一构建验证。）
 */
class WithdrawUnansweredTurnTest {

    @Test
    fun thinkingOnlyIsNotSubstantiveAndCanWithdraw() {
        val projector = ConversationProjector()
        val clientId = "client-thinking-only"
        projector.appendUserMessage(clientId, "发错了", null)
        projector.beginAssistant("asst-$clientId")
        projector.apply(
            StreamEvent.ThinkingBlockDelta(
                messageId = "asst-$clientId",
                index = 0,
                text = "先想想",
            ),
        )

        assertFalse(projector.hasSubstantiveAssistantOutput(clientId))
        assertTrue(evaluateCanWithdrawUnansweredTurn(projector.messages, clientId))

        projector.withdrawUnansweredTurn(clientId)
        assertTrue(projector.messages.isEmpty())
    }

    @Test
    fun textOrToolBlocksBlockWithdraw() {
        val clientId = "client-has-text"
        val withText = listOf(
            ChatMessage(id = clientId, role = "user", content = "问", clientEventId = clientId),
            ChatMessage(
                id = "asst-1",
                role = "assistant",
                content = "答",
                blocksJson = listOf(BlockItem(type = "text", text = "答")),
            ),
        )
        assertTrue(withText.hasSubstantiveAssistantOutput(clientId))
        assertFalse(evaluateCanWithdrawUnansweredTurn(withText, clientId))

        val withTool = listOf(
            ChatMessage(id = clientId, role = "user", content = "跑工具", clientEventId = clientId),
            ChatMessage(
                id = "asst-2",
                role = "assistant",
                agentSteps = listOf(
                    AgentStep(
                        id = "tool-1",
                        type = StepType.TOOL_CALL,
                        name = "bash",
                        status = StepStatus.RUNNING,
                    ),
                ),
            ),
        )
        assertTrue(withTool.hasSubstantiveAssistantOutput(clientId))
        assertFalse(evaluateCanWithdrawUnansweredTurn(withTool, clientId))
    }

    @Test
    fun olderUserTurnCannotWithdrawWhenLaterTurnExists() {
        val older = "client-older"
        val newer = "client-newer"
        val messages = listOf(
            ChatMessage(id = older, role = "user", content = "旧", clientEventId = older),
            ChatMessage(id = "asst-empty", role = "assistant", content = ""),
            ChatMessage(id = newer, role = "user", content = "新", clientEventId = newer),
        )
        assertFalse(evaluateCanWithdrawUnansweredTurn(messages, older))
        assertTrue(evaluateCanWithdrawUnansweredTurn(messages, newer))
    }

    @Test
    fun withdrawCancelPayloadCarriesWithdrawFlags() {
        // 「撤回触发 chat.cancel」：载荷必须含 withdraw_unanswered，与 iOS Composer Stop 同款。
        val stopOnly = buildChatCancelPayload(sessionId = "s1", taskId = "t1")
        assertEquals("s1", stopOnly["session_id"]?.jsonPrimitive?.content)
        assertEquals("t1", stopOnly["task_id"]?.jsonPrimitive?.content)
        assertNull(stopOnly["withdraw_unanswered"])
        assertNull(stopOnly["client_message_id"])

        val request = resolveWithdrawCancelRequest(
            ChatMessage(
                id = "local-user",
                role = "user",
                content = "发错了",
                clientEventId = "client-evt-1",
            ),
        )
        val withdraw = buildChatCancelPayload(
            sessionId = "s1",
            taskId = "t1",
            clientMessageId = request.clientMessageId,
            withdrawUnanswered = true,
            targetContent = request.targetContent,
        )
        assertEquals(true, withdraw["withdraw_unanswered"]?.jsonPrimitive?.booleanOrNull)
        assertEquals("client-evt-1", withdraw["client_message_id"]?.jsonPrimitive?.content)
        assertEquals("发错了", withdraw["target_content"]?.jsonPrimitive?.content)
    }
}
