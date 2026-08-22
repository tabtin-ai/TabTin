package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFieldConflict
import com.tabtin.mobile.data.repository.TabDataDraftSnapshot
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * 把内部 name-key 草稿转成 bulk-update 所需的 field-id key。
 * 草稿存储格式仍按字段名，只在构造请求时转换。
 */
public object TabDataBulkUpdatePolicy {
    public const val CONFLICT_NAME_LIMIT: Int = 2

    public fun fieldIdPayload(
        dirtyByName: JsonObject,
        originalByName: Map<String, JsonElement>,
        fields: List<TabDataField>,
    ): TabDataFieldIdPayload {
        val fieldsByName = fields.associateBy(TabDataField::name)
        val data = linkedMapOf<String, JsonElement>()
        val snapshot = linkedMapOf<String, JsonElement>()
        dirtyByName.forEach { (name, value) ->
            val field = fieldsByName[name] ?: return@forEach
            data[field.id] = value
            snapshot[field.id] = originalByName[name] ?: JsonNull
        }
        return TabDataFieldIdPayload(
            data = JsonObject(data),
            baseSnapshot = JsonObject(snapshot),
        )
    }

    /**
     * 冲突检测要的是「用户开始编辑时」的远端值，不是打开详情时最新的远端值。
     * 草稿快照的 original 在字段改名后仍可能是旧 name，这里按 field id 映射回当前 name。
     */
    public fun editStartValues(
        snapshot: TabDataDraftSnapshot?,
        detailOriginal: Map<String, JsonElement>,
        fields: List<TabDataField>,
    ): Map<String, JsonElement> {
        if (snapshot == null) return detailOriginal
        val identities = snapshot.fieldIdentities
        return fields.associate { field ->
            val oldName = identities?.entries?.firstOrNull { it.value.fieldId == field.id }?.key
            field.name to (
                oldName?.let { snapshot.original[it] }
                    ?: snapshot.original[field.name]
                    ?: detailOriginal[field.name]
                    ?: JsonNull
            )
        }
    }

    public fun conflictFieldNames(
        conflicts: List<TabDataFieldConflict>,
        fields: List<TabDataField>,
        maxNames: Int = CONFLICT_NAME_LIMIT,
    ): TabDataConflictFieldNames {
        val names = conflicts.map { conflict ->
            fields.firstOrNull { it.id == conflict.fieldId }?.name ?: conflict.fieldId
        }.distinct()
        return TabDataConflictFieldNames(
            listed = names.take(maxNames.coerceAtLeast(1)),
            total = names.size,
        )
    }
}

public data class TabDataFieldIdPayload(
    public val data: JsonObject,
    public val baseSnapshot: JsonObject,
)

public data class TabDataConflictFieldNames(
    public val listed: List<String>,
    public val total: Int,
) {
    public val hasOverflow: Boolean
        get() = total > listed.size
}
