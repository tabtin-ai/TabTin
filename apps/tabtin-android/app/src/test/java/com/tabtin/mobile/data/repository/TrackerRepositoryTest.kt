package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.TrackerApi
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.tracker.CreateTrackerRequest
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TrackerRepositoryTest {

    @Test
    fun `create sends host in query and execution context in body`() = runTest {
        val api = mockk<TrackerApi>()
        val tokenManager = mockk<TokenManager>()
        val body = slot<CreateTrackerRequest>()
        every { tokenManager.organizationId } returns "organization-1"
        coEvery {
            api.createEvent("organization-1", "project-1", capture(body))
        } returns ApiEnvelope(
            success = true,
            data = Tracker(id = "tracker-1", name = "日报"),
        )

        val repository = TrackerRepository(api, tokenManager)
        repository.createEvent(
            name = "日报",
            description = "汇总今天的工作",
            hostSpaceId = "project-1",
            workspaceId = "workspace-1",
            agentId = "agent-1",
        )

        assertEquals("workspace-1", body.captured.workspaceId)
        assertEquals("agent-1", body.captured.agentId)
        assertEquals("汇总今天的工作", body.captured.skillParams.instructions)
    }

    @Test
    fun `blank description falls back to name as instructions`() = runTest {
        val api = mockk<TrackerApi>()
        val tokenManager = mockk<TokenManager>()
        val body = slot<CreateTrackerRequest>()
        every { tokenManager.organizationId } returns "organization-1"
        coEvery {
            api.createEvent("organization-1", "workspace-1", capture(body))
        } returns ApiEnvelope(
            success = true,
            data = Tracker(id = "tracker-1", name = "检查告警"),
        )

        TrackerRepository(api, tokenManager).createEvent(
            name = "检查告警",
            hostSpaceId = "workspace-1",
            workspaceId = "workspace-1",
            agentId = "agent-1",
        )

        assertEquals("检查告警", body.captured.skillParams.instructions)
    }

    @Test
    fun `detail reads the dedicated tracker endpoint`() = runTest {
        val api = mockk<TrackerApi>()
        val tokenManager = mockk<TokenManager>(relaxed = true)
        val tracker = Tracker(id = "tracker-1", name = "日报")
        coEvery { api.getEvent("tracker-1") } returns ApiEnvelope(success = true, data = tracker)

        val result = TrackerRepository(api, tokenManager).getEvent("tracker-1")

        assertEquals(tracker, result)
        coVerify(exactly = 1) { api.getEvent("tracker-1") }
        coVerify(exactly = 0) { api.getEvents(any(), any()) }
    }
}
