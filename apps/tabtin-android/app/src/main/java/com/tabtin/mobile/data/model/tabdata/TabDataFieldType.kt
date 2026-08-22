package com.tabtin.mobile.data.model.tabdata

/**
 * 与 `packages/table-kernel/src/types/field.ts` 的 `FIELD_TYPE_ALIASES` /
 * `normalizeFieldType()` 保持同一张表：trim + lowercase 后查别名，未命中则透传。
 */
public object TabDataFieldType {
    private val aliases: Map<String, String> = mapOf(
        "string" to "text",
        "textarea" to "long_text",
        "integer" to "number",
        "float" to "number",
        "bool" to "checkbox",
        "boolean" to "checkbox",
        "single_select" to "select",
        "multiple_select" to "multi_select",
        "multiselect" to "multi_select",
        "file" to "attachment",
        "image" to "attachment",
        "enum" to "select",
    )

    public fun normalize(raw: String?): String {
        if (raw.isNullOrEmpty()) return "text"
        val key = raw.trim().lowercase()
        return aliases[key] ?: key
    }
}
