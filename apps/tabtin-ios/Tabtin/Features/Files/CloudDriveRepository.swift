import Foundation

/// Organization 云盘只读数据源。不碰 `CloudDocsViewModel` 知识树。
enum CloudDriveRepository {
    static let defaultPageSize = 50
    static let searchPageSize = 30
    static let sharedLimit = 30

    static func listCollections(organizationId: String) async throws -> [OrganizationCollection] {
        let response: OrganizationCollectionListResponse = try await APIClient.shared.get(
            path: Endpoints.Context.organizationCollections(organizationId: organizationId)
        )
        return response.collections
    }

    static func listFolderItems(
        organizationId: String,
        collectionId: String?,
        itemTypes: String,
        page: Int,
        pageSize: Int = defaultPageSize
    ) async throws -> SpaceResourceListResponse {
        return try await APIClient.shared.get(
            path: Endpoints.Context.organizationContextItems(organizationId: organizationId),
            query: [
                "is_archived": "false",
                "item_types": itemTypes,
                "page": "\(max(1, page))",
                "page_size": "\(pageSize)",
                "collection_id": collectionId ?? "root",
            ]
        )
    }

    static func listRecentItems(
        organizationId: String,
        itemTypes: String,
        page: Int,
        pageSize: Int = defaultPageSize
    ) async throws -> SpaceResourceListResponse {
        try await APIClient.shared.get(
            path: Endpoints.Context.organizationContextItems(organizationId: organizationId),
            query: [
                "is_archived": "false",
                "item_types": itemTypes,
                "visited_only": "true",
                "sort": "-last_visited_at",
                "page": "\(max(1, page))",
                "page_size": "\(pageSize)",
            ]
        )
    }

    static func search(
        organizationId: String,
        query: String,
        types: String,
        page: Int,
        pageSize: Int = searchPageSize
    ) async throws -> SpaceResourceListResponse {
        try await APIClient.shared.get(
            path: Endpoints.Context.organizationSearch(organizationId: organizationId),
            query: [
                "q": query,
                "types": types,
                "page": "\(max(1, page))",
                "page_size": "\(pageSize)",
            ]
        )
    }

    /// 统一 shared-feed；禁止客户端三路游标合并。
    static func listSharedFeed(
        organizationId: String,
        itemTypes: String,
        cursor: String?,
        limit: Int = sharedLimit
    ) async throws -> CloudDriveSharedFeedResponse {
        var query: [String: String] = [
            "item_types": itemTypes,
            "limit": "\(limit)",
        ]
        if let cursor, !cursor.isEmpty {
            query["cursor"] = cursor
        }
        return try await APIClient.shared.get(
            path: Endpoints.Context.cloudDriveSharedFeed(organizationId: organizationId),
            query: query
        )
    }

    static func fetchDownloadURL(
        organizationId: String,
        contextItemId: String,
        previewMaxBytes: Int? = nil
    ) async throws -> CloudFileDownloadURLResponse {
        var query: [String: String] = [:]
        if let previewMaxBytes {
            query["preview_max_bytes"] = "\(previewMaxBytes)"
        }
        return try await APIClient.shared.get(
            path: Endpoints.Context.organizationFileDownloadURL(
                organizationId: organizationId,
                contextItemId: contextItemId
            ),
            query: query.isEmpty ? nil : query
        )
    }

    /// Fire-and-forget 访问上报；失败不向上抛。
    static func reportAccess(contextItemId: String) async {
        guard !contextItemId.isEmpty, !contextItemId.hasPrefix("shared:") else { return }
        do {
            let _: MessageResponse = try await APIClient.shared.post(
                path: Endpoints.Context.contextItemAccess(contextItemId)
            )
        } catch {
            // 上报失败不阻断打开
        }
    }

    // MARK: - Writes

    static func createCollection(
        organizationId: String,
        name: String,
        parentId: String?
    ) async throws -> OrganizationCollection {
        var body: [String: Any] = ["name": name]
        if let parentId, !parentId.isEmpty {
            body["parent_id"] = parentId
        }
        return try await APIClient.shared.post(
            path: Endpoints.Context.organizationCollections(organizationId: organizationId),
            body: body
        )
    }

    static func createDocument(
        organizationId: String,
        collectionId: String?,
        title: String
    ) async throws -> CloudDriveCreatedDocument {
        let envelope: CloudDriveCreatedDocumentEnvelope = try await APIClient.shared.post(
            path: Endpoints.TabDoc.documents,
            body: makeCreateDocumentBody(
                organizationId: organizationId,
                collectionId: collectionId,
                title: title
            )
        )
        return envelope.document
    }

    static func createTable(
        organizationId: String,
        collectionId: String?,
        name: String
    ) async throws -> CloudDriveCreatedTable {
        return try await APIClient.shared.post(
            path: Endpoints.TabData.tables,
            body: makeCreateTableBody(
                organizationId: organizationId,
                collectionId: collectionId,
                name: name
            )
        )
    }

