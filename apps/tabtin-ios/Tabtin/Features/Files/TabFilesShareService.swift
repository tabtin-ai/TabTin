import Foundation
import OSLog

/// TabFiles 协作者管理。
///
/// 边界：
/// - 使用 FileRecordID（`/context/files/{file_record_id}/collaborators`）
/// - **无公开链接**（与 TabDoc/TabData `CloudDocsShareService` 分离）
/// - 邀请 / 改权 / 撤销需资源级 admin（通常 owner）；viewer 只能列表
actor TabFilesShareService {
    static let shared = TabFilesShareService()

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "TabFilesShare")

    /// Owner brief 无 permission 字段；协作者带 permission。
    struct OwnerBrief: Decodable, Sendable, Hashable {
        let userId: String
        let nickname: String
        let avatar: String?
        let email: String

        enum CodingKeys: String, CodingKey {
            case userId = "user_id"
            case nickname, avatar, email
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            userId = try c.decodeIfPresent(String.self, forKey: .userId) ?? ""
            nickname = try c.decodeIfPresent(String.self, forKey: .nickname) ?? ""
            avatar = try c.decodeIfPresent(String.self, forKey: .avatar)
            email = try c.decodeIfPresent(String.self, forKey: .email) ?? ""
        }
    }

    struct CollaboratorList: Decodable, Sendable {
        let owner: OwnerBrief?
        let collaborators: [CloudDocsCollaborator]

        enum CodingKeys: String, CodingKey {
            case owner, collaborators
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            owner = try c.decodeIfPresent(OwnerBrief.self, forKey: .owner)
            collaborators = try c.decodeIfPresent([CloudDocsCollaborator].self, forKey: .collaborators) ?? []
        }
    }

    func list(fileRecordId: String) async throws -> CollaboratorList {
        let id = try Self.requireFileRecordId(fileRecordId)
        do {
            return try await APIClient.shared.get(
                path: Endpoints.Context.fileCollaborators(fileRecordId: id)
            )
        } catch {
            throw CloudDocsShareService.mapAPIError(error)
        }
    }

    func invite(fileRecordId: String, userId: String, permission: String) async throws {
        let id = try Self.requireFileRecordId(fileRecordId)
        let _: CloudDocsMutationAck = try await APIClient.shared.post(
            path: Endpoints.Context.fileCollaborators(fileRecordId: id),
            body: ["user_ids": [userId], "permission": permission]
        )
    }

    func update(fileRecordId: String, userId: String, permission: String) async throws {
        let id = try Self.requireFileRecordId(fileRecordId)
        let _: CloudDocsMutationAck = try await APIClient.shared.patch(
            path: Endpoints.Context.fileCollaborator(fileRecordId: id, userId: userId),
            body: ["permission": permission]
        )
    }

    func revoke(fileRecordId: String, userId: String) async throws {
        let id = try Self.requireFileRecordId(fileRecordId)
        let _: CloudDocsMutationAck = try await APIClient.shared.delete(
            path: Endpoints.Context.fileCollaborator(fileRecordId: id, userId: userId)
        )
    }

    private static func requireFileRecordId(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw CloudDocsShareError.other("missing FileRecordID")
        }
        return trimmed
    }
}
