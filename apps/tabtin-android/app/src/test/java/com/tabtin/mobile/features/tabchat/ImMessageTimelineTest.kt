package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ImMessage
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test

class ImMessageTimelineTest {
    @Test
    fun `group creation notice uses real timestamp only at earliest history`() {
        val notice = formatGroupCreatedNotice("2026-08-12T09:00:00Z")

        assertTrue(notice?.startsWith("群组创建于 ") == true)
        assertEquals(null, formatGroupCreatedNotice("not-a-date"))
    }

    private fun message(
        id: Int,
        senderId: String,
        createdAt: String,
        senderType: String = "user",
        messageType: Int = com.tabtin.mobile.data.im.ImMessageType.TEXT,
    ): ImMessage = ImMessage(
        id = id,
        seq = id,
        conversationId = "conv-1",
        senderId = senderId,
        senderType = senderType,
        content = "hello",
        messageType = messageType,
        createdAt = createdAt,
    )

    @Test
    fun `incoming avatar only shows at message group start`() {
        val first = message(1, "user-a", "2026-08-01T10:00:00Z")
        val grouped = message(2, "user-a", "2026-08-01T10:01:00Z")

        assertTrue(ImMessageTimeline.showsIncomingAvatar(first, null, "me"))
        assertFalse(ImMessageTimeline.showsIncomingAvatar(grouped, first, "me"))
    }

    @Test
    fun `recalled message breaks the next incoming visual group`() {
        val recalled = message(1, "user-a", "2026-08-01T10:00:00Z").copy(isDeleted = true)
        val next = message(2, "user-a", "2026-08-01T10:01:00Z")

        assertTrue(ImMessageTimeline.isGroupStart(next, recalled))
        assertTrue(ImMessageTimeline.showsIncomingAvatar(next, recalled, "me"))
        assertTrue(
            ImMessageTimeline.showsIncomingSenderName(
                message = next,
                previous = recalled,
                isDm = false,
                currentUserId = "me",
            ),
        )
    }

    @Test
    fun `outgoing message does not show avatar`() {
        val outgoing = message(1, "me", "2026-08-01T10:00:00Z")
        assertFalse(ImMessageTimeline.showsIncomingAvatar(outgoing, null, "me"))
    }

    @Test
    fun `only human sender avatar in group can open direct message`() {
        val human = message(1, "user-a", "2026-08-01T10:00:00Z")
        val agent = message(2, "agent-a", "2026-08-01T10:01:00Z", senderType = "agent")

        assertTrue(ImMessageTimeline.canOpenSenderDirectMessage(human, isDm = false, currentUserId = "me"))
        assertFalse(ImMessageTimeline.canOpenSenderDirectMessage(human, isDm = true, currentUserId = "me"))
        assertFalse(ImMessageTimeline.canOpenSenderDirectMessage(agent, isDm = false, currentUserId = "me"))
    }
}
