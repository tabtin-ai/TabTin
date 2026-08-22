package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Code
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

@Composable
internal fun CodeSearchCardView(step: AgentStep) {
    val input = remember(step.input) { parseJson(step.input) }
    val pattern = input?.optString("pattern").takeIf { !it.isNullOrEmpty() }
        ?: input?.optString("query").orEmpty()
    val matches = remember(step.output) { parseCodeMatches(step.output) }

    ToolCardContainer(
        header = {
            Icon(Icons.Default.Code, null, modifier = Modifier.size(ChatCardTokens.iconSize), tint = ChatCardTokens.textMuted())
            Spacer(Modifier.width(TTSpacing.xs))
            Text(pattern.take(40), style = TTFonts.captionSemibold, color = ChatCardTokens.textPrimary(), modifier = Modifier.weight(1f))
            if (matches.isNotEmpty()) {
                Text(stringResource(R.string.chat_card_matches, matches.size), style = TTFonts.caption, color = ChatCardTokens.textMuted())
            }
        },
    ) {
        Column(
            modifier = Modifier
                .heightIn(max = ChatCardTokens.maxHeightLg)
                .padding(ChatCardTokens.cardPaddingH, ChatCardTokens.cardPaddingV),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            matches.take(10).forEachIndexed { i, m ->
                Column {
                    Text(m.file.substringAfterLast("/"), style = TTFonts.captionSemibold, color = ChatCardTokens.textAccent())
                    Text(m.file, style = TTFonts.caption, color = ChatCardTokens.textMuted(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (m.line.isNotBlank()) {
                        SelectionContainer {
                            Text(m.line.trim(), style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace), color = ChatCardTokens.textPrimary(), maxLines = 3)
                        }
                    }
                }
                if (i < matches.size - 1) HorizontalDivider(color = ChatCardTokens.borderDefault())
            }
        }
    }
}

private data class CodeMatch(val file: String, val line: String, val lineNumber: Int)

private fun parseCodeMatches(raw: String?): List<CodeMatch> {
    val arr = parseJsonArray(raw, "matches", "results") ?: return emptyList()
    return try {
        (0 until arr.length()).mapNotNull { i ->
            val obj = arr.optJSONObject(i) ?: return@mapNotNull null
            CodeMatch(
                file = obj.optString("file", obj.optString("path", "")),
                line = obj.optString("line", obj.optString("content", obj.optString("match", ""))),
                lineNumber = obj.optInt("line_number", obj.optInt("lineNumber", 0)),
            )
        }
    } catch (_: Exception) { emptyList() }
}
