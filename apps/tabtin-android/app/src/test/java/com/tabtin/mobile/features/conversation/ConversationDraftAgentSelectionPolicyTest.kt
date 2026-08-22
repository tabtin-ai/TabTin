package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Test

class ConversationDraftAgentSelectionPolicyTest {
    @Test
    fun `new conversation selects the default available agent`() {
        val options = listOf(
            ComposerTaskAgentOption(
                id = "agent-alpha",
                name = "Alpha",
                isDefault = false,
            ),
            ComposerTaskAgentOption(
                id = "agent-default",
                name = "Default",
                isDefault = true,
            ),
        )

        assertEquals(
            "agent-default",
            ConversationDraftAgentSelectionPolicy.resolve(
                selectedAgentId = null,
                startsNewSession = true,
                options = options,
            ),
        )
    }

    @Test
    fun `new conversation falls back to the first available agent`() {
        val options = listOf(
            ComposerTaskAgentOption(id = "disabled", name = "Disabled", isAvailable = false),
            ComposerTaskAgentOption(id = "available", name = "Available"),
        )

        assertEquals(
            "available",
            ConversationDraftAgentSelectionPolicy.resolve(
                selectedAgentId = null,
                startsNewSession = true,
                options = options,
            ),
        )
    }

    @Test
    fun `existing selection and formal sessions are unchanged`() {
        val options = listOf(
            ComposerTaskAgentOption(id = "default", name = "Default", isDefault = true),
        )

        assertEquals(
            "selected",
            ConversationDraftAgentSelectionPolicy.resolve(
                selectedAgentId = "selected",
                startsNewSession = true,
                options = options,
            ),
        )
        assertEquals(
            null,
            ConversationDraftAgentSelectionPolicy.resolve(
                selectedAgentId = null,
                startsNewSession = false,
                options = options,
            ),
        )
    }
}
