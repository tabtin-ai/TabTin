package com.tabtin.mobile.features.conversation

internal object ComposerModelSelectionPolicy {
    fun canSelect(
        isSending: Boolean,
        isStreaming: Boolean,
        isPaused: Boolean,
        isSwitchingModel: Boolean,
    ): Boolean = !isSending && !isStreaming && !isPaused && !isSwitchingModel
}
