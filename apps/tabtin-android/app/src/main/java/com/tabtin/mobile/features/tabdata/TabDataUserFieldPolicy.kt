package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * 人员字段的可编辑形态与写回契约。
 *
 * 多选看后端顶层 `isMultipleCellValue` 或 `options.multiple`，任一为真即多选。
 * 写回与桌面 GridUserEditor / 记录表单一致：单选是标量用户 ID，多选是 ID 数组；
 * 两者清空都写 null——Web 正典对空多选也写 null，写 `[]` 会让同一张表出现两种空值形态。
 */
public data class TabDataMemberSearchQuery(
    val offset: Int,
    val limit: Int,
    val search: String? = null,
    val searchMode: String? = null,
)

public data class TabDataMemberSearchPage(
    val members: List<TabDataDirectoryMember> = emptyList(),
    val total: Int = 0,
)

public object TabDataUserFieldPolicy {
    /** 与 iOS `NativeTabDataMemberPickerPolicy.pageLimit` 对齐的每页条数。 */
    public const val SEARCH_PAGE_LIMIT: Int = 50

    /** 与 iOS `maxLimit` / 服务端 members 接口一致的硬顶，不能拿来当页大小。 */
    public const val SEARCH_MAX_LIMIT: Int = 200

    public const val SEARCH_MODE_NICKNAME: String = "nickname"

    public fun isEditableUserField(field: TabDataField): Boolean =
        field.normalizedType == "user"

    public fun isMultiple(field: TabDataField): Boolean =
        isEditableUserField(field) && (
            field.isMultipleCellValue ||
                booleanFlag(field.options, "multiple") ||
                booleanFlag(field.options, "isMultiple")
        )

    public fun selectedIds(value: JsonElement?): List<String> =
        TabDataMemberDirectory.collectUserIds(value)

    public fun encode(ids: Collection<String>, multiple: Boolean): JsonElement {
        val normalized = ids.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        if (normalized.isEmpty()) return JsonNull
        return if (multiple) {
            JsonArray(normalized.map(::JsonPrimitive))
        } else {
            JsonPrimitive(normalized.first())
        }
    }

    public fun toggle(current: JsonElement?, userId: String, multiple: Boolean): JsonElement {
        val id = userId.trim()
        if (id.isEmpty()) return encode(selectedIds(current), multiple)
        val selected = selectedIds(current)
        if (multiple) {
            return encode(
                if (id in selected) selected.filter { it != id } else selected + id,
                multiple = true,
            )
        }
        return if (selected.singleOrNull() == id) JsonNull else encode(listOf(id), multiple = false)
    }

    public fun remove(current: JsonElement?, userId: String, multiple: Boolean): JsonElement {
        val id = userId.trim()
        return encode(selectedIds(current).filter { it != id }, multiple)
    }

    /**
     * 与 iOS `searchQuery` 对齐：空搜索不带 search / search_mode，
     * offset 不能为负，limit 夹在 1..[SEARCH_MAX_LIMIT]。
     */
    public fun searchQuery(
        search: String,
        offset: Int = 0,
        limit: Int = SEARCH_PAGE_LIMIT,
    ): TabDataMemberSearchQuery {
        val trimmed = search.trim()
        return TabDataMemberSearchQuery(
            offset = offset.coerceAtLeast(0),
            limit = limit.coerceIn(1, SEARCH_MAX_LIMIT),
            search = trimmed.takeIf(String::isNotEmpty),
            searchMode = SEARCH_MODE_NICKNAME.takeIf { trimmed.isNotEmpty() },
        )
    }

    public fun searchOffset(reset: Boolean, loadedCount: Int): Int =
        if (reset) 0 else loadedCount.coerceAtLeast(0)

    public fun canLoadMore(loadedCount: Int, total: Int): Boolean =
        loadedCount > 0 && loadedCount < total

    public fun nextSearchGeneration(current: Int): Int = current + 1

    public fun shouldApplySearchResponse(requestGeneration: Int, currentGeneration: Int): Boolean =
        requestGeneration == currentGeneration

    public fun mergeSearchPage(
        current: List<TabDataDirectoryMember>,
        incoming: List<TabDataDirectoryMember>,
        reset: Boolean,
    ): List<TabDataDirectoryMember> {
        if (reset) return incoming
        val seen = current.mapTo(linkedSetOf()) { it.userId }
        return current + incoming.filter { member ->
            val userId = member.userId
            userId.isNotEmpty() && seen.add(userId)
        }
    }

    private fun booleanFlag(options: JsonObject, key: String): Boolean {
        val value = options[key] as? JsonPrimitive ?: return false
        return value.booleanOrNull == true || value.contentOrNull.equals("true", ignoreCase = true)
    }
}
