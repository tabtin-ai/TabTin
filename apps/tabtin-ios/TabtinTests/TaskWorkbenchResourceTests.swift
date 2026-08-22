import XCTest
@testable import Tabtin

final class TaskWorkbenchResourceTests: XCTestCase {

    func testDashboardLoadingPolicyOnlyUsesSkeletonForEmptyInitialLoad() {
        XCTAssertTrue(WorkbenchDashboardLoadingPolicy.showsSkeleton(
            hasOutputs: false,
            hasApps: false,
            isResourceLoading: true,
            isAppCatalogLoading: false,
            hasResourceError: false,
            hasAppCatalogError: false
        ))
        XCTAssertTrue(WorkbenchDashboardLoadingPolicy.showsSkeleton(
            hasOutputs: false,
            hasApps: false,
            isResourceLoading: false,
            isAppCatalogLoading: true,
            hasResourceError: false,
            hasAppCatalogError: false
        ))

        XCTAssertFalse(WorkbenchDashboardLoadingPolicy.showsSkeleton(
            hasOutputs: true,
            hasApps: false,
            isResourceLoading: true,
            isAppCatalogLoading: true,
            hasResourceError: false,
            hasAppCatalogError: false
        ))
        XCTAssertFalse(WorkbenchDashboardLoadingPolicy.showsSkeleton(
            hasOutputs: false,
            hasApps: false,
            isResourceLoading: true,
            isAppCatalogLoading: true,
            hasResourceError: true,
            hasAppCatalogError: false
        ))
        XCTAssertFalse(WorkbenchDashboardLoadingPolicy.showsSkeleton(
            hasOutputs: false,
            hasApps: false,
            isResourceLoading: false,
            isAppCatalogLoading: false,
            hasResourceError: false,
            hasAppCatalogError: false
        ))
    }

