package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.TabDataApi
import com.tabtin.mobile.data.api.json
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.tabdata.TabDataBulkUpdateItem
import com.tabtin.mobile.data.model.tabdata.TabDataBulkUpdateRequest
import com.tabtin.mobile.data.model.tabdata.TabDataCreateRecordRequest
import com.tabtin.mobile.data.model.tabdata.TabDataCreateFieldRequest
import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFilterRule
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataSortRule
import com.tabtin.mobile.data.model.tabdata.TabDataTable
import com.tabtin.mobile.data.model.tabdata.TabDataUpdateOutcome
import com.tabtin.mobile.data.model.tabdata.TabDataView
import com.tabtin.mobile.data.model.tabdata.TabDataViewRecordsResponse
import java.util.UUID
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class TabDataRepository @Inject constructor(
    private val api: TabDataApi,
) {
    public suspend fun loadTable(tableId: String): TabDataTable = api.getTable(tableId).unwrap()

    public suspend fun loadViews(tableId: String): List<TabDataView> =
        api.listViews(tableId).unwrap().views.sortedWith(compareBy<TabDataView> { it.order }.thenBy { it.name })

    public suspend fun loadFields(tableId: String): List<TabDataField> =
        api.listFields(tableId).unwrap().fields.sortedBy { it.order }

    public suspend fun createField(request: TabDataCreateFieldRequest): TabDataField = try {
        api.createField(request).unwrap()
    } catch (error: HttpException) {
        throw error.toResourceVisibilityError() ?: error
    }

    public suspend fun loadViewRecords(
        view: TabDataView,
        page: Int = 1,
        pageSize: Int = DEFAULT_PAGE_SIZE,
        search: String? = null,
        filters: JsonArray? = view.legacyFilterQuery(),
        filterLogic: String? = filters?.let { view.configuredFilterLogic },
        groups: List<JsonObject> = view.groups,
        sorts: List<JsonObject> = view.sorts,
        perGroupLimit: Int? = if (view.viewType == "kanban") DEFAULT_GROUP_LIMIT else null,
        groupOffsets: Map<String, Int> = emptyMap(),
    ): TabDataViewRecordsResponse {
        val response = api.getViewRecords(
            viewId = view.id,
            page = page,
            pageSize = pageSize,
            search = search?.trim()?.takeIf { it.isNotEmpty() },
            searchHideNotMatchRows = true,
            filtersJson = filters?.let { json.encodeToString(JsonArray.serializer(), it) },
            filterLogic = filterLogic,
            groupsJson = groups.takeIf { it.isNotEmpty() }?.let { json.encodeToString(JsonArray(it)) },
            sortsJson = sorts.takeIf { it.isNotEmpty() }?.let { json.encodeToString(JsonArray(it)) },
            perGroupLimit = perGroupLimit,
            groupOffsetsJson = groupOffsets.takeIf { it.isNotEmpty() }
                ?.let { offsets ->
                    JsonObject(
                        offsets.mapValues { (_, value) -> kotlinx.serialization.json.JsonPrimitive(value) },
                    )
                }
                ?.let(json::encodeToString),
        ).unwrap()
        val returnedView = response.view
        return if (returnedView != null && returnedView.tableId.isBlank()) {
            response.copy(view = returnedView.copy(tableId = view.tableId))
        } else {
            response
        }
    }

    /**
     * 页面级搜索 / 筛选 / 排序不写回共享视图；没有临时规则时继续使用视图已保存配置。
     */
    public suspend fun loadViewRecords(
        view: TabDataView,
        page: Int,
        pageSize: Int,
        search: String?,
        filters: List<TabDataFilterRule>,
        filterLogic: String,
        sorts: List<TabDataSortRule>,
        groupOffsets: Map<String, Int> = emptyMap(),
    ): TabDataViewRecordsResponse = loadViewRecords(
        view = view,
        page = page,
        pageSize = pageSize,
        search = search,
        filters = if (filters.isEmpty()) {
            view.legacyFilterQuery()
        } else {
            JsonArray(filters.map { rule ->
                JsonObject(
                    mapOf(
                        "field_id" to kotlinx.serialization.json.JsonPrimitive(rule.fieldId),
                        "operator" to kotlinx.serialization.json.JsonPrimitive(rule.operator),
                        "value" to rule.value,
                        "enabled" to kotlinx.serialization.json.JsonPrimitive(true),
                    ),
                )
            })
        },
        filterLogic = mobileFilterLogic(view, filters, filterLogic),
        groups = view.groups,
        sorts = if (sorts.isEmpty()) view.sorts else sorts.map { rule ->
            JsonObject(
                mapOf(
                    "field_id" to kotlinx.serialization.json.JsonPrimitive(rule.fieldId),
                    "direction" to kotlinx.serialization.json.JsonPrimitive(
                        if (rule.descending) "desc" else "asc",
                    ),
                ),
            )
        },
        groupOffsets = groupOffsets,
    )

    public suspend fun loadRecord(recordId: String): TabDataRecord = try {
        api.getRecord(recordId).unwrap()
    } catch (error: HttpException) {
        throw error.toResourceVisibilityError() ?: error
    }

    public suspend fun createRecord(tableId: String, fields: JsonObject): TabDataRecord =
        try {
            api.createRecord(TabDataCreateRecordRequest(tableId, fields)).unwrap()
        } catch (error: HttpException) {
            if (error.code() == 503) throw AppError.RequestFailed(errorCode = SAVE_BUSY_CODE)
            throw error.toResourceVisibilityError() ?: error
        }

    public suspend fun updateRecord(
        recordId: String,
        dirtyFields: JsonObject,
        baseSnapshot: JsonObject,
    ): TabDataUpdateOutcome {
        val envelope = try {
            api.bulkUpdateRecords(
                TabDataBulkUpdateRequest(
                    updates = listOf(
                        TabDataBulkUpdateItem(
                            recordId = recordId,
                            data = dirtyFields,
                            baseSnapshot = baseSnapshot,
                        ),
                    ),
                    operationGroupId = UUID.randomUUID().toString(),
                ),
            )
        } catch (error: HttpException) {
            if (error.code() == 409) throw AppError.VersionConflict
            if (error.code() == 503) throw AppError.RequestFailed(errorCode = SAVE_BUSY_CODE)
            throw error.toResourceVisibilityError() ?: error
        }
        if (!envelope.success || envelope.data == null) {
            if (envelope.code == VERSION_CONFLICT_CODE || envelope.errorCode == VERSION_CONFLICT_CODE) {
                throw AppError.VersionConflict
            }
            if (envelope.code == SAVE_BUSY_CODE || envelope.errorCode == SAVE_BUSY_CODE) {
                throw AppError.RequestFailed(errorCode = SAVE_BUSY_CODE)
            }
            throw AppError.RequestFailed(envelope.message, envelope.errorCode ?: envelope.code)
        }
        val payload = envelope.data
        if (payload.errors.isNotEmpty()) {
            val first = payload.errors.first()
            val detail = (first as? JsonPrimitive)?.contentOrNull ?: first.toString()
            throw AppError.RequestFailed(detail.ifBlank { envelope.message }, envelope.errorCode ?: envelope.code)
        }
        val record = payload.records.firstOrNull { it.id == recordId }
            ?: throw AppError.RequestFailed(envelope.message, envelope.errorCode ?: envelope.code)
        return TabDataUpdateOutcome(
            record = record,
            conflicts = payload.conflicts.filter { it.recordId == recordId },
        )
    }

    public suspend fun deleteRecord(recordId: String, expectedVersion: Long? = null) {
        val envelope = try {
            api.deleteRecord(recordId, expectedVersion)
        } catch (error: HttpException) {
            if (error.code() == 409) throw AppError.VersionConflict
            throw error.toResourceVisibilityError() ?: error
        }
        if (!envelope.success) {
            if (envelope.code == VERSION_CONFLICT_CODE || envelope.errorCode == VERSION_CONFLICT_CODE) {
                throw AppError.VersionConflict
            }
            throw AppError.RequestFailed(envelope.message, envelope.errorCode ?: envelope.code)
        }
    }

    public companion object {
        public const val DEFAULT_PAGE_SIZE: Int = 50
        public const val DEFAULT_GROUP_LIMIT: Int = 20
        private const val VERSION_CONFLICT_CODE: String = "VERSION_CONFLICT"
        internal const val SAVE_BUSY_CODE: String = "SAVE_BUSY"
    }
}

private fun HttpException.toResourceVisibilityError(): AppError.RequestFailed? = when (code()) {
    403 -> AppError.RequestFailed("你没有操作这项资源的权限", "PERMISSION_DENIED")
    404 -> AppError.RequestFailed("这项资源不存在或已不可见", "NOT_FOUND")
    else -> null
}

internal fun mobileFilterLogic(
    view: TabDataView,
    mobileFilters: List<TabDataFilterRule>,
    requestedLogic: String,
): String? = when {
    mobileFilters.isNotEmpty() -> requestedLogic
    view.validFilterSet != null -> null
    view.filters.isNotEmpty() -> view.configuredFilterLogic
    else -> null
}

/** GET filters 只接受数组；新版 FilterSet 留给服务端按视图配置回退，绝不能塞进 filters query。 */
internal fun TabDataView.legacyFilterQuery(): JsonArray? =
    if (validFilterSet != null) null else filters.takeIf { it.isNotEmpty() }?.let(::JsonArray)
