package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ImMessage
import java.io.File
import java.time.Instant
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test

class ImMessageInteractionsTest {
    @Test
    fun `reaction rows keep five item wrapping with compact vertical spacing`() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/tabchat/ImMessageInteractions.kt",
        ).readText()
        val reactionBar = source.substringAfter("internal fun ImReactionBar(")
            .substringBefore("private fun ImReactionChip(")
        val reactionChip = source.substringAfter("private fun ImReactionChip(")
            .substringBefore("internal fun ImRecalledBubble(")

        assertTrue(reactionBar.contains("items.chunked(IM_REACTION_MAX_ITEMS_PER_ROW)"))
        assertTrue(reactionBar.contains("verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs)"))
        assertTrue(reactionBar.contains("padding(start = if (isMine) 0.dp else 46.dp)"))
        assertTrue(reactionChip.contains("LocalMinimumInteractiveComponentSize provides Dp.Unspecified"))
    }

    @Test
    fun `failed recall produces user visible feedback`() {
        assertEquals("消息撤回失败，请稍后重试", imRecallFeedbackMessage(success = false))
        assertEquals(null, imRecallFeedbackMessage(success = true))
    }

    @Test
    fun `recall preview only changes when target reaches the known conversation tail`() {
        assertTrue(
            imRecallTargetIsLatest(
                targetSeq = 12,
                loadedLastSeq = 10,
                listedLastSeq = 12,
            ),
        )
        assertFalse(
            imRecallTargetIsLatest(
                targetSeq = 10,
                loadedLastSeq = 10,
                listedLastSeq = 12,
            ),
        )
    }

    @Test
    fun `recall window accepts ISO instant timestamp`() {
        val now = Instant.parse("2026-08-05T04:30:00Z")
        val message = ImMessage(
            id = 1,
            seq = 1,
            conversationId = "conv-1",
            content = "hello",
            createdAt = now.minusSeconds(30).toString(),
        )

        assertTrue(imWithinRecallWindow(message, nowMs = now.toEpochMilli()))
    }

    @Test
    fun `recall window rejects old ISO instant timestamp`() {
        val now = Instant.parse("2026-08-05T04:30:00Z")
        val message = ImMessage(
            id = 1,
            seq = 1,
            conversationId = "conv-1",
            content = "hello",
            createdAt = now.minusSeconds(180).toString(),
        )

        assertFalse(imWithinRecallWindow(message, nowMs = now.toEpochMilli()))
    }
}
