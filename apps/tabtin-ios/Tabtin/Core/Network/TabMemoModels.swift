import Foundation

/// Memo App 首页数据契约 DTO（Task 2）。
/// 完整首页 UI 属 Task 3；此处只钉 Endpoints / 解码模型 / 取消语义挂钩点。

enum MemoAppHomeFeatureFlags {
    /// Electron 已迁到 Organization diary feed；生产仍隐藏「Agent 日记」，
    /// 等 Task 3 App Home UI 接好 `diary-feed` 后再翻开。未就绪不得用空列表伪装。
    static let isOrganizationAgentDiaryEnabled = false
}

struct MemoHeatmapBucket: Decodable, Hashable, Sendable {
    let date: String
    let count: Int
}

struct MemoHeatmapResponse: Decodable, Sendable {
    let buckets: [MemoHeatmapBucket]
    let total: Int
    let days: Int
}

struct MemoTagStatsItem: Decodable, Hashable, Sendable {
    let name: String
    let count: Int
    let aiOnly: Bool

    enum CodingKeys: String, CodingKey {
        case name
        case count
        case aiOnly = "ai_only"
    }
}

struct MemoTagStatsResponse: Decodable, Sendable {
    let tags: [MemoTagStatsItem]
    let totalUserTags: Int?
    let totalAiTags: Int?

    enum CodingKeys: String, CodingKey {
        case tags
        case totalUserTags = "total_user_tags"
        case totalAiTags = "total_ai_tags"
    }
}

struct AgentDiaryFeedItem: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let agentId: String
    let agentName: String
    let agentAvatar: String?
    let memoryType: String
    let content: String
    let tags: [String]
    let importance: Int?
    let sourceRef: String?
    let createdAt: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case agentId = "agent_id"
        case agentName = "agent_name"
        case agentAvatar = "agent_avatar"
        case memoryType = "memory_type"
        case content
        case tags
        case importance
        case sourceRef = "source_ref"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct AgentDiaryFeedResponse: Decodable, Sendable {
    let items: [AgentDiaryFeedItem]
    let nextCursor: String
    let hasMore: Bool
    let limit: Int?
    let memoryEnabled: Bool?
    let legacyPolicy: String?

    enum CodingKeys: String, CodingKey {
        case items
        case nextCursor = "next_cursor"
        case hasMore = "has_more"
        case limit
        case memoryEnabled = "memory_enabled"
        case legacyPolicy = "legacy_policy"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decodeIfPresent([AgentDiaryFeedItem].self, forKey: .items) ?? []
        nextCursor = try container.decodeIfPresent(String.self, forKey: .nextCursor) ?? ""
        hasMore = try container.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
        limit = try container.decodeIfPresent(Int.self, forKey: .limit)
        memoryEnabled = try container.decodeIfPresent(Bool.self, forKey: .memoryEnabled)
        legacyPolicy = try container.decodeIfPresent(String.self, forKey: .legacyPolicy)
    }
}

/// 列表请求世代号：切 Organization / view / search 时递增并取消旧请求。
actor MemoListRequestGate {
    private var generation: UInt64 = 0

    @discardableResult
    func begin() -> UInt64 {
        generation &+= 1
        return generation
    }

    func isCurrent(_ token: UInt64) -> Bool {
        token == generation
    }

    func cancelOutstanding() {
        generation &+= 1
    }
}
