package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class ConversationAttachmentScopePolicyTest {
    @Test
    fun `new conversation binds attachments to explicit organization and draft context`() {
        val scope = ConversationAttachmentScopePolicy.resolve(
            sessionId = "",
            startsNewSession = true,
            organizationId = "organization-1",
            workspaceId = "workspace-1",
            projectId = "project-1",
        )

        assertNotNull(scope)
        assertEquals("organization-1", scope?.organizationId)
        assertEquals("message", scope?.contextType)
        assertEquals("draft:workspace-1:project-1", scope?.contextId)
    }

    @Test
    fun `existing conversation keeps its session as attachment context`() {
        val scope = ConversationAttachmentScopePolicy.resolve(
            sessionId = "session-1",
            startsNewSession = false,
            organizationId = "organization-1",
            workspaceId = "workspace-1",
            projectId = null,
        )

        assertEquals("session-1", scope?.contextId)
    }
}
