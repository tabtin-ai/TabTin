package com.tabtin.mobile.features.clouddocs

import com.tabtin.mobile.data.model.SharedResourceItem
import com.tabtin.mobile.data.model.SharedResourceType
import com.tabtin.mobile.data.model.SpaceResource

/**
 * 深链 / 通知待打开的云文档目标。
 *
 * 由 [AppNavigation] 在切到 CLOUD Tab 时下发，[CloudDocsTabScreen] / ViewModel 消费：
 * 切组织 → 加载列表 → 解析路由 → push 打开（对齐 iOS `openPendingResourceIfNeeded`）。
 */
public data class CloudDocsPendingOpen(
    val organizationId: String,
    val spaceId: String?,
    val resourceType: String,
    val resourceId: String,
    val title: String? = null,
    val locationHint: String? = null,
    /** 分享给我通知：打开前切到「分享给我」分段。 */
    val preferSharedSegment: Boolean = false,
) {
    public val normalizedType: String get() = SpaceResource.normalizedType(resourceType)

    public fun asSpaceResource(): SpaceResource = SpaceResource(
        id = resourceId,
        itemType = normalizedType,
        title = title?.takeIf { it.isNotBlank() } ?: defaultTitle(normalizedType),
        resourceId = resourceId,
        spaceId = spaceId,
        organizationId = organizationId,
        spaceName = locationHint,
    )

    private fun defaultTitle(type: String): String = when (type) {
        "tabdoc" -> "TabDoc"
        "tabdata" -> "TabData"
        else -> "Resource"
    }
}

internal sealed class CloudDocsPendingOpenResult {
    data class Open(
        val resource: SpaceResource,
        val spaceName: String?,
    ) : CloudDocsPendingOpenResult()

    data class Unsupported(
        val locationHint: String?,
    ) : CloudDocsPendingOpenResult()
}

/**
 * 纯解析：是否走云文档 Tab、如何从已加载列表 / 深链兜底合成可打开资源。
 */
internal object CloudDocsPendingOpenResolver {
    private val CLOUD_DOC_TYPES: Set<String> = setOf("tabdoc", "tabdata")

    fun isCloudDocsType(resourceType: String): Boolean =
        SpaceResource.normalizedType(resourceType) in CLOUD_DOC_TYPES

    fun resolve(
        pending: CloudDocsPendingOpen,
        recentItems: List<SpaceResource>,
        sharedItems: List<SharedResourceItem> = emptyList(),
    ): CloudDocsPendingOpenResult {
        if (!isCloudDocsType(pending.resourceType)) {
            return CloudDocsPendingOpenResult.Unsupported(pending.locationHint)
        }

        val matchedRecent = recentItems.firstOrNull { matches(it, pending) }
        if (matchedRecent != null) {
            return CloudDocsPendingOpenResult.Open(
                resource = matchedRecent,
                spaceName = matchedRecent.spaceName ?: pending.locationHint,
            )
        }

        val matchedShared = sharedItems.firstOrNull { item ->
            item.resourceId == pending.resourceId || item.id == pending.resourceId
        }
        if (matchedShared != null) {
            return CloudDocsPendingOpenResult.Open(
                resource = matchedShared.toSpaceResource(),
                spaceName = pending.locationHint,
            )
        }

        // tabdoc / tabdata 即使不在最近列表也能合成资源，交给统一原生资源宿主打开。
        return CloudDocsPendingOpenResult.Open(
            resource = pending.asSpaceResource(),
            spaceName = pending.locationHint,
        )
    }

    private fun matches(resource: SpaceResource, pending: CloudDocsPendingOpen): Boolean {
        val type = pending.normalizedType
        return resource.resourceId == pending.resourceId ||
            resource.id == pending.resourceId ||
            (resource.normalizedType == type && resource.resourceId == pending.resourceId)
    }
}

internal fun SharedResourceItem.toSpaceResource(): SpaceResource = SpaceResource(
    id = id,
    itemType = when (resourceType) {
        SharedResourceType.DOC -> "tabdoc"
        SharedResourceType.TABLE -> "tabdata"
    },
    title = title,
    resourceId = resourceId,
    organizationId = organizationId,
    spaceId = spaceId,
    updatedAt = updatedAt,
)
