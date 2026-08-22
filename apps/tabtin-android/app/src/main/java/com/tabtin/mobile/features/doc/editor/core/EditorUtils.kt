package com.tabtin.mobile.features.doc.editor.core

import android.text.Editable
import android.text.Spannable
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.TextView

/**
 * Derived from anytype-kotlin core-utils.
 * Consolidated editor utility functions.
 */

// --- Keyboard ---

public fun EditText.showKeyboard() {
    post {
        if (!hasFocus()) {
            if (requestFocus()) {
                val imm = context.getSystemService(InputMethodManager::class.java)
                imm?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
            }
        }
    }
}

// --- Span removal ---

public inline fun <reified T> Editable.removeSpans() {
    getSpans(0, length, T::class.java).forEach { removeSpan(it) }
}

public inline fun <reified T> Spannable.removeSpans() {
    getSpans(0, length, T::class.java).forEach { removeSpan(it) }
}

// --- IME input action ---

public enum class InputAction {
    NewLine,
    Done;

    public fun toIMECode(): Int = when (this) {
        Done -> EditorInfo.IME_ACTION_DONE
        NewLine -> EditorInfo.IME_ACTION_GO
    }
}

// --- Enter key detection ---

public fun KeyEvent?.isEnterPressed(): Boolean =
    this != null && keyCode == KeyEvent.KEYCODE_ENTER && action == KeyEvent.ACTION_DOWN

public class OnEnterActionListener(
    private val onEnter: (tv: TextView) -> Unit
) : TextView.OnEditorActionListener {
    override fun onEditorAction(tv: TextView, actionId: Int, keyEvent: KeyEvent?): Boolean {
        val isEnter = actionId == EditorInfo.IME_ACTION_GO
                || actionId == EditorInfo.IME_ACTION_DONE
                || actionId == EditorInfo.IME_ACTION_UNSPECIFIED && keyEvent.isEnterPressed()
        if (isEnter) {
            onEnter(tv)
            return true
        }
        return false
    }
}
