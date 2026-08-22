package com.tabtin.mobile.data.model.memo

import androidx.annotation.StringRes
import androidx.compose.ui.graphics.Color
import com.tabtin.mobile.R
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// ─── 响应模型 ─────────────────────────────────────────────

@Serializable
public data class MemoSummary(
    val id: String,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("memo_type") val memoType: String = "note",
    val importance: Int? = null,
    @SerialName("content_plaintext") val contentPlaintext: String = "",
    val tags: List<String> = emptyList(),
    @SerialName("ai_tags") val aiTags: List<String> = emptyList(),
    val color: String = "",
    val source: String = "manual",
    val status: String = "active",
    @SerialName("is_pinned") val isPinned: Boolean = false,
    @SerialName("bookmark_url") val bookmarkUrl: String = "",
    @SerialName("bookmark_title") val bookmarkTitle: String = "",
    @SerialName("bookmark_image") val bookmarkImage: String = "",
    @SerialName("attachment_count") val attachmentCount: Int = 0,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
)

@Serializable
public data class MemoDetail(
    val id: String,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("memo_type") val memoType: String = "note",
    val importance: Int? = null,
    @SerialName("content_plaintext") val contentPlaintext: String = "",
    @SerialName("content_json") val contentJson: JsonObject = JsonObject(emptyMap()),
    @SerialName("content_markdown") val contentMarkdown: String = "",
    val tags: List<String> = emptyList(),
    @SerialName("ai_tags") val aiTags: List<String> = emptyList(),
    val color: String = "",
    val source: String = "manual",
    val status: String = "active",
    @SerialName("source_url") val sourceUrl: String = "",
    @SerialName("is_pinned") val isPinned: Boolean = false,
    @SerialName("bookmark_url") val bookmarkUrl: String = "",
    @SerialName("bookmark_title") val bookmarkTitle: String = "",
    @SerialName("bookmark_image") val bookmarkImage: String = "",
    @SerialName("bookmark_description") val bookmarkDescription: String = "",
    @SerialName("attachment_count") val attachmentCount: Int = 0,
    val attachments: List<AttachmentOut> = emptyList(),
    val collections: List<CollectionBriefOut> = emptyList(),
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
)

@Serializable
public data class MemoListResponse(
    val items: List<MemoSummary>,
    @SerialName("next_cursor") val nextCursor: String = "",
    @SerialName("has_more") val hasMore: Boolean = false,
)

