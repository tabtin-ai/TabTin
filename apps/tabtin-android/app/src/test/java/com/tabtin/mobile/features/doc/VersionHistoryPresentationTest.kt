package com.tabtin.mobile.features.doc

import com.tabtin.mobile.data.model.doc.DocHistoryEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class VersionHistoryPresentationTest {
    @Test
    fun `history without name or timestamp uses product language instead of record id`() {
        val entry = DocHistoryEntry(
            id = "internal-history-record-id",
            name = "",
            createdAt = null,
        )

        val title = versionHistoryEntryTitle(
            entry = entry,
            snapshotLabel = "Snapshot",
            historyVersionLabel = "History version",
        )

        assertEquals("History version", title)
        assertFalse(title.contains(entry.id))
        assertFalse(title.contains(entry.id.take(8)))
    }
}
