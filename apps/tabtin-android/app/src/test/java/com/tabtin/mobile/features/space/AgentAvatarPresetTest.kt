package com.tabtin.mobile.features.space

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentAvatarPresetTest {

    @Test
    fun legacyPresetsKeepTheirKeysOrderAndDefault() {
        assertEquals(
            listOf(
                "general-assistant",
                "code-engineer",
                "doc-writer",
                "data-analyst",
                "web-researcher",
                "slide-designer",
                "office-secretary",
            ),
            AgentAvatarPreset.entries.take(7).map(AgentAvatarPreset::key),
        )
        assertEquals(AgentAvatarPreset.GENERAL_ASSISTANT, AgentAvatarPreset.entries.first())
    }

    @Test
    fun functionPresetsAreAppendedAndResolveByTheirSharedKeys() {
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
    fun fromRecognizesSharedAvatarKeysAfterWhitespaceIsTrimmed() {
        assertEquals(
            AgentAvatarPreset.CODE_ENGINEER,
            AgentAvatarPreset.from("  code-engineer  "),
        )
    }

    @Test
    fun fromRejectsMissingAndUnknownAvatarKeys() {
        assertNull(AgentAvatarPreset.from(null))
        assertNull(AgentAvatarPreset.from("unknown"))
    }
}
