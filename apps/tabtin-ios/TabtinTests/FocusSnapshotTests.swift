import XCTest
@testable import Tabtin

@MainActor
final class FocusSnapshotTests: XCTestCase {
    func testProjectsActiveResourceTabFromNavigationPath() {
        let navigation = WorkbenchNavigationState()
        navigation.show(.tabdoc(documentId: "doc-A", documentName: "需求文档"))

        let snapshot = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .appFocus,
            userTimeZone: "Asia/Shanghai"
        )

        XCTAssertEqual(snapshot.appType, "tabdoc")
        XCTAssertEqual(snapshot.spaceId, "space-1")
        XCTAssertEqual(snapshot.userTimeZone, "Asia/Shanghai")
        XCTAssertEqual(snapshot.workspaceMode, "desktop")
        XCTAssertEqual(snapshot.openTabs?.count, 1)
        XCTAssertEqual(snapshot.openTabs?.first?.id, "doc-A")
        XCTAssertEqual(snapshot.openTabs?.first?.title, "需求文档")
        XCTAssertEqual(snapshot.openTabs?.first?.active, true)
        XCTAssertEqual(snapshot.openTabs?.first?.app_key, "tabdoc")
        // 正典：结构键是字段名；资源值在 manifest 键上。
        XCTAssertEqual(snapshot.appMeta?["idField"], "current_doc_id")
        XCTAssertEqual(snapshot.appMeta?["titleField"], "current_doc_title")
        XCTAssertEqual(snapshot.appMeta?["current_doc_id"], "doc-A")
        XCTAssertEqual(snapshot.appMeta?["current_doc_title"], "需求文档")
        XCTAssertNil(snapshot.appMeta?["content"])
        XCTAssertNil(snapshot.appMeta?["body"])
    }

    func testPresentedSheetFocusTakesPriorityOverPresentedPageFallback() throws {
        let navigation = WorkbenchNavigationState()
        navigation.prepare(
            for: "org-1",
            spaceId: "space-1",
            presentsPagesModally: true
        )
        navigation.showAppHome(
            TaskWorkbenchApp(
                id: "tabdoc",
                name: "Docs",
                description: "协作文档",
                manifestIcon: "file-text",
                surface: .collaborative,
                installed: true,
                workspaceAvailable: true,
                enabled: true,
                canCreate: true,
                order: 2,
                recentResource: nil,
                resourceCount: 1
            )
        )
        let sheetResourceFocus = try XCTUnwrap(
            FocusTab.from(
                route: .tabdata(
                    tableId: "table-in-sheet",
                    tableName: "Sheet 内多维表"
                )
            )
        )
        navigation.updatePresentedFocus(sheetResourceFocus)

        let snapshot = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .split,
            userTimeZone: "Asia/Shanghai"
        )

        XCTAssertEqual(snapshot.appType, "tabdata")
        XCTAssertEqual(snapshot.openTabs?.first?.id, "table-in-sheet")
        XCTAssertEqual(snapshot.openTabs?.first?.title, "Sheet 内多维表")
        XCTAssertEqual(snapshot.appMeta?["current_table_id"], "table-in-sheet")
        XCTAssertNil(snapshot.openTabs?.first?.is_home)
    }

    func testDoesNotDriftWhenNavigationLaterChangesToResourceB() {
        let navigation = WorkbenchNavigationState()
        navigation.show(.tabdoc(documentId: "doc-A", documentName: "资源 A"))
        let frozen = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .appFocus,
            userTimeZone: "Asia/Shanghai"
        )

        navigation.show(.tabdata(tableId: "table-B", tableName: "资源 B"))

        XCTAssertEqual(frozen.openTabs?.first?.id, "doc-A")
        XCTAssertEqual(frozen.appType, "tabdoc")
        XCTAssertEqual(frozen.appMeta?["current_doc_id"], "doc-A")

        let payload = ConversationRuntimeConfiguration().chatSendPayload(
            sessionId: "session-1",
            message: "继续改 A",
            clientEventId: "event-1",
            modelId: "model-1",
            blocks: nil,
            userTimeZone: "Asia/Shanghai",
            focusSnapshot: frozen
        )
        let appContext = payload["app_context"] as? [String: Any]
        let openTabs = appContext?["openTabs"] as? [[String: Any]]
        XCTAssertEqual(openTabs?.first?["id"] as? String, "doc-A")
        XCTAssertEqual(appContext?["appType"] as? String, "tabdoc")
        let meta = appContext?["appMeta"] as? [String: String]
        XCTAssertEqual(meta?["idField"], "current_doc_id")
        XCTAssertEqual(meta?["current_doc_id"], "doc-A")
        XCTAssertEqual(appContext?["userTimeZone"] as? String, "Asia/Shanghai")
        XCTAssertEqual(appContext?["user_time_zone"] as? String, "Asia/Shanghai")
    }

    func testQueuedRecordRoundTripPreservesFrozenFocus() throws {
        let focus = FocusSnapshot(
            appType: "tabdoc",
            appMeta: [
                "idField": "current_doc_id",
                "titleField": "current_doc_title",
                "current_doc_id": "doc-A",
                "current_doc_title": "冻结文档",
            ],
            openTabs: [
                FocusTab(
                    type: "tabdoc",
                    id: "doc-A",
                    title: "冻结文档",
                    active: true,
                    app_key: "tabdoc"
                ),
            ],
            spaceId: "space-1",
            userTimeZone: "Asia/Shanghai",
            workspaceMode: "desktop"
        )

        let encoded = try FocusSnapshot.encodeForPersistence(focus)
        let decoded = try FocusSnapshot.decodeFromPersistence(encoded)
        XCTAssertEqual(decoded, focus)
        XCTAssertEqual(decoded.appMeta?["idField"], "current_doc_id")
        XCTAssertEqual(decoded.appMeta?["current_doc_id"], "doc-A")

        let record = QueuedOutgoingMessageRecord(
            id: "q-1",
            clientEventId: "q-1",
            sessionId: "session-1",
            text: "离线指令",
            modelId: "model-1",
            agentMode: "agent",
            approvalMode: "always_ask",
            blocksData: nil,
            statusRaw: "offline",
            attemptCount: 0,
            lastError: nil,
            createdAt: .now,
            updatedAt: .now,
            focusSnapshotData: encoded
        )
        let queued = record.toQueuedMessage(permitsRelaxedApproval: true)
        XCTAssertEqual(queued.focusSnapshot?.openTabs?.first?.id, "doc-A")
        XCTAssertEqual(queued.focusSnapshot?.appType, "tabdoc")
        XCTAssertEqual(queued.focusSnapshot?.appMeta?["current_doc_title"], "冻结文档")
    }

    func testChatFocusKeepsOpenWorkbenchResourceId() {
        let navigation = WorkbenchNavigationState()
        navigation.show(.tabdoc(documentId: "open-doc", documentName: "仍打开的文档"))

        let snapshot = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .chatFocus,
            userTimeZone: "UTC"
        )
        // 对话面只改 workspaceMode；导航仍挂着资源时必须带真实 id。
        XCTAssertEqual(snapshot.workspaceMode, "conversation")
        XCTAssertEqual(snapshot.spaceId, "space-1")
        XCTAssertEqual(snapshot.openTabs?.first?.id, "open-doc")
        XCTAssertEqual(snapshot.appMeta?["current_doc_id"], "open-doc")
        XCTAssertEqual(snapshot.appType, "tabdoc")
    }

    func testCompactConversationSurfaceKeepsPathResourceId() {
        let navigation = WorkbenchNavigationState()
        navigation.show(.tabdata(tableId: "table-open", tableName: "仍打开的表"))

        let snapshot = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .chatFocus,
            isCompactLayout: true,
            compactSurface: .conversation,
            userTimeZone: "UTC"
        )
        XCTAssertEqual(snapshot.workspaceMode, "conversation")
        XCTAssertEqual(snapshot.openTabs?.first?.id, "table-open")
        XCTAssertEqual(snapshot.appMeta?["current_table_id"], "table-open")
        XCTAssertEqual(snapshot.appType, "tabdata")
    }

    func testEmptyNavigationOnConversationSurfaceHasNoResourceFocus() {
        let navigation = WorkbenchNavigationState()

        let snapshot = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .chatFocus,
            isCompactLayout: true,
            compactSurface: .conversation,
            userTimeZone: "UTC"
        )
        XCTAssertEqual(snapshot.workspaceMode, "conversation")
        XCTAssertNil(snapshot.openTabs)
        XCTAssertNil(snapshot.appMeta)
        XCTAssertNil(snapshot.appType)
    }

    func testAppHomeDisappearNilDoesNotClobberPathResourceFocus() {
        let app = TaskWorkbenchApp(
            id: "tabdoc",
            name: "文档",
            description: "协作文档",
            manifestIcon: "file-text",
            surface: .collaborative,
            installed: true,
            workspaceAvailable: true,
            enabled: true,
            canCreate: true,
            order: 2,
            recentResource: nil,
            resourceCount: 1
        )
        // 模拟：sheet 内已 push 文档，App Home onDisappear 传入 nil。
        let focus = FocusTab.resolveAppHomePresentedFocus(
            previewItemId: nil,
            previewItemTitle: nil,
            resourceType: "tabdoc",
            path: [.tabdoc(documentId: "doc-live", documentName: "Live 文档")],
            appHome: app
        )
        XCTAssertEqual(focus?.id, "doc-live")
        XCTAssertEqual(focus?.title, "Live 文档")
        XCTAssertNil(focus?.is_home)

        let homeOnly = FocusTab.resolveAppHomePresentedFocus(
            previewItemId: nil,
            previewItemTitle: nil,
            resourceType: "tabdoc",
            path: [],
            appHome: app
        )
        XCTAssertEqual(homeOnly?.is_home, true)
        XCTAssertNil(homeOnly?.id)
    }

    func testHostProjectionKeepsSyncedResourceAfterAppHomeFocusClobber() throws {
        // WorkbenchPresentedPageSheet 用本地 navigationState push 资源，宿主 path 为空、
        // presentedPage 仍是 appHome；焦点只靠 presentedFocusTab。若被 onDisappear
        // 打回首页，投影必须仍能在「修复后的回写」下拿到资源 id。
        let app = TaskWorkbenchApp(
            id: "tabdoc",
            name: "文档",
            description: "协作文档",
            manifestIcon: "file-text",
            surface: .collaborative,
            installed: true,
            workspaceAvailable: true,
            enabled: true,
            canCreate: true,
            order: 2,
            recentResource: nil,
            resourceCount: 1
        )
        let host = WorkbenchNavigationState()
        host.prepare(for: "org-1", spaceId: "space-1", presentsPagesModally: true)
        host.showAppHome(app)

        let sheetPath: [SpaceAppRoute] = [
            .tabdoc(documentId: "doc-sheet", documentName: "Sheet 内文档"),
        ]
        // 正确回写（修复后 onDisappear(nil) 应走这条）。
        let synced = try XCTUnwrap(
            FocusTab.resolveAppHomePresentedFocus(
                previewItemId: nil,
                previewItemTitle: nil,
                resourceType: "tabdoc",
                path: sheetPath,
                appHome: app
            )
        )
        host.updatePresentedFocus(synced)

        let snapshot = FocusSnapshot.projecting(
            navigationState: host,
            spaceId: "space-1",
            viewMode: .appFocus,
            isCompactLayout: true,
            compactSurface: .workbench,
            userTimeZone: "UTC"
        )
        XCTAssertEqual(snapshot.openTabs?.first?.id, "doc-sheet")
        XCTAssertEqual(snapshot.appMeta?["current_doc_id"], "doc-sheet")
        XCTAssertNil(snapshot.appMeta?["current_app_home"])
    }

    func testPathResourceWinsOverStaleAppHomePresentedFocus() throws {
        let navigation = WorkbenchNavigationState()
        navigation.prepare(
            for: "org-1",
            spaceId: "space-1",
            presentsPagesModally: true
        )
        navigation.showAppHome(
            TaskWorkbenchApp(
                id: "tabdoc",
                name: "文档",
                description: "协作文档",
                manifestIcon: "file-text",
                surface: .collaborative,
                installed: true,
                workspaceAvailable: true,
                enabled: true,
                canCreate: true,
                order: 2,
                recentResource: nil,
                resourceCount: 1
            )
        )
        // 模拟嵌套容器把 modal 降级后，资源进 path，而 presentedFocusTab 仍停在首页。
        navigation.path = [.tabdoc(documentId: "doc-from-path", documentName: "Path 文档")]

        let snapshot = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .appFocus,
            isCompactLayout: true,
            compactSurface: .workbench,
            userTimeZone: "UTC"
        )

        XCTAssertEqual(snapshot.openTabs?.first?.id, "doc-from-path")
        XCTAssertEqual(snapshot.appMeta?["current_doc_id"], "doc-from-path")
        XCTAssertNil(snapshot.openTabs?.first?.is_home)
        XCTAssertNil(snapshot.appMeta?["current_app_home"])
    }

    func testCompactWorkbenchKeepsResourceFocusDespiteChatFocusViewMode() {
        let navigation = WorkbenchNavigationState()
        navigation.show(.tabdoc(documentId: "doc-phone", documentName: "手机文档"))

        // iPhone 工作台：viewMode 可能仍是 chatFocus，但 compactSurface=workbench。
        let snapshot = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .chatFocus,
            isCompactLayout: true,
            compactSurface: .workbench,
            userTimeZone: "UTC"
        )
        XCTAssertEqual(snapshot.openTabs?.first?.id, "doc-phone")
        XCTAssertEqual(snapshot.appMeta?["idField"], "current_doc_id")
        XCTAssertEqual(snapshot.appMeta?["current_doc_id"], "doc-phone")
        // 手机工作台资源面应对齐 Electron desktop scope，而非钉死 conversation。
        XCTAssertEqual(snapshot.workspaceMode, "desktop")
    }

    func testAppHomeDoesNotWriteAppIdAsDocumentId() {
        let navigation = WorkbenchNavigationState()
        navigation.showAppHome(
            TaskWorkbenchApp(
                id: "tabdoc",
                name: "文档",
                description: "协作文档",
                manifestIcon: "file-text",
                surface: .collaborative,
                installed: true,
                workspaceAvailable: true,
                enabled: true,
                canCreate: true,
                order: 2,
                recentResource: nil,
                resourceCount: 1
            )
        )

        let snapshot = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .appFocus,
            userTimeZone: "UTC"
        )

        XCTAssertEqual(snapshot.appType, "tabdoc")
        XCTAssertEqual(snapshot.openTabs?.first?.is_home, true)
        XCTAssertNil(snapshot.openTabs?.first?.id)
        XCTAssertEqual(snapshot.appMeta?["current_app_home"], "tabdoc")
        XCTAssertNil(snapshot.appMeta?["current_doc_id"])
        XCTAssertNil(snapshot.appMeta?["idField"])
        XCTAssertEqual(snapshot.workspaceMode, "desktop")
    }

    func testTabDataAppMetaUsesManifestIdFieldWithoutSpuriousTitleField() {
        let navigation = WorkbenchNavigationState()
        navigation.show(.tabdata(tableId: "tbl-1", tableName: "客户表"))

        let snapshot = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .appFocus,
            userTimeZone: "UTC"
        )
        XCTAssertEqual(snapshot.appMeta?["idField"], "current_table_id")
        XCTAssertEqual(snapshot.appMeta?["current_table_id"], "tbl-1")
        XCTAssertNil(snapshot.appMeta?["titleField"])
        // 不得把资源 id/title 误写进结构键。
        XCTAssertNotEqual(snapshot.appMeta?["idField"], "tbl-1")
        // 仅 table、无 NativeFocus viewId → 不写 current_view_id。
        XCTAssertNil(snapshot.appMeta?["current_view_id"])
    }

    func testTabDataAppMetaIncludesCurrentViewIdWhenNativeFocusReports() {
        let navigation = WorkbenchNavigationState()
        navigation.show(.tabdata(tableId: "tbl-view", tableName: "带视图的表"))
        navigation.updateResourceViewFocus(
            appType: "tabdata",
            resourceId: "tbl-view",
            viewId: "view-uuid-1"
        )

        let snapshot = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .appFocus,
            userTimeZone: "UTC"
        )
        XCTAssertEqual(snapshot.appMeta?["current_table_id"], "tbl-view")
        XCTAssertEqual(snapshot.appMeta?["current_view_id"], "view-uuid-1")
        XCTAssertEqual(snapshot.appMeta?["idField"], "current_table_id")
    }

    func testTabDataAppMetaOmitsEmptyViewIdFromNativeFocus() {
        let navigation = WorkbenchNavigationState()
        navigation.show(.tabdata(tableId: "tbl-empty-view", tableName: "空视图"))
        navigation.updateResourceViewFocus(
            appType: "tabdata",
            resourceId: "tbl-empty-view",
            viewId: "   "
        )

        let snapshot = FocusSnapshot.projecting(
            navigationState: navigation,
            spaceId: "space-1",
            viewMode: .appFocus,
            userTimeZone: "UTC"
        )
        XCTAssertEqual(snapshot.appMeta?["current_table_id"], "tbl-empty-view")
        XCTAssertNil(snapshot.appMeta?["current_view_id"])
    }

    func testNativeFocusReportParseRejectsEmptyResourceAndEmptyViewString() {
        let ok = NativeWorkbenchFocusReport.parse([
            "appType": "tabdata",
            "resourceId": "tbl-1",
            "viewId": "view-1",
        ])
        XCTAssertEqual(ok?.resourceId, "tbl-1")
        XCTAssertEqual(ok?.viewId, "view-1")

        let nullView = NativeWorkbenchFocusReport.parse([
            "appType": "tabdata",
            "resourceId": "tbl-1",
            "viewId": NSNull(),
        ])
        XCTAssertNil(nullView?.viewId)

        let emptyView = NativeWorkbenchFocusReport.parse([
            "appType": "tabdata",
            "resourceId": "tbl-1",
            "viewId": "",
        ])
        XCTAssertNil(emptyView?.viewId)

        XCTAssertNil(NativeWorkbenchFocusReport.parse([
            "appType": "tabdata",
            "resourceId": "  ",
            "viewId": "view-1",
        ]))
    }
}
