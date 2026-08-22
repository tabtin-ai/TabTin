import Foundation

/// 树中一行的渲染单元：节点 + 缩进层级。
struct KnowledgeTreeFlatRow: Identifiable, Hashable, Sendable {
    let node: KnowledgeTreeNode
    let depth: Int

    var id: String { node.id }

    /// 有子节点就能展开，哪怕子节点还没加载。
    var isExpandable: Bool { node.childCount > 0 }
}

/// 搜索命中：节点 + 从根到它的祖先标题，用于在结果行上显示所在位置。
struct KnowledgeTreeSearchHit: Identifiable, Hashable, Sendable {
    let node: KnowledgeTreeNode
    let path: [String]

    var id: String { node.id }
}

/// 知识树的纯函数层：展平、懒加载合并、搜索。
///
/// 展开状态由调用方持有（`Set<String>`），这里不保存任何状态，
/// 便于单测覆盖，也让 SwiftUI 的 diff 只依赖输入。
enum KnowledgeTreeFlattener {
    /// 按展开集合把树展平成可渲染的行序列。
    ///
    /// 只有既在 `expandedIds` 里、又已经加载到 `children` 的节点才会展开子行；
    /// 声明了 `childCount` 但 `children` 为空的节点展开后不出行，等懒加载补齐。
    static func flatten(
        roots: [KnowledgeTreeNode],
        expandedIds: Set<String>
    ) -> [KnowledgeTreeFlatRow] {
        var rows: [KnowledgeTreeFlatRow] = []
        appendRows(nodes: roots, depth: 0, expandedIds: expandedIds, into: &rows)
        return rows
    }

    private static func appendRows(
        nodes: [KnowledgeTreeNode],
        depth: Int,
        expandedIds: Set<String>,
        into rows: inout [KnowledgeTreeFlatRow]
    ) {
        for node in nodes {
            rows.append(KnowledgeTreeFlatRow(node: node, depth: depth))
            guard expandedIds.contains(node.id),
                  let children = node.children,
                  !children.isEmpty else { continue }
            appendRows(nodes: children, depth: depth + 1, expandedIds: expandedIds, into: &rows)
        }
    }

    /// 是否需要向后端补拉子节点。
    ///
    /// 与 Electron `nodeNeedsLazyChildren` 同口径：声明的子节点数多于已加载的。
    static func needsLazyChildren(_ node: KnowledgeTreeNode) -> Bool {
        guard node.childCount > 0 else { return false }
        return (node.children?.count ?? 0) < node.childCount
    }

    /// 把懒加载回来的子节点写回树里对应位置，返回新树。
    ///
    /// 找不到目标节点时原样返回，调用方无需额外判空。
    static func replacingChildren(
        in nodes: [KnowledgeTreeNode],
        nodeId: String,
        children: [KnowledgeTreeNode]
    ) -> [KnowledgeTreeNode] {
        nodes.map { node in
            var updated = node
            if node.id == nodeId {
                updated.children = children
            } else if let existing = node.children, !existing.isEmpty {
                updated.children = replacingChildren(in: existing, nodeId: nodeId, children: children)
            }
            return updated
        }
    }

    /// 全树标题搜索，结果带祖先路径。
    ///
    /// 树搜索时把层级压平：用户搜到什么就直接点开什么，不需要先展开父级。
    static func search(roots: [KnowledgeTreeNode], keyword: String) -> [KnowledgeTreeSearchHit] {
        let needle = keyword.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return [] }
        var hits: [KnowledgeTreeSearchHit] = []
        appendHits(nodes: roots, path: [], needle: needle, into: &hits)
        return hits
    }

    private static func appendHits(
        nodes: [KnowledgeTreeNode],
        path: [String],
        needle: String,
        into hits: inout [KnowledgeTreeSearchHit]
    ) {
        for node in nodes {
            if node.title.lowercased().contains(needle) {
                hits.append(KnowledgeTreeSearchHit(node: node, path: path))
            }
            guard let children = node.children, !children.isEmpty else { continue }
            appendHits(
                nodes: children,
                path: path + [node.displayTitle],
                needle: needle,
                into: &hits
            )
        }
    }
}
