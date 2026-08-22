package com.tabtin.mobile.features.clouddocs

import com.tabtin.mobile.data.model.CloudShareResourceType
import com.tabtin.mobile.data.model.SpaceResource

/** 页面级分享目标：挂在列表外，避免删除/刷新把 sheet 一起卸掉。 */
internal data class CloudDocsShareTarget(
    val resourceId: String,
    val type: CloudShareResourceType,
    val title: String,
)

/** 待确认删除目标，同样挂页面级。 */
internal data class CloudDocsDeletionTarget(
    val id: String,
    val title: String,
)

/**
 * `canShare` 三态：
 * - `false`：不出入口
 * - `true` / `null`：放出（知识树不回填 → null 乐观放出）
 *
 * 仅 tabdoc / tabdata 可映射为公开链接资源。
 */
internal fun resolveShareTarget(
    itemType: String,
    resourceId: String?,
    title: String,
    canShare: Boolean?,
): CloudDocsShareTarget? {
    if (canShare == false) return null
    val id = resourceId?.trim().orEmpty()
    if (id.isEmpty()) return null
    val type = CloudShareResourceType.fromNormalizedType(SpaceResource.normalizedType(itemType))
        ?: return null
    return CloudDocsShareTarget(resourceId = id, type = type, title = title)
}

/** 只有本组织 context-item 可置顶/删除；`shared:` 合成 id 解析不出。 */
internal fun manageableContextItemId(rawId: String?): String? {
    val id = rawId?.trim().orEmpty()
    if (id.isEmpty() || id.startsWith("shared:")) return null
    return id
}
