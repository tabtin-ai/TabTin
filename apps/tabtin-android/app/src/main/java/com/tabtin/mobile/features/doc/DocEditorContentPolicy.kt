package com.tabtin.mobile.features.doc

import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView

/** Keeps the document title in the reading flow without leaking its adapter offset to the model. */
internal object DocEditorContentPolicy {
    private const val DOCUMENT_TITLE_ID = "__tabtin_document_title__"

    fun adapterItems(
        title: String,
        blocks: List<TabDocBlockView>,
    ): List<TabDocBlockView> = buildList(blocks.size + 2) {
        add(TabDocBlockView.Title(id = DOCUMENT_TITLE_ID, body = title))
        addAll(blocks)
        add(TabDocBlockView.CommentsFooter())
    }

    /** Position zero is the document title; the last row is the comments footer. */
    fun documentBlockIndex(adapterPosition: Int, itemCount: Int? = null): Int? {
        if (adapterPosition <= 0) return null
        if (itemCount != null && adapterPosition >= itemCount - 1) return null
        return adapterPosition - 1
    }

    fun isCommentsFooter(item: TabDocBlockView): Boolean = item is TabDocBlockView.CommentsFooter
}
