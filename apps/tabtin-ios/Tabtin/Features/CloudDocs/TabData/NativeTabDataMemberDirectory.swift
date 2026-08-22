import Foundation

/// 人员字段解析出的一条可见身份。`userId` 只供内部对照，不得进入界面文案。
struct NativeTabDataMemberRef: Equatable, Sendable, Identifiable {
    let userId: String
    let displayName: String
    let avatarUrl: String?
    let kind: NativeTabDataMemberKind

    var id: String { "\(kind.rawValue)|\(userId)|\(displayName)" }

    var avatarURL: URL? {
        guard let avatarUrl else { return nil }
        let trimmed = avatarUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return URL(string: trimmed)
    }
}

enum NativeTabDataMemberKind: String, Equatable, Sendable {
    case member
    case departed
    case external
    case unknown
}

struct NativeTabDataDirectoryMember: Equatable, Sendable, Decodable {
    let userId: String
    let displayName: String
    let avatarUrl: String?
}

struct NativeTabDataIdentitySnapshot: Equatable, Sendable, Decodable {
    let userId: String
    let displayName: String
    let leftAt: String?
}

struct NativeTabDataMemberDirectory: Equatable, Sendable, Decodable {
    var members: [NativeTabDataDirectoryMember]
    var identitySnapshots: [NativeTabDataIdentitySnapshot]

    static let empty = NativeTabDataMemberDirectory(members: [], identitySnapshots: [])

    func member(for userId: String) -> NativeTabDataDirectoryMember? {
        members.first { $0.userId == userId }
    }

    func snapshot(for userId: String) -> NativeTabDataIdentitySnapshot? {
        identitySnapshots.first { $0.userId == userId }
    }
}

/// 契约夹具用中文正典；界面传入 `.localized`。
struct NativeTabDataMemberCopy: Equatable, Sendable {
    var unknown: String
    var departedFormat: String
    /// 在职但昵称、用户名都为空的成员。丢弃会让这个人在选择器里选不到，
    /// 回落成 user_id 又违反「人员展示任何分支都不露裸 ID」。
    var unnamed: String

    func departed(_ name: String) -> String {
        String(format: departedFormat, name)
    }

    static let contract = NativeTabDataMemberCopy(
        unknown: "未知",
        departedFormat: "%@（已离职）",
        unnamed: "未命名成员"
    )

    static var localized: NativeTabDataMemberCopy {
        NativeTabDataMemberCopy(
            unknown: L10n.TabData.unknownMember,
            departedFormat: L10n.TabData.departedMemberFormat,
            unnamed: L10n.TabData.unnamedMember
        )
    }
}

struct NativeTabDataIdentitySnapshotList: Decodable, Sendable {
    let identities: [NativeTabDataIdentitySnapshotWire]
    let total: Int?
}

struct NativeTabDataIdentitySnapshotWire: Decodable, Sendable {
    let userId: String
    let displayName: String
    let leftAt: String?

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case displayName = "display_name"
        case leftAt = "left_at"
    }

    var snapshot: NativeTabDataIdentitySnapshot {
        NativeTabDataIdentitySnapshot(userId: userId, displayName: displayName, leftAt: leftAt)
    }
}

struct NativeTabDataBatchProfile: Decodable, Sendable {
    let id: String
    let nickname: String?
    let username: String?
    let avatar: String?
    let avatarVersion: String?

    enum CodingKeys: String, CodingKey {
        case id, nickname, username, avatar
        case avatarVersion = "avatar_version"
    }

    var directoryMember: NativeTabDataDirectoryMember? {
        let name = [nickname, username]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        guard let name else { return nil }
        let trimmedAvatar = avatar?.trimmingCharacters(in: .whitespacesAndNewlines)
        return NativeTabDataDirectoryMember(
            userId: id,
            displayName: name,
            avatarUrl: (trimmedAvatar?.isEmpty == false) ? trimmedAvatar : nil
        )
    }
}

enum NativeTabDataMemberDirectoryBatching {
    static let maxIdsPerRequest = 200

    /// 去重且保持首次出现顺序，再按上限切批。
    static func uniquedChunks(_ userIds: [String], size: Int = maxIdsPerRequest) -> [[String]] {
        var seen = Set<String>()
        var unique: [String] = []
        for raw in userIds {
            let id = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, seen.insert(id).inserted else { continue }
            unique.append(id)
        }
        guard !unique.isEmpty else { return [] }
        let chunkSize = max(size, 1)
        return stride(from: 0, to: unique.count, by: chunkSize).map {
            Array(unique[$0 ..< min($0 + chunkSize, unique.count)])
        }
    }
}

enum NativeTabDataMemberDirectoryResolver {
    /// 解析优先级：currentMember → identitySnapshot → embeddedName → unknown。
    /// 目录现名压过字段值里的导入旧名；内嵌姓名只兜住两个目录都认不出的人。
    /// 空值产出空列表，不回落成「未知」，也不回落成原始 ID。
    static func resolve(
        _ raw: Any?,
        directory: NativeTabDataMemberDirectory,
        copy: NativeTabDataMemberCopy = .contract
    ) -> [NativeTabDataMemberRef] {
        tokens(from: unwrap(raw)).map { resolve($0, directory: directory, copy: copy) }
    }

