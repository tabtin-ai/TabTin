import Foundation

/// Project 是团队协作场景；后端物理实现仍是 Space(type=team_space)。
/// 移动端只消费协作字段，不把本地目录或设备误建模为 Project 自身属性。
struct Project: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let organizationId: String
    let type: String?
    let name: String
    let description: String?
    let avatar: String?
    let color: String?
    let status: String?
    let isArchived: Bool?
    let visibility: String?
    let memberCount: Int?
    let primaryAgentId: String?
    let canManage: Bool?
    let lastActivityAt: String?
    let createdAt: String?
    let updatedAt: String?
    let myWorkspace: ProjectCompanionWorkspace?

    enum CodingKeys: String, CodingKey {
        case id, type, name, description, avatar, color, status, visibility
        case organizationId = "organization_id"
        case isArchived = "is_archived"
        case memberCount = "member_count"
        case primaryAgentId = "primary_agent_id"
        case canManage = "can_manage"
        case lastActivityAt = "last_activity_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case myWorkspace = "my_workspace"
    }

    var displayDescription: String? {
        guard let value = description?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }

    var displayTime: String? {
        guard let value = lastActivityAt ?? updatedAt ?? createdAt else { return nil }
        return RelativeTime.format(value)
    }
}

struct ProjectCompanionWorkspace: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String?
    let agentId: String?
    let executionAgentId: String?
    let workingDir: String?
    let controlDeviceId: String?
    let controlDeviceStatus: String?
    let isCompanion: Bool?

    enum CodingKeys: String, CodingKey {
        case id, name
        case agentId = "agent_id"
        case executionAgentId = "execution_agent_id"
        case workingDir = "working_dir"
        case controlDeviceId = "control_device_id"
        case controlDeviceStatus = "control_device_status"
        case isCompanion = "is_companion"
    }
}

struct ProjectListResponse: Decodable, Sendable {
    let projects: [Project]
    let total: Int?
}

struct ProjectPrimaryAgentResponse: Decodable, Sendable {
    let projectId: String
    let primaryAgentId: String?

    enum CodingKeys: String, CodingKey {
        case projectId = "project_id"
        case primaryAgentId = "primary_agent_id"
    }
}

struct PendingProjectInvitation: Codable, Identifiable, Hashable, Sendable {
    let projectId: String
    let projectName: String
    let organizationId: String
    let role: String
    let inviterName: String
    let invitedAt: String?

    var id: String { projectId }

    enum CodingKeys: String, CodingKey {
        case role
        case projectId = "project_id"
        case projectName = "project_name"
        case organizationId = "organization_id"
        case inviterName = "inviter_name"
        case invitedAt = "invited_at"
    }
}

struct PendingProjectInvitationListResponse: Decodable, Sendable {
    let invitations: [PendingProjectInvitation]
    let total: Int?
}

struct ProjectDiscussion: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let organizationId: String
    let spaceId: String?
    let spaceName: String?
    let isTeamSpaceChannel: Bool
    let name: String
    let memberCount: Int?
    let isArchived: Bool
    let lastMessageAt: String?
    let lastMessagePreview: String?
    let unreadCount: Int

    enum CodingKeys: String, CodingKey {
        case id, name
        case organizationId = "organization_id"
        case spaceId = "space_id"
        case spaceName = "space_name"
        case isTeamSpaceChannel = "is_team_space_channel"
        case memberCount = "member_count"
        case isArchived = "is_archived"
        case lastMessageAt = "last_message_at"
        case lastMessagePreview = "last_message_preview"
        case unreadCount = "unread_count"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        organizationId = try c.decode(String.self, forKey: .organizationId)
        spaceId = try c.decodeIfPresent(String.self, forKey: .spaceId)
        spaceName = try c.decodeIfPresent(String.self, forKey: .spaceName)
        isTeamSpaceChannel = try c.decodeIfPresent(Bool.self, forKey: .isTeamSpaceChannel) ?? false
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        memberCount = try c.decodeIfPresent(Int.self, forKey: .memberCount)
        isArchived = try c.decodeIfPresent(Bool.self, forKey: .isArchived) ?? false
        lastMessageAt = try c.decodeIfPresent(String.self, forKey: .lastMessageAt)
        lastMessagePreview = try c.decodeIfPresent(String.self, forKey: .lastMessagePreview)
        unreadCount = try c.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0
    }
}

struct ProjectActivityEvent: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let eventType: String
    let actorUserId: String?
    let actorName: String?
    let targetType: String?
    let targetId: String?
    let targetName: String?
    let metadata: [String: AnyCodable]?
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, metadata
        case eventType = "event_type"
        case actorUserId = "actor_user_id"
        case actorName = "actor_name"
        case targetType = "target_type"
        case targetId = "target_id"
        case targetName = "target_name"
        case createdAt = "created_at"
    }

    var displayTime: String? { RelativeTime.format(createdAt) }
}

struct ProjectActivityListResponse: Decodable, Sendable {
    let items: [ProjectActivityEvent]
    let total: Int?
    let page: Int?
    let limit: Int?
}

struct ProjectMembership: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let spaceId: String
    let agentId: String?
    let userId: String?
    let role: String
    let isActive: Bool
    let roleLabel: String?
    let responsibility: String?
    let personaOverride: String?
    let isPrimary: Bool?
    let joinedAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, role
        case spaceId = "space_id"
        case agentId = "agent_id"
        case userId = "user_id"
        case isActive = "is_active"
        case roleLabel = "role_label"
        case responsibility
        case personaOverride = "persona_override"
        case isPrimary = "is_primary"
        case joinedAt = "joined_at"
        case updatedAt = "updated_at"
    }
}

struct ProjectMembershipListResponse: Decodable, Sendable {
    let memberships: [ProjectMembership]
    let total: Int?
}

struct ProjectParticipant: Identifiable, Hashable, Sendable {
    enum Kind: String, Hashable, Sendable {
        case member
        case agent
    }

    let id: String
    let name: String
    let kind: Kind
    let role: String
    let roleLabel: String?
    let responsibility: String?
    /// 人类成员用户 id；Agent 为 nil。点成员行开私信用。
    let userId: String?
    let agentId: String?
    let ownedByCurrentUser: Bool
    let isPrimary: Bool
}
