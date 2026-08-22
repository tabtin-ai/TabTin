package com.tabtin.mobile.features.space

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MemorySettingsUiStateTest {

    @Test
    fun dirtyStateUsesTheServerRecordPreferenceInsteadOfAnAgentFallback() {
        assertFalse(
            MemorySettingsUiState(
                enabled = false,
                savedEnabled = null,
                isLoading = false,
            ).isDirty,
        )

        assertTrue(
            MemorySettingsUiState(
                enabled = false,
                savedEnabled = true,
                isLoading = false,
            ).isDirty,
        )

        assertFalse(
            MemorySettingsUiState(
                enabled = false,
                savedEnabled = false,
                isLoading = false,
            ).isDirty,
        )
    }
}
