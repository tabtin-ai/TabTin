package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.SessionRunStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PauseControlPolicyTest {
    @Test
    fun `pause ack keeps pending and does not claim the runtime stopped`() {
        val next = pauseControlAfterAck(
            requestedPause = true,
            ackSucceeded = true,
            currentlyPaused = false,
            currentlyPending = true,
        )
        assertFalse(next.isPaused)
        assertTrue(next.isPauseControlPending)
    }

    @Test
    fun `resume ack clears pause immediately`() {
        val next = pauseControlAfterAck(
            requestedPause = false,
            ackSucceeded = true,
            currentlyPaused = true,
            currentlyPending = true,
        )
        assertFalse(next.isPaused)
        assertFalse(next.isPauseControlPending)
    }

    @Test
    fun `failed ack drops the pending request`() {
        val next = pauseControlAfterAck(
            requestedPause = true,
            ackSucceeded = false,
            currentlyPaused = false,
            currentlyPending = true,
        )
        assertFalse(next.isPaused)
        assertFalse(next.isPauseControlPending)
    }

    @Test
    fun `run state paused is the only reached-pause signal`() {
        val next = pauseControlAfterRunState(
            runStatus = SessionRunStatus.PAUSED,
            currentlyPending = true,
        )
        assertTrue(next.isPaused)
        assertFalse(next.isPauseControlPending)
    }

    @Test
    fun `run state still running after pause ack keeps pending`() {
        val next = pauseControlAfterRunState(
            runStatus = SessionRunStatus.RUNNING,
            currentlyPending = true,
        )
        assertFalse(next.isPaused)
        assertTrue(next.isPauseControlPending)
        assertEquals(
            PauseControlPresentation(isPaused = false, isPauseControlPending = false),
            pauseControlAfterRunState(
                runStatus = SessionRunStatus.COMPLETED,
                currentlyPending = true,
            ),
        )
    }

    @Test
    fun `session requested pause restores pending when run state is still running`() {
        val next = pauseControlAfterRunState(
            runStatus = SessionRunStatus.RUNNING,
            currentlyPending = false,
            sessionRequestedPause = true,
        )
        assertFalse(next.isPaused)
        assertTrue(next.isPauseControlPending)
        assertEquals(
            PauseControlPresentation(isPaused = true, isPauseControlPending = false),
            pauseControlAfterRunState(
                runStatus = SessionRunStatus.PAUSED,
                currentlyPending = false,
                sessionRequestedPause = true,
            ),
        )
        assertEquals(
            PauseControlPresentation(isPaused = false, isPauseControlPending = false),
            pauseControlAfterRunState(
                runStatus = SessionRunStatus.COMPLETED,
                currentlyPending = false,
                sessionRequestedPause = true,
            ),
        )
    }

    @Test
    fun `pause pending does not block stop`() {
        assertTrue(pauseControlAllowsStop(hasActiveRun = true, isPaused = false, pausePending = true))
        assertTrue(pauseControlAllowsStop(hasActiveRun = false, isPaused = false, pausePending = true))
        assertFalse(pauseControlAllowsStop(hasActiveRun = false, isPaused = false, pausePending = false))
    }
}