    static func collectUserIds(from records: [NativeTabDataRecord], fields: [NativeTabDataField]) -> [String] {
        let personFields = fields.filter(\.fieldType.isPerson)
        var ids: [String] = []
        for record in records {
            for field in personFields {
                let raw = record.fields[field.id] ?? record.fields[field.name]
                ids.append(contentsOf: tokens(from: unwrap(raw)).map(\.userId))
            }
        }
        return ids
    }

    fileprivate static func tokens(from raw: Any?) -> [NativeTabDataMemberToken] {
        guard let raw, !(raw is NSNull) else { return [] }
        if let boxed = raw as? AnyCodable {
            return tokens(from: boxed.value)
        }
        if let values = raw as? [Any] {
            return values.flatMap { tokens(from: $0) }
        }
        if let token = token(from: raw) {
            return [token]
        }
        return []
    }

    private static func resolve(
        _ token: NativeTabDataMemberToken,
        directory: NativeTabDataMemberDirectory,
        copy: NativeTabDataMemberCopy
    ) -> NativeTabDataMemberRef {
        if let member = directory.member(for: token.userId) {
            let name = member.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty {
                return NativeTabDataMemberRef(
                    userId: token.userId,
                    displayName: name,
                    avatarUrl: member.avatarUrl,
                    kind: .member
                )
            }
        }
        if let snapshot = directory.snapshot(for: token.userId) {
            let name = snapshot.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty {
                return NativeTabDataMemberRef(
                    userId: token.userId,
                    displayName: copy.departed(name),
                    avatarUrl: nil,
                    kind: .departed
                )
            }
        }
        if let embedded = token.embeddedName, !embedded.isEmpty {
            return NativeTabDataMemberRef(
                userId: token.userId,
                displayName: embedded,
                avatarUrl: nil,
                kind: .external
            )
        }
        return NativeTabDataMemberRef(
            userId: token.userId,
            displayName: copy.unknown,
            avatarUrl: nil,
            kind: .unknown
        )
    }

    private static func token(from raw: Any) -> NativeTabDataMemberToken? {
        if let string = raw as? String {
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : NativeTabDataMemberToken(userId: trimmed, embeddedName: nil)
        }
        guard let dictionary = dictionary(from: raw) else { return nil }
        let userId = firstNonEmptyString(in: dictionary, keys: ["id", "user_id", "userId"]) ?? ""
        let embeddedName = firstNonEmptyString(in: dictionary, keys: ["name", "display_name"])
        if embeddedName == nil, userId.isEmpty { return nil }
        return NativeTabDataMemberToken(userId: userId, embeddedName: embeddedName)
    }

    private static func unwrap(_ raw: Any?) -> Any? {
        if let boxed = raw as? AnyCodable { return boxed.value }
        return raw
    }

    private static func dictionary(from raw: Any) -> [String: Any]? {
        if let dictionary = raw as? [String: Any] { return dictionary }
        if let dictionary = raw as? [String: AnyCodable] {
            return dictionary.mapValues(\.value)
        }
        return nil
    }

    private static func firstNonEmptyString(in dictionary: [String: Any], keys: [String]) -> String? {
        for key in keys {
            if let value = dictionary[key] as? String {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
    }
}

private struct NativeTabDataMemberToken: Equatable {
    let userId: String
    let embeddedName: String?
}

@MainActor
final class NativeTabDataMemberDirectoryStore {
    static let shared = NativeTabDataMemberDirectoryStore()

    private var snapshotsByOrg: [String: [NativeTabDataIdentitySnapshot]] = [:]
    private var profilesByOrg: [String: [String: NativeTabDataDirectoryMember]] = [:]
    private var lookedUpIdsByOrg: [String: Set<String>] = [:]

    func directory(
        organizationId: String,
        workspaceMembers: [OrganizationMember]
    ) -> NativeTabDataMemberDirectory {
        var membersById: [String: NativeTabDataDirectoryMember] = [:]
        for member in workspaceMembers {
            // 走同一套策略：只认昵称/用户名，不让手机号、邮箱当称呼，也不丢掉没名字的人。
            guard let entry = NativeTabDataMemberPickerPolicy.directoryMember(from: member) else { continue }
            membersById[entry.userId] = entry
        }
        for (userId, profile) in profilesByOrg[organizationId] ?? [:] where membersById[userId] == nil {
            membersById[userId] = profile
        }
        return NativeTabDataMemberDirectory(
            members: Array(membersById.values),
            identitySnapshots: snapshotsByOrg[organizationId] ?? []
        )
    }

    func cachedSnapshots(for organizationId: String) -> [NativeTabDataIdentitySnapshot]? {
        snapshotsByOrg[organizationId]
    }

    func replaceSnapshots(organizationId: String, snapshots: [NativeTabDataIdentitySnapshot]) {
        snapshotsByOrg[organizationId] = snapshots
    }

    func mergeProfiles(organizationId: String, profiles: [NativeTabDataDirectoryMember]) {
        var current = profilesByOrg[organizationId] ?? [:]
        for profile in profiles {
            current[profile.userId] = profile
        }
        profilesByOrg[organizationId] = current
    }

    func markLookedUp(organizationId: String, userIds: [String]) {
        var current = lookedUpIdsByOrg[organizationId] ?? []
        current.formUnion(userIds)
        lookedUpIdsByOrg[organizationId] = current
    }

    func pendingProfileIds(organizationId: String, userIds: [String], knownIds: Set<String>) -> [String] {
        let lookedUp = lookedUpIdsByOrg[organizationId] ?? []
        return userIds.filter { !knownIds.contains($0) && !lookedUp.contains($0) }
    }
}
