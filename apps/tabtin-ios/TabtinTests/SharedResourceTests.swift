import XCTest
@testable import Tabtin

final class SharedResourceTests: XCTestCase {
    func testDecodesSharedDocRow() throws {
        let json = """
        {
          "resource_type": "doc",
          "document_id": "doc-9",
          "title": "客户案例库",
          "icon": "",
          "organization_id": "org-1",
          "space_id": "ws-2",
          "permission": "editor",
          "updated_at": "2026-07-25T08:00:00+00:00",
          "shared_by": { "id": "u-1", "display_name": "李工", "avatar": "" }
        }
        """
        let row = try JSONDecoder().decode(SharedDocRow.self, from: Data(json.utf8))
        let item = row.asSharedResourceItem()
        XCTAssertEqual(item.id, "shared:doc:doc-9")
        XCTAssertEqual(item.resourceType, .doc)
        XCTAssertEqual(item.title, "客户案例库")
        XCTAssertEqual(item.sharedBy?.displayName, "李工")
        XCTAssertEqual(item.spaceId, "ws-2")
    }

    func testDecodesSharedTableRow() throws {
        let json = """
        {
          "resource_type": "table",
          "table_id": "table-9",
          "title": "竞品功能对照表",
          "icon": "",
          "organization_id": "org-1",
          "space_id": "",
          "permission": "viewer",
          "updated_at": null,
          "shared_by": null
        }
        """
        let row = try JSONDecoder().decode(SharedTableRow.self, from: Data(json.utf8))
        let item = row.asSharedResourceItem()
        XCTAssertEqual(item.id, "shared:table:table-9")
        XCTAssertEqual(item.resourceType, .table)
        XCTAssertNil(item.sharedBy)
        // 后端 org-only 分享时 space_id 返回空串，归一成 nil 避免下游误当有效 ID
        XCTAssertNil(item.spaceId)
    }

    func testSharedItemAppRoute() {
        let doc = SharedResourceItem(
            resourceType: .doc,
            resourceId: "doc-1",
            title: "路线图",
            organizationId: "org-1",
            spaceId: nil,
            permission: "editor",
            updatedAt: nil,
            sharedBy: nil
        )
        guard case let .tabdoc(documentId, documentName)? = doc.appRoute else {
            return XCTFail("文档分享项应产出 tabdoc 路由")
        }
        XCTAssertEqual(documentId, "doc-1")
        XCTAssertEqual(documentName, "路线图")

        let table = SharedResourceItem(
            resourceType: .table,
            resourceId: "table-1",
            title: "看板",
            organizationId: "org-1",
            spaceId: nil,
            permission: "viewer",
            updatedAt: nil,
            sharedBy: nil
        )
        guard case let .tabdata(tableId, _)? = table.appRoute else {
            return XCTFail("表格分享项应产出 tabdata 路由")
        }
        XCTAssertEqual(tableId, "table-1")
    }

    func testMergeSortsByUpdatedAtDescending() {
        let older = SharedResourceItem(
            resourceType: .doc, resourceId: "a", title: "A", organizationId: "org-1",
            spaceId: nil, permission: "viewer", updatedAt: "2026-07-01T00:00:00+00:00", sharedBy: nil
        )
        let newer = SharedResourceItem(
            resourceType: .table, resourceId: "b", title: "B", organizationId: "org-1",
            spaceId: nil, permission: "viewer", updatedAt: "2026-07-20T00:00:00+00:00", sharedBy: nil
        )
        let undated = SharedResourceItem(
            resourceType: .doc, resourceId: "c", title: "C", organizationId: "org-1",
            spaceId: nil, permission: "viewer", updatedAt: nil, sharedBy: nil
        )
        let merged = SharedResourcesService.merged(docs: [older, undated], tables: [newer])
        XCTAssertEqual(merged.map(\.resourceId), ["b", "a", "c"])
    }

    func testSharedWithMeEndpointPaths() {
        XCTAssertEqual(Endpoints.TabDoc.sharedWithMe, "/tabdoc/shared-with-me")
        XCTAssertEqual(Endpoints.TabData.sharedWithMe, "/tabdata/shared-with-me")
    }

    func testOnlyHTTP404TriggersRouteFallback() {
        XCTAssertTrue(APIError.serverError(404, "Not found").isHTTPNotFound)
        XCTAssertFalse(APIError.serverError(403, "Forbidden").isHTTPNotFound)
        XCTAssertFalse(APIError.serverError(500, "Server error").isHTTPNotFound)
        XCTAssertFalse(APIError.apiErrorWithCode(code: "NOT_FOUND", message: "业务对象不存在").isHTTPNotFound)
    }

