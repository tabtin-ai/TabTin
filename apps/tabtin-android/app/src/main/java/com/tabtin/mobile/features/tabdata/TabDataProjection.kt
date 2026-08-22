package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataCreateFieldRequest
import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFieldType
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataView
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

public enum class TabDataFieldEditMode {
    NATIVE,
    FULL_MODE_ONLY,
}

public enum class TabDataCreateFieldType(
    public val wireValue: String,
    public val requiresChoices: Boolean = false,
) {
    TEXT("text"),
    LONG_TEXT("long_text"),
    NUMBER("number"),
    SELECT("select", requiresChoices = true),
    MULTI_SELECT("multi_select", requiresChoices = true),
    CHECKBOX("checkbox"),
}

public enum class TabDataCreateFieldValidationError {
    EMPTY_NAME,
    NAME_TOO_LONG,
    DUPLICATE_NAME,
    MISSING_CHOICES,
}

public object TabDataFieldCreationPolicy {
    public fun request(
        tableId: String,
        name: String,
        fieldType: TabDataCreateFieldType,
        choices: List<String> = emptyList(),
    ): TabDataCreateFieldRequest {
        val normalizedChoices = choices.map(String::trim).filter(String::isNotEmpty).distinct()
        return TabDataCreateFieldRequest(
            tableId = tableId,
            name = name.trim(),
            fieldType = fieldType.wireValue,
            options = if (fieldType.requiresChoices) {
                JsonObject(mapOf("choices" to JsonArray(normalizedChoices.map(::JsonPrimitive))))
            } else {
                JsonObject(emptyMap())
            },
        )
    }

    public fun validationError(
        request: TabDataCreateFieldRequest,
        existingFields: List<TabDataField>,
        fieldType: TabDataCreateFieldType,
    ): TabDataCreateFieldValidationError? = when {
        request.name.isEmpty() -> TabDataCreateFieldValidationError.EMPTY_NAME
        request.name.length > 100 -> TabDataCreateFieldValidationError.NAME_TOO_LONG
        existingFields.any { it.name.equals(request.name, ignoreCase = true) } ->
            TabDataCreateFieldValidationError.DUPLICATE_NAME
        fieldType.requiresChoices && (request.options["choices"] as? JsonArray).isNullOrEmpty() ->
            TabDataCreateFieldValidationError.MISSING_CHOICES
        else -> null
    }
}

public object TabDataFieldPolicy {
    private val nativeTypes: Set<String> = setOf(
        "text", "long_text", "number", "currency", "percent", "rating",
        "select", "multi_select", "checkbox", "date",
        "url", "email", "phone", "user",
    )

    public fun normalizeFieldType(raw: String?): String = TabDataFieldType.normalize(raw)

    public fun editMode(fieldType: String): TabDataFieldEditMode =
        if (normalizeFieldType(fieldType) in nativeTypes) TabDataFieldEditMode.NATIVE
        else TabDataFieldEditMode.FULL_MODE_ONLY
}

public data class TabDataCardSummaryRow(
    public val name: String,
    public val text: String,
    public val members: List<TabDataMemberRef> = emptyList(),
)

public data class TabDataCardProjection(
    public val record: TabDataRecord,
    public val title: String,
    public val coverUrl: String?,
    public val summary: List<Pair<String, String>>,
    public val summaryRows: List<TabDataCardSummaryRow> = emptyList(),
)

public object TabDataProjection {
    /** 能承载封面图的字段类型；按归一化后的类型判断，`image` / `file` 等别名同样成立。 */
    private val coverFieldTypes = setOf("attachment")

    private fun canBeCover(field: TabDataField): Boolean =
        TabDataFieldType.normalize(field.fieldType) in coverFieldTypes

