package com.tabtin.mobile.features.tabdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataRecordGroup

class TabDataRecordNavigationPolicyTest {
    @Test
    fun `neighbors follow visible record order`() {
        val ids = listOf("a", "b", "c")

        val first = TabDataRecordNavigationPolicy.neighbors(ids, "a")
        assertNull(first.previousId)
        assertEquals("b", first.nextId)

        val last = TabDataRecordNavigationPolicy.neighbors(ids, "c")
        assertEquals("b", last.previousId)
        assertNull(last.nextId)

        val middle = TabDataRecordNavigationPolicy.neighbors(ids, "b")
        assertEquals("a", middle.previousId)
        assertEquals("c", middle.nextId)

        val missing = TabDataRecordNavigationPolicy.neighbors(ids, "missing")
        assertNull(missing.previousId)
        assertNull(missing.nextId)
    }

    @Test
    fun `visible ids flatten kanban groups and keep grid order`() {
        val records = listOf(record("g1"), record("g2"))
        val groups = listOf(
            group("todo", listOf(record("k1"), record("k2"))),
            group("done", listOf(record("k3"))),
        )
        assertEquals(
            listOf("g1", "g2"),
            TabDataRecordNavigationPolicy.visibleIds("grid", records, groups),
        )
        assertEquals(
            listOf("k1", "k2", "k3"),
            TabDataRecordNavigationPolicy.visibleIds("kanban", records, groups),
        )
    }

    private fun record(id: String): TabDataRecord =
        TabDataRecord(id = id, tableId = "table")

    private fun group(key: String, records: List<TabDataRecord>): TabDataRecordGroup =
        TabDataRecordGroup(
            groupValue = kotlinx.serialization.json.JsonPrimitive(key),
            groupLabel = key,
            records = records,
            count = records.size,
        )
}
