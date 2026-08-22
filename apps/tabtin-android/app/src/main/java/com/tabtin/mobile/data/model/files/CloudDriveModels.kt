package com.tabtin.mobile.data.model.files

import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.SpaceResourceOwner
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** 云盘三范围：全部 / 最近 / 分享给我。 */
public enum class CloudDriveBrowseScope {
    ALL,
    RECENT,
    SHARED,
}

/** 类型筛选；与范围共同生效。 */
public enum class CloudDriveTypeFilter(public val wireValue: String?) {
    ALL(null),
    TABDOC("tabdoc"),
    TABDATA("tabdata"),
    TABFILES("tabfiles"),
    ;

    public fun toItemTypesParam(): String = when (this) {
        ALL -> CloudDriveContracts.CLOUD_DRIVE_ITEM_TYPES
        else -> wireValue!!
    }
}

public object CloudDriveContracts {
    public const val CLOUD_DRIVE_ITEM_TYPES: String = "tabdoc,tabdata,tabfiles"
    public const val ROOT_COLLECTION_ID: String = "root"
    public const val DEFAULT_PAGE_SIZE: Int = 50
    public const val SEARCH_PAGE_SIZE: Int = 30
    public const val SHARED_FEED_LIMIT: Int = 30
    public const val RECENT_SORT: String = "-last_visited_at"
    /** 搜索 / 分享行位置列：根目录。 */
    public const val LOCATION_ROOT: String = "根目录"
    /** 搜索 / 分享行位置列：分享给我（collection 不在本人文件夹树）。 */
    public const val LOCATION_SHARED_WITH_ME: String = "分享给我"
}

/**
 * 云盘资源行（产品层）。明确区分 ContextItemID 与 FileRecordID，
 * 避免 View 层只传裸 `id`。
 */
public data class CloudDriveResourceRow(
    val contextItemId: String,
    val resourceId: String,
    val fileRecordId: String?,
    val itemType: String,
    val title: String,
    val preview: String?,
    val collectionId: String?,
    val organizationId: String?,
    val spaceId: String?,
    val spaceName: String?,
    val owner: SpaceResourceOwner?,
    val metadata: JsonObject?,
    val isPinned: Boolean,
    val lastVisitedAt: String?,
    val updatedAt: String?,
    val canView: Boolean?,
    val canEdit: Boolean?,
    val canMove: Boolean?,
    val canShare: Boolean?,
    val canTrash: Boolean?,
    val canDelete: Boolean?,
    val sharedBy: SpaceResourceOwner? = null,
    val permission: String? = null,
    val locationLabel: String? = null,
) {
    public val normalizedType: String
        get() = SpaceResource.normalizedType(itemType)

    public val displayTitle: String
        get() = title.ifBlank { "未命名" }

    /** 打开详情前可从列表 metadata 透传，不必等签名 URL。 */
    public val mimeType: String?
        get() = metadata.firstMetaString("mime_type", "mime", "content_type", "contentType")

    public val fileSizeBytes: Long?
        get() = metadata.firstMetaLong("size", "file_size", "size_bytes", "bytes")

    public companion object {
        public fun fromSpaceResource(
            resource: SpaceResource,
            locationLabel: String? = null,
        ): CloudDriveResourceRow = CloudDriveResourceRow(
            contextItemId = resource.contextItemId,
            resourceId = resource.resourceId,
            fileRecordId = resource.fileRecordId,
            itemType = resource.itemType,
            title = resource.title,
            preview = resource.preview,
            collectionId = resource.collectionId,
            organizationId = resource.organizationId,
            spaceId = resource.spaceId,
            spaceName = resource.spaceName,
            owner = resource.owner,
            metadata = resource.metadata,
            isPinned = resource.isPinned == true,
            lastVisitedAt = resource.lastVisitedAt,
            updatedAt = resource.updatedAt,
            canView = resource.canView,
            canEdit = resource.canEdit,
            canMove = resource.canMove,
            canShare = resource.canShare,
            canTrash = resource.canTrash,
            canDelete = resource.canDelete,
            locationLabel = locationLabel,
        )

        public fun fromSharedFeedItem(item: CloudDriveSharedFeedItem): CloudDriveResourceRow =
            CloudDriveResourceRow(
                contextItemId = item.contextItemId,
                resourceId = item.resourceId,
                fileRecordId = item.fileRecordId
                    ?: item.resourceId.takeIf { item.normalizedType == "tabfiles" },
                itemType = item.itemType,
                title = item.title,
                preview = item.preview,
                collectionId = item.collectionId,
                organizationId = item.organizationId,
                spaceId = item.spaceId,
                spaceName = item.spaceName,
                owner = item.owner,
                metadata = item.metadata,
                isPinned = item.isPinned,
                lastVisitedAt = null,
                updatedAt = item.updatedAt,
                canView = item.canView,
                canEdit = item.canEdit,
                canMove = item.canMove,
                canShare = item.canShare,
                canTrash = item.canTrash,
                canDelete = item.canDelete,
                sharedBy = item.sharedBy,
                permission = item.permission,
                locationLabel = CloudDriveContracts.LOCATION_SHARED_WITH_ME,
            )

        /** 分享权限 wire → 行副标题可读文案。 */
        public fun formatSharePermission(permission: String?): String? {
            val raw = permission?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            return when (raw.lowercase()) {
                "viewer", "view" -> "可查看"
                "editor", "edit" -> "可编辑"
                "comment" -> "可评论"
                "owner" -> "所有者"
                else -> raw
            }
        }
    }
}

