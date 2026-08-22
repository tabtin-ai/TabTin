package com.tabtin.mobile.features.tabdata

import androidx.annotation.StringRes
import com.tabtin.mobile.R

public enum class TabDataSaveIndicatorState(@StringRes public val labelRes: Int) {
    IDLE(0),
    DIRTY(R.string.doc_save_edited),
    SAVING(R.string.doc_save_saving),
    SAVED(R.string.doc_save_saved),
    CONFLICT(R.string.doc_save_conflict_short),
    PERMISSION_DENIED(R.string.tabdata_save_readonly),
    FAILED(R.string.doc_save_failed),
}

public object TabDataSaveIndicatorPolicy {
    public fun shows(state: TabDataSaveIndicatorState): Boolean =
        state != TabDataSaveIndicatorState.IDLE

    public fun showsRetry(state: TabDataSaveIndicatorState): Boolean =
        state == TabDataSaveIndicatorState.FAILED

    public fun fromUi(state: NativeTabDataUiState): TabDataSaveIndicatorState = fromUi(
        isSaving = state.isSaving,
        writeBlockedByServer = state.writeBlockedByServer,
        detailWriteBlocked = state.detailWriteBlocked,
        saveFailed = state.saveFailed,
        saveConflicted = state.saveConflicted,
        isDetailDirty = state.isDetailDirty,
        isCreating = state.isCreating,
        justSaved = state.justSaved,
    )

    public fun fromUi(
        isSaving: Boolean,
        writeBlockedByServer: Boolean,
        detailWriteBlocked: Boolean,
        saveFailed: Boolean,
        saveConflicted: Boolean,
        isDetailDirty: Boolean,
        isCreating: Boolean,
        justSaved: Boolean,
    ): TabDataSaveIndicatorState {
        if (isSaving) return TabDataSaveIndicatorState.SAVING
        if (saveConflicted) return TabDataSaveIndicatorState.CONFLICT
        if (writeBlockedByServer || detailWriteBlocked) {
            return TabDataSaveIndicatorState.PERMISSION_DENIED
        }
        if (saveFailed) return TabDataSaveIndicatorState.FAILED
        if (isDetailDirty || isCreating) return TabDataSaveIndicatorState.DIRTY
        if (justSaved) return TabDataSaveIndicatorState.SAVED
        return TabDataSaveIndicatorState.IDLE
    }
}
