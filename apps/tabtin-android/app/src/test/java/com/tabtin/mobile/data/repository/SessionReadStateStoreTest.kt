package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.SessionReadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionReadStateStoreTest {

    @Test
    fun `an acknowledged cursor survives a stale session snapshot`() {
        val store = SessionReadStateStore()
        val unread = readState(lastReadSequence = 3, lastReadRevision = 2)
        val acknowledged = unread.copy(
            lastReadRunSequence = 4,
            lastReadTerminalRevision = 1L,
        )

        assertTrue(store.accept("session-1", unread))
        assertTrue(store.accept("session-1", acknowledged))
        assertFalse(store.accept("session-1", unread))

        assertEquals(acknowledged, store.latest("session-1"))
        assertFalse(store.latest("session-1")!!.hasUnreadReply)
    }

    private fun readState(
        lastReadSequence: Int,
        lastReadRevision: Int,
    ): SessionReadState = SessionReadState(
        lastReadRunSequence = lastReadSequence,
        lastReadTerminalRevision = lastReadRevision.toLong(),
        latestCompletedRunId = "run-4",
        latestCompletedRunSequence = 4,
        latestCompletedTerminalRevision = 1L,
    )
}
