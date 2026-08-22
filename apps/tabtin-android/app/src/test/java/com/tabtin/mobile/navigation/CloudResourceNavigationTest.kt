package com.tabtin.mobile.navigation

import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.workbench.WorkbenchAppHomeKind
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudResourceNavigationTest {

    @Test
    fun `documents and tables open natively while slides keep full web editor`() {
        val document = resolveCloudResourceDestination(
            organizationId = "org-1",
            resource = resource("tabdoc"),
            spaceName = "Workspace A",
        )

        assertTrue(document is NativeCloudResourceRoute)
        document as NativeCloudResourceRoute
        assertEquals("tabdoc", document.resourceType)
        assertEquals("resource-tabdoc", document.resourceId)
        assertEquals("org-1", document.organizationId)
        assertEquals("space-1", document.spaceId)
        assertEquals("Resource tabdoc", document.title)

        val table = resolveCloudResourceDestination(
            organizationId = "org-1",
            resource = resource("tabdata"),
            spaceName = "Workspace A",
        )
        assertTrue(table is NativeCloudResourceRoute)
        table as NativeCloudResourceRoute
        assertEquals("tabdata", table.resourceType)
        assertEquals("resource-tabdata", table.resourceId)

        listOf("tabslide").forEach { type ->
            val destination = resolveCloudResourceDestination(
                organizationId = "org-1",
                resource = resource(type),
                spaceName = "Workspace A",
            )

            assertTrue(destination is CloudWebResourceRoute)
            destination as CloudWebResourceRoute
            assertEquals(type, destination.resourceType)
            assertEquals("org-1", destination.organizationId)
            assertEquals("space-1", destination.spaceId)
        }
    }

    @Test
    fun `organization-only native documents keep their missing Space context`() {
        val destination = resolveCloudResourceDestination(
            organizationId = "org-1",
            resource = resource(type = "tabdoc", spaceId = null),
            spaceName = null,
        )

        assertTrue(destination is NativeCloudResourceRoute)
        destination as NativeCloudResourceRoute
        assertEquals("org-1", destination.organizationId)
        assertNull(destination.spaceId)
    }

    @Test
    fun `site stays on dedicated preview - memo uses workbench - files with id keep CloudFileRoute`() {
        val site = resolveCloudResourceDestination(
            organizationId = "org-1",
            resource = resource(
                type = "tabsite",
                metadata = buildJsonObject {
                    put("url", "https://example.test/site")
                    put("status", "published")
                },
            ),
            spaceName = "Workspace A",
        )
        assertTrue(site is CloudSiteDestination)
        assertEquals("https://example.test/site", (site as CloudSiteDestination).route.siteUrl)

        val memo = resolveCloudResourceDestination(
            organizationId = "org-1",
            resource = resource("tabmemo"),
            spaceName = "Workspace A",
        )
        assertTrue(memo is CloudWorkbenchOpenDestination)
        memo as CloudWorkbenchOpenDestination
        assertEquals("org-1", memo.organizationId)
        assertEquals("space-1", memo.spaceId)
        assertEquals("tabmemo", memo.request.normalizedType)
        assertEquals("resource-tabmemo", memo.request.resourceId)

        val file = resolveCloudResourceDestination(
            organizationId = "org-1",
            resource = resource(
                type = "tabfiles",
                metadata = buildJsonObject {
                    put("file_name", "brief.pdf")
                    put("mime_type", "application/pdf")
                    put("size_bytes", 42L)
                    put("download_url", "https://example.test/brief.pdf")
                },
            ),
            spaceName = "Workspace A",
        )
        assertTrue(
            "tabfiles with resourceId must keep CloudFileRoute (signed-url detail)",
            file is CloudFileRoute,
        )
        file as CloudFileRoute
        assertEquals("item-tabfiles", file.contextItemId)
        assertEquals("org-1", file.organizationId)
        assertEquals("resource-tabfiles", file.resourceId)
        assertEquals("brief.pdf", file.fileName)
        assertNull(file.fileUrl)
        assertEquals("space-1", file.spaceId)
        assertEquals("Workspace A", file.spaceName)
    }

    @Test
    fun `empty-id tabfiles may enter workbench App Home placeholder`() {
        val destination = resolveCloudResourceDestination(
            organizationId = "org-1",
            resource = resource(type = "tabfiles", resourceId = ""),
            spaceName = "Workspace A",
        )
        assertTrue(destination is CloudWorkbenchOpenDestination)
        destination as CloudWorkbenchOpenDestination
        assertEquals("tabfiles", destination.request.normalizedType)
        assertEquals("", destination.request.resourceId)
        assertEquals(
            WorkbenchAppHomeKind.TABFILES,
            WorkbenchAppHomeKind.fromAppId(destination.request.normalizedType),
        )
    }

    @Test
    fun `unsupported resources remain in cloud list`() {
        assertNull(
            resolveCloudResourceDestination(
                organizationId = "org-1",
                resource = resource("tabtracker"),
                spaceName = "Workspace A",
            ),
        )
    }

    @Test
    fun `legacy resource aliases use the same root detail routes`() {
        mapOf(
            "document" to NativeCloudResourceRoute::class,
            "table" to NativeCloudResourceRoute::class,
            "ppt" to CloudWebResourceRoute::class,
            "site" to CloudSiteDestination::class,
            "memo" to CloudWorkbenchOpenDestination::class,
            "file" to CloudFileRoute::class,
        ).forEach { (type, expectedClass) ->
            val destination = resolveCloudResourceDestination(
                organizationId = "org-1",
                resource = resource(type),
                spaceName = "Workspace A",
            )

            assertEquals(expectedClass, destination?.let { it::class })
        }
    }

    @Test
    fun `native cloud route policy covers aliases and rejects full mode types`() {
        listOf("tabdoc", "document", "doc", "tabdata", "table").forEach { type ->
            val route = nativeCloudResourceRoute(type, "resource-1", "org-1", null, "Title")
            assertTrue("$type should use native host", route is NativeCloudResourceRoute)
        }
        assertNull(nativeCloudResourceRoute("tabslide", "slide-1", "org-1", null, "Slides"))
        assertNull(nativeCloudResourceRoute("tabdata", "", "org-1", null, "Table"))
    }

    private fun resource(
        type: String,
        metadata: kotlinx.serialization.json.JsonObject? = null,
        spaceId: String? = "space-1",
        resourceId: String? = null,
    ): SpaceResource = SpaceResource(
        id = "item-$type",
        itemType = type,
        title = "Resource $type",
        resourceId = resourceId ?: "resource-$type",
        spaceId = spaceId,
        metadata = metadata,
    )
}
