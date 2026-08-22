import XCTest
@testable import Tabtin

@MainActor
final class CloudDocsViewModelTests: XCTestCase {
    private func treeNode(
        _ id: String,
        title: String,
        childCount: Int = 0,
        children: [KnowledgeTreeNode]? = nil
    ) -> KnowledgeTreeNode {
        KnowledgeTreeNode(
            id: id, nodeType: .tabdoc, resourceId: "res-\(id)", contextItemId: id,
            parentNodeId: nil, parentNodeType: nil, parentId: nil,
            title: title, icon: nil, order: 0, isPinned: false,
            updatedAt: nil, childCount: childCount, children: children
        )
    }

    private func resource(
        _ id: String,
        title: String,
        type: String = "tabdoc",
        lastVisitedAt: String?,
        updatedAt: String? = "2026-07-01T00:00:00Z"
    ) -> SpaceResource {
        SpaceResource(
            id: id, itemType: type, title: title, preview: nil,
            resourceId: "res-\(id)", spaceId: "ws-1", organizationId: "org-1",
            metadata: nil, isArchived: false, isPinned: false, pinnedAt: nil,
            updatedAt: updatedAt, createdAt: nil, spaceName: nil,
            lastVisitedAt: lastVisitedAt
        )
    }

    private func sharedItem(_ resourceId: String, title: String) -> SharedResourceItem {
        SharedResourceItem(
            resourceType: .doc,
            resourceId: resourceId,
            title: title,
            organizationId: "org-1",
            spaceId: nil,
            permission: "view",
            updatedAt: "2026-07-20T00:00:00Z",
            sharedBy: nil
        )
    }

    func testBrowseViewTitlesAreLocalized() {
        XCTAssertFalse(CloudDocsBrowseView.all.title.isEmpty)
        XCTAssertFalse(CloudDocsBrowseView.recent.title.isEmpty)
        XCTAssertFalse(CloudDocsBrowseView.shared.title.isEmpty)
        XCTAssertEqual(CloudDocsBrowseView.allCases.count, 3)
    }

    func testTreeRowsReflectExpansion() {
        let vm = CloudDocsViewModel()
        vm.setTreeRootsForTest([
            treeNode("n1", title: "根", childCount: 1, children: [treeNode("n2", title: "子")]),
        ])
        XCTAssertEqual(vm.treeRows.map(\.node.id), ["n1"])

        vm.setExpandedForTest(["n1"])
        XCTAssertEqual(vm.treeRows.map(\.node.id), ["n1", "n2"])
        XCTAssertEqual(vm.treeRows.map(\.depth), [0, 1])
    }

    func testRecentItemsOnlyIncludeVisitedSortedDescending() {
        let vm = CloudDocsViewModel()
        vm.setRecentItemsForTest([
            resource("a", title: "A", lastVisitedAt: "2026-07-10T00:00:00Z"),
            resource("b", title: "B", lastVisitedAt: nil),
            resource("c", title: "C", lastVisitedAt: "2026-07-28T00:00:00Z"),
        ])
        XCTAssertEqual(vm.recentItems.map(\.id), ["c", "a"])
    }

    func testRecentExcludesNonCloudDocTypes() {
        let vm = CloudDocsViewModel()
        vm.setRecentItemsForTest([
            resource("a", title: "文档", type: "tabdoc", lastVisitedAt: "2026-07-10T00:00:00Z"),
            resource("b", title: "表格", type: "tabdata", lastVisitedAt: "2026-07-11T00:00:00Z"),
            resource("c", title: "幻灯片", type: "tabslide", lastVisitedAt: "2026-07-12T00:00:00Z"),
            resource("d", title: "笔记", type: "tabmemo", lastVisitedAt: "2026-07-13T00:00:00Z"),
        ])
        XCTAssertEqual(Set(vm.recentItems.map(\.id)), ["a", "b"])
    }

    func testSearchHitsComeFromWholeTree() {
        let vm = CloudDocsViewModel()
        vm.setTreeRootsForTest([
            treeNode("n1", title: "产品设计中心", childCount: 1, children: [
                treeNode("n2", title: "竞品调研"),
            ]),
        ])
        XCTAssertFalse(vm.isSearching)

        vm.searchText = "竞品"
        XCTAssertTrue(vm.isSearching)
        XCTAssertEqual(vm.searchHits.map(\.node.id), ["n2"])
        XCTAssertEqual(vm.searchHits.first?.path, ["产品设计中心"])
    }

    func testBlankSearchTextIsNotSearching() {
        let vm = CloudDocsViewModel()
        vm.searchText = "   "
        XCTAssertFalse(vm.isSearching)
        XCTAssertTrue(vm.searchHits.isEmpty)
    }

