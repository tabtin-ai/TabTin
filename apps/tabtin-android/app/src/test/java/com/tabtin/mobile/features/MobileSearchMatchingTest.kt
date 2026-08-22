package com.tabtin.mobile.features

import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.features.clouddocs.matchesCloudSearch
import com.tabtin.mobile.features.conversation.matchesTaskSearch
import com.tabtin.mobile.features.tracker.matchesAutomationSearch
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileSearchMatchingTest {

    @Test
    fun `task search includes session context and ignores case`() {
        val session = AllChatSession(
            id = "session-1",
            title = "发布计划",
            agentName = "Release Agent",
            lastMessagePreview = "Waiting for approval",
        )

        assertTrue(session.matchesTaskSearch("release"))
        assertTrue(session.matchesTaskSearch("approval"))
        assertFalse(session.matchesTaskSearch("invoice"))
    }

    @Test
    fun `cloud search includes resource title preview and type`() {
        val resource = SpaceResource(
            id = "resource-1",
            itemType = "tabdoc",
            title = "Launch brief",
            preview = "Mobile release checklist",
            resourceId = "doc-1",
        )

        assertTrue(resource.matchesCloudSearch("CHECKLIST"))
        assertTrue(resource.matchesCloudSearch("tabdoc"))
        assertFalse(resource.matchesCloudSearch("spreadsheet"))
    }

    @Test
    fun `automation search includes tracker skill`() {
        val tracker = Tracker(id = "tracker-1", name = "Daily digest", skillKey = "summarize_updates")

        assertTrue(tracker.matchesAutomationSearch("SUMMARIZE"))
        assertFalse(tracker.matchesAutomationSearch("expense"))
    }
}
