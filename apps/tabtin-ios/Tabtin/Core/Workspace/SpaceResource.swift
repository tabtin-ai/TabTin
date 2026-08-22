import Foundation

/// 统一资源模型，对齐 Electron `SpaceContextItem`。
/// 数据来源可以是 Space 或 Organization 级 context-items 接口。
///
/// 一个 Space「有哪些内嵌 App / 实例」不在 Space 模型里，而是由该 Space 的 context-items
/// 推导：每条 item 的 `item_type`（经 normalizedType 归一）= App 类型，`resource_id` = App 实例 id。
/// 移植自 apps/tabtin-ios，裁掉 RelativeTimeFormatter 依赖（保留 sortTimestamp）。
struct SpaceResource: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let itemType: String
    let title: String
    let preview: String?
    let resourceId: String
    /// 组织直属资源无 Space 宿主，服务端会返回 `null`。
    let spaceId: String?
    let organizationId: String?
    let metadata: [String: AnyCodable]?
    let isArchived: Bool?
    let isPinned: Bool?
    let pinnedAt: String?
    let updatedAt: String?
    let createdAt: String?
    /// 仅在 `?scope=organization` 查询下由后端注入。space 级查询为 nil。
    let spaceName: String?
    /// per-user 访问时间；后端在 context-items 列表里按当前用户回填，未访问过为 nil。
    /// 声明为 `var` 而非 `let`：optional `var` 在合成的 memberwise init 里默认为 nil，
    /// 既有调用方不必逐个补参数（`let` optional 则会强制所有调用方传值）。
    var lastVisitedAt: String?
    /// 资源所有者，由后端 `_enrich_owner_info` 注入。同上用 `var` 保住既有调用方。
    var owner: SpaceResourceOwner?
    /// 能否开公开链接 / 邀请协作者，由后端 `_enrich_capabilities` 注入。
    /// 门槛是资源级 admin：owner 通过，editor 不通过。
    ///
    /// 只有 context-items 列表回填这一位，知识树接口不吐，所以拿不到时是 `nil`
    /// 而不是 `false`——两者要分开处理：`nil` 是「不知道」，`false` 是「确定不行」。
    var collectionId: String?
    var canShare: Bool?
    var canView: Bool?
    var canEdit: Bool?
    var canMove: Bool?
    var canTrash: Bool?
    var canDelete: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case itemType = "item_type"
        case title, preview
        case resourceId = "resource_id"
        case spaceId = "space_id"
        case organizationId = "organization_id"
        case collectionId = "collection_id"
        case metadata
        case isArchived = "is_archived"
        case isPinned = "is_pinned"
        case pinnedAt = "pinned_at"
        case updatedAt = "updated_at"
        case createdAt = "created_at"
        case spaceName = "space_name"
        case lastVisitedAt = "last_visited_at"
        case owner
        case canShare = "can_share"
        case canView = "can_view"
        case canEdit = "can_edit"
        case canMove = "can_move"
        case canTrash = "can_trash"
        case canDelete = "can_delete"
    }

    var contextItemId: String { id }

    var fileRecordId: String? {
        normalizedType == "tabfiles" ? resourceId : nil
    }

    var fileName: String? {
        Self.metadataString(metadata, keys: ["file_name", "filename", "name", "original_name", "display_name"])
    }

    var mimeType: String? {
        Self.metadataString(metadata, keys: ["mime_type", "mime", "content_type", "contentType"])
    }

    var fileSizeBytes: Int? {
        Self.metadataInt(metadata, keys: ["size", "file_size", "size_bytes", "bytes"])
    }

    var fileExtension: String? {
        Self.metadataString(metadata, keys: ["file_extension", "extension", "ext"])
    }

    var thumbnailURL: String? {
        Self.metadataString(metadata, keys: ["thumbnail_url", "thumb_url", "cover_url"])
    }

    static func metadataString(_ metadata: [String: AnyCodable]?, keys: [String]) -> String? {
        guard let metadata else { return nil }
        for key in keys {
            if let value = metadata[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
               !value.isEmpty {
                return value
            }
        }
        return nil
    }

    static func metadataInt(_ metadata: [String: AnyCodable]?, keys: [String]) -> Int? {
        guard let metadata else { return nil }
        for key in keys {
            if let intValue = metadata[key]?.intValue { return intValue }
            if let doubleValue = metadata[key]?.doubleValue { return Int(doubleValue) }
            if let stringValue = metadata[key]?.stringValue, let parsed = Int(stringValue) {
                return parsed
            }
        }
        return nil
    }

    var displayTitle: String { title.isEmpty ? L10n.CloudDocs.untitled : title }

    // ISO8601DateFormatter：实例配置完成后并发只读调用 .date(from:) 安全。
    private nonisolated(unsafe) static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private nonisolated(unsafe) static let isoFallback: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    var sortTimestamp: Date {
        let ts = updatedAt ?? createdAt ?? ""
        return Self.isoFormatter.date(from: ts) ?? Self.isoFallback.date(from: ts) ?? .distantPast
    }

    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    /// `lastVisitedAt` 是「最近」分段的排序键，必须纳入相等判定：
    /// 漏掉它，SwiftUI 数组 diff / `.onChange(of:)` / 按值去重都看不见访问时间变化，
    /// 乐观更新会静默丢失，表现成「点进去再回来顺序没动」。
    /// 收紧 `==` 不破坏 Hashable 契约——`hash(into:)` 只 combine `id`，相等仍蕴含同哈希。
    static func == (lhs: SpaceResource, rhs: SpaceResource) -> Bool {
        lhs.id == rhs.id
            && lhs.title == rhs.title
            && lhs.updatedAt == rhs.updatedAt
            && lhs.lastVisitedAt == rhs.lastVisitedAt
    }
}

