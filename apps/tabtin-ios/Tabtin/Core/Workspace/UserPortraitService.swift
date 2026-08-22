import Foundation

enum UserPortraitDistillStatus: String, Codable, Sendable {
    case idle
    case pending
    case failed
}

/// 某个 AI 分身对当前用户的综合理解，严格按 (organization_id, agent_id) 隔离。
struct UserPortrait: Codable, Equatable, Sendable {
    let id: String
    let userId: String
    let organizationId: String
    let agentId: String?
    let contentMd: String
    let version: Int
    let lastDistilledAt: String?
    let lastDistillStatus: UserPortraitDistillStatus
    let lastDistillError: String
    let pendingHintsCount: Int
    let memoryEnabled: Bool?
    let createdAt: String
    let updatedAt: String
    let softWarning: String?
    let distillDispatched: Bool?
    let accepted: Bool?
    let message: String?

    enum CodingKeys: String, CodingKey {
        case id, version, accepted, message
        case userId = "user_id"
        case organizationId = "organization_id"
        case agentId = "agent_id"
        case contentMd = "content_md"
        case lastDistilledAt = "last_distilled_at"
        case lastDistillStatus = "last_distill_status"
        case lastDistillError = "last_distill_error"
        case pendingHintsCount = "pending_hints_count"
        case memoryEnabled = "memory_enabled"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case softWarning = "soft_warning"
        case distillDispatched = "distill_dispatched"
    }
}

struct UserPortraitSnapshot: Codable, Equatable, Sendable {
    let id: String
    let versionAtSnapshot: Int
    let contentMd: String
    let triggerReason: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case versionAtSnapshot = "version_at_snapshot"
        case contentMd = "content_md"
        case triggerReason = "trigger_reason"
        case createdAt = "created_at"
    }
}

struct UserPortraitSnapshotList: Codable, Equatable, Sendable {
    let items: [UserPortraitSnapshot]
    let count: Int
}

enum UserPortraitService {
    private static let basePath = "/user-portrait/me"

    nonisolated static func endpoint(organizationId: String, suffix: String = "") -> String {
        let encoded = organizationId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
            ?? organizationId
        return "\(basePath)/\(encoded)\(suffix)"
    }

    /// 四个画像端点必须共享同一个 per-Agent 查询契约。
    nonisolated static func query(agentId: String, limit: Int? = nil) -> [String: String] {
        var query = ["agent_id": agentId]
        if let limit { query["limit"] = String(limit) }
        return query
    }

    static func get(organizationId: String, agentId: String) async throws -> UserPortrait {
        try validate(organizationId: organizationId, agentId: agentId)
        return try await APIClient.shared.get(
            path: endpoint(organizationId: organizationId),
            query: query(agentId: agentId)
        )
    }

    static func submitHint(
        organizationId: String,
        agentId: String,
        text: String
    ) async throws -> UserPortrait {
        try validate(organizationId: organizationId, agentId: agentId)
        return try await APIClient.shared.post(
            path: endpoint(organizationId: organizationId, suffix: "/hint"),
            body: ["text": text],
            query: query(agentId: agentId)
        )
    }

    static func triggerDistill(organizationId: String, agentId: String) async throws -> UserPortrait {
        try validate(organizationId: organizationId, agentId: agentId)
        return try await APIClient.shared.post(
            path: endpoint(organizationId: organizationId, suffix: "/distill"),
            body: [:],
            query: query(agentId: agentId)
        )
    }

    static func snapshots(
        organizationId: String,
        agentId: String,
        limit: Int = 20
    ) async throws -> UserPortraitSnapshotList {
        try validate(organizationId: organizationId, agentId: agentId)
        return try await APIClient.shared.get(
            path: endpoint(organizationId: organizationId, suffix: "/snapshots"),
            query: query(agentId: agentId, limit: limit)
        )
    }

    private static func validate(organizationId: String, agentId: String) throws {
        guard !organizationId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw APIError.apiErrorWithCode(
                code: "INVALID_ORGANIZATION_ID",
                message: L10n.Agent.userPortraitNoOrganization
            )
        }
        guard !agentId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw APIError.apiErrorWithCode(
                code: "INVALID_AGENT_ID",
                message: "AI 分身 ID 不能为空"
            )
        }
    }
}

func parseUserPortraitSections(_ content: String) -> [(title: String, body: String)] {
    let lines = content.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")
    guard lines.contains(where: { !$0.isEmpty }) else { return [] }

    var result: [(title: String, body: String)] = []
    var title = ""
    var body: [String] = []

    func appendCurrent() {
        let text = body.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty || !text.isEmpty else { return }
        result.append((title: title, body: text))
    }

    for line in lines {
        if line.hasPrefix("## ") {
            appendCurrent()
            title = String(line.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
            body = []
        } else {
            body.append(line)
        }
    }
    appendCurrent()
    return result
}
