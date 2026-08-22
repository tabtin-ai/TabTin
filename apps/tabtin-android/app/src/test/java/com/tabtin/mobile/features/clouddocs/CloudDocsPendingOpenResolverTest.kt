package com.tabtin.mobile.features.clouddocs

import com.tabtin.mobile.data.model.SharedResourceItem
import com.tabtin.mobile.data.model.SharedResourceType
import com.tabtin.mobile.data.model.SpaceResource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudDocsPendingOpenResolverTest {

    @Test
    fun `only tabdoc and tabdata route through cloud docs tab`() {
        assertTrue(CloudDocsPendingOpenResolver.isCloudDocsType("tabdoc"))
        assertTrue(CloudDocsPendingOpenResolver.isCloudDocsType("document"))
        assertTrue(CloudDocsPendingOpenResolver.isCloudDocsType("tabdata"))
        assertTrue(CloudDocsPendingOpenResolver.isCloudDocsType("table"))
        assertFalse(CloudDocsPendingOpenResolver.isCloudDocsType("tabslide"))
        assertFalse(CloudDocsPendingOpenResolver.isCloudDocsType("tabsite"))
        assertFalse(CloudDocsPendingOpenResolver.isCloudDocsType("tabtracker"))
    }

    @Test
    fun `resolve prefers matched recent item metadata`() {
        val pending = CloudDocsPendingOpen(
            organizationId = "org-1",
            spaceId = "space-1",
            resourceType = "tabdoc",
            resourceId = "doc-1",
            title = "Deep link title",
        )
        val recent = SpaceResource(
            id = "item-1",
            itemType = "tabdoc",
            title = "Recent title",
            resourceId = "doc-1",
            spaceId = "space-1",
            organizationId = "org-1",
            spaceName = "Space A",
        )

        val result = CloudDocsPendingOpenResolver.resolve(pending, recentItems = listOf(recent))

        assertTrue(result is CloudDocsPendingOpenResult.Open)
        result as CloudDocsPendingOpenResult.Open
        assertEquals("item-1", result.resource.id)
        assertEquals("Recent title", result.resource.title)
        assertEquals("Space A", result.spaceName)
    }

    @Test
    fun `resolve falls back to shared item then synthesizes openable resource`() {
        val pending = CloudDocsPendingOpen(
            organizationId = "org-1",
            spaceId = "space-9",
            resourceType = "table",
            resourceId = "tbl-1",
            title = "Shared table",
            locationHint = "hint",
        )
        val shared = SharedResourceItem(
            resourceType = SharedResourceType.TABLE,
            resourceId = "tbl-1",
            title = "From share list",
            organizationId = "org-1",
            spaceId = "space-9",
            permission = "viewer",
            updatedAt = null,
            sharedBy = null,
        )

        val fromShared = CloudDocsPendingOpenResolver.resolve(
            pending,
            recentItems = emptyList(),
            sharedItems = listOf(shared),
        )
        assertTrue(fromShared is CloudDocsPendingOpenResult.Open)
        fromShared as CloudDocsPendingOpenResult.Open
        assertEquals("From share list", fromShared.resource.title)
        assertEquals("shared:table:tbl-1", fromShared.resource.id)

        val synthesized = CloudDocsPendingOpenResolver.resolve(
            pending,
            recentItems = emptyList(),
            sharedItems = emptyList(),
        )
        assertTrue(synthesized is CloudDocsPendingOpenResult.Open)
        synthesized as CloudDocsPendingOpenResult.Open
        assertEquals("tbl-1", synthesized.resource.resourceId)
        assertEquals("tabdata", synthesized.resource.normalizedType)
        assertEquals("hint", synthesized.spaceName)
    }

    @Test
    fun `unsupported types return explicit unsupported result`() {
        val pending = CloudDocsPendingOpen(
            organizationId = "org-1",
            spaceId = "space-1",
            resourceType = "tabslide",
            resourceId = "slide-1",
            locationHint = "deck",
        )
        val result = CloudDocsPendingOpenResolver.resolve(pending, recentItems = emptyList())
        assertTrue(result is CloudDocsPendingOpenResult.Unsupported)
        assertEquals("deck", (result as CloudDocsPendingOpenResult.Unsupported).locationHint)
    }
}
