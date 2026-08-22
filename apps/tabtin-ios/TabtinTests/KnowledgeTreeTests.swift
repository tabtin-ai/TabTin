import XCTest
@testable import Tabtin

final class KnowledgeTreeTests: XCTestCase {
    /// 后端 KnowledgeTreeService._assemble() 的真实字段集合，含一层嵌套与懒加载占位。
    private let treeJSON = """
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
    """

    func testDecodesKnowledgeTreeResponse() throws {
        let response = try JSONDecoder().decode(KnowledgeTreeResponse.self, from: Data(treeJSON.utf8))
        XCTAssertEqual(response.organizationId, "org-1")
        XCTAssertEqual(response.roots.count, 1)

        let root = try XCTUnwrap(response.roots.first)
        XCTAssertEqual(root.id, "n1")
        XCTAssertEqual(root.nodeType, .tabdoc)
        XCTAssertEqual(root.title, "产品设计中心")
        XCTAssertTrue(root.isPinned)
        XCTAssertEqual(root.childCount, 2)
        XCTAssertEqual(root.children?.count, 2)

        let table = try XCTUnwrap(root.children?.last)
        XCTAssertEqual(table.nodeType, .tabdata)
        XCTAssertEqual(table.resourceId, "table-1")
        XCTAssertEqual(table.parentId, "n1")
    }

    func testDecodesTreeStatsAndRootMetadata() throws {
        let response = try JSONDecoder().decode(KnowledgeTreeResponse.self, from: Data(treeJSON.utf8))
        XCTAssertEqual(response.stats.folderCount, 0)
        XCTAssertEqual(response.stats.docCount, 2)
        XCTAssertEqual(response.stats.tableCount, 1)
        XCTAssertEqual(response.stats.orphanCount, 0)
        XCTAssertTrue(response.warnings.isEmpty)

        let root = try XCTUnwrap(response.roots.first)
        XCTAssertNil(root.parentNodeId)
        XCTAssertNil(root.parentNodeType)
        XCTAssertNil(root.icon)
        XCTAssertEqual(root.order, 0)
        XCTAssertEqual(root.contextItemId, "n1")
        XCTAssertEqual(root.updatedAt, "2026-07-30T09:15:00+00:00")

        let nested = try XCTUnwrap(root.children?.first)
        XCTAssertEqual(nested.parentNodeType, .tabdoc)
        XCTAssertEqual(nested.order, 0)
    }

    /// depth 截断的判定依据：`children.count < childCount` 说明这一层没展开完，要走懒加载。
    /// 后端对「叶子」和「被截断」都返回 `children: []`，只有 childCount 能区分两者。
    func testTruncatedSubtreeIsDistinguishableFromLeaf() throws {
        let response = try JSONDecoder().decode(KnowledgeTreeResponse.self, from: Data(treeJSON.utf8))
        let children = try XCTUnwrap(response.roots.first?.children)

        let truncated = try XCTUnwrap(children.first)
        XCTAssertEqual(truncated.childCount, 1)
        XCTAssertEqual(truncated.children?.count, 0)

        let leaf = try XCTUnwrap(children.last)
        XCTAssertEqual(leaf.childCount, 0)
        XCTAssertEqual(leaf.children?.count, 0)
    }

    /// `children` 缺失（nil，未加载）与 `children: []`（已加载且为空）语义不同，解码必须保留区别。
    func testMissingChildrenDecodesToNilAndEmptyArrayIsPreserved() throws {
        let missing = """
        {
          "id": "n1",
          "node_type": "tabdoc",
          "resource_id": "doc-1",
          "context_item_id": "n1",
          "parent_node_id": null,
          "parent_node_type": null,
          "parent_id": null,
          "title": "无 children 键",
          "icon": null,
          "order": 0,
          "is_pinned": false,
          "updated_at": null,
          "child_count": 3
        }
        """
        let missingNode = try JSONDecoder().decode(KnowledgeTreeNode.self, from: Data(missing.utf8))
        XCTAssertNil(missingNode.children)
        XCTAssertEqual(missingNode.childCount, 3)
        XCTAssertNil(missingNode.updatedAt)

        let explicitNull = missing.replacingOccurrences(
            of: "\"child_count\": 3",
            with: "\"child_count\": 3,\n  \"children\": null"
        )
        let nullNode = try JSONDecoder().decode(KnowledgeTreeNode.self, from: Data(explicitNull.utf8))
        XCTAssertNil(nullNode.children)

        let empty = missing.replacingOccurrences(
            of: "\"child_count\": 3",
            with: "\"child_count\": 0,\n  \"children\": []"
        )
        let emptyNode = try JSONDecoder().decode(KnowledgeTreeNode.self, from: Data(empty.utf8))
        XCTAssertEqual(emptyNode.children?.count, 0)
    }

