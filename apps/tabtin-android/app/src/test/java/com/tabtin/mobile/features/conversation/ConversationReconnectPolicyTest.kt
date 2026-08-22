package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationReconnectPolicyTest {
    @Test
    fun `stable stream still drops duplicate or rewind seq`() {
        assertEquals(
            ConversationReconnectPolicy.SeqDecision.Drop,
            ConversationReconnectPolicy.decideSeq(
                previous = 150,
                incoming = 149,
                acceptLowerSeq = false,
            ),
        )
        assertEquals(
            ConversationReconnectPolicy.SeqDecision.Drop,
            ConversationReconnectPolicy.decideSeq(
                previous = 150,
                incoming = 150,
                acceptLowerSeq = false,
            ),
        )
    }

    @Test
    fun `reconnect window applies rewind seq so approval-era replay is not discarded`() {
        assertEquals(
            ConversationReconnectPolicy.SeqDecision.Apply,
            ConversationReconnectPolicy.decideSeq(
                previous = 150,
                incoming = 12,
                acceptLowerSeq = true,
            ),
        )
    }

    @Test
    fun `reconnect window does not reset accumulator on replayed seq 1`() {
        assertEquals(
            ConversationReconnectPolicy.SeqDecision.Apply,
            ConversationReconnectPolicy.decideSeq(
                previous = 150,
                incoming = 1,
                acceptLowerSeq = true,
            ),
        )
        assertEquals(
            ConversationReconnectPolicy.SeqDecision.Reset,
            ConversationReconnectPolicy.decideSeq(
                previous = 150,
                incoming = 1,
                acceptLowerSeq = false,
            ),
        )
    }

    @Test
    fun `reconnect must not replace the live streaming bubble`() {
        assertFalse(ConversationReconnectPolicy.shouldReplaceStreamingHistory(streamingActive = true))
        assertTrue(ConversationReconnectPolicy.shouldReplaceStreamingHistory(streamingActive = false))
    }

    @Test
    fun `reconnect after drop resets seq cursor`() {
        assertTrue(ConversationReconnectPolicy.shouldResetSeqCursor(connectedAfterDrop = true))
        assertFalse(ConversationReconnectPolicy.shouldResetSeqCursor(connectedAfterDrop = false))
    }

    @Test
    fun `reconnect with topics waits for subscribe before resume`() {
        assertTrue(
            ConversationReconnectPolicy.shouldWaitForSubscribeBeforeResume(
                wasReconnect = true,
                hasDesiredTopics = true,
            ),
        )
        assertFalse(
            ConversationReconnectPolicy.shouldWaitForSubscribeBeforeResume(
                wasReconnect = true,
                hasDesiredTopics = false,
            ),
        )
        assertFalse(
            ConversationReconnectPolicy.shouldWaitForSubscribeBeforeResume(
                wasReconnect = false,
                hasDesiredTopics = true,
            ),
        )
    }

    @Test
    fun `settle-only reconcile skips a streaming tick instead of aborting`() {
        assertEquals(
            ConversationReconnectPolicy.ReconcileTick.SkipWait,
            ConversationReconnectPolicy.reconcileTick(
                sessionMatches = true,
                generationMatches = true,
                streamingActive = true,
                allowWhileStreaming = false,
            ),
        )
    }

    @Test
    fun `reconnect reconcile may apply while streaming`() {
        assertEquals(
            ConversationReconnectPolicy.ReconcileTick.Apply,
            ConversationReconnectPolicy.reconcileTick(
                sessionMatches = true,
                generationMatches = true,
                streamingActive = true,
                allowWhileStreaming = true,
            ),
        )
    }

    @Test
    fun `stale generation still aborts the reconcile loop`() {
        assertEquals(
            ConversationReconnectPolicy.ReconcileTick.Abort,
            ConversationReconnectPolicy.reconcileTick(
                sessionMatches = true,
                generationMatches = false,
                streamingActive = false,
                allowWhileStreaming = true,
            ),
        )
    }
}
