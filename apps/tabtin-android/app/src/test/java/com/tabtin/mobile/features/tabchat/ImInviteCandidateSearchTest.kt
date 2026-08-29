package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ExternalContact
import com.tabtin.mobile.data.model.MemberUser
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.OrganizationRole
import org.junit.Assert.assertEquals
import org.junit.Test

class ImInviteCandidateSearchTest {
    @Test
    fun `invite search matches organization-member identity fields`() {
        val result = filterImInviteMembers(
            candidates = listOf(
                member("u-1", nickname = "小林", email = "lin@example.com"),
                member("u-2", nickname = "王华", email = "wang@example.com"),
            ),
            query = "LIN@",
        )

        assertEquals(listOf("u-1"), result.map { it.userId })
    }

    @Test
    fun `invite search matches external contact and organization names`() {
        val result = filterImInviteExternalContacts(
            candidates = listOf(
                ExternalContact(
                    contactId = "external-1",
                    peerUserId = "zoe",
                    displayName = "周宁",
                    peerOrganizationName = "Design Studio",
                ),
                ExternalContact(
                    contactId = "external-2",
                    peerUserId = "alex",
                    displayName = "陈晨",
                    peerOrganizationName = "Product Lab",
                ),
            ),
            query = "studio",
        )

        assertEquals(listOf("external-1"), result.map { it.contactId })
    }

    private fun member(userId: String, nickname: String, email: String): OrganizationMember =
        OrganizationMember(
            id = "member-$userId",
            userId = userId,
            role = OrganizationRole.VIEWER,
            user = MemberUser(id = userId, nickname = nickname, email = email),
        )
}
