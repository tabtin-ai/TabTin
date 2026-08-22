package com.tabtin.mobile.data.im

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ImHumanReadReceiptPolicyTest {
    @Test
    fun `uses domain user ids and excludes identities outside member snapshot`() {
        val userId = "05a81772-b342-4590-a4a1-ed423f5e1a4d"
        val removedUserId = "22222222-2222-4222-8222-222222222222"

        val projection = ImHumanReadReceiptPolicy.project(
            progress = ImReadReceipt(readCount = 1, recipientCount = 2),
            detail = ImMessageReadReceipts(
                readers = listOf(ImReadReceiptMember(userId = removedUserId, name = "已移除成员")),
                unreaders = listOf(ImReadReceiptMember(userId = userId, name = "当前成员")),
            ),
            members = listOf(
                ImMember(userId = "me"),
                ImMember(
                    userId = userId,
                    nickname = "当前成员",
                ),
            ),
            currentUserId = "me",
            senderId = "me",
        )

        assertEquals(emptyList<ImReadReceiptMember>(), projection.detail?.readers)
        assertEquals(listOf(userId), projection.detail?.unreaders?.map { it.userId })
        assertEquals(ImReadReceipt(readCount = 0, recipientCount = 1), projection.progress)
    }

    @Test
    fun `filters agents from read receipt details and counts`() {
        val agentId = "56922c34-4337-4bc7-ae63-748b5d6b514a"
        val projection = ImHumanReadReceiptPolicy.project(
            progress = ImReadReceipt(readCount = 2, recipientCount = 4),
            detail = ImMessageReadReceipts(
                readers = listOf(
                    ImReadReceiptMember(userId = "human-1", name = "甲"),
                    ImReadReceiptMember(userId = agentId, name = "AI"),
                ),
                unreaders = listOf(
                    ImReadReceiptMember(userId = "human-2", name = "乙"),
                    ImReadReceiptMember(userId = "me", name = "我"),
                ),
            ),
            members = listOf(
                ImMember(userId = "me", nickname = "我"),
                ImMember(userId = "human-1", nickname = "甲"),
                ImMember(userId = "human-2", nickname = "乙"),
                ImMember(
                    memberType = ImMemberType.AGENT,
                    agentId = agentId,
                    nickname = "AI",
                ),
            ),
            currentUserId = "me",
            senderId = "me",
        )

        assertEquals(ImReadReceipt(readCount = 1, recipientCount = 2), projection.progress)
        assertEquals(listOf("human-1"), projection.detail?.readers?.map { it.userId })
        assertEquals(listOf("human-2"), projection.detail?.unreaders?.map { it.userId })
    }

    @Test
    fun `explicit user type wins over legacy agent id prefix`() {
        val projection = ImHumanReadReceiptPolicy.project(
            progress = ImReadReceipt(readCount = 1, recipientCount = 2),
            detail = ImMessageReadReceipts(
                readers = listOf(ImReadReceiptMember(userId = "a_human", name = "真人")),
                unreaders = listOf(ImReadReceiptMember(userId = "a_legacy_agent", name = "AI")),
            ),
            members = listOf(
                ImMember(userId = "me"),
                ImMember(memberType = ImMemberType.USER, userId = "a_human", nickname = "真人"),
            ),
            currentUserId = "me",
            senderId = "me",
        )

        assertEquals(ImReadReceipt(readCount = 1, recipientCount = 1), projection.progress)
        assertEquals(listOf("a_human"), projection.detail?.readers?.map { it.userId })
        assertEquals(emptyList<ImReadReceiptMember>(), projection.detail?.unreaders)
    }

    @Test
    fun `maps domain members and excludes removed readers and unreaders`() {
        val currentUserId = "11111111-1111-4111-8111-111111111111"
        val currentHumanId = "05a81772-b342-4590-a4a1-ed423f5e1a4d"
        val removedReaderId = "22222222-2222-4222-8222-222222222222"
        val removedUnreaderId = "33333333-3333-4333-8333-333333333333"
        val projection = ImHumanReadReceiptPolicy.project(
            progress = ImReadReceipt(readCount = 2, recipientCount = 3),
            detail = ImMessageReadReceipts(
                readers = listOf(
                    ImReadReceiptMember(userId = currentHumanId, name = "当前成员"),
                    ImReadReceiptMember(userId = removedReaderId, name = "已移除读者"),
                ),
                unreaders = listOf(
                    ImReadReceiptMember(userId = removedUnreaderId, name = "已移除未读者"),
                ),
            ),
            members = listOf(
                ImMember(
                    userId = currentUserId,
                ),
                ImMember(
                    userId = currentHumanId,
                    nickname = "当前成员",
                ),
            ),
            currentUserId = currentUserId,
            senderId = currentUserId,
        )

        assertEquals(ImReadReceipt(readCount = 1, recipientCount = 1), projection.progress)
        assertEquals(listOf(currentHumanId), projection.detail?.readers?.map { it.userId })
        assertEquals(emptyList<ImReadReceiptMember>(), projection.detail?.unreaders)
    }

    @Test
    fun `agent added after message keeps human recipients but waits for reader identities`() {
        val projection = ImHumanReadReceiptPolicy.project(
            progress = ImReadReceipt(readCount = 1, recipientCount = 2),
            detail = null,
            members = listOf(
                ImMember(userId = "11111111-1111-4111-8111-111111111111"),
                ImMember(userId = "22222222-2222-4222-8222-222222222222"),
                ImMember(userId = "33333333-3333-4333-8333-333333333333"),
                ImMember(
                    memberType = ImMemberType.AGENT,
                    agentId = "56922c34-4337-4bc7-ae63-748b5d6b514a",
                ),
            ),
            currentUserId = "11111111-1111-4111-8111-111111111111",
            senderId = "11111111-1111-4111-8111-111111111111",
        )

        assertEquals(ImReadReceipt(readCount = 0, recipientCount = 2), projection.progress)
    }

    @Test
    fun `caps recipients without double counting Agent identities`() {
        val projection = ImHumanReadReceiptPolicy.project(
            progress = ImReadReceipt(readCount = 0, recipientCount = 3),
            detail = null,
            members = listOf(
                ImMember(userId = "me"),
                ImMember(userId = "human-1"),
                ImMember(userId = "human-2"),
                ImMember(
                    memberType = ImMemberType.AGENT,
                    userId = "a_provider-agent",
                    agentId = "agent-domain-id",
                ),
            ),
            currentUserId = "me",
            senderId = "me",
        )

        assertEquals(ImReadReceipt(readCount = 0, recipientCount = 2), projection.progress)
    }

    @Test
    fun `does not count unknown readers as human before detail arrives`() {
        val projection = ImHumanReadReceiptPolicy.project(
            progress = ImReadReceipt(readCount = 1, recipientCount = 3),
            detail = null,
            members = listOf(
                ImMember(userId = "me"),
                ImMember(userId = "human-1"),
                ImMember(userId = "human-2"),
                ImMember(memberType = ImMemberType.AGENT, agentId = "agent-1"),
            ),
            currentUserId = "me",
            senderId = "me",
        )

        assertEquals(ImReadReceipt(readCount = 0, recipientCount = 2), projection.progress)
    }

    @Test
    fun `without a member snapshot hides untrusted aggregate counts`() {
        val projection = ImHumanReadReceiptPolicy.project(
            progress = ImReadReceipt(readCount = 3, recipientCount = 4),
            detail = null,
            members = emptyList(),
            currentUserId = "me",
            senderId = "me",
        )

        assertNull(projection.progress)
    }

    @Test
    fun `legacy Agent identity without member type is still excluded`() {
        val projection = ImHumanReadReceiptPolicy.project(
            progress = ImReadReceipt(readCount = 1, recipientCount = 2),
            detail = null,
            members = listOf(
                ImMember(userId = "me"),
                ImMember(userId = "human-1"),
                ImMember(userId = null, agentId = "agent-legacy"),
            ),
            currentUserId = "me",
            senderId = "me",
        )

        assertEquals(ImReadReceipt(readCount = 0, recipientCount = 1), projection.progress)
    }

    @Test
    fun `partial detail counts only confirmed human readers`() {
        val projection = ImHumanReadReceiptPolicy.project(
            progress = ImReadReceipt(readCount = 2, recipientCount = 3),
            detail = ImMessageReadReceipts(
                readers = listOf(ImReadReceiptMember(userId = "human-1", name = "甲")),
                unreaders = emptyList(),
            ),
            members = listOf(
                ImMember(userId = "me"),
                ImMember(userId = "human-1"),
                ImMember(userId = "human-2"),
                ImMember(memberType = ImMemberType.AGENT, agentId = "agent-1"),
            ),
            currentUserId = "me",
            senderId = "me",
        )

        assertEquals(ImReadReceipt(readCount = 1, recipientCount = 2), projection.progress)
    }
}
