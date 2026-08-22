package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataTable
import com.tabtin.mobile.data.model.tabdata.TabDataView
import com.tabtin.mobile.data.model.tabdata.TabDataViewRecordsResponse

/**
 * 网络请求的代际只能证明“这是最后一次请求”，不能证明响应属于当前资源。
 * 所有 TabData 原生响应在进入 UI 或清理草稿前，都必须再经过资源身份栅栏。
 */
internal object TabDataResponseFence {
    fun requireTable(
        table: TabDataTable,
        expectedTableId: String,
        expectedOrganizationId: String,
    ) {
        if (table.organizationId.isNullOrBlank() || table.organizationId != expectedOrganizationId) {
            throw TabDataOrganizationBoundaryException()
        }
        if (table.id != expectedTableId) mismatch()
    }

    fun requireViews(views: List<TabDataView>, expectedTableId: String) {
        if (views.any { it.id.isBlank() || it.tableId != expectedTableId }) mismatch()
    }

    fun requireFields(fields: List<TabDataField>, expectedTableId: String) {
        if (fields.any { it.id.isBlank() || it.tableId != expectedTableId }) mismatch()
    }

    fun requireRecord(
        record: TabDataRecord,
        expectedTableId: String,
        expectedRecordId: String? = null,
    ) {
        if (
            record.id.isBlank() || record.tableId != expectedTableId ||
            (expectedRecordId != null && record.id != expectedRecordId)
        ) mismatch()
    }

    fun requireRecordPage(
        response: TabDataViewRecordsResponse,
        expectedView: TabDataView,
        expectedTableId: String,
    ) {
        response.view?.let { returnedView ->
            if (returnedView.id != expectedView.id || returnedView.tableId != expectedTableId) mismatch()
        }
        response.records.forEach { requireRecord(it, expectedTableId) }
        response.metadata.groups.forEach { group ->
            group.records.forEach { requireRecord(it, expectedTableId) }
        }
    }

    private fun mismatch(): Nothing = throw TabDataResponseMismatchException()
}

internal class TabDataOrganizationBoundaryException : Exception(
    "服务返回的多维表不属于当前组织，本地草稿已清除。",
)

internal class TabDataResponseMismatchException : Exception(
    "服务返回了不属于当前多维表的内容，本地草稿已保留。",
)
