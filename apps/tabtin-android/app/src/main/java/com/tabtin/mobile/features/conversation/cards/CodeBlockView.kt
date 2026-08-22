package com.tabtin.mobile.features.conversation.cards

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Done
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlinx.coroutines.delay

@Composable
internal fun CodeBlockView(
    code: String,
    language: String? = null,
    showLineNumbers: Boolean = true,
    maxLines: Int = 0,
    modifier: Modifier = Modifier,
) {
    val shape = ChatCardTokens.cardRadius
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }

    LaunchedEffect(copied) {
        if (copied) { delay(2000); copied = false }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(ChatCardTokens.bgCode())
            .border(0.5.dp, ChatCardTokens.borderDefault(), shape),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(ChatCardTokens.bgHeader())
                .padding(horizontal = ChatCardTokens.cardPaddingH, vertical = ChatCardTokens.headerPaddingV),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(language ?: "", style = TTFonts.caption, color = ChatCardTokens.textMuted())
            Icon(
                if (copied) Icons.Default.Done else Icons.Default.ContentCopy,
                contentDescription = null,
                modifier = Modifier
                    .size(14.dp)
                    .clickable {
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        cm.setPrimaryClip(ClipData.newPlainText("code", code))
                        copied = true
                    },
                tint = if (copied) ChatCardTokens.textSuccess() else ChatCardTokens.textMuted(),
            )
        }

        val allLines = remember(code) { code.lines() }
        val lines = remember(allLines, maxLines) {
            if (maxLines > 0 && allLines.size > maxLines) allLines.take(maxLines) else allLines
        }
        val truncated = maxLines > 0 && allLines.size > maxLines

        SelectionContainer {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(ChatCardTokens.cardPaddingH, ChatCardTokens.cardPaddingV),
            ) {
                if (showLineNumbers) {
                    val pad = lines.size.toString().length
                    Column(modifier = Modifier.padding(end = TTSpacing.sm)) {
                        lines.forEachIndexed { i, _ ->
                            Text(
                                (i + 1).toString().padStart(pad),
                                style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                                color = ChatCardTokens.textMuted(),
                            )
                        }
                    }
                }
                Column {
                    lines.forEach { line ->
                        Text(
                            line,
                            style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                            color = ChatCardTokens.textPrimary(),
                            softWrap = false,
                        )
                    }
                    if (truncated) {
                        Text(
                            "\u2026 (${code.lines().size - maxLines} more lines)",
                            style = TTFonts.caption,
                            color = ChatCardTokens.textMuted(),
                        )
                    }
                }
            }
        }
    }
}
