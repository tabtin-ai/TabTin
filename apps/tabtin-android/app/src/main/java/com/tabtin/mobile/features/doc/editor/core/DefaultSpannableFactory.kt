package com.tabtin.mobile.features.doc.editor.core

import android.text.Spannable

/**
 * Derived from anytype-kotlin core-ui DefaultSpannableFactory.
 * Avoids unnecessary SpannableStringBuilder allocation when source is already Spannable.
 */
public class DefaultSpannableFactory : Spannable.Factory() {
    override fun newSpannable(source: CharSequence): Spannable {
        return source as? Spannable ?: super.newSpannable(source)
    }
}
