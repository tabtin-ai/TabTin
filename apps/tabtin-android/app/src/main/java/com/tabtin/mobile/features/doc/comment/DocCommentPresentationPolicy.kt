package com.tabtin.mobile.features.doc.comment

import com.tabtin.mobile.data.model.doc.CommentThread
import com.tabtin.mobile.features.doc.model.DocBlock

public enum class DocCommentAnchorKind {
    DOCUMENT,
    BLOCK,
    ORPHANED,
}

public data class DocCommentPresentationLabels(
    val documentTitle: String,
    val blockTitle: String,
    val orphanedTitle: String,
    val anonymousAuthor: String,
)

public data class DocCommentPresentation(
    val threadId: String,
    val kind: DocCommentAnchorKind,
    val title: String,
    val body: String,
    val authorName: String,
    val authorAvatarUrl: String? = null,
    val matchedBlockId: String? = null,
    val blockPreview: String? = null,
)

/**
 * 第一档只按 [DocBlock.blockId] 对块级锚点。运行期 id / 历史记录 id 不能当标题，
 * 也对不上原生块；对不上就标失联，不改正文。
 */
public fun presentCommentThreads(
    threads: List<CommentThread>,
    blocks: List<DocBlock>,
    labels: DocCommentPresentationLabels,
): List<DocCommentPresentation> {
    val blocksByPersistentId = linkedMapOf<String, DocBlock>()
    blocks.forEach { block ->
        val persistentId = block.blockId?.takeIf(String::isNotBlank) ?: return@forEach
        blocksByPersistentId.putIfAbsent(persistentId, block)
    }
    return threads.map { thread -> presentThread(thread, blocksByPersistentId, labels) }
}

private fun presentThread(
    thread: CommentThread,
    blocksByPersistentId: Map<String, DocBlock>,
    labels: DocCommentPresentationLabels,
): DocCommentPresentation {
    val root = thread.messages.firstOrNull { it.kind == "root" && !it.isDeleted }
        ?: thread.messages.firstOrNull { !it.isDeleted }
    val body = root?.body.orEmpty()
    val authorName = root?.authorName?.takeIf(String::isNotBlank) ?: labels.anonymousAuthor
    val authorAvatarUrl = root?.authorAvatar?.takeIf(String::isNotBlank)

    if (thread.scope == "document") {
        return DocCommentPresentation(
            threadId = thread.id,
            kind = DocCommentAnchorKind.DOCUMENT,
            title = labels.documentTitle,
            body = body,
            authorName = authorName,
            authorAvatarUrl = authorAvatarUrl,
        )
    }

    val matched = thread.anchor.blockIds
        .asSequence()
        .mapNotNull { id -> id.takeIf(String::isNotBlank)?.let(blocksByPersistentId::get) }
        .firstOrNull()
    if (matched == null) {
        return DocCommentPresentation(
            threadId = thread.id,
            kind = DocCommentAnchorKind.ORPHANED,
            title = labels.orphanedTitle,
            body = body,
            authorName = authorName,
            authorAvatarUrl = authorAvatarUrl,
        )
    }

    val preview = matched.text.trim().ifBlank {
        thread.selectedText?.trim().orEmpty().ifBlank {
            thread.anchor.selectedText?.trim().orEmpty()
        }
    }
    val title = preview.take(40).ifBlank { labels.blockTitle }
    return DocCommentPresentation(
        threadId = thread.id,
        kind = DocCommentAnchorKind.BLOCK,
        title = title,
        body = body,
        authorName = authorName,
        authorAvatarUrl = authorAvatarUrl,
        matchedBlockId = matched.blockId,
        blockPreview = preview.ifBlank { null },
    )
}
