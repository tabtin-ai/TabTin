package com.tabtin.mobile.features.files

import com.tabtin.mobile.data.model.files.CloudDriveBrowseScope
import com.tabtin.mobile.data.model.files.CloudDriveContracts
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import java.time.Instant

/** 只从有合法访问时间的真实资源中选择续接项；更新时间不能冒充访问记录。 */
internal fun selectCloudDriveResumeItem(
    resources: List<CloudDriveResourceRow>,
): CloudDriveResourceRow? = resources
    .mapNotNull { resource ->
        if (resource.normalizedType !in RESUMABLE_RESOURCE_TYPES) return@mapNotNull null
        if (resource.canView == false) return@mapNotNull null
        val visitedAt = resource.lastVisitedAt?.let { raw ->
            runCatching { Instant.parse(raw) }.getOrNull()
        } ?: return@mapNotNull null
        resource to visitedAt
    }
    .maxByOrNull { (_, visitedAt) -> visitedAt }
    ?.first

/** 云盘根首页上下文，用于控制上传、新建等首页动作。 */
internal fun isCloudDriveLandingContext(
    scope: CloudDriveBrowseScope,
    searchQuery: String,
    currentCollectionId: String,
): Boolean = scope == CloudDriveBrowseScope.ALL &&
    searchQuery.isBlank() &&
    currentCollectionId == CloudDriveContracts.ROOT_COLLECTION_ID

/** 首页快捷动作在全部与最近范围保持可见；共享、搜索和目录内仍隐藏。 */
internal fun isCloudDriveQuickActionContext(
    scope: CloudDriveBrowseScope,
    searchQuery: String,
    currentCollectionId: String,
): Boolean = scope in QUICK_ACTION_SCOPES &&
    searchQuery.isBlank() &&
    currentCollectionId == CloudDriveContracts.ROOT_COLLECTION_ID

/** 续接 hero 在全部与最近范围展示，但不能打断搜索、共享或目录浏览。 */
internal fun isCloudDriveResumeHeroContext(
    scope: CloudDriveBrowseScope,
    searchQuery: String,
    currentCollectionId: String,
): Boolean = scope in RESUME_HERO_SCOPES &&
    searchQuery.isBlank() &&
    currentCollectionId == CloudDriveContracts.ROOT_COLLECTION_ID

private val RESUMABLE_RESOURCE_TYPES = setOf("tabdoc", "tabdata", "tabfiles")
private val QUICK_ACTION_SCOPES = setOf(CloudDriveBrowseScope.ALL, CloudDriveBrowseScope.RECENT)
private val RESUME_HERO_SCOPES = setOf(CloudDriveBrowseScope.ALL, CloudDriveBrowseScope.RECENT)
