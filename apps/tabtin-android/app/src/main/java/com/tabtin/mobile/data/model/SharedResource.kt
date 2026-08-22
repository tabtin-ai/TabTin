package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

public enum class SharedResourceType(public val wireValue: String) {
    DOC("doc"),
    TABLE("table"),
}

/** 分享人。后端在 shared-with-me 响应里 enrich 出来，可能为空。 */
@Serializable
public data class SharedResourceOwner(
    val id: String = "",
    @SerialName("display_name") val displayName: String = "",
    val avatar: String? = null,
)

/**
 * 别人分享给我的云资源。
 *
 * 这类资源不一定在当前 organization 的 context-items 里，因此没有 contextItemId，
 * [id] 是合成的（`shared:doc:xxx`），不能拿去调 context-item 的接口。
 */
public data class SharedResourceItem(
    val resourceType: SharedResourceType,
    val resourceId: String,
    val title: String,
    val organizationId: String,
    val spaceId: String?,
    val permission: String,
    val updatedAt: String?,
    val sharedBy: SharedResourceOwner?,
) {
    val id: String get() = "shared:${resourceType.wireValue}:$resourceId"

    val displayTitle: String get() = title.ifEmpty { "未命名" }
}

/**
 * tabdoc `/shared-with-me` 单行。
 *
 * [organizationId] / [permission] 声明为可空：后端对脏数据会吐 null，
 * 一行 null 不能拖垮整批；转 [SharedResourceItem] 时降级为空串。
 */
@Serializable
public data class SharedDocRow(
    @SerialName("document_id") val documentId: String,
    val title: String = "",
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    val permission: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("shared_by") val sharedBy: SharedResourceOwner? = null,
) {
    public fun asSharedResourceItem(): SharedResourceItem = SharedResourceItem(
        resourceType = SharedResourceType.DOC,
        resourceId = documentId,
        title = title,
        organizationId = organizationId.orEmpty(),
        spaceId = SharedResourceNormalizer.normalizedId(spaceId),
        permission = permission.orEmpty(),
        updatedAt = updatedAt,
        sharedBy = sharedBy,
    )
}

/**
 * tabdata `/shared-with-me` 单行。
 * 表格端点显式允许 `organization_id` 为 null，见 tabdata `share_service`。
 */
@Serializable
public data class SharedTableRow(
    @SerialName("table_id") val tableId: String,
    val title: String = "",
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    val permission: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("shared_by") val sharedBy: SharedResourceOwner? = null,
) {
    public fun asSharedResourceItem(): SharedResourceItem = SharedResourceItem(
        resourceType = SharedResourceType.TABLE,
        resourceId = tableId,
        title = title,
        organizationId = organizationId.orEmpty(),
        spaceId = SharedResourceNormalizer.normalizedId(spaceId),
        permission = permission.orEmpty(),
        updatedAt = updatedAt,
        sharedBy = sharedBy,
    )
}

public object SharedResourceNormalizer {
    /** 后端在「只分享到组织、没落到具体 Workspace」时返回空串，统一归一成 null。 */
    public fun normalizedId(value: String?): String? {
        val trimmed = value?.trim().orEmpty()
        return trimmed.takeIf { it.isNotEmpty() }
    }
}

@Serializable
public data class SharedDocsResponse(
    val documents: List<SharedDocRow>? = null,
    val total: Int? = null,
)

@Serializable
public data class SharedTablesResponse(
    val tables: List<SharedTableRow>? = null,
    val total: Int? = null,
)
