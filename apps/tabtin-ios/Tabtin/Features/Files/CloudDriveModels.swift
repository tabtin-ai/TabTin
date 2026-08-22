import Foundation

// MARK: - Scope / Filter

enum CloudDriveScope: String, CaseIterable, Identifiable, Hashable, Sendable {
    case all
    case recent
    case shared

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return L10n.CloudDocs.browseAll
        case .recent: return L10n.CloudDocs.browseRecent
        case .shared: return L10n.CloudDocs.browseShared
        }
    }
}

enum CloudDriveTypeFilter: String, CaseIterable, Identifiable, Hashable, Sendable {
    case all
    case tabdoc
    case tabdata
    case tabfiles

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return L10n.CloudDrive.filterAll
        case .tabdoc: return L10n.CloudDrive.filterDocs
        case .tabdata: return L10n.CloudDrive.filterTables
        case .tabfiles: return L10n.CloudDrive.filterFiles
        }
    }

    /// 传给后端的 `item_types` / `types`；`.all` 为云盘三类型白名单。
    var itemTypesQuery: String {
        switch self {
        case .all: return "tabdoc,tabdata,tabfiles"
        case .tabdoc: return "tabdoc"
        case .tabdata: return "tabdata"
        case .tabfiles: return "tabfiles"
        }
    }

    func matches(normalizedType: String) -> Bool {
        switch self {
        case .all: return ["tabdoc", "tabdata", "tabfiles"].contains(normalizedType)
        case .tabdoc, .tabdata, .tabfiles: return normalizedType == rawValue
        }
    }
}

/// 分享范围搜索：服务端 shared-feed 无 `q`，客户端翻页本地过滤。
enum CloudDriveSharedSearchPolicy {
    /// 最多拉取的 feed 页数（× `CloudDriveRepository.sharedLimit`）。
    static let maxFeedPages = 10

    static func matches(_ item: SharedResourceItem, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return true }
        if item.title.localizedCaseInsensitiveContains(needle) { return true }
        if let preview = item.preview, preview.localizedCaseInsensitiveContains(needle) {
            return true
        }
        return false
    }
}

// MARK: - Collection

struct OrganizationCollection: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let parentId: String?
    let organizationId: String?
    let icon: String?
    let color: String?
    let order: Int?
    let isPinned: Bool?
    let itemCount: Int?
    var children: [OrganizationCollection]

    enum CodingKeys: String, CodingKey {
        case id, name, icon, color, order, children
        case parentId = "parent_id"
        case organizationId = "organization_id"
        case isPinned = "is_pinned"
        case itemCount = "item_count"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try Self.decodeID(c, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        parentId = try Self.decodeOptionalID(c, forKey: .parentId)
        organizationId = try Self.decodeOptionalID(c, forKey: .organizationId)
        icon = try c.decodeIfPresent(String.self, forKey: .icon)
        color = try c.decodeIfPresent(String.self, forKey: .color)
        order = try c.decodeIfPresent(Int.self, forKey: .order)
        isPinned = try c.decodeIfPresent(Bool.self, forKey: .isPinned)
        itemCount = try c.decodeIfPresent(Int.self, forKey: .itemCount)
        children = try c.decodeIfPresent([OrganizationCollection].self, forKey: .children) ?? []
    }

    init(
        id: String,
        name: String,
        parentId: String? = nil,
        organizationId: String? = nil,
        icon: String? = nil,
        color: String? = nil,
        order: Int? = nil,
        isPinned: Bool? = nil,
        itemCount: Int? = nil,
        children: [OrganizationCollection] = []
    ) {
        self.id = id
        self.name = name
        self.parentId = parentId
        self.organizationId = organizationId
        self.icon = icon
        self.color = color
        self.order = order
        self.isPinned = isPinned
        self.itemCount = itemCount
        self.children = children
    }

    private static func decodeID(_ c: KeyedDecodingContainer<CodingKeys>, forKey key: CodingKeys) throws -> String {
        if let s = try c.decodeIfPresent(String.self, forKey: key), !s.isEmpty { return s }
        if let u = try c.decodeIfPresent(UUID.self, forKey: key) { return u.uuidString.lowercased() }
        throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "missing collection id")
    }

    private static func decodeOptionalID(_ c: KeyedDecodingContainer<CodingKeys>, forKey key: CodingKeys) throws -> String? {
        if let s = try c.decodeIfPresent(String.self, forKey: key) {
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if let u = try c.decodeIfPresent(UUID.self, forKey: key) {
            return u.uuidString.lowercased()
        }
        return nil
    }
}

struct OrganizationCollectionListResponse: Decodable, Sendable {
    let collections: [OrganizationCollection]
    let total: Int?
}

// MARK: - Shared feed

struct CloudDriveSharedFeedResponse: Decodable, Sendable {
    let items: [CloudDriveSharedFeedItem]
    let nextCursor: String?
    let limit: Int?

    enum CodingKeys: String, CodingKey {
        case items, limit
        case nextCursor = "next_cursor"
    }
}

