package com.tabtin.mobile.data.im

import com.tabtin.mobile.data.model.OrganizationMember

/**
 * IM 会话详情有时只给成员 id，不给昵称。
 * 展示层统一从当前会话组织通讯录补齐，避免设置页 / @ 成员页退化成一排“成员”。
 */
public object ImMemberDisplayPolicy {
    public fun resolvedAvatar(
        userId: String?,
        snapshotAvatar: String?,
        organizationMembers: List<OrganizationMember>,
    ): String {
        val currentAvatar = userId
            ?.takeIf { it.isNotBlank() }
            ?.let { id -> organizationMembers.firstOrNull { it.userId == id } }
            ?.user
            ?.avatar
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
        return currentAvatar ?: snapshotAvatar?.trim().orEmpty()
    }

    public fun resolvedDisplayName(
        userId: String?,
        snapshotName: String?,
        organizationMembers: List<OrganizationMember>,
    ): String {
        val currentUser = userId
            ?.takeIf { it.isNotBlank() }
            ?.let { id -> organizationMembers.firstOrNull { it.userId == id } }
            ?.user
        val currentName = sequenceOf(
            currentUser?.nickname,
            currentUser?.username,
            currentUser?.phone,
            currentUser?.email,
        ).mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }.firstOrNull()
        return currentName ?: snapshotName.orEmpty().displayNameIfNotUserId(userId.orEmpty()).orEmpty()
    }

    public fun directMessageDisplayName(
        members: List<ImMember>,
        currentUserId: String?,
        peerUserId: String?,
        organizationMembers: List<OrganizationMember>,
        fallback: String = "私聊",
    ): String {
        val normalizedPeerUserId = peerUserId?.trim()?.takeIf { it.isNotEmpty() }
        val peer = normalizedPeerUserId?.let { id ->
            members.firstOrNull { !it.isAgent && it.userId == id }
        } ?: members.firstOrNull { !it.isAgent && it.userId != currentUserId }
        return resolvedDisplayName(
            userId = peer?.userId ?: normalizedPeerUserId,
            snapshotName = peer?.displayName,
            organizationMembers = organizationMembers,
        ).ifBlank { fallback }
    }

    public fun enrichedReadReceipts(
        receipts: ImMessageReadReceipts,
        organizationMembers: List<OrganizationMember>,
    ): ImMessageReadReceipts = ImMessageReadReceipts(
        readers = receipts.readers.map { it.enriched(organizationMembers) },
        unreaders = receipts.unreaders.map { it.enriched(organizationMembers) },
    )

    public fun enrichedDetail(
        detail: ImConversationDetail,
        organizationMembers: List<OrganizationMember>,
    ): ImConversationDetail {
        if (organizationMembers.isEmpty()) return detail
        val byUserId = organizationMembers.associateBy { it.userId }
        return detail.copy(
            members = detail.members.map { member ->
                if (member.isAgent) return@map member
                val userId = member.userId?.takeIf { it.isNotBlank() } ?: return@map member
                val organizationMember = byUserId[userId] ?: return@map member
                val snapshotNickname = member.nickname.displayNameIfNotUserId(userId)
                val snapshotUsername = member.username.displayNameIfNotUserId(userId)
                member.copy(
                    nickname = snapshotNickname
                        ?: organizationMember.user?.nickname?.takeIf { it.isNotBlank() }
                        ?: organizationMember.user?.username?.takeIf { it.isNotBlank() }
                        ?: organizationMember.user?.email?.takeIf { it.isNotBlank() }
                        ?: organizationMember.user?.phone?.takeIf { it.isNotBlank() }
                        ?: snapshotUsername
                        ?: "",
                    username = snapshotUsername
                        ?: organizationMember.user?.username?.takeIf { it.isNotBlank() }
                        .orEmpty(),
                    // Organization 公开资料是当前权威值；消息成员/card 里的头像只是快照。
                    avatar = organizationMember.user?.avatar?.takeIf { it.isNotBlank() }
                        ?: member.avatar,
                )
            },
        )
    }

    public fun displayName(member: ImMember): String {
        val name = member.displayName.trim()
        if (name.isNotEmpty()) return name
        if (member.isAgent) return "Agent"
        val userId = member.userId.orEmpty().trim()
        return if (userId.isNotEmpty()) "成员 ${userId.take(8)}" else "成员"
    }

    public fun directMessagePeerDisplayName(
        detail: ImConversationDetail,
        currentUserId: String?,
        preferredPeerUserId: String?,
    ): String? {
        val preferredPeer = preferredPeerUserId?.trim()?.takeIf { it.isNotEmpty() }
        detail.members.firstOrNull {
            !it.isAgent && preferredPeer != null && it.userId == preferredPeer
        }?.displayName?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }

        val currentUser = currentUserId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return detail.members.firstOrNull {
            !it.isAgent && it.userId != currentUser
        }?.displayName?.trim()?.takeIf { it.isNotEmpty() }
    }

    private fun ImReadReceiptMember.enriched(
        organizationMembers: List<OrganizationMember>,
    ): ImReadReceiptMember = copy(
        name = resolvedDisplayName(userId, name, organizationMembers).ifBlank { name },
        avatar = resolvedAvatar(userId, avatar, organizationMembers),
    )

    private fun String.displayNameIfNotUserId(userId: String): String? =
        trim().takeIf { it.isNotEmpty() && it != userId.trim() }
}
