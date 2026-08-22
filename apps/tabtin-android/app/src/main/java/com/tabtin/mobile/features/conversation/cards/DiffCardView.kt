package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

private const val MAX_PREVIEW_LINES = 10

@Composable
internal fun DiffCardView(step: AgentStep) {
    val input = remember(step.input) { parseJson(step.input) }
    val path = input?.optString("path").takeIf { !it.isNullOrEmpty() }
        ?: input?.optString("file").orEmpty()
    val diff = input?.optString("diff").takeIf { !it.isNullOrEmpty() }
        ?: input?.optString("content").takeIf { !it.isNullOrEmpty() }
        ?: step.output ?: ""

    val allLines = remember(diff) { diff.lines() }
    val contentLines = remember(allLines) {
        allLines.filter { !it.startsWith("@@") && !it.startsWith("diff ") && !it.startsWith("index ") }
    }
    val addCount = remember(contentLines) { contentLines.count { it.startsWith("+") && !it.startsWith("+++") } }
    val removeCount = remember(contentLines) { contentLines.count { it.startsWith("-") && !it.startsWith("---") } }
    val previewLines = remember(contentLines) { contentLines.take(MAX_PREVIEW_LINES) }
    val hasMore = contentLines.size > MAX_PREVIEW_LINES

    ToolCardContainer(
        header = {
            Text(
                path.substringAfterLast("/").ifEmpty { "diff" },
                style = TTFonts.captionSemibold,
                color = ChatCardTokens.textPrimary(),
                modifier = Modifier.weight(1f),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                if (addCount > 0) Text("+$addCount", style = TTFonts.caption, color = ChatCardTokens.diffAddText())
                if (removeCount > 0) Text("-$removeCount", style = TTFonts.caption, color = ChatCardTokens.diffRemoveText())
            }
        },
    ) {
        if (previewLines.isNotEmpty()) {
            SelectionContainer {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(ChatCardTokens.cardPaddingH, ChatCardTokens.cardPaddingV),
                ) {
                    previewLines.forEach { line ->
                        val (bgColor, textColor) = when {
                            line.startsWith("+") && !line.startsWith("+++") ->
                                ChatCardTokens.diffAddBg() to ChatCardTokens.diffAddText()
                            line.startsWith("-") && !line.startsWith("---") ->
                                ChatCardTokens.diffRemoveBg() to ChatCardTokens.diffRemoveText()
                            else -> Color.Transparent to ChatCardTokens.textPrimary()
                        }
                        Text(
                            line,
                            style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                            color = textColor,
                            softWrap = false,
                            modifier = Modifier.fillMaxWidth().background(bgColor),
                        )
                    }
                }
            }
            if (hasMore) {
                Text(
                    stringResource(R.string.chat_card_diff_more, contentLines.size - MAX_PREVIEW_LINES),
                    style = TTFonts.caption,
                    color = ChatCardTokens.textMuted(),
                    modifier = Modifier.padding(horizontal = ChatCardTokens.cardPaddingH, vertical = TTSpacing.xxs),
                )
            }
        }
    }
}
