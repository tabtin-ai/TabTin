package com.tabtin.mobile.features.workspace

import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.OrganizationRole
import org.junit.Assert.assertEquals
import org.junit.Test

class WsMembersTabTest {
    @Test
    fun `owner is first while other members keep server order`() {
        val members = listOf(
            member("editor", OrganizationRole.EDITOR),
            member("viewer", OrganizationRole.VIEWER),
            member("owner", OrganizationRole.OWNER),
            member("admin", OrganizationRole.ADMIN),
        )

        assertEquals(
            listOf("owner", "editor", "viewer", "admin"),
            ownerFirst(members).map { it.userId },
        )
    }

    @Test
    fun `member actions follow role hierarchy and organization boundaries`() {
        assertEquals(
            true,
            canManageOrganizationMember(OrganizationRole.OWNER, OrganizationRole.ADMIN, false, false),
        )
        assertEquals(
            true,
            canManageOrganizationMember(OrganizationRole.ADMIN, OrganizationRole.EDITOR, false, false),
        )
        assertEquals(
            false,
            canManageOrganizationMember(OrganizationRole.ADMIN, OrganizationRole.ADMIN, false, false),
        )
        assertEquals(
            false,
            canManageOrganizationMember(OrganizationRole.OWNER, OrganizationRole.EDITOR, true, false),
        )
        assertEquals(
            false,
            canManageOrganizationMember(OrganizationRole.OWNER, OrganizationRole.EDITOR, false, true),
        )
    }

    private fun member(userId: String, role: OrganizationRole): OrganizationMember =
        OrganizationMember(
            id = "member-$userId",
            userId = userId,
            role = role,
        )
}
