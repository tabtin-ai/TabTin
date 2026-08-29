package com.tabtin.mobile.features.tabchat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImGroupCreationValidationTest {
    @Test
    fun `group chat needs two distinct recipients besides the initiator`() {
        assertFalse(
            hasMinimumImGroupRecipients(
                memberIds = setOf("me", "member-1"),
                externalContactIds = emptySet(),
                currentUserId = "me",
            ),
        )
        assertTrue(
            hasMinimumImGroupRecipients(
                memberIds = setOf("member-1", "member-2"),
                externalContactIds = emptySet(),
                currentUserId = "me",
            ),
        )
        assertTrue(
            hasMinimumImGroupRecipients(
                memberIds = setOf("member-1"),
                externalContactIds = setOf("external-1"),
                currentUserId = "me",
            ),
        )
    }

    @Test
    fun `local group validation keeps its actionable error message`() {
        assertEquals(
            "创建群聊至少添加两名成员",
            imGroupCreationFailureMessage(
                IllegalArgumentException("创建群聊至少添加两名成员"),
                "操作失败",
            ),
        )
        assertEquals(
            "操作失败",
            imGroupCreationFailureMessage(IllegalStateException("network"), "操作失败"),
        )
    }
}