    // MARK: - 最近：口径边界

    /// 后端历史别名（document / table）也是云文档，不能因为字面量不等于 tabdoc/tabdata 就被丢掉。
    func testRecentAcceptsLegacyTypeAliases() {
        let vm = CloudDocsViewModel()
        vm.setRecentItemsForTest([
            resource("a", title: "旧文档", type: "document", lastVisitedAt: "2026-07-10T00:00:00Z"),
            resource("b", title: "旧表格", type: "table", lastVisitedAt: "2026-07-11T00:00:00Z"),
            resource("c", title: "站点", type: "site", lastVisitedAt: "2026-07-12T00:00:00Z"),
        ])
        XCTAssertEqual(vm.recentItems.map(\.id), ["b", "a"])
    }

    /// 空串与不可解析的时间戳都不能把条目排到最前面：空串直接不算访问过，脏值排最后。
    func testRecentHandlesEmptyAndUnparsableVisitTimestamps() {
        let vm = CloudDocsViewModel()
        vm.setRecentItemsForTest([
            resource("empty", title: "空串", lastVisitedAt: ""),
            resource("garbage", title: "脏值", lastVisitedAt: "not-a-date"),
            resource("good", title: "正常", lastVisitedAt: "2026-07-10T00:00:00Z"),
        ])
        XCTAssertEqual(vm.recentItems.map(\.id), ["good", "garbage"])
    }

    // MARK: - 展开态

    /// 展开态存 id 而不是节点本身；折叠要把 id 摘掉，且不留下加载中标记。
    func testToggleExpansionTogglesNodeIdOnly() async {
        let vm = CloudDocsViewModel()
        let node = treeNode("n1", title: "根", childCount: 1, children: [treeNode("n2", title: "子")])
        vm.setTreeRootsForTest([node])

        await vm.toggleExpansion(node)
        XCTAssertEqual(vm.expandedNodeIds, ["n1"])
        XCTAssertEqual(vm.treeRows.map(\.node.id), ["n1", "n2"])
        XCTAssertTrue(vm.loadingChildNodeIds.isEmpty)

        await vm.toggleExpansion(node)
        XCTAssertTrue(vm.expandedNodeIds.isEmpty)
        XCTAssertEqual(vm.treeRows.map(\.node.id), ["n1"])
    }

    /// 被 depth 截断的节点（childCount > 已加载）在没有 organizationId 时不能发请求，
    /// 但展开态要照记，用户不会觉得点了没反应；也不能把 loading 标记留在原地。
    func testToggleExpansionWithoutOrganizationSkipsFetch() async {
        let vm = CloudDocsViewModel()
        let truncated = treeNode("n1", title: "被截断", childCount: 3, children: [])
        vm.setTreeRootsForTest([truncated])

        await vm.toggleExpansion(truncated)

        XCTAssertEqual(vm.expandedNodeIds, ["n1"])
        XCTAssertTrue(vm.loadingChildNodeIds.isEmpty)
        XCTAssertEqual(vm.treeRows.map(\.node.id), ["n1"])
    }

    // MARK: - 空态

    func testIsEmptyFollowsBrowseView() {
        let vm = CloudDocsViewModel()
        XCTAssertTrue(vm.isEmpty)

        vm.setTreeRootsForTest([treeNode("n1", title: "根")])
        XCTAssertFalse(vm.isEmpty)

        vm.browseView = .recent
        XCTAssertTrue(vm.isEmpty)
        vm.setRecentItemsForTest([resource("a", title: "A", lastVisitedAt: "2026-07-10T00:00:00Z")])
        XCTAssertFalse(vm.isEmpty)

        vm.browseView = .shared
        XCTAssertTrue(vm.isEmpty)
        vm.setSharedItemsForTest([sharedItem("doc-1", title: "别人分享的")])
        XCTAssertFalse(vm.isEmpty)
    }

    /// 只有「访问过」才算最近：有资源但都没访问过时，最近分段仍是空的。
    func testRecentIsEmptyWhenNothingVisited() {
        let vm = CloudDocsViewModel()
        vm.browseView = .recent
        vm.setRecentItemsForTest([
            resource("a", title: "A", lastVisitedAt: nil),
            resource("b", title: "B", lastVisitedAt: nil),
        ])
        XCTAssertTrue(vm.isEmpty)
        XCTAssertTrue(vm.recentItems.isEmpty)
    }

    // MARK: - 记录访问

