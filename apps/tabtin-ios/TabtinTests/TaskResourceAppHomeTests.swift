import XCTest
@testable import Tabtin

final class TaskResourceAppHomeTests: XCTestCase {

    // MARK: - Continue 四级降级

    func testContinuePrefersCurrentlyOpenSameAppResource() {
        let olderVisited = resource(
            id: "doc-visited",
            lastVisitedAt: date(300),
            updatedAt: date(100)
        )
        let open = resource(
            id: "doc-open",
            lastVisitedAt: date(10),
            updatedAt: date(50)
        )
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [olderVisited, open],
            pendingOverlays: [],
            currentlyOpen: TaskResourceIdentity(resourceType: "tabdoc", resourceId: "doc-open"),
            searchQuery: ""
        )
        XCTAssertEqual(snapshot.continueItem?.resourceId, "doc-open")
    }

    func testContinueFallsBackToMostRecentLastVisited() {
        let a = resource(id: "a", isPrimary: true, lastVisitedAt: date(100), updatedAt: date(500))
        let b = resource(id: "b", isPrimary: false, lastVisitedAt: date(200), updatedAt: date(10))
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [a, b],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertEqual(snapshot.continueItem?.resourceId, "b")
    }

    func testContinueFallsBackToPrimaryWhenNoVisit() {
        let primary = resource(id: "primary", isPrimary: true, updatedAt: date(10))
        let newer = resource(id: "newer", isPrimary: false, updatedAt: date(100))
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [newer, primary],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertEqual(snapshot.continueItem?.resourceId, "primary")
    }

    func testContinueFallsBackToMostRecentlyUpdated() {
        let older = resource(id: "older", updatedAt: date(10))
        let newer = resource(id: "newer", updatedAt: date(100))
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [older, newer],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertEqual(snapshot.continueItem?.resourceId, "newer")
    }

    func testContinueAbsentWhenNoResources() {
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertNil(snapshot.continueItem)
        XCTAssertTrue(snapshot.items.isEmpty)
    }

    func testContinueIgnoresOtherAppOpenResource() {
        let doc = resource(id: "doc-1", resourceType: "tabdoc", updatedAt: date(10))
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [doc],
            pendingOverlays: [],
            currentlyOpen: TaskResourceIdentity(resourceType: "tabdata", resourceId: "table-1"),
            searchQuery: ""
        )
        XCTAssertEqual(snapshot.continueItem?.resourceId, "doc-1")
    }

    func testContinueSkipsNonOpenableResourceAcrossAllFallbacks() {
        let blocked = resource(
            id: "blocked",
            isPrimary: true,
            canOpen: false,
            lastVisitedAt: date(300),
            updatedAt: date(300)
        )
        let openable = resource(id: "openable", updatedAt: date(10))
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [blocked, openable],
            pendingOverlays: [],
            currentlyOpen: TaskResourceIdentity(resourceType: "tabdoc", resourceId: "blocked"),
            searchQuery: ""
        )

        XCTAssertEqual(snapshot.continueItem?.resourceId, "openable")
    }

    func testContinueAbsentWhenOnlyResourceCannotOpen() {
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [resource(id: "blocked", canOpen: false)],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: ""
        )

        XCTAssertNil(snapshot.continueItem)
        XCTAssertEqual(snapshot.items.map(\.resourceId), ["blocked"])
    }

    // MARK: - Task 与组织最近资源的继续入口

    func testResolvedContinuePrefersOpenableTaskItemOverRecentLibraryItem() throws {
        let taskItem = taskHomeItem(
            id: "task-doc",
            organizationId: "org-task",
            spaceId: "space-task",
            lastVisitedAt: date(10)
        )
        let recentLibraryItem = libraryItem(
            id: "library-doc",
            organizationId: "org-library",
            spaceId: "space-library",
            lastVisitedAt: date(500)
        )

        let resolved = try XCTUnwrap(
            TaskResourceAppHomeProjector.resolveContinueItem(
                taskItem: taskItem,
                recentLibraryItems: [recentLibraryItem]
            )
        )

        XCTAssertEqual(resolved, taskItem)
        XCTAssertEqual(resolved.source, .candidate)
    }

    func testResolvedContinueFallsBackToFirstOpenableRecentLibraryItemWhenTaskMissing() throws {
        let blocked = libraryItem(id: "blocked-library", canOpen: false)
        let openable = libraryItem(
            id: "openable-library",
            organizationId: "org-recent",
            spaceId: "space-recent"
        )

        let resolved = try XCTUnwrap(
            TaskResourceAppHomeProjector.resolveContinueItem(
                taskItem: nil,
                recentLibraryItems: [blocked, openable]
            )
        )

        XCTAssertEqual(resolved.resourceId, "openable-library")
        XCTAssertEqual(resolved.source, .library)
        XCTAssertTrue(resolved.canOpen)
    }

    func testResolvedContinueFallsBackWhenTaskCannotOpenAndPreservesLibraryRouteScope() throws {
        let blockedTask = taskHomeItem(id: "blocked-task", canOpen: false)
        let recentLibraryItem = libraryItem(
            id: "recent-table",
            resourceType: "tabdata",
            title: "移动端适配清单",
            subtitle: "24 条记录",
            preview: "Agent 刚更新了 3 条建议",
            contextItemId: "ci-recent-table",
            organizationId: "org-route",
            spaceId: "space-route",
            lastVisitedAt: date(300),
            updatedAt: date(200)
        )

        let resolved = try XCTUnwrap(
            TaskResourceAppHomeProjector.resolveContinueItem(
                taskItem: blockedTask,
                recentLibraryItems: [recentLibraryItem]
            )
        )

        XCTAssertEqual(resolved.source, .library)
        XCTAssertEqual(resolved.resourceType, "tabdata")
        XCTAssertEqual(resolved.resourceId, "recent-table")
        XCTAssertEqual(resolved.contextItemId, "ci-recent-table")
        XCTAssertEqual(resolved.organizationId, "org-route")
        XCTAssertEqual(resolved.resourceSpaceId, "space-route")
        XCTAssertEqual(resolved.title, "移动端适配清单")
        XCTAssertEqual(resolved.subtitle, "24 条记录")
        XCTAssertEqual(resolved.preview, "Agent 刚更新了 3 条建议")
        XCTAssertEqual(resolved.lastVisitedAt, date(300))
        XCTAssertEqual(resolved.updatedAt, date(200))
        XCTAssertTrue(resolved.canOpen)
        XCTAssertFalse(resolved.isPendingSync)
        XCTAssertFalse(resolved.isPrimary)
    }

    // MARK: - App 过滤 / 文案

    func testFiltersToRequestedAppAndNeverCrossContaminates() {
        let docs = [
            resource(id: "d1", resourceType: "tabdoc"),
            resource(id: "t1", resourceType: "tabdata"),
            resource(id: "s1", resourceType: "tabsite"),
        ]
        let docHome = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: docs,
            pendingOverlays: [
                pending(id: "d2", resourceType: "tabdoc"),
                pending(id: "t2", resourceType: "tabdata"),
            ],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertEqual(Set(docHome.items.map(\.resourceId)), ["d1", "d2"])
        XCTAssertEqual(docHome.title, "文档")
        XCTAssertEqual(docHome.continueActionTitle, "继续写")
        XCTAssertEqual(docHome.agentActionTitle, "让 Agent 起草")

        let tableHome = TaskResourceAppHomeProjector.project(
            appKind: .tabdata,
            resources: docs,
            pendingOverlays: [
                pending(id: "d2", resourceType: "tabdoc"),
                pending(id: "t2", resourceType: "tabdata"),
            ],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertEqual(Set(tableHome.items.map(\.resourceId)), ["t1", "t2"])
        XCTAssertEqual(tableHome.title, "多维表")
        XCTAssertEqual(tableHome.continueActionTitle, "继续处理")
        XCTAssertEqual(tableHome.agentActionTitle, "让 Agent 搭建")
    }

    func testNormalizesAliasesLikeDocumentAndTable() {
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [resource(id: "d1", resourceType: "document")],
            pendingOverlays: [pending(id: "d2", resourceType: "doc")],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertEqual(Set(snapshot.items.map(\.resourceId)), ["d1", "d2"])
        XCTAssertTrue(snapshot.items.allSatisfy { $0.resourceType == "tabdoc" })
    }

    // MARK: - 摘要降级

    func testDocSubtitleUsesPreviewAndDegradesToNil() {
        let withPreview = resource(id: "a", preview: "第一段预览")
        let without = resource(id: "b", preview: nil)
        let blank = resource(id: "c", preview: "   ")
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [withPreview, without, blank],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: ""
        )
        let byId = Dictionary(uniqueKeysWithValues: snapshot.items.map { ($0.resourceId, $0) })
        XCTAssertEqual(byId["a"]?.subtitle, "第一段预览")
        XCTAssertNil(byId["b"]?.subtitle)
        XCTAssertNil(byId["c"]?.subtitle)
    }

    func testTableSummaryDegradesWithoutInventingFields() {
        let full = resource(
            id: "full",
            resourceType: "tabdata",
            summary: TaskResourceAppHomeSummary(recordCount: 24, fieldCount: 8, fieldNames: ["状态", "负责人"])
        )
        let recordsOnly = resource(
            id: "records",
            resourceType: "tabdata",
            summary: TaskResourceAppHomeSummary(recordCount: 3, fieldCount: nil, fieldNames: nil)
        )
        let fieldsOnly = resource(
            id: "fields",
            resourceType: "tabdata",
            summary: TaskResourceAppHomeSummary(recordCount: nil, fieldCount: 2, fieldNames: ["A"])
        )
        let empty = resource(
            id: "empty",
            resourceType: "tabdata",
            summary: TaskResourceAppHomeSummary(recordCount: nil, fieldCount: nil, fieldNames: nil)
        )
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdata,
            resources: [full, recordsOnly, fieldsOnly, empty],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: ""
        )
        let byId = Dictionary(uniqueKeysWithValues: snapshot.items.map { ($0.resourceId, $0) })
        XCTAssertEqual(
            byId["full"]?.subtitle,
            "24 条记录 · 8 个字段 · \(ListFormatter.localizedString(byJoining: ["状态", "负责人"]))"
        )
        XCTAssertEqual(byId["records"]?.subtitle, "3 条记录")
        XCTAssertEqual(byId["fields"]?.subtitle, "2 个字段 · A")
        XCTAssertNil(byId["empty"]?.subtitle)
    }

    func testProjectedItemRetainsWhitelistedPreviewAndSummaryForPreviewSheet() throws {
        let summary = TaskResourceAppHomeSummary(
            recordCount: 24,
            fieldCount: 8,
            fieldNames: ["状态", "负责人"]
        )
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdata,
            resources: [
                resource(
                    id: "table-preview",
                    resourceType: "tabdata",
                    preview: "Agent 刚更新了 3 条适配建议",
                    summary: summary
                ),
            ],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: ""
        )

        let item = try XCTUnwrap(snapshot.items.first)
        XCTAssertEqual(item.preview, "Agent 刚更新了 3 条适配建议")
        XCTAssertEqual(item.summary, summary)
    }

    func testSanitizeSummaryIgnoresWrongTypesWithoutCrashing() {
        let nested: [String] = ["nested"]
        let summary = TaskResourceAppHomeProjector.sanitizeSummary([
            "record_count": "not-a-number",
            "field_count": true,
            "field_names": ["ok", 12, nested] as [Any],
            "secret": "leak",
        ])
        XCTAssertNil(summary.recordCount)
        XCTAssertNil(summary.fieldCount)
        XCTAssertEqual(summary.fieldNames, ["ok", "12"])
    }

    // MARK: - 搜索

    func testSearchMatchesTitlePreviewAndFieldNames() {
        let byTitle = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [
                resource(id: "1", title: "入口方案", preview: "分层说明"),
                resource(id: "3", title: "无关", preview: "其他"),
            ],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: "入口"
        )
        XCTAssertEqual(byTitle.items.map(\.resourceId), ["1"])

        let byPreview = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [
                resource(id: "1", title: "入口方案", preview: "分层说明"),
                resource(id: "3", title: "无关", preview: "其他"),
            ],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: "分层"
        )
        XCTAssertEqual(byPreview.items.map(\.resourceId), ["1"])

        let byField = TaskResourceAppHomeProjector.project(
            appKind: .tabdata,
            resources: [
                resource(
                    id: "2",
                    resourceType: "tabdata",
                    title: "适配清单",
                    summary: TaskResourceAppHomeSummary(recordCount: 1, fieldCount: 1, fieldNames: ["负责人"])
                ),
                resource(id: "9", resourceType: "tabdata", title: "其他表"),
            ],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: "负责人"
        )
        XCTAssertEqual(byField.items.map(\.resourceId), ["2"])
    }

    // MARK: - Overlay 去重与约束

    func testDeliverableWinsOverCandidateAndPendingOverlay() {
        let candidate = resource(
            id: "same",
            title: "候选标题",
            source: .candidate,
            updatedAt: date(50)
        )
        let deliverable = resource(
            id: "same",
            title: "交付标题",
            source: .deliverable,
            updatedAt: date(40)
        )
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [candidate, deliverable],
            pendingOverlays: [
                pending(id: "same", title: "临时标题", preview: "同步中预览"),
            ],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertEqual(snapshot.items.count, 1)
        XCTAssertEqual(snapshot.items.first?.title, "交付标题")
        XCTAssertEqual(snapshot.items.first?.source, .deliverable)
        XCTAssertFalse(snapshot.items.first?.isPendingSync ?? true)
    }

    func testPendingOverlayKeptWhenServerAbsentAndCannotImpersonateVisitOrDeliverable() {
        let confirmed = resource(
            id: "confirmed",
            lastVisitedAt: date(10),
            updatedAt: date(5)
        )
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [confirmed],
            pendingOverlays: [
                pending(id: "pending-1", title: "刚生成"),
            ],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertEqual(snapshot.continueItem?.resourceId, "confirmed")
        let pendingItem = snapshot.items.first { $0.resourceId == "pending-1" }
        XCTAssertNotNil(pendingItem)
        XCTAssertTrue(pendingItem?.isPendingSync ?? false)
        XCTAssertEqual(pendingItem?.source, .pendingOverlay)
        XCTAssertNotEqual(pendingItem?.source, .deliverable)

        let pendingOnly = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [],
            pendingOverlays: [pending(id: "pending-1", title: "刚生成")],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertNil(pendingOnly.continueItem)
        XCTAssertEqual(pendingOnly.items.count, 1)
        XCTAssertTrue(pendingOnly.items[0].isPendingSync)
    }

    func testCurrentlyOpenCanSelectPendingOverlay() {
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [resource(id: "other", updatedAt: date(100))],
            pendingOverlays: [pending(id: "pending-open", title: "打开中")],
            currentlyOpen: TaskResourceIdentity(resourceType: "tabdoc", resourceId: "pending-open"),
            searchQuery: ""
        )
        XCTAssertEqual(snapshot.continueItem?.resourceId, "pending-open")
        XCTAssertTrue(snapshot.continueItem?.isPendingSync ?? false)
    }

    func testPendingOverlayRetainsPreviewWithoutInventingSummary() throws {
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [],
            pendingOverlays: [
                pending(id: "pending-preview", title: "同步中", preview: "入口分层草稿"),
            ],
            currentlyOpen: nil,
            searchQuery: ""
        )

        let item = try XCTUnwrap(snapshot.items.first)
        XCTAssertEqual(item.preview, "入口分层草稿")
        XCTAssertNil(item.summary)
        XCTAssertTrue(item.isPendingSync)
    }

    // MARK: - 稳定排序

    func testStableSecondarySortWhenTimestampsEqual() {
        let a = resource(id: "a-res", updatedAt: date(100))
        let b = resource(id: "b-res", updatedAt: date(100))
        let c = resource(id: "c-res", updatedAt: date(200))
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [b, a, c],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertEqual(snapshot.items.map(\.resourceId), ["c-res", "a-res", "b-res"])
        XCTAssertEqual(snapshot.continueItem?.resourceId, "c-res")
    }

    func testContinueStableTieBreakOnSameLastVisited() {
        let a = resource(id: "a-res", lastVisitedAt: date(50), updatedAt: date(1))
        let b = resource(id: "b-res", lastVisitedAt: date(50), updatedAt: date(9))
        let snapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [b, a],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: ""
        )
        XCTAssertEqual(snapshot.continueItem?.resourceId, "a-res")
    }

    // MARK: - 组织资源库

    @MainActor
    func testOptimisticRecentDoesNotPretendTheServerPageFinishedLoading() throws {
        let viewModel = TaskResourceLibraryViewModel(
            organizationId: "org-1",
            appKind: .tabdoc
        )

        for index in 1...4 {
            let snapshot = TaskResourceAppHomeProjector.project(
                appKind: .tabdoc,
                resources: [resource(id: "doc-\(index)")],
                pendingOverlays: [],
                currentlyOpen: nil,
                searchQuery: ""
            )
            viewModel.recordAccess(
                item: try XCTUnwrap(snapshot.items.first),
                reportsToServer: false
            )
        }

        XCTAssertFalse(viewModel.hasLoadedQueryForTest(.recent))
        XCTAssertEqual(
            viewModel.resources(for: .recent).map(\.resourceId),
            ["doc-4", "doc-3", "doc-2", "doc-1"]
        )
        let visibleAfterContinueDeduplication = TaskResourceLibraryProjector.project(
            appKind: .tabdoc,
            scope: .recent,
            resources: viewModel.resources(for: .recent),
            sharedResources: [],
            searchQuery: "",
            excludingIdentity: TaskResourceIdentity(
                resourceType: "tabdoc",
                resourceId: "doc-4"
            )
        )
        XCTAssertEqual(
            visibleAfterContinueDeduplication.items.map(\.resourceId),
            ["doc-3", "doc-2", "doc-1"]
        )

        let repeatedSnapshot = TaskResourceAppHomeProjector.project(
            appKind: .tabdoc,
            resources: [resource(id: "doc-2")],
            pendingOverlays: [],
            currentlyOpen: nil,
            searchQuery: ""
        )
        viewModel.recordAccess(
            item: try XCTUnwrap(repeatedSnapshot.items.first),
            reportsToServer: false
        )
        XCTAssertEqual(
            viewModel.resources(for: .recent).map(\.resourceId),
            ["doc-2", "doc-4", "doc-3", "doc-1"]
        )
    }

    func testLibraryProjectorIsolatesDocumentAndTableTypes() {
        let resources = [
            libraryResource(id: "doc", resourceType: "tabdoc"),
            libraryResource(id: "table", resourceType: "tabdata"),
            libraryResource(id: "site", resourceType: "tabsite"),
        ]

        let documents = TaskResourceLibraryProjector.project(
            appKind: .tabdoc,
            scope: .all,
            resources: resources,
            sharedResources: [],
            searchQuery: ""
        )
        let tables = TaskResourceLibraryProjector.project(
            appKind: .tabdata,
            scope: .all,
            resources: resources,
            sharedResources: [],
            searchQuery: ""
        )

        XCTAssertEqual(documents.items.map(\.resourceId), ["doc"])
        XCTAssertEqual(tables.items.map(\.resourceId), ["table"])
    }

    func testLibraryRecentOnlyIncludesVisitedResourcesAndLimitsDefaultDisplayToThree() {
        let resources = [
            libraryResource(id: "never", lastVisitedAt: nil),
            libraryResource(id: "one", lastVisitedAt: "2026-07-01T00:00:00Z"),
            libraryResource(id: "two", lastVisitedAt: "2026-07-02T00:00:00Z"),
            libraryResource(id: "three", lastVisitedAt: "2026-07-03T00:00:00Z"),
            libraryResource(id: "four", lastVisitedAt: "2026-07-04T00:00:00Z"),
        ]

        let snapshot = TaskResourceLibraryProjector.project(
            appKind: .tabdoc,
            scope: .recent,
            resources: resources,
            sharedResources: [],
            searchQuery: ""
        )

        XCTAssertEqual(snapshot.scope, .recent)
        XCTAssertEqual(snapshot.items.map(\.resourceId), ["four", "three", "two"])
        XCTAssertEqual(snapshot.totalCount, 4)
        XCTAssertTrue(snapshot.items.allSatisfy { $0.lastVisitedAt != nil })
    }

    func testLibraryAllAndSharedLimitDisplayToThreeAndRespectServerTotalCountOverride() {
        let allSnapshot = TaskResourceLibraryProjector.project(
            appKind: .tabdoc,
            scope: .all,
            resources: [
                libraryResource(id: "owned-1", updatedAt: "2026-07-04T00:00:00Z"),
                libraryResource(id: "owned-2", updatedAt: "2026-07-03T00:00:00Z"),
                libraryResource(id: "owned-3", updatedAt: "2026-07-02T00:00:00Z"),
                libraryResource(id: "owned-4", updatedAt: "2026-07-01T00:00:00Z"),
            ],
            sharedResources: [],
            searchQuery: "",
            totalCount: 24
        )

        XCTAssertEqual(allSnapshot.items.map(\.resourceId), ["owned-1", "owned-2", "owned-3"])
        XCTAssertEqual(allSnapshot.totalCount, 24)

        let sharedSnapshot = TaskResourceLibraryProjector.project(
            appKind: .tabdoc,
            scope: .shared,
            resources: [],
            sharedResources: [
                sharedResource(id: "shared-1", resourceType: .doc, updatedAt: "2026-07-04T00:00:00Z"),
                sharedResource(id: "shared-2", resourceType: .doc, updatedAt: "2026-07-03T00:00:00Z"),
                sharedResource(id: "shared-3", resourceType: .doc, updatedAt: "2026-07-02T00:00:00Z"),
                sharedResource(id: "shared-4", resourceType: .doc, updatedAt: "2026-07-01T00:00:00Z"),
            ],
            searchQuery: "",
            totalCount: 18
        )

        XCTAssertEqual(sharedSnapshot.items.map(\.resourceId), ["shared-1", "shared-2", "shared-3"])
        XCTAssertEqual(sharedSnapshot.totalCount, 18)
    }

    func testLibrarySharedScopeUsesRealSharedItemsAndPreservesIdentityScope() throws {
        let sharedDoc = sharedResource(
            id: "shared-doc",
            resourceType: .doc,
            preview: "来自分享流的预览",
            organizationId: "org-shared",
            spaceId: "space-shared",
            contextItemId: "ci-shared"
        )
        let snapshot = TaskResourceLibraryProjector.project(
            appKind: .tabdoc,
            scope: .shared,
            resources: [libraryResource(id: "owned-doc")],
            sharedResources: [
                sharedDoc,
                sharedResource(id: "shared-table", resourceType: .table),
            ],
            searchQuery: ""
        )

        XCTAssertEqual(snapshot.scope, .shared)
        XCTAssertEqual(snapshot.totalCount, 1)
        let item = try XCTUnwrap(snapshot.items.first)
        XCTAssertEqual(item.resourceId, "shared-doc")
        XCTAssertEqual(item.resourceType, "tabdoc")
        XCTAssertEqual(item.source, .shared)
        XCTAssertEqual(item.preview, "来自分享流的预览")
        XCTAssertEqual(item.contextItemId, "ci-shared")
        XCTAssertEqual(item.organizationId, "org-shared")
        XCTAssertEqual(item.resourceSpaceId, "space-shared")
        XCTAssertTrue(item.canOpen)
    }

    func testLibrarySearchMatchesPreviewAndPreservesOwnedOrganizationAndSpace() throws {
        let snapshot = TaskResourceLibraryProjector.project(
            appKind: .tabdoc,
            scope: .all,
            resources: [
                libraryResource(
                    id: "preview-hit",
                    title: "移动端方案",
                    preview: "上次停在入口分层",
                    organizationId: "org-owned",
                    spaceId: "space-owned",
                    spaceName: "产品研发"
                ),
                libraryResource(id: "miss", title: "其他文档", preview: "无关内容"),
            ],
            sharedResources: [],
            searchQuery: "入口分层"
        )

        XCTAssertEqual(snapshot.totalCount, 1)
        let item = try XCTUnwrap(snapshot.items.first)
        XCTAssertEqual(item.resourceId, "preview-hit")
        XCTAssertEqual(item.source, .owned)
        XCTAssertEqual(item.preview, "上次停在入口分层")
        XCTAssertEqual(item.organizationId, "org-owned")
        XCTAssertEqual(item.resourceSpaceId, "space-owned")
        XCTAssertEqual(item.spaceName, "产品研发")
    }

    func testLibraryNormalizesBlankRouteScope() throws {
        let snapshot = TaskResourceLibraryProjector.project(
            appKind: .tabdoc,
            scope: .all,
            resources: [
                libraryResource(
                    id: "blank-scope",
                    organizationId: "  ",
                    spaceId: "\n"
                ),
            ],
            sharedResources: [],
            searchQuery: ""
        )

        let item = try XCTUnwrap(snapshot.items.first)
        XCTAssertNil(item.organizationId)
        XCTAssertNil(item.resourceSpaceId)
    }

    func testLibraryAllSortsPinnedFirstThenByUpdatedAt() {
        let snapshot = TaskResourceLibraryProjector.project(
            appKind: .tabdoc,
            scope: .all,
            resources: [
                libraryResource(id: "newest", updatedAt: "2026-07-30T00:00:00Z"),
                libraryResource(id: "pinned-old", isPinned: true, updatedAt: "2026-07-01T00:00:00Z"),
                libraryResource(id: "middle", updatedAt: "2026-07-20T00:00:00Z"),
            ],
            sharedResources: [],
            searchQuery: ""
        )

        XCTAssertEqual(snapshot.items.map(\.resourceId), ["pinned-old", "newest", "middle"])
    }

    func testLibrarySortFallsBackToResourceIdWhenLocalizedTitlesAreEquivalent() {
        let snapshot = TaskResourceLibraryProjector.project(
            appKind: .tabdoc,
            scope: .all,
            resources: [
                libraryResource(id: "z-resource", title: "ENTRY", updatedAt: "2026-07-01T00:00:00Z"),
                libraryResource(id: "a-resource", title: "entry", updatedAt: "2026-07-01T00:00:00Z"),
            ],
            sharedResources: [],
            searchQuery: ""
        )

        XCTAssertEqual(snapshot.items.map(\.resourceId), ["a-resource", "z-resource"])
    }

    func testLibraryDeduplicatesNormalizedResourceIdentityAndKeepsFirstSortedItem() throws {
        let snapshot = TaskResourceLibraryProjector.project(
            appKind: .tabdoc,
            scope: .all,
            resources: [
                libraryResource(
                    id: "duplicate",
                    resourceType: "document",
                    title: "旧版本",
                    updatedAt: "2026-07-01T00:00:00Z"
                ),
                libraryResource(
                    id: "duplicate",
                    resourceType: "tabdoc",
                    title: "新版本",
                    updatedAt: "2026-07-02T00:00:00Z"
                ),
            ],
            sharedResources: [],
            searchQuery: ""
        )

        XCTAssertEqual(snapshot.totalCount, 1)
        let item = try XCTUnwrap(snapshot.items.first)
        XCTAssertEqual(item.resourceId, "duplicate")
        XCTAssertEqual(item.title, "新版本")
        XCTAssertEqual(snapshot.items.count, 1)
    }

    // MARK: - Fixtures

    private func date(_ epoch: TimeInterval) -> Date {
        Date(timeIntervalSince1970: epoch)
    }

    private func resource(
        id: String,
        resourceType: String = "tabdoc",
        title: String? = nil,
        preview: String? = nil,
        summary: TaskResourceAppHomeSummary? = nil,
        source: TaskResourceAppHomeSource = .candidate,
        isPrimary: Bool = false,
        canOpen: Bool = true,
        lastVisitedAt: Date? = nil,
        updatedAt: Date? = nil
    ) -> TaskResourceAppHomeResource {
        TaskResourceAppHomeResource(
            contextItemId: "ci-\(id)",
            resourceType: resourceType,
            resourceId: id,
            title: title ?? id,
            preview: preview,
            summary: summary,
            organizationId: "org-1",
            resourceSpaceId: "space-1",
            source: source,
            taskRunId: "run-1",
            isPrimary: isPrimary,
            canOpen: canOpen,
            createdAt: date(1),
            updatedAt: updatedAt ?? date(1),
            lastVisitedAt: lastVisitedAt
        )
    }

    private func pending(
        id: String,
        resourceType: String = "tabdoc",
        title: String = "pending",
        preview: String? = nil
    ) -> TaskResourceAppHomePendingOverlay {
        TaskResourceAppHomePendingOverlay(
            resourceType: resourceType,
            resourceId: id,
            title: title,
            preview: preview
        )
    }

    private func taskHomeItem(
        id: String,
        resourceType: String = "tabdoc",
        organizationId: String? = "org-1",
        spaceId: String? = "space-1",
        canOpen: Bool = true,
        lastVisitedAt: Date? = nil,
        updatedAt: Date? = nil
    ) -> TaskResourceAppHomeItem {
        TaskResourceAppHomeItem(
            resourceType: resourceType,
            resourceId: id,
            title: id,
            subtitle: nil,
            preview: nil,
            summary: nil,
            source: .candidate,
            isPendingSync: false,
            canOpen: canOpen,
            isPrimary: false,
            contextItemId: "ci-\(id)",
            organizationId: organizationId,
            resourceSpaceId: spaceId,
            lastVisitedAt: lastVisitedAt,
            updatedAt: updatedAt
        )
    }

    private func libraryItem(
        id: String,
        resourceType: String = "tabdoc",
        title: String? = nil,
        subtitle: String? = nil,
        preview: String? = nil,
        contextItemId: String? = nil,
        organizationId: String? = "org-1",
        spaceId: String? = "space-1",
        canOpen: Bool = true,
        lastVisitedAt: Date? = nil,
        updatedAt: Date? = nil
    ) -> TaskResourceLibraryItem {
        TaskResourceLibraryItem(
            resourceType: resourceType,
            resourceId: id,
            title: title ?? id,
            subtitle: subtitle,
            preview: preview,
            source: .owned,
            contextItemId: contextItemId ?? "ci-\(id)",
            organizationId: organizationId,
            resourceSpaceId: spaceId,
            spaceName: "产品研发",
            canOpen: canOpen,
            isPinned: false,
            lastVisitedAt: lastVisitedAt,
            updatedAt: updatedAt
        )
    }

    private func libraryResource(
        id: String,
        resourceType: String = "tabdoc",
        title: String? = nil,
        preview: String? = nil,
        organizationId: String? = "org-1",
        spaceId: String? = "space-1",
        spaceName: String? = "产品研发",
        isPinned: Bool = false,
        lastVisitedAt: String? = nil,
        updatedAt: String? = "2026-07-01T00:00:00Z"
    ) -> SpaceResource {
        SpaceResource(
            id: "ci-\(id)",
            itemType: resourceType,
            title: title ?? id,
            preview: preview,
            resourceId: id,
            spaceId: spaceId,
            organizationId: organizationId,
            metadata: nil,
            isArchived: false,
            isPinned: isPinned,
            pinnedAt: nil,
            updatedAt: updatedAt,
            createdAt: "2026-06-01T00:00:00Z",
            spaceName: spaceName,
            lastVisitedAt: lastVisitedAt
        )
    }

    private func sharedResource(
        id: String,
        resourceType: SharedResourceType,
        title: String? = nil,
        preview: String? = nil,
        organizationId: String = "org-1",
        spaceId: String? = "space-1",
        contextItemId: String? = nil,
        canView: Bool? = true,
        updatedAt: String? = "2026-07-01T00:00:00Z"
    ) -> SharedResourceItem {
        var item = SharedResourceItem(
            resourceType: resourceType,
            resourceId: id,
            title: title ?? id,
            organizationId: organizationId,
            spaceId: spaceId,
            permission: "viewer",
            updatedAt: updatedAt,
            sharedBy: nil
        )
        item.contextItemId = contextItemId
        item.preview = preview
        item.canView = canView
        return item
    }
}
