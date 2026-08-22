package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ChatMessage
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ：`withdraw_applied` 门控终态对账。
 * （只写不跑；由父代理统一 gradle 验证。）
 */
class WithdrawReconcileExemptionTest {

    @Test
    fun parseWithdrawAppliedReadsOptionalBoolean() {
        assertEquals(
            true,
            parseWithdrawApplied(buildJsonObject { put("withdraw_applied", true) }),
        )
        assertEquals(
            false,
            parseWithdrawApplied(buildJsonObject { put("withdraw_applied", false) }),
        )
        assertNull(parseWithdrawApplied(buildJsonObject { put("session_id", "s1") }))
        assertNull(parseWithdrawApplied(buildJsonObject { put("withdraw_applied", JsonNull) }))
    }

    @Test
    fun onlyTrueExemptsTerminalReconcile() {
        assertTrue(shouldExemptWithdrawnTurnReconcile(true))
        assertFalse(shouldExemptWithdrawnTurnReconcile(false))
        assertFalse(shouldExemptWithdrawnTurnReconcile(null))
    }

    @Test
    fun historyForReconcileDropsWithdrawnTurnWhenExempt() {
        val withdrawn = "client-withdrawn"
        val older = ChatMessage(id = "u0", role = "user", content = "更早", clientEventId = "client-older")
        val olderAsst = ChatMessage(id = "a0", role = "assistant", content = "旧答")
        val target = ChatMessage(
            id = withdrawn,
            role = "user",
            content = "发错了",
            clientEventId = withdrawn,
        )
        val ghostAsst = ChatMessage(id = "a1", role = "assistant", content = "")
        val history = listOf(older, olderAsst, target, ghostAsst)

        // withdraw_applied=true → 豁免：不得把已撤 user 及其后内容回灌
        val exempted = historyForWithdrawReconcile(history, withdrawn)
        assertEquals(listOf(older, olderAsst), exempted)

        // withdraw_applied=false → 不豁免：完整历史用于回拉
        assertEquals(history, historyForWithdrawReconcile(history, exemptWithdrawnClientMessageId = null))

        // 字段缺失（旧后端）→ 与 false 相同：现状行为，完整回拉
        assertEquals(history, historyForWithdrawReconcile(history, exemptWithdrawnClientMessageId = null))
    }

    @Test
    fun excludingWithdrawnTurnMatchesByIdentityKeys() {
        val clientId = "client-evt-9"
        val history = listOf(
            ChatMessage(id = "server-user-9", role = "user", content = "误发", clientEventId = clientId),
            ChatMessage(id = "asst-9", role = "assistant", content = "…"),
        )
        assertTrue(history.excludingWithdrawnTurn(clientId).isEmpty())
        assertEquals(history, history.excludingWithdrawnTurn("other-id"))
    }
}
