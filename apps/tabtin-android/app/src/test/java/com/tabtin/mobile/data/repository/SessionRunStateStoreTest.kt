package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.SessionRunState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionRunStateStoreTest {

    @Test
    fun `newer realtime state survives a stale later session snapshot`() {
        val store = SessionRunStateStore()
        val running = runState(revision = 2, status = "running")
        val staleSnapshot = runState(revision = 1, status = "queued")

        assertTrue(store.accept("session-1", running))
        assertFalse(store.accept("session-1", staleSnapshot))

        assertEquals(running, store.latest("session-1"))
    }

    @Test
    fun `new run sequence replaces terminal state from a prior run`() {
        val store = SessionRunStateStore()
        val completed = runState(runId = "run-1", sequence = 1, revision = 5, status = "completed")
        val queued = runState(runId = "run-2", sequence = 2, revision = 0, status = "queued")

        assertTrue(store.accept("session-1", completed))
        assertTrue(store.accept("session-1", queued))

        assertEquals(queued, store.latest("session-1"))
    }

    @Test
    fun `higher revision authoritative active state replaces same run terminal`() {
        val store = SessionRunStateStore()
        val completed = runState(runId = "run-1", sequence = 1, revision = 5, status = "completed")
        val running = runState(runId = "run-1", sequence = 1, revision = 6, status = "running")

        assertTrue(store.accept("session-1", completed))
        assertTrue(store.accept("session-1", running))
        assertEquals(running, store.latest("session-1"))
    }

    private fun runState(
        runId: String = "run-1",
        sequence: Int = 1,
        revision: Int,
        status: String,
    ): SessionRunState = SessionRunState(
        runId = runId,
        sequence = sequence,
        revision = revision.toLong(),
        status = status,
        queueDepth = 0,
        stateChangedAt = "2026-07-30T00:00:00Z",
    )
}
