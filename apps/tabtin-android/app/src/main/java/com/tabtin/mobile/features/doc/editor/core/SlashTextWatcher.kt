package com.tabtin.mobile.features.doc.editor.core

import android.text.Editable
import android.util.Log

/**
 * Derived from anytype-kotlin core-ui SlashTextWatcher.
 * Detects '/' character input and manages slash command filter state.
 */
internal class SlashTextWatcher(
    private val onSlashEvent: (SlashTextWatcherState) -> Unit
) : TextInputTextWatcher {

    private var locked: Boolean = false

    override fun lock() { locked = true }
    override fun unlock() { locked = false }

    private var slashCharPosition = NO_SLASH_POSITION
    private var filter: CharSequence = ""

    override fun afterTextChanged(s: Editable?) {}
    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}

    override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) {
        proceedWithStop(start)
        proceedWithStart(text = s, start = start, count = count)
        proceedWithFilter(text = s, start = start, count = count)
    }

    public fun onDismiss() {
        slashCharPosition = NO_SLASH_POSITION
        filter = ""
    }

    private fun proceedWithStart(text: CharSequence, start: Int, count: Int) {
        val slashPosition = SlashHelper.getSlashPosition(text = text, start = start, count = count)
        if (slashPosition != NO_SLASH_POSITION) {
            slashCharPosition = slashPosition
            filter = ""
            proceedWithState(SlashTextWatcherState.Start(start = slashCharPosition))
        }
    }

    private fun proceedWithFilter(text: CharSequence, start: Int, count: Int) {
        if (isSlashCharVisible() && slashCharPosition < text.length && start + count <= text.length) {
            filter = text.subSequence(startIndex = slashCharPosition, endIndex = start + count)
            proceedWithState(SlashTextWatcherState.Filter(filter))
        }
    }

    private fun proceedWithStop(start: Int) {
        if (SlashHelper.isSlashDeleted(start = start, slashPosition = slashCharPosition)) {
            stopSlashWatcher()
        }
    }

    private fun stopSlashWatcher() {
        onDismiss()
        proceedWithState(SlashTextWatcherState.Stop)
    }

    private fun proceedWithState(state: SlashTextWatcherState) {
        if (!locked) {
            onSlashEvent(state)
        } else {
            Log.d(TAG, "Locked slash text watcher. Skipping event: $state")
        }
    }

    private fun isSlashCharVisible(): Boolean = slashCharPosition != NO_SLASH_POSITION

    public companion object {
        private const val TAG = "SlashTextWatcher"
        public const val SLASH_CHAR: Char = '/'
        public const val NO_SLASH_POSITION: Int = -1
    }
}

public sealed class SlashTextWatcherState {
    public data class Start(val start: Int) : SlashTextWatcherState()
    public data class Filter(val text: CharSequence) : SlashTextWatcherState()
    public data object Stop : SlashTextWatcherState()
}

public object SlashHelper {
    public fun getSlashPosition(text: CharSequence, start: Int, count: Int): Int {
        val position = start + count - 1
        return if (count > 0 && start < text.length && text.getOrNull(position) == SlashTextWatcher.SLASH_CHAR) {
            position
        } else {
            SlashTextWatcher.NO_SLASH_POSITION
        }
    }

    public fun isSlashDeleted(start: Int, slashPosition: Int): Boolean =
        slashPosition != SlashTextWatcher.NO_SLASH_POSITION && start <= slashPosition
}
