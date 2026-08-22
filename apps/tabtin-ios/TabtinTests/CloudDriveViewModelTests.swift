import XCTest
@testable import Tabtin

@MainActor
final class CloudDriveViewModelTests: XCTestCase {
    func testListRowsIncludeFoldersOnlyInAllScopeWithoutSearch() {
        let vm = CloudDriveViewModel(organizationId: "org-1")
        let folder = OrganizationCollection(id: "f1", name: "归档")
        let resource = SpaceResource(
            id: "ci-1",
            itemType: "tabdoc",
            title: "笔记",
            preview: nil,
            resourceId: "doc-1",
            spaceId: nil,
            organizationId: "org-1",
            metadata: nil,
            isArchived: false,
            isPinned: false,
            pinnedAt: nil,
            updatedAt: nil,
            createdAt: nil,
            spaceName: nil
        )
        vm.setCollectionsForTest([folder])
        vm.setResourcesForTest([resource])
        vm.setScopeForTest(.all)

        let ids = vm.listRows.map(\.id)
        XCTAssertEqual(ids, ["folder:f1", "resource:ci-1"])

        vm.setScopeForTest(.recent)
        XCTAssertEqual(vm.listRows.map(\.id), ["resource:ci-1"])

        vm.setScopeForTest(.shared)
        let shared = SharedResourceItem(
            resourceType: .doc,
            resourceId: "doc-9",
            title: "分享文档",
            organizationId: "org-1",
            spaceId: nil,
            permission: "viewer",
            updatedAt: nil,
            sharedBy: nil,
            contextItemId: "ci-shared"
        )
        vm.setSharedForTest([shared])
        XCTAssertEqual(vm.listRows.map(\.id), ["shared:doc:ci-shared"])
    }

    func testTypeFilterFiltersAlreadyLoadedResources() {
        let vm = CloudDriveViewModel(organizationId: "org-1")
        vm.setScopeForTest(.all)
        vm.setResourcesForTest([
            SpaceResource(
                id: "doc-item",
                itemType: "tabdoc",
                title: "需求文档",
                preview: nil,
                resourceId: "doc-1",
                spaceId: nil,
                organizationId: "org-1",
                metadata: nil,
                isArchived: false,
                isPinned: false,
                pinnedAt: nil,
                updatedAt: nil,
                createdAt: nil,
                spaceName: nil
            ),
            SpaceResource(
                id: "table-item",
                itemType: "tabdata",
                title: "项目表",
                preview: nil,
                resourceId: "table-1",
                spaceId: nil,
                organizationId: "org-1",
                metadata: nil,
                isArchived: false,
                isPinned: false,
                pinnedAt: nil,
                updatedAt: nil,
                createdAt: nil,
                spaceName: nil
            ),
            SpaceResource(
                id: "file-item",
                itemType: "tabfiles",
                title: "附件.pdf",
                preview: nil,
                resourceId: "file-1",
                spaceId: nil,
                organizationId: "org-1",
                metadata: nil,
                isArchived: false,
                isPinned: false,
                pinnedAt: nil,
                updatedAt: nil,
                createdAt: nil,
                spaceName: nil
            ),
        ])

        vm.setTypeFilterForTest(.tabdata)
        XCTAssertEqual(vm.listRows.map(\.id), ["resource:table-item"])

        vm.setTypeFilterForTest(.tabfiles)
        XCTAssertEqual(vm.listRows.map(\.id), ["resource:file-item"])
    }

    func testSearchHidesBreadcrumbSemanticsAndIncludesLocalFolders() {
        let vm = CloudDriveViewModel(organizationId: "org-1")
        let folder = OrganizationCollection(id: "f1", name: "设计稿")
        vm.setCollectionsForTest([folder])
        vm.setScopeForTest(.all)
        vm.setSearchForTest("设计")

        XCTAssertTrue(vm.isSearching)
        XCTAssertTrue(vm.breadcrumbPath.isEmpty || vm.isSearching)
        // 搜索态 folderRows 为空（当前位置语义隐藏），但 listRows 含本地文件夹命中。
        XCTAssertTrue(vm.folderRows.isEmpty)
        XCTAssertEqual(vm.listRows.first?.title, "设计稿")
    }

    func testSharedScopeDoesNotClientMergeThreeFeeds() {
        // 契约钉住：ViewModel 只消费 SharedResourceItem 列表（来自统一 feed），
        // 不暴露 docs/tables/files 三分游标。
        let vm = CloudDriveViewModel(organizationId: "org-1")
        vm.setScopeForTest(.shared)
        XCTAssertNil(Mirror(reflecting: vm).children.first { $0.label == "docCursor" })
        XCTAssertNil(Mirror(reflecting: vm).children.first { $0.label == "tableCursor" })
        XCTAssertNil(Mirror(reflecting: vm).children.first { $0.label == "fileCursor" })
    }