/// 资源所有者。后端 `_enrich_owner_info` 注入 `{id, display_name, avatar}`。
///
/// 三个字段全可选：enrich 是查用户表补出来的，用户被删或查不到时后端会吐
/// `null`，把任何一个声明成必填都会让整条资源解码失败、整页列表变空。
struct SpaceResourceOwner: Codable, Hashable, Sendable {
    let id: String?
    let displayName: String?
    let avatar: String?

    enum CodingKeys: String, CodingKey {
        case id
        case displayName = "display_name"
        case avatar
    }

    /// 拿不到名字就当没有所有者信息，让调用方省掉这一段而不是显示空字符串。
    var presentableName: String? {
        guard let displayName, !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return displayName
    }
}

struct SpaceResourceListResponse: Decodable, Sendable {
    let items: [SpaceResource]
    let total: Int?
    let page: Int?
    let pageSize: Int?

    enum CodingKeys: String, CodingKey {
        case items, total, page
        case pageSize = "page_size"
    }
}

/// Composer / Workbench 引用候选的 context-items 查询口径。
///
/// 集中在资源模型边界，避免独立选择器与 Composer 预加载各写一份参数后再次漂移。
enum MentionableResourceListQuery {
    static let parameters = [
        "is_archived": "false",
        "page_size": "200",
        "scope": "organization",
    ]
}

// MARK: - 展示与归一

extension SpaceResource {
    /// 别名归一：后端历史返回 table/document/site 等，统一到 tab* 口径。
    var normalizedType: String {
        Self.normalizedType(itemType)
    }

    static func normalizedType(_ rawType: String) -> String {
        let aliases: [String: String] = [
            "table": "tabdata", "document": "tabdoc",
            "doc": "tabdoc",
            "slide": "tabslide", "ppt": "tabslide",
            "video": "tabvideo",
            "canvas": "tabwhiteboard", "memo": "tabmemo",
            "site": "tabsite", "code": "tabcode",
            "file": "tabfiles", "files": "tabfiles", "tabfile": "tabfiles",
            "goal": "tabtracker", "tabgoal": "tabtracker",
        ]
        return aliases[rawType] ?? rawType
    }

    var icon: String { Self.icon(forType: normalizedType) }

    static func icon(forType type: String) -> String {
        switch type {
        case "tabdata": return "tablecells"
        case "tabdoc": return "doc.text"
        case "tabslide": return "rectangle.on.rectangle.angled"
        case "tabvideo": return "film"
        case "tabwhiteboard": return "scribble.variable"
        case "tabmemo": return "note.text"
        case "tabsite": return "globe"
        case "tabcode": return "chevron.left.forwardslash.chevron.right"
        case "tabfiles": return "folder"
        case "tabtracker", "tabgoal": return "target"
        case "widget": return "photo.on.rectangle"
        default: return "doc"
        }
    }

    var typeLabel: String { Self.typeLabel(forType: normalizedType, fallback: itemType) }

    static func typeLabel(forType type: String, fallback: String? = nil) -> String {
        switch type {
        case "tabdata": return "TabData"
        case "tabdoc": return "TabDoc"
        case "tabslide": return "TabSlide"
        case "tabvideo": return "TabVideo"
        case "tabwhiteboard": return "TabWhiteboard"
        case "tabmemo": return "TabMemo"
        case "tabsite": return "TabSite"
        case "tabcode": return "TabCode"
        case "tabfiles": return "TabFiles"
        case "tabtracker", "tabgoal": return "TabTracker"
        case "widget": return "图示"
        default: return fallback ?? type
        }
    }

