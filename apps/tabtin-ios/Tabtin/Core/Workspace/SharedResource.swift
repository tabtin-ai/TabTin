import Foundation
import OSLog

enum SharedResourceType: String, Hashable, Sendable {
    case doc
    case table
    case file
}

/// 分享人。后端在 shared-with-me 响应里 enrich 出来，可能为空。
struct SharedResourceOwner: Codable, Hashable, Sendable {
    let id: String
    let displayName: String
    let avatar: String?

    enum CodingKeys: String, CodingKey {
        case id, avatar
        case displayName = "display_name"
    }
}

/// 别人分享给我的云资源。
///
/// 旧 shared-with-me 可能没有 contextItemId；云盘 shared-feed 会带回 contextItemId，
/// 文件另带 fileRecordId。
struct SharedResourceItem: Identifiable, Hashable, Sendable {
    let resourceType: SharedResourceType
    let resourceId: String
    let title: String
    let organizationId: String
    let spaceId: String?
    let permission: String
    let updatedAt: String?
    let sharedBy: SharedResourceOwner?
    var contextItemId: String? = nil
    var fileRecordId: String? = nil
    var preview: String? = nil
    var itemType: String? = nil
    var collectionId: String? = nil
    var canView: Bool? = nil
    var canEdit: Bool? = nil
    var canMove: Bool? = nil
    var canShare: Bool? = nil
    var canTrash: Bool? = nil
    var canDelete: Bool? = nil
    var metadata: [String: AnyCodable]? = nil

    var id: String {
        if let contextItemId, !contextItemId.isEmpty {
            return "shared:\(resourceType.rawValue):\(contextItemId)"
        }
        return "shared:\(resourceType.rawValue):\(resourceId)"
    }

    var displayTitle: String { title.isEmpty ? L10n.CloudDocs.untitled : title }

    var appRoute: SpaceAppRoute? {
        guard !resourceId.isEmpty else { return nil }
        switch resourceType {
        case .doc: return .tabdoc(documentId: resourceId, documentName: displayTitle)
        case .table: return .tabdata(tableId: resourceId, tableName: displayTitle)
        case .file:
            guard let contextItemId, !contextItemId.isEmpty else { return nil }
            return .tabfiles(context: CloudFileDetailContext(shared: self))
        }
    }
}

struct SharedDocRow: Decodable, Sendable {
    let documentId: String
    let title: String
    /// 后端对未归属组织的资源会返回 `null`。降级为空串而不是让它可空：
    /// 下游拿到的仍是非可选契约，同时一行脏数据不会把整批解码打掉。
    let organizationId: String
    let spaceId: String?
    let permission: String
    let updatedAt: String?
    let sharedBy: SharedResourceOwner?

    enum CodingKeys: String, CodingKey {
        case title, permission
        case documentId = "document_id"
        case organizationId = "organization_id"
        case spaceId = "space_id"
        case updatedAt = "updated_at"
        case sharedBy = "shared_by"
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        documentId = try container.decode(String.self, forKey: .documentId)
        title = try container.decode(String.self, forKey: .title)
        organizationId = try container.decodeIfPresent(String.self, forKey: .organizationId) ?? ""
        spaceId = try container.decodeIfPresent(String.self, forKey: .spaceId)
        permission = try container.decodeIfPresent(String.self, forKey: .permission) ?? ""
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        sharedBy = try container.decodeIfPresent(SharedResourceOwner.self, forKey: .sharedBy)
    }

    func asSharedResourceItem() -> SharedResourceItem {
        SharedResourceItem(
            resourceType: .doc,
            resourceId: documentId,
            title: title,
            organizationId: organizationId,
            spaceId: SharedResourceNormalizer.normalizedId(spaceId),
            permission: permission,
            updatedAt: updatedAt,
            sharedBy: sharedBy
        )
    }
}

struct SharedTableRow: Decodable, Sendable {
    let tableId: String
    let title: String
    /// 表格端点显式允许 `organization_id` 为 null，见 tabdata `share_service`。
    /// 降级为空串，避免单行 null 让整个表格来源解码失败、被判成「表格全挂」。
    let organizationId: String
    let spaceId: String?
    let permission: String
    let updatedAt: String?
    let sharedBy: SharedResourceOwner?

    enum CodingKeys: String, CodingKey {
        case title, permission
        case tableId = "table_id"
        case organizationId = "organization_id"
        case spaceId = "space_id"
        case updatedAt = "updated_at"
        case sharedBy = "shared_by"
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableId = try container.decode(String.self, forKey: .tableId)
        title = try container.decode(String.self, forKey: .title)
        organizationId = try container.decodeIfPresent(String.self, forKey: .organizationId) ?? ""
        spaceId = try container.decodeIfPresent(String.self, forKey: .spaceId)
        permission = try container.decodeIfPresent(String.self, forKey: .permission) ?? ""
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        sharedBy = try container.decodeIfPresent(SharedResourceOwner.self, forKey: .sharedBy)
    }

    func asSharedResourceItem() -> SharedResourceItem {
        SharedResourceItem(
            resourceType: .table,
            resourceId: tableId,
            title: title,
            organizationId: organizationId,
            spaceId: SharedResourceNormalizer.normalizedId(spaceId),
            permission: permission,
            updatedAt: updatedAt,
            sharedBy: sharedBy
        )
    }
}