@Serializable
public data class AttachmentOut(
    val id: String,
    @SerialName("file_type") val fileType: String = "",
    @SerialName("file_url") val fileUrl: String = "",
    @SerialName("file_name") val fileName: String = "",
    @SerialName("file_size") val fileSize: Int = 0,
    @SerialName("mime_type") val mimeType: String = "",
    @SerialName("thumbnail_url") val thumbnailUrl: String = "",
    @SerialName("sort_order") val sortOrder: Int = 0,
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
public data class CollectionBriefOut(
    val id: String,
    val title: String,
    val icon: String = "",
    val color: String = "",
)

@Serializable
public data class MemoCollection(
    val id: String,
    val title: String,
    val description: String = "",
    val icon: String = "",
    val color: String = "",
    @SerialName("is_smart") val isSmart: Boolean = false,
    @SerialName("smart_filter") val smartFilter: JsonObject = JsonObject(emptyMap()),
    @SerialName("memo_count") val memoCount: Int = 0,
    @SerialName("sort_order") val sortOrder: Int = 0,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
)

@Serializable
public data class MemoCollectionListResponse(
    val items: List<MemoCollection> = emptyList(),
    val total: Int = 0,
    val limit: Int = 0,
    val offset: Int = 0,
)

@Serializable
public data class BookmarkPreview(
    val url: String,
    val title: String = "",
    val description: String = "",
    val image: String = "",
)

/** 当前用户在一个 Organization 内的记忆记录偏好（服务端唯一权威）。 */
@Serializable
public data class RecordStyleConfig(
    val enabled: Boolean = true,
)

@Serializable
public data class MemoHeatmapBucket(
    val date: String,
    val count: Int = 0,
)

@Serializable
public data class MemoHeatmapResponse(
    val buckets: List<MemoHeatmapBucket> = emptyList(),
    val total: Int = 0,
    val days: Int = 0,
)

@Serializable
public data class MemoTagStatsItem(
    val name: String,
    val count: Int = 0,
    @SerialName("ai_only") val aiOnly: Boolean = false,
)

@Serializable
public data class MemoTagStatsResponse(
    val tags: List<MemoTagStatsItem> = emptyList(),
    @SerialName("total_user_tags") val totalUserTags: Int = 0,
    @SerialName("total_ai_tags") val totalAiTags: Int = 0,
)

@Serializable
public data class AgentDiaryFeedItem(
    val id: String,
    @SerialName("agent_id") val agentId: String,
    @SerialName("agent_name") val agentName: String = "",
    @SerialName("agent_avatar") val agentAvatar: String? = null,
    @SerialName("memory_type") val memoryType: String = "diary",
    val content: String = "",
    val tags: List<String> = emptyList(),
    val importance: Int? = null,
    @SerialName("source_ref") val sourceRef: String? = null,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
)

@Serializable
public data class AgentDiaryFeedResponse(
    val items: List<AgentDiaryFeedItem> = emptyList(),
    @SerialName("next_cursor") val nextCursor: String = "",
    @SerialName("has_more") val hasMore: Boolean = false,
    val limit: Int = 0,
    @SerialName("memory_enabled") val memoryEnabled: Boolean = true,
    @SerialName("legacy_policy") val legacyPolicy: String = "",
)

/**
 * Electron 已迁到 Organization diary feed；生产仍隐藏「Agent 日记」。
 * 未就绪不得用空列表伪装。
 */
public object MemoAppHomeFeatureFlags {
    public const val IS_ORGANIZATION_AGENT_DIARY_ENABLED: Boolean = false
}

// ─── 请求模型 ─────────────────────────────────────────────

@Serializable
public data class MemoCreateRequest(
    @SerialName("organization_id") val organizationId: String,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("content_json") val contentJson: JsonObject = JsonObject(emptyMap()),
    @SerialName("content_markdown") val contentMarkdown: String = "",
    val tags: List<String> = emptyList(),
    val color: String = "",
    @SerialName("memo_type") val memoType: String = "note",
    val importance: Int? = null,
    val source: String = "manual",
    @SerialName("source_url") val sourceUrl: String = "",
    @SerialName("bookmark_url") val bookmarkUrl: String = "",
    @SerialName("collection_id") val collectionId: String? = null,
)

@Serializable
public data class MemoUpdateRequest(
    @SerialName("content_json") val contentJson: JsonObject? = null,
    @SerialName("content_markdown") val contentMarkdown: String? = null,
    val tags: List<String>? = null,
    val color: String? = null,
    @SerialName("is_pinned") val isPinned: Boolean? = null,
    @SerialName("memo_type") val memoType: String? = null,
    val importance: Int? = null,
    @SerialName("bookmark_url") val bookmarkUrl: String? = null,
    @SerialName("bookmark_title") val bookmarkTitle: String? = null,
    @SerialName("bookmark_description") val bookmarkDescription: String? = null,
    @SerialName("bookmark_image") val bookmarkImage: String? = null,
)

@Serializable
public data class MemoPinRequest(
    val pinned: Boolean,
)

@Serializable
public data class AttachmentAddRequest(
    @SerialName("file_record_id") val fileRecordId: String,
    @SerialName("file_type") val fileType: String = "",
    @SerialName("sort_order") val sortOrder: Int = 0,
)

@Serializable
public data class CollectionAddMemosRequest(
    @SerialName("memo_ids") val memoIds: List<String>,
)

@Serializable
public data class BookmarkPreviewRequest(
    val url: String,
)

/** 只更新本次用户主动修改的记录偏好字段。 */
@Serializable
public data class RecordStyleUpdateRequest(
    val enabled: Boolean,
)

// ─── MemoColor 枚举 ─────────────────────────────────────────────

public enum class MemoColor(public val rawValue: String) {
    NONE(""),
    YELLOW("yellow"),
    BLUE("blue"),
    GREEN("green"),
    PINK("pink"),
    PURPLE("purple"),
    ORANGE("orange"),
    GRAY("gray");

    public val displayColor: Color
        get() = when (this) {
            NONE -> Color.Transparent
            YELLOW -> Color(0xFFEAB308)
            BLUE -> Color(0xFF3B82F6)
            GREEN -> Color(0xFF22C55E)
            PINK -> Color(0xFFEC4899)
            PURPLE -> Color(0xFFA855F7)
            ORANGE -> Color(0xFFF97316)
            GRAY -> Color(0xFF6B7280)
        }

    public val bgLight: Color
        get() = when (this) {
            NONE -> Color.Transparent
            YELLOW -> Color(0xFFFEFCE8)
            BLUE -> Color(0xFFEFF6FF)
            GREEN -> Color(0xFFF0FDF4)
            PINK -> Color(0xFFFDF2F8)
            PURPLE -> Color(0xFFFAF5FF)
            ORANGE -> Color(0xFFFFF7ED)
            GRAY -> Color(0xFFF9FAFB)
        }

    public val bgDark: Color
        get() = when (this) {
            NONE -> Color.Transparent
            YELLOW -> Color(0xFF422006)
            BLUE -> Color(0xFF172554)
            GREEN -> Color(0xFF052E16)
            PINK -> Color(0xFF500724)
            PURPLE -> Color(0xFF3B0764)
            ORANGE -> Color(0xFF431407)
            GRAY -> Color(0xFF1F2937)
        }

    @get:StringRes
    public val displayNameRes: Int
        get() = when (this) {
            NONE -> R.string.memo_color_none
            YELLOW -> R.string.memo_color_yellow
            BLUE -> R.string.memo_color_blue
            GREEN -> R.string.memo_color_green
            PINK -> R.string.memo_color_pink
            PURPLE -> R.string.memo_color_purple
            ORANGE -> R.string.memo_color_orange
            GRAY -> R.string.memo_color_gray
        }

    public companion object {
        public val colorCases: List<MemoColor> = listOf(YELLOW, BLUE, GREEN, PINK, PURPLE, ORANGE, GRAY)
        public val selectableCases: List<MemoColor> = colorCases

        public fun from(raw: String): MemoColor? {
            if (raw.isEmpty()) return null
            return entries.find { it.rawValue == raw }
        }
    }
}

// ─── MemoSummary 扩展 ─────────────────────────────────────────────

/** 去除 Markdown 格式后的纯文本预览 */
public val MemoSummary.strippedPreview: String
    get() = MemoMarkdownStripper.strip(contentPlaintext)

/** 是否为语音备忘 */
public val MemoSummary.isVoice: Boolean
    get() = source == "voice"

private object MemoMarkdownStripper {
    private val patterns = listOf(
        Regex("^#{1,6}\\s+") to "",
        Regex("\\*\\*(.+?)\\*\\*") to "$1",
        Regex("\\*(.+?)\\*") to "$1",
        Regex("`([^`]+)`") to "$1",
        Regex("\\[([^\\]]+)\\]\\([^)]+\\)") to "$1",
    )

    fun strip(text: String): String {
        var result = text
        for ((regex, replacement) in patterns) {
            result = regex.replace(result, replacement)
        }
        return result.trim()
    }
}

// ─── toSummary 扩展 ─────────────────────────────────────────────

/**
 * 将 MemoDetail 转为 MemoSummary，用于创建/更新后插入列表。
 */
public fun MemoDetail.toSummary(): MemoSummary = MemoSummary(
    id = id,
    spaceId = spaceId,
    memoType = memoType,
    importance = importance,
    contentPlaintext = contentPlaintext,
    tags = tags,
    aiTags = aiTags,
    color = color,
    source = source,
    status = status,
    isPinned = isPinned,
    bookmarkUrl = bookmarkUrl,
    bookmarkTitle = bookmarkTitle,
    bookmarkImage = bookmarkImage,
    attachmentCount = attachmentCount,
    createdAt = createdAt,
    updatedAt = updatedAt,
)
