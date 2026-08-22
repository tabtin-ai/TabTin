import Foundation

/// 会话详情里的成员资料可能只有 user_id；用当前组织通讯录补齐展示名，避免 UI 退化成“成员”。
enum IMMemberDisplayPolicy {
    static func resolvedAvatar(
        userId: String?,
        snapshotAvatar: String?,
        organizationMembers: [OrganizationMember]
    ) -> String {
        let currentAvatar = organizationMember(for: userId, in: organizationMembers)?
            .avatar?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfBlank
        return currentAvatar
            ?? snapshotAvatar?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
            ?? ""
    }

    static func resolvedDisplayName(
        userId: String?,
        snapshotName: String?,
        organizationMembers: [OrganizationMember]
    ) -> String {
        let currentUser = organizationMember(for: userId, in: organizationMembers)?.user
        let currentName = [
            currentUser?.nickname,
            currentUser?.username,
            currentUser?.phone,
            currentUser?.email,
        ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank }
            .first
        return currentName
            ?? snapshotName?.displayNameIfNotUserId(userId ?? "")
            ?? ""
    }

    static func directMessageDisplayName(
        members: [IMMember],
        currentUserId: String?,
        peerUserId: String?,
        organizationMembers: [OrganizationMember],
        fallback: String = "私聊"
    ) -> String {
        let normalizedPeerUserId = peerUserId?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        let peer = normalizedPeerUserId.flatMap { id in
            members.first { $0.typedMemberType == .user && $0.userId == id }
        } ?? members.first {
            $0.typedMemberType == .user && $0.userId != currentUserId
        }
        let resolved = resolvedDisplayName(
            userId: peer?.userId ?? normalizedPeerUserId,
            snapshotName: peer?.displayName,
            organizationMembers: organizationMembers
        )
        return resolved.nilIfBlank ?? fallback
    }

    static func enrichedReadReceipts(
        _ receipts: IMMessageReadReceipts,
        organizationMembers: [OrganizationMember]
    ) -> IMMessageReadReceipts {
        IMMessageReadReceipts(
            readers: receipts.readers.map { enrichedReadReceiptMember($0, organizationMembers: organizationMembers) },
            unreaders: receipts.unreaders.map { enrichedReadReceiptMember($0, organizationMembers: organizationMembers) }
        )
    }

    static func enrichedDetail(
        _ detail: IMConversationDetail,
        organizationMembers: [OrganizationMember]
    ) -> IMConversationDetail {
        guard !organizationMembers.isEmpty else { return detail }
        let byUserId = organizationMembers.reduce(into: [String: OrganizationMember]()) { result, member in
            result[member.userId] = member
        }
        let members = detail.members.map { member in
            guard member.typedMemberType == .user,
                  let userId = member.userId,
                  let organizationMember = byUserId[userId] else { return member }
            let snapshotNickname = member.nickname.displayNameIfNotUserId(userId)
            let snapshotUsername = member.username.displayNameIfNotUserId(userId)
            return IMMember(
                memberType: member.memberType,
                userId: member.userId,
                agentId: member.agentId,
                participantOrganizationId: member.participantOrganizationId,
                nickname: snapshotNickname
                    ?? organizationMember.user?.nickname?.nilIfBlank
                    ?? organizationMember.user?.username?.nilIfBlank
                    ?? organizationMember.user?.email?.nilIfBlank
                    ?? organizationMember.user?.phone?.nilIfBlank
                    ?? snapshotUsername
                    ?? "",
                username: snapshotUsername
                    ?? organizationMember.user?.username?.nilIfBlank
                    ?? "",
                // Organization 公开资料是当前权威值；消息成员/card 里的头像只是快照。
                avatar: organizationMember.avatar?.nilIfBlank
                    ?? member.avatar.nilIfBlank
                    ?? "",
                role: member.role,
                isMuted: member.isMuted,
                pinned: member.pinned,
                joinedAt: member.joinedAt,
                ownerUserId: member.ownerUserId,
                ownerDisplayName: member.ownerDisplayName,
                isExecutionOnline: member.isExecutionOnline,
                isExternal: member.isExternal,
                organizationName: member.organizationName
            )
        }
        return IMConversationDetail(
            id: detail.id,
            organizationId: detail.organizationId,
            spaceId: detail.spaceId,
            spaceName: detail.spaceName,
            isTeamSpaceChannel: detail.isTeamSpaceChannel,
            type: detail.type,
            name: detail.name,
            avatarUrl: detail.avatarUrl,
            memberCount: detail.memberCount,
            isArchived: detail.isArchived,
            lastMessageAt: detail.lastMessageAt,
            lastMessagePreview: detail.lastMessagePreview,
            createdBy: detail.createdBy,
            createdAt: detail.createdAt,
            members: members,
            hasUnreadMention: detail.hasUnreadMention,
            isExternal: detail.isExternal,
            participantOrganizationId: detail.participantOrganizationId,
            directoryScopeId: detail.directoryScopeId,
            canSend: detail.canSend,
            labels: detail.labels
        )
    }

