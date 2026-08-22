package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ExternalContact
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.OrganizationRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContactsDirectoryGroupingTest {
    @Test
    fun `keeps friends and blocked contacts in separate directory tabs`() {
        val groups = groupExternalContacts(
            listOf(
                contact(id = "friend", relationship = "friend"),
                contact(id = "blocked", relationship = "blocked"),
                contact(id = "removed", relationship = "removed"),
            ),
        )

        assertEquals(listOf("friend"), groups.friends.map { it.contactId })
        assertEquals(listOf("blocked"), groups.blocked.map { it.contactId })
    }

    @Test
    fun `invitation failure stays on its own directory tab`() {
        val externalState = ContactsUiState(
            selectedTab = ContactsDirectoryTab.EXTERNAL,
            incomingInvitationsErrorMessage = "邀请接口失败",
        )
        val incomingState = externalState.copy(selectedTab = ContactsDirectoryTab.INCOMING)

        assertNull(externalState.selectedDirectoryError())
        assertEquals("邀请接口失败", incomingState.selectedDirectoryError())
    }

    @Test
    fun `only team owner can see add organization member entry`() {
        val owner = member("owner", OrganizationRole.OWNER)
        val admin = member("admin", OrganizationRole.ADMIN)

        assertTrue(canInviteOrganizationMembers(listOf(owner), "owner", false))
        assertFalse(canInviteOrganizationMembers(listOf(owner), "owner", true))
        assertFalse(canInviteOrganizationMembers(listOf(admin), "admin", false))
        assertFalse(canInviteOrganizationMembers(listOf(owner), null, false))
    }

    private fun contact(id: String, relationship: String): ExternalContact =
        ExternalContact(contactId = id, relationship = relationship)

    private fun member(userId: String, role: OrganizationRole): OrganizationMember =
        OrganizationMember(
            id = "member:$userId",
            userId = userId,
            role = role,
        )
}
