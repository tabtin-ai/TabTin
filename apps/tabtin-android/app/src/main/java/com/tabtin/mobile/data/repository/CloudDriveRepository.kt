package com.tabtin.mobile.data.repository

import android.net.Uri
import android.util.Log
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.api.TabDataApi
import com.tabtin.mobile.data.api.TabFilesApi
import com.tabtin.mobile.data.api.UploadScope
import com.tabtin.mobile.data.model.SearchUserItem
import com.tabtin.mobile.data.model.doc.DocDetailResponse
import com.tabtin.mobile.data.model.files.CloudDriveBrowseScope
import com.tabtin.mobile.data.model.files.CloudDriveCollection
import com.tabtin.mobile.data.model.files.CloudDriveCollectionCreateRequest
import com.tabtin.mobile.data.model.files.CloudDriveContracts
import com.tabtin.mobile.data.model.files.CloudDriveFileMountRequest
import com.tabtin.mobile.data.model.files.CloudDriveFolderPage
import com.tabtin.mobile.data.model.files.CloudDriveMountPendingException
import com.tabtin.mobile.data.model.files.CloudDriveMoveItemsRequest
import com.tabtin.mobile.data.model.files.CloudDrivePendingMountTask
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.data.model.files.CloudDriveSharedPage
import com.tabtin.mobile.data.model.files.CloudDriveTypeFilter
import com.tabtin.mobile.data.model.files.CloudDriveUploadPhase
import com.tabtin.mobile.data.model.files.CloudFileDownloadUrlResponse
import com.tabtin.mobile.data.model.files.CreateTableRequest
import com.tabtin.mobile.data.model.files.CreateTableResponse
import com.tabtin.mobile.data.model.files.TabFilesCollaboratorsResponse
import com.tabtin.mobile.data.model.files.TabFilesInviteCollaboratorsRequest
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

