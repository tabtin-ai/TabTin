import XCTest
@testable import Tabtin

final class CloudDriveContractTests: XCTestCase {
    func testSpaceResourceDistinguishesContextItemAndFileRecordIds() {
        var resource = SpaceResource(
            id: "ctx-1",
            itemType: "tabfiles",
            title: "report.pdf",
            preview: nil,
            resourceId: "file-rec-9",
            spaceId: nil,
            organizationId: "org-1",
            metadata: [
                "file_name": AnyCodable("report.pdf"),
                "mime_type": AnyCodable("application/pdf"),
                "file_size": AnyCodable(2048),
            ],
            isArchived: false,
            isPinned: false,
            pinnedAt: nil,
            updatedAt: nil,
            createdAt: nil,
            spaceName: nil
        )
        resource.collectionId = "folder-1"
        resource.canView = true
        resource.canEdit = false
        resource.canMove = false
        resource.canShare = true
        resource.canTrash = true

        XCTAssertEqual(resource.contextItemId, "ctx-1")
        XCTAssertEqual(resource.fileRecordId, "file-rec-9")
        XCTAssertEqual(resource.mimeType, "application/pdf")
        XCTAssertEqual(resource.fileSizeBytes, 2048)
        XCTAssertEqual(resource.collectionId, "folder-1")
        XCTAssertEqual(resource.canView, true)
        XCTAssertEqual(resource.canMove, false)

        guard case let .tabfiles(context)? = resource.appRoute else {
            return XCTFail("expected CloudFileDetailContext route")
        }
        XCTAssertEqual(context.contextItemId, "ctx-1")
        XCTAssertEqual(context.fileRecordId, "file-rec-9")
        XCTAssertEqual(context.organizationId, "org-1")
        XCTAssertEqual(context.mimeType, "application/pdf")
        XCTAssertTrue(context.canShare)
        XCTAssertTrue(context.canTrash)
    }

    func testSharedFeedItemMapsFileWithBothIds() throws {
        let json = """
        {
          "context_item_id": "ci-file",
          "resource_id": "fr-1",
          "item_type": "tabfiles",
          "title": "shared.bin",
          "preview": "",
          "collection_id": null,
          "organization_id": "org-1",
          "space_id": null,
          "permission": "viewer",
          "updated_at": "2026-07-31T00:00:00Z",
          "shared_by": {"id": "u1", "display_name": "Ada", "avatar": ""},
          "file_record_id": "fr-1",
          "can_view": true,
          "can_edit": false,
          "can_move": false,
          "can_share": false,
          "can_trash": false
        }
        """.data(using: .utf8)!
        let item = try JSONDecoder().decode(CloudDriveSharedFeedItem.self, from: json)
        let shared = item.asSharedResourceItem()
        XCTAssertEqual(shared.resourceType, .file)
        XCTAssertEqual(shared.contextItemId, "ci-file")
        XCTAssertEqual(shared.fileRecordId, "fr-1")
        XCTAssertEqual(shared.canShare, false)
        XCTAssertEqual(shared.canTrash, false)
        guard case let .tabfiles(context)? = shared.appRoute else {
            return XCTFail("file share should open via CloudFileDetailContext")
        }
        XCTAssertEqual(context.contextItemId, "ci-file")
        XCTAssertEqual(context.fileRecordId, "fr-1")
        XCTAssertFalse(context.canShare)
        XCTAssertFalse(context.canTrash)
    }

    func testFolderLookupPathAndLocalSearch() {
        let child = OrganizationCollection(id: "c2", name: "设计", parentId: "c1")
        let root = OrganizationCollection(id: "c1", name: "项目", children: [child])
        let path = CloudDriveFolderLookup.path(to: "c2", in: [root])
        XCTAssertEqual(path.map(\.id), ["c1", "c2"])
        XCTAssertEqual(CloudDriveFolderLookup.children(of: "c1", in: [root]).map(\.id), ["c2"])
        let flat = CloudDriveFolderLookup.flatten([root])
        XCTAssertEqual(Set(flat.map(\.id)), Set(["c1", "c2"]))
    }

    func testConversationFileUsesFileRecordAccessRoute() {
        let context = CloudFileDetailContext(
            contextItemId: "",
            fileRecordId: "file-abc",
            organizationId: "org-1",
            title: "报告.pdf"
        )
        XCTAssertEqual(context.accessRoute, .fileRecord)
    }

