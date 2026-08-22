package com.tabtin.mobile.data.im

import com.tabtin.mobile.data.model.MemberUser
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.OrganizationRole
import org.junit.Assert.assertEquals
import org.junit.Test

class ImMemberDisplayPolicyTest {
    @Test
    fun `conversation detail members fall back to organization member names`() {
        val detail = ImConversationDetail(
            id = "conv-1",
            type = ImConversationType.GROUP,
            members = listOf(ImMember(userId = "user-1")),
        )
        val enriched = ImMemberDisplayPolicy.enrichedDetail(
            detail,
            listOf(
                OrganizationMember(
                    id = "member-1",
                    userId = "user-1",
                    role = OrganizationRole.EDITOR,
                    user = MemberUser(
                        id = "user-1",
                        nickname = "张三",
                        username = "zhangsan",
                        avatar = "https://example.test/avatar.png",
                    ),
                ),
            ),
        )

        assertEquals("张三", enriched.members.single().displayName)
        assertEquals("zhangsan", enriched.members.single().username)
        assertEquals("https://example.test/avatar.png", enriched.members.single().avatar)
    }

    @Test
    fun `conversation detail treats user id snapshot as missing display name`() {
        val detail = ImConversationDetail(
            id = "dm-1",
            type = ImConversationType.DM,
            members = listOf(
                ImMember(
                    userId = "user-1",
                    nickname = "user-1",
                    username = "user-1",
                ),
            ),
        )
        val enriched = ImMemberDisplayPolicy.enrichedDetail(
            detail,
            listOf(
                OrganizationMember(
                    id = "member-1",
                    userId = "user-1",
                    role = OrganizationRole.EDITOR,
                    user = MemberUser(
                        id = "user-1",
                        nickname = "张三",
                        username = "zhangsan",
                    ),
                ),
            ),
        )

        assertEquals("张三", enriched.members.single().displayName)
        assertEquals("zhangsan", enriched.members.single().username)
    }

    @Test
    fun `direct message settings name never exposes user id`() {
        val members = listOf(
            ImMember(userId = "current-user", nickname = "我"),
            ImMember(userId = "peer-user-id", nickname = "peer-user-id", username = "peer-user-id"),
        )
        val organizationMembers = listOf(
            OrganizationMember(
                id = "member-1",
                userId = "peer-user-id",
                role = OrganizationRole.EDITOR,
                user = MemberUser(
                    id = "peer-user-id",
                    nickname = "张三",
                    username = "zhangsan",
                ),
            ),
        )

        assertEquals(
            "张三",
            ImMemberDisplayPolicy.directMessageDisplayName(
                members = members,
                currentUserId = "current-user",
                peerUserId = "peer-user-id",
                organizationMembers = organizationMembers,
            ),
        )
        assertEquals(
            "私聊",
            ImMemberDisplayPolicy.directMessageDisplayName(
                members = members,
                currentUserId = "current-user",
                peerUserId = "peer-user-id",
                organizationMembers = emptyList(),
            ),
        )
    }

    @Test
    fun `organization profile avatar replaces stale IM snapshot`() {
        val detail = ImConversationDetail(
            id = "conv-1",
            type = ImConversationType.GROUP,
            members = listOf(
                ImMember(
                    userId = "user-1",
                    avatar = "https://example.test/stale-avatar.png",
                ),
            ),
        )
        val enriched = ImMemberDisplayPolicy.enrichedDetail(
            detail,
            listOf(
                OrganizationMember(
                    id = "member-1",
                    userId = "user-1",
                    role = OrganizationRole.EDITOR,
                    user = MemberUser(
                        id = "user-1",
                        nickname = "张三",
                        avatar = "https://example.test/current-avatar.png",
                    ),
                ),
            ),
        )

        assertEquals("https://example.test/current-avatar.png", enriched.members.single().avatar)
    }

    @Test
    fun `read receipt avatars use current organization profile and keep message snapshot fallback`() {
        val members = listOf(
            OrganizationMember(
                id = "member-1",
                userId = "user-1",
                role = OrganizationRole.EDITOR,
                user = MemberUser(
                    id = "user-1",
                    nickname = "最新昵称",
                    avatar = "https://example.test/current-avatar.png",
                ),
            ),
        )

        val enriched = ImMemberDisplayPolicy.enrichedReadReceipts(
            ImMessageReadReceipts(
                readers = listOf(
                    ImReadReceiptMember(
                        userId = "user-1",
                        name = "旧昵称",
                        avatar = "https://example.test/stale-avatar.png",
                    ),
                ),
                unreaders = listOf(
                    ImReadReceiptMember(
                        userId = "user-2",
                        name = "完整成员快照",
                        avatar = "https://example.test/message-snapshot-avatar.png",
                    ),
                ),
            ),
            members,
        )

        assertEquals("最新昵称", enriched.readers.single().name)
        assertEquals("https://example.test/current-avatar.png", enriched.readers.single().avatar)
        assertEquals("https://example.test/message-snapshot-avatar.png", enriched.unreaders.single().avatar)
    }

    @Test
    fun `member display fallback keeps rows distinguishable when directory is missing`() {
        assertEquals(
            "成员 user-123",
            ImMemberDisplayPolicy.displayName(ImMember(userId = "user-123456789")),
        )
    }

    @Test
    fun `dm peer name prefers explicit peer id when current user is unavailable`() {
        val detail = ImConversationDetail(
            id = "dm-1",
            type = ImConversationType.DM,
            members = listOf(
                ImMember(userId = "me", nickname = "我"),
                ImMember(userId = "peer", nickname = "沈庚涛"),
            ),
        )

        assertEquals(
            "沈庚涛",
            ImMemberDisplayPolicy.directMessagePeerDisplayName(
                detail = detail,
                currentUserId = null,
                preferredPeerUserId = "peer",
            ),
        )
    }

    @Test
    fun `dm peer name fails closed when current user and preferred peer are unavailable`() {
        val detail = ImConversationDetail(
            id = "dm-1",
            type = ImConversationType.DM,
            members = listOf(ImMember(userId = "me", nickname = "我")),
        )

        assertEquals(
            null,
            ImMemberDisplayPolicy.directMessagePeerDisplayName(
                detail = detail,
                currentUserId = null,
                preferredPeerUserId = "removed-peer",
            ),
        )
    }
}
