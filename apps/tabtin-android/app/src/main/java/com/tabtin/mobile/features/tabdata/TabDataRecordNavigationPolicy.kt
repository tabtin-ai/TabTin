package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataRecordGroup

public data class TabDataRecordNeighbor(
    val previousId: String?,
    val nextId: String?,
)

public object TabDataRecordNavigationPolicy {
    public fun visibleIds(
        viewType: String?,
        records: List<TabDataRecord>,
        groups: List<TabDataRecordGroup>,
    ): List<String> {
        return if (viewType != null &&
            TabDataSurfacePolicy.kind(viewType) == TabDataSurfaceKind.KANBAN
        ) {
            groups.flatMap { group -> group.records.map { it.id } }
        } else {
            records.map { it.id }
        }
    }

    public fun neighbors(recordIds: List<String>, currentId: String): TabDataRecordNeighbor {
        val index = recordIds.indexOf(currentId)
        if (index < 0) return TabDataRecordNeighbor(previousId = null, nextId = null)
        return TabDataRecordNeighbor(
            previousId = recordIds.getOrNull(index - 1),
            nextId = recordIds.getOrNull(index + 1),
        )
    }
}
