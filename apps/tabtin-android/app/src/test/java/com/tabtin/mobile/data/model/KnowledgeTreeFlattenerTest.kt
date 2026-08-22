package com.tabtin.mobile.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KnowledgeTreeFlattenerTest {

    private fun node(
        id: String,
        title: String,
        type: KnowledgeTreeNodeType = KnowledgeTreeNodeType.TABDOC,
        childCount: Int = 0,
        children: List<KnowledgeTreeNode>? = null,
        isPinned: Boolean = false,
    ): KnowledgeTreeNode = KnowledgeTreeNode(
        id = id,
        nodeType = type,
        resourceId = "res-$id",
        contextItemId = id,
        title = title,
        isPinned = isPinned,
        childCount = childCount,
        children = children,
    )

    private val sampleRoots: List<KnowledgeTreeNode> = listOf(
        node(
            "n1",
            title = "产品设计中心",
            childCount = 2,
            children = listOf(
                node("n2", title = "竞品调研", childCount = 1, children = emptyList()),
                node("n3", title = "用户访谈记录表", type = KnowledgeTreeNodeType.TABDATA),
            ),
            isPinned = true,
        ),
        node(
            "n4",
            title = "周会纪要",
            childCount = 1,
            children = listOf(node("n5", title = "07-30 周会")),
        ),
    )

    /** 单链：l0 → l1 → … → l(depth-1) */
    private fun chain(depth: Int): KnowledgeTreeNode {
        var current = node("l${depth - 1}", title = "层 ${depth - 1}")
        for (level in (depth - 2) downTo 0) {
            current = node("l$level", title = "层 $level", childCount = 1, children = listOf(current))
        }
        return current
    }

    @Test
    fun flattenCollapsedReturnsRootsOnly() {
        val rows = KnowledgeTreeFlattener.flatten(sampleRoots, expandedIds = emptySet())
        assertEquals(listOf("n1", "n4"), rows.map { it.node.id })
        assertEquals(listOf(0, 0), rows.map { it.depth })
    }

    @Test
    fun flattenExpandedIncludesChildrenWithDepth() {
        val rows = KnowledgeTreeFlattener.flatten(sampleRoots, expandedIds = setOf("n1"))
        assertEquals(listOf("n1", "n2", "n3", "n4"), rows.map { it.node.id })
        assertEquals(listOf(0, 1, 1, 0), rows.map { it.depth })
    }

    @Test
    fun flattenNestedExpansion() {
        val roots = listOf(
            node(
                "a",
                title = "A",
                childCount = 1,
                children = listOf(
                    node(
                        "b",
                        title = "B",
                        childCount = 1,
                        children = listOf(node("c", title = "C")),
                    ),
                ),
            ),
        )
        val rows = KnowledgeTreeFlattener.flatten(roots, expandedIds = setOf("a", "b"))
        assertEquals(listOf("a", "b", "c"), rows.map { it.node.id })
        assertEquals(listOf(0, 1, 2), rows.map { it.depth })
    }

    @Test
    fun expandingNodeWithoutLoadedChildrenYieldsNoExtraRows() {
        val rows = KnowledgeTreeFlattener.flatten(sampleRoots, expandedIds = setOf("n1", "n2"))
        assertEquals(listOf("n1", "n2", "n3", "n4"), rows.map { it.node.id })
    }

    @Test
    fun needsLazyChildren() {
        assertTrue(
            KnowledgeTreeFlattener.needsLazyChildren(
                node("x", title = "X", childCount = 1, children = emptyList()),
            ),
        )
        assertFalse(
            KnowledgeTreeFlattener.needsLazyChildren(
                node("y", title = "Y", childCount = 1, children = listOf(node("y1", title = "Y1"))),
            ),
        )
        assertFalse(KnowledgeTreeFlattener.needsLazyChildren(node("z", title = "Z", childCount = 0)))
        assertTrue(
            KnowledgeTreeFlattener.needsLazyChildren(
                node("w", title = "W", childCount = 2, children = null),
            ),
        )
        assertTrue(
            KnowledgeTreeFlattener.needsLazyChildren(
                node("p", title = "P", childCount = 3, children = listOf(node("p1", title = "P1"))),
            ),
        )
    }

    @Test
    fun replacingChildrenInsertsAtNestedNode() {
        val loaded = listOf(node("n6", title = "调研问卷"))
        val updated = KnowledgeTreeFlattener.replacingChildren(
            nodes = sampleRoots,
            nodeId = "n2",
            children = loaded,
        )
        val rows = KnowledgeTreeFlattener.flatten(updated, expandedIds = setOf("n1", "n2"))
        assertEquals(listOf("n1", "n2", "n6", "n3", "n4"), rows.map { it.node.id })
        assertEquals(listOf(0, 1, 2, 1, 0), rows.map { it.depth })
    }

    @Test
    fun replacingChildrenLeavesTreeUntouchedWhenNodeMissing() {
        val updated = KnowledgeTreeFlattener.replacingChildren(
            nodes = sampleRoots,
            nodeId = "does-not-exist",
            children = listOf(node("zz", title = "ZZ")),
        )
        assertEquals(sampleRoots, updated)
    }

    @Test
    fun searchMatchesNestedNodesAndReportsPath() {
        val hits = KnowledgeTreeFlattener.search(sampleRoots, keyword = "访谈")
        assertEquals(1, hits.size)
        assertEquals("n3", hits.first().node.id)
        assertEquals(listOf("产品设计中心"), hits.first().path)
    }

    @Test
    fun searchIsCaseInsensitiveAndTrimmed() {
        val roots = listOf(node("a", title = "Roadmap 2026"))
        assertEquals(1, KnowledgeTreeFlattener.search(roots, keyword = "  roadmap ").size)
    }

    @Test
    fun searchWithBlankKeywordReturnsNothing() {
        assertTrue(KnowledgeTreeFlattener.search(sampleRoots, keyword = "   ").isEmpty())
    }

    @Test
    fun searchMatchesRootWithEmptyPath() {
        val hits = KnowledgeTreeFlattener.search(sampleRoots, keyword = "周会纪要")
        assertEquals(emptyList<String>(), hits.first().path)
    }

    @Test
    fun emptyRootsAreHandledByEveryEntryPoint() {
        assertTrue(KnowledgeTreeFlattener.flatten(emptyList(), expandedIds = setOf("n1")).isEmpty())
        assertTrue(
            KnowledgeTreeFlattener.replacingChildren(
                nodes = emptyList(),
                nodeId = "n1",
                children = listOf(node("x", title = "X")),
            ).isEmpty(),
        )
        assertTrue(KnowledgeTreeFlattener.search(emptyList(), keyword = "任意").isEmpty())
    }

    @Test
    fun flattenSingleLeafExpandedStillYieldsOneRow() {
        val rows = KnowledgeTreeFlattener.flatten(
            roots = listOf(node("only", title = "唯一")),
            expandedIds = setOf("only"),
        )
        assertEquals(listOf("only"), rows.map { it.node.id })
        assertEquals(0, rows.first().depth)
    }

    @Test
    fun flattenDeepChainKeepsOrderAndDepth() {
        val levels = 200
        val expected = (0 until levels).map { "l$it" }
        val rows = KnowledgeTreeFlattener.flatten(
            roots = listOf(chain(levels)),
            expandedIds = expected.toSet(),
        )
        assertEquals(expected, rows.map { it.node.id })
        assertEquals((0 until levels).toList(), rows.map { it.depth })
    }

    @Test
    fun flatRowIsExpandableFollowsChildCountNotLoadedChildren() {
        val truncated = node("t", title = "被截断", childCount = 3, children = emptyList())
        val leaf = node("l", title = "真叶子", childCount = 0, children = emptyList())
        val rows = KnowledgeTreeFlattener.flatten(listOf(truncated, leaf), expandedIds = emptySet())
        assertEquals(listOf(true, false), rows.map { it.isExpandable })
    }

    @Test
    fun replacingChildrenAppliesToEveryNodeWithMatchingId() {
        val roots = listOf(
            node("dup", title = "A", childCount = 1, children = listOf(node("a1", title = "A1"))),
            node("dup", title = "B", childCount = 1, children = listOf(node("b1", title = "B1"))),
        )
        val updated = KnowledgeTreeFlattener.replacingChildren(
            nodes = roots,
            nodeId = "dup",
            children = listOf(node("new", title = "新子节点")),
        )
        assertEquals(2, updated.size)
        assertEquals(listOf("new"), updated.first().children?.map { it.id })
        assertEquals(listOf("new"), updated.last().children?.map { it.id })
    }

    @Test
    fun searchDoesNotCascadeFromMatchedParentToChildren() {
        val roots = listOf(
            node(
                "p",
                title = "季度复盘",
                childCount = 2,
                children = listOf(
                    node("c1", title = "季度复盘附件"),
                    node("c2", title = "无关材料"),
                ),
            ),
        )
        val hits = KnowledgeTreeFlattener.search(roots, keyword = "季度复盘")
        assertEquals(listOf("p", "c1"), hits.map { it.node.id })
        assertEquals(emptyList<String>(), hits.first().path)
        assertEquals(listOf("季度复盘"), hits.last().path)
    }

    @Test
    fun searchBuildsFullAncestorPathInDeepTree() {
        val hits = KnowledgeTreeFlattener.search(listOf(chain(4)), keyword = "层 3")
        assertEquals(listOf("l3"), hits.map { it.node.id })
        assertEquals(listOf("层 0", "层 1", "层 2"), hits.first().path)
    }
}
