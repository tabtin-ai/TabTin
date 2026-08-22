import XCTest
@testable import Tabtin

final class KnowledgeTreeFlattenerTests: XCTestCase {
    private func node(
        _ id: String,
        title: String,
        type: KnowledgeTreeNodeType = .tabdoc,
        childCount: Int = 0,
        children: [KnowledgeTreeNode]? = nil,
        isPinned: Bool = false
    ) -> KnowledgeTreeNode {
        KnowledgeTreeNode(
            id: id,
            nodeType: type,
            resourceId: "res-\(id)",
            contextItemId: id,
            parentNodeId: nil,
            parentNodeType: nil,
            parentId: nil,
            title: title,
            icon: nil,
            order: 0,
            isPinned: isPinned,
            updatedAt: nil,
            childCount: childCount,
            children: children
        )
    }

    private var sampleRoots: [KnowledgeTreeNode] {
        [
            node(
                "n1",
                title: "产品设计中心",
                childCount: 2,
                children: [
                    node("n2", title: "竞品调研", childCount: 1, children: []),
                    node("n3", title: "用户访谈记录表", type: .tabdata),
                ],
                isPinned: true
            ),
            node("n4", title: "周会纪要", childCount: 1, children: [
                node("n5", title: "07-30 周会"),
            ]),
        ]
    }

    /// 单链：l0 → l1 → … → l(depth-1)，每层都声明 childCount，用来压递归深度与路径累积。
    private func chain(depth: Int) -> KnowledgeTreeNode {
        var current = node("l\(depth - 1)", title: "层 \(depth - 1)")
        for level in stride(from: depth - 2, through: 0, by: -1) {
            current = node("l\(level)", title: "层 \(level)", childCount: 1, children: [current])
        }
        return current
    }

    func testFlattenCollapsedReturnsRootsOnly() {
        let rows = KnowledgeTreeFlattener.flatten(roots: sampleRoots, expandedIds: [])
        XCTAssertEqual(rows.map(\.node.id), ["n1", "n4"])
        XCTAssertEqual(rows.map(\.depth), [0, 0])
    }

