package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.MemberUser
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.OrganizationRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConversationSessionSharePresentationTest {

    @Test
    fun `empty recipients distinguishes an empty organization from no search results`() {
        assertEquals(
            "组织内没有其他可共享成员。",
            ConversationSessionSharePresentation.emptyRecipientsMessage("   "),
        )
        assertEquals(
            "未找到匹配成员。",
            ConversationSessionSharePresentation.emptyRecipientsMessage("hu"),
        )
    }

    @Test
    fun `recipient subtitle exposes only username`() {
        assertEquals(
            "@lin",
            ConversationSessionSharePresentation.recipientSubtitle(
                member(username = " lin ", email = "lin@example.com"),
            ),
        )
        assertNull(
            ConversationSessionSharePresentation.recipientSubtitle(
                member(username = null, email = "private@example.com"),
            ),
        )
        assertEquals(
            "小林",
            ConversationSessionSharePresentation.memberDisplayName(
                member(username = "lin", email = "lin@example.com"),
            ),
        )
        assertEquals(
            "成员",
            ConversationSessionSharePresentation.memberDisplayName(
                member(username = null, email = "private@example.com", nickname = ""),
            ),
        )
    }

    private fun member(
        username: String?,
        email: String,
        nickname: String = "小林",
    ): OrganizationMember = OrganizationMember(
        id = "member-1",
        userId = "user-secret-id",
        role = OrganizationRole.VIEWER,
        user = MemberUser(
            id = "user-secret-id",
            nickname = nickname,
            username = username,
            email = email,
        ),
    )
}
