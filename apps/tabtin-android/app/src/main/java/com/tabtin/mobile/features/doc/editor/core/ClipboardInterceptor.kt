package com.tabtin.mobile.features.doc.editor.core

/**
 * Derived from anytype-kotlin core-ui ClipboardInterceptor.
 * Intercepts clipboard operations (copy/paste) for custom handling.
 */
public interface ClipboardInterceptor {

    public fun onClipboardAction(action: Action)
    public fun onBookmarkPasted(url: String) {}
    public fun onLinkPasted(url: String) {}

    public sealed class Action {
        public data class Copy(val selection: IntRange) : Action()
        public data class Paste(val selection: IntRange) : Action()
    }
}