enum SharedResourceNormalizer {
    /// 后端在「只分享到组织、没落到具体 Workspace」时返回空串，统一归一成 nil。
    static func normalizedId(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

struct SharedDocsResponse: Decodable, Sendable {
    let documents: [SharedDocRow]?
}

struct SharedTablesResponse: Decodable, Sendable {
    let tables: [SharedTableRow]?
}

/// 聚合「分享给我」的文档与表格。
///
/// 云文档域不收文件，所以不调 `/context/files/shared-with-me`。
/// 单个来源失败降级为空列表，两个都失败才向上抛——一类资源挂了不该让整页空白。
enum SharedResourcesService {
    private static let logger = Logger(subsystem: "com.tabtin.mobile", category: "SharedResources")

    static func listSharedWithMe(organizationId: String) async throws -> [SharedResourceItem] {
        // 两个端点的过滤条件都是 `if organization_id`：传空串等于不过滤，
        // 会把其他组织的分享项一并返回。所以宁可不发请求。
        let organization = try validatedOrganizationId(organizationId)
        let query = ["organization_id": organization]

        async let docsTask = fetch(
            SharedDocsResponse.self,
            path: Endpoints.TabDoc.sharedWithMe,
            query: query,
            source: "tabdoc"
        )
        async let tablesTask = fetch(
            SharedTablesResponse.self,
            path: Endpoints.TabData.sharedWithMe,
            query: query,
            source: "tabdata"
        )
        let (docs, tables) = await (docsTask, tablesTask)

        // 父任务被取消时两个来源都会失败。先让取消原样往上抛，
        // 否则会被判成「两边都挂了」，给用户弹一个莫名其妙的加载失败。
        try Task.checkCancellation()

        if let docsFailure = docs.failure, let tablesFailure = tables.failure {
            logger.error(
                """
                shared-with-me 两个来源都失败 \
                tabdoc=\(docsFailure, privacy: .public) tabdata=\(tablesFailure, privacy: .public)
                """
            )
        }

        return try resolve(docs: docs.value, tables: tables.value)
    }

    /// 工作台按 App 类型展示“分享给我”时的旧服务兼容入口。
    ///
    /// 新版优先走统一 shared-feed；只有该路由尚未部署并明确返回 HTTP 404 时，
    /// 调用方才回退到这里。单类型请求必须保留真实失败，不能沿用聚合页的单路吞错语义。
    static func listSharedWithMe(
        organizationId: String,
        resourceType: SharedResourceType
    ) async throws -> [SharedResourceItem] {
        let organization = try validatedOrganizationId(organizationId)
        let query = ["organization_id": organization]

        switch resourceType {
        case .doc:
            let response: SharedDocsResponse = try await APIClient.shared.get(
                path: Endpoints.TabDoc.sharedWithMe,
                query: query
            )
            return (response.documents ?? []).map { $0.asSharedResourceItem() }
        case .table:
            let response: SharedTablesResponse = try await APIClient.shared.get(
                path: Endpoints.TabData.sharedWithMe,
                query: query
            )
            return (response.tables ?? []).map { $0.asSharedResourceItem() }
        case .file:
            throw APIError.apiError(L10n.CloudDocs.sharedLoadFailed)
        }
    }

    /// 判定降级：任一来源活着就用它，两边都挂才向上抛。
    ///
    /// 抽成纯函数是为了让这条判定本身可测——单边失败是这个功能最常走的路径，
    /// 靠 `merged` 的数组拼接断言覆盖不到它。
    static func resolve(
        docs: SharedDocsResponse?,
        tables: SharedTablesResponse?
    ) throws -> [SharedResourceItem] {
        guard docs != nil || tables != nil else {
            throw APIError.apiError(L10n.CloudDocs.sharedLoadFailed)
        }
        return merged(
            docs: (docs?.documents ?? []).map { $0.asSharedResourceItem() },
            tables: (tables?.tables ?? []).map { $0.asSharedResourceItem() }
        )
    }

    /// 取单个来源；失败降级为 nil，并记下是哪个来源、错了什么。
    /// 日志只带来源名与错误描述，不带资源标题 / 分享人等用户内容。
    private static func fetch<T: Decodable & Sendable>(
        _ type: T.Type,
        path: String,
        query: [String: String],
        source: String
    ) async -> (value: T?, failure: String?) {
        do {
            let response: T = try await APIClient.shared.get(path: path, query: query)
            return (response, nil)
        } catch {
            // 取消不是故障：视图重建 / 下拉刷新替换旧 Task 时两边都会走到这里。
            guard !error.isCancellation else { return (nil, nil) }
            logger.error(
                "shared-with-me 来源 \(source, privacy: .public) 失败：\(error.localizedDescription, privacy: .public)"
            )
            return (nil, error.localizedDescription)
        }
    }

    /// 合并两个来源并按更新时间倒序；没有时间的排最后。
    static func merged(
        docs: [SharedResourceItem],
        tables: [SharedResourceItem]
    ) -> [SharedResourceItem] {
        (docs + tables).sorted { lhs, rhs in
            let l = lhs.updatedAt.flatMap(ISO8601DateParser.date(from:))?.timeIntervalSince1970 ?? 0
            let r = rhs.updatedAt.flatMap(ISO8601DateParser.date(from:))?.timeIntervalSince1970 ?? 0
            if l == r { return lhs.title < rhs.title }
            return l > r
        }
    }

    private static func validatedOrganizationId(_ organizationId: String) throws -> String {
        let organization = organizationId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !organization.isEmpty else {
            logger.error("shared-with-me 缺少 organization_id，已拦截请求")
            throw APIError.apiError(L10n.CloudDocs.sharedLoadFailed)
        }
        return organization
    }
}

/// 后端时间戳带小数秒时 `ISO8601DateFormatter` 默认解析会失败，这里两种格式都试。
enum ISO8601DateParser {
    // ISO8601DateFormatter：实例配置完成后并发只读调用 .date(from:) 安全。
    private nonisolated(unsafe) static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private nonisolated(unsafe) static let plain = ISO8601DateFormatter()

    static func date(from string: String) -> Date? {
        withFractional.date(from: string) ?? plain.date(from: string)
    }
}
