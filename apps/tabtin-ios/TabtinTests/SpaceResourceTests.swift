import XCTest
import WebKit
@testable import Tabtin

/// Phase 5 app-host 地基单测：SpaceResource 类型归一、资源路由派生（含 metadata URL 兜底）。
@MainActor
final class SpaceResourceTests: XCTestCase {
    func testWorkbenchWebViewKeepsPinchZoomEnabled() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Tabtin/Features/Workbench/WorkbenchSheet.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertTrue(source.contains("webView.scrollView.pinchGestureRecognizer?.isEnabled = true"))
    }

    private func resource(
        id: String = "i1", itemType: String, resourceId: String = "r1",
        title: String = "T", preview: String? = nil,
        metadata: [String: AnyCodable]? = nil, isPinned: Bool? = nil,
        updatedAt: String? = nil
    ) -> SpaceResource {
        SpaceResource(
            id: id, itemType: itemType, title: title, preview: preview,
            resourceId: resourceId, spaceId: "s1", organizationId: "org-1", metadata: metadata,
            isArchived: false, isPinned: isPinned, pinnedAt: nil,
            updatedAt: updatedAt, createdAt: nil, spaceName: nil
        )
    }

    func testMentionableResourcesUseOrganizationScope() {
        XCTAssertEqual(
            MentionableResourceListQuery.parameters["scope"],
            "organization",
            "Composer 上下文必须包含组织直属资源，不能退回只看 Workspace 的默认范围"
        )
    }

    func testWorkbenchResourceURLUsesRootRouteForOrganizationOnlyResources() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://web.example"))

        XCTAssertEqual(
            workbenchResourceURL(
                baseURL: baseURL,
                organizationId: "org-1",
                spaceId: nil,
                pathName: "docs",
                resourceId: "doc-1"
            ).absoluteString,
            "https://web.example/docs/doc-1"
        )
    }

    func testResourceDeepLinkRequiresTheCurrentOrganization() {
        XCTAssertEqual(
            CloudResourceDeepLinkPolicy.decision(
                snapshot: .init(
                    currentOrganizationId: "org-1",
                    availableOrganizationIds: ["org-1", "org-2"],
                    hasAuthoritativeOrganizationList: true
                ),
                targetOrganizationId: "org-1"
            ),
            .open
        )
        XCTAssertEqual(
            CloudResourceDeepLinkPolicy.decision(
                snapshot: .init(
                    currentOrganizationId: "org-2",
                    availableOrganizationIds: ["org-1", "org-2"],
                    hasAuthoritativeOrganizationList: true
                ),
                targetOrganizationId: "org-1"
            ),
            .wrongCurrentOrganization
        )
        XCTAssertEqual(
            CloudResourceDeepLinkPolicy.decision(
                snapshot: .init(
                    currentOrganizationId: "org-2",
                    availableOrganizationIds: ["org-2"],
                    hasAuthoritativeOrganizationList: true
                ),
                targetOrganizationId: "org-1"
            ),
            .organizationUnavailable
        )
    }

    func testResourceDeepLinkKeepsPendingWhenOrganizationListRefreshFails() async {
        var pending = true
        var didLoadResources = false
        var didOpen = false
        var notice: String?

        await CloudResourceDeepLinkCoordinator.open(
            targetOrganizationId: "org-1",
            snapshot: {
                .init(
                    currentOrganizationId: "org-2",
                    availableOrganizationIds: ["org-2"],
                    hasAuthoritativeOrganizationList: true
                )
            },
            refreshOrganizations: { false },
            loadResources: { didLoadResources = true },
            isCurrent: { pending },
            consume: { pending = false },
            notify: { notice = $0 },
            openResource: { didOpen = true }
        )

        XCTAssertTrue(pending)
        XCTAssertFalse(didLoadResources)
        XCTAssertFalse(didOpen)
        XCTAssertEqual(notice, L10n.Common.resourceLinkOrganizationLoadFailed)
    }

    func testResourceDeepLinkIsRejectedWhenOrganizationChangesDuringLoad() async {
        let loadStarted = expectation(description: "resource load started")
        let loadGate = CloudResourceTestLoadGate()
        var selectedOrganizationId = "org-1"
        var pending = true
        var didOpen = false
        var notice: String?

        let task = Task { @MainActor in
            await CloudResourceDeepLinkCoordinator.open(
                targetOrganizationId: "org-1",
                snapshot: {
                    .init(
                        currentOrganizationId: selectedOrganizationId,
                        availableOrganizationIds: ["org-1", "org-2"],
                        hasAuthoritativeOrganizationList: true
                    )
                },
                refreshOrganizations: { true },
                loadResources: {
                    loadStarted.fulfill()
                    await loadGate.wait()
                },
                isCurrent: { pending },
                consume: { pending = false },
                notify: { notice = $0 },
                openResource: { didOpen = true }
            )
        }

        await fulfillment(of: [loadStarted], timeout: 1)
        selectedOrganizationId = "org-2"
        loadGate.resume()
        await task.value

        XCTAssertFalse(pending)
        XCTAssertFalse(didOpen)
        XCTAssertEqual(notice, L10n.Common.resourceLinkWrongCurrentOrganization)
    }

    func testEmbeddedWorkbenchResourceURLCarriesTheNativeTheme() throws {
        let canonicalURL = try XCTUnwrap(URL(string: "https://web.example/docs/doc-1"))

        XCTAssertEqual(
            embeddedWorkbenchResourceURL(canonicalURL: canonicalURL, client: "ios", isDarkTheme: true)?.absoluteString,
            "https://web.example/docs/doc-1?shell=embedded&client=ios&theme=dark"
        )
    }

    func testWorkbenchBlobURLStaysInWebView() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://web.example.com"))
        let origin = try XCTUnwrap(WorkbenchWebOrigin(url: baseURL))
        let blobURL = try XCTUnwrap(URL(string: "blob:https://web.example.com/export-1"))

        XCTAssertFalse(origin.shouldOpenExternally(blobURL))
    }

    func testWorkbenchSameOriginURLStaysInWebView() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://web.example.com"))
        let origin = try XCTUnwrap(WorkbenchWebOrigin(url: baseURL))
        let sameOriginURL = try XCTUnwrap(URL(string: "https://web.example.com/docs/doc-1"))

        XCTAssertFalse(origin.shouldOpenExternally(sameOriginURL))
    }

    func testWorkbenchExternalURLLeavesWebView() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://web.example.com"))
        let origin = try XCTUnwrap(WorkbenchWebOrigin(url: baseURL))
        let externalURL = try XCTUnwrap(URL(string: "https://example.com/docs/doc-1"))

        XCTAssertTrue(origin.shouldOpenExternally(externalURL))
    }

    func testWorkbenchHTTPSDefaultPortUsesBrowserCanonicalOrigin() throws {
        let explicitDefaultURL = try XCTUnwrap(URL(string: "https://web.example.com:443/docs/doc-1"))
        let origin = try XCTUnwrap(WorkbenchWebOrigin(url: explicitDefaultURL))
        let implicitDefaultURL = try XCTUnwrap(URL(string: "https://web.example.com/docs/doc-2"))

        XCTAssertEqual(origin.javascriptValue, "https://web.example.com")
        XCTAssertTrue(origin.matches(implicitDefaultURL))
        XCTAssertFalse(origin.shouldOpenExternally(implicitDefaultURL))
    }

    func testWorkbenchHTTPDefaultPortUsesBrowserCanonicalOrigin() throws {
        let explicitDefaultURL = try XCTUnwrap(URL(string: "http://web.example.com:80/docs/doc-1"))
        let origin = try XCTUnwrap(WorkbenchWebOrigin(url: explicitDefaultURL))
        let implicitDefaultURL = try XCTUnwrap(URL(string: "http://web.example.com/docs/doc-2"))

        XCTAssertEqual(origin.javascriptValue, "http://web.example.com")
        XCTAssertTrue(origin.matches(implicitDefaultURL))
    }

    func testWorkbenchNonDefaultPortStaysInTrustedOrigin() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://web.example.com:8443/docs/doc-1"))
        let origin = try XCTUnwrap(WorkbenchWebOrigin(url: baseURL))
        let defaultPortURL = try XCTUnwrap(URL(string: "https://web.example.com/docs/doc-2"))

        XCTAssertEqual(origin.javascriptValue, "https://web.example.com:8443")
        XCTAssertFalse(origin.matches(defaultPortURL))
        XCTAssertTrue(origin.shouldOpenExternally(defaultPortURL))
    }

    func testWorkbenchIPv6TrustedOriginKeepsBracketsAndNonDefaultPort() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://[2001:db8::1]:8443/docs/doc-1"))
        let origin = try XCTUnwrap(WorkbenchWebOrigin(url: baseURL))

        XCTAssertEqual(origin.javascriptValue, "https://[2001:db8::1]:8443")
    }

    func testWorkbenchIPv6DefaultPortUsesBrowserCanonicalOrigin() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://[2001:db8::1]:443/docs/doc-1"))
        let origin = try XCTUnwrap(WorkbenchWebOrigin(url: baseURL))

        XCTAssertEqual(origin.javascriptValue, "https://[2001:db8::1]")
    }

    func testWorkbenchMobileHostContextSerializesTheVersionedTabletContract() throws {
        let context = WorkbenchMobileHostContext.iOS(formFactor: .tablet)
        let jsonData = try XCTUnwrap(context.encodedJSON.data(using: .utf8))
        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: jsonData) as? [String: Any]
        )
        let capabilities = try XCTUnwrap(payload["capabilities"] as? [String: Any])

        XCTAssertEqual(payload["version"] as? Int, 1)
        XCTAssertEqual(payload["platform"] as? String, "ios")
        XCTAssertEqual(payload["formFactor"] as? String, "tablet")
        XCTAssertEqual(capabilities["filePicker"] as? Bool, true)
        XCTAssertEqual(capabilities["nativeFocus"] as? Bool, true)
        XCTAssertEqual(capabilities["fullEditor"] as? Bool, true)
    }

    func testWorkbenchMobileHostContextInjectsAtDocumentStartAndDispatchesEvent() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://web.example.com"))
        let origin = try XCTUnwrap(WorkbenchWebOrigin(url: baseURL))
        let context = WorkbenchMobileHostContext.iOS(formFactor: .phone)
        let source = context.injectionScript(expectedOrigin: origin)
        let userScript = context.userScript(expectedOrigin: origin)

        XCTAssertEqual(userScript.injectionTime, WKUserScriptInjectionTime.atDocumentStart)
        XCTAssertTrue(userScript.isForMainFrameOnly)
        XCTAssertTrue(source.contains("window.location.origin !=="))
        XCTAssertTrue(source.contains("web.example.com"))
        XCTAssertTrue(source.contains("window.__TABTIN_MOBILE_HOST__ = hostContext"))
        XCTAssertTrue(source.contains("new CustomEvent('tabtin:host-context', { detail: hostContext })"))
        XCTAssertTrue(source.contains("\"formFactor\":\"phone\""))
    }

    func testWorkbenchWebAuthClearsPersistedWebSnapshotBeforeInjectingNativeSession() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://web.example.com"))
        let origin = try XCTUnwrap(WorkbenchWebOrigin(url: baseURL))
        let snapshot = WorkbenchWebAuthSnapshot(
            accessToken: "native-access-token",
            expiresAt: 1_234,
            userJSON: #"{"id":"user-1"}"#
        )
        let source = snapshot.injectionScript(expectedOrigin: origin)

        XCTAssertTrue(source.contains("localStorage.removeItem('tabtin-auth-storage')"))
        XCTAssertTrue(source.contains("localStorage.setItem('tabtin_access_token'"))
        XCTAssertTrue(source.contains("localStorage.setItem('tabtin_user'"))
    }

    func testNormalizedTypeAliases() {
        XCTAssertEqual(resource(itemType: "table").normalizedType, "tabdata")
        XCTAssertEqual(resource(itemType: "document").normalizedType, "tabdoc")
        XCTAssertEqual(resource(itemType: "site").normalizedType, "tabsite")
        XCTAssertEqual(resource(itemType: "goal").normalizedType, "tabtracker")
        XCTAssertEqual(resource(itemType: "tabdata").normalizedType, "tabdata") // 已归一保持
        XCTAssertEqual(resource(itemType: "unknown_kind").normalizedType, "unknown_kind") // 未知透传
    }

    func testTabSiteRouteFromPublishedUrl() {
        let res = resource(itemType: "tabsite", resourceId: "site9", title: "我的站点",
                           metadata: ["published_url": AnyCodable("https://x.example/site")])
        guard case let .tabsite(siteId, siteUrl, siteName)? = res.appRoute else {
            return XCTFail("expected tabsite route")
        }
        XCTAssertEqual(siteId, "site9")
        XCTAssertEqual(siteUrl, "https://x.example/site")
        XCTAssertEqual(siteName, "我的站点")
    }

    func testTabSiteRouteFallsBackToDistOssUrl() {
        let res = resource(itemType: "site",
                           metadata: ["dist_oss_url": AnyCodable("https://oss/site")])
        guard case let .tabsite(_, siteUrl, _)? = res.appRoute else {
            return XCTFail("expected tabsite route via dist_oss_url")
        }
        XCTAssertEqual(siteUrl, "https://oss/site")
    }

    func testTabSiteRouteWithoutUrlStillOpenable() {
        // 未发布站点：route 仍存在（siteUrl nil → viewer 显示未发布空态）
        guard case let .tabsite(_, siteUrl, _)? = resource(itemType: "tabsite").appRoute else {
            return XCTFail("expected tabsite route even without url")
        }
        XCTAssertNil(siteUrl)
    }

    func testTabSlideRouteOpenable() {
        let res = resource(itemType: "tabslide", resourceId: "deck7", title: "季度汇报")
        guard case let .tabslide(slideId, slideName)? = res.appRoute else {
            return XCTFail("expected tabslide route")
        }
        XCTAssertEqual(slideId, "deck7")
        XCTAssertEqual(slideName, "季度汇报")
    }

    func testTabSlideAliasesRouteToSlide() {
        // ppt / slide 别名都应归一到 tabslide 并可打开
        XCTAssertNotNil(resource(itemType: "ppt").appRoute)
        XCTAssertNotNil(resource(itemType: "slide").appRoute)
    }

    func testAuthenticatedWebResourceTypesAreOpenable() {
        guard case let .tabdata(tableId, tableName)? = resource(itemType: "tabdata", resourceId: "t1", title: "表格").appRoute else {
            return XCTFail("expected tabdata route")
        }
        XCTAssertEqual(tableId, "t1")
        XCTAssertEqual(tableName, "表格")

        guard case let .tabdoc(documentId, documentName)? = resource(itemType: "tabdoc", resourceId: "d1", title: "文档").appRoute else {
            return XCTFail("expected tabdoc route")
        }
        XCTAssertEqual(documentId, "d1")
        XCTAssertEqual(documentName, "文档")
    }

    func testOrganizationContextItemsDecodeResourcesWithoutASpace() throws {
        let payload = Data(
            """
            {
              "items": [{
                "id": "item-1",
                "item_type": "tabdoc",
                "title": "云端文档",
                "resource_id": "doc-1",
                "space_id": null,
                "organization_id": "org-1",
                "is_archived": false,
                "is_pinned": false
              }],
              "total": 1,
              "page": 1,
              "page_size": 100
            }
            """.utf8
        )

        let response = try JSONDecoder().decode(SpaceResourceListResponse.self, from: payload)

        XCTAssertEqual(response.total, 1)
        XCTAssertEqual(response.page, 1)
        XCTAssertEqual(response.pageSize, 100)
        XCTAssertEqual(response.items.count, 1)
        XCTAssertNil(response.items.first?.spaceId)
        XCTAssertEqual(response.items.first?.organizationId, "org-1")
    }

    /// owner 是后端查用户表 enrich 出来的，查不到时会整段吐 null 或缺字段。
    /// 三个子字段任一声明成必填都会让整条资源解码失败、把整页列表打空，
    /// 所以这里连「owner 缺失」「owner 为 null」「display_name 为 null」一起钉住。
    func testOwnerDecodesLenientlyAndSkipsBlankNames() throws {
        let payload = Data(
            """
            {
              "items": [
                {
                  "id": "item-1", "item_type": "tabdoc", "title": "有所有者",
                  "resource_id": "doc-1", "organization_id": "org-1",
                  "owner": { "id": "u1", "display_name": "李雷", "avatar": null }
                },
                {
                  "id": "item-2", "item_type": "tabdoc", "title": "owner 为 null",
                  "resource_id": "doc-2", "organization_id": "org-1",
                  "owner": null
                },
                {
                  "id": "item-3", "item_type": "tabdoc", "title": "owner 缺字段",
                  "resource_id": "doc-3", "organization_id": "org-1",
                  "owner": { "id": "u3", "display_name": null }
                },
                {
                  "id": "item-4", "item_type": "tabdoc", "title": "名字是空白",
                  "resource_id": "doc-4", "organization_id": "org-1",
                  "owner": { "id": "u4", "display_name": "   " }
                }
              ]
            }
            """.utf8
        )

        let items = try JSONDecoder().decode(SpaceResourceListResponse.self, from: payload).items

        XCTAssertEqual(items.count, 4, "任何一条 owner 异常都不该拖垮整个列表")
        XCTAssertEqual(items[0].owner?.presentableName, "李雷")
        XCTAssertNil(items[1].owner)
        XCTAssertNil(items[2].owner?.presentableName, "没有名字就当没有所有者信息")
        XCTAssertNil(items[3].owner?.presentableName, "纯空白名字不该在副标题里占一段")
    }

    /// `canShare` 必须是三态：后端只在 context-items 列表回填这一位，知识树接口
    /// 不吐。把「字段缺失」和「明确为 false」混成一个值，就只能二选一地错——
    /// 要么让知识树整段没有分享入口，要么给 editor 显示一个必定 403 的按钮。
    func testCanShareKeepsMissingDistinctFromFalse() throws {
        let payload = Data(
            """
            {
              "items": [
                {
                  "id": "i1", "item_type": "tabdoc", "title": "可分享",
                  "resource_id": "d1", "organization_id": "org-1", "can_share": true
                },
                {
                  "id": "i2", "item_type": "tabdoc", "title": "明确不可分享",
                  "resource_id": "d2", "organization_id": "org-1", "can_share": false
                },
                {
                  "id": "i3", "item_type": "tabdoc", "title": "接口没吐这一位",
                  "resource_id": "d3", "organization_id": "org-1"
                }
              ]
            }
            """.utf8
        )

        let items = try JSONDecoder().decode(SpaceResourceListResponse.self, from: payload).items

        XCTAssertEqual(items[0].canShare, true)
        XCTAssertEqual(items[1].canShare, false)
        XCTAssertNil(items[2].canShare, "字段缺失是「不知道」，不能塌陷成 false")
    }

    func testWorkbenchResourceURLFallsBackWhenSpaceIsMissing() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://web.example"))

        XCTAssertEqual(
            workbenchResourceURL(
                baseURL: baseURL,
                organizationId: "org-1",
                spaceId: "space-1",
                pathName: "docs",
                resourceId: "doc-1"
            ).absoluteString,
            "https://web.example/organizations/org-1/spaces/space-1/docs/doc-1"
        )
        XCTAssertEqual(
            workbenchResourceURL(
                baseURL: baseURL,
                organizationId: nil,
                spaceId: "space-1",
                pathName: "tables",
                resourceId: "table-1"
            ).absoluteString,
            "https://web.example/spaces/space-1/tables/table-1"
        )
        XCTAssertEqual(
            workbenchResourceURL(
                baseURL: baseURL,
                organizationId: "org-1",
                spaceId: nil,
                pathName: "docs",
                resourceId: "doc-1"
            ).absoluteString,
            "https://web.example/docs/doc-1"
        )
    }

    func testCloudDetailContextSupportsMemoAndFiles() {
        let memo = resource(itemType: "tabmemo", resourceId: "memo-1", title: "Memo")
        let file = resource(itemType: "tabfiles", resourceId: "file-1", title: "File")

        guard case let .tabmemo(memoId, memoName, _)? = memo.appRoute else {
            return XCTFail("expected memo detail route")
        }
        XCTAssertEqual(memoId, "memo-1")
        XCTAssertEqual(memoName, "Memo")

        guard case let .tabfiles(fileContext)? = file.appRoute else {
            return XCTFail("expected file detail route")
        }
        XCTAssertEqual(fileContext.fileRecordId, "file-1")
        XCTAssertEqual(fileContext.contextItemId, file.id)

        let context = CloudResourceOpenContext(
            id: memo.id,
            organizationId: "org-1",
            spaceId: memo.spaceId,
            spaceName: "Workspace A",
            route: memo.appRoute!
        )
        XCTAssertEqual(context.organizationId, "org-1")
        XCTAssertEqual(context.spaceId, "s1")
        XCTAssertEqual(context.spaceName, "Workspace A")
        XCTAssertEqual(context.id, memo.id)
    }

    func testStillUnsupportedTypesNotOpenableYet() {
        XCTAssertNil(resource(itemType: "tabtracker").appRoute)
    }

    /// `hasAppRoute(forType:)` 是「只知道类型、拿不到资源」时的判断依据，必须和 `appRoute` 同步，
    /// 否则工作台会给一个 iOS 打不开的 App 开首页。
    func testTypeLevelRouteCapabilityMatchesResourceRoute() {
        let routableTypes = ["tabdoc", "tabdata", "tabsite", "tabslide", "tabmemo", "tabfiles"]
        for type in routableTypes {
            XCTAssertTrue(SpaceResource.hasAppRoute(forType: type), "\(type) 应声明可承载")
            XCTAssertNotNil(resource(itemType: type).appRoute, "\(type) 的 appRoute 不应为 nil")
        }
        for type in ["tabtracker", "tabwhiteboard", "tabvideo", "tabmail", "tabphone", "tabweb"] {
            XCTAssertFalse(SpaceResource.hasAppRoute(forType: type), "\(type) 不应声明可承载")
            XCTAssertNil(resource(itemType: type).appRoute, "\(type) 的 appRoute 应为 nil")
        }
        // 别名要跟着归一，否则 document/table 这类历史类型会被判成打不开。
        XCTAssertTrue(SpaceResource.hasAppRoute(forType: "document"))
        XCTAssertTrue(SpaceResource.hasAppRoute(forType: "table"))
    }

    @MainActor
    func testViewModelGroupsAndSortsByPinThenTime() {
        let vm = WorkbenchViewModel(spaceId: "s1")
        let a = resource(id: "a", itemType: "tabsite", title: "A", updatedAt: "2026-01-01T00:00:00Z")
        let b = resource(id: "b", itemType: "tabsite", title: "B", isPinned: true, updatedAt: "2025-01-01T00:00:00Z")
        let c = resource(id: "c", itemType: "tabdoc", title: "C")
        vm.setResourcesForTest([a, b, c])

        // 常用 order = [tabdata, tabdoc, tabslide, tabsite, ...] → tabdoc 先于 tabsite
        XCTAssertEqual(vm.availableTypes, ["tabdoc", "tabsite"])
        let sites = vm.resources(ofType: "tabsite")
        XCTAssertEqual(sites.map(\.id), ["b", "a"]) // 置顶 B 优先，其次按时间 A
    }

    @MainActor
    func testViewModelScopeChangeClearsPreviousSpaceState() {
        let vm = WorkbenchViewModel(spaceId: " s1 ")
        vm.setResourcesForTest([resource(itemType: "tabdoc")])
        vm.errorMessage = "旧错误"

        vm.updateScope(spaceId: "s2")

        XCTAssertEqual(vm.spaceId, "s2")
        XCTAssertTrue(vm.resources.isEmpty)
        XCTAssertNil(vm.errorMessage)
        XCTAssertFalse(vm.isLoading)
    }

    @MainActor
    func testWorkbenchNavigationOpensResourceAndCarriesLocationHint() {
        let state = WorkbenchNavigationState()
        let request = SpaceResourceOpenRequest(
            resourceType: "tabdoc",
            resourceId: "doc-1",
            title: "需求文档",
            locationHint: "第 3 节"
        )

        state.open(request, resources: [])

        guard case let .tabdoc(documentId, documentName)? = state.path.first else {
            return XCTFail("expected tabdoc route")
        }
        XCTAssertEqual(documentId, "doc-1")
        XCTAssertEqual(documentName, "需求文档")
        XCTAssertEqual(state.locationHint(for: state.path[0]), "第 3 节")
        XCTAssertNil(state.openNotice)
    }

    @MainActor
    func testWorkbenchNavigationPreservesOrganizationOnlyLibraryScope() {
        let state = WorkbenchNavigationState()
        let request = SpaceResourceOpenRequest(
            resourceType: "tabdoc",
            resourceId: "doc-org",
            title: "组织直属文档",
            locationHint: nil
        )
        let scope = WorkbenchResourceRouteScope(
            organizationId: "org-library",
            spaceId: nil
        )

        state.open(request, resources: [], resourceScope: scope)

        guard let route = state.path.first else {
            return XCTFail("expected library resource route")
        }
        XCTAssertEqual(state.resourceScope(for: route), scope)
        XCTAssertNil(state.resourceScope(for: route)?.spaceId)
    }

    @MainActor
    func testWorkbenchNavigationShowsNoticeForUnsupportedResource() {
        let state = WorkbenchNavigationState()
        let request = SpaceResourceOpenRequest(
            resourceType: "tabtracker",
            resourceId: "goal-1",
            title: "发布计划",
            locationHint: "里程碑"
        )

        state.open(request, resources: [])

        XCTAssertTrue(state.path.isEmpty)
        XCTAssertEqual(
            state.openNotice,
            "这个资源类型暂不支持在 iOS 内打开，已为你定位到工作台。\n定位线索：里程碑"
        )
    }

    @MainActor
    func testWorkbenchNavigationOnlyResetsWhenScopeActuallyChanges() {
        let state = WorkbenchNavigationState()
        let request = SpaceResourceOpenRequest(
            resourceType: "tabdoc",
            resourceId: "doc-1",
            title: nil,
            locationHint: nil
        )

        state.prepare(for: "s1")
        state.open(request, resources: [])
        state.prepare(for: "s1")
        XCTAssertEqual(state.path.count, 1)

        state.prepare(for: "s2")
        XCTAssertTrue(state.path.isEmpty)
        XCTAssertNil(state.openNotice)
    }

    @MainActor
    func testWorkbenchNavigationResetsResourceScopeWhenOrganizationChanges() throws {
        let state = WorkbenchNavigationState()
        let request = SpaceResourceOpenRequest(
            resourceType: "tabdoc",
            resourceId: "doc-1",
            title: "需求文档",
            locationHint: nil
        )
        let scope = WorkbenchResourceRouteScope(
            organizationId: "org-1",
            spaceId: "shared-space"
        )

        state.prepare(for: "org-1", spaceId: "shared-space")
        state.open(request, resources: [], resourceScope: scope)
        let route = try XCTUnwrap(state.path.first)
        XCTAssertEqual(state.resourceScope(for: route), scope)

        state.prepare(for: "org-2", spaceId: "shared-space")

        XCTAssertTrue(state.path.isEmpty)
        XCTAssertNil(state.resourceScope(for: route))
    }

    @MainActor
    func testEmbeddedWorkbenchCanOpenAndCloseAResourceWithoutChangingRouteType() {
        let state = WorkbenchNavigationState()
        let route = SpaceAppRoute.tabdoc(documentId: "doc-1", documentName: "需求文档")

        state.show(route)
        XCTAssertEqual(state.path, [route])

        state.closeResource()
        XCTAssertTrue(state.path.isEmpty)
    }

    @MainActor
    func testConversationWorkbenchPresentsRoutesWithoutReplacingItsNavigationPath() {
        let state = WorkbenchNavigationState()
        let request = SpaceResourceOpenRequest(
            resourceType: "tabdoc",
            resourceId: "doc-1",
            title: "需求文档",
            locationHint: "第 3 节"
        )

        state.prepare(
            for: "org-1",
            spaceId: "workspace-1",
            presentsPagesModally: true
        )
        state.open(request, resources: [])

        XCTAssertTrue(state.path.isEmpty)
        guard case let .resource(route, locationHint, resourceScope)? = state.presentedPage,
              case let .tabdoc(documentId, documentName) = route else {
            return XCTFail("expected a presented tabdoc route")
        }
        XCTAssertEqual(documentId, "doc-1")
        XCTAssertEqual(documentName, "需求文档")
        XCTAssertEqual(locationHint, "第 3 节")
        XCTAssertNil(resourceScope)
        XCTAssertEqual(state.presentedFocusTab, FocusTab.from(route: route))

        state.dismissPresentedPage()
        XCTAssertNil(state.presentedPage)
        XCTAssertNil(state.presentedFocusTab)
    }

    @MainActor
    func testConversationWorkbenchPresentsAppHomeWithoutReplacingItsNavigationPath() {
        let state = WorkbenchNavigationState()
        let app = TaskWorkbenchApp(
            id: "tabdoc",
            name: "云文档",
            description: "协作文档",
            manifestIcon: "file-text",
            surface: .collaborative,
            installed: true,
            workspaceAvailable: true,
            enabled: true,
            canCreate: true,
            order: 1,
            recentResource: nil,
            resourceCount: 0
        )

        state.prepare(
            for: "org-1",
            spaceId: "workspace-1",
            presentsPagesModally: true
        )
        state.showAppHome(app)

        XCTAssertTrue(state.path.isEmpty)
        XCTAssertNil(state.appHome)
        XCTAssertEqual(state.presentedPage, .appHome(app))
        XCTAssertEqual(state.presentedFocusTab, FocusTab.from(appHome: app))

        let nestedResourceFocus = FocusTab.from(
            route: .tabdoc(
                documentId: "doc-nested",
                documentName: "Sheet 内文档"
            )
        )
        state.updatePresentedFocus(nestedResourceFocus)
        XCTAssertEqual(state.presentedFocusTab, nestedResourceFocus)

        state.dismissPresentedPage()
        XCTAssertNil(state.presentedPage)
        XCTAssertNil(state.presentedFocusTab)
    }

    @MainActor
    func testConversationWorkbenchPromotesPreloadedRouteToPresentation() {
        let state = WorkbenchNavigationState()
        let request = SpaceResourceOpenRequest(
            resourceType: "tabdoc",
            resourceId: "doc-1",
            title: "需求文档",
            locationHint: "第 3 节"
        )
        let scope = WorkbenchResourceRouteScope(
            organizationId: "org-1",
            spaceId: nil
        )

        state.prepare(for: "org-1", spaceId: "workspace-1")
        state.open(request, resources: [], resourceScope: scope)
        XCTAssertEqual(state.path.count, 1)

        // 通知入口可能在工作台视图重新挂载前先写入导航状态。
        state.prepare(
            for: "org-1",
            spaceId: "workspace-1",
            presentsPagesModally: true
        )

        XCTAssertTrue(state.path.isEmpty)
        guard case let .resource(route, locationHint, resourceScope)? = state.presentedPage,
              case let .tabdoc(documentId, _) = route else {
            return XCTFail("expected pending route to be presented")
        }
        XCTAssertEqual(documentId, "doc-1")
        XCTAssertEqual(locationHint, "第 3 节")
        XCTAssertEqual(resourceScope, scope)
        XCTAssertNil(resourceScope?.spaceId)
        XCTAssertEqual(state.presentedFocusTab, FocusTab.from(route: route))
    }

    func testTaskWorkbenchProjectsOnlyAssistantOutputsAndUsesResourceAuthority() {
        let document = resource(
            itemType: "tabdoc",
            resourceId: "doc-1",
            title: "权威需求文档",
            preview: "服务端资源摘要",
            updatedAt: "2026-07-29T10:00:00Z"
        )
        let assistant = ChatMessage(
            id: "assistant-1",
            role: .assistant,
            blocks: [.richContent(richResource(
                type: "document",
                id: "doc-1",
                title: "流式临时标题"
            ))],
            createdAt: Date(timeIntervalSince1970: 100)
        )
        let userContext = ChatMessage(
            id: "user-1",
            role: .user,
            blocks: [.richContent(richResource(
                type: "tabdata",
                id: "table-input",
                title: "用户输入引用"
            ))],
            createdAt: Date(timeIntervalSince1970: 200)
        )

        let snapshot = TaskWorkbenchProjector.project(
            messages: [assistant, userContext],
            resources: [document],
            currentRoute: nil,
            runState: .idle,
            agentName: "Codex",
            completedTodoCount: 0,
            totalTodoCount: 0
        )

        XCTAssertEqual(snapshot.outputs.count, 1)
        XCTAssertEqual(snapshot.outputs.first?.resourceType, "tabdoc")
        XCTAssertEqual(snapshot.outputs.first?.title, "权威需求文档")
        XCTAssertEqual(snapshot.outputs.first?.preview, "服务端资源摘要")
        XCTAssertEqual(snapshot.resumeItem?.id, snapshot.outputs.first?.id)
    }

    func testTaskWorkbenchExtractsMarkdownResourceLinksFromAssistantText() {
        let docId = "02eda024-5f11-4d4a-85c2-9a1b3c5d7e90"
        let assistant = ChatMessage(
            id: "assistant-md-link",
            role: .assistant,
            blocks: [
                .text(TextBlock(
                    messageId: "assistant-md-link",
                    index: 0,
                    text: "已创建 [问候文档](tabtin://resource/document/\(docId)?hint=tabdoc)"
                )),
            ],
            createdAt: Date(timeIntervalSince1970: 100)
        )

        let snapshot = TaskWorkbenchProjector.project(
            messages: [assistant],
            resources: [],
            currentRoute: nil,
            runState: .idle,
            agentName: "Kimi",
            completedTodoCount: 0,
            totalTodoCount: 0
        )

        XCTAssertEqual(snapshot.outputs.count, 1)
        XCTAssertEqual(snapshot.outputs.first?.resourceType, "tabdoc")
        XCTAssertEqual(snapshot.outputs.first?.resourceId, docId)
        XCTAssertEqual(snapshot.outputs.first?.title, "问候文档")
    }

    func testTaskWorkbenchExtractsCLIDocCreateJSONFromToolResult() throws {
        let docId = "a7adaa70-825c-4d04-9155-0f83acc850db"
        // 对齐 dogfood 快照：外层 terminal result + stdout 内嵌 document JSON。
        let stdoutObject: [String: Any] = [
            "ok": true,
            "data": [
                "document": [
                    "id": docId,
                    "title": "随手记",
                ],
            ],
        ]
        let stdoutData = try JSONSerialization.data(withJSONObject: stdoutObject)
        let stdout = try XCTUnwrap(String(data: stdoutData, encoding: .utf8))
        let resultObject: [String: Any] = [
            "status": "completed",
            "exit_code": 0,
            "stdout": stdout,
        ]
        let resultData = try JSONSerialization.data(withJSONObject: resultObject)
        let resultText = try XCTUnwrap(String(data: resultData, encoding: .utf8))

        let extracted = TaskWorkbenchCLIResourceExtractor.extract(from: resultText)
        XCTAssertEqual(extracted.count, 1)
        XCTAssertEqual(extracted.first?.resourceId, docId)
        XCTAssertEqual(extracted.first?.title, "随手记")

        var tool = ToolCall(
            toolCallId: "tu-doc-create",
            index: 0,
            name: "run_terminal_command",
            inputJson: #"{"command":"tabtin doc create --title \"随手记\" --format json"}"#,
            finalized: true
        )
        tool.resultText = resultText
        tool.executionPhase = .succeeded

        let assistant = ChatMessage(
            id: "assistant-cli-doc",
            role: .assistant,
            blocks: [.tool(tool)],
            createdAt: Date(timeIntervalSince1970: 100)
        )

        let snapshot = TaskWorkbenchProjector.project(
            messages: [assistant],
            resources: [],
            currentRoute: nil,
            runState: .idle,
            agentName: "Kimi",
            completedTodoCount: 0,
            totalTodoCount: 0
        )

        XCTAssertEqual(snapshot.outputs.count, 1)
        XCTAssertEqual(snapshot.outputs.first?.resourceType, "tabdoc")
        XCTAssertEqual(snapshot.outputs.first?.resourceId, docId)
        XCTAssertEqual(snapshot.outputs.first?.title, "随手记")
    }

    func testTaskWorkbenchIncludesSubagentResourceOutputsAndDeduplicatesWithParentOutput() {
        let authoritativeDocument = resource(
            itemType: "tabdoc",
            resourceId: "doc-1",
            title: "权威需求文档",
            preview: "资源接口摘要"
        )
        let parentMessage = ChatMessage(
            id: "assistant-parent",
            role: .assistant,
            blocks: [.richContent(richResource(
                type: "tabdoc",
                id: "doc-1",
                title: "父 Agent 临时标题"
            ))],
            createdAt: Date(timeIntervalSince1970: 100)
        )
        var subagent = SubagentRun.pending(runId: "subagent-1")
        subagent.endedAt = 300
        subagent.transcript = [
            SubagentTranscriptItem(
                id: "subagent-doc",
                messageId: "child-message-1",
                index: 0,
                kind: .richContent,
                title: nil,
                text: nil,
                inputText: nil,
                outputText: nil,
                isFinal: true,
                isError: false,
                toolCallId: nil,
                richContent: richResource(
                    type: "document",
                    id: "doc-1",
                    title: "子 Agent 临时标题"
                ),
                contextRef: nil
            ),
            SubagentTranscriptItem(
                id: "subagent-table",
                messageId: "child-message-2",
                index: 0,
                kind: .richContent,
                title: nil,
                text: nil,
                inputText: nil,
                outputText: nil,
                isFinal: true,
                isError: false,
                toolCallId: nil,
                richContent: richResource(
                    type: "tabdata",
                    id: "table-1",
                    title: "子 Agent 数据表"
                ),
                contextRef: nil
            ),
        ]

        let snapshot = TaskWorkbenchProjector.project(
            messages: [parentMessage],
            subagentRuns: [subagent],
            resources: [authoritativeDocument],
            currentRoute: nil,
            runState: .idle,
            agentName: "Codex",
            completedTodoCount: 0,
            totalTodoCount: 0
        )
        let outputsById = Dictionary(
            uniqueKeysWithValues: snapshot.outputs.map { ($0.id, $0) }
        )

        XCTAssertEqual(snapshot.outputs.count, 2)
        XCTAssertEqual(outputsById["tabdoc:doc-1"]?.title, "权威需求文档")
        XCTAssertEqual(outputsById["tabdoc:doc-1"]?.preview, "资源接口摘要")
        XCTAssertEqual(outputsById["tabdata:table-1"]?.title, "子 Agent 数据表")
    }

    func testTaskWorkbenchDeduplicatesOutputsAndProjectsLatestCheckpoint() {
        let earlier = ChatMessage(
            id: "assistant-1",
            role: .assistant,
            blocks: [.richContent(richResource(
                type: "tabdoc",
                id: "doc-1",
                title: "初稿"
            ))],
            createdAt: Date(timeIntervalSince1970: 100)
        )
        let checkpointRecord = ChatCheckpointRecord(
            checkpointId: "checkpoint-1",
            sessionId: "session-1",
            anchorType: "message",
            status: .ready,
            capabilityScope: ChatCheckpointCapabilityScope(
                messagePreview: true,
                fileDiff: true,
                fileRestore: true,
                resourceRestore: true,
                unrevert: false
            ),
            degradedReasons: nil,
            contextSummary: ChatCheckpointContextSummary(intentSummary: "完成工作台布局"),
            impactSummary: ChatCheckpointImpactSummary(
                fileSummary: ChatCheckpointFileSummary(
                    changed: 3,
                    insertions: 20,
                    deletions: 4,
                    files: nil
                )
            )
        )
        let later = ChatMessage(
            id: "assistant-2",
            role: .assistant,
            blocks: [.richContent(richResource(
                type: "tabdoc",
                id: "doc-1",
                title: "最终稿"
            ))],
            checkpointRecord: checkpointRecord,
            createdAt: Date(timeIntervalSince1970: 300)
        )

        let snapshot = TaskWorkbenchProjector.project(
            messages: [earlier, later],
            resources: [],
            currentRoute: nil,
            runState: .idle,
            agentName: "Codex",
            completedTodoCount: 2,
            totalTodoCount: 4
        )

        XCTAssertEqual(snapshot.outputs.map(\.title), ["最终稿"])
        XCTAssertEqual(snapshot.latestCheckpoint?.messageId, "assistant-2")
        XCTAssertEqual(snapshot.latestCheckpoint?.title, "完成工作台布局")
        XCTAssertEqual(snapshot.latestCheckpoint?.changedFileCount, 3)
        XCTAssertTrue(snapshot.latestCheckpoint?.canRestoreResources == true)
        XCTAssertEqual(snapshot.completedTodoCount, 2)
        XCTAssertEqual(snapshot.totalTodoCount, 4)
    }

    func testTaskWorkbenchOutputListCollapsesAfterFiveBars() {
        let items = (1...7).map { "item-\($0)" }
        XCTAssertEqual(TaskWorkbenchOutputListPolicy.collapsedVisibleCount, 5)
        XCTAssertEqual(
            TaskWorkbenchOutputListPolicy.visible(from: items, expanded: false),
            ["item-1", "item-2", "item-3", "item-4", "item-5"]
        )
        XCTAssertEqual(TaskWorkbenchOutputListPolicy.hiddenCount(total: items.count, expanded: false), 2)
        XCTAssertEqual(TaskWorkbenchOutputListPolicy.visible(from: items, expanded: true), items)
        XCTAssertEqual(TaskWorkbenchOutputListPolicy.hiddenCount(total: items.count, expanded: true), 0)
        XCTAssertEqual(TaskWorkbenchOutputListPolicy.hiddenCount(total: 4, expanded: false), 0)
    }

    func testTaskWorkbenchOutputUsesProductGlyphInsteadOfSystemImage() {
        let output = TaskWorkbenchOutput(
            id: "tabdoc:doc-1",
            resourceType: "tabdoc",
            resourceId: "doc-1",
            title: "需求文档",
            preview: nil,
            timestamp: Date(timeIntervalSince1970: 100),
            resource: nil,
            openRequest: SpaceResourceOpenRequest(
                resourceType: "tabdoc",
                resourceId: "doc-1",
                title: "需求文档",
                locationHint: nil
            )
        )

        XCTAssertEqual(output.iconReference, .asset("AppGlyphTabdoc"))
        XCTAssertEqual(
            TaskWorkbenchOutput(
                id: "tabdata:table-1",
                resourceType: "table",
                resourceId: "table-1",
                title: "线索表",
                preview: nil,
                timestamp: Date(timeIntervalSince1970: 100),
                resource: nil,
                openRequest: SpaceResourceOpenRequest(
                    resourceType: "tabdata",
                    resourceId: "table-1",
                    title: "线索表",
                    locationHint: nil
                )
            ).iconReference,
            .asset("AppGlyphTabdata")
        )
    }

    func testTaskWorkbenchWaitsForMetadataDependentResources() {
        let message = ChatMessage(
            id: "assistant-1",
            role: .assistant,
            blocks: [
                .richContent(richResource(type: "tabdoc", id: "doc-1", title: "文档")),
                .richContent(richResource(type: "tabsite", id: "site-1", title: "站点")),
                .richContent(richResource(type: "tabfiles", id: "files-1", title: "文件")),
            ],
            createdAt: Date(timeIntervalSince1970: 100)
        )

        let snapshot = TaskWorkbenchProjector.project(
            messages: [message],
            resources: [],
            currentRoute: nil,
            runState: .idle,
            agentName: "Codex",
            completedTodoCount: 0,
            totalTodoCount: 0
        )
        let outputsByType = Dictionary(
            uniqueKeysWithValues: snapshot.outputs.map { ($0.resourceType, $0) }
        )

        XCTAssertTrue(outputsByType["tabdoc"]?.canOpen == true)
        XCTAssertFalse(outputsByType["tabsite"]?.canOpen == true)
        XCTAssertTrue(outputsByType["tabfiles"]?.canOpen == true)
    }

    func testTaskWorkbenchCollectsConversationFilesWidgetsAndSlides() {
        let assistant = ChatMessage(
            id: "assistant-mixed-artifacts",
            role: .assistant,
            blocks: [
                .richContent(RichContentBlock(
                    index: 0,
                    kind: "file",
                    summary: "周报",
                    title: "周报.pdf",
                    groupId: nil,
                    tableRows: [],
                    tableSchema: nil,
                    footer: nil,
                    resourceType: nil,
                    resourceName: nil,
                    resourceId: nil,
                    spaceName: nil,
                    url: nil,
                    filename: "周报.pdf",
                    mimeType: "application/pdf",
                    fileSize: 1024,
                    totalRows: nil,
                    widgetId: nil,
                    format: nil,
                    sourceCode: nil,
                    mermaidSource: nil,
                    query: nil,
                    searchResults: [],
                    totalCount: nil,
                    fileId: "file-oss-1",
                    artifactKind: "oss_file"
                )),
                .richContent(RichContentBlock(
                    index: 1,
                    kind: "widget",
                    summary: "流程示意",
                    title: "流程示意",
                    groupId: nil,
                    tableRows: [],
                    tableSchema: nil,
                    footer: nil,
                    resourceType: nil,
                    resourceName: nil,
                    resourceId: nil,
                    spaceName: nil,
                    url: nil,
                    filename: nil,
                    mimeType: nil,
                    fileSize: nil,
                    totalRows: nil,
                    widgetId: "widget-1",
                    format: nil,
                    sourceCode: "graph TD; A-->B",
                    mermaidSource: nil,
                    query: nil,
                    searchResults: [],
                    totalCount: nil
                )),
                .richContent(richResource(type: "slide", id: "slide-1", title: "路演稿")),
                .text(TextBlock(
                    messageId: "assistant-mixed-artifacts",
                    index: 3,
                    text: "附件见 [采集表](tabtin://resource/file/file-from-link)"
                )),
            ],
            createdAt: Date(timeIntervalSince1970: 100)
        )

        let snapshot = TaskWorkbenchProjector.project(
            messages: [assistant],
            resources: [],
            currentRoute: nil,
            runState: .idle,
            agentName: "Kimi",
            completedTodoCount: 0,
            totalTodoCount: 0
        )

        XCTAssertEqual(
            Set(snapshot.outputs.map(\.id)),
            [
                "tabfiles:file-oss-1",
                "widget:widget-1",
                "tabslide:slide-1",
                "tabfiles:file-from-link",
            ]
        )
        XCTAssertTrue(snapshot.outputs.contains { $0.resourceId == "file-oss-1" && $0.canOpen })
        XCTAssertTrue(snapshot.outputs.contains { $0.resourceType == "widget" && !$0.canOpen })
    }

    func testTaskWorkbenchAppCatalogKeepsProductAppsAndFiltersSkillPacks() {
        let catalog = [
            TaskWorkbenchCatalogApp(
                id: "tabdoc",
                name: "Docs",
                icon: "file-text",
                description: "协作文档",
                surface: "collaborative",
                installed: true,
                order: 2
            ),
            TaskWorkbenchCatalogApp(
                id: "tabtin-research-pack",
                name: "Research Pack",
                icon: "search",
                description: "技能包",
                surface: nil,
                installed: true,
                order: 23
            ),
            TaskWorkbenchCatalogApp(
                id: "cowart",
                name: "Cowart",
                icon: "palette",
                description: "绘图扩展",
                surface: "local",
                installed: false,
                order: 21,
                mobileMode: "unsupported"
            ),
        ]

        let apps = TaskWorkbenchAppProjector.project(
            catalog: catalog,
            workspaceApps: nil,
            resources: []
        )

        // mobile unsupported 的本机扩展不进工作台总览（死入口）。
        XCTAssertEqual(apps.map(\.id), ["tabdoc"])
        XCTAssertEqual(
            TaskWorkbenchAppProjector.sections(from: apps).map(\.title),
            ["协作应用"]
        )
    }

    /// 产品未开放的 App 不能出现在移动端工作台：桌面硬门禁的两端都打不开，
    /// 软门禁里 iOS 又没有承载页的那几个则两条路都是死链；
    /// Agent / TabInbox / Desktop / TabMemo 也不应以应用磁贴出现在工作台。
    func testTaskWorkbenchAppCatalogHidesAppsWithoutAMobileEntry() {
        let hidden = [
            "tabsite", "tabslide", "tins", "tabwhiteboard", "tabvideo", "tabphone", "tabmail",
            "orchestration", "tabinbox", "tabdesktop", "tabmemo",
        ]
        let kept = ["tabdoc", "tabdata", "tabfiles", "tabweb"]
        let catalog = (hidden + kept).enumerated().map { index, appId in
            TaskWorkbenchCatalogApp(
                id: appId,
                name: appId,
                icon: "square",
                description: "",
                surface: "collaborative",
                installed: true,
                order: index
            )
        }

        let apps = TaskWorkbenchAppProjector.project(
            catalog: catalog,
            workspaceApps: nil,
            resources: []
        )

        XCTAssertEqual(apps.map(\.id), kept)
    }

    func testTaskWorkbenchAppVisibilityNormalizesCasingAndWhitespace() {
        XCTAssertTrue(TaskWorkbenchAppVisibility.isHidden(appId: "  TabSlide "))
        XCTAssertTrue(TaskWorkbenchAppVisibility.isHidden(appId: "Orchestration"))
        XCTAssertTrue(TaskWorkbenchAppVisibility.isHidden(appId: "tabinbox"))
        XCTAssertTrue(TaskWorkbenchAppVisibility.isHidden(appId: "tabdesktop"))
        // 对标 Electron DESKTOP_APPS_EXCLUDED_IDS：碎片笔记不用工作台磁贴呈现。
        XCTAssertTrue(TaskWorkbenchAppVisibility.isHidden(appId: "tabmemo"))
        XCTAssertTrue(TaskWorkbenchAppVisibility.isHidden(appId: "  TabMemo "))
    }

    func testTaskWorkbenchAppDisplayNameUsesChineseProductTitles() {
        XCTAssertEqual(
            TaskWorkbenchAppDisplayName.resolve(appId: "tabmemo", fallback: "Memo"),
            "笔记"
        )
        let catalog = [
            TaskWorkbenchCatalogApp(
                id: "tabdata",
                name: "Tables",
                icon: "table",
                description: "English description",
                surface: "collaborative",
                installed: true,
                order: 1
            ),
            TaskWorkbenchCatalogApp(
                id: "tabtracker",
                name: "Scheduled Tasks",
                icon: "clock",
                description: "",
                surface: "collaborative",
                installed: true,
                order: 2
            ),
        ]
        let apps = TaskWorkbenchAppProjector.project(
            catalog: catalog,
            workspaceApps: nil,
            resources: []
        )
        XCTAssertEqual(apps.map(\.name), ["多维表", "自动化"])
        XCTAssertEqual(apps.first(where: { $0.id == "tabdata" })?.surface, .collaborative)
        XCTAssertEqual(apps.first(where: { $0.id == "tabtracker" })?.surface, .builtin)
        XCTAssertTrue(
            apps.filter { $0.surface == .collaborative }
                .allSatisfy { $0.activation == .openAppHome }
        )
    }

    func testTaskWorkbenchAppActivationEntersAppHomeInsteadOfLatestResource() {
        let document = resource(
            itemType: "tabdoc",
            resourceId: "doc-1",
            title: "需求文档",
            updatedAt: "2026-07-29T10:00:00Z"
        )
        let catalog = [
            TaskWorkbenchCatalogApp(
                id: "tabdoc",
                name: "Docs",
                icon: "file-text",
                description: "协作文档",
                surface: "collaborative",
                installed: true,
                order: 2
            ),
            TaskWorkbenchCatalogApp(
                id: "tabweb",
                name: "Browser",
                icon: "globe",
                description: "网页浏览",
                surface: "builtin",
                installed: true,
                order: 7
            ),
        ]
        let workspaceApps = [
            TaskWorkbenchWorkspaceApp(
                id: "tabdoc",
                name: "Docs",
                icon: "file-text",
                canCreate: true,
                enabled: true,
                order: 2,
                desktopGroup: "cloudResources",
                surface: "collaborative"
            ),
            TaskWorkbenchWorkspaceApp(
                id: "tabweb",
                name: "Browser",
                icon: "globe",
                canCreate: true,
                enabled: true,
                order: 7,
                desktopGroup: "capabilities",
                surface: "builtin"
            ),
        ]

        let apps = TaskWorkbenchAppProjector.project(
            catalog: catalog,
            workspaceApps: workspaceApps,
            resources: [document, resource(id: "i2", itemType: "tabdoc", resourceId: "doc-2")]
        )
        let appsById = Dictionary(uniqueKeysWithValues: apps.map { ($0.id, $0) })
        guard let tabdoc = appsById["tabdoc"], let tabweb = appsById["tabweb"] else {
            return XCTFail("目录投影应保留两个 App")
        }

        XCTAssertEqual(tabdoc.activation, .openAppHome)
        XCTAssertEqual(tabdoc.actionLabel, "进入 · 2 项")
        // 最近那条资源降级成提示，不再是点卡片的落点。
        XCTAssertEqual(tabdoc.recentResourceHint, "最近：需求文档")
        XCTAssertEqual(tabdoc.recentResource?.resourceId, "doc-1")

        if case .requestAgent = tabweb.activation {
            XCTAssertEqual(tabweb.actionLabel, "让 Agent 新建")
        } else {
            XCTFail("iOS 没有承载页的已启用 App 应转成 Agent 请求")
        }
        XCTAssertNil(tabweb.recentResourceHint)
        XCTAssertEqual(
            TaskWorkbenchAppProjector.quickStartApps(from: apps).map(\.id),
            ["tabdoc", "tabweb"]
        )
    }

    /// 一条资源都没有时主操作仍是进首页（首页负责空态引导），措辞不再带数量。
    func testTaskWorkbenchAppHomeStaysPrimaryActionWithoutAnyResource() {
        let catalog = [
            TaskWorkbenchCatalogApp(
                id: "tabdoc",
                name: "Docs",
                icon: "file-text",
                description: "协作文档",
                surface: "collaborative",
                installed: true,
                order: 2
            ),
        ]
        let workspaceApps = [
            TaskWorkbenchWorkspaceApp(
                id: "tabdoc",
                name: "Docs",
                icon: "file-text",
                canCreate: true,
                enabled: true,
                order: 2,
                desktopGroup: "cloudResources",
                surface: "collaborative"
            ),
        ]

        let apps = TaskWorkbenchAppProjector.project(
            catalog: catalog,
            workspaceApps: workspaceApps,
            resources: []
        )

        guard let tabdoc = apps.first else { return XCTFail("应保留 tabdoc") }
        XCTAssertEqual(tabdoc.activation, .openAppHome)
        XCTAssertEqual(tabdoc.resourceCount, 0)
        XCTAssertEqual(tabdoc.actionLabel, "进入")
        XCTAssertNil(tabdoc.recentResourceHint)
        XCTAssertEqual(tabdoc.agentActionTitle, "让 Agent 新建")
    }


    func testTaskWorkbenchMobileModeGatesAppHomeActivation() {
        let catalog = [
            TaskWorkbenchCatalogApp(
                id: "tabfiles",
                name: "Files",
                icon: "folder",
                description: "",
                surface: "collaborative",
                installed: true,
                order: 1,
                mobileMode: "full"
            ),
            TaskWorkbenchCatalogApp(
                id: "tabtin-demo-app",
                name: "Demo",
                icon: "sparkles",
                description: "",
                surface: "collaborative",
                installed: true,
                order: 2,
                mobileMode: "unsupported"
            ),
            TaskWorkbenchCatalogApp(
                id: "tabdoc",
                name: "Docs",
                icon: "file-text",
                description: "",
                surface: "collaborative",
                installed: true,
                order: 3,
                mobileMode: nil
            ),
        ]
        let workspaceApps = catalog.map {
            TaskWorkbenchWorkspaceApp(
                id: $0.id,
                name: $0.name,
                icon: $0.icon,
                canCreate: true,
                enabled: true,
                order: $0.order,
                desktopGroup: "cloudResources",
                surface: "collaborative"
            )
        }
        let apps = TaskWorkbenchAppProjector.project(
            catalog: catalog,
            workspaceApps: workspaceApps,
            resources: []
        )
        let byId = Dictionary(uniqueKeysWithValues: apps.map { ($0.id, $0) })

        XCTAssertEqual(byId["tabfiles"]?.activation, .openAppHome)
        XCTAssertEqual(byId["tabdoc"]?.activation, .openAppHome)
        XCTAssertNil(byId["tabtin-demo-app"], "unsupported mobile_mode 应从工作台目录移除")
        XCTAssertTrue(TaskWorkbenchMobileRuntime.isBlocked("unsupported"))
        XCTAssertFalse(TaskWorkbenchMobileRuntime.isBlocked(nil))
        // MemoAppHome 能力仍在；仅工作台磁贴隐藏，runtime 门禁不变。
        XCTAssertTrue(TaskWorkbenchMobileRuntime.allowsAppHome("full", appId: "tabmemo"))
        XCTAssertTrue(TaskWorkbenchMobileRuntime.allowsAppHome(nil, appId: "tabdoc"))
        XCTAssertFalse(TaskWorkbenchMobileRuntime.allowsAppHome("unsupported", appId: "x"))
    }

    @MainActor
    func testWorkbenchAppHomeKeepsResourceDetailAboveItAndClearsOnScopeChange() {
        let state = WorkbenchNavigationState()
        let app = TaskWorkbenchApp(
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
        state.prepare(for: "s1")

        state.showAppHome(app)
        XCTAssertEqual(state.appHome?.id, "tabdoc")
        XCTAssertTrue(state.path.isEmpty)

        // 从首页打开一条资源后返回，应落回首页而不是直接回到工作台。
        state.show(.tabdoc(documentId: "doc-1", documentName: "需求文档"))
        XCTAssertEqual(state.path.count, 1, "资源详情压在 App 首页之上")
        XCTAssertEqual(state.appHome?.id, "tabdoc", "打开详情不应清掉 App 首页")
        state.closeResource()
        XCTAssertTrue(state.path.isEmpty)
        XCTAssertEqual(state.appHome?.id, "tabdoc")

        // 多维表同路径：App home → path → back 仍在 App home。
        let tableApp = TaskWorkbenchApp(
            id: "tabdata",
            name: "Tables",
            description: "多维表",
            manifestIcon: "table",
            surface: .collaborative,
            installed: true,
            workspaceAvailable: true,
            enabled: true,
            canCreate: true,
            order: 3,
            recentResource: nil,
            resourceCount: 1
        )
        state.closeAppHome()
        state.showAppHome(tableApp)
        state.show(.tabdata(tableId: "tbl-1", tableName: "线索表"))
        state.closeResource()
        XCTAssertTrue(state.path.isEmpty)
        XCTAssertEqual(state.appHome?.id, "tabdata")

        state.closeAppHome()
        XCTAssertNil(state.appHome)

        state.showAppHome(app)
        state.prepare(for: "s2")
        XCTAssertNil(state.appHome)
    }

    func testTaskWorkbenchAppActivationExplainsDisabledOrUnsupportedWorkspaceApps() {
        let catalog = [
            TaskWorkbenchCatalogApp(
                id: "tabfiles",
                name: "Files",
                icon: "folder",
                description: "",
                surface: "collaborative",
                installed: true,
                order: 13
            ),
            TaskWorkbenchCatalogApp(
                id: "terminal",
                name: "Terminal",
                icon: "terminal",
                description: "",
                surface: "builtin",
                installed: true,
                order: 9
            ),
        ]
        let workspaceApps = [
            TaskWorkbenchWorkspaceApp(
                id: "tabfiles",
                name: "Files",
                icon: "folder",
                canCreate: true,
                enabled: false,
                order: 13,
                desktopGroup: "cloudResources",
                surface: "collaborative"
            ),
        ]

        let apps = TaskWorkbenchAppProjector.project(
            catalog: catalog,
            workspaceApps: workspaceApps,
            resources: []
        )
        let appsById = Dictionary(uniqueKeysWithValues: apps.map { ($0.id, $0) })

        XCTAssertEqual(appsById["tabfiles"]?.actionLabel, "未启用")
        XCTAssertEqual(appsById["terminal"]?.actionLabel, "暂不支持")
        XCTAssertTrue(TaskWorkbenchAppProjector.quickStartApps(from: apps).isEmpty)
    }

    func testTaskWorkbenchCatalogSuccessWithUnknownWorkspaceStatusIsNotActionable() {
        let catalog = [
            TaskWorkbenchCatalogApp(
                id: "tabdoc",
                name: "Docs",
                icon: "file-text",
                description: "协作文档",
                surface: "collaborative",
                installed: true,
                order: 2
            ),
        ]
        let apps = TaskWorkbenchAppProjector.project(
            catalog: catalog,
            workspaceApps: nil,
            resources: [
                resource(
                    itemType: "tabdoc",
                    resourceId: "doc-1",
                    title: "需求文档",
                    updatedAt: "2026-07-29T10:00:00Z"
                ),
            ]
        )

        guard let app = apps.first else {
            return XCTFail("目录成功时仍应展示 App")
        }
        XCTAssertEqual(app.actionLabel, "状态未知")
        XCTAssertTrue(TaskWorkbenchAppProjector.quickStartApps(from: apps).isEmpty)
        if case let .unavailable(message) = app.activation {
            XCTAssertTrue(message.contains("应用状态暂不可确认"))
        } else {
            XCTFail("Workspace Apps 失败时不得打开资源或转成 Agent 请求")
        }
    }

    private func richResource(
        type: String,
        id: String,
        title: String
    ) -> RichContentBlock {
        RichContentBlock(
            index: 0,
            kind: "resource_ref",
            summary: title,
            title: title,
            groupId: nil,
            tableRows: [],
            tableSchema: nil,
            footer: nil,
            resourceType: type,
            resourceName: title,
            resourceId: id,
            spaceName: nil,
            url: nil,
            filename: nil,
            mimeType: nil,
            fileSize: nil,
            totalRows: nil,
            widgetId: nil,
            format: nil,
            sourceCode: nil,
            mermaidSource: nil,
            query: nil,
            searchResults: [],
            totalCount: nil
        )
    }

    func testDecodesLastVisitedAt() throws {
        let json = """
        {
          "id": "11111111-1111-1111-1111-111111111111",
          "item_type": "tabdoc",
          "title": "竞品调研",
          "resource_id": "doc-1",
          "space_id": "ws-1",
          "organization_id": "org-1",
          "is_pinned": false,
          "updated_at": "2026-07-28T10:00:00Z",
          "last_visited_at": "2026-07-30T09:12:00Z"
        }
        """
        let resource = try JSONDecoder().decode(SpaceResource.self, from: Data(json.utf8))
        XCTAssertEqual(resource.lastVisitedAt, "2026-07-30T09:12:00Z")
    }

    func testLastVisitedAtIsNilWhenAbsent() throws {
        let json = """
        {
          "id": "22222222-2222-2222-2222-222222222222",
          "item_type": "tabdata",
          "title": "渠道数据看板",
          "resource_id": "table-1",
          "updated_at": "2026-07-28T10:00:00Z"
        }
        """
        let resource = try JSONDecoder().decode(SpaceResource.self, from: Data(json.utf8))
        XCTAssertNil(resource.lastVisitedAt)
    }

    /// 置顶切换会整体重建资源，访问时间不能在这条路径上被悄悄清空，
    /// 否则「最近」分段会因为用户点了个置顶就把这条资源排掉。
    func testWithPinnedPreservesLastVisitedAt() throws {
        let json = """
        {
          "id": "33333333-3333-3333-3333-333333333333",
          "item_type": "tabdoc",
          "title": "竞品调研",
          "resource_id": "doc-1",
          "is_pinned": false,
          "last_visited_at": "2026-07-30T09:12:00Z"
        }
        """
        let resource = try JSONDecoder().decode(SpaceResource.self, from: Data(json.utf8))

        XCTAssertEqual(resource.withPinned(true).lastVisitedAt, "2026-07-30T09:12:00Z")
        XCTAssertEqual(resource.withPinned(false).lastVisitedAt, "2026-07-30T09:12:00Z")
    }

    /// 「最近」分段按 `lastVisitedAt` 排序，它必须落在 Equatable 的可见范围内：
    /// 漏掉它，SwiftUI 数组 diff / `.onChange(of:)` / 按值去重都看不见访问时间变化，
    /// 乐观更新会静默丢失，表现成「点进去再回来顺序没动」。
    func testEqualityDistinguishesLastVisitedAt() {
        let unvisited = resource(itemType: "tabdoc")
        var visited = unvisited
        visited.lastVisitedAt = "2026-07-30T09:12:00Z"

        XCTAssertNotEqual(visited, unvisited)

        var revisited = visited
        revisited.lastVisitedAt = "2026-07-30T10:00:00Z"
        XCTAssertNotEqual(visited, revisited)

        // hash(into:) 只 combine id，收紧 == 不破坏「相等 ⇒ 同哈希」。
        XCTAssertEqual(visited.hashValue, unvisited.hashValue)
    }

    func testContextItemAccessEndpointPath() {
        XCTAssertEqual(
            Endpoints.Context.contextItemAccess("abc-123"),
            "/context/context-items/abc-123/access"
        )
    }
}

@MainActor
private final class CloudResourceTestLoadGate {
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        await withCheckedContinuation { continuation = $0 }
    }

    func resume() {
        continuation?.resume()
        continuation = nil
    }
}
