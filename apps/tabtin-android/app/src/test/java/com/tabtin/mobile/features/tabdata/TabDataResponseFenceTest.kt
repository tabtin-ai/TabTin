package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataTable
import com.tabtin.mobile.data.model.tabdata.TabDataView
import com.tabtin.mobile.data.model.tabdata.TabDataViewRecordsResponse
import org.junit.Assert.assertThrows
import org.junit.Test

public class TabDataResponseFenceTest {
    @Test
    public fun `missing or different table organization crosses the organization boundary`() {
        listOf(null, "", "org-2").forEach { organizationId ->
            assertThrows(TabDataOrganizationBoundaryException::class.java) {
                TabDataResponseFence.requireTable(
                    TabDataTable(id = "table-1", name = "Wrong", organizationId = organizationId),
                    expectedTableId = "table-1",
                    expectedOrganizationId = "org-1",
                )
            }
        }
    }

    @Test
    public fun `table view field and detail identities fail closed`() {
        assertThrows(TabDataResponseMismatchException::class.java) {
            TabDataResponseFence.requireTable(
                TabDataTable(id = "wrong", name = "Wrong", organizationId = "org-1"),
                expectedTableId = "table-1",
                expectedOrganizationId = "org-1",
            )
        }
        assertThrows(TabDataResponseMismatchException::class.java) {
            TabDataResponseFence.requireViews(
                listOf(TabDataView(id = "view-1", tableId = "wrong", name = "Wrong")),
                "table-1",
            )
        }
        assertThrows(TabDataResponseMismatchException::class.java) {
            TabDataResponseFence.requireFields(
                listOf(TabDataField(id = "field-1", tableId = "wrong", name = "标题", fieldType = "text")),
                "table-1",
            )
        }
        assertThrows(TabDataResponseMismatchException::class.java) {
            TabDataResponseFence.requireRecord(
                TabDataRecord(id = "wrong", tableId = "table-1"),
                expectedTableId = "table-1",
                expectedRecordId = "record-1",
            )
        }
        assertThrows(TabDataResponseMismatchException::class.java) {
            TabDataResponseFence.requireRecordPage(
                TabDataViewRecordsResponse(
                    records = listOf(TabDataRecord(id = "record-1", tableId = "wrong")),
                ),
                expectedView = TabDataView(id = "view-1", tableId = "table-1", name = "All"),
                expectedTableId = "table-1",
            )
        }
    }
}