    static func displayName(for member: IMMember) -> String {
        let name = member.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        if member.typedMemberType == .agent { return "Agent" }
        if let userId = member.userId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !userId.isEmpty {
            return "成员 \(String(userId.prefix(8)))"
        }
        return "成员"
    }

    static func directMessagePeerDisplayName(
        in detail: IMConversationDetail,
        currentUserId: String?,
        preferredPeerUserId: String?
    ) -> String? {
        let preferredPeer = preferredPeerUserId?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let member = detail.members.first(where: {
            $0.typedMemberType == .user
                && preferredPeer?.isEmpty == false
                && $0.userId == preferredPeer
        }), let name = member.displayName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank {
            return name
        }
        guard let currentUserId = currentUserId?
            .trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank else { return nil }
        let member = detail.members.first {
            $0.typedMemberType == .user && $0.userId != currentUserId
        }
        return member?.displayName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
    }

    private static func organizationMember(
        for userId: String?,
        in organizationMembers: [OrganizationMember]
    ) -> OrganizationMember? {
        guard let userId = userId?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank else {
            return nil
        }
        return organizationMembers.first { $0.userId == userId }
    }

    private static func enrichedReadReceiptMember(
        _ member: IMReadReceiptMember,
        organizationMembers: [OrganizationMember]
    ) -> IMReadReceiptMember {
        IMReadReceiptMember(
            userId: member.userId,
            name: resolvedDisplayName(
                userId: member.userId,
                snapshotName: member.name,
                organizationMembers: organizationMembers
            ).nilIfBlank ?? member.name,
            avatar: resolvedAvatar(
                userId: member.userId,
                snapshotAvatar: member.avatar,
                organizationMembers: organizationMembers
            )
        )
    }
}

struct IMHumanReadReceiptProjection: Equatable, Sendable {
    let progress: IMReadReceipt?
    let detail: IMMessageReadReceipts?
}

/// Django 回执使用领域 user_id；客户端只需排除发送者、本人和 Agent。
enum IMHumanReadReceiptPolicy {
    static func project(
        progress: IMReadReceipt?,
        detail: IMMessageReadReceipts?,
        members: [IMMember],
        currentUserId: String?,
        senderId: String
    ) -> IMHumanReadReceiptProjection {
        let currentUserId = normalized(currentUserId)
        let senderId = normalized(senderId) ?? ""
        let excludedActorIds = Set([currentUserId, normalized(senderId)].compactMap { $0 })
        var humanMemberIds = Set<String>()
        var agentMemberIds = Set<String>()
        for member in members {
            switch member.typedMemberType {
            case .agent:
                agentMemberIds.formUnion([
                    normalized(member.userId),
                    normalized(member.agentId),
                ].compactMap { $0 })
            case .user:
                if let userId = normalized(member.userId), !excludedActorIds.contains(userId) {
                    humanMemberIds.insert(userId)
                }
            case nil:
                break
            }
        }
        let hasMemberSnapshot = !members.isEmpty

        func isHumanRecipient(_ userId: String) -> Bool {
            let userId = userId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !userId.isEmpty, !excludedActorIds.contains(userId) else { return false }
            if agentMemberIds.contains(userId) { return false }
            if humanMemberIds.contains(userId) { return true }
            return false
        }

        let projectedDetail = detail.map { detail in
            IMMessageReadReceipts(
                readers: detail.readers.filter { isHumanRecipient($0.userId) },
                unreaders: detail.unreaders.filter { isHumanRecipient($0.userId) }
            )
        }

        let rawRecipientCount = max(progress?.recipientCount ?? 0, 0)
        let rawDetailCount = detail.map { $0.readers.count + $0.unreaders.count } ?? 0
        let hasCompleteDetail = detail != nil && rawRecipientCount > 0 && rawDetailCount >= rawRecipientCount

        let recipientCount: Int
        let readCount: Int
        if hasCompleteDetail, let projectedDetail {
            readCount = projectedDetail.readers.count
            recipientCount = readCount + projectedDetail.unreaders.count
        } else {
            // 没有成员快照时无法可靠区分真人和 Agent；宁可暂不展示，也不显示错误人数。
            recipientCount = hasMemberSnapshot
                ? min(rawRecipientCount, humanMemberIds.count)
                : 0
            // 汇总只有人数时没有读者身份；部分名单也不能把未返回身份的 reader 当真人。
            readCount = min(projectedDetail?.readers.count ?? 0, recipientCount)
        }

        let projectedProgress = recipientCount > 0
            ? IMReadReceipt(readCount: readCount, recipientCount: recipientCount)
            : nil
        return IMHumanReadReceiptProjection(progress: projectedProgress, detail: projectedDetail)
    }

    private static func normalized(_ value: String?) -> String? {
        value?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
    }
}

private extension String {
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func displayNameIfNotUserId(_ userId: String) -> String? {
        guard let value = nilIfBlank else { return nil }
        return value == userId.trimmingCharacters(in: .whitespacesAndNewlines) ? nil : value
    }
}
