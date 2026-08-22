package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * 云文档知识树的节点类型。
 *
 * 云文档域只收文档与表格两类；后端 `item_types` 也只接受这两个值。
 */
@Serializable
public enum class KnowledgeTreeNodeType {
    @SerialName("tabdoc") TABDOC,
    @SerialName("tabdata") TABDATA,
    ;

    /** 查询参数 / 路径用的 wire 值（`tabdoc` / `tabdata`）。 */
    public val wireValue: String
        get() = when (this) {
            TABDOC -> "tabdoc"
            TABDATA -> "tabdata"
        }
}

/**
 * 知识树节点。层级来自 `ContextItem.parent`，与云盘 Collection 无关。
 *
 * [childCount] 是直接子节点总数，[children] 只包含本次响应展开的部分：
 * 当 `children.size < childCount` 时说明被 depth 截断，需要懒加载补齐。
 *
 * `children` 缺失（null，未加载）与 `children: []`（已加载且为空）语义不同。
 */
@Serializable
public data class KnowledgeTreeNode(
    val id: String,
    @SerialName("node_type") val nodeType: KnowledgeTreeNodeType,
    @SerialName("resource_id") val resourceId: String? = null,
    @SerialName("context_item_id") val contextItemId: String? = null,
    @SerialName("parent_node_id") val parentNodeId: String? = null,
    @SerialName("parent_node_type") val parentNodeType: KnowledgeTreeNodeType? = null,
    @SerialName("parent_id") val parentId: String? = null,
    val title: String = "",
    val icon: String? = null,
    val order: Int = 0,
    @SerialName("is_pinned") val isPinned: Boolean = false,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("child_count") val childCount: Int = 0,
    val children: List<KnowledgeTreeNode>? = null,
) {
    val displayTitle: String get() = title.ifEmpty { "未命名" }
}

@Serializable
public data class KnowledgeTreeStats(
    @SerialName("folder_count") val folderCount: Int = 0,
    @SerialName("doc_count") val docCount: Int = 0,
    @SerialName("table_count") val tableCount: Int = 0,
    @SerialName("orphan_count") val orphanCount: Int = 0,
)

@Serializable
public data class KnowledgeTreeResponse(
    @SerialName("organization_id") val organizationId: String,
    val roots: List<KnowledgeTreeNode> = emptyList(),
    val stats: KnowledgeTreeStats = KnowledgeTreeStats(),
    val warnings: List<String> = emptyList(),
)

@Serializable
public data class KnowledgeTreeChildrenResponse(
    @SerialName("node_id") val nodeId: String,
    @SerialName("node_type") val nodeType: KnowledgeTreeNodeType,
    val children: List<KnowledgeTreeNode> = emptyList(),
)