    func testFlattenExpandedIncludesChildrenWithDepth() {
        let rows = KnowledgeTreeFlattener.flatten(roots: sampleRoots, expandedIds: ["n1"])
        XCTAssertEqual(rows.map(\.node.id), ["n1", "n2", "n3", "n4"])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 1, 0])
    }

    func testFlattenNestedExpansion() {
        let roots = [
            node("a", title: "A", childCount: 1, children: [
                node("b", title: "B", childCount: 1, children: [
                    node("c", title: "C"),
                ]),
            ]),
        ]
        let rows = KnowledgeTreeFlattener.flatten(roots: roots, expandedIds: ["a", "b"])
        XCTAssertEqual(rows.map(\.node.id), ["a", "b", "c"])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 2])
    }

    func testExpandingNodeWithoutLoadedChildrenYieldsNoExtraRows() {
        // n2 声明 child_count=1 但 children 为空——被 depth 截断，展开时先不出行，等懒加载
        let rows = KnowledgeTreeFlattener.flatten(roots: sampleRoots, expandedIds: ["n1", "n2"])
        XCTAssertEqual(rows.map(\.node.id), ["n1", "n2", "n3", "n4"])
    }

    func testNeedsLazyChildren() {
        XCTAssertTrue(KnowledgeTreeFlattener.needsLazyChildren(
            node("x", title: "X", childCount: 1, children: [])
        ))
        XCTAssertFalse(KnowledgeTreeFlattener.needsLazyChildren(
            node("y", title: "Y", childCount: 1, children: [node("y1", title: "Y1")])
        ))
        XCTAssertFalse(KnowledgeTreeFlattener.needsLazyChildren(
            node("z", title: "Z", childCount: 0)
        ))
        XCTAssertTrue(KnowledgeTreeFlattener.needsLazyChildren(
            node("w", title: "W", childCount: 2, children: nil)
        ))
        // 只加载了一部分子节点也要补拉：判据是 count < childCount，不是 children 空不空
        XCTAssertTrue(KnowledgeTreeFlattener.needsLazyChildren(
            node("p", title: "P", childCount: 3, children: [node("p1", title: "P1")])
        ))
    }

    func testReplacingChildrenInsertsAtNestedNode() {
        let loaded = [node("n6", title: "调研问卷")]
        let updated = KnowledgeTreeFlattener.replacingChildren(
            in: sampleRoots,
            nodeId: "n2",
            children: loaded
        )
        let rows = KnowledgeTreeFlattener.flatten(roots: updated, expandedIds: ["n1", "n2"])
        XCTAssertEqual(rows.map(\.node.id), ["n1", "n2", "n6", "n3", "n4"])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 2, 1, 0])
    }

    func testReplacingChildrenLeavesTreeUntouchedWhenNodeMissing() {
        let updated = KnowledgeTreeFlattener.replacingChildren(
            in: sampleRoots,
            nodeId: "does-not-exist",
            children: [node("zz", title: "ZZ")]
        )
        XCTAssertEqual(updated, sampleRoots)
    }

    func testSearchMatchesNestedNodesAndReportsPath() {
        let hits = KnowledgeTreeFlattener.search(roots: sampleRoots, keyword: "访谈")
        XCTAssertEqual(hits.count, 1)
        let hit = try? XCTUnwrap(hits.first)
        XCTAssertEqual(hit?.node.id, "n3")
        XCTAssertEqual(hit?.path, ["产品设计中心"])
    }

    func testSearchIsCaseInsensitiveAndTrimmed() {
        let roots = [node("a", title: "Roadmap 2026")]
        XCTAssertEqual(KnowledgeTreeFlattener.search(roots: roots, keyword: "  roadmap ").count, 1)
    }

    func testSearchWithBlankKeywordReturnsNothing() {
        XCTAssertTrue(KnowledgeTreeFlattener.search(roots: sampleRoots, keyword: "   ").isEmpty)
    }

    func testSearchMatchesRootWithEmptyPath() {
        let hits = KnowledgeTreeFlattener.search(roots: sampleRoots, keyword: "周会纪要")
        XCTAssertEqual(hits.first?.path, [])
    }

    // MARK: - 边界

    func testEmptyRootsAreHandledByEveryEntryPoint() {
        XCTAssertTrue(KnowledgeTreeFlattener.flatten(roots: [], expandedIds: ["n1"]).isEmpty)
        XCTAssertTrue(KnowledgeTreeFlattener.replacingChildren(
            in: [],
            nodeId: "n1",
            children: [node("x", title: "X")]
        ).isEmpty)
        XCTAssertTrue(KnowledgeTreeFlattener.search(roots: [], keyword: "任意").isEmpty)
    }

    /// 叶子被塞进 expandedIds（例如用户先展开、懒加载回来发现是空的）不能多出行，也不能丢自己那行。
    func testFlattenSingleLeafExpandedStillYieldsOneRow() {
        let rows = KnowledgeTreeFlattener.flatten(roots: [node("only", title: "唯一")], expandedIds: ["only"])
        XCTAssertEqual(rows.map(\.node.id), ["only"])
        XCTAssertEqual(rows.first?.depth, 0)
    }

    /// 产品上限是 4 层，但纯函数不该依赖这个假设：200 层链式递归不能爆栈、不能丢层。
    func testFlattenDeepChainKeepsOrderAndDepth() {
        let levels = 200
        let expected = (0..<levels).map { "l\($0)" }
        let rows = KnowledgeTreeFlattener.flatten(
            roots: [chain(depth: levels)],
            expandedIds: Set(expected)
        )
        XCTAssertEqual(rows.map(\.node.id), expected)
        XCTAssertEqual(rows.map(\.depth), Array(0..<levels))
    }

    /// 能不能展开只看 childCount：后端对「真叶子」和「被 depth 截断」都返回 children: []。
    func testFlatRowIsExpandableFollowsChildCountNotLoadedChildren() {
        let truncated = node("t", title: "被截断", childCount: 3, children: [])
        let leaf = node("l", title: "真叶子", childCount: 0, children: [])
        let rows = KnowledgeTreeFlattener.flatten(roots: [truncated, leaf], expandedIds: [])
        XCTAssertEqual(rows.map(\.isExpandable), [true, false])
    }

    /// id 唯一性由后端保证；万一被破坏，行为是「所有同 id 节点一起写入」而非只改第一个。
    func testReplacingChildrenAppliesToEveryNodeWithMatchingId() {
        let roots = [
            node("dup", title: "A", childCount: 1, children: [node("a1", title: "A1")]),
            node("dup", title: "B", childCount: 1, children: [node("b1", title: "B1")]),
        ]
        let updated = KnowledgeTreeFlattener.replacingChildren(
            in: roots,
            nodeId: "dup",
            children: [node("new", title: "新子节点")]
        )
        XCTAssertEqual(updated.count, 2)
        XCTAssertEqual(updated.first?.children?.map(\.id), ["new"])
        XCTAssertEqual(updated.last?.children?.map(\.id), ["new"])
    }

    /// 父命中不连带整棵子树：子节点只有自己标题也命中才进结果。
    func testSearchDoesNotCascadeFromMatchedParentToChildren() {
        let roots = [
            node("p", title: "季度复盘", childCount: 2, children: [
                node("c1", title: "季度复盘附件"),
                node("c2", title: "无关材料"),
            ]),
        ]
        let hits = KnowledgeTreeFlattener.search(roots: roots, keyword: "季度复盘")
        XCTAssertEqual(hits.map(\.node.id), ["p", "c1"])
        XCTAssertEqual(hits.first?.path, [])
        XCTAssertEqual(hits.last?.path, ["季度复盘"])
    }

    /// path 是「祖先标题」而非「含自己」，深层命中要把整条祖先链按根→父的顺序带出来。
    func testSearchBuildsFullAncestorPathInDeepTree() {
        let hits = KnowledgeTreeFlattener.search(roots: [chain(depth: 4)], keyword: "层 3")
        XCTAssertEqual(hits.map(\.node.id), ["l3"])
        XCTAssertEqual(hits.first?.path, ["层 0", "层 1", "层 2"])
    }
}
