package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

@Composable
internal fun FileReadCardView(step: AgentStep) {
    val input = remember(step.input) { parseJson(step.input) }
    val path = input?.optString("path").takeIf { !it.isNullOrEmpty() }
        ?: input?.optString("file_path").orEmpty()
    val content = step.output ?: ""
    val filename = path.substringAfterLast("/").ifEmpty { "file" }
    val language = FILE_EXTENSION_TO_LANGUAGE[filename.substringAfterLast(".", "")]
    val lineCount = remember(content) { if (content.isNotBlank()) content.lines().size else 0 }

    ToolCardContainer(
        header = {
            Icon(Icons.Default.Description, null, modifier = Modifier.size(ChatCardTokens.iconSize), tint = ChatCardTokens.textMuted())
            Spacer(Modifier.width(TTSpacing.xs))
            Text(filename, style = TTFonts.captionSemibold, color = ChatCardTokens.textPrimary(), modifier = Modifier.weight(1f))
            if (lineCount > 0) {
                Text(
                    stringResource(R.string.chat_card_lines, lineCount),
                    style = TTFonts.caption,
                    color = ChatCardTokens.textMuted(),
                )
            }
        },
    ) {
        if (content.isNotBlank()) {
            CodeBlockView(code = content.take(5000), language = language, maxLines = 30)
        }
    }
}

@Composable
internal fun FileWriteCardView(step: AgentStep) {
    val input = remember(step.input) { parseJson(step.input) }
    val path = input?.optString("path").takeIf { !it.isNullOrEmpty() }
        ?: input?.optString("file_path").orEmpty()
    val content = input?.optString("content").orEmpty()
    val filename = path.substringAfterLast("/").ifEmpty { "file" }
    val language = FILE_EXTENSION_TO_LANGUAGE[filename.substringAfterLast(".", "")]

    ToolCardContainer(
        header = {
            Icon(Icons.Default.Edit, null, modifier = Modifier.size(ChatCardTokens.iconSize), tint = ChatCardTokens.textAccent())
            Spacer(Modifier.width(TTSpacing.xs))
            Text(stringResource(R.string.chat_card_write_file), style = TTFonts.captionSemibold, color = ChatCardTokens.textSecondary())
            Spacer(Modifier.width(TTSpacing.xs))
            Text(filename, style = TTFonts.captionSemibold, color = ChatCardTokens.textPrimary())
        },
    ) {
        if (content.isNotBlank()) {
            CodeBlockView(code = content.take(3000), language = language, maxLines = 20)
        } else {
            Text(
                path,
                style = TTFonts.caption,
                color = ChatCardTokens.textMuted(),
                modifier = Modifier.padding(ChatCardTokens.cardPaddingH, ChatCardTokens.cardPaddingV),
            )
        }
    }
}

internal val FILE_EXTENSION_TO_LANGUAGE = mapOf(
    "kt" to "kotlin", "java" to "java", "py" to "python", "js" to "javascript",
    "ts" to "typescript", "tsx" to "typescript", "jsx" to "javascript",
    "swift" to "swift", "rs" to "rust", "go" to "go", "rb" to "ruby",
    "sql" to "sql", "sh" to "bash", "bash" to "bash", "zsh" to "bash",
    "json" to "json", "xml" to "xml", "html" to "html", "css" to "css",
    "yaml" to "yaml", "yml" to "yaml", "toml" to "toml", "md" to "markdown",
    "gradle" to "gradle", "kts" to "kotlin",
)