@Singleton
public class CloudDriveRepository @Inject constructor(
    private val contextApi: ContextApi,
    private val tabFilesApi: TabFilesApi,
    private val tabDataApi: TabDataApi,
    private val docRepository: DocRepository,
    private val ossUploadService: OSSUploadService,
    private val pendingMountStore: CloudDrivePendingMountStore,
) {
    public suspend fun listCollections(organizationId: String): List<CloudDriveCollection> {
        return contextApi.getOrganizationCollections(organizationId).unwrap().collections
    }

    public suspend fun listFolderPage(
        organizationId: String,
        collectionId: String = CloudDriveContracts.ROOT_COLLECTION_ID,
        typeFilter: CloudDriveTypeFilter = CloudDriveTypeFilter.ALL,
        page: Int = 1,
        pageSize: Int = CloudDriveContracts.DEFAULT_PAGE_SIZE,
        childFolders: List<CloudDriveCollection> = emptyList(),
    ): CloudDriveFolderPage {
        val response = contextApi.getOrganizationContextItems(
            organizationId = organizationId,
            isArchived = "false",
            page = page,
            pageSize = pageSize,
            itemTypes = typeFilter.toItemTypesParam(),
            collectionId = collectionId,
        ).unwrap()
        val resources = response.items.map { CloudDriveResourceRow.fromSpaceResource(it) }
        val total = response.total ?: resources.size
        val resolvedPageSize = response.pageSize?.takeIf { it > 0 } ?: pageSize
        val hasMore = resources.size >= resolvedPageSize &&
            (response.total == null || page * resolvedPageSize < total)
        return CloudDriveFolderPage(
            folders = if (page == 1) childFolders else emptyList(),
            resources = resources,
            total = total,
            page = response.page ?: page,
            pageSize = resolvedPageSize,
            hasMore = hasMore,
        )
    }

    public suspend fun listRecentPage(
        organizationId: String,
        typeFilter: CloudDriveTypeFilter = CloudDriveTypeFilter.ALL,
        page: Int = 1,
        pageSize: Int = CloudDriveContracts.DEFAULT_PAGE_SIZE,
    ): CloudDriveFolderPage {
        val response = contextApi.getOrganizationContextItems(
            organizationId = organizationId,
            isArchived = "false",
            page = page,
            pageSize = pageSize,
            itemTypes = typeFilter.toItemTypesParam(),
            visitedOnly = "true",
            sort = CloudDriveContracts.RECENT_SORT,
        ).unwrap()
        val resources = response.items.map { CloudDriveResourceRow.fromSpaceResource(it) }
        val total = response.total ?: resources.size
        val resolvedPageSize = response.pageSize?.takeIf { it > 0 } ?: pageSize
        val hasMore = resources.size >= resolvedPageSize &&
            (response.total == null || page * resolvedPageSize < total)
        return CloudDriveFolderPage(
            folders = emptyList(),
            resources = resources,
            total = total,
            page = response.page ?: page,
            pageSize = resolvedPageSize,
            hasMore = hasMore,
        )
    }

    public suspend fun listSharedFeedPage(
        organizationId: String,
        typeFilter: CloudDriveTypeFilter = CloudDriveTypeFilter.ALL,
        cursor: String? = null,
        limit: Int = CloudDriveContracts.SHARED_FEED_LIMIT,
    ): CloudDriveSharedPage {
        val response = contextApi.getCloudDriveSharedFeed(
            organizationId = organizationId,
            itemTypes = typeFilter.toItemTypesParam(),
            cursor = cursor,
            limit = limit,
        ).unwrap()
        return CloudDriveSharedPage(
            resources = response.items.map(CloudDriveResourceRow::fromSharedFeedItem),
            nextCursor = response.nextCursor,
            hasMore = !response.nextCursor.isNullOrBlank(),
        )
    }

    public suspend fun search(
        organizationId: String,
        query: String,
        typeFilter: CloudDriveTypeFilter = CloudDriveTypeFilter.ALL,
        page: Int = 1,
        pageSize: Int = CloudDriveContracts.SEARCH_PAGE_SIZE,
        collections: List<CloudDriveCollection> = emptyList(),
    ): CloudDriveFolderPage {
        val response = contextApi.searchOrganizationCloudDrive(
            organizationId = organizationId,
            query = query,
            types = typeFilter.toItemTypesParam(),
            page = page,
            pageSize = pageSize,
        ).unwrap()
        val resources = response.items.map {
            CloudDriveResourceRow.fromSpaceResource(
                resource = it,
                locationLabel = resolveSearchLocationLabel(collections, it.collectionId),
            )
        }
        val total = response.total
        val resolvedPageSize = response.pageSize.takeIf { it > 0 } ?: pageSize
        val hasMore = resources.size >= resolvedPageSize && page * resolvedPageSize < total
        return CloudDriveFolderPage(
            folders = emptyList(),
            resources = resources,
            total = total,
            page = response.page,
            pageSize = resolvedPageSize,
            hasMore = hasMore,
        )
    }

    /**
     * 搜索结果位置列：本人文件夹树内 → 文件夹名；根 → 「根目录」；
     * collection 不在本人树（分享来源）→ 「分享给我」。
     */
    public fun resolveSearchLocationLabel(
        collections: List<CloudDriveCollection>,
        collectionId: String?,
    ): String {
        if (collectionId.isNullOrBlank() || collectionId == CloudDriveContracts.ROOT_COLLECTION_ID) {
            return CloudDriveContracts.LOCATION_ROOT
        }
        return findCollection(collections, collectionId)?.name
            ?: CloudDriveContracts.LOCATION_SHARED_WITH_ME
    }

    public suspend fun recordAccess(contextItemId: String) {
        contextApi.recordContextItemAccess(contextItemId).requireSuccess()
    }

    public suspend fun getPreviewUrl(
        organizationId: String,
        contextItemId: String,
        previewMaxBytes: Int = DEFAULT_PREVIEW_MAX_BYTES,
    ): CloudFileDownloadUrlResponse {
        return tabFilesApi.getDownloadUrl(
            organizationId = organizationId,
            contextItemId = contextItemId,
            previewMaxBytes = previewMaxBytes,
        ).unwrap()
    }

    public suspend fun getDownloadUrl(
        organizationId: String,
        contextItemId: String,
    ): CloudFileDownloadUrlResponse {
        return tabFilesApi.getDownloadUrl(
            organizationId = organizationId,
            contextItemId = contextItemId,
            previewMaxBytes = null,
        ).unwrap()
    }

    /** 本地乐观更新最近访问时间（ISO-8601 UTC）。 */
    public fun optimisticVisitedAtNow(): String = Instant.now().toString()

    public fun pendingMountCount(): Int = pendingMountStore.count()

    public fun listPendingMounts(): List<CloudDrivePendingMountTask> = pendingMountStore.list()

    public suspend fun createFolder(
        organizationId: String,
        name: String,
        parentCollectionId: String?,
    ): CloudDriveCollection {
        val parentId = parentCollectionId
            ?.takeIf { it.isNotBlank() && it != CloudDriveContracts.ROOT_COLLECTION_ID }
        return contextApi.createOrganizationCollection(
            organizationId = organizationId,
            body = CloudDriveCollectionCreateRequest(
                name = name.trim(),
                parentId = parentId,
            ),
        ).unwrap()
    }

    public suspend fun renameFolder(collectionId: String, name: String): CloudDriveCollection {
        val trimmed = name.trim()
        require(trimmed.isNotEmpty()) { "folder name required" }
        return contextApi.updateCollection(
            collectionId = collectionId,
            body = buildJsonObject { put("name", JsonPrimitive(trimmed)) },
        ).unwrap()
    }

    /**
     * 移动文件夹。目标为根时显式传 parent_id=null。
     */
    public suspend fun moveFolder(
        collectionId: String,
        parentCollectionId: String?,
    ): CloudDriveCollection {
        val parentId = parentCollectionId
            ?.takeIf { it.isNotBlank() && it != CloudDriveContracts.ROOT_COLLECTION_ID }
        val body = buildJsonObject {
            if (parentId == null) {
                put("parent_id", JsonNull)
            } else {
                put("parent_id", JsonPrimitive(parentId))
            }
        }
        return contextApi.updateCollection(collectionId = collectionId, body = body).unwrap()
    }

    public suspend fun deleteFolder(collectionId: String) {
        contextApi.deleteCollection(collectionId).unwrap()
    }

    /**
     * 移动单条资源（owner-only，由服务端 + 客户端 [CloudDriveResourceRow.canMove] 双重收口）。
     * [contextItemId] 不可用 FileRecordID 顶替。
     */
    public suspend fun moveResource(
        organizationId: String,
        contextItemId: String,
        targetCollectionId: String?,
        canMove: Boolean?,
    ): Int {
        if (canMove != true) {
            throw IllegalStateException("MOVE_DENIED")
        }
        val target = targetCollectionId
            ?.takeIf { it.isNotBlank() && it != CloudDriveContracts.ROOT_COLLECTION_ID }
        return contextApi.moveOrganizationCollectionItems(
            organizationId = organizationId,
            body = CloudDriveMoveItemsRequest(
                itemIds = listOf(contextItemId),
                collectionId = target,
            ),
        ).unwrap().updated
    }

    public suspend fun trashTabFile(
        organizationId: String,
        fileRecordId: String,
    ) {
        require(fileRecordId.isNotBlank()) { "fileRecordId required" }
        tabFilesApi.trashOrganizationFile(organizationId, fileRecordId).unwrap()
    }

    public suspend fun restoreTabFile(
        organizationId: String,
        fileRecordId: String,
    ): CloudDriveResourceRow {
        require(fileRecordId.isNotBlank()) { "fileRecordId required" }
        return CloudDriveResourceRow.fromSpaceResource(
            tabFilesApi.restoreOrganizationFile(organizationId, fileRecordId).unwrap(),
        )
    }

    public suspend fun permanentDeleteTabFile(
        organizationId: String,
        fileRecordId: String,
    ) {
        require(fileRecordId.isNotBlank()) { "fileRecordId required" }
        tabFilesApi.permanentDeleteOrganizationFile(organizationId, fileRecordId).unwrap()
    }

    public suspend fun listTabFileCollaborators(fileRecordId: String): TabFilesCollaboratorsResponse {
        require(fileRecordId.isNotBlank()) { "fileRecordId required" }
        return tabFilesApi.listFileCollaborators(fileRecordId).unwrap()
    }

    public suspend fun inviteTabFileCollaborators(
        fileRecordId: String,
        userIds: List<String>,
        permission: String = "viewer",
    ): TabFilesCollaboratorsResponse {
        require(fileRecordId.isNotBlank()) { "fileRecordId required" }
        return tabFilesApi.inviteFileCollaborators(
            fileRecordId = fileRecordId,
            body = TabFilesInviteCollaboratorsRequest(
                userIds = userIds.filter { it.isNotBlank() },
                permission = permission,
            ),
        ).unwrap()
    }

    public suspend fun revokeTabFileCollaborator(
        fileRecordId: String,
        userId: String,
    ) {
        require(fileRecordId.isNotBlank()) { "fileRecordId required" }
        require(userId.isNotBlank()) { "userId required" }
        tabFilesApi.revokeFileCollaborator(fileRecordId, userId).unwrap()
    }

    public suspend fun searchOrgUsers(
        organizationId: String,
        query: String,
    ): List<SearchUserItem> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        return contextApi.searchUsersForOrganization(organizationId, q).unwrap().users
    }

    public suspend fun createDocument(
        organizationId: String,
        title: String,
        collectionId: String?,
    ): DocDetailResponse {
        return docRepository.createDocument(
            title = title,
            collectionId = collectionId
                ?.takeIf { it.isNotBlank() && it != CloudDriveContracts.ROOT_COLLECTION_ID },
            organizationId = organizationId,
        )
    }

    public suspend fun createTable(
        organizationId: String,
        name: String,
        collectionId: String?,
    ): CreateTableResponse {
        return tabDataApi.createTable(
            CreateTableRequest(
                organizationId = organizationId,
                name = name,
                collectionId = collectionId
                    ?.takeIf { it.isNotBlank() && it != CloudDriveContracts.ROOT_COLLECTION_ID },
            ),
        ).unwrap()
    }

    /**
     * 系统文件 → OSS presign/PUT/confirm → Organization TabFiles mount。
     * confirm 成功但 mount 失败时写入 [pendingMountStore]，并抛
     * [CloudDriveMountPendingException]（不要求用户重选文件）。
     */
    public suspend fun uploadAndMount(
        organizationId: String,
        collectionId: String?,
        uri: Uri,
        fileName: String,
        contentType: String,
        fileSize: Long,
        onProgress: ((Float) -> Unit)? = null,
        onPhase: ((CloudDriveUploadPhase) -> Unit)? = null,
    ): CloudDriveResourceRow {
        val resolvedCollectionId = collectionId
            ?.takeIf { it.isNotBlank() && it != CloudDriveContracts.ROOT_COLLECTION_ID }
        onPhase?.invoke(CloudDriveUploadPhase.UPLOADING)
        val upload = ossUploadService.directUploadFromUri(
            uri = uri,
            fileSize = fileSize,
            fileName = fileName,
            contentType = contentType.ifBlank { "application/octet-stream" },
            folder = UPLOAD_FOLDER,
            scope = UploadScope(
                module = UPLOAD_MODULE,
                contextType = "organization",
                contextId = organizationId,
                organizationId = organizationId,
                isPublic = false,
            ),
            onProgress = onProgress,
        )
        onPhase?.invoke(CloudDriveUploadPhase.CONFIRMED)
        onPhase?.invoke(CloudDriveUploadPhase.MOUNTING)
        return mountConfirmedFile(
            organizationId = organizationId,
            fileRecordId = upload.fileId,
            collectionId = resolvedCollectionId,
            title = fileName,
        )
    }

    public suspend fun mountConfirmedFile(
        organizationId: String,
        fileRecordId: String,
        collectionId: String?,
        title: String?,
    ): CloudDriveResourceRow {
        return try {
            val item = tabFilesApi.mountFileToOrganization(
                organizationId = organizationId,
                body = CloudDriveFileMountRequest(
                    fileRecordId = fileRecordId,
                    collectionId = collectionId,
                    title = title,
                ),
            ).unwrap()
            pendingMountStore.remove(organizationId, fileRecordId)
            CloudDriveResourceRow.fromSpaceResource(item)
        } catch (error: CloudDriveMountPendingException) {
            throw error
        } catch (error: Exception) {
            pendingMountStore.upsert(
                CloudDrivePendingMountTask(
                    fileRecordId = fileRecordId,
                    organizationId = organizationId,
                    collectionId = collectionId,
                    title = title,
                    error = error.message,
                    createdAt = Instant.now().toString(),
                ),
            )
            runCatching {
                Log.w(TAG, "mount failed; persist pendingMount fileRecordId=$fileRecordId")
            }
            throw CloudDriveMountPendingException(
                fileRecordId = fileRecordId,
                organizationId = organizationId,
                cause = error,
            )
        }
    }

    /** 重试全部 pendingMount；成功项从队列移除。返回成功挂载数。 */
    public suspend fun retryPendingMounts(): Int {
        var success = 0
        for (task in pendingMountStore.list()) {
            runCatching {
                mountConfirmedFile(
                    organizationId = task.organizationId,
                    fileRecordId = task.fileRecordId,
                    collectionId = task.collectionId,
                    title = task.title,
                )
            }.onSuccess { success += 1 }
        }
        return success
    }

    public fun childFoldersOf(
        collections: List<CloudDriveCollection>,
        parentId: String?,
    ): List<CloudDriveCollection> {
        if (parentId == null || parentId == CloudDriveContracts.ROOT_COLLECTION_ID) {
            return collections.sortedWith(compareBy({ it.order }, { it.name.lowercase() }))
        }
        return findCollection(collections, parentId)
            ?.children
            ?.sortedWith(compareBy({ it.order }, { it.name.lowercase() }))
            ?: emptyList()
    }

    public fun findCollection(
        collections: List<CloudDriveCollection>,
        collectionId: String,
    ): CloudDriveCollection? {
        for (node in collections) {
            if (node.id == collectionId) return node
            findCollection(node.children, collectionId)?.let { return it }
        }
        return null
    }

    public fun breadcrumbPath(
        collections: List<CloudDriveCollection>,
        collectionId: String?,
    ): List<CloudDriveCollection> {
        if (collectionId.isNullOrBlank() || collectionId == CloudDriveContracts.ROOT_COLLECTION_ID) {
            return emptyList()
        }
        val path = mutableListOf<CloudDriveCollection>()
        fun walk(nodes: List<CloudDriveCollection>, trail: List<CloudDriveCollection>): Boolean {
            for (node in nodes) {
                val next = trail + node
                if (node.id == collectionId) {
                    path.clear()
                    path.addAll(next)
                    return true
                }
                if (walk(node.children, next)) return true
            }
            return false
        }
        walk(collections, emptyList())
        return path
    }

    public fun searchCollectionsLocally(
        collections: List<CloudDriveCollection>,
        query: String,
    ): List<CloudDriveCollection> {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return emptyList()
        val hits = mutableListOf<CloudDriveCollection>()
        fun walk(nodes: List<CloudDriveCollection>) {
            for (node in nodes) {
                if (node.name.lowercase().contains(needle)) hits += node
                walk(node.children)
            }
        }
        walk(collections)
        return hits
    }

    public fun resolveBrowseScope(scope: CloudDriveBrowseScope): CloudDriveBrowseScope = scope

    private companion object {
        const val TAG: String = "CloudDriveRepository"
        const val DEFAULT_PREVIEW_MAX_BYTES: Int = 5 * 1024 * 1024
        const val UPLOAD_FOLDER: String = "tabfiles/uploads"
        const val UPLOAD_MODULE: String = "tabfiles"
    }
}
