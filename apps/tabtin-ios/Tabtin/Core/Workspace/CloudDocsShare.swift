import Foundation

/// 云文档公开分享支持的资源类型。
///
/// 刻意只覆盖 tabdoc / tabdata。tabfiles 没有公开链接，不要套同一套 URL。
enum CloudShareResourceType: String, Sendable, Hashable {
    case document
    case table

    /// 公网范围的 share_type 取值：doc 是 `"public"`，table 是 `"data"`。
    /// 这是后端的既有不对称——写死一边会让另一种资源静默开成错误范围。
    var anyoneWireValue: String {
        switch self {
        case .document: return "public"
        case .table: return "data"
        }
    }

    /// 公开分享页路径段：`/shared/docs|tables/{shareId}`。
    var publicPathSegment: String {
        switch self {
        case .document: return "docs"
        case .table: return "tables"
        }
    }

    /// 后端支持、且 UI 应展示的权限档位。table 没有 comment。
    var availablePermissions: [CloudSharePermission] {
        switch self {
        case .document: return [.view, .comment, .edit]
        case .table: return [.view, .edit]
        }
    }

    /// 从归一后的类型名解析。只认 `tabdoc` / `tabdata`。
    static func from(normalizedType: String) -> CloudShareResourceType? {
        switch normalizedType {
        case "tabdoc": return .document
        case "tabdata": return .table
        default: return nil
        }
    }
}

enum CloudShareScope: Sendable, Hashable, CaseIterable {
    case organization
    case anyone

    func wireValue(for type: CloudShareResourceType) -> String {
        switch self {
        case .organization: return "organization"
        case .anyone: return type.anyoneWireValue
        }
    }

    /// 反解 share_type。认不出来时返回 organization（保守，宁可显示成范围更小）。
    static func from(wireValue: String, type: CloudShareResourceType) -> CloudShareScope {
        if wireValue == "organization" { return .organization }
        if wireValue == type.anyoneWireValue { return .anyone }
        return .organization
    }
}

enum CloudSharePermission: String, Sendable, Hashable {
    case view
    case comment
    case edit
}

/// 后端 ShareOut / DataShareOut 的交集字段。
///
/// `allow_download` / `allow_copy` 本期不给 UI，先不解码。
/// TabData 的 DataShareOut 可能缺 `organization_id` / `is_active`，缺省要能解。
struct CloudDocShare: Decodable, Sendable, Hashable {
    let shareId: String
    let shareType: String
    let permission: String
    let hasPassword: Bool
    let expireAt: String?
    let organizationId: String?
    let visitCount: Int?
    let isActive: Bool
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case permission
        case shareId = "share_id"
        case shareType = "share_type"
        case hasPassword = "has_password"
        case expireAt = "expire_at"
        case organizationId = "organization_id"
        case visitCount = "visit_count"
        case isActive = "is_active"
        case createdAt = "created_at"
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        shareId = try container.decode(String.self, forKey: .shareId)
        shareType = try container.decode(String.self, forKey: .shareType)
        permission = try container.decode(String.self, forKey: .permission)
        hasPassword = try container.decodeIfPresent(Bool.self, forKey: .hasPassword) ?? false
        expireAt = try container.decodeIfPresent(String.self, forKey: .expireAt)
        organizationId = try container.decodeIfPresent(String.self, forKey: .organizationId)
        visitCount = try container.decodeIfPresent(Int.self, forKey: .visitCount)
        // TabData DataShareOut 无 is_active；能读到分享对象即视为生效中。
        isActive = try container.decodeIfPresent(Bool.self, forKey: .isActive) ?? true
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

enum CloudDocsShareError: Error, Sendable, Equatable {
    case forbidden
    case publicExposureNotAcknowledged
    case unsupportedResourceType
    case other(String)
}

// MARK: - 信封（data 内层，APIClient 已剥掉外层 success）

struct CloudDocShareFetchResponse: Decodable, Sendable {
    let share: CloudDocShare?
    let enabled: Bool?
}

struct CloudDocShareMutationResponse: Decodable, Sendable {
    let share: CloudDocShare
}

struct CloudDocShareDisableResponse: Decodable, Sendable {
    let disabledCount: Int?

    enum CodingKeys: String, CodingKey {
        case disabledCount = "disabled_count"
    }
}

struct CloudDocsCollaborator: Decodable, Identifiable, Sendable, Hashable {
    let userId: String
    let nickname: String
    let avatar: String?
    let email: String
    let permission: String
    var id: String { userId }

    /// 协作者接口使用 `editor` / `admin`；兼容早期环境曾返回的 `edit`，
    /// 但不把只读成员算作维护者。
    var canEdit: Bool {
        switch permission.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "admin", "editor", "edit": return true
        default: return false
        }
    }

    enum CodingKeys: String, CodingKey { case userId = "user_id", nickname, avatar, email, permission }
}

/// 协作者接口把 owner 单独放在顶层，且 owner 没有 permission 字段。
struct CloudDocsResourceOwner: Decodable, Identifiable, Sendable, Hashable {
    let userId: String
    let nickname: String
    let avatar: String?
    let email: String
    var id: String { userId }
    enum CodingKeys: String, CodingKey { case userId = "user_id", nickname, avatar, email }
}

struct CloudDocsCollaboratorList: Decodable, Sendable {
    let owner: CloudDocsResourceOwner?
    let collaborators: [CloudDocsCollaborator]
}

struct CloudDocsMutationAck: Decodable, Sendable {}
