import Foundation

struct CloudDocsSharerAvatar: Equatable {
    let name: String
    let seed: String
    let imageUrl: String?
}

/// 云文档列表行上的修改时间文案和分享人头像。
enum CloudDocsPresentation {
    static func lastModified(_ raw: String?) -> String? {
        guard let value = raw.flatMap({ RelativeTime.format($0) }) else { return nil }
        return L10n.CloudDocs.recentlyModifiedAt(value)
    }

    static func sharerAvatar(_ owner: SharedResourceOwner?) -> CloudDocsSharerAvatar? {
        guard let owner else { return nil }
        let name = owner.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = owner.id.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedAvatar = owner.avatar?.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageUrl = (trimmedAvatar?.isEmpty == false) ? trimmedAvatar : nil
        guard !name.isEmpty || !id.isEmpty || imageUrl != nil else { return nil }
        return CloudDocsSharerAvatar(
            name: name.isEmpty ? "?" : name,
            seed: IdentityAvatar.colorSeed(id, fallbackName: name),
            imageUrl: imageUrl
        )
    }
}
