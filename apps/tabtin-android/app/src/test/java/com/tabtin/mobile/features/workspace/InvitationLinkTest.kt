package com.tabtin.mobile.features.workspace

import org.junit.Assert.assertEquals
import org.junit.Test

class InvitationLinkTest {
    @Test
    fun `invite link uses current web environment`() {
        assertEquals(
            "https://web-test.example.com/invite/invite-token",
            invitationLink("https://web-test.example.com", "invite-token"),
        )
        assertEquals(
            "https://web.example.com/invite/invite%2Ftoken",
            invitationLink("https://web.example.com/", " invite/token "),
        )
    }
}
