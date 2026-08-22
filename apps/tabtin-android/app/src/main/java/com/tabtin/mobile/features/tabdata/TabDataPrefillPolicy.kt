package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFieldType
import com.tabtin.mobile.data.model.tabdata.TabDataRecordGroup
import com.tabtin.mobile.data.model.tabdata.TabDataView
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * 新建记录时按当前视图预填字段。与 Web `resolveMobilePrefillValues` 逐条对齐：
 *
 * - `config.filter_logic === 'or'` 时整段 filters 跳过（不读嵌套 FilterSet 的 conjunction）
 * - 只读顶层扁平 `filters` / `groups`，不读 `config.filters`、`filter_groups`、顶层 `filter`
 * - `enabled === false` 跳过；缺省视为启用
 * - 字段先按 id 再按 name；算子 trim + 小写
 * - 同一字段被赋了不同值 → 清空**整段** filters 结果
 * - 结果 key 是字段名；空结果返回 null
 *
 * 可写性跟 Web 的 `isWritableField`（创建期类型），不是移动端详情页能不能编辑。
 * 附件 / 关联记录在移动端只读展示，预填值仍要进提交内容。
 */
public object TabDataPrefillPolicy {
    private val nonWritableCreateFieldTypes: Set<String> = setOf(
        "created_time",
        "last_modified_time",
        "created_by",
        "last_modified_by",
    )
    private val scalarPrefillOperators: Set<String> = setOf("equals", "is", "is_exactly")
    private val arrayPrefillOperators: Set<String> = setOf("in", "is_any_of")

    public fun resolve(
        currentView: TabDataView?,
        fields: List<TabDataField>,
        groupValues: JsonObject? = null,
    ): JsonObject? {
        val fieldById = fields.associateBy(TabDataField::id)
        val fieldByName = fields.associateBy(TabDataField::name)
        val result = linkedMapOf<String, JsonElement>()
        val filterLogic = (currentView?.config?.get("filter_logic") as? JsonPrimitive)?.contentOrNull
        if (filterLogic != "or") {
            var hasConflictingFilter = false
            for (filter in currentView?.filters.orEmpty()) {
                if (isDisabled(filter)) continue
                val fieldKey = (filter["field_id"] as? JsonPrimitive)?.contentOrNull ?: continue
                val field = fieldById[fieldKey] ?: fieldByName[fieldKey]
                val value = readFilterPrefill(filter, field)
                if (field == null || value == null) continue
                val existing = result[field.name]
                if (existing != null && existing != value) {
                    hasConflictingFilter = true
                    break
                }
                result[field.name] = value
            }
            if (hasConflictingFilter) result.clear()
        }

        for (group in currentView?.groups.orEmpty()) {
            val fieldKey = (group["field_id"] as? JsonPrimitive)?.contentOrNull ?: continue
            val field = fieldById[fieldKey] ?: fieldByName[fieldKey] ?: continue
            if (!isWritableField(field)) continue
            val value = groupValues?.get(field.name)
            if (!shouldSkipGroupValue(value)) result[field.name] = requireNotNull(value)
        }
        return if (result.isEmpty()) null else JsonObject(result)
    }

    /**
     * 看板分组下新建：把这一列的 `groupValue` 写成 `{字段名: 值}`，供 [resolve] 的 groups 分支使用。
     * 移动端看板只展开第一层分组。
     */
    public fun groupValuesFrom(
        view: TabDataView?,
        fields: List<TabDataField>,
        group: TabDataRecordGroup,
    ): JsonObject? {
        val grouping = view?.groups.orEmpty()
        if (grouping.isEmpty()) return null
        val fieldKey = (grouping.first()["field_id"] as? JsonPrimitive)?.contentOrNull ?: return null
        val field = fields.firstOrNull { it.id == fieldKey }
            ?: fields.firstOrNull { it.name == fieldKey }
            ?: return null
        if (shouldSkipGroupValue(group.groupValue)) return null
        return JsonObject(mapOf(field.name to group.groupValue))
    }

    private fun isWritableField(field: TabDataField?): Boolean {
        if (field == null) return false
        val type = field.fieldType
        val normalized = TabDataFieldType.normalize(type)
        return type !in nonWritableCreateFieldTypes && normalized !in nonWritableCreateFieldTypes
    }

    private fun readFilterPrefill(filter: JsonObject, field: TabDataField?): JsonElement? {
        if (!isWritableField(field)) return null
        val operator = (filter["operator"] as? JsonPrimitive)?.contentOrNull?.trim()?.lowercase()
            ?: return null
        val raw = filter["value"]
        if (raw == null || raw is JsonNull) return null
        if (operator in scalarPrefillOperators) return raw
        if (operator in arrayPrefillOperators && raw is JsonArray && raw.size == 1) return raw.first()
        return null
    }

    private fun isDisabled(filter: JsonObject): Boolean {
        val enabled = filter["enabled"] as? JsonPrimitive ?: return false
        return enabled.booleanOrNull == false
    }

    private fun shouldSkipGroupValue(value: JsonElement?): Boolean = when (value) {
        null, JsonNull -> true
        is JsonPrimitive -> value.isString && value.content.isEmpty()
        else -> false
    }
}
