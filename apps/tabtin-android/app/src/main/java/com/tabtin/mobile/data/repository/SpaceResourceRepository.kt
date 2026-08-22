package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.model.KnowledgeTreeChildrenResponse
import com.tabtin.mobile.data.model.KnowledgeTreeResponse
import com.tabtin.mobile.data.model.SpaceResource
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class SpaceResourceRepository @Inject constructor(
    private val contextApi: ContextApi,
) {
    public suspend fun getResources(spaceId: String): List<SpaceResource> {
        // 云端资源已改为 Organization 所有；以当前 Project/Workspace 作为排序锚点，
        // 既保留当前上下文的资源优先级，也能展示没有 Space 宿主的资源。
        val response = contextApi.getContextItems(spaceId, scope = "organization")
        return response.unwrap().items.sortedByDescending { it.updatedAt ?: it.createdAt ?: "" }
    }

    /**
     * 云端页以 Organization 为边界聚合资源。服务端单页上限为 100，完整拉取以免
     * 新创建的资源因排在第二页以后而继续从移动端消失。
     */
    public suspend fun getOrganizationResources(organizationId: String): List<SpaceResource> {
        val resources = mutableListOf<SpaceResource>()
        var page = 1

        while (true) {
            val response = contextApi.getOrganizationContextItems(
                organizationId = organizationId,
                page = page,
                pageSize = ORGANIZATION_RESOURCE_PAGE_SIZE,
            ).unwrap()
            resources += response.items

            val total = response.total
            val currentPageSize = response.pageSize
                ?.takeIf { it > 0 }
                ?: ORGANIZATION_RESOURCE_PAGE_SIZE
            val hasNextPage = response.items.size >= currentPageSize &&
                (total == null || resources.size < total)
            if (!hasNextPage) break
            page += 1
        }

        return resources.sortedByDescending { it.updatedAt ?: it.createdAt ?: "" }
    }

    /**
     * 「最近」分段用的组织级 context-items 单页。
     *
     * 与 iOS `recentPageSize = 100` 对齐：组织级接口把 page_size clamp 到 100，
     * 只拉第 1 页即可；完整分页仍走 [getOrganizationResources]。
     */
    public suspend fun getRecentOrganizationResources(
        organizationId: String,
        pageSize: Int = RECENT_PAGE_SIZE,
    ): List<SpaceResource> {
        return contextApi.getOrganizationContextItems(
            organizationId = organizationId,
            page = 1,
            pageSize = pageSize,
        ).unwrap().items
    }

    public suspend fun getKnowledgeTree(
        organizationId: String,
        itemTypes: String = "tabdoc,tabdata",
        depth: Int = 2,
    ): KnowledgeTreeResponse {
        return contextApi.getOrganizationKnowledgeTree(
            organizationId = organizationId,
            itemTypes = itemTypes,
            depth = depth,
        ).unwrap()
    }

    public suspend fun getKnowledgeTreeChildren(
        organizationId: String,
        nodeId: String,
        nodeType: String,
        itemTypes: String = "tabdoc,tabdata",
    ): KnowledgeTreeChildrenResponse {
        return contextApi.getOrganizationKnowledgeTreeChildren(
            organizationId = organizationId,
            nodeId = nodeId,
            nodeType = nodeType,
            itemTypes = itemTypes,
        ).unwrap()
    }

    public suspend fun recordAccess(itemId: String) {
        contextApi.recordContextItemAccess(itemId).requireSuccess()
    }

    public suspend fun togglePin(itemId: String, pinned: Boolean) {
        val body = JsonObject(mapOf("is_pinned" to JsonPrimitive(pinned)))
        contextApi.patchContextItem(itemId, body)
    }

    public suspend fun deleteContextItem(itemId: String) {
        contextApi.deleteContextItem(itemId).requireSuccess()
    }

    private companion object {
        const val ORGANIZATION_RESOURCE_PAGE_SIZE = 100
        const val RECENT_PAGE_SIZE = 100
    }
}
