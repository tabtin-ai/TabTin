import XCTest
@testable import Tabtin

final class CloudDocsShareTests: XCTestCase {

    func testDecodesCollaboratorListContract() throws {
        let json = """
        {"owner":{"user_id":"owner","nickname":"Owner","avatar":"https://example.com/o.png","email":"o@example.com"},"collaborators":[{"user_id":"member","nickname":"Member","email":"m@example.com","permission":"editor"}]}
        """
        let response = try JSONDecoder().decode(CloudDocsCollaboratorList.self, from: Data(json.utf8))
        XCTAssertEqual(response.owner?.userId, "owner")
        XCTAssertEqual(response.owner?.avatar, "https://example.com/o.png")
        XCTAssertEqual(response.collaborators.first?.userId, "member")
        XCTAssertEqual(response.collaborators.first?.permission, "editor")
        XCTAssertEqual(response.collaborators.first?.canEdit, true)
    }

    func testCollaboratorEditAccessUsesCollaboratorWireContract() {
        let editor = CloudDocsCollaborator(
            userId: "editor",
            nickname: "Editor",
            avatar: nil,
            email: "editor@example.com",
            permission: "editor"
        )
        let viewer = CloudDocsCollaborator(
            userId: "viewer",
            nickname: "Viewer",
            avatar: nil,
            email: "viewer@example.com",
            permission: "viewer"
        )
        let admin = CloudDocsCollaborator(
            userId: "admin",
            nickname: "Admin",
            avatar: nil,
            email: "admin@example.com",
            permission: "admin"
        )

        XCTAssertTrue(editor.canEdit)
        XCTAssertTrue(admin.canEdit)
        XCTAssertFalse(viewer.canEdit)
    }

    func testCollaboratorListStillDecodesWhenOlderServerOmitsOwner() throws {
        let json = #"{"collaborators":[]}"#
        let response = try JSONDecoder().decode(CloudDocsCollaboratorList.self, from: Data(json.utf8))
        XCTAssertNil(response.owner)
        XCTAssertTrue(response.collaborators.isEmpty)
    }

    // MARK: - anyoneWireValue（最易错：公网 share_type 不对称）

    func testAnyoneWireValueIsAsymmetric() {
        XCTAssertEqual(CloudShareResourceType.document.anyoneWireValue, "public")
        XCTAssertEqual(CloudShareResourceType.table.anyoneWireValue, "data")
    }

    // MARK: - Scope 往返

    func testScopeWireRoundTripForDocument() {
        XCTAssertEqual(
            CloudShareScope.organization.wireValue(for: .document),
            "organization"
        )
        XCTAssertEqual(
            CloudShareScope.anyone.wireValue(for: .document),
            "public"
        )
        XCTAssertEqual(
            CloudShareScope.from(wireValue: "organization", type: .document),
            .organization
        )
        XCTAssertEqual(
            CloudShareScope.from(wireValue: "public", type: .document),
            .anyone
        )
        // table 的公网值用在 doc 上应保守退回 organization
        XCTAssertEqual(
            CloudShareScope.from(wireValue: "data", type: .document),
            .organization
        )
    }

    func testScopeWireRoundTripForTable() {
        XCTAssertEqual(
            CloudShareScope.anyone.wireValue(for: .table),
            "data"
        )
        XCTAssertEqual(
            CloudShareScope.from(wireValue: "data", type: .table),
            .anyone
        )
        XCTAssertEqual(
            CloudShareScope.from(wireValue: "organization", type: .table),
            .organization
        )
        // doc 的公网值用在 table 上应保守退回 organization
        XCTAssertEqual(
            CloudShareScope.from(wireValue: "public", type: .table),
            .organization
        )
    }

    func testScopeFromUnknownWireValueFallsBackToOrganization() {
        XCTAssertEqual(
            CloudShareScope.from(wireValue: "form", type: .document),
            .organization
        )
        XCTAssertEqual(
            CloudShareScope.from(wireValue: "", type: .table),
            .organization
        )
        XCTAssertEqual(
            CloudShareScope.from(wireValue: "unknown", type: .table),
            .organization
        )
    }

    // MARK: - Permissions / type parse

    func testAvailablePermissionsTableOmitsComment() {
        XCTAssertEqual(
            CloudShareResourceType.document.availablePermissions,
            [.view, .comment, .edit]
        )
        XCTAssertEqual(
            CloudShareResourceType.table.availablePermissions,
            [.view, .edit]
        )
        XCTAssertFalse(
            CloudShareResourceType.table.availablePermissions.contains(.comment)
        )
    }

    func testFromNormalizedType() {
        XCTAssertEqual(CloudShareResourceType.from(normalizedType: "tabdoc"), .document)
        XCTAssertEqual(CloudShareResourceType.from(normalizedType: "tabdata"), .table)
        XCTAssertNil(CloudShareResourceType.from(normalizedType: "tabfiles"))
        XCTAssertNil(CloudShareResourceType.from(normalizedType: ""))
        XCTAssertNil(CloudShareResourceType.from(normalizedType: "doc"))
        XCTAssertNil(CloudShareResourceType.from(normalizedType: "TABDOC"))
    }

