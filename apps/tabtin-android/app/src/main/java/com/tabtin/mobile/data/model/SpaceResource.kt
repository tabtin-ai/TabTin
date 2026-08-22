package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

@Serializable
public data class SpaceResource(
    val id: String,
    @SerialName("item_type") val itemType: String,
    val title: String = "",
    val preview: String? = null,
    @SerialName("resource_id") val resourceId: String,
    /** 资源可只归属于 Organization；这种云端资源没有 Space 宿主。 */
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    /**
     * Wave 6 跨端协议验证：space_name 让 @ 提及生成的 context block 携带可读 space 名。
     * 组织级资源没有该字段，缺失时不影响引用的资源级溯源。
     */
    @SerialName("space_name") val spaceName: String? = null,
    /**
     * Wave 6 跨端协议验证：field 类引用必备 — field 资源所属 owner table 的 ID，
     * 用于生成 `MessageBlock(type="table_selection", tableId=ownerTableId, fieldIds=[fieldId])`
     * 与 Electron `useContextInjection.ts::contextRefsToBlocks` 行 137-141 一致。
     * 当前 Android 列表接口不下发独立 field 子项（field 候选源待 Wave 7+ 接入），
     * 字段先暴露能力，UI 入口暂不开。
     */
    @SerialName("owner_table_id") val ownerTableId: String? = null,
    val metadata: JsonObject? = null,
    @SerialName("is_archived") val isArchived: Boolean? = null,
    @SerialName("is_pinned") val isPinned: Boolean? = null,
    @SerialName("pinned_at") val pinnedAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    /**
     * per-user 访问时间；后端在 context-items 列表里按当前用户回填，未访问过为 null。
     * 「最近」分段按此排序。
     */
    @SerialName("last_visited_at") val lastVisitedAt: String? = null,
    /**
     * Organization Collection 文件夹 ID；根目录未入夹时为 null。
     * 云盘列表 / 移动 / 面包屑使用，与知识树 `parent_id` 解耦。
     */
    @SerialName("collection_id") val collectionId: String? = null,
    /**
     * 资源所有者，由后端 `_enrich_owner_info` 注入。
     * owner 整段可为 null；子字段也全可选——用户被删或查不到时后端会吐 null，
     * 任一子字段声明成必填都会让整条资源解码失败。
     */
    val owner: SpaceResourceOwner? = null,
    /**
     * 云盘 capability。三态与 [canShare] 同口径：
     * `null` = 接口未回填（乐观放行读路径）；显式 `false` 才收口。
     */
    @SerialName("can_view") val canView: Boolean? = null,
    @SerialName("can_edit") val canEdit: Boolean? = null,
    @SerialName("can_move") val canMove: Boolean? = null,
    /**
     * 能否开公开链接 / 邀请协作者。
     *
     * 三态必须保留：
     * - `true`：确定可分享
     * - `false`：确定不行（不出入口）
     * - `null`：接口没吐这一位（知识树不回填）——乐观放出入口
     */
    @SerialName("can_share") val canShare: Boolean? = null,
    @SerialName("can_trash") val canTrash: Boolean? = null,
    @SerialName("can_delete") val canDelete: Boolean? = null,
) {
    /**
     * ContextItem 主键。列表、移动、访问上报、签名下载一律用此 ID，
     * 不要与 [resourceId] / [fileRecordId] 混传。
     */
    val contextItemId: String
        get() = id

    /**
     * TabFiles 的 FileRecordID（= [resourceId]）。
     * 分享 / 回收站 / 恢复 / 永久删除用；下载签名 URL 仍走 [contextItemId]。
     */
    val fileRecordId: String?
        get() = if (normalizedType == "tabfiles") resourceId.takeIf { it.isNotBlank() } else null

    val normalizedType: String
        get() = normalizedType(itemType)

    val emoji: String
        get() = when (normalizedType) {
            "tabdata" -> "📊"
            "tabdoc" -> "📄"
            "tabslide" -> "📑"
            "tabtracker" -> "📅"
            "tabvideo" -> "🎬"
            "tabcode" -> "💻"
            "tabsite" -> "🌐"
            "tabmemo" -> "📝"
            "tabwhiteboard" -> "✏️"
            "tabdesign" -> "🎨"
            "tabfiles" -> "📁"
            else -> "📁"
        }

    val typeLabel: String
        get() = when (normalizedType) {
            "tabdata" -> "TabData"
            "tabdoc" -> "TabDoc"
            "tabslide" -> "TabSlide"
            "tabtracker" -> "Tracker"
            "tabvideo" -> "TabVideo"
            "tabcode" -> "TabCode"
            "tabsite" -> "TabSite"
            "tabmemo" -> "TabMemo"
            "tabwhiteboard" -> "TabWhiteboard"
            "tabdesign" -> "TabDesign"
            "tabfiles" -> "TabFiles"
            else -> itemType
        }

    val icon: String
        get() = when (normalizedType) {
            "tabdata" -> "table_chart"
            "tabdoc" -> "article"
            "tabslide" -> "slideshow"
            "tabtracker" -> "calendar_today"
            "tabfiles" -> "folder"
            else -> "insert_drive_file"
        }

    val displayTitle: String get() = title.ifEmpty { "未命名" }

    val siteUrl: String?
        get() {
            if (normalizedType != "tabsite") return null
            preview?.takeIf { it.isNotBlank() }?.let { return it }
            val meta = metadata ?: return null
            (meta["dist_oss_url"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
                ?.takeIf { it.isNotBlank() }?.let { return it }
            (meta["url"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
                ?.takeIf { it.isNotBlank() }?.let { return it }
            return null
        }

    val fileName: String
        get() = metadata.firstString("file_name", "filename", "name", "original_name", "display_name")
            ?: displayTitle

    val mimeType: String?
        get() = metadata.firstString("mime_type", "mime", "content_type", "contentType")

    val fileSizeBytes: Long?
        get() = metadata.firstLong("size", "file_size", "size_bytes", "bytes")

    val fileUrl: String?
        get() = metadata.firstString(
            "preview_url",
            "download_url",
            "file_url",
            "url",
            "oss_url",
            "dist_oss_url",
            "storage_url",
        ) ?: preview?.takeIf { it.isNotBlank() && (it.startsWith("http://") || it.startsWith("https://")) }

    public companion object {
        public fun normalizedType(rawType: String): String {
            val aliases = mapOf(
                "table" to "tabdata", "document" to "tabdoc",
                "doc" to "tabdoc",
                "slide" to "tabslide", "ppt" to "tabslide",
                "video" to "tabvideo",
                "canvas" to "tabwhiteboard", "memo" to "tabmemo",
                "site" to "tabsite", "code" to "tabcode",
                "file" to "tabfiles", "files" to "tabfiles", "tabfile" to "tabfiles",
                "goal" to "tabtracker", "tabgoal" to "tabtracker", "tracker" to "tabtracker",
                // Wave 6 协议对照 Review P1-Q1：补 "design" 别名让 @提及 ResourceReference
                // 能稳定走 "tabdesign" 分支生成 MessageBlock(type="design")，与 iOS
                // ContextRefType.fromItemType 同口径。
                "design" to "tabdesign",
            )
            return aliases[rawType] ?: rawType
        }
    }
}

private fun JsonObject?.firstString(vararg keys: String): String? {
    val json = this ?: return null
    for (key in keys) {
        val value = (json[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
        if (value != null) return value
    }
    return null
}

private fun JsonObject?.firstLong(vararg keys: String): Long? {
    val json = this ?: return null
    for (key in keys) {
        val primitive = json[key] as? JsonPrimitive ?: continue
        primitive.contentOrNull?.toLongOrNull()?.let { return it }
    }
    return null
}

/**
 * 资源所有者。后端 `_enrich_owner_info` 注入 `{id, display_name, avatar}`。
 * 三个字段全可选，避免脏数据拖垮整页列表解码。
 */
@Serializable
public data class SpaceResourceOwner(
    val id: String? = null,
    @SerialName("display_name") val displayName: String? = null,
    val avatar: String? = null,
) {
    /** 拿不到名字就当没有所有者信息，避免副标题显示空串。 */
    val presentableName: String?
        get() = displayName?.trim()?.takeIf { it.isNotEmpty() }
}

@Serializable
public data class SpaceResourceListResponse(
    val items: List<SpaceResource>,
    val total: Int? = null,
    val page: Int? = null,
    @SerialName("page_size") val pageSize: Int? = null,
)