private fun JsonObject?.firstMetaString(vararg keys: String): String? {
    val json = this ?: return null
    for (key in keys) {
        val value = (json[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
        if (value != null) return value
    }
    return null
}

private fun JsonObject?.firstMetaLong(vararg keys: String): Long? {
    val json = this ?: return null
    for (key in keys) {
        val primitive = json[key] as? JsonPrimitive ?: continue
        primitive.contentOrNull?.toLongOrNull()?.let { return it }
    }
    return null
}

@Serializable
public data class CloudDriveCollection(
    val id: String,
    val name: String,
    val icon: String = "📁",
    val color: String = "",
    val order: Int = 0,
    @SerialName("parent_id") val parentId: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("is_expanded") val isExpanded: Boolean = false,
    @SerialName("is_pinned") val isPinned: Boolean = false,
    @SerialName("item_count") val itemCount: Int = 0,
    val children: List<CloudDriveCollection> = emptyList(),
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
public data class CloudDriveCollectionListResponse(
    val collections: List<CloudDriveCollection> = emptyList(),
    val total: Int = 0,
)

@Serializable
public data class CloudDriveSearchResponse(
    val items: List<SpaceResource> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    @SerialName("page_size") val pageSize: Int = 30,
)

@Serializable
public data class CloudDriveSharedFeedItem(
    @SerialName("context_item_id") val contextItemId: String,
    @SerialName("resource_id") val resourceId: String,
    @SerialName("file_record_id") val fileRecordId: String? = null,
    @SerialName("item_type") val itemType: String,
    val title: String = "",
    val preview: String? = null,
    @SerialName("collection_id") val collectionId: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("space_name") val spaceName: String? = null,
    val metadata: JsonObject? = null,
    @SerialName("is_pinned") val isPinned: Boolean = false,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    val permission: String? = null,
    @SerialName("shared_by") val sharedBy: SpaceResourceOwner? = null,
    val owner: SpaceResourceOwner? = null,
    @SerialName("owner_id") val ownerId: String? = null,
    @SerialName("can_view") val canView: Boolean? = null,
    @SerialName("can_edit") val canEdit: Boolean? = null,
    @SerialName("can_move") val canMove: Boolean? = null,
    @SerialName("can_share") val canShare: Boolean? = null,
    @SerialName("can_trash") val canTrash: Boolean? = null,
    @SerialName("can_delete") val canDelete: Boolean? = null,
) {
    public val normalizedType: String
        get() = SpaceResource.normalizedType(itemType)
}

@Serializable
public data class CloudDriveSharedFeedResponse(
    val items: List<CloudDriveSharedFeedItem> = emptyList(),
    @SerialName("next_cursor") val nextCursor: String? = null,
    val limit: Int = 30,
)

@Serializable
public data class CloudFileDownloadUrlResponse(
    val url: String = "",
    @SerialName("file_name") val fileName: String = "",
    @SerialName("mime_type") val mimeType: String? = null,
    @SerialName("file_size") val fileSize: Long? = null,
    @SerialName("preview_eligible") val previewEligible: Boolean = false,
    @SerialName("mime_preview_safe") val mimePreviewSafe: Boolean = false,
)

public data class CloudDriveFolderPage(
    val folders: List<CloudDriveCollection>,
    val resources: List<CloudDriveResourceRow>,
    val total: Int,
    val page: Int,
    val pageSize: Int,
    val hasMore: Boolean,
)

public data class CloudDriveSharedPage(
    val resources: List<CloudDriveResourceRow>,
    val nextCursor: String?,
    val hasMore: Boolean,
)

@Serializable
public data class CloudDriveCollectionCreateRequest(
    val name: String,
    @SerialName("parent_id") val parentId: String? = null,
    val icon: String? = "📁",
    val color: String? = "",
)

/** 文件夹重命名 / 移动。显式传 [parentId]=null 表示移到根。 */
@Serializable
public data class CloudDriveCollectionUpdateRequest(
    val name: String? = null,
    @SerialName("parent_id") val parentId: String? = null,
)

/** 移动资源进/出文件夹；[itemIds] = ContextItemID 列表（首发单条）。 */
@Serializable
public data class CloudDriveMoveItemsRequest(
    @SerialName("item_ids") val itemIds: List<String>,
    @SerialName("collection_id") val collectionId: String? = null,
)

@Serializable
public data class CloudDriveMoveItemsResponse(
    val updated: Int = 0,
)

@Serializable
public data class TabFilesUserBrief(
    @SerialName("user_id") val userId: String = "",
    val nickname: String = "",
    val avatar: String? = null,
    val email: String = "",
)

@Serializable
public data class TabFilesCollaborator(
    @SerialName("user_id") val userId: String = "",
    val nickname: String = "",
    val avatar: String? = null,
    val email: String = "",
    val permission: String = "viewer",
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
public data class TabFilesCollaboratorsResponse(
    val owner: TabFilesUserBrief? = null,
    val collaborators: List<TabFilesCollaborator> = emptyList(),
)

@Serializable
public data class TabFilesInviteCollaboratorsRequest(
    @SerialName("user_ids") val userIds: List<String>,
    val permission: String = "viewer",
)

@Serializable
public data class TabFilesUpdateCollaboratorRequest(
    val permission: String,
)

@Serializable
public data class CloudDriveFileMountRequest(
    @SerialName("file_record_id") val fileRecordId: String,
    @SerialName("collection_id") val collectionId: String? = null,
    val title: String? = null,
)

@Serializable
public data class CreateTableRequest(
    @SerialName("organization_id") val organizationId: String,
    val name: String,
    @SerialName("collection_id") val collectionId: String? = null,
    @SerialName("use_default_fields") val useDefaultFields: Boolean = true,
)

@Serializable
public data class CreateTableResponse(
    val id: String,
    val name: String = "",
    @SerialName("organization_id") val organizationId: String? = null,
)

/**
 * OSS confirm 成功、云盘 mount 失败时持久化的待挂载任务。
 * 再次进入 App 或显式重试时按 Organization + FileRecord 幂等 mount。
 */
@Serializable
public data class CloudDrivePendingMountTask(
    @SerialName("file_record_id") val fileRecordId: String,
    @SerialName("organization_id") val organizationId: String,
    @SerialName("collection_id") val collectionId: String? = null,
    val title: String? = null,
    val error: String? = null,
    @SerialName("created_at") val createdAt: String = "",
)

/** 单文件上传 UI 阶段（不含本地文件正文）。 */
public enum class CloudDriveUploadPhase {
    SELECTED,
    UPLOADING,
    CONFIRMED,
    MOUNTING,
    READY,
    PENDING_MOUNT,
    FAILED,
}

/**
 * confirm 已成功、mount 失败：已写入 pendingMount，可按 [fileRecordId] 重试。
 */
public class CloudDriveMountPendingException(
    public val fileRecordId: String,
    public val organizationId: String,
    cause: Throwable,
) : Exception(cause.message, cause)

public data class CloudDriveUploadItemState(
    val localKey: String,
    val fileName: String,
    val phase: CloudDriveUploadPhase,
    val progress: Float = 0f,
    val errorMessage: String? = null,
    val contextItemId: String? = null,
)

public object CloudFilePreviewPolicy {
    /** 与后端 `_PREVIEW_SAFE_MIME_TYPES` 对齐的客户端护栏（不含 svg/html/zip）。 */
    public fun isInlinePreviewSafe(mimeType: String?): Boolean {
        val mime = mimeType?.trim()?.lowercase().orEmpty()
        if (mime.isEmpty()) return false
        if (mime == "application/pdf") return true
        if (mime.startsWith("text/") && mime !in UNSAFE_TEXT_MIME) return true
        if (mime.startsWith("image/") && mime != "image/svg+xml") return true
        return mime in SAFE_MEDIA_MIME
    }

    private val UNSAFE_TEXT_MIME: Set<String> = setOf(
        "text/html",
        "text/javascript",
        "text/xml",
    )

    private val SAFE_MEDIA_MIME: Set<String> = setOf(
        "audio/mpeg",
        "audio/mp4",
        "audio/wav",
        "audio/x-wav",
        "video/mp4",
        "video/quicktime",
    )
}