    // MARK: - 合并与排序
    //
    // 这一节只覆盖 `merged` 的数组拼接与排序。降级判定在 `resolve`，见下方「降级判定」。

    /// 两个空数组合并出空列表，不应报错。
    func testMergeOfTwoEmptyArraysYieldsEmpty() {
        XCTAssertTrue(SharedResourcesService.merged(docs: [], tables: []).isEmpty)
    }

    /// 一边为空数组时，另一边的结果必须完整保留、不被吞掉。
    func testMergeKeepsAllItemsWhenOneArrayIsEmpty() {
        let doc = SharedResourceItem(
            resourceType: .doc, resourceId: "a", title: "A", organizationId: "org-1",
            spaceId: nil, permission: "viewer", updatedAt: "2026-07-01T00:00:00+00:00", sharedBy: nil
        )
        XCTAssertEqual(SharedResourcesService.merged(docs: [doc], tables: []).map(\.resourceId), ["a"])
        XCTAssertEqual(SharedResourcesService.merged(docs: [], tables: [doc]).map(\.resourceId), ["a"])
    }

    /// 更新时间相同时按标题升序，保证列表顺序稳定、不随两个来源的返回时序抖动。
    func testMergeBreaksTiesByTitle() {
        let sameTime = "2026-07-20T00:00:00+00:00"
        let bravo = SharedResourceItem(
            resourceType: .doc, resourceId: "b", title: "Bravo", organizationId: "org-1",
            spaceId: nil, permission: "viewer", updatedAt: sameTime, sharedBy: nil
        )
        let alpha = SharedResourceItem(
            resourceType: .table, resourceId: "a", title: "Alpha", organizationId: "org-1",
            spaceId: nil, permission: "viewer", updatedAt: sameTime, sharedBy: nil
        )
        XCTAssertEqual(
            SharedResourcesService.merged(docs: [bravo], tables: [alpha]).map(\.resourceId),
            ["a", "b"]
        )
    }

    /// 后端时间戳带小数秒时也要能解析，否则会被当成「无时间」排到最后。
    func testMergeParsesFractionalSecondTimestamps() {
        let fractional = SharedResourceItem(
            resourceType: .doc, resourceId: "frac", title: "A", organizationId: "org-1",
            spaceId: nil, permission: "viewer", updatedAt: "2026-07-20T00:00:00.123Z", sharedBy: nil
        )
        let plain = SharedResourceItem(
            resourceType: .doc, resourceId: "plain", title: "B", organizationId: "org-1",
            spaceId: nil, permission: "viewer", updatedAt: "2026-07-01T00:00:00Z", sharedBy: nil
        )
        XCTAssertNotNil(ISO8601DateParser.date(from: "2026-07-20T00:00:00.123Z"))
        XCTAssertEqual(
            SharedResourcesService.merged(docs: [plain, fractional], tables: []).map(\.resourceId),
            ["frac", "plain"]
        )
    }

    /// 标题为空时回退到「未命名」，且路由名不会是空串。
    func testEmptyTitleFallsBackToDisplayTitle() {
        let item = SharedResourceItem(
            resourceType: .doc, resourceId: "doc-1", title: "", organizationId: "org-1",
            spaceId: nil, permission: "viewer", updatedAt: nil, sharedBy: nil
        )
        XCTAssertFalse(item.displayTitle.isEmpty)
        guard case let .tabdoc(_, documentName)? = item.appRoute else {
            return XCTFail("文档分享项应产出 tabdoc 路由")
        }
        XCTAssertFalse(documentName.isEmpty)
    }

    /// resourceId 缺失的脏数据不产出路由，避免点开一个打不开的空白页。
    func testMissingResourceIdHasNoRoute() {
        let item = SharedResourceItem(
            resourceType: .table, resourceId: "", title: "坏数据", organizationId: "org-1",
            spaceId: nil, permission: "viewer", updatedAt: nil, sharedBy: nil
        )
        XCTAssertNil(item.appRoute)
    }

    /// space_id 只有空白字符时同样归一成 nil。
    func testWhitespaceOnlySpaceIdNormalizesToNil() {
        XCTAssertNil(SharedResourceNormalizer.normalizedId("   "))
        XCTAssertNil(SharedResourceNormalizer.normalizedId(nil))
        XCTAssertEqual(SharedResourceNormalizer.normalizedId(" ws-2 "), "ws-2")
    }

    // MARK: - 脏数据容错