    /// 单测可钉：当前文件夹写入须带 `collection_id`；根目录省略。
    static func makeCreateDocumentBody(
        organizationId: String,
        collectionId: String?,
        title: String
    ) -> [String: Any] {
        var body: [String: Any] = [
            "organization_id": organizationId,
            "title": title,
        ]
        if let collectionId, !collectionId.isEmpty {
            body["collection_id"] = collectionId
        }
        return body
    }

    static func makeCreateTableBody(
        organizationId: String,
        collectionId: String?,
        name: String
    ) -> [String: Any] {
        var body: [String: Any] = [
            "organization_id": organizationId,
            "name": name,
            "use_default_fields": true,
        ]
        if let collectionId, !collectionId.isEmpty {
            body["collection_id"] = collectionId
        }
        return body
    }

    /// 将已 confirm 的 FileRecord 挂到组织云盘当前文件夹。
    static func mountUploadedFile(
        organizationId: String,
        fileRecordId: String,
        collectionId: String?,
        title: String?
    ) async throws -> SpaceResource {
        var body: [String: Any] = [
            "file_record_id": fileRecordId,
        ]
        if let collectionId, !collectionId.isEmpty {
            body["collection_id"] = collectionId
        }
        if let title {
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                body["title"] = trimmed
            }
        }
        return try await APIClient.shared.post(
            path: Endpoints.Context.organizationFilesUpload(organizationId: organizationId),
            body: body
        )
    }

    static func tabfilesUploadScope(organizationId: String) -> UploadScope {
        UploadScope(
            module: "tabfiles",
            contextType: "organization",
            contextId: organizationId,
            organizationId: organizationId,
            isPublic: false
        )
    }

    static let tabfilesUploadFolder = "tabfiles/uploads"

    // MARK: - High-risk writes (Task 9)

    static func renameCollection(collectionId: String, name: String) async throws -> OrganizationCollection {
        try await APIClient.shared.patch(
            path: Endpoints.Context.collection(collectionId),
            body: ["name": name]
        )
    }

    /// 移动文件夹：改 `parent_id`；根目录传 `NSNull`。
    static func moveCollection(collectionId: String, parentId: String?) async throws -> OrganizationCollection {
        let body: [String: Any] = [
            "parent_id": parentId as Any? ?? NSNull(),
        ]
        return try await APIClient.shared.patch(
            path: Endpoints.Context.collection(collectionId),
            body: body
        )
    }

    /// 删除文件夹：递归删子文件夹，内容进回收站（服务端语义）。
    static func deleteCollection(collectionId: String) async throws {
        let _: MessageResponse = try await APIClient.shared.delete(
            path: Endpoints.Context.collection(collectionId)
        )
    }

    /// 单资源移动 / 移出文件夹。`itemIds` 必须是 ContextItemID；`collectionId == nil` 表示移到根。
    /// 服务端对云资产强制 owner-only。
    static func moveItems(
        organizationId: String,
        contextItemIds: [String],
        collectionId: String?
    ) async throws -> Int {
        var body: [String: Any] = [
            "item_ids": contextItemIds,
        ]
        if let collectionId, !collectionId.isEmpty {
            body["collection_id"] = collectionId
        } else {
            body["collection_id"] = NSNull()
        }
        let response: CloudDriveMoveItemsResponse = try await APIClient.shared.post(
            path: Endpoints.Context.organizationCollectionsMoveItems(organizationId: organizationId),
            body: body
        )
        return response.updated ?? 0
    }

    /// TabFiles trash —— 必须传 FileRecordID。
    static func trashTabFile(organizationId: String, fileRecordId: String) async throws {
        let _: MessageResponse = try await APIClient.shared.post(
            path: Endpoints.Context.organizationFileTrash(
                organizationId: organizationId,
                fileRecordId: fileRecordId
            )
        )
    }

    static func restoreTabFile(organizationId: String, fileRecordId: String) async throws -> SpaceResource {
        try await APIClient.shared.post(
            path: Endpoints.Context.organizationFileRestore(
                organizationId: organizationId,
                fileRecordId: fileRecordId
            )
        )
    }

    static func permanentDeleteTabFile(organizationId: String, fileRecordId: String) async throws {
        let _: MessageResponse = try await APIClient.shared.delete(
            path: Endpoints.Context.organizationFilePermanent(
                organizationId: organizationId,
                fileRecordId: fileRecordId
            )
        )
    }

    /// 单测可钉：move-items body 用 ContextItemID，不混 FileRecordID。
    static func makeMoveItemsBody(contextItemIds: [String], collectionId: String?) -> [String: Any] {
        var body: [String: Any] = ["item_ids": contextItemIds]
        if let collectionId, !collectionId.isEmpty {
            body["collection_id"] = collectionId
        } else {
            body["collection_id"] = NSNull()
        }
        return body
    }
}
