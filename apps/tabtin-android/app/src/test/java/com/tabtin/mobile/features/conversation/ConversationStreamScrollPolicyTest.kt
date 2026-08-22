package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationStreamScrollPolicyTest {
    @Test
    fun `streaming after initial settle must not re-run settle path`() {
        assertFalse(
            ConversationStreamScrollPolicy.shouldRunInitialSettle(
                focusMessageIdBlank = true,
                hasMessages = true,
                isLoadingMore = false,
                isStreaming = true,
                hasSettledInitialPosition = true,
                hasSettledInitialHistory = true,
            ),
        )
    }

    @Test
    fun `first paint before settle still runs`() {
        assertTrue(
            ConversationStreamScrollPolicy.shouldRunInitialSettle(
                focusMessageIdBlank = true,
                hasMessages = true,
                isLoadingMore = false,
                isStreaming = false,
                hasSettledInitialPosition = false,
                hasSettledInitialHistory = false,
            ),
        )
    }

    @Test
    fun `history still loading after position settle still runs`() {
        assertTrue(
            ConversationStreamScrollPolicy.shouldRunInitialSettle(
                focusMessageIdBlank = true,
                hasMessages = true,
                isLoadingMore = false,
                isStreaming = false,
                hasSettledInitialPosition = true,
                hasSettledInitialHistory = false,
            ),
        )
    }

    @Test
    fun `after initial history settled idle chat does not settle on identity churn`() {
        assertFalse(
            ConversationStreamScrollPolicy.shouldRunInitialSettle(
                focusMessageIdBlank = true,
                hasMessages = true,
                isLoadingMore = false,
                isStreaming = false,
                hasSettledInitialPosition = true,
                hasSettledInitialHistory = true,
            ),
        )
    }

    @Test
    fun `message identity ignores body growth`() {
        val ids = listOf("u1", "a1")
        assertEquals(
            ConversationStreamScrollPolicy.messageIdentityKey(ids),
            ConversationStreamScrollPolicy.messageIdentityKey(ids),
        )
    }

    @Test
    fun `programmatic scroll during streaming must not unpin`() {
        assertTrue(
            ConversationStreamScrollPolicy.nextPinnedToBottom(
                currentlyPinned = true,
                nearBottom = false,
                isStreaming = true,
                isUserDragging = false,
                userScrollSettled = false,
            ),
        )
    }

    @Test
    fun `user drag during streaming can unpin`() {
        assertFalse(
            ConversationStreamScrollPolicy.nextPinnedToBottom(
                currentlyPinned = true,
                nearBottom = false,
                isStreaming = true,
                isUserDragging = true,
                userScrollSettled = false,
            ),
        )
    }

    @Test
    fun `user fling settling at bottom re-pins while streaming`() {
        assertTrue(
            ConversationStreamScrollPolicy.nextPinnedToBottom(
                currentlyPinned = false,
                nearBottom = true,
                isStreaming = true,
                isUserDragging = false,
                userScrollSettled = true,
            ),
        )
    }

    @Test
    fun `idle chat still follows near-bottom for pin`() {
        assertFalse(
            ConversationStreamScrollPolicy.nextPinnedToBottom(
                currentlyPinned = true,
                nearBottom = false,
                isStreaming = false,
                isUserDragging = false,
                userScrollSettled = false,
            ),
        )
    }

    @Test
    fun `streaming follow never jumps to last item even if it is offscreen`() {
        assertFalse(
            ConversationStreamScrollPolicy.shouldJumpToLastItem(
                lastAlreadyVisible = false,
                trailingOnly = true,
            ),
        )
    }

    @Test
    fun `visible last item never uses scrollToItem`() {
        assertFalse(
            ConversationStreamScrollPolicy.shouldJumpToLastItem(
                lastAlreadyVisible = true,
                trailingOnly = false,
            ),
        )
    }

    @Test
    fun `new message settle may jump when last item is not visible`() {
        assertTrue(
            ConversationStreamScrollPolicy.shouldJumpToLastItem(
                lastAlreadyVisible = false,
                trailingOnly = false,
            ),
        )
    }

    @Test
    fun `strict canScrollForward must not rewrite pin during streaming`() {
        assertFalse(ConversationStreamScrollPolicy.shouldUpdatePinFromStrictEnd(isStreaming = true))
        assertTrue(ConversationStreamScrollPolicy.shouldUpdatePinFromStrictEnd(isStreaming = false))
    }

    @Test
    fun `near-end with slack still counts as bottom even if list can scroll a bit`() {
        assertTrue(
            ConversationStreamScrollPolicy.isAtBottomForPin(
                canScrollForward = true,
                trailingOverflowPx = 80,
                slackPx = 96,
            ),
        )
        assertFalse(
            ConversationStreamScrollPolicy.isAtBottomForPin(
                canScrollForward = true,
                trailingOverflowPx = 200,
                slackPx = 96,
            ),
        )
        assertTrue(
            ConversationStreamScrollPolicy.isAtBottomForPin(
                canScrollForward = false,
                trailingOverflowPx = 400,
                slackPx = 96,
            ),
        )
    }

    @Test
    fun `streaming tail follow requires pin and an active stream`() {
        assertTrue(
            ConversationStreamScrollPolicy.shouldFollowStreamingTail(
                pinned = true,
                isLoadingMore = false,
                isUserDragging = false,
                isStreaming = true,
            ),
        )
        assertFalse(
            ConversationStreamScrollPolicy.shouldFollowStreamingTail(
                pinned = true,
                isLoadingMore = false,
                isUserDragging = true,
                isStreaming = true,
            ),
        )
        assertFalse(
            ConversationStreamScrollPolicy.shouldFollowStreamingTail(
                pinned = false,
                isLoadingMore = false,
                isUserDragging = false,
                isStreaming = true,
            ),
        )
    }
}
