import Foundation

enum CloudFileAccessRoute: Equatable, Sendable {
    case contextItem
    case fileRecord
    case missing
}

/// TabFiles 打开上下文：明确区分 ContextItemID 与 FileRecordID。
struct CloudFileDetailContext: Hashable, Sendable {
    let contextItemId: String
    let fileRecordId: String
    let organizationId: String
    let title: String
    let preview: String?
    let mimeType: String?
    let fileSize: Int?
    let fileExtension: String?
    let spaceName: String?
    /// 与列表 `canShare` / HighRiskPolicy 对齐；详情协作者入口门禁。
    let canShare: Bool
    /// 与列表 trash 策略对齐；详情「移到回收站」门禁。
    let canTrash: Bool

    init(
        contextItemId: String,
        fileRecordId: String,
        organizationId: String,
        title: String,
        preview: String? = nil,
        mimeType: String? = nil,
        fileSize: Int? = nil,
        fileExtension: String? = nil,
        spaceName: String? = nil,
        canShare: Bool = false,
        canTrash: Bool = false
    ) {
        self.contextItemId = contextItemId
        self.fileRecordId = fileRecordId
        self.organizationId = organizationId
        self.title = title
        self.preview = preview
        self.mimeType = mimeType
        self.fileSize = fileSize
        self.fileExtension = fileExtension
        self.spaceName = spaceName
        self.canShare = canShare
        self.canTrash = canTrash
    }

    init(resource: SpaceResource) {
        self.contextItemId = resource.contextItemId
        self.fileRecordId = resource.fileRecordId ?? resource.resourceId
        self.organizationId = resource.organizationId ?? ""
        self.title = resource.displayTitle
        self.preview = resource.preview
        self.mimeType = resource.mimeType
        self.fileSize = resource.fileSizeBytes
        self.fileExtension = resource.fileExtension
        self.spaceName = resource.spaceName
        self.canShare = CloudDriveHighRiskPolicy.canManageTabFileCollaborators(resource)
        self.canTrash = CloudDriveHighRiskPolicy.canTrashTabFile(resource)
    }

    init(shared: SharedResourceItem) {
        self.contextItemId = shared.contextItemId ?? ""
        self.fileRecordId = shared.fileRecordId ?? shared.resourceId
        self.organizationId = shared.organizationId
        self.title = shared.displayTitle
        self.preview = shared.preview
        self.mimeType = SpaceResource.metadataString(
            shared.metadata, keys: ["mime_type", "mime", "content_type"]
        )
        self.fileSize = SpaceResource.metadataInt(
            shared.metadata, keys: ["size", "file_size", "size_bytes"]
        )
        self.fileExtension = SpaceResource.metadataString(
            shared.metadata, keys: ["file_extension", "extension", "ext"]
        )
        self.spaceName = nil
        self.canShare = CloudDriveHighRiskPolicy.canManageSharedTabFileCollaborators(shared)
        self.canTrash = CloudDriveHighRiskPolicy.canTrashSharedTabFile(shared)
    }

    /// 对话产物只有 FileRecordID；云盘列表才有 ContextItemID。二者不能互顶。
    var accessRoute: CloudFileAccessRoute {
        let organization = organizationId.trimmingCharacters(in: .whitespacesAndNewlines)
        let contextItem = contextItemId.trimmingCharacters(in: .whitespacesAndNewlines)
        let fileRecord = fileRecordId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !organization.isEmpty && !contextItem.isEmpty {
            return .contextItem
        }
        if !fileRecord.isEmpty {
            return .fileRecord
        }
        return .missing
    }

    var displayTitle: String {
        title.isEmpty ? L10n.CloudDocs.untitled : title
    }

    var fileSizeText: String? {
        guard let fileSize, fileSize > 0 else { return nil }
        return ByteCountFormatter.string(fromByteCount: Int64(fileSize), countStyle: .file)
    }
}

enum CloudFileDetailAction: String, Equatable, Hashable, Sendable {
    case preview
    case openExternally
    case download
    case copyLink
    case share
    case collaborators
    case trash
}

enum CloudFileDetailPresentation {
    static func showsLiveImage(_ kind: CloudDriveFileKind) -> Bool {
        kind == .image
    }

    static func actions(
        canPreview: Bool,
        hasShareableLink: Bool,
        canManageCollaborators: Bool,
        canTrash: Bool
    ) -> [CloudFileDetailAction] {
        var items: [CloudFileDetailAction] = []
        if canPreview {
            items.append(.preview)
            items.append(.openExternally)
        }
        items.append(.download)
        if hasShareableLink {
            items.append(.copyLink)
            items.append(.share)
        }
        if canManageCollaborators { items.append(.collaborators) }
        if canTrash { items.append(.trash) }
        return items
    }
}

enum CloudFileSignedPreviewPolicy {
    static let previewMaxBytes = 5 * 1024 * 1024

    static func cacheKey(for context: CloudFileDetailContext) -> String? {
        switch context.accessRoute {
        case .contextItem:
            return "ctx:\(context.contextItemId.trimmingCharacters(in: .whitespacesAndNewlines))"
        case .fileRecord:
            return "file:\(context.fileRecordId.trimmingCharacters(in: .whitespacesAndNewlines))"
        case .missing:
            return nil
        }
    }

    static func httpURL(from raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowered = trimmed.lowercased()
        guard lowered.hasPrefix("http://") || lowered.hasPrefix("https://") else { return nil }
        return URL(string: trimmed)
    }
}
