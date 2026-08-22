package com.tabtin.mobile.data.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 钉住 SpaceResource 与 iOS / 后端 wire 口径：
 * owner 子字段全可选、canShare 三态、lastVisitedAt 可选。
 */
class SpaceResourceWireContractTest {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        isLenient = true
    }

    @Test
    fun `owner decodes leniently and skips blank names`() {
        val items = json.decodeFromString<SpaceResourceListResponse>(
            """
            {
              "items": [
                {
                  "id": "item-1", "item_type": "tabdoc", "title": "有所有者",
                  "resource_id": "doc-1", "organization_id": "org-1",
                  "owner": { "id": "u1", "display_name": "李雷", "avatar": null }
                },
                {
                  "id": "item-2", "item_type": "tabdoc", "title": "owner 为 null",
                  "resource_id": "doc-2", "organization_id": "org-1",
                  "owner": null
                },
                {
                  "id": "item-3", "item_type": "tabdoc", "title": "owner 缺字段",
                  "resource_id": "doc-3", "organization_id": "org-1",
                  "owner": { "id": "u3", "display_name": null }
                },
                {
                  "id": "item-4", "item_type": "tabdoc", "title": "名字是空白",
                  "resource_id": "doc-4", "organization_id": "org-1",
                  "owner": { "id": "u4", "display_name": "   " }
                }
              ]
            }
            """.trimIndent(),
        ).items

        assertEquals(4, items.size)
        assertEquals("李雷", items[0].owner?.presentableName)
        assertNull(items[1].owner)
        assertNull(items[2].owner?.presentableName)
        assertNull(items[3].owner?.presentableName)
    }

    @Test
    fun `canShare keeps missing distinct from false`() {
        val items = json.decodeFromString<SpaceResourceListResponse>(
            """
            {
              "items": [
                {
                  "id": "i1", "item_type": "tabdoc", "title": "可分享",
                  "resource_id": "d1", "organization_id": "org-1", "can_share": true
                },
                {
                  "id": "i2", "item_type": "tabdoc", "title": "明确不可分享",
                  "resource_id": "d2", "organization_id": "org-1", "can_share": false
                },
                {
                  "id": "i3", "item_type": "tabdoc", "title": "接口没吐这一位",
                  "resource_id": "d3", "organization_id": "org-1"
                }
              ]
            }
            """.trimIndent(),
        ).items

        assertTrue(items[0].canShare == true)
        assertFalse(items[1].canShare == true)
        assertEquals(false, items[1].canShare)
        assertNull(items[2].canShare)
    }

    @Test
    fun `lastVisitedAt decodes when present and stays null when missing`() {
        val items = json.decodeFromString<SpaceResourceListResponse>(
            """
            {
              "items": [
                {
                  "id": "i1", "item_type": "tabdoc", "title": "最近看过",
                  "resource_id": "d1", "organization_id": "org-1",
                  "last_visited_at": "2026-07-30T09:15:00+00:00"
                },
                {
                  "id": "i2", "item_type": "tabdoc", "title": "没访问过",
                  "resource_id": "d2", "organization_id": "org-1"
                }
              ]
            }
            """.trimIndent(),
        ).items

        assertEquals("2026-07-30T09:15:00+00:00", items[0].lastVisitedAt)
        assertNull(items[1].lastVisitedAt)
    }

    @Test
    fun `collection and capabilities decode with explicit context vs file ids`() {
        val item = json.decodeFromString<SpaceResourceListResponse>(
            """
            {
              "items": [
                {
                  "id": "ci-1",
                  "item_type": "tabfiles",
                  "title": "brief.pdf",
                  "resource_id": "fr-1",
                  "organization_id": "org-1",
                  "collection_id": "col-1",
                  "can_view": true,
                  "can_edit": false,
                  "can_move": false,
                  "can_share": true,
                  "can_trash": false,
                  "can_delete": false
                }
              ]
            }
            """.trimIndent(),
        ).items.single()

        assertEquals("ci-1", item.contextItemId)
        assertEquals("fr-1", item.fileRecordId)
        assertEquals("col-1", item.collectionId)
        assertEquals(true, item.canView)
        assertEquals(false, item.canEdit)
        assertEquals(false, item.canMove)
        assertEquals(true, item.canShare)
        assertEquals(false, item.canTrash)
        assertEquals(false, item.canDelete)
    }
}
