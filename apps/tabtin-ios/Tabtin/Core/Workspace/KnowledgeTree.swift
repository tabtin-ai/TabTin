import Foundation

/// 云文档知识树的节点类型。
///
/// 云文档域只收文档与表格两类；后端 `item_types` 也只接受这两个值。
enum KnowledgeTreeNodeType: String, Codable, Hashable, Sendable {
    case tabdoc
    case tabdata
}

/// 知识树节点。层级来自 `ContextItem.parent`，与云盘 Collection 无关。
///
/// `childCount` 是直接子节点总数，`children` 只包含本次响应展开的部分：
/// 当 `children.count < childCount` 时说明被 depth 截断，需要懒加载补齐。
struct KnowledgeTreeNode: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let nodeType: KnowledgeTreeNodeType
    let resourceId: String?
    let contextItemId: String?
    let parentNodeId: String?
    let parentNodeType: KnowledgeTreeNodeType?
    let parentId: String?
    let title: String
    let icon: String?
    let order: Int
    let isPinned: Bool
    let updatedAt: String?
    let childCount: Int
    var children: [KnowledgeTreeNode]?

    enum CodingKeys: String, CodingKey {
        case id, title, icon, order, children
        case nodeType = "node_type"
        case resourceId = "resource_id"
        case contextItemId = "context_item_id"
        case parentNodeId = "parent_node_id"
        case parentNodeType = "parent_node_type"
        case parentId = "parent_id"
        case isPinned = "is_pinned"
        case updatedAt = "updated_at"
        case childCount = "child_count"
    }

    var displayTitle: String { title.isEmpty ? L10n.CloudDocs.untitled : title }

    /// 打开资源用的路由，与 `SpaceResource.appRoute` 保持同一套语义。
    var appRoute: SpaceAppRoute? {
        guard let resourceId, !resourceId.isEmpty else { return nil }
        switch nodeType {
        case .tabdoc: return .tabdoc(documentId: resourceId, documentName: displayTitle)
        case .tabdata: return .tabdata(tableId: resourceId, tableName: displayTitle)
        }
    }
}

struct KnowledgeTreeStats: Codable, Hashable, Sendable {
    let folderCount: Int
    let docCount: Int
    let tableCount: Int
    let orphanCount: Int

    enum CodingKeys: String, CodingKey {
        case folderCount = "folder_count"
        case docCount = "doc_count"
        case tableCount = "table_count"
        case orphanCount = "orphan_count"
    }
}

struct KnowledgeTreeResponse: Codable, Sendable {
    let organizationId: String
    let roots: [KnowledgeTreeNode]
    let stats: KnowledgeTreeStats
    let warnings: [String]

    enum CodingKeys: String, CodingKey {
        case roots, stats, warnings
        case organizationId = "organization_id"
    }
}

struct KnowledgeTreeChildrenResponse: Codable, Sendable {
    let nodeId: String
    let nodeType: KnowledgeTreeNodeType
    let children: [KnowledgeTreeNode]

    enum CodingKeys: String, CodingKey {
        case children
        case nodeId = "node_id"
        case nodeType = "node_type"
    }
}
