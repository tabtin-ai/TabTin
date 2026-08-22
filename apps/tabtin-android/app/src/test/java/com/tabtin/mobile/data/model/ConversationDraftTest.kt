package com.tabtin.mobile.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class ConversationDraftTest {

    @Test
    fun `draft blocks retain uploaded file ids but never persist a signed url`() {
        val persisted = ConversationDraftBlock.fromMessageBlock(
            MessageBlock(
                type = "file",
                fileId = "file-123",
                filename = "brief.pdf",
                mimeType = "application/pdf",
                url = "https://storage.example/signed?token=secret",
            ),
        )

        val restored = requireNotNull(persisted).toMessageBlock()
        assertEquals("file-123", restored.fileId)
        assertEquals("brief.pdf", restored.filename)
        assertNull(restored.url)
    }

    @Test
    fun `unuploaded attachments do not enter a recoverable draft`() {
        val persisted = ConversationDraftBlock.fromMessageBlock(
            MessageBlock(
                type = "image",
                filename = "local-photo.jpg",
                url = "content://media/local-photo",
            ),
        )

        assertNull(persisted)
    }

    @Test
    fun `draft recognizes both the stable creation id and recorded pending session`() {
        val draft = ConversationDraftSnapshot(
            draftId = "draft-session-id",
            scope = ConversationDraftScope("org", "workspace"),
            text = "hello",
            agentId = "agent",
            modelId = "model",
            pendingSessionId = "server-session-id",
        )

        assertTrue(draft.matchesSession("draft-session-id"))
        assertTrue(draft.matchesSession("server-session-id"))
        assertFalse(draft.matchesSession("another-session"))
    }

    @Test
    fun `create session request carries the frozen first-send facts`() {
        val encoded = Json.encodeToString(
            CreateSessionRequest(
                sessionId = "00000000-0000-0000-0000-000000000001",
                agentId = "agent",
                workspaceId = "workspace",
                projectId = "project",
                organizationId = "organization",
                modelId = "00000000-0000-0000-0000-000000000002",
                agentMode = "plan",
                approvalMode = "always_ask",
            ),
        )

        assertTrue(encoded.contains("\"session_id\""))
        assertTrue(encoded.contains("\"model_id\""))
        assertTrue(encoded.contains("\"agent_mode\":\"plan\""))
        assertTrue(encoded.contains("\"approval_mode\":\"always_ask\""))
    }
}