    /// 打开资源后不等下一次整页刷新，本地先把访问时间盖上，最近分段立刻反映顺序。
    ///
    /// 「a」故意用很久以前的时间：断言只依赖「刚记的比历史新」，不依赖跑测机器的当天日期。
    func testRecordAccessStampsVisitLocally() {
        let vm = CloudDocsViewModel()
        vm.setRecentItemsForTest([
            resource("a", title: "A", lastVisitedAt: "2020-01-01T00:00:00Z"),
            resource("b", title: "B", lastVisitedAt: nil),
        ])
        XCTAssertEqual(vm.recentItems.map(\.id), ["a"])

        vm.recordAccess(contextItemId: "b")

        XCTAssertEqual(vm.recentItems.map(\.id), ["b", "a"])
    }

    /// 分享项的 id 是合成的（`shared:` 前缀），不是真实 context-item，不能拿去上报也不能改本地列表。
    func testRecordAccessIgnoresSyntheticAndBlankIds() {
        let vm = CloudDocsViewModel()
        vm.setRecentItemsForTest([resource("a", title: "A", lastVisitedAt: nil)])

        vm.recordAccess(contextItemId: nil)
        vm.recordAccess(contextItemId: "")
        vm.recordAccess(contextItemId: "shared:doc:a")

        XCTAssertTrue(vm.recentItems.isEmpty)
        XCTAssertNil(vm.allRecentItems.first?.lastVisitedAt)
    }

    // MARK: - 行操作的目标边界

    /// 知识树节点与「最近」条目都是本组织的 context-item，能被置顶 / 删除。
    func testManageableIdAcceptsOwnContextItems() {
        let node = treeNode("n1", title: "我的文档")
        XCTAssertEqual(CloudDocsRowActionTarget.manageableId(node.contextItemId), "n1")

        let recent = resource("ci-1", title: "最近打开", lastVisitedAt: "2026-07-10T00:00:00Z")
        XCTAssertEqual(CloudDocsRowActionTarget.manageableId(recent.id), "ci-1")
    }

    /// 分享给我的条目 id 是合成的（`shared:` 前缀），既不是 context-item，
    /// 语义上也不该让接收方去删别人的东西——必须解析不出可操作目标。
    func testManageableIdRejectsSharedAndBlankIds() {
        XCTAssertNil(CloudDocsRowActionTarget.manageableId(sharedItem("doc-1", title: "别人分享的").id))
        XCTAssertNil(CloudDocsRowActionTarget.manageableId(nil))
        XCTAssertNil(CloudDocsRowActionTarget.manageableId(""))
        XCTAssertNil(CloudDocsRowActionTarget.manageableId("   "))
    }

    // MARK: - 新建注册表

    /// 右上角 Menu 只遍历 enabledKinds；rawValue 对齐 item_type，方便扩展对表。
    func testCreatableKindsAreExtensibleRegistry() {
        XCTAssertEqual(
            CloudDocsCreatableKind.enabledKinds.map(\.rawValue),
            ["tabdoc", "tabdata"]
        )
        XCTAssertEqual(
            CloudDocsCreatableKind.document.iconReference,
            .asset("AppGlyphTabdoc")
        )
        XCTAssertEqual(
            CloudDocsCreatableKind.table.iconReference,
            .asset("AppGlyphTabdata")
        )
        for kind in CloudDocsCreatableKind.enabledKinds {
            XCTAssertFalse(kind.title.isEmpty)
        }
    }

    func testCreateServiceResolvesBlankTitleToUntitled() {
        XCTAssertEqual(CloudDocsCreateService.resolveTitle(nil), L10n.CloudDocs.untitled)
        XCTAssertEqual(CloudDocsCreateService.resolveTitle("   "), L10n.CloudDocs.untitled)
        XCTAssertEqual(CloudDocsCreateService.resolveTitle("路线图"), "路线图")
    }

    func testLastModifiedLabelUsesCanonicalPrefix() {
        let label = CloudDocsPresentation.lastModified("2026-07-20T00:00:00+00:00")
        XCTAssertNotNil(label)
        let text = label ?? ""
        XCTAssertTrue(
            text.contains("最近修改") || text.localizedCaseInsensitiveContains("edited"),
            text
        )
    }

    func testSharerAvatarKeepsSeedWhenDisplayNameChanges() {
        let userId = "05a81772-b342-4590-a4a1-ed423f5e1a4d"
        let avatar = CloudDocsPresentation.sharerAvatar(
            SharedResourceOwner(id: userId, displayName: "林工（已离职）", avatar: "https://cdn.example/a.png")
        )
        XCTAssertEqual(avatar?.seed, userId)
        XCTAssertEqual(avatar?.imageUrl, "https://cdn.example/a.png")
    }

    func testSharerAvatarIgnoresEmptyOwner() {
        XCTAssertNil(CloudDocsPresentation.sharerAvatar(nil))
        XCTAssertNil(CloudDocsPresentation.sharerAvatar(
            SharedResourceOwner(id: "", displayName: "", avatar: nil)
        ))
    }
}
