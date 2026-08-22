package com.tabtin.mobile.data.model.tabdata

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import com.tabtin.mobile.features.tabdata.TabDataSurfacePolicy
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@Serializable
public data class TabDataTable(
    public val id: String,
    public val name: String,
    public val description: String? = null,
    public val icon: String? = null,
    @SerialName("organization_id") public val organizationId: String? = null,
    @SerialName("space_id") public val spaceId: String? = null,
    @SerialName("default_view_id") public val defaultViewId: String? = null,
    @SerialName("row_count") public val rowCount: Int? = null,
    @SerialName("field_count") public val fieldCount: Int = 0,
    @SerialName("schema_version") public val schemaVersion: Int = 0,
    @SerialName("current_user_role") public val currentUserRole: String? = null,
    @SerialName("is_archived") public val isArchived: Boolean = false,
) {
    public val canWrite: Boolean
        get() = currentUserRole?.lowercase() in setOf("owner", "admin", "editor")
}

@Serializable
public data class TabDataViewsResponse(
    public val views: List<TabDataView> = emptyList(),
    public val total: Int = views.size,
)

@Serializable
public data class TabDataView(
    public val id: String,
    @SerialName("table_id") public val tableId: String = "",
    public val name: String,
    @SerialName("view_type") public val viewType: String = "grid",
    public val description: String? = null,
    /** 新版嵌套 FilterSet；与旧 [filters] 并存时必须优先。 */
    public val filter: JsonObject? = null,
    public val filters: List<JsonObject> = emptyList(),
    public val sorts: List<JsonObject> = emptyList(),
    public val groups: List<JsonObject> = emptyList(),
    @SerialName("visible_fields") public val visibleFields: List<String> = emptyList(),
    @SerialName("field_order") public val fieldOrder: List<String> = emptyList(),
    @SerialName("column_meta") public val columnMeta: JsonObject = JsonObject(emptyMap()),
    public val config: JsonObject = JsonObject(emptyMap()),
    @SerialName("is_locked") public val isLocked: Boolean = false,
    public val order: Int = 0,
) {
    /**
     * 网格 / 列表走原生卡片，看板走分组卡片；日历 / 画廊 / 表单 / 闪卡 / 透视等走摘要。
     */
    public val supportsNativeCards: Boolean
        get() = TabDataSurfacePolicy.supportsNativeCards(viewType)

    public val configuredFilterLogic: String
        get() = validFilterSet
            ?.get("conjunction")
            ?.let { it as? JsonPrimitive }
            ?.contentOrNull
            ?.lowercase()
            ?.takeIf { it in setOf("and", "or") }
            ?: (config["filter_logic"] as? JsonPrimitive)
            ?.contentOrNull
            ?.lowercase()
            ?.takeIf { it == "or" }
            ?: "and"

    /** 只有形状明确的 FilterSet 才会覆盖旧 filters；畸形新字段安全回退旧契约。 */
    public val validFilterSet: JsonObject?
        get() = filter?.takeIf { candidate ->
            val conjunction = (candidate["conjunction"] as? JsonPrimitive)
                ?.contentOrNull
                ?.lowercase()
            conjunction in setOf("and", "or") && candidate["filterSet"] is JsonArray
        }
}

@Serializable
public data class TabDataFieldsResponse(
    public val fields: List<TabDataField> = emptyList(),
    public val total: Int = fields.size,
    @SerialName("schema_version") public val schemaVersion: Int? = null,
)

@Serializable
public data class TabDataCreateFieldRequest(
    @SerialName("table_id") public val tableId: String,
    public val name: String,
    @SerialName("field_type") public val fieldType: String,
    public val options: JsonObject = JsonObject(emptyMap()),
)

@Serializable
public data class TabDataField(
    public val id: String,
    @SerialName("table_id") public val tableId: String,
    public val name: String,
    @SerialName("field_type") public val fieldType: String,
    public val description: String? = null,
    public val options: JsonObject = JsonObject(emptyMap()),
    @SerialName("is_primary") public val isPrimary: Boolean = false,
    public val order: Int = 0,
    @SerialName("is_hidden") public val isHidden: Boolean = false,
    /** 后端以 camelCase 输出（tabdata/schemas.py），旧响应可能缺省。 */
    @SerialName("isMultipleCellValue") public val isMultipleCellValue: Boolean = false,
) {
    public val choices: List<TabDataChoice>
        get() = parseChoices(options["choices"])

    public val normalizedType: String
        get() = TabDataFieldType.normalize(fieldType)
}

public data class TabDataChoice(
    public val value: String,
    public val label: String,
    public val color: String? = null,
)

/** 移动端临时查询条件；只覆盖当前页面，不会改写共享视图配置。 */
public data class TabDataFilterRule(
    public val fieldId: String,
    public val fieldName: String,
    public val operator: String,
    public val value: JsonElement = JsonNull,
)

/** 移动端临时排序；服务端按视图查询契约执行。 */
public data class TabDataSortRule(
    public val fieldId: String,
    public val fieldName: String,
    public val descending: Boolean = false,
)

