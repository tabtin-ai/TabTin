package com.tabtin.mobile.features.doc.comment

import com.tabtin.mobile.features.doc.SaveState

public object DocCommentWritePolicy {
    public fun canCreate(
        saveState: SaveState,
        isReadOnly: Boolean,
        requiresFullEditor: Boolean,
    ): Boolean = saveState != SaveState.CONFLICT && !isReadOnly && !requiresFullEditor
}