    func testDecodesBackendResourceFields() throws {
        let json = """
        {
          "workbench": {
            "project": {"id": "p-1"},
            "task": {"id": "t-1"},
            "resources": [
              {
                "context_item_id": "ci-1",
                "resource_type": "tabdoc",
                "resource_id": "doc-1",
                "title": "需求文档",
                "preview": "第一节",
                "summary": {},
                "organization_id": "org-1",
                "resource_space_id": "ws-1",
                "source": "candidate",
                "task_run_id": "run-1",
                "is_primary": true,
                "can_open": true,
                "created_at": "2026-07-31T01:02:03.456789+00:00",
                "updated_at": "2026-07-31T02:03:04Z",
                "last_visited_at": "2026-07-31T03:04:05Z"
              },
              {
                "context_item_id": "ci-2",
                "resource_type": "tabdata",
                "resource_id": "table-1",
                "title": "进度表",
                "preview": "",
                "summary": {
                  "record_count": 12,
                  "field_count": 3,
                  "field_names": ["状态", "负责人", "截止"]
                },
                "organization_id": "org-1",
                "source": "deliverable",
                "task_run_id": "run-2",
                "is_primary": false,
                "can_open": false,
                "created_at": null,
                "updated_at": "2026-07-30T00:00:00Z",
                "last_visited_at": null
              }
            ]
          }
        }
        """

        let response = try JSONDecoder().decode(
            TaskWorkbenchCurrentResponse.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(response.resources.count, 2)

        let doc = response.resources[0]
        XCTAssertEqual(doc.contextItemId, "ci-1")
        XCTAssertEqual(doc.resourceType, "tabdoc")
        XCTAssertEqual(doc.resourceId, "doc-1")
        XCTAssertEqual(doc.title, "需求文档")
        XCTAssertEqual(doc.preview, "第一节")
        XCTAssertEqual(doc.organizationId, "org-1")
        XCTAssertEqual(doc.resourceSpaceId, "ws-1")
        XCTAssertEqual(doc.source, .candidate)
        XCTAssertEqual(doc.taskRunId, "run-1")
        XCTAssertTrue(doc.isPrimary)
        XCTAssertTrue(doc.canOpen)
        XCTAssertEqual(doc.resourceIdentity, "tabdoc:doc-1")
        XCTAssertNotNil(doc.createdAtDate)
        XCTAssertNotNil(doc.lastVisitedAtDate)

        let table = response.resources[1]
        XCTAssertEqual(table.source, .deliverable)
        XCTAssertEqual(table.summary?.recordCount, 12)
        XCTAssertEqual(table.summary?.fieldCount, 3)
        XCTAssertEqual(table.summary?.fieldNames, ["状态", "负责人", "截止"])
        XCTAssertNil(table.resourceSpaceId)
        XCTAssertNil(table.lastVisitedAt)
        XCTAssertFalse(table.canOpen)
    }

    func testSummaryToleratesMissingAndWrongTypes() throws {
        let json = """
        {
          "context_item_id": "ci",
          "resource_type": "tabdata",
          "resource_id": "t1",
          "title": "表",
          "preview": null,
          "summary": {
            "record_count": "nope",
            "field_count": 2.0,
            "field_names": "not-an-array",
            "secret": "drop-me"
          },
          "organization_id": "org",
          "source": "deliverable",
          "task_run_id": "run",
          "is_primary": false,
          "can_open": true
        }
        """

        let resource = try JSONDecoder().decode(
            TaskWorkbenchResource.self,
            from: Data(json.utf8)
        )
        XCTAssertNil(resource.summary?.recordCount)
        XCTAssertEqual(resource.summary?.fieldCount, 2)
        XCTAssertNil(resource.summary?.fieldNames)
        XCTAssertNil(resource.preview)
    }

    func testMissingResourcesDefaultsToEmpty() throws {
        let json = #"{"workbench":{"project":{"id":"p"},"task":{"id":"t"}}}"#
        let response = try JSONDecoder().decode(
            TaskWorkbenchCurrentResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertTrue(response.resources.isEmpty)
    }

    @MainActor
    func testServerErrorMessageStillSilencesNonProjectTask() {
        let coded = APIError.apiErrorWithCode(
            code: "PROJECT_TASK_SESSION_REQUIRED",
            message: "当前会话不是 Project Task 执行会话"
        )
        let legacy = APIError.serverError(400, "当前会话不是 Project Task 执行会话")
        XCTAssertTrue(WorkbenchViewModel.isNonProjectTaskSessionErrorForTest(coded))
        XCTAssertTrue(WorkbenchViewModel.isNonProjectTaskSessionErrorForTest(legacy))
        XCTAssertFalse(
            WorkbenchViewModel.isNonProjectTaskSessionErrorForTest(
                APIError.serverError(500, "boom")
            )
        )
    }

    func testPendingOverlayDropsConfirmedIdentities() {
        let confirmed = TaskWorkbenchResource(
            contextItemId: "ci",
            resourceType: "tabdoc",
            resourceId: "doc-1",
            title: "服务端已确认",
            preview: nil,
            summary: nil,
            organizationId: "org",
            resourceSpaceId: nil,
            source: .candidate,
            taskRunId: "run",
            isPrimary: false,
            canOpen: true,
            createdAt: nil,
            updatedAt: nil,
            lastVisitedAt: nil
        )
        let outputs = [
            TaskWorkbenchOutput(
                id: "tabdoc:doc-1",
                resourceType: "tabdoc",
                resourceId: "doc-1",
                title: "本地输出",
                preview: "x",
                timestamp: Date(),
                resource: nil,
                openRequest: SpaceIDResourceOpenRequestStub.doc1
            ),
            TaskWorkbenchOutput(
                id: "tabdoc:doc-2",
                resourceType: "tabdoc",
                resourceId: "doc-2",
                title: "仍在同步",
                preview: "y",
                timestamp: Date(),
                resource: nil,
                openRequest: SpaceIDResourceOpenRequestStub.doc2
            ),
        ]

        let overlays = TaskWorkbenchPendingOverlayBuilder.build(
            outputs: outputs,
            confirmedResources: [confirmed]
        )

        XCTAssertEqual(overlays.map(\.resourceId), ["doc-2"])
        XCTAssertEqual(overlays.first?.title, "仍在同步")
    }

    @MainActor
    func testResponseErrorKeepsServerErrorStatusForCodedBodies() {
        // 全局 responseError 必须保留 HTTP status；不得因任意 code 改成 apiErrorWithCode。
        let taskData = Data(
            #"{"success":false,"code":"PROJECT_TASK_SESSION_REQUIRED","message":"当前会话不是 Project Task 执行会话"}"#.utf8
        )
        let taskError = APIClient.responseError(statusCode: 400, data: taskData)
        guard case .serverError(let taskStatus, let taskMessage) = taskError else {
            return XCTFail("expected serverError preserving status, got \(taskError)")
        }
        XCTAssertEqual(taskStatus, 400)
        XCTAssertTrue(taskMessage?.contains("Project Task") == true)
        XCTAssertTrue(WorkbenchViewModel.isNonProjectTaskSessionErrorForTest(taskError))

        let other = APIClient.responseError(
            statusCode: 403,
            data: Data(#"{"code":"PERMISSION_DENIED","message":"no"}"#.utf8)
        )
        guard case .serverError(let status, let message) = other else {
            return XCTFail("expected serverError for unrelated codes, got \(other)")
        }
        XCTAssertEqual(status, 403)
        // 有业务码时嵌入 [CODE]，仍保留 HTTP status（不得改成 apiErrorWithCode）。
        XCTAssertEqual(message, "[PERMISSION_DENIED] no")
        XCTAssertEqual(other.businessCode, "PERMISSION_DENIED")
    }

    @MainActor
    func testViewModelScopeChangeClearsTaskResources() {
        let vm = WorkbenchViewModel(
            spaceId: "ws-1",
            organizationId: "org-1",
            sessionId: "session-1"
        )
        vm.setTaskResourcesForTest([
            TaskWorkbenchResource(
                contextItemId: "ci",
                resourceType: "tabdoc",
                resourceId: "doc-1",
                title: "Doc",
                preview: nil,
                summary: nil,
                organizationId: "org-1",
                resourceSpaceId: nil,
                source: .deliverable,
                taskRunId: "run",
                isPrimary: true,
                canOpen: true,
                createdAt: nil,
                updatedAt: nil,
                lastVisitedAt: nil
            )
        ])
        vm.syncPendingOverlays(from: [
            TaskWorkbenchOutput(
                id: "tabdoc:doc-9",
                resourceType: "tabdoc",
                resourceId: "doc-9",
                title: "pending",
                preview: nil,
                timestamp: Date(),
                resource: nil,
                openRequest: SpaceIDResourceOpenRequestStub.doc9
            )
        ])
        XCTAssertFalse(vm.taskResources.isEmpty)
        XCTAssertFalse(vm.pendingTaskResourceOverlays.isEmpty)

        vm.updateScope(
            spaceId: "ws-1",
            organizationId: "org-1",
            sessionId: "session-2"
        )

        XCTAssertTrue(vm.taskResources.isEmpty)
        XCTAssertTrue(vm.pendingTaskResourceOverlays.isEmpty)
        XCTAssertNil(vm.taskResourcesErrorMessage)
        XCTAssertEqual(vm.sessionId, "session-2")
        XCTAssertFalse(vm.isProjectTaskSession)
    }

    @MainActor
    func testRecordTaskResourceAccessStampsVisitLocally() {
        let vm = WorkbenchViewModel(spaceId: "ws-1", organizationId: "org-1", sessionId: "session-1")
        vm.setTaskResourcesForTest([
            TaskWorkbenchResource(
                contextItemId: "ci-old",
                resourceType: "tabdoc",
                resourceId: "doc-old",
                title: "Old",
                organizationId: "org-1",
                source: .deliverable,
                taskRunId: "run",
                isPrimary: false,
                canOpen: true,
                lastVisitedAt: "2020-01-01T00:00:00Z"
            ),
            TaskWorkbenchResource(
                contextItemId: "ci-new",
                resourceType: "tabdoc",
                resourceId: "doc-new",
                title: "New",
                organizationId: "org-1",
                source: .candidate,
                taskRunId: "run",
                isPrimary: false,
                canOpen: true,
                lastVisitedAt: nil
            ),
        ])

        vm.recordTaskResourceAccess(contextItemId: "ci-new")

        let visited = vm.taskResources.first(where: { $0.contextItemId == "ci-new" })?.lastVisitedAt
        XCTAssertNotNil(visited)
        // 旧项仍保留历史时间；新项被盖上本地访问时间。
        XCTAssertEqual(
            vm.taskResources.first(where: { $0.contextItemId == "ci-old" })?.lastVisitedAt,
            "2020-01-01T00:00:00Z"
        )
    }

    @MainActor
    func testRecordTaskResourceAccessIgnoresBlankAndMissingIds() {
        let vm = WorkbenchViewModel(spaceId: "ws-1", organizationId: "org-1", sessionId: "session-1")
        vm.setTaskResourcesForTest([
            TaskWorkbenchResource(
                contextItemId: "ci-1",
                resourceType: "tabdoc",
                resourceId: "doc-1",
                title: "Doc",
                organizationId: "org-1",
                source: .deliverable,
                taskRunId: "run",
                isPrimary: true,
                canOpen: true,
                lastVisitedAt: nil
            ),
        ])

        vm.recordTaskResourceAccess(contextItemId: nil)
        vm.recordTaskResourceAccess(contextItemId: "")
        vm.recordTaskResourceAccess(contextItemId: "   ")

        XCTAssertNil(vm.taskResources.first?.lastVisitedAt)
    }

    func testContinueWindowReusesAppHomeItemAndKind() {
        let output = TaskWorkbenchOutput(
            id: "tabdata:table-1",
            resourceType: "table",
            resourceId: "table-1",
            title: "需求表",
            preview: "3 条记录",
            timestamp: Date(timeIntervalSince1970: 1_700_000_000),
            resource: nil,
            openRequest: SpaceResourceOpenRequest(
                resourceType: "table",
                resourceId: "table-1",
                title: "需求表",
                locationHint: nil
            )
        )
        XCTAssertEqual(TaskWorkbenchContinueWindowPolicy.appKind(for: output.resourceType), .tabdata)
        XCTAssertTrue(TaskWorkbenchContinueWindowPolicy.usesContinueProcessingCard(for: output.resourceType))
        XCTAssertFalse(TaskWorkbenchContinueWindowPolicy.usesContinueProcessingCard(for: "file"))
        let item = TaskWorkbenchContinueWindowPolicy.item(from: output)
        XCTAssertEqual(item.title, "需求表")
        XCTAssertEqual(item.preview, "3 条记录")
        XCTAssertEqual(item.resourceId, "table-1")
        XCTAssertEqual(item.source, .deliverable)
        XCTAssertEqual(item.resourceType, "tabdata")
    }
}

private enum SpaceIDResourceOpenRequestStub {
    static let doc1 = SpaceResourceOpenRequest(
        resourceType: "tabdoc",
        resourceId: "doc-1",
        title: "doc-1",
        locationHint: nil
    )
    static let doc2 = SpaceResourceOpenRequest(
        resourceType: "tabdoc",
        resourceId: "doc-2",
        title: "doc-2",
        locationHint: nil
    )
    static let doc9 = SpaceResourceOpenRequest(
        resourceType: "tabdoc",
        resourceId: "doc-9",
        title: "doc-9",
        locationHint: nil
    )
}