    func testSharedSearchPolicyMatchesTitleAndPreview() {
        let item = SharedResourceItem(
            resourceType: .file,
            resourceId: "fr-1",
            title: "季度报告.pdf",
            organizationId: "org-1",
            spaceId: nil,
            permission: "viewer",
            updatedAt: nil,
            sharedBy: nil,
            contextItemId: "ci-1",
            preview: "财务摘要"
        )
        XCTAssertTrue(CloudDriveSharedSearchPolicy.matches(item, query: "季度"))
        XCTAssertTrue(CloudDriveSharedSearchPolicy.matches(item, query: "财务"))
        XCTAssertFalse(CloudDriveSharedSearchPolicy.matches(item, query: "无关"))
        XCTAssertEqual(CloudDriveSharedSearchPolicy.maxFeedPages, 10)
    }

    func testWriteCapabilityRequiresEditorAndAllScopeWithoutSearch() {
        XCTAssertFalse(CloudDriveWriteCapability.canWrite(role: .viewer))
        XCTAssertFalse(CloudDriveWriteCapability.canWrite(role: .unknown))
        XCTAssertTrue(CloudDriveWriteCapability.canWrite(role: .editor))
        XCTAssertTrue(CloudDriveWriteCapability.canWrite(role: .owner))

        let vm = CloudDriveViewModel(organizationId: "org-1")
        vm.setScopeForTest(.all)
        vm.setSearchForTest("")
        // canWrite 还依赖 WorkspaceStore.currentUserRole；单测只钉 scope/search 门闩。
        vm.setScopeForTest(.recent)
        XCTAssertFalse(vm.canWrite)
        vm.setScopeForTest(.all)
        vm.setSearchForTest("x")
        XCTAssertFalse(vm.canWrite)
    }

    func testCreateCapabilityRemainsEnabledInRecentScope() {
        XCTAssertTrue(
            CloudDriveWriteCapability.canCreate(
                hasOrganizationWritePermission: true,
                scope: .all,
                isSearching: false
            )
        )
        XCTAssertTrue(
            CloudDriveWriteCapability.canCreate(
                hasOrganizationWritePermission: true,
                scope: .recent,
                isSearching: false
            )
        )
        XCTAssertFalse(
            CloudDriveWriteCapability.canCreate(
                hasOrganizationWritePermission: true,
                scope: .shared,
                isSearching: false
            )
        )
        XCTAssertFalse(
            CloudDriveWriteCapability.canCreate(
                hasOrganizationWritePermission: false,
                scope: .recent,
                isSearching: false
            )
        )
        XCTAssertFalse(
            CloudDriveWriteCapability.canCreate(
                hasOrganizationWritePermission: true,
                scope: .recent,
                isSearching: true
            )
        )
    }

    func testDecodeCreateDocumentAndTableContracts() throws {
        let docJSON = """
        {"document":{"id":"doc-1","title":"Hello"}}
        """.data(using: .utf8)!
        let doc = try JSONDecoder().decode(CloudDriveCreatedDocumentEnvelope.self, from: docJSON)
        XCTAssertEqual(doc.document.id, "doc-1")
        XCTAssertEqual(doc.document.title, "Hello")

        let tableJSON = """
        {"id":"tbl-1","name":"Sheet"}
        """.data(using: .utf8)!
        let table = try JSONDecoder().decode(CloudDriveCreatedTable.self, from: tableJSON)
        XCTAssertEqual(table.id, "tbl-1")
        XCTAssertEqual(table.name, "Sheet")
    }