@Serializable
public data class TabDataRecord(
    public val id: String,
    @SerialName("row_id") public val rowId: String? = null,
    @SerialName("table_id") public val tableId: String? = null,
    public val data: JsonObject = JsonObject(emptyMap()),
    public val fields: JsonObject = JsonObject(emptyMap()),
    public val order: Double? = null,
    public val version: Long? = null,
    @SerialName("created_at") public val createdAt: String? = null,
    @SerialName("updated_at") public val updatedAt: String? = null,
) {
    /** 请求统一使用 name key；新协议优先，旧 data 保持解码兼容。 */
    public val namedFields: JsonObject
        get() = if (fields.isNotEmpty()) fields else data
}

@Serializable
public data class TabDataViewRecordsResponse(
    public val view: TabDataView? = null,
    public val records: List<TabDataRecord> = emptyList(),
    public val total: Int = 0,
    @SerialName("matched_total") public val matchedTotal: Int = total,
    public val page: Int = 1,
    @SerialName("page_size") public val pageSize: Int = 50,
    public val metadata: TabDataViewMetadata = TabDataViewMetadata(),
    @SerialName("latest_version") public val latestVersion: Long = 0,
)

@Serializable
public data class TabDataViewMetadata(
    @SerialName("view_type") public val viewType: String? = null,
    @Serializable(with = TabDataRecordGroupsSerializer::class)
    public val groups: List<TabDataRecordGroup> = emptyList(),
    @SerialName("needs_configuration") public val needsConfiguration: Boolean = false,
)

@Serializable
public data class TabDataRecordGroup(
    @SerialName("group_value") public val groupValue: JsonElement = JsonNull,
    @SerialName("group_label") public val groupLabel: String = "未分组",
    public val color: String? = null,
    public val records: List<TabDataRecord> = emptyList(),
    public val count: Int = records.size,
    public val offset: Int = 0,
    @SerialName("per_group_limit") public val perGroupLimit: Int = 50,
    @SerialName("has_more") public val hasMore: Boolean = false,
) {
    public val offsetKey: String
        get() = groupValue.jsonPrimitive.contentOrNull?.takeIf { it.isNotBlank() } ?: "__ungrouped__"
}

internal object TabDataRecordGroupsSerializer : KSerializer<List<TabDataRecordGroup>> {
    private val delegate = ListSerializer(TabDataRecordGroup.serializer())

    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun deserialize(decoder: Decoder): List<TabDataRecordGroup> {
        val jsonDecoder = decoder as? JsonDecoder ?: return delegate.deserialize(decoder)
        return when (val element = jsonDecoder.decodeJsonElement()) {
            is JsonArray -> jsonDecoder.json.decodeFromJsonElement(delegate, element)
            is JsonObject, JsonNull -> emptyList()
            else -> throw SerializationException("metadata.groups must be an array, object, or null")
        }
    }

    override fun serialize(encoder: Encoder, value: List<TabDataRecordGroup>) {
        val jsonEncoder = encoder as? JsonEncoder
        if (jsonEncoder == null) {
            delegate.serialize(encoder, value)
            return
        }
        jsonEncoder.encodeJsonElement(jsonEncoder.json.encodeToJsonElement(delegate, value))
    }
}

@Serializable
public data class TabDataCreateRecordRequest(
    @SerialName("table_id") public val tableId: String,
    public val fields: JsonObject,
    @SerialName("field_key_type") public val fieldKeyType: String = "name",
)

@Serializable
public data class TabDataUpdateRecordRequest(
    public val fields: JsonObject,
    @SerialName("field_key_type") public val fieldKeyType: String = "name",
    @SerialName("expected_version") public val expectedVersion: Long? = null,
)

@Serializable
public data class TabDataBulkUpdateRequest(
    public val updates: List<TabDataBulkUpdateItem>,
    @SerialName("operation_group_id") public val operationGroupId: String,
)

@Serializable
public data class TabDataBulkUpdateItem(
    @SerialName("record_id") public val recordId: String,
    public val data: JsonObject,
    @SerialName("base_snapshot") public val baseSnapshot: JsonObject,
)

@Serializable
public data class TabDataBulkUpdateResponse(
    @SerialName("success_count") public val successCount: Int = 0,
    public val records: List<TabDataRecord> = emptyList(),
    public val errors: List<JsonElement> = emptyList(),
    public val conflicts: List<TabDataFieldConflict> = emptyList(),
)

@Serializable
public data class TabDataFieldConflict(
    @SerialName("record_id") public val recordId: String,
    @SerialName("field_id") public val fieldId: String,
    @SerialName("your_value") public val yourValue: JsonElement = JsonNull,
    @SerialName("server_value") public val serverValue: JsonElement = JsonNull,
)

public data class TabDataUpdateOutcome(
    public val record: TabDataRecord,
    public val conflicts: List<TabDataFieldConflict> = emptyList(),
)

private fun parseChoices(raw: JsonElement?): List<TabDataChoice> = when (raw) {
    is JsonArray -> raw.mapNotNull { element ->
        when (element) {
            is JsonPrimitive -> element.contentOrNull?.let { TabDataChoice(value = it, label = it) }
            is JsonObject -> {
                val value = element.string("value")
                    ?: element.string("id")
                    ?: element.string("name")
                    ?: element.string("label")
                    ?: return@mapNotNull null
                TabDataChoice(
                    value = value,
                    label = element.string("label") ?: element.string("name") ?: value,
                    color = element.string("color"),
                )
            }
            else -> null
        }
    }
    else -> emptyList()
}

private fun JsonObject.string(key: String): String? =
    (get(key) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