    /// 可在 iOS 内嵌打开的目标路由。返回 nil 表示该类型暂不支持「打开」（仅展示）。
    /// Phase 5 起逐个内嵌 App 上线，这里相应增加 case；Workbench 决定具体承载方式。
    var appRoute: SpaceAppRoute? {
        switch normalizedType {
        case "tabdoc":
            return .tabdoc(documentId: resourceId, documentName: displayTitle)
        case "tabdata":
            return .tabdata(tableId: resourceId, tableName: displayTitle)
        case "tabsite":
            let publishedUrl = metadata?["published_url"]?.stringValue
                ?? metadata?["dist_oss_url"]?.stringValue
            return .tabsite(siteId: resourceId, siteUrl: publishedUrl, siteName: displayTitle)
        case "tabslide":
            return .tabslide(slideId: resourceId, slideName: displayTitle)
        case "tabmemo":
            return .tabmemo(memoId: resourceId, memoName: displayTitle, spaceName: spaceName)
        case "tabfiles":
            return .tabfiles(context: CloudFileDetailContext(resource: self))
        default:
            return nil
        }
    }

    /// 该类型在 iOS 上有没有内嵌承载页——case 集合与 `appRoute` 保持一致（有单测钉住）。
    /// 供「只知道 App 类型、手上没有具体资源」的判断使用，例如工作台要不要给这个 App 开首页。
    static func hasAppRoute(forType rawType: String) -> Bool {
        switch normalizedType(rawType) {
        case "tabdoc", "tabdata", "tabsite", "tabslide", "tabmemo", "tabfiles":
            return true
        default:
            return false
        }
    }

    func withPinned(_ pinned: Bool, pinnedAt newPinnedAt: String? = nil) -> SpaceResource {
        var copy = SpaceResource(
            id: id,
            itemType: itemType,
            title: title,
            preview: preview,
            resourceId: resourceId,
            spaceId: spaceId,
            organizationId: organizationId,
            metadata: metadata,
            isArchived: isArchived,
            isPinned: pinned,
            pinnedAt: pinned ? (newPinnedAt ?? pinnedAt) : nil,
            updatedAt: updatedAt,
            createdAt: createdAt,
            spaceName: spaceName,
            lastVisitedAt: lastVisitedAt
        )
        copy.owner = owner
        copy.collectionId = collectionId
        copy.canShare = canShare
        copy.canView = canView
        copy.canEdit = canEdit
        copy.canMove = canMove
        copy.canTrash = canTrash
        copy.canDelete = canDelete
        return copy
    }
}

/// 内嵌 App 打开路由。随 Phase 5 逐个 App 迁移增加 case。
enum SpaceAppRoute: Hashable {
    case tabdoc(documentId: String, documentName: String)
    case tabdata(tableId: String, tableName: String)
    case tabsite(siteId: String, siteUrl: String?, siteName: String)
    case tabslide(slideId: String, slideName: String)
    case tabmemo(memoId: String, memoName: String, spaceName: String?)
    case tabfiles(context: CloudFileDetailContext)
}

struct SpaceResourceOpenRequest: Hashable, Sendable {
    let resourceType: String
    let resourceId: String
    let title: String?
    let locationHint: String?

    var normalizedType: String {
        SpaceResource.normalizedType(resourceType)
    }

    var fallbackRoute: SpaceAppRoute? {
        let fallbackTitle = (title?.isEmpty == false) ? title! : nil
        switch normalizedType {
        case "tabdoc":
            return .tabdoc(documentId: resourceId, documentName: fallbackTitle ?? "TabDoc")
        case "tabdata":
            return .tabdata(tableId: resourceId, tableName: fallbackTitle ?? "TabData")
        case "tabsite":
            return .tabsite(siteId: resourceId, siteUrl: nil, siteName: fallbackTitle ?? "TabSite")
        case "tabslide":
            return .tabslide(slideId: resourceId, slideName: fallbackTitle ?? "TabSlide")
        case "tabmemo":
            return .tabmemo(memoId: resourceId, memoName: fallbackTitle ?? "Memo", spaceName: nil)
        default:
            return nil
        }
    }

    func route(in resources: [SpaceResource]) -> SpaceAppRoute? {
        let matched = resources.first { resource in
            resource.resourceId == resourceId
                || resource.id == resourceId
                || (resource.normalizedType == normalizedType && resource.resourceId == resourceId)
        }
        return matched?.appRoute ?? fallbackRoute
    }

    var unsupportedOpenNotice: String {
        var message = "这个资源类型暂不支持在 iOS 内打开，已为你定位到工作台。"
        if let locationHint, !locationHint.isEmpty {
            message += "\n定位线索：\(locationHint)"
        }
        return message
    }
}
