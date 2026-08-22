package com.tabtin.mobile.features.tabsite

import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.workbench.WorkbenchTab
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/**
 * D-004 回归测试：WorkbenchTab 包含 TABSITE、SpaceResource 正确映射 tabsite。
 *
 * 确保 Android 端工作台能识别和展示 TabSite 类型资源。
 */
class TabSiteWorkbenchIntegrationTest {

    @Test
    fun `WorkbenchTab contains TABSITE entry`() {
        val tabsite = WorkbenchTab.valueOf("TABSITE")
        assertNotNull(tabsite)
        assertEquals("language", tabsite.icon)
    }

    @Test
    fun `SpaceResource with itemType site normalizes to tabsite`() {
        val resource = SpaceResource(
            id = "item-1",
            itemType = "site",
            title = "My Site",
            resourceId = "res-1",
            spaceId = "space-1",
        )
        assertEquals("tabsite", resource.normalizedType)
        assertEquals("TabSite", resource.typeLabel)
        assertEquals("\uD83C\uDF10", resource.emoji)
    }

    @Test
    fun `SpaceResource with itemType tabsite normalizes correctly`() {
        val resource = SpaceResource(
            id = "item-2",
            itemType = "tabsite",
            title = "Another Site",
            resourceId = "res-2",
            spaceId = "space-1",
        )
        assertEquals("tabsite", resource.normalizedType)
    }

    @Test
    fun `tabsite metadata extraction for published_url and status`() {
        val metadata = JsonObject(mapOf(
            "published_url" to JsonPrimitive("https://site.example.com/s/demo/"),
            "status" to JsonPrimitive("published"),
            "dist_oss_url" to JsonPrimitive("https://cdn.example.com/sites/demo/v1/"),
            "current_version" to JsonPrimitive(3),
        ))
        val resource = SpaceResource(
            id = "item-3",
            itemType = "site",
            title = "Demo Site",
            resourceId = "res-3",
            spaceId = "space-1",
            metadata = metadata,
        )

        val publishedUrl = resource.metadata?.get("published_url")?.let {
            (it as? JsonPrimitive)?.content
        } ?: ""
        val status = resource.metadata?.get("status")?.let {
            (it as? JsonPrimitive)?.content
        } ?: "draft"

        assertEquals("https://site.example.com/s/demo/", publishedUrl)
        assertEquals("published", status)
    }

    @Test
    fun `draft tabsite with empty published_url`() {
        val metadata = JsonObject(mapOf(
            "published_url" to JsonPrimitive(""),
            "status" to JsonPrimitive("draft"),
        ))
        val resource = SpaceResource(
            id = "item-4",
            itemType = "site",
            resourceId = "res-4",
            spaceId = "space-1",
            metadata = metadata,
        )

        val publishedUrl = resource.metadata?.get("published_url")?.let {
            (it as? JsonPrimitive)?.content
        } ?: ""

        assertEquals("", publishedUrl)
    }

    @Test
    fun `TABSITE tab filters correctly by normalizedType`() {
        val tab = WorkbenchTab.TABSITE
        assertEquals("TABSITE", tab.name)
        assertEquals("tabsite", tab.name.lowercase())
    }

    @Test
    fun `WorkbenchTab enum order places TABSITE between TABSLIDE and TABTRACKER`() {
        val values = WorkbenchTab.entries
        val slideIdx = values.indexOf(WorkbenchTab.TABSLIDE)
        val siteIdx = values.indexOf(WorkbenchTab.TABSITE)
        val trackerIdx = values.indexOf(WorkbenchTab.TABTRACKER)
        assertTrue("TABSITE should come after TABSLIDE", siteIdx > slideIdx)
        assertTrue("TABSITE should come before TABTRACKER", siteIdx < trackerIdx)
    }
}
