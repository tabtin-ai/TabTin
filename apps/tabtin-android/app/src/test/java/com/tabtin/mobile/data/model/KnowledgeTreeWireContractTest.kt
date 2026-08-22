package com.tabtin.mobile.data.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class KnowledgeTreeWireContractTest {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        isLenient = true
    }

    private val treeJson = """
    {
      "organization_id": "org-1",
      "folder_scope": "none",
      "orphan_policy": "promote_to_root",
      "roots": [
        {
          "id": "n1",
          "node_type": "tabdoc",
          "resource_id": "doc-1",
          "context_item_id": "n1",
          "parent_node_id": null,
          "parent_node_type": null,
          "parent_id": null,
          "collection_id": null,
          "title": "产品设计中心",
          "icon": null,
          "order": 0,
          "is_pinned": true,
          "updated_at": "2026-07-30T09:15:00+00:00",
          "child_count": 2,
          "children": [
            {
              "id": "n2",
              "node_type": "tabdoc",
              "resource_id": "doc-2",
              "context_item_id": "n2",
              "parent_node_id": "n1",
              "parent_node_type": "tabdoc",
              "parent_id": "n1",
              "collection_id": null,
              "title": "竞品调研",
              "icon": null,
              "order": 0,
              "is_pinned": false,
              "updated_at": "2026-07-29T18:00:00+00:00",
              "child_count": 1,
              "children": []
            },
            {
              "id": "n3",
              "node_type": "tabdata",
              "resource_id": "table-1",
              "context_item_id": "n3",
              "parent_node_id": "n1",
              "parent_node_type": "tabdoc",
              "parent_id": "n1",
              "collection_id": null,
              "title": "用户访谈记录表",
              "icon": null,
              "order": 1,
              "is_pinned": false,
              "updated_at": "2026-07-28T12:00:00+00:00",
              "child_count": 0,
              "children": []
            }
          ]
        }
      ],
      "stats": { "folder_count": 0, "doc_count": 2, "table_count": 1, "orphan_count": 0 },
      "warnings": []
    }
    """.trimIndent()

    @Test
    fun `decodes knowledge tree response with nested children`() {
        val response = json.decodeFromString<KnowledgeTreeResponse>(treeJson)
        assertEquals("org-1", response.organizationId)
        assertEquals(1, response.roots.size)

        val root = response.roots.single()
        assertEquals("n1", root.id)
        assertEquals(KnowledgeTreeNodeType.TABDOC, root.nodeType)
        assertEquals("产品设计中心", root.title)
        assertTrue(root.isPinned)
        assertEquals(2, root.childCount)
        assertEquals(2, root.children?.size)

        val table = root.children!!.last()
        assertEquals(KnowledgeTreeNodeType.TABDATA, table.nodeType)
        assertEquals("table-1", table.resourceId)
        assertEquals("n1", table.parentId)
        assertEquals(KnowledgeTreeNodeType.TABDOC, table.parentNodeType)
    }

    @Test
    fun `decodes tree stats`() {
        val response = json.decodeFromString<KnowledgeTreeResponse>(treeJson)
        assertEquals(0, response.stats.folderCount)
        assertEquals(2, response.stats.docCount)
        assertEquals(1, response.stats.tableCount)
        assertEquals(0, response.stats.orphanCount)
        assertTrue(response.warnings.isEmpty())
    }

    @Test
    fun `truncated subtree is distinguishable from leaf by childCount`() {
        val response = json.decodeFromString<KnowledgeTreeResponse>(treeJson)
        val children = response.roots.single().children!!

        val truncated = children.first()
        assertEquals(1, truncated.childCount)
        assertEquals(0, truncated.children?.size)

        val leaf = children.last()
        assertEquals(0, leaf.childCount)
        assertEquals(0, leaf.children?.size)
    }

    @Test
    fun `missing children decodes to null and empty array is preserved`() {
        val missing = json.decodeFromString<KnowledgeTreeNode>(
            """
            {
              "id": "n1",
              "node_type": "tabdoc",
              "resource_id": "doc-1",
              "context_item_id": "n1",
              "title": "无 children 键",
              "order": 0,
              "is_pinned": false,
              "child_count": 3
            }
            """.trimIndent(),
        )
        assertNull(missing.children)
        assertEquals(3, missing.childCount)

        val empty = json.decodeFromString<KnowledgeTreeNode>(
            """
            {
              "id": "n1",
              "node_type": "tabdoc",
              "resource_id": "doc-1",
              "title": "空 children",
              "child_count": 0,
              "children": []
            }
            """.trimIndent(),
        )
        assertEquals(emptyList<KnowledgeTreeNode>(), empty.children)
    }

    @Test
    fun `decodes knowledge tree children response`() {
        val response = json.decodeFromString<KnowledgeTreeChildrenResponse>(
            """
            {
              "node_id": "n1",
              "node_type": "tabdoc",
              "children": [
                {
                  "id": "n2",
                  "node_type": "tabdata",
                  "resource_id": "t-1",
                  "title": "子表格",
                  "child_count": 0,
                  "children": []
                }
              ]
            }
            """.trimIndent(),
        )
        assertEquals("n1", response.nodeId)
        assertEquals(KnowledgeTreeNodeType.TABDOC, response.nodeType)
        assertEquals(1, response.children.size)
        assertEquals("t-1", response.children.single().resourceId)
    }
}
