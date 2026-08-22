package com.tabtin.mobile.features.clouddocs

import com.tabtin.mobile.data.model.SpaceResource

/**
 * 云文档资源本地搜索匹配（标题 / 预览 / Space 名 / 类型标签）。
 * 从旧 cloudapps 包迁出，供单测与后续本地 filter 复用。
 */
internal fun SpaceResource.matchesCloudSearch(query: String): Boolean {
    val normalizedQuery = query.trim()
    return normalizedQuery.isEmpty() || listOfNotNull(title, preview, spaceName, typeLabel)
        .any { it.contains(normalizedQuery, ignoreCase = true) }
}
