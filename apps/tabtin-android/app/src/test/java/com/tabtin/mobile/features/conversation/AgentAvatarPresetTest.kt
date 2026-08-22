package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentAvatarPresetTest {
    @Test
    fun functionPresetsResolveForConversationSurfaces() {
        val functionKeys = listOf(
            "function-general-assistant",
            "function-code-engineer",
            "function-doc-writer",
            "function-data-analyst",
            "function-web-researcher",
            "function-slide-designer",
            "function-office-secretary",
        )

        assertEquals(functionKeys, AgentAvatarPreset.entries.drop(7).map(AgentAvatarPreset::key))
        functionKeys.forEach { key ->
            assertEquals(key, AgentAvatarPreset.from(key)?.key)
        }
    }

    @Test
    fun unknownPresetStillFallsBackOutsideTheRegistry() {
        assertNull(AgentAvatarPreset.from("future-avatar"))
    }
}
