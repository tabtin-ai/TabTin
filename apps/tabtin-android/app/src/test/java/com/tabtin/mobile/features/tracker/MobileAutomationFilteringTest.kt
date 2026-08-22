package com.tabtin.mobile.features.tracker

import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.data.model.tracker.TrackerStatus
import org.junit.Assert.assertEquals
import org.junit.Test

class MobileAutomationFilteringTest {

    @Test
    fun `status filter exposes every supported automation lifecycle state`() {
        assertEquals(
            listOf(
                null,
                TrackerStatus.ACTIVE,
                TrackerStatus.PAUSED,
                TrackerStatus.DRAFT,
                TrackerStatus.DISABLED,
            ),
            MobileAutomationStatusFilter.entries.map { it.trackerStatus },
        )
    }

    @Test
    fun `keeps only matching workspace status and search results`() {
        val trackers = listOf(
            Tracker(
                id = "active-match",
                name = "日报汇总",
                workspaceId = "workspace-1",
                status = TrackerStatus.ACTIVE,
            ),
            Tracker(
                id = "paused-match",
                name = "日报汇总",
                workspaceId = "workspace-1",
                status = TrackerStatus.PAUSED,
            ),
            Tracker(
                id = "other-workspace",
                name = "日报汇总",
                workspaceId = "workspace-2",
                status = TrackerStatus.ACTIVE,
            ),
        )

        val results = filterMobileAutomations(
            trackers = trackers,
            searchQuery = "日报",
            workspaceId = "workspace-1",
            status = MobileAutomationStatusFilter.ACTIVE,
        )

        assertEquals(listOf("active-match"), results.map(Tracker::id))
    }
}