struct CloudDriveSharedFeedItem: Decodable, Hashable, Sendable {
    let contextItemId: String
    let resourceId: String
    let itemType: String
    let title: String
    let preview: String?
    let collectionId: String?
    let organizationId: String
    let spaceId: String?
    let spaceName: String?
    let metadata: [String: AnyCodable]?
    let isPinned: Bool?
    let updatedAt: String?
    let createdAt: String?
    let permission: String?
    let sharedBy: SharedResourceOwner?
    let fileRecordId: String?
    let canView: Bool?
    let canEdit: Bool?
    let canMove: Bool?
    let canShare: Bool?
    let canTrash: Bool?
    let canDelete: Bool?

    enum CodingKeys: String, CodingKey {
        case title, preview, metadata, permission, owner
        case contextItemId = "context_item_id"
        case resourceId = "resource_id"
        case itemType = "item_type"
        case collectionId = "collection_id"
        case organizationId = "organization_id"
        case spaceId = "space_id"
        case spaceName = "space_name"
        case isPinned = "is_pinned"
        case updatedAt = "updated_at"
        case createdAt = "created_at"
        case sharedBy = "shared_by"
        case fileRecordId = "file_record_id"
        case canView = "can_view"
        case canEdit = "can_edit"
        case canMove = "can_move"
        case canShare = "can_share"
        case canTrash = "can_trash"
        case canDelete = "can_delete"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        contextItemId = try Self.decodeID(c, forKey: .contextItemId)
        resourceId = try c.decodeIfPresent(String.self, forKey: .resourceId) ?? ""
        itemType = try c.decodeIfPresent(String.self, forKey: .itemType) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        preview = try c.decodeIfPresent(String.self, forKey: .preview)
        collectionId = try Self.decodeOptionalID(c, forKey: .collectionId)
        organizationId = try Self.decodeOptionalID(c, forKey: .organizationId) ?? ""
        spaceId = try Self.decodeOptionalID(c, forKey: .spaceId)
        spaceName = try c.decodeIfPresent(String.self, forKey: .spaceName)
        metadata = try c.decodeIfPresent([String: AnyCodable].self, forKey: .metadata)
        isPinned = try c.decodeIfPresent(Bool.self, forKey: .isPinned)
        updatedAt = try Self.decodeDateString(c, forKey: .updatedAt)
        createdAt = try Self.decodeDateString(c, forKey: .createdAt)
        permission = try c.decodeIfPresent(String.self, forKey: .permission)
        sharedBy = try c.decodeIfPresent(SharedResourceOwner.self, forKey: .sharedBy)
        fileRecordId = try Self.decodeOptionalID(c, forKey: .fileRecordId)
        canView = try c.decodeIfPresent(Bool.self, forKey: .canView)
        canEdit = try c.decodeIfPresent(Bool.self, forKey: .canEdit)
        canMove = try c.decodeIfPresent(Bool.self, forKey: .canMove)
        canShare = try c.decodeIfPresent(Bool.self, forKey: .canShare)
        canTrash = try c.decodeIfPresent(Bool.self, forKey: .canTrash)
        canDelete = try c.decodeIfPresent(Bool.self, forKey: .canDelete)
    }

    func asSharedResourceItem() -> SharedResourceItem {
        let normalized = SpaceResource.normalizedType(itemType)
        let resourceType: SharedResourceType
        switch normalized {
        case "tabdoc": resourceType = .doc
        case "tabdata": resourceType = .table
        default: resourceType = .file
        }
        return SharedResourceItem(
            resourceType: resourceType,
            resourceId: resourceId,
            title: title,
            organizationId: organizationId,
            spaceId: spaceId,
            permission: permission ?? "",
            updatedAt: updatedAt,
            sharedBy: sharedBy,
            contextItemId: contextItemId,
            fileRecordId: fileRecordId ?? (normalized == "tabfiles" ? resourceId : nil),
            preview: preview,
            itemType: itemType,
            collectionId: collectionId,
            canView: canView,
            canEdit: canEdit,
            canMove: canMove,
            canShare: canShare,
            canTrash: canTrash,
            canDelete: canDelete,
            metadata: metadata
        )
    }

    private static func decodeID(_ c: KeyedDecodingContainer<CodingKeys>, forKey key: CodingKeys) throws -> String {
        if let s = try c.decodeIfPresent(String.self, forKey: key), !s.isEmpty { return s }
        if let u = try c.decodeIfPresent(UUID.self, forKey: key) { return u.uuidString.lowercased() }
        throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "missing id")
    }

    private static func decodeOptionalID(_ c: KeyedDecodingContainer<CodingKeys>, forKey key: CodingKeys) throws -> String? {
        if let s = try c.decodeIfPresent(String.self, forKey: key) {
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if let u = try c.decodeIfPresent(UUID.self, forKey: key) {
            return u.uuidString.lowercased()
        }
        return nil
    }

    private static func decodeDateString(_ c: KeyedDecodingContainer<CodingKeys>, forKey key: CodingKeys) throws -> String? {
        if let s = try c.decodeIfPresent(String.self, forKey: key) { return s }
        return nil
    }
}

