package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TaskHomeAgentFaceResolverTest {
    @Test
    fun storeAvatarKeyWinsOverStaleSessionAvatar() {
        val raw = TaskHomeAgentFaceResolver.resolveAvatarRaw(
            agentId = "agent-new",
            sessionAvatar = "code-engineer",
            storeAvatarUrl = null,
            storeAvatarKey = "web-researcher",
        )
        assertEquals("web-researcher", raw)
    }

    @Test
    fun storeAvatarUrlWinsOverKeyAndSession() {
        val raw = TaskHomeAgentFaceResolver.resolveAvatarRaw(
            agentId = "agent-new",
            sessionAvatar = "code-engineer",
            storeAvatarUrl = "https://cdn.example.test/a.png",
            storeAvatarKey = "function-web-researcher",
        )
        assertEquals("https://cdn.example.test/a.png", raw)
    }

    @Test
    fun fallsBackToSessionWhenStoreMissing() {
        val raw = TaskHomeAgentFaceResolver.resolveAvatarRaw(
            agentId = "agent-new",
            sessionAvatar = "doc-writer",
            storeAvatarUrl = null,
            storeAvatarKey = null,
        )
        assertEquals("doc-writer", raw)
    }

    @Test
    fun agentIdentityWithoutAnyAvatarUsesGeneralAssistant() {
        val raw = TaskHomeAgentFaceResolver.resolveAvatarRaw(
            agentId = "agent-new",
            sessionAvatar = null,
            storeAvatarUrl = null,
            storeAvatarKey = null,
        )
        assertEquals(AgentAvatarPreset.GENERAL_ASSISTANT.key, raw)
    }

    @Test
    fun noAgentIdentityReturnsNull() {
        val raw = TaskHomeAgentFaceResolver.resolveAvatarRaw(
            agentId = null,
            sessionAvatar = null,
            storeAvatarUrl = null,
            storeAvatarKey = null,
        )
        assertNull(raw)
    }

    @Test
    fun displayNamePrefersStore() {
        val name = TaskHomeAgentFaceResolver.resolveDisplayName(
            agentId = "agent-new",
            sessionAgentName = "旧名",
            storeDisplayName = "冲浪版",
            locationName = "Workspace",
        )
        assertEquals("冲浪版", name)
    }
}
