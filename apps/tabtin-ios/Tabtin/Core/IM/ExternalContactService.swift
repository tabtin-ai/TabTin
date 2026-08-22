import Foundation

struct ExternalContact: Codable, Identifiable, Hashable, Sendable {
    let contactId: String
    let organizationId: String
    let peerOrganizationId: String
    let peerUserId: String
    let displayName: String
    let avatarURL: String
    let relationship: String
    let suspendedReason: String?
    let isRestorable: Bool
    let updatedAt: String
    let peerOrganizationName: String

    var id: String { contactId }

    enum CodingKeys: String, CodingKey {
        case contactId = "contact_id"
        case organizationId = "organization_id"
        case peerOrganizationId = "peer_organization_id"
        case peerUserId = "peer_user_id"
        case displayName = "display_name"
        case avatarURL = "avatar_url"
        case relationship
        case suspendedReason = "suspended_reason"
        case isRestorable = "is_restorable"
        case updatedAt = "updated_at"
        case peerOrganizationName = "peer_organization_name"
    }
}

struct ExternalContactCandidate: Codable, Sendable {
    let userId: String
    let displayName: String
    let avatarURL: String
    let relationship: String
    let externalContactId: String?
    let pendingInvitationId: String?

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case displayName = "display_name"
        case avatarURL = "avatar_url"
        case relationship
        case externalContactId = "external_contact_id"
        case pendingInvitationId = "pending_invitation_id"
    }
}

struct ExternalContactInvitation: Codable, Identifiable, Hashable, Sendable {
    let invitationId: String
    let direction: String
    let status: String
    let peerUserId: String
    let peerOrganizationId: String?
    let displayName: String
    let avatarURL: String
    let createdAt: String
    let expiresAt: String
    let resolvedAt: String?
    let note: String?
    let peerOrganizationName: String?

    var id: String { invitationId }

    enum CodingKeys: String, CodingKey {
        case invitationId = "invitation_id"
        case direction, status
        case peerUserId = "peer_user_id"
        case peerOrganizationId = "peer_organization_id"
        case displayName = "display_name"
        case avatarURL = "avatar_url"
        case createdAt = "created_at"
        case expiresAt = "expires_at"
        case resolvedAt = "resolved_at"
        case note
        case peerOrganizationName = "peer_organization_name"
    }
}

struct ExternalContactListResponse: Decodable, Sendable {
    let items: [ExternalContact]
}

struct ExternalContactInvitationListResponse: Decodable, Sendable {
    let items: [ExternalContactInvitation]
}

struct ExternalContactInvitationCreateResponse: Decodable, Sendable {
    let invitation: ExternalContactInvitation?
    let invitationId: String?

    enum CodingKeys: String, CodingKey {
        case invitation
        case invitationId = "invitation_id"
    }
}

/// 跨 Organization 联系人管理；与 IMConversationService 共用 Django API 鉴权和基址。
actor ExternalContactService {
    static let shared = ExternalContactService()

    func list(organizationId: String) async throws -> [ExternalContact] {
        let response: ExternalContactListResponse = try await APIClient.shared.request(
            "GET",
            path: Endpoints.IM.externalContacts,
            query: ["organization_id": organizationId]
        )
        return response.items
    }

    func discover(organizationId: String, phone: String) async throws -> ExternalContactCandidate {
        try await APIClient.shared.request(
            "POST",
            path: Endpoints.IM.discoverExternalContact,
            body: ["organization_id": organizationId, "phone": phone]
        )
    }

    func invite(organizationId: String, targetUserId: String, note: String? = nil) async throws -> ExternalContactInvitationCreateResponse {
        var body: [String: Any] = [
            "organization_id": organizationId,
            "target_user_id": targetUserId,
        ]
        if let note, !note.isEmpty { body["note"] = note }
        return try await APIClient.shared.request(
            "POST",
            path: Endpoints.IM.externalContactInvitations,
            body: body
        )
    }

    func listInvitations(
        organizationId: String,
        direction: String? = "incoming",
        status: String? = "pending"
    ) async throws -> [ExternalContactInvitation] {
        var query = ["organization_id": organizationId]
        if let direction { query["direction"] = direction }
        if let status { query["status"] = status }
        let response: ExternalContactInvitationListResponse = try await APIClient.shared.request(
            "GET",
            path: Endpoints.IM.externalContactInvitations,
            query: query
        )
        return response.items
    }

    func accept(organizationId: String, invitationId: String) async throws -> ExternalContact {
        try await APIClient.shared.request(
            "POST",
            path: Endpoints.IM.acceptExternalContact,
            body: ["organization_id": organizationId, "invite_code": invitationId]
        )
    }

    func updateInvitation(invitationId: String, action: String, organizationId: String) async throws {
        let _: ExternalContactInvitation = try await APIClient.shared.request(
            "PATCH",
            path: Endpoints.IM.externalContactInvitation(invitationId),
            body: ["organization_id": organizationId, "action": action]
        )
    }

    func updateContact(contactId: String, action: String, organizationId: String) async throws {
        let _: ExternalContact = try await APIClient.shared.request(
            "PATCH",
            path: Endpoints.IM.externalContact(contactId),
            body: ["organization_id": organizationId, "action": action]
        )
    }
}

/// 消息域共享的外部联系人目录。
///
/// Electron 会在打开通讯录时刷新这份目录；移动端还要让消息首页先激活它，
/// 否则外部私聊无法解析昵称，且用户只有真正进入通讯录子页后才会发出首次请求。
@MainActor
@Observable
final class ExternalContactDirectoryStore {
    static let shared = ExternalContactDirectoryStore()

    typealias Loader = @Sendable (String) async throws -> [ExternalContact]

    private(set) var contacts: [ExternalContact] = []
    private(set) var isLoading = false
    private(set) var loadError: String?

    private let loader: Loader
    private var organizationId: String?
    private var generation = 0

    init(loader: @escaping Loader = { organizationId in
        try await ExternalContactService.shared.list(organizationId: organizationId)
    }) {
        self.loader = loader
    }

    func reload(organizationId: String) async {
        let normalizedOrganizationId = organizationId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedOrganizationId.isEmpty else {
            clear()
            return
        }

        generation += 1
        let currentGeneration = generation
        if self.organizationId != normalizedOrganizationId {
            contacts = []
        }
        self.organizationId = normalizedOrganizationId
        isLoading = true
        loadError = nil

        do {
            let loaded = try await loader(normalizedOrganizationId)
            guard currentGeneration == generation,
                  self.organizationId == normalizedOrganizationId else { return }
            contacts = loaded
                .filter { $0.relationship == "friend" }
                .sorted {
                    $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
                }
        } catch is CancellationError {
            if currentGeneration == generation { isLoading = false }
            return
        } catch {
            guard currentGeneration == generation,
                  self.organizationId == normalizedOrganizationId else { return }
            contacts = []
            loadError = error.localizedDescription
        }

        guard currentGeneration == generation else { return }
        isLoading = false
    }

    func contact(peerUserId: String?) -> ExternalContact? {
        guard let peerUserId, !peerUserId.isEmpty else { return nil }
        return contacts.first { $0.peerUserId == peerUserId }
    }

    func clear() {
        generation += 1
        organizationId = nil
        contacts = []
        isLoading = false
        loadError = nil
    }
}