    public fun card(
        record: TabDataRecord,
        view: TabDataView,
        fields: List<TabDataField>,
        untitledTitle: String,
        summaryLimit: Int = 4,
        directory: TabDataMemberDirectory = TabDataMemberDirectory.Empty,
        labels: TabDataMemberLabels = TabDataMemberLabels.Chinese,
    ): TabDataCardProjection {
        val byId = fields.associateBy { it.id }
        val byName = fields.associateBy { it.name }
        val visibleFields = orderedVisibleFields(view, fields)
        val configuredTitle = view.config.fieldReference("card_title_field", "title_field")
        val titleField = configuredTitle?.let { byId[it] ?: byName[it] }
            ?: visibleFields.firstOrNull { it.isPrimary }
            ?: visibleFields.firstOrNull()
        val titleValue = titleField?.let { cardText(it, record.valueFor(it), directory, labels) }.orEmpty()
        val title = when {
            titleValue.isNotBlank() -> titleValue
            else -> untitledTitle
        }

        // 配置的封面字段仍要过类型闸门。Web 会把任意配置字段的字符串值直接当图片地址取用，
        // 于是一处 url 字段配置就能让卡片去拉任意外链；这里只认真正的附件与媒体。
        val coverRef = view.config.fieldReference("card_cover_field", "cover_field")
        val coverField = (coverRef?.let { byId[it] ?: byName[it] } ?: visibleFields.firstOrNull(::canBeCover))
            ?.takeIf(::canBeCover)
        val coverUrl = coverField?.let { record.valueFor(it).firstMediaUrl() }

        // 只排除标题与封面：分组字段照常进摘要，与 mobileTableProjection.ts:84 一致。
        val excluded = buildSet {
            titleField?.let { add(it.id); add(it.name) }
            coverField?.let { add(it.id); add(it.name) }
        }
        val summaryRows = visibleFields.asSequence()
            .filterNot { it.id in excluded || it.name in excluded }
            .mapNotNull { field ->
                val value = record.valueFor(field)
                val text = cardText(field, value, directory, labels).takeIf { it.isNotBlank() } ?: return@mapNotNull null
                val members = if (TabDataMemberDirectory.isUserField(field)) {
                    directory.resolve(value, labels)
                } else {
                    emptyList()
                }
                TabDataCardSummaryRow(field.name, text, members)
            }
            .take(summaryLimit.coerceIn(1, 4))
            .toList()

        return TabDataCardProjection(
            record = record,
            title = title,
            coverUrl = coverUrl,
            summary = summaryRows.map { it.name to it.text },
            summaryRows = summaryRows,
        )
    }

    /**
     * 卡片标题与摘要的显示值。date / percent / currency / rating 按字段类型分派，其余走通用
     * [displayText]。与 Web 正典 mobileTablePrimitives.ts:114 的 formatMobileCardValue 同档。
     *
     * created_time / last_modified_time 在 Web 卡片上同样走原样输出，这里不擅自领先一步。
     */
    private fun cardText(
        field: TabDataField,
        value: JsonElement?,
        directory: TabDataMemberDirectory,
        labels: TabDataMemberLabels,
    ): String {
        if (TabDataMemberDirectory.isUserField(field)) {
            return directory.resolve(value, labels).joinToString("、") { it.displayName }
        }
        val primitive = value as? JsonPrimitive
        val raw = primitive?.contentOrNull ?: primitive?.content
        return when (TabDataFieldType.normalize(field.fieldType)) {
            "date" -> TabDataDateCodec.decodeDate(raw)?.let(TabDataDateCodec::displayDate)
            "percent" -> TabDataNumberFormat.formatPercent(raw)
            "currency" -> TabDataNumberFormat.formatCurrency(
                raw,
                symbol = TabDataNumberFormat.currencySymbol(field.options),
                precision = TabDataNumberFormat.currencyPrecision(field.options),
            )
            "rating" -> TabDataNumberFormat.formatRatingStars(
                raw,
                max = TabDataNumberFormat.ratingMax(field.options),
            )
            else -> null
        } ?: value.displayText()
    }

