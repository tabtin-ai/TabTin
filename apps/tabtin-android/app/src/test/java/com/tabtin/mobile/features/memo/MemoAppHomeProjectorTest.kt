package com.tabtin.mobile.features.memo

import com.tabtin.mobile.data.model.memo.MemoAppHomeFeatureFlags
import com.tabtin.mobile.data.model.memo.MemoHeatmapBucket
import com.tabtin.mobile.data.model.memo.MemoSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class MemoAppHomeProjectorTest {

    private val zone = ZoneId.of("Asia/Shanghai")

    @Test
    fun `visible kinds hide agent diary while flag is off`() {
        assertFalse(MemoAppHomeFeatureFlags.IS_ORGANIZATION_AGENT_DIARY_ENABLED)
        assertEquals(
            listOf(MemoViewKind.ALL, MemoViewKind.TODAY),
            MemoViewKind.visibleKinds(),
        )
    }

    @Test
    fun `today query snapshot uses half-open local day bounds`() {
        val today = LocalDate.of(2026, 7, 31)
        val snapshot = MemoListQuerySnapshot.forView(
            organizationId = "org-1",
            spaceId = "",
            viewKind = MemoViewKind.TODAY,
            status = "active",
            zoneId = zone,
            today = today,
        )
        assertEquals("2026-07-31T00:00:00+08:00", snapshot.createdAfter)
        assertEquals("2026-08-01T00:00:00+08:00", snapshot.createdBefore)
        assertNull(
            MemoListQuerySnapshot.forView(
                organizationId = "org-1",
                spaceId = "",
                viewKind = MemoViewKind.ALL,
                status = "active",
                zoneId = zone,
                today = today,
            ).createdAfter,
        )
    }

    @Test
    fun `sections project pinned today yesterday this week and earlier`() {
        val today = LocalDate.of(2026, 7, 31) // Friday
        val memos = listOf(
            memo("p1", "2026-07-31T10:00:00+08:00", pinned = true),
            memo("t1", "2026-07-31T09:00:00+08:00"),
            memo("y1", "2026-07-30T12:00:00+08:00"),
            memo("w1", "2026-07-28T12:00:00+08:00"), // Tuesday this week
            memo("e1", "2026-07-20T12:00:00+08:00"),
        )
        val sections = MemoHomeProjector.projectSections(memos, zoneId = zone, today = today)
        assertEquals(
            listOf(
                MemoHomeSectionKind.PINNED,
                MemoHomeSectionKind.TODAY,
                MemoHomeSectionKind.YESTERDAY,
                MemoHomeSectionKind.THIS_WEEK,
                MemoHomeSectionKind.EARLIER,
            ),
            sections.map { it.kind },
        )
        assertEquals(listOf("p1"), sections[0].memos.map { it.id })
        assertEquals(listOf("t1"), sections[1].memos.map { it.id })
        assertEquals(listOf("y1"), sections[2].memos.map { it.id })
        assertEquals(listOf("w1"), sections[3].memos.map { it.id })
        assertEquals(listOf("e1"), sections[4].memos.map { it.id })
    }

    @Test
    fun `heatmap month count sums only current month buckets`() {
        val today = LocalDate.of(2026, 7, 31)
        val projected = MemoHomeProjector.projectHeatmap(
            buckets = listOf(
                MemoHeatmapBucket("2026-07-01", 2),
                MemoHeatmapBucket("2026-07-15", 3),
                MemoHeatmapBucket("2026-06-30", 9),
            ),
            days = 84,
            zoneId = zone,
            today = today,
        )
        assertEquals(5, projected.monthCount)
        assertTrue(projected.buckets.size == 3)
    }

    private fun memo(id: String, createdAt: String, pinned: Boolean = false): MemoSummary =
        MemoSummary(
            id = id,
            contentPlaintext = id,
            createdAt = createdAt,
            updatedAt = createdAt,
            isPinned = pinned,
        )
}

