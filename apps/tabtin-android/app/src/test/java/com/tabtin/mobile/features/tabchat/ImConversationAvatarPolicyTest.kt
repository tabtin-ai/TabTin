package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ImConversationDetail
import com.tabtin.mobile.data.im.ImConversationType
import com.tabtin.mobile.data.im.ImMember
import com.tabtin.mobile.data.im.ImMemberType
import com.tabtin.mobile.ui.components.IdentityAvatarImagePresentation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImConversationAvatarPolicyTest {
    @Test
    fun `only group admin or owner can edit avatar`() {
        val members = listOf(
            ImMember(userId = "member", role = 1),
            ImMember(userId = "admin", role = 2),
            ImMember(userId = "owner", role = 3),
            ImMember(memberType = ImMemberType.AGENT, agentId = "agent", role = 3),
        )
        val group = ImConversationDetail(
            id = "group-1",
            organizationId = "org-1",
            type = ImConversationType.GROUP,
            members = members,
        )
        val directMessage = group.copy(id = "dm-1", type = ImConversationType.DM)

        assertFalse(ImConversationAvatarPolicy.canEditGroupAvatar(group, "member"))
        assertTrue(ImConversationAvatarPolicy.canEditGroupAvatar(group, "admin"))
        assertTrue(ImConversationAvatarPolicy.canEditGroupAvatar(group, "owner"))
        assertFalse(ImConversationAvatarPolicy.canEditGroupAvatar(group, "agent"))
        assertFalse(ImConversationAvatarPolicy.canEditGroupAvatar(directMessage, "admin"))
    }

    @Test
    fun `remote avatar does not show text while image is loading`() {
        assertEquals(
            IdentityAvatarImagePresentation.Loading,
            IdentityAvatarImagePresentation.mode(
                hasRemoteImage = true,
                hasCachedImage = false,
                didFail = false,
            ),
        )
        assertEquals(
            IdentityAvatarImagePresentation.Image,
            IdentityAvatarImagePresentation.mode(
                hasRemoteImage = true,
                hasCachedImage = true,
                didFail = false,
            ),
        )
        assertEquals(
            IdentityAvatarImagePresentation.Fallback,
            IdentityAvatarImagePresentation.mode(
                hasRemoteImage = true,
                hasCachedImage = false,
                didFail = true,
            ),
        )
    }
}
