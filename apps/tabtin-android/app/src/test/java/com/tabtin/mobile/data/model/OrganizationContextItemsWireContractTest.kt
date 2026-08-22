package com.tabtin.mobile.data.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OrganizationContextItemsWireContractTest {

    @Test
    fun `organization avatar uses settings logo and ignores legacy emoji icon`() {
        val organization = Json.decodeFromString<Organization>(
            """
            {
              "id": "org-1",
              "name": "TabTin",
              "icon": "🏢",
              "settings": {"logo_url": "https://cdn.example.com/org.png"}
            }
            """.trimIndent(),
        )

        assertEquals("https://cdn.example.com/org.png", organization.logoUrl)
        assertTrue(organization.hasCustomLogo)
    }

    @Test
    fun `organization default avatar uses first character instead of user initials`() {
        val organization = Organization(id = "org-1", name = "天工团队")

        assertEquals("天", organization.avatarFallbackText)
    }

    @Test
    fun `organization context items decode an organization-only resource`() {
        val response = Json.decodeFromString<SpaceResourceListResponse>(
            """
            {
              "items": [{
                "id": "item-1",
                "item_type": "tabdoc",
                "title": "云端文档",
                "resource_id": "doc-1",
                "space_id": null,
                "organization_id": "org-1",
                "is_archived": false,
                "is_pinned": false
              }],
              "total": 1,
              "page": 1,
              "page_size": 100
            }
            """.trimIndent(),
        )

        assertEquals(1, response.total)
        assertEquals(1, response.page)
        assertEquals(100, response.pageSize)
        assertNull(response.items.single().spaceId)
        assertEquals("org-1", response.items.single().organizationId)
    }
}