    public fun orderedVisibleFields(view: TabDataView, fields: List<TabDataField>): List<TabDataField> {
        val available = fields.filterNot { it.isHidden }
        val byId = available.associateBy { it.id }
        val byName = available.associateBy { it.name }

        // 顺序只认 field_order / column_meta.order，可见性只认 visible_fields / column_meta。
        // 拿 visible_fields 当顺序会让在 Web 拖过列顺序的视图在移动端摘要里字段乱序，
        // 与 mobileTablePrimitives.ts:139 的 resolveFieldOrder 分家。
        val configuredOrder = when {
            view.fieldOrder.isNotEmpty() -> view.fieldOrder
            view.columnMeta.isNotEmpty() -> view.columnMeta.entries
                .sortedBy { (_, meta) -> (meta as? JsonObject)?.int("order") ?: Int.MAX_VALUE }
                .map { it.key }
            else -> emptyList()
        }
        val ordered = if (configuredOrder.isEmpty()) {
            available.sortedBy { it.order }
        } else {
            val ranked = configuredOrder.mapNotNull { byId[it] ?: byName[it] }.distinctBy { it.id }
            val rankedIds = ranked.mapTo(mutableSetOf()) { it.id }
            ranked + available.filterNot { it.id in rankedIds }
        }

        if (view.visibleFields.isNotEmpty()) {
            return ordered.filter { it.id in view.visibleFields || it.name in view.visibleFields }
        }
        return ordered.filterNot { field ->
            val meta = (view.columnMeta[field.id] ?: view.columnMeta[field.name]) as? JsonObject
            meta?.boolean("hidden") == true || meta?.boolean("visible") == false
        }
    }

    public fun dirtyFields(
        original: Map<String, JsonElement>,
        draft: Map<String, JsonElement>,
    ): JsonObject = JsonObject(
        draft.filter { (key, value) -> original[key] != value },
    )
}

public fun JsonElement?.displayText(): String = when (this) {
    null, JsonNull -> ""
    is JsonPrimitive -> when {
        isString -> contentOrNull.orEmpty().takeUnless(::looksLikeInternalId).orEmpty()
        booleanOrNull != null -> if (booleanOrNull == true) "是" else "否"
        doubleOrNull != null -> content
        else -> contentOrNull.orEmpty().takeUnless(::looksLikeInternalId).orEmpty()
    }
    is JsonArray -> joinToString("、") { it.displayText() }.trim('、')
    is JsonObject -> {
        sequenceOf(
            "label",
            "name",
            "display_name",
            "displayName",
            "title",
            "text",
            "filename",
            "file_name",
            "value",
            "url",
        )
            .mapNotNull { key -> get(key)?.displayText()?.takeIf(String::isNotBlank) }
            .firstOrNull()
            ?: values.map { it.displayText() }.filter { it.isNotBlank() }.joinToString("、").trim('、')
    }
}

internal fun looksLikeInternalId(text: String): Boolean =
    Regex("^(usr|rec|tbl|viw)-[A-Za-z0-9_-]+$", RegexOption.IGNORE_CASE).matches(text.trim())

private fun TabDataRecord.valueFor(field: TabDataField): JsonElement? =
    namedFields[field.name] ?: namedFields[field.id]

private fun JsonObject.fieldReference(vararg keys: String): String? = keys.asSequence()
    .mapNotNull { key -> (get(key) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() } }
    .firstOrNull()

private fun JsonObject.boolean(key: String): Boolean? =
    (get(key) as? JsonPrimitive)?.booleanOrNull

private fun JsonObject.int(key: String): Int? =
    (get(key) as? JsonPrimitive)?.contentOrNull?.toIntOrNull()

private fun JsonElement?.firstMediaUrl(): String? = when (this) {
    is JsonPrimitive -> contentOrNull?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
    is JsonArray -> firstNotNullOfOrNull { it.firstMediaUrl() }
    is JsonObject -> sequenceOf("url", "download_url", "thumbnail_url", "src")
        .mapNotNull { key -> get(key).firstMediaUrl() }
        .firstOrNull()
    else -> null
}
