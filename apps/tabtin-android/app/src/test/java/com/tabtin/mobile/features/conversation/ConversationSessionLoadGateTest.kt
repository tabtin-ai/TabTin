package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationSessionLoadGateTest {
    @Test
    fun `stale generation cannot apply to the same session`() {
        assertFalse(
            ConversationSessionLoadGate.accepts(
                requestSessionId = "session-a",
                requestGeneration = 1,
                currentSessionId = "session-a",
                currentGeneration = 2,
                streamingActive = false,
                allowWhileStreaming = false,
            ),
        )
    }

    @Test
    fun `other session cannot apply even with matching generation`() {
        assertFalse(
            ConversationSessionLoadGate.accepts(
                requestSessionId = "session-a",
                requestGeneration = 3,
                currentSessionId = "session-b",
                currentGeneration = 3,
                streamingActive = false,
                allowWhileStreaming = false,
            ),
        )
    }

    @Test
    fun `replace history is blocked while streaming`() {
        assertFalse(
            ConversationSessionLoadGate.accepts(
                requestSessionId = "session-a",
                requestGeneration = 4,
                currentSessionId = "session-a",
                currentGeneration = 4,
                streamingActive = true,
                allowWhileStreaming = false,
            ),
        )
    }

    @Test
    fun `same-generation merge may proceed while streaming`() {
        assertTrue(
            ConversationSessionLoadGate.accepts(
                requestSessionId = "session-a",
                requestGeneration = 4,
                currentSessionId = "session-a",
                currentGeneration = 4,
                streamingActive = true,
                allowWhileStreaming = true,
            ),
        )
    }

    @Test
    fun `idle same generation can replace history`() {
        assertTrue(
            ConversationSessionLoadGate.accepts(
                requestSessionId = "session-a",
                requestGeneration = 5,
                currentSessionId = "session-a",
                currentGeneration = 5,
                streamingActive = false,
                allowWhileStreaming = false,
            ),
        )
    }
}
