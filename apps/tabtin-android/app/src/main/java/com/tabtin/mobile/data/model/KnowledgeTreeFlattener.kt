package com.tabtin.mobile.data.model

import java.util.Locale

/** 树中一行的渲染单元：节点 + 缩进层级。 */
public data class KnowledgeTreeFlatRow(
    val node: KnowledgeTreeNode,
    val depth: Int,
) {
    val id: String get() = node.id

    /** 有子节点就能展开，哪怕子节点还没加载。 */
    val isExpandable: Boolean get() = node.childCount > 0
}

/** 搜索命中：节点 + 从根到它的祖先标题，用于在结果行上显示所在位置。 */
public data class KnowledgeTreeSearchHit(
    val node: KnowledgeTreeNode,
    val path: List<String>,
) {
    val id: String get() = node.id
}

/**
 * 知识树的纯函数层：展平、懒加载合并、搜索。
 *
 * 展开状态由调用方持有（[Set] of node id），这里不保存任何状态。
 */
public object KnowledgeTreeFlattener {
    /** 按展开集合把树展平成可渲染的行序列。 */
    public fun flatten(
        roots: List<KnowledgeTreeNode>,
        expandedIds: Set<String>,
    ): List<KnowledgeTreeFlatRow> {
        val rows = ArrayList<KnowledgeTreeFlatRow>()
        appendRows(roots, depth = 0, expandedIds = expandedIds, rows = rows)
        return rows
    }

    private fun appendRows(
        nodes: List<KnowledgeTreeNode>,
        depth: Int,
        expandedIds: Set<String>,
        rows: MutableList<KnowledgeTreeFlatRow>,
    ) {
        for (node in nodes) {
            rows.add(KnowledgeTreeFlatRow(node = node, depth = depth))
            if (node.id !in expandedIds) continue
            val children = node.children
            if (children.isNullOrEmpty()) continue
            appendRows(children, depth + 1, expandedIds, rows)
        }
    }

    /**
     * 是否需要向后端补拉子节点。
     *
     * 与 Electron `nodeNeedsLazyChildren` 同口径：声明的子节点数多于已加载的。
     */
    public fun needsLazyChildren(node: KnowledgeTreeNode): Boolean {
        if (node.childCount <= 0) return false
        return (node.children?.size ?: 0) < node.childCount
    }

    /**
     * 把懒加载回来的子节点写回树里对应位置，返回新树。
     *
     * 找不到目标节点时原样返回。
     */
    public fun replacingChildren(
        nodes: List<KnowledgeTreeNode>,
        nodeId: String,
        children: List<KnowledgeTreeNode>,
    ): List<KnowledgeTreeNode> = nodes.map { node ->
        when {
            node.id == nodeId -> node.copy(children = children)
            !node.children.isNullOrEmpty() ->
                node.copy(children = replacingChildren(node.children, nodeId, children))
            else -> node
        }
    }

    /** 全树标题搜索，结果带祖先路径。 */
    public fun search(
        roots: List<KnowledgeTreeNode>,
        keyword: String,
    ): List<KnowledgeTreeSearchHit> {
        val needle = keyword.trim().lowercase(Locale.ROOT)
        if (needle.isEmpty()) return emptyList()
        val hits = ArrayList<KnowledgeTreeSearchHit>()
        appendHits(roots, path = emptyList(), needle = needle, hits = hits)
        return hits
    }

    private fun appendHits(
        nodes: List<KnowledgeTreeNode>,
        path: List<String>,
        needle: String,
        hits: MutableList<KnowledgeTreeSearchHit>,
    ) {
        for (node in nodes) {
            if (node.title.lowercase(Locale.ROOT).contains(needle)) {
                hits.add(KnowledgeTreeSearchHit(node = node, path = path))
            }
            val children = node.children
            if (children.isNullOrEmpty()) continue
            appendHits(
                nodes = children,
                path = path + node.displayTitle,
                needle = needle,
                hits = hits,
            )
        }
    }
}
