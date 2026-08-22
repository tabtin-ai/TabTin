package com.tabtin.mobile.features.tabdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import com.tabtin.mobile.R

class TabDataSaveIndicatorPolicyTest {
    @Test
    fun `shows only occupies navigation space while active or actionable`() {
        assertFalse(TabDataSaveIndicatorPolicy.shows(TabDataSaveIndicatorState.IDLE))
        assertTrue(TabDataSaveIndicatorPolicy.shows(TabDataSaveIndicatorState.DIRTY))
        assertTrue(TabDataSaveIndicatorPolicy.shows(TabDataSaveIndicatorState.SAVED))
        assertTrue(TabDataSaveIndicatorPolicy.shows(TabDataSaveIndicatorState.SAVING))
        assertTrue(TabDataSaveIndicatorPolicy.shows(TabDataSaveIndicatorState.CONFLICT))
        assertTrue(TabDataSaveIndicatorPolicy.shows(TabDataSaveIndicatorState.PERMISSION_DENIED))
        assertTrue(TabDataSaveIndicatorPolicy.shows(TabDataSaveIndicatorState.FAILED))
    }

    @Test
    fun `showsRetry is offered only after a failed save`() {
        assertFalse(TabDataSaveIndicatorPolicy.showsRetry(TabDataSaveIndicatorState.IDLE))
        assertFalse(TabDataSaveIndicatorPolicy.showsRetry(TabDataSaveIndicatorState.DIRTY))
        assertFalse(TabDataSaveIndicatorPolicy.showsRetry(TabDataSaveIndicatorState.SAVING))
        assertFalse(TabDataSaveIndicatorPolicy.showsRetry(TabDataSaveIndicatorState.SAVED))
        assertFalse(TabDataSaveIndicatorPolicy.showsRetry(TabDataSaveIndicatorState.CONFLICT))
        assertFalse(TabDataSaveIndicatorPolicy.showsRetry(TabDataSaveIndicatorState.PERMISSION_DENIED))
        assertTrue(TabDataSaveIndicatorPolicy.showsRetry(TabDataSaveIndicatorState.FAILED))
    }

    @Test
    fun `fromUi maps idle dirty failed and blocked states`() {
        assertEquals(
            TabDataSaveIndicatorState.IDLE,
            TabDataSaveIndicatorPolicy.fromUi(idleInputs()),
        )
        assertEquals(
            TabDataSaveIndicatorState.SAVING,
            TabDataSaveIndicatorPolicy.fromUi(idleInputs().copy(isSaving = true, isDetailDirty = true)),
        )
        assertEquals(
            TabDataSaveIndicatorState.DIRTY,
            TabDataSaveIndicatorPolicy.fromUi(idleInputs().copy(isDetailDirty = true)),
        )
        assertEquals(
            TabDataSaveIndicatorState.FAILED,
            TabDataSaveIndicatorPolicy.fromUi(idleInputs().copy(saveFailed = true)),
        )
        assertEquals(
            TabDataSaveIndicatorState.CONFLICT,
            TabDataSaveIndicatorPolicy.fromUi(
                idleInputs().copy(
                    saveConflicted = true,
                    writeBlockedByServer = true,
                ),
            ),
        )
        assertEquals(
            TabDataSaveIndicatorState.PERMISSION_DENIED,
            TabDataSaveIndicatorPolicy.fromUi(idleInputs().copy(writeBlockedByServer = true)),
        )
        assertEquals(
            TabDataSaveIndicatorState.PERMISSION_DENIED,
            TabDataSaveIndicatorPolicy.fromUi(
                NativeTabDataUiState(
                    writeBlockedByServer = true,
                    saveConflicted = false,
                    conflictMessageRes = R.string.tabdata_permission_changed_draft_preserved,
                ),
            ),
        )
        assertEquals(
            TabDataSaveIndicatorState.SAVED,
            TabDataSaveIndicatorPolicy.fromUi(idleInputs().copy(justSaved = true)),
        )
        assertFalse(
            TabDataSaveIndicatorPolicy.shows(
                TabDataSaveIndicatorPolicy.fromUi(idleInputs()),
            ),
        )
        assertTrue(
            TabDataSaveIndicatorPolicy.showsRetry(
                TabDataSaveIndicatorPolicy.fromUi(idleInputs().copy(saveFailed = true)),
            ),
        )
    }

    @Test
    fun `justSaved residual stays SAVED after snackbar message is consumed`() {
        val state = NativeTabDataUiState(
            justSaved = true,
            mutationMessageRes = null,
        )
        assertEquals(TabDataSaveIndicatorState.SAVED, TabDataSaveIndicatorPolicy.fromUi(state))
        assertTrue(TabDataSaveIndicatorPolicy.shows(TabDataSaveIndicatorPolicy.fromUi(state)))
        assertFalse(TabDataSaveIndicatorPolicy.showsRetry(TabDataSaveIndicatorPolicy.fromUi(state)))
    }

    @Test
    fun `soft version conflict residual stays CONFLICT while draft is dirty`() {
        val state = NativeTabDataUiState(
            saveConflicted = true,
            conflictMessageRes = null,
            detailDraft = mapOf("name" to kotlinx.serialization.json.JsonPrimitive("edited")),
            detailOriginal = emptyMap(),
        )
        assertTrue(state.isDetailDirty)
        assertEquals(TabDataSaveIndicatorState.CONFLICT, TabDataSaveIndicatorPolicy.fromUi(state))
        assertFalse(TabDataSaveIndicatorPolicy.showsRetry(TabDataSaveIndicatorPolicy.fromUi(state)))
    }

    private data class Inputs(
        val isSaving: Boolean = false,
        val writeBlockedByServer: Boolean = false,
        val detailWriteBlocked: Boolean = false,
        val saveFailed: Boolean = false,
        val saveConflicted: Boolean = false,
        val isDetailDirty: Boolean = false,
        val isCreating: Boolean = false,
        val justSaved: Boolean = false,
    )

    private fun idleInputs(): Inputs = Inputs()

    private fun TabDataSaveIndicatorPolicy.fromUi(inputs: Inputs): TabDataSaveIndicatorState =
        fromUi(
            isSaving = inputs.isSaving,
            writeBlockedByServer = inputs.writeBlockedByServer,
            detailWriteBlocked = inputs.detailWriteBlocked,
            saveFailed = inputs.saveFailed,
            saveConflicted = inputs.saveConflicted,
            isDetailDirty = inputs.isDetailDirty,
            isCreating = inputs.isCreating,
            justSaved = inputs.justSaved,
        )
}