    func testPendingMountStoreEnqueueDedupesAndPersists() async {
        await CloudDrivePendingMountStore.shared.clearForTesting()
        let task = CloudDrivePendingMountTask(
            fileRecordId: "fr-1",
            organizationId: "org-1",
            collectionId: "col-1",
            title: "a.pdf",
            lastError: "boom"
        )
        await CloudDrivePendingMountStore.shared.enqueue(task)
        await CloudDrivePendingMountStore.shared.enqueue(
            CloudDrivePendingMountTask(
                fileRecordId: "fr-1",
                organizationId: "org-1",
                collectionId: "col-1",
                title: "a.pdf",
                lastError: "again"
            )
        )
        let all = await CloudDrivePendingMountStore.shared.all()
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all.first?.lastError, "again")
        await CloudDrivePendingMountStore.shared.remove(fileRecordId: "fr-1", organizationId: "org-1")
        let empty = await CloudDrivePendingMountStore.shared.all()
        XCTAssertTrue(empty.isEmpty)
    }

    func testPendingMountEnqueuePostsStoreChangeNotification() async {
        await CloudDrivePendingMountStore.shared.clearForTesting()
        let exp = expectation(forNotification: .cloudDrivePendingMountStoreDidChange, object: nil)
        await CloudDrivePendingMountStore.shared.enqueue(
            CloudDrivePendingMountTask(
                fileRecordId: "fr-notify",
                organizationId: "org-1",
                collectionId: nil,
                title: "n.pdf",
                lastError: "mount failed"
            )
        )
        await fulfillment(of: [exp], timeout: 2)
        await CloudDrivePendingMountStore.shared.remove(fileRecordId: "fr-notify", organizationId: "org-1")
    }

    func testCreateDocumentAndTableBodiesPassCollectionId() {
        let doc = CloudDriveRepository.makeCreateDocumentBody(
            organizationId: "org-1",
            collectionId: "col-9",
            title: "Hello"
        )
        XCTAssertEqual(doc["collection_id"] as? String, "col-9")
        XCTAssertEqual(doc["organization_id"] as? String, "org-1")

        let docRoot = CloudDriveRepository.makeCreateDocumentBody(
            organizationId: "org-1",
            collectionId: nil,
            title: "Hello"
        )
        XCTAssertNil(docRoot["collection_id"])

        let table = CloudDriveRepository.makeCreateTableBody(
            organizationId: "org-1",
            collectionId: "col-2",
            name: "Sheet"
        )
        XCTAssertEqual(table["collection_id"] as? String, "col-2")
        XCTAssertEqual(table["use_default_fields"] as? Bool, true)
    }

    func testMoveItemsBodyUsesContextItemIdsNotFileRecordIds() {
        let body = CloudDriveRepository.makeMoveItemsBody(
            contextItemIds: ["ci-1"],
            collectionId: "col-2"
        )
        XCTAssertEqual(body["item_ids"] as? [String], ["ci-1"])
        XCTAssertEqual(body["collection_id"] as? String, "col-2")

        let root = CloudDriveRepository.makeMoveItemsBody(
            contextItemIds: ["ci-9"],
            collectionId: nil
        )
        XCTAssertTrue(root["collection_id"] is NSNull)
    }

    func testOwnerOnlyMoveAndFolderNeverSendToChat() {
        var owned = SpaceResource(
            id: "ci-1",
            itemType: "tabfiles",
            title: "a.pdf",
            preview: nil,
            resourceId: "fr-1",
            spaceId: nil,
            organizationId: "org-1",
            metadata: nil,
            isArchived: false,
            isPinned: false,
            pinnedAt: nil,
            updatedAt: nil,
            createdAt: nil,
            spaceName: nil
        )
        owned.canMove = true
        owned.canTrash = true
        owned.canShare = true
        XCTAssertTrue(CloudDriveHighRiskPolicy.canMoveResource(owned))
        XCTAssertTrue(CloudDriveHighRiskPolicy.canTrashTabFile(owned))
        XCTAssertTrue(CloudDriveHighRiskPolicy.canManageTabFileCollaborators(owned))

        var shared = owned
        shared.canMove = false
        XCTAssertFalse(CloudDriveHighRiskPolicy.canMoveResource(shared))

        let folder = OrganizationCollection(id: "f1", name: "Archive")
        let sink = CloudDriveConversationSink(send: { _ in })
        XCTAssertFalse(
            CloudDriveHighRiskPolicy.canSendToConversation(
                row: .folder(folder),
                sink: sink
            )
        )
        XCTAssertTrue(
            CloudDriveHighRiskPolicy.canSendToConversation(
                row: .resource(owned),
                sink: sink
            )
        )
        XCTAssertFalse(
            CloudDriveHighRiskPolicy.canSendToConversation(
                row: .resource(owned),
                sink: nil
            )
        )
    }

    func testCanTrashPrefersDedicatedFlagOverCanEdit() {
        var resource = SpaceResource(
            id: "ci-1",
            itemType: "tabfiles",
            title: "a.pdf",
            preview: nil,
            resourceId: "fr-1",
            spaceId: nil,
            organizationId: "org-1",
            metadata: nil,
            isArchived: false,
            isPinned: false,
            pinnedAt: nil,
            updatedAt: nil,
            createdAt: nil,
            spaceName: nil
        )
        resource.canEdit = true
        resource.canTrash = false
        XCTAssertFalse(CloudDriveHighRiskPolicy.canTrashTabFile(resource))

        resource.canTrash = true
        XCTAssertTrue(CloudDriveHighRiskPolicy.canTrashTabFile(resource))

        resource.canTrash = nil
        resource.canDelete = true
        resource.canEdit = false
        XCTAssertTrue(CloudDriveHighRiskPolicy.canTrashTabFile(resource))

        resource.canDelete = false
        resource.canEdit = true
        XCTAssertFalse(CloudDriveHighRiskPolicy.canTrashTabFile(resource))
    }

    func testDetailContextCarriesShareAndTrashGatesFromResource() {
        var resource = SpaceResource(
            id: "ci-1",
            itemType: "tabfiles",
            title: "a.pdf",
            preview: nil,
            resourceId: "fr-1",
            spaceId: nil,
            organizationId: "org-1",
            metadata: nil,
            isArchived: false,
            isPinned: false,
            pinnedAt: nil,
            updatedAt: nil,
            createdAt: nil,
            spaceName: nil
        )
        resource.canShare = false
        resource.canTrash = false
        resource.canEdit = true
        let denied = CloudFileDetailContext(resource: resource)
        XCTAssertFalse(denied.canShare)
        XCTAssertFalse(denied.canTrash)

        resource.canShare = true
        resource.canTrash = true
        let allowed = CloudFileDetailContext(resource: resource)
        XCTAssertTrue(allowed.canShare)
        XCTAssertTrue(allowed.canTrash)
    }

    func testSharedDetailContextCarriesShareAndTrashGates() {
        var item = SharedResourceItem(
            resourceType: .file,
            resourceId: "fr-1",
            title: "shared.pdf",
            organizationId: "org-1",
            spaceId: nil,
            permission: "viewer",
            updatedAt: nil,
            sharedBy: nil,
            contextItemId: "ci-1",
            fileRecordId: "fr-1"
        )
        item.canShare = false
        item.canTrash = false
        item.canEdit = true
        let denied = CloudFileDetailContext(shared: item)
        XCTAssertFalse(denied.canShare)
        XCTAssertFalse(denied.canTrash)

        item.canShare = true
        item.canTrash = true
        let allowed = CloudFileDetailContext(shared: item)
        XCTAssertTrue(allowed.canShare)
        XCTAssertTrue(allowed.canTrash)
    }

    func testMoveFolderConfirmMessageNamesSourceAndTarget() {
        let message = CloudDriveHighRiskPolicy.moveFolderConfirmMessage(
            sourceName: "设计",
            targetName: "项目"
        )
        XCTAssertTrue(message.contains("设计"))
        XCTAssertTrue(message.contains("项目"))
    }

    func testTabFilesMentionRefUsesFileRecordIdAndFileWireType() {
        let resource = SpaceResource(
            id: "ci-file",
            itemType: "tabfiles",
            title: "deck.pdf",
            preview: "preview",
            resourceId: "fr-99",
            spaceId: nil,
            organizationId: "org-1",
            metadata: nil,
            isArchived: false,
            isPinned: false,
            pinnedAt: nil,
            updatedAt: nil,
            createdAt: nil,
            spaceName: nil
        )
        let ref = CloudDriveHighRiskPolicy.mentionRef(for: resource, fallbackSpaceName: nil)
        XCTAssertEqual(ref?.type, .file)
        XCTAssertEqual(ref?.resourceId, "fr-99")
        let payload = ref?.blockPayload()
        XCTAssertEqual(payload?["type"] as? String, "file")
        XCTAssertEqual(payload?["file_id"] as? String, "fr-99")
        XCTAssertNotEqual(payload?["file_id"] as? String, "ci-file")
    }

    func testLaunchContextGatesSendCapability() {
        let workbench = AppHomeLaunchContext(organizationId: "org", source: .taskWorkbench)
        let deepLink = AppHomeLaunchContext(organizationId: "org", source: .deepLink)
        let sheet = AppHomeLaunchContext(organizationId: "org", source: .sheet)
        XCTAssertTrue(workbench.canOfferSendToConversation)
        XCTAssertFalse(deepLink.canOfferSendToConversation)
        XCTAssertFalse(sheet.canOfferSendToConversation)
    }

    func testContextRefTypeMapsTabfilesToFileNotFolder() {
        XCTAssertEqual(ContextRefType.fromItemType("tabfiles"), .file)
        XCTAssertEqual(ContextRefType.fromItemType("folder"), .folder)
        XCTAssertEqual(ContextRefType.fromItemType("tabfolder"), .folder)
    }
}
