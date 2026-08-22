package com.tabtin.mobile.data.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SharedResourceWireContractTest {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        isLenient = true
    }

    @Test
    fun `decodes shared doc row into synthetic shared id`() {
        val row = json.decodeFromString<SharedDocRow>(
            """
            {
              "resource_type": "doc",
              "document_id": "doc-9",
              "title": "客户案例库",
              "icon": "",
              "organization_id": "org-1",
              "space_id": "ws-2",
              "permission": "editor",
              "updated_at": "2026-07-25T08:00:00+00:00",
              "shared_by": { "id": "u-1", "display_name": "李工", "avatar": "" }
            }
            """.trimIndent(),
        )
        val item = row.asSharedResourceItem()
        assertEquals("shared:doc:doc-9", item.id)
        assertEquals(SharedResourceType.DOC, item.resourceType)
        assertEquals("客户案例库", item.title)
        assertEquals("李工", item.sharedBy?.displayName)
        assertEquals("ws-2", item.spaceId)
    }

    @Test
    fun `decodes shared table row and normalizes blank space id to null`() {
        val row = json.decodeFromString<SharedTableRow>(
            """
            {
              "resource_type": "table",
              "table_id": "table-9",
              "title": "竞品功能对照表",
              "icon": "",
              "organization_id": "org-1",
              "space_id": "",
              "permission": "viewer",
              "updated_at": null,
              "shared_by": null
            }
            """.trimIndent(),
        )
        val item = row.asSharedResourceItem()
        assertEquals("shared:table:table-9", item.id)
        assertEquals(SharedResourceType.TABLE, item.resourceType)
        assertNull(item.sharedBy)
        assertNull(item.spaceId)
    }

    @Test
    fun `null organization id does not drop the whole batch`() {
        val tables = json.decodeFromString<SharedTablesResponse>(
            """
            {
              "tables": [
                { "table_id": "t-1", "title": "组织外表格", "organization_id": null, "permission": null },
                { "table_id": "t-2", "title": "正常表格", "organization_id": "org-1", "permission": "viewer" }
              ]
            }
            """.trimIndent(),
        )
        assertEquals(listOf("t-1", "t-2"), tables.tables?.map { it.tableId })
        assertEquals("", tables.tables?.first()?.asSharedResourceItem()?.organizationId)
        assertEquals("", tables.tables?.first()?.asSharedResourceItem()?.permission)

        val docs = json.decodeFromString<SharedDocsResponse>(
            """{ "documents": [{ "document_id": "d-1", "title": "缺字段文档" }] }""",
        )
        assertEquals("", docs.documents?.first()?.asSharedResourceItem()?.organizationId)
        assertEquals("", docs.documents?.first()?.asSharedResourceItem()?.permission)
    }

    @Test
    fun `whitespace only space id normalizes to null`() {
        assertNull(SharedResourceNormalizer.normalizedId("   "))
        assertNull(SharedResourceNormalizer.normalizedId(null))
        assertEquals("ws-2", SharedResourceNormalizer.normalizedId(" ws-2 "))
    }
}