// MARK: - Download

struct CloudFileDownloadURLResponse: Decodable, Sendable {
    let url: String?
    let fileName: String?
    let mimeType: String?
    let fileSize: Int?
    let previewEligible: Bool?
    let mimePreviewSafe: Bool?

    enum CodingKeys: String, CodingKey {
        case url
        case fileName = "file_name"
        case mimeType = "mime_type"
        case fileSize = "file_size"
        case previewEligible = "preview_eligible"
        case mimePreviewSafe = "mime_preview_safe"
    }
}

// MARK: - List row

enum CloudDriveListRow: Identifiable, Hashable, Sendable {
    case folder(OrganizationCollection)
    case resource(SpaceResource)
    case shared(SharedResourceItem)

    var id: String {
        switch self {
        case let .folder(c): return "folder:\(c.id)"
        case let .resource(r): return "resource:\(r.contextItemId)"
        case let .shared(s): return s.id
        }
    }

    var title: String {
        switch self {
        case let .folder(c): return c.name.isEmpty ? L10n.CloudDrive.untitledFolder : c.name
        case let .resource(r): return r.displayTitle
        case let .shared(s): return s.displayTitle
        }
    }
}

enum CloudDriveFolderLookup {
    /// 扁平化树，便于面包屑 / 本地文件夹搜索。
    static func flatten(_ roots: [OrganizationCollection]) -> [OrganizationCollection] {
        var result: [OrganizationCollection] = []
        func walk(_ nodes: [OrganizationCollection]) {
            for node in nodes {
                result.append(node)
                walk(node.children)
            }
        }
        walk(roots)
        return result
    }

    static func path(to collectionId: String, in roots: [OrganizationCollection]) -> [OrganizationCollection] {
        func dfs(_ nodes: [OrganizationCollection], trail: [OrganizationCollection]) -> [OrganizationCollection]? {
            for node in nodes {
                let next = trail + [node]
                if node.id == collectionId { return next }
                if let found = dfs(node.children, trail: next) { return found }
            }
            return nil
        }
        return dfs(roots, trail: []) ?? []
    }

    static func children(of parentId: String?, in roots: [OrganizationCollection]) -> [OrganizationCollection] {
        guard let parentId else { return roots }
        let flat = flatten(roots)
        return flat.first(where: { $0.id == parentId })?.children ?? []
    }
}

// MARK: - Write DTOs / upload state

struct CloudDriveCreatedDocumentEnvelope: Decodable, Sendable {
    let document: CloudDriveCreatedDocument
}

struct CloudDriveCreatedDocument: Decodable, Sendable {
    let id: String
    let title: String?
}

struct CloudDriveCreatedTable: Decodable, Sendable {
    let id: String
    let name: String?
}

enum CloudDriveUploadPhase: String, Equatable, Sendable {
    case selected
    case uploading
    case confirmed
    case mounting
    case ready
    case pendingMount
}

struct CloudDriveUploadProgress: Equatable, Sendable {
    var fileName: String
    var phase: CloudDriveUploadPhase
    var progress: Double
    var errorMessage: String?
}

enum CloudDriveWriteCapability {
    /// Organization 写入门槛：editor 及以上；viewer 只读。
    static func canWrite(role: OrganizationRole?) -> Bool {
        (role ?? .unknown).canEdit
    }

    static func canCreate(
        hasOrganizationWritePermission: Bool,
        scope: CloudDriveScope,
        isSearching: Bool
    ) -> Bool {
        hasOrganizationWritePermission && scope != .shared && !isSearching
    }
}

struct CloudDriveMoveItemsResponse: Decodable, Sendable {
    let updated: Int?
}

/// 最近一次 TabFiles trash 的本地撤销 / 永久删除入口（无完整回收站浏览）。
struct CloudDriveTrashedFileNotice: Equatable, Sendable, Identifiable {
    let id: String
    let fileRecordId: String
    let title: String
}

enum CloudFilePreviewPolicy {
    /// 与后端 `_PREVIEW_SAFE_MIME_TYPES` 对齐的客户端二次门禁。
    static let safeMIMETypes: Set<String> = [
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/heic",
        "image/heif",
        "audio/mpeg",
        "audio/mp4",
        "audio/wav",
        "audio/x-wav",
        "audio/ogg",
        "video/mp4",
        "video/webm",
        "video/quicktime",
    ]

    static let defaultPreviewMaxBytes = 8 * 1024 * 1024

    static func normalizeMIME(_ raw: String?) -> String {
        (raw ?? "").split(separator: ";", maxSplits: 1).first
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            ?? ""
    }

    static func isPreviewSafe(mimeType: String?) -> Bool {
        safeMIMETypes.contains(normalizeMIME(mimeType))
    }
}
