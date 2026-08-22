package com.tabtin.mobile.data.model.tracker

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrackerModelsDecodingTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `decodes server authority and waiting device run facts`() {
        val tracker = json.decodeFromString<Tracker>(
            """
                {
                  "id": "tracker-1",
                  "name": "日报",
                  "status": "archived",
                  "workspace_id": "workspace-1",
                  "space_name": "产品组",
                  "capabilities": { "can_edit": false, "can_trigger": true, "can_cancel": false }
                }
            """.trimIndent(),
        )
        val run = json.decodeFromString<TrackerRun>(
            """
                {
                  "id": "run-1",
                  "tracker_id": "tracker-1",
                  "chat_session_id": "session-1",
                  "status": "waiting_device",
                  "progress_pct": 42,
                  "progress_message": "等待 Mac 上线",
                  "result_summary": "",
                  "capabilities": { "can_edit": false, "can_trigger": false, "can_cancel": true }
                }
            """.trimIndent(),
        )

        assertEquals(TrackerStatus.ARCHIVED, tracker.status)
        assertEquals("workspace-1", tracker.workspaceId)
        assertEquals("产品组", tracker.spaceName)
        assertTrue(tracker.capabilities.canTrigger)
        assertFalse(tracker.capabilities.canEdit)
        assertEquals(TrackerRunStatus.WAITING_DEVICE, run.status)
        assertEquals("session-1", run.chatSessionId)
        assertEquals(42, run.progressPct)
        assertTrue(run.capabilities.canCancel)
    }

    @Test
    fun `keeps the tracker page readable when the server adds a status`() {
        val tracker = json.decodeFromString<Tracker>(
            """{ "id": "tracker-1", "name": "日报", "status": "future_status" }""",
        )
        val run = json.decodeFromString<TrackerRun>(
            """{ "id": "run-1", "tracker_id": "tracker-1", "status": "future_status" }""",
        )

        assertEquals(TrackerStatus.UNKNOWN, tracker.status)
        assertEquals(TrackerRunStatus.UNKNOWN, run.status)
    }
}
