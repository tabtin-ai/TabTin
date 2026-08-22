package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.KnowledgeTreeChildrenResponse
import com.tabtin.mobile.data.model.KnowledgeTreeNode
import com.tabtin.mobile.data.model.KnowledgeTreeNodeType
import com.tabtin.mobile.data.model.KnowledgeTreeResponse
import com.tabtin.mobile.data.model.KnowledgeTreeStats
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.SpaceResourceListResponse
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class SpaceResourceRepositoryTest {

    @Test
    fun `space workbench resources include organization-owned cloud resources`() = runTest {
        val api = mockk<ContextApi>()
        coEvery { api.getContextItems("space-1", "false", 200, "organization") } returns response(
            items = listOf(resource("1")),
            total = 1,
            page = 1,
        )
        val repository = SpaceResourceRepository(api)

        val resources = repository.getResources("space-1")

        assertEquals(listOf("item-1"), resources.map { it.id })
        coVerify(exactly = 1) { api.getContextItems("space-1", "false", 200, "organization") }
    }

    @Test
    fun `organization resources follow the server page size until the full list is loaded`() = runTest {
        val api = mockk<ContextApi>()
        val requestedPages = mutableListOf<Int>()
        coEvery {
            api.getOrganizationContextItems(
                organizationId = any(),
                isArchived = any(),
                page = any(),
                pageSize = any(),
                itemTypes = any(),
                collectionId = any(),
                visitedOnly = any(),
                sort = any(),
            )
        } coAnswers {
            val page = args[2] as Int
            requestedPages += page
            when (page) {
                1 -> response(items = listOf(resource("1"), resource("2")), total = 3, page = 1)
                2 -> response(items = listOf(resource("3")), total = 3, page = 2)
                else -> error("unexpected page $page")
            }
        }
        val repository = SpaceResourceRepository(api)

        val resources = repository.getOrganizationResources("org-1")

        assertEquals(listOf(1, 2), requestedPages)
        assertEquals(setOf("item-1", "item-2", "item-3"), resources.map { it.id }.toSet())
    }

    @Test
    fun `getRecentOrganizationResources returns first page only`() = runTest {
        val api = mockk<ContextApi>()
        coEvery {
            api.getOrganizationContextItems(
                organizationId = "org-1",
                isArchived = "false",
                page = 1,
                pageSize = 100,
                itemTypes = null,
                collectionId = null,
                visitedOnly = null,
                sort = null,
            )
        } returns response(
            items = listOf(resource("1")),
            total = 1,
            page = 1,
        )
        val repository = SpaceResourceRepository(api)

        val resources = repository.getRecentOrganizationResources("org-1")

        assertEquals(listOf("item-1"), resources.map { it.id })
        coVerify(exactly = 1) {
            api.getOrganizationContextItems(
                organizationId = "org-1",
                isArchived = "false",
                page = 1,
                pageSize = 100,
                itemTypes = null,
                collectionId = null,
                visitedOnly = null,
                sort = null,
            )
        }
    }

    @Test
    fun `getKnowledgeTree unwraps organization tree response`() = runTest {
        val api = mockk<ContextApi>()
        val tree = KnowledgeTreeResponse(
            organizationId = "org-1",
            roots = listOf(
                KnowledgeTreeNode(
                    id = "n1",
                    nodeType = KnowledgeTreeNodeType.TABDOC,
                    resourceId = "doc-1",
                    title = "根文档",
                ),
            ),
            stats = KnowledgeTreeStats(docCount = 1),
        )
        coEvery {
            api.getOrganizationKnowledgeTree("org-1", "tabdoc,tabdata", 2)
        } returns ApiEnvelope(success = true, data = tree)
        val repository = SpaceResourceRepository(api)

        val result = repository.getKnowledgeTree("org-1")

        assertEquals("org-1", result.organizationId)
        assertEquals(listOf("n1"), result.roots.map { it.id })
        coVerify(exactly = 1) { api.getOrganizationKnowledgeTree("org-1", "tabdoc,tabdata", 2) }
    }

    @Test
    fun `getKnowledgeTreeChildren forwards node type`() = runTest {
        val api = mockk<ContextApi>()
        val children = KnowledgeTreeChildrenResponse(
            nodeId = "n1",
            nodeType = KnowledgeTreeNodeType.TABDOC,
            children = listOf(
                KnowledgeTreeNode(
                    id = "n2",
                    nodeType = KnowledgeTreeNodeType.TABDATA,
                    resourceId = "t-1",
                    title = "子表",
                ),
            ),
        )
        coEvery {
            api.getOrganizationKnowledgeTreeChildren("org-1", "n1", "tabdoc", "tabdoc,tabdata")
        } returns ApiEnvelope(success = true, data = children)
        val repository = SpaceResourceRepository(api)

        val result = repository.getKnowledgeTreeChildren("org-1", "n1", "tabdoc")

        assertEquals(listOf("n2"), result.children.map { it.id })
        coVerify(exactly = 1) {
            api.getOrganizationKnowledgeTreeChildren("org-1", "n1", "tabdoc", "tabdoc,tabdata")
        }
    }

    @Test
    fun `recordAccess and deleteContextItem call matching endpoints`() = runTest {
        val api = mockk<ContextApi>()
        coEvery { api.recordContextItemAccess("item-1") } returns ApiEnvelope(success = true, data = JsonObject(emptyMap()))
        coEvery { api.deleteContextItem("item-1") } returns ApiEnvelope(success = true, data = JsonObject(emptyMap()))
        val repository = SpaceResourceRepository(api)

        repository.recordAccess("item-1")
        repository.deleteContextItem("item-1")

        coVerify(exactly = 1) { api.recordContextItemAccess("item-1") }
        coVerify(exactly = 1) { api.deleteContextItem("item-1") }
    }

    private fun response(
        items: List<SpaceResource>,
        total: Int,
        page: Int,
    ): ApiEnvelope<SpaceResourceListResponse> = ApiEnvelope(
        success = true,
        data = SpaceResourceListResponse(
            items = items,
            total = total,
            page = page,
            pageSize = 2,
        ),
    )

    private fun resource(id: String): SpaceResource = SpaceResource(
        id = "item-$id",
        itemType = "tabdoc",
        title = "Document $id",
        resourceId = "doc-$id",
        organizationId = "org-1",
    )
}
