package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * 云文档公开分享支持的资源类型。
 *
 * 刻意只覆盖 tabdoc / tabdata。tabfiles 没有公开链接，不要套同一套 URL。
 */
public enum class CloudShareResourceType {
    DOCUMENT,
    TABLE,
    ;

    /** 公网范围的 share_type：doc 是 `"public"`，table 是 `"data"`。 */
    public val anyoneWireValue: String
        get() = when (this) {
            DOCUMENT -> "public"
            TABLE -> "data"
        }

    /** 公开分享页路径段：`/shared/docs|tables/{shareId}`。 */
    public val publicPathSegment: String
        get() = when (this) {
            DOCUMENT -> "docs"
            TABLE -> "tables"
        }

    /** 后端支持、且 UI 应展示的权限档位。table 没有 comment。 */
    public val availablePermissions: List<CloudSharePermission>
        get() = when (this) {
            DOCUMENT -> listOf(
                CloudSharePermission.VIEW,
                CloudSharePermission.COMMENT,
                CloudSharePermission.EDIT,
            )
            TABLE -> listOf(
                CloudSharePermission.VIEW,
                CloudSharePermission.EDIT,
            )
        }

    public companion object {
        /** 从归一后的类型名解析。只认 `tabdoc` / `tabdata`。 */
        public fun fromNormalizedType(normalizedType: String): CloudShareResourceType? =
            when (normalizedType) {
                "tabdoc" -> DOCUMENT
                "tabdata" -> TABLE
                else -> null
            }
    }
}

public enum class CloudShareScope {
    ORGANIZATION,
    ANYONE,
    ;

    public fun wireValue(type: CloudShareResourceType): String = when (this) {
        ORGANIZATION -> "organization"
        ANYONE -> type.anyoneWireValue
    }

    public companion object {
        /**
         * 反解 share_type。认不出来时返回 organization（保守，宁可显示成范围更小）。
         */
        public fun fromWireValue(wireValue: String, type: CloudShareResourceType): CloudShareScope =
            when (wireValue) {
                "organization" -> ORGANIZATION
                type.anyoneWireValue -> ANYONE
                else -> ORGANIZATION
            }
    }
}

public enum class CloudSharePermission(public val wireValue: String) {
    VIEW("view"),
    COMMENT("comment"),
    EDIT("edit"),
    ;

    public companion object {
        public fun fromWireValue(wireValue: String): CloudSharePermission? =
            entries.firstOrNull { it.wireValue == wireValue }
    }
}

/**
 * 后端 ShareOut / DataShareOut 的交集字段。
 *
 * `allow_download` / `allow_copy` 本期不给 UI，先不解码。
 * TabData 的 DataShareOut 可能缺 `organization_id` / `is_active`，缺省要能解。
 */
@Serializable
public data class CloudDocShare(
    @SerialName("share_id") val shareId: String,
    @SerialName("share_type") val shareType: String,
    val permission: String,
    @SerialName("has_password") val hasPassword: Boolean = false,
    @SerialName("expire_at") val expireAt: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("visit_count") val visitCount: Int? = null,
    /** TabData DataShareOut 无 is_active；能读到分享对象即视为生效中。 */
    @SerialName("is_active") val isActive: Boolean = true,
    @SerialName("created_at") val createdAt: String? = null,
)

public sealed class CloudDocsShareError(message: String? = null) : Exception(message) {
    public data object Forbidden : CloudDocsShareError("forbidden")
    public data object PublicExposureNotAcknowledged :
        CloudDocsShareError("public_exposure_not_acknowledged")
    public data object UnsupportedResourceType : CloudDocsShareError("unsupported_resource_type")
    public data class Other(val detail: String) : CloudDocsShareError(detail)
}

@Serializable
public data class CloudDocShareFetchResponse(
    val share: CloudDocShare? = null,
    val enabled: Boolean? = null,
)

@Serializable
public data class CloudDocShareMutationResponse(
    val share: CloudDocShare,
)

@Serializable
public data class CloudDocShareDisableResponse(
    @SerialName("disabled_count") val disabledCount: Int? = null,
)

/** 资源级协作者。权限值沿用后端 `viewer` / `editor` / `admin` 契约。 */
@Serializable
public data class CloudDocsCollaborator(
    @SerialName("user_id") val userId: String,
    val nickname: String = "",
    val avatar: String? = null,
    val email: String = "",
    val permission: String = "viewer",
)

@Serializable
public data class CloudDocsOwner(
    @SerialName("user_id") val userId: String,
    val nickname: String = "",
    val avatar: String? = null,
    val email: String = "",
)

@Serializable
public data class CloudDocsCollaboratorsResponse(
    val owner: CloudDocsOwner,
    val collaborators: List<CloudDocsCollaborator> = emptyList(),
)

@Serializable
public data class CloudDocsInviteRequest(
    @SerialName("user_ids") val userIds: List<String>,
    val permission: String,
)

@Serializable
public data class CloudDocsUpdateCollaboratorRequest(val permission: String)

/** 与 iOS Endpoints.TabDoc / TabData share 路径对齐，便于单测钉住。 */
public object CloudDocsSharePaths {
    public fun documentShare(documentId: String): String =
        "tabdoc/documents/$documentId/share"

    public fun documentShareRefresh(documentId: String): String =
        "tabdoc/documents/$documentId/share/refresh"

    public fun tableShare(tableId: String): String =
        "tabdata/tables/$tableId/share"
}
