package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerModelSelectionPolicyTest {
    @Test
    fun `model selection is disabled while a response is streaming`() {
        assertFalse(
            ComposerModelSelectionPolicy.canSelect(
                isSending = false,
                isStreaming = true,
                isPaused = false,
                isSwitchingModel = false,
            ),
        )
    }

    @Test
    fun `model selection is disabled while a run is paused`() {
        assertFalse(
            ComposerModelSelectionPolicy.canSelect(
                isSending = false,
                isStreaming = false,
                isPaused = true,
                isSwitchingModel = false,
            ),
        )
    }

    @Test
    fun `model selection remains available when conversation is idle`() {
        assertTrue(
            ComposerModelSelectionPolicy.canSelect(
                isSending = false,
                isStreaming = false,
                isPaused = false,
                isSwitchingModel = false,
            ),
        )
    }

    @Test
    fun `model selection is disabled while another switch is pending`() {
        assertFalse(
            ComposerModelSelectionPolicy.canSelect(
                isSending = false,
                isStreaming = false,
                isPaused = false,
                isSwitchingModel = true,
            ),
        )
    }
}