    /// 后端 depth 最深到 5，递归解码要一路到底不丢层。
    func testDecodesDeeplyNestedNodes() throws {
        func node(_ id: String, children: String) -> String {
            """
            {
              "id": "\(id)",
              "node_type": "tabdoc",
              "resource_id": "doc-\(id)",
              "context_item_id": "\(id)",
              "parent_node_id": null,
              "parent_node_type": null,
              "parent_id": null,
              "title": "层 \(id)",
              "icon": null,
              "order": 0,
              "is_pinned": false,
              "updated_at": null,
              "child_count": 1,
              "children": [\(children)]
            }
            """
        }
        let deep = node("1", children: node("2", children: node("3", children: node("4", children: node("5", children: "")))))

        let root = try JSONDecoder().decode(KnowledgeTreeNode.self, from: Data(deep.utf8))
        let level5 = try XCTUnwrap(root.children?.first?.children?.first?.children?.first?.children?.first)
        XCTAssertEqual(level5.id, "5")
        XCTAssertEqual(level5.title, "层 5")
        XCTAssertEqual(level5.children?.count, 0)
    }

    /// 云文档域只收 tabdoc / tabdata：后端 `node_type` 硬编码在这两个值里，
    /// 出现第三种值属于契约破坏，解码显式失败而不是静默吞掉节点。
    func testUnknownNodeTypeFailsDecoding() {
        let json = """
        {
          "id": "n9",
          "node_type": "tabslide",
          "resource_id": "slide-1",
          "context_item_id": "n9",
          "parent_node_id": null,
          "parent_node_type": null,
          "parent_id": null,
          "title": "幻灯片",
          "icon": null,
          "order": 0,
          "is_pinned": false,
          "updated_at": null,
          "child_count": 0,
          "children": []
        }
        """
        XCTAssertThrowsError(try JSONDecoder().decode(KnowledgeTreeNode.self, from: Data(json.utf8)))
    }

    func testDisplayTitleFallsBackWhenTitleIsEmpty() throws {
        let json = """
        {
          "id": "n1",
          "node_type": "tabdata",
          "resource_id": "table-9",
          "context_item_id": "n1",
          "parent_node_id": null,
          "parent_node_type": null,
          "parent_id": null,
          "title": "",
          "icon": null,
          "order": 0,
          "is_pinned": false,
          "updated_at": null,
          "child_count": 0,
          "children": []
        }
        """
        let node = try JSONDecoder().decode(KnowledgeTreeNode.self, from: Data(json.utf8))
        XCTAssertTrue(node.title.isEmpty)
        XCTAssertFalse(node.displayTitle.isEmpty)
    }

    func testAppRouteMapsNodeTypeToEmbeddedApp() throws {
        let response = try JSONDecoder().decode(KnowledgeTreeResponse.self, from: Data(treeJSON.utf8))
        let root = try XCTUnwrap(response.roots.first)
        XCTAssertEqual(root.appRoute, .tabdoc(documentId: "doc-1", documentName: "产品设计中心"))

        let table = try XCTUnwrap(root.children?.last)
        XCTAssertEqual(table.appRoute, .tabdata(tableId: "table-1", tableName: "用户访谈记录表"))
    }

    /// 没有 resource_id 就打不开，返回 nil 让调用方退回「仅展示」。
    func testAppRouteIsNilWithoutResourceId() throws {
        let json = """
        {
          "id": "n1",
          "node_type": "tabdoc",
          "resource_id": null,
          "context_item_id": "n1",
          "parent_node_id": null,
          "parent_node_type": null,
          "parent_id": null,
          "title": "没有资源",
          "icon": null,
          "order": 0,
          "is_pinned": false,
          "updated_at": null,
          "child_count": 0,
          "children": []
        }
        """
        let node = try JSONDecoder().decode(KnowledgeTreeNode.self, from: Data(json.utf8))
        XCTAssertNil(node.resourceId)
        XCTAssertNil(node.appRoute)
    }

    func testDecodesChildrenResponse() throws {
        let json = """
        {
          "node_id": "n2",
          "node_type": "tabdoc",
          "children": [
            {
              "id": "n4",
              "node_type": "tabdoc",
              "resource_id": "doc-4",
              "context_item_id": "n4",
              "parent_node_id": "n2",
              "parent_node_type": "tabdoc",
              "parent_id": "n2",
              "collection_id": null,
              "title": "设计规范 v3",
              "icon": null,
              "order": 0,
              "is_pinned": false,
              "updated_at": "2026-07-30T10:00:00+00:00",
              "child_count": 0,
              "children": []
            }
          ]
        }
        """
        let response = try JSONDecoder().decode(KnowledgeTreeChildrenResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.nodeId, "n2")
        XCTAssertEqual(response.children.count, 1)
        XCTAssertEqual(response.children.first?.title, "设计规范 v3")
    }

    func testDecodesEmptyChildrenResponse() throws {
        let json = """
        { "node_id": "n2", "node_type": "tabdata", "children": [] }
        """
        let response = try JSONDecoder().decode(KnowledgeTreeChildrenResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.nodeType, .tabdata)
        XCTAssertTrue(response.children.isEmpty)
    }

    func testKnowledgeTreeEndpointPaths() {
        XCTAssertEqual(
            Endpoints.Context.organizationKnowledgeTree(organizationId: "org-1"),
            "/context/organizations/org-1/knowledge-tree"
        )
        XCTAssertEqual(
            Endpoints.Context.organizationKnowledgeTreeChildren(organizationId: "org-1", nodeId: "n2"),
            "/context/organizations/org-1/knowledge-tree/nodes/n2/children"
        )
    }
}
