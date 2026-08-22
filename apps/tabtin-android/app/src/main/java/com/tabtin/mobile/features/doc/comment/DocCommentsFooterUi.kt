package com.tabtin.mobile.features.doc.comment

public data class DocCommentsFooterUi(
    val presentations: List<DocCommentPresentation> = emptyList(),
    val draft: String = "",
    val canCreate: Boolean = false,
    val isPosting: Boolean = false,
)