    func testCloudDriveFilePrefersContextItemAccessRoute() {
        let context = CloudFileDetailContext(
            contextItemId: "ctx-1",
            fileRecordId: "file-abc",
            organizationId: "org-1",
            title: "报告.pdf"
        )
        XCTAssertEqual(context.accessRoute, .contextItem)
    }

    func testBlankIdentifiersHaveMissingAccessRoute() {
        let context = CloudFileDetailContext(
            contextItemId: "  ",
            fileRecordId: "",
            organizationId: "org-1",
            title: "报告.pdf"
        )
        XCTAssertEqual(context.accessRoute, .missing)
        XCTAssertNil(CloudFileSignedPreviewPolicy.cacheKey(for: context))
        XCTAssertEqual(
            CloudFileSignedPreviewPolicy.cacheKey(for: CloudFileDetailContext(
                contextItemId: "ctx-1",
                fileRecordId: "file-abc",
                organizationId: "org-1",
                title: "报告.pdf"
            )),
            "ctx:ctx-1"
        )
    }

    func testOSSFileAccessPrefersCDNDisplayURL() throws {
        let access = try JSONDecoder().decode(OSSFileAccess.self, from: Data("""
        {"file_id":"file-1","file_name":"image.png","file_size":8,
         "mime_type":"image/png",
         "access_url":"https://assets.example.com/image.png",
         "cdn_url":"https://assets.example.com/cdn-image.png",
         "resolved_url":"https://example-assets.oss-cn-shanghai.aliyuncs.com/image.png"}
        """.utf8))
        XCTAssertEqual(access.displayUrl, "https://assets.example.com/cdn-image.png")
    }

    func testPreviewPolicyWhitelist() {
        XCTAssertTrue(CloudFilePreviewPolicy.isPreviewSafe(mimeType: "application/pdf"))
        XCTAssertTrue(CloudFilePreviewPolicy.isPreviewSafe(mimeType: "image/png; charset=utf-8"))
        XCTAssertFalse(CloudFilePreviewPolicy.isPreviewSafe(mimeType: "text/html"))
        XCTAssertFalse(CloudFilePreviewPolicy.isPreviewSafe(mimeType: "application/zip"))
    }

    func testTypeFilterQueryContract() {
        XCTAssertEqual(CloudDriveTypeFilter.all.itemTypesQuery, "tabdoc,tabdata,tabfiles")
        XCTAssertEqual(CloudDriveTypeFilter.tabdoc.itemTypesQuery, "tabdoc")
        XCTAssertTrue(CloudDriveTypeFilter.all.matches(normalizedType: "tabfiles"))
        XCTAssertFalse(CloudDriveTypeFilter.tabdoc.matches(normalizedType: "tabdata"))
    }

    func testEndpointPaths() {
        XCTAssertEqual(
            Endpoints.Context.cloudDriveSharedFeed(organizationId: "org-1"),
            "/context/organizations/org-1/cloud-drive/shared-feed"
        )
        XCTAssertEqual(
            Endpoints.Context.organizationSearch(organizationId: "org-1"),
            "/context/organizations/org-1/search"
        )
        XCTAssertEqual(
            Endpoints.Context.organizationFileDownloadURL(organizationId: "org-1", contextItemId: "ci-1"),
            "/context/organizations/org-1/files/ci-1/download-url"
        )
        XCTAssertEqual(
            Endpoints.Context.organizationCollections(organizationId: "org-1"),
            "/context/organizations/org-1/collections"
        )
        // TabFiles trash/restore/permanent 必须走 FileRecordID，不能用 ContextItemID。
        XCTAssertEqual(
            Endpoints.Context.organizationFileTrash(organizationId: "org-1", fileRecordId: "fr-9"),
            "/context/organizations/org-1/files/fr-9/trash"
        )
        XCTAssertEqual(
            Endpoints.Context.organizationFileRestore(organizationId: "org-1", fileRecordId: "fr-9"),
            "/context/organizations/org-1/files/fr-9/restore"
        )
        XCTAssertEqual(
            Endpoints.Context.organizationFilePermanent(organizationId: "org-1", fileRecordId: "fr-9"),
            "/context/organizations/org-1/files/fr-9/permanent"
        )
        XCTAssertEqual(
            Endpoints.Context.fileCollaborators(fileRecordId: "fr-9"),
            "/context/files/fr-9/collaborators"
        )
        XCTAssertEqual(
            Endpoints.Context.organizationCollectionsMoveItems(organizationId: "org-1"),
            "/context/organizations/org-1/collections/move-items"
        )
    }
}
