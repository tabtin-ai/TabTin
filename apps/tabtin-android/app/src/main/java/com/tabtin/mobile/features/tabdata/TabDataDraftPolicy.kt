package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFieldType
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.repository.TabDataDraftSchema
import com.tabtin.mobile.data.repository.TabDataDraftSnapshot
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

public object TabDataDraftPolicy {
    public fun initialDraft(
        record: TabDataRecord?,
        fields: List<TabDataField>,
    ): Map<String, JsonElement> = fields.associate { field ->
        field.name to (record?.namedFields?.get(field.name)
            ?: record?.namedFields?.get(field.id)
            ?: JsonNull)
    }

    public fun normalize(field: TabDataField, raw: String): JsonElement {
        val value = raw.trim()
        if (value.isEmpty()) return JsonNull
        return when (TabDataFieldType.normalize(field.fieldType)) {
            "number", "currency", "percent" -> value.toDoubleOrNull()?.let(::JsonPrimitive) ?: JsonPrimitive(raw)
            "rating" -> value.toIntOrNull()?.let(::JsonPrimitive) ?: JsonPrimitive(raw)
            "checkbox" -> JsonPrimitive(value.equals("true", true) || value == "1")
            "multi_select" -> JsonArray(
                value.split(',').map(String::trim).filter(String::isNotBlank).map(::JsonPrimitive),
            )
            else -> JsonPrimitive(raw)
        }
    }

    public fun validate(
        draft: Map<String, JsonElement>,
        fields: List<TabDataField>,
    ): Map<String, TabDataValidationError> = buildMap {
        fields.forEach { field ->
            val value = draft[field.name]
            if (value != null && value !is JsonNull) {
                when (TabDataFieldType.normalize(field.fieldType)) {
                    "number", "currency", "percent", "rating" -> {
                        val primitive = value as? JsonPrimitive
                        if (primitive?.doubleOrNull == null) {
                            put(field.name, TabDataValidationError.InvalidNumber)
                        }
                    }
                }
            }
        }
    }

    public fun dirtyFields(
        original: Map<String, JsonElement>,
        draft: Map<String, JsonElement>,
        fields: List<TabDataField>,
    ): JsonObject {
        val editableNames = fields
            .filter { TabDataFieldPolicy.editMode(it.fieldType) == TabDataFieldEditMode.NATIVE }
            .mapTo(mutableSetOf()) { it.name }
        return JsonObject(
            draft.filter { (key, value) -> key in editableNames && original[key] != value },
        )
    }

    /**
     * 只把“同一字段 ID 且同一类型”的脏值套回当前 schema。旧版无身份信息的草稿仍可展示和复制，
     * 但 [isWriteCompatible] 为 false，调用方必须锁住写入，避免同名新字段被误覆盖。
     */
    public fun restore(
        remote: Map<String, JsonElement>,
        snapshot: TabDataDraftSnapshot,
        fields: List<TabDataField>,
    ): RestoredTabDataDraft {
        val dirtyNames = (snapshot.original.keys + snapshot.draft.keys).filterTo(linkedSetOf()) { key ->
            snapshot.original[key] != snapshot.draft[key]
        }
        val identities = snapshot.fieldIdentities
        val currentById = fields.associateBy(TabDataField::id)
        val writeCompatible = snapshot.schemaFingerprint != null && identities != null &&
            dirtyNames.all { oldName ->
                val identity = identities[oldName] ?: return@all false
                val current = currentById[identity.fieldId] ?: return@all false
                TabDataFieldType.normalize(current.fieldType) ==
                    TabDataFieldType.normalize(identity.fieldType)
            }

        if (!writeCompatible) {
            return RestoredTabDataDraft(
                original = remote,
                draft = remote + snapshot.draft,
                isWriteCompatible = false,
                schemaMatchesExactly = false,
            )
        }

        val restoredDirty = dirtyNames.associate { oldName ->
            val identity = requireNotNull(identities?.get(oldName))
            val current = requireNotNull(currentById[identity.fieldId])
            current.name to (snapshot.draft[oldName] ?: JsonNull)
        }
        return RestoredTabDataDraft(
            original = remote,
            draft = remote + restoredDirty,
            isWriteCompatible = true,
            schemaMatchesExactly = snapshot.schemaFingerprint == TabDataDraftSchema.fingerprint(fields),
        )
    }
}

public data class RestoredTabDataDraft(
    val original: Map<String, JsonElement>,
    val draft: Map<String, JsonElement>,
    val isWriteCompatible: Boolean,
    val schemaMatchesExactly: Boolean,
)

public enum class TabDataValidationError {
    InvalidNumber,
}

public fun TabDataField.valueFrom(record: TabDataRecord): JsonElement? =
    record.namedFields[name] ?: record.namedFields[id]

public fun JsonElement?.asDraftText(): String = when (this) {
    null, JsonNull -> ""
    is JsonPrimitive -> when {
        booleanOrNull != null -> booleanOrNull.toString()
        else -> contentOrNull.orEmpty()
    }
    is JsonArray -> joinToString(", ") { it.asDraftText() }
    is JsonObject -> displayText()
}
