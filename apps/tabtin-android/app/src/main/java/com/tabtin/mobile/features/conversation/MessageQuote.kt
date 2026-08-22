package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ChatMessage

internal data class ComposerMessageQuote(
    val author: String,
    val content: String,
    val reply: String,
    val payload: String,
)

internal object MessageQuote {
    fun payload(message: ChatMessage): String? {
        if (message.isStreaming) return null
        val content = message.displayContent.trim()
        if (content.isEmpty()) return null
        val author = if (message.isAssistant) "Agent" else "我"
        val quoted = content.lineSequence().joinToString("\n") { "> $it" }
        return "> $author：\n$quoted\n\n"
    }

    fun parseComposerDraft(draft: String): ComposerMessageQuote? {
        val separator = draft.indexOf("\n\n")
        if (separator < 0) return null

        val quoteBlock = draft.substring(0, separator)
        val lines = quoteBlock.split("\n")
        val author = when (lines.firstOrNull()) {
            "> Agent：" -> "Agent"
            "> 我：" -> "我"
            else -> return null
        }
        val contentLines = lines.drop(1).map { line ->
            when {
                line.startsWith("> ") -> line.removePrefix("> ")
                line == ">" -> ""
                else -> return null
            }
        }
        if (contentLines.isEmpty()) return null

        return ComposerMessageQuote(
            author = author,
            content = contentLines.joinToString("\n"),
            reply = draft.substring(separator + 2),
            payload = draft.substring(0, separator + 2),
        )
    }

    fun replacingComposerQuote(draft: String, message: ChatMessage): String? {
        val newPayload = payload(message) ?: return null
        return newPayload + removingComposerQuote(draft)
    }

    fun removingComposerQuote(draft: String): String = parseComposerDraft(draft)?.reply ?: draft
}
