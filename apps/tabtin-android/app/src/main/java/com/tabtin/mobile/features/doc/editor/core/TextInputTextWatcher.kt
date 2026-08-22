package com.tabtin.mobile.features.doc.editor.core

import android.text.TextWatcher

/**
 * Derived from anytype-kotlin core-ui TextInputTextWatcher.
 * Lockable TextWatcher — prevents callbacks during programmatic text changes.
 */
public interface TextInputTextWatcher : TextWatcher {
    public fun lock()
    public fun unlock()
}