    // MARK: - publicURL

    func testPublicURLPathSegmentsAndShareId() throws {
        let docURL = try XCTUnwrap(
            CloudDocsShareService.publicURL(shareId: "share-doc-1", type: .document)
        )
        XCTAssertTrue(docURL.absoluteString.contains("/shared/docs/share-doc-1"))
        XCTAssertFalse(docURL.absoluteString.contains("/shared/tables/"))

        let tableURL = try XCTUnwrap(
            CloudDocsShareService.publicURL(shareId: "share-table-9", type: .table)
        )
        XCTAssertTrue(tableURL.absoluteString.contains("/shared/tables/share-table-9"))
        XCTAssertFalse(tableURL.absoluteString.contains("/shared/docs/"))
    }

    func testPublicURLRejectsEmptyShareId() {
        XCTAssertNil(CloudDocsShareService.publicURL(shareId: "", type: .document))
        XCTAssertNil(CloudDocsShareService.publicURL(shareId: "   ", type: .table))
    }

    func testPublicPathSegment() {
        XCTAssertEqual(CloudShareResourceType.document.publicPathSegment, "docs")
        XCTAssertEqual(CloudShareResourceType.table.publicPathSegment, "tables")
    }

    // MARK: - Decoding

    func testDecodesCloudDocShareWithOptionalFieldsMissing() throws {
        // 刻意不带 visit_count / expire_at / organization_id / is_active / created_at
        // （也没有不存在的 expire_count）——缺省不应炸。
        let json = """
        {
          "share_id": "sh-1",
          "share_type": "organization",
          "permission": "view",
          "has_password": false
        }
        """
        let share = try JSONDecoder().decode(CloudDocShare.self, from: Data(json.utf8))
        XCTAssertEqual(share.shareId, "sh-1")
        XCTAssertEqual(share.shareType, "organization")
        XCTAssertEqual(share.permission, "view")
        XCTAssertFalse(share.hasPassword)
        XCTAssertNil(share.expireAt)
        XCTAssertNil(share.organizationId)
        XCTAssertNil(share.visitCount)
        XCTAssertTrue(share.isActive)
        XCTAssertNil(share.createdAt)
    }

    func testDecodesCloudDocShareFullFields() throws {
        let json = """
        {
          "share_id": "sh-2",
          "share_type": "public",
          "permission": "edit",
          "has_password": true,
          "expire_at": "2026-08-01T00:00:00+00:00",
          "organization_id": "org-1",
          "visit_count": 12,
          "is_active": true,
          "created_at": "2026-07-30T00:00:00+00:00",
          "allow_download": true,
          "allow_copy": false
        }
        """
        let share = try JSONDecoder().decode(CloudDocShare.self, from: Data(json.utf8))
        XCTAssertEqual(share.shareId, "sh-2")
        XCTAssertEqual(share.shareType, "public")
        XCTAssertEqual(share.visitCount, 12)
        XCTAssertEqual(share.organizationId, "org-1")
        XCTAssertTrue(share.hasPassword)
        XCTAssertTrue(share.isActive)
    }

    func testDecodesFetchResponseWhenShareNull() throws {
        let json = """
        { "share": null, "enabled": false }
        """
        let response = try JSONDecoder().decode(
            CloudDocShareFetchResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertNil(response.share)
        XCTAssertEqual(response.enabled, false)
    }

    // MARK: - Error mapping（钉住 APIClient 实际抛出的形态）

    func testMapAPIErrorForbiddenFromServerError403() {
        let mapped = CloudDocsShareService.mapAPIError(
            APIError.serverError(403, "nope")
        )
        guard case CloudDocsShareError.forbidden = mapped else {
            return XCTFail("403 应映射为 .forbidden，实际 \(mapped)")
        }
    }

    func testMapAPIErrorPublicExposureFromServerError409() {
        let mapped = CloudDocsShareService.mapAPIError(
            APIError.serverError(409, "ack required")
        )
        guard case CloudDocsShareError.publicExposureNotAcknowledged = mapped else {
            return XCTFail("409 应映射为 .publicExposureNotAcknowledged，实际 \(mapped)")
        }
    }

    func testMapAPIErrorPublicExposureFromApiErrorWithCode() {
        let mapped = CloudDocsShareService.mapAPIError(
            APIError.apiErrorWithCode(
                code: "PUBLIC_EXPOSURE_ACK_REQUIRED",
                message: "ack"
            )
        )
        guard case CloudDocsShareError.publicExposureNotAcknowledged = mapped else {
            return XCTFail("业务码应映射为 .publicExposureNotAcknowledged，实际 \(mapped)")
        }
    }

    func testShareEndpointPaths() {
        XCTAssertEqual(
            Endpoints.TabDoc.documentShare("doc-1"),
            "/tabdoc/documents/doc-1/share"
        )
        XCTAssertEqual(
            Endpoints.TabDoc.documentShareRefresh("doc-1"),
            "/tabdoc/documents/doc-1/share/refresh"
        )
        XCTAssertEqual(
            Endpoints.TabData.tableShare("table-1"),
            "/tabdata/tables/table-1/share"
        )
    }
}
