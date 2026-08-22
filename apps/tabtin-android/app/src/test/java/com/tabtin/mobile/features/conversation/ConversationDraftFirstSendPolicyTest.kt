package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationDraftFirstSendPolicyTest {
    @Test
    fun draftEntryWhenSessionIdBlankOrStartsNewSession() {
        assertTrue(ConversationDraftFirstSendPolicy.isDraftEntry("", startsNewSession = false))
        assertTrue(ConversationDraftFirstSendPolicy.isDraftEntry("", startsNewSession = true))
        assertTrue(
            ConversationDraftFirstSendPolicy.isDraftEntry(
                sessionId = "sess-1",
                startsNewSession = true,
            ),
        )
        assertFalse(
            ConversationDraftFirstSendPolicy.isDraftEntry(
                sessionId = "sess-1",
                startsNewSession = false,
            ),
        )
    }

    @Test
    fun beginFirstSendOnlyOnceWhileDraftWithoutSession() {
        assertTrue(
            ConversationDraftFirstSendPolicy.canBeginFirstSend(
                draftMode = true,
                hasSession = false,
                firstSendInFlight = false,
            ),
        )
        assertFalse(
            ConversationDraftFirstSendPolicy.canBeginFirstSend(
                draftMode = true,
                hasSession = false,
                firstSendInFlight = true,
            ),
        )
        assertFalse(
            ConversationDraftFirstSendPolicy.canBeginFirstSend(
                draftMode = true,
                hasSession = true,
                firstSendInFlight = false,
            ),
        )
        assertFalse(
            ConversationDraftFirstSendPolicy.canBeginFirstSend(
                draftMode = false,
                hasSession = false,
                firstSendInFlight = false,
            ),
        )
    }
}
