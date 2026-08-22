import Foundation

/// 人员字段选择器的可测策略：搜索查询、单选/多选切换、写回形态。
enum NativeTabDataMemberPickerPolicy {
    static let pageLimit = 50
    static let maxLimit = 200

    /// 服务端默认模式会额外按邮箱、手机号和裸 user.id 匹配，且只对 owner 生效，
    /// 同一个搜索词在不同角色下结果会不一样。nickname 模式仍覆盖用户名与拼音，
    /// 只去掉这三项，因此选人场景固定用它（与 Android 同口径）。
    static let searchMode = "nickname"

    /// 与 `list_organization_members` 对齐：空搜索不带 search，避免服务端按空串过滤。
    static func searchQuery(
        search: String,
        offset: Int = 0,
        limit: Int = pageLimit
    ) -> [String: String] {
        var query = [
            "offset": String(max(0, offset)),
            "limit": String(min(max(limit, 1), maxLimit)),
        ]
        let trimmed = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            query["search"] = trimmed
            query["search_mode"] = searchMode
        }
        return query
    }

    static func toggle(
        selected: [String],
        userId: String,
        multiple: Bool
    ) -> [String] {
        let id = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { return selected }
        if multiple {
            if let index = selected.firstIndex(of: id) {
                var next = selected
                next.remove(at: index)
                return next
            }
            return selected + [id]
        }
        return selected == [id] ? [] : [id]
    }

    /// 已选 id 一律走四级解析；草稿只存 id 时，用记录原文补内嵌姓名，避免退化成「未知」。
    static func resolveSelected(
        ids: [String],
        raw: AnyCodable? = nil,
        directory: NativeTabDataMemberDirectory,
        copy: NativeTabDataMemberCopy = .localized
    ) -> [NativeTabDataMemberRef] {
        let fromIds = NativeTabDataMemberDirectoryResolver.resolve(ids, directory: directory, copy: copy)
        guard let raw else { return fromIds }
        let fromRaw = NativeTabDataMemberDirectoryResolver.resolve(raw.value, directory: directory, copy: copy)
        let rawById = Dictionary(fromRaw.filter { !$0.userId.isEmpty }.map { ($0.userId, $0) }, uniquingKeysWith: { first, _ in first })
        return fromIds.map { member in
            if member.kind != .unknown || member.userId.isEmpty { return member }
            return rawById[member.userId] ?? member
        }
    }

    /// 只认昵称和用户名：`OrganizationMember.displayName` 会回落到手机号 / 邮箱，
    /// 那是联系方式不是称呼，不该出现在人员字段和选择器里。都没有时给占位名，
    /// 既不丢掉这个人（丢了在选择器里就搜不到、派不了活），也不回落成裸 user_id。
    static func directoryMember(
        from member: OrganizationMember,
        copy: NativeTabDataMemberCopy = .localized
    ) -> NativeTabDataDirectoryMember? {
        let userId = member.userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !userId.isEmpty else { return nil }
        let name = [member.user?.nickname, member.user?.username]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        let avatar = member.avatar?.trimmingCharacters(in: .whitespacesAndNewlines)
        return NativeTabDataDirectoryMember(
            userId: userId,
            displayName: name ?? copy.unnamed,
            avatarUrl: (avatar?.isEmpty == false) ? avatar : nil
        )
    }
}