    /// 后端表格端点显式允许 `organization_id` 为 null。一行 null 不能把整批打掉——
    /// 否则整个表格来源会被判成失败降级为空，用户一张表都看不到。
    func testNullOrganizationIdDoesNotDropTheWholeBatch() throws {
        let tablesJSON = """
        {
          "tables": [
            { "table_id": "t-1", "title": "组织外表格", "organization_id": null, "permission": null },
            { "table_id": "t-2", "title": "正常表格", "organization_id": "org-1", "permission": "viewer" }
          ]
        }
        """
        let tables = try JSONDecoder().decode(SharedTablesResponse.self, from: Data(tablesJSON.utf8))
        XCTAssertEqual(tables.tables?.map(\.tableId), ["t-1", "t-2"])
        XCTAssertEqual(tables.tables?.first?.organizationId, "")
        XCTAssertEqual(tables.tables?.first?.permission, "")

        // 文档端点同理：字段整个缺失也走同一条降级。
        let docsJSON = """
        { "documents": [{ "document_id": "d-1", "title": "缺字段文档" }] }
        """
        let docs = try JSONDecoder().decode(SharedDocsResponse.self, from: Data(docsJSON.utf8))
        XCTAssertEqual(docs.documents?.first?.organizationId, "")
        XCTAssertEqual(docs.documents?.first?.permission, "")
    }

    /// 端点的过滤条件是 `if organization_id`：传空串等于不过滤，会返回其他组织的分享项。
    /// 所以空 organization_id 必须在发请求之前就被拒绝。
    func testBlankOrganizationIdIsRejectedBeforeAnyRequest() async {
        do {
            _ = try await SharedResourcesService.listSharedWithMe(organizationId: "   ")
            XCTFail("空 organization_id 必须直接抛错，不能发请求")
        } catch {
            XCTAssertEqual((error as? APIError)?.errorDescription, L10n.CloudDocs.sharedLoadFailed)
        }
    }

    // MARK: - 降级判定

    /// 两边都挂：向上抛，让页面显示加载失败，而不是假装「没人分享给我」。
    func testResolveThrowsWhenBothSourcesFailed() {
        XCTAssertThrowsError(try SharedResourcesService.resolve(docs: nil, tables: nil)) { error in
            XCTAssertEqual((error as? APIError)?.errorDescription, L10n.CloudDocs.sharedLoadFailed)
        }
    }

    /// 文档挂了、表格活着：只丢文档，表格必须照常出现。
    func testResolveKeepsTablesWhenDocsFailed() throws {
        let tables = try decodeTables(ids: ["t-1"])
        let items = try SharedResourcesService.resolve(docs: nil, tables: tables)
        XCTAssertEqual(items.map(\.resourceId), ["t-1"])
    }

    /// 表格挂了、文档活着：反向同理。
    func testResolveKeepsDocsWhenTablesFailed() throws {
        let docs = try decodeDocs(ids: ["d-1"])
        let items = try SharedResourcesService.resolve(docs: docs, tables: nil)
        XCTAssertEqual(items.map(\.resourceId), ["d-1"])
    }

    /// 两边都活着：合并两个来源；都返回空也只是空列表，不报错。
    func testResolveMergesBothSourcesAndAllowsEmptyResult() throws {
        let items = try SharedResourcesService.resolve(
            docs: decodeDocs(ids: ["d-1"]),
            tables: decodeTables(ids: ["t-1"])
        )
        XCTAssertEqual(Set(items.map(\.resourceId)), ["d-1", "t-1"])

        XCTAssertTrue(
            try SharedResourcesService.resolve(
                docs: decodeDocs(ids: []),
                tables: SharedTablesResponse(tables: nil)
            ).isEmpty
        )
    }

    // 这两个夹具用完整字段，好让 resolve 的用例只在判定降级，不牵连解码容错。
    private func decodeDocs(ids: [String]) throws -> SharedDocsResponse {
        let rows = ids.map {
            #"{ "document_id": "\#($0)", "title": "\#($0)", "organization_id": "org-1", "permission": "viewer" }"#
        }
        return try JSONDecoder().decode(
            SharedDocsResponse.self,
            from: Data(#"{ "documents": [\#(rows.joined(separator: ","))] }"#.utf8)
        )
    }

    private func decodeTables(ids: [String]) throws -> SharedTablesResponse {
        let rows = ids.map {
            #"{ "table_id": "\#($0)", "title": "\#($0)", "organization_id": "org-1", "permission": "viewer" }"#
        }
        return try JSONDecoder().decode(
            SharedTablesResponse.self,
            from: Data(#"{ "tables": [\#(rows.joined(separator: ","))] }"#.utf8)
        )
    }
}
