package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFieldType
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * 人员字段目录解析。优先级与 Web 正典同序：
 * currentMember → identitySnapshot → embeddedName → unknown。
 *
 * 目录认得的人跟随目录现名（内嵌姓名往往是导入旧快照，不能盖掉）。
 * 离组 / 脏数据文案与 Web 有意不同：保留快照姓名并加「（已离职）」，
 * 查不到时显示「未知」，绝不回落成用户 ID。
 */
public enum class TabDataMemberKind {
    MEMBER,
    DEPARTED,
    EXTERNAL,
    UNKNOWN,
    ;

    public val wireValue: String
        get() = name.lowercase()
}

public data class TabDataMemberRef(
    public val userId: String,
    public val displayName: String,
    public val avatarUrl: String?,
    public val kind: TabDataMemberKind,
)

public data class TabDataDirectoryMember(
    public val userId: String,
    public val displayName: String,
    public val avatarUrl: String? = null,
)

public data class TabDataIdentitySnapshot(
    public val userId: String,
    public val displayName: String,
    public val leftAt: String? = null,
)

public data class TabDataMemberLabels(
    public val departedSuffix: String = DEFAULT_DEPARTED_SUFFIX,
    public val unknown: String = DEFAULT_UNKNOWN,
    /** 在职但昵称、用户名都为空的成员。丢弃会让这个人在选择器里选不到，回落成 userId 又会露裸 ID。 */
    public val unnamed: String = DEFAULT_UNNAMED,
) {
    public fun departed(name: String): String = "$name$departedSuffix"

    public companion object {
        public const val DEFAULT_DEPARTED_SUFFIX: String = "（已离职）"
        public const val DEFAULT_UNKNOWN: String = "未知"
        public const val DEFAULT_UNNAMED: String = "未命名成员"
        public val Chinese: TabDataMemberLabels = TabDataMemberLabels()
    }
}

public data class TabDataMemberDirectory(
    public val members: List<TabDataDirectoryMember> = emptyList(),
    public val identitySnapshots: List<TabDataIdentitySnapshot> = emptyList(),
) {
    private val membersById: Map<String, TabDataDirectoryMember> =
        members.associateBy(TabDataDirectoryMember::userId)
    private val snapshotsById: Map<String, TabDataIdentitySnapshot> =
        identitySnapshots.associateBy(TabDataIdentitySnapshot::userId)

    public fun knows(userId: String): Boolean {
        val id = userId.trim()
        return id.isNotEmpty() && (id in membersById || id in snapshotsById)
    }

    /**
     * 把人员字段的原始 JSON 解析成按原序排列的展示引用。
     * 空值（null / 空串 / 空数组）返回空列表，由调用方走空值占位，不显示「未知」。
     */
    public fun resolve(
        value: JsonElement?,
        labels: TabDataMemberLabels = TabDataMemberLabels.Chinese,
    ): List<TabDataMemberRef> = parseUserEntries(value).map { entry -> resolveEntry(entry, labels) }

    private fun resolveEntry(
        entry: ParsedUserEntry,
        labels: TabDataMemberLabels,
    ): TabDataMemberRef {
        val member = membersById[entry.userId]
        if (member != null) {
            return TabDataMemberRef(
                userId = entry.userId,
                displayName = member.displayName.trim().takeIf(String::isNotEmpty) ?: labels.unnamed,
                avatarUrl = member.avatarUrl?.trim()?.takeIf(String::isNotEmpty),
                kind = TabDataMemberKind.MEMBER,
            )
        }
        val snapshot = snapshotsById[entry.userId]
        if (snapshot != null) {
            return TabDataMemberRef(
                userId = entry.userId,
                displayName = labels.departed(snapshot.displayName),
                avatarUrl = null,
                kind = TabDataMemberKind.DEPARTED,
            )
        }
        val embeddedName = entry.embeddedName?.trim()?.takeIf(String::isNotEmpty)
        if (embeddedName != null) {
            return TabDataMemberRef(
                userId = entry.userId,
                displayName = embeddedName,
                avatarUrl = null,
                kind = TabDataMemberKind.EXTERNAL,
            )
        }
        return TabDataMemberRef(
            userId = entry.userId,
            displayName = labels.unknown,
            avatarUrl = null,
            kind = TabDataMemberKind.UNKNOWN,
        )
    }

    public companion object {
        public const val BATCH_PROFILE_LIMIT: Int = 200

        public val Empty: TabDataMemberDirectory = TabDataMemberDirectory()

        public fun isUserField(field: TabDataField): Boolean =
            field.normalizedType in USER_FIELD_TYPES

        public fun isUserFieldType(fieldType: String): Boolean =
            TabDataFieldType.normalize(fieldType) in USER_FIELD_TYPES

        public fun collectUserIds(value: JsonElement?): List<String> =
            parseUserEntries(value).map(ParsedUserEntry::userId).filter(String::isNotEmpty)

        public fun collectUserIds(
            records: List<TabDataRecord>,
            fields: List<TabDataField>,
        ): List<String> {
            val userFields = fields.filter(::isUserField)
            return records.flatMap { record ->
                userFields.flatMap { field ->
                    collectUserIds(record.namedFields[field.name] ?: record.namedFields[field.id])
                }
            }
        }

        /** 去重后按 [batchSize] 切批，供 batch-profiles 使用（后端上限 200）。 */
        public fun chunkUserIds(
            userIds: Collection<String>,
            batchSize: Int = BATCH_PROFILE_LIMIT,
        ): List<List<String>> {
            val normalized = userIds
                .map { it.trim() }
                .filter(String::isNotEmpty)
                .distinct()
            if (normalized.isEmpty() || batchSize <= 0) return emptyList()
            return normalized.chunked(batchSize)
        }
    }
}

private val USER_FIELD_TYPES: Set<String> = setOf("user", "created_by", "last_modified_by")

private data class ParsedUserEntry(
    val userId: String,
    val embeddedName: String?,
)

private fun parseUserEntries(value: JsonElement?): List<ParsedUserEntry> = when (value) {
    null, JsonNull -> emptyList()
    is JsonArray -> value.flatMap(::parseUserEntries)
    is JsonPrimitive -> {
        val text = value.contentOrNull?.trim().orEmpty().ifEmpty { value.content.trim() }
        if (text.isEmpty()) emptyList() else listOf(ParsedUserEntry(userId = text, embeddedName = null))
    }
    is JsonObject -> {
        val userId = sequenceOf("id", "user_id", "userId")
            .mapNotNull { key ->
                (value[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
            }
            .firstOrNull()
            .orEmpty()
        val embeddedName = sequenceOf("name", "display_name", "displayName")
            .mapNotNull { key ->
                (value[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
            }
            .firstOrNull()
        if (userId.isEmpty() && embeddedName == null) emptyList()
        else listOf(ParsedUserEntry(userId = userId, embeddedName = embeddedName))
    }
}
