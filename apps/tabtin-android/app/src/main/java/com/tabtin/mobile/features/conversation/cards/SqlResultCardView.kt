package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import org.json.JSONArray
import org.json.JSONObject

@Composable
internal fun SqlResultCardView(step: AgentStep) {
    val output = remember(step.output) { step.output?.trim() ?: "" }
    val parsed = remember(output) { parseSqlResult(output) }

    ToolCardContainer(
        header = {
            Icon(Icons.Default.Storage, null, modifier = Modifier.size(ChatCardTokens.iconSize), tint = ChatCardTokens.textMuted())
            Spacer(Modifier.width(TTSpacing.xs))
            Text(stringResource(R.string.chat_card_sql_result), style = TTFonts.captionSemibold, color = ChatCardTokens.textPrimary())
            if (parsed != null) {
                Spacer(Modifier.weight(1f))
                Text(stringResource(R.string.chat_card_rows, parsed.totalRows), style = TTFonts.caption, color = ChatCardTokens.textMuted())
            }
        },
    ) {
        if (parsed != null && parsed.headers.isNotEmpty()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = ChatCardTokens.maxHeightLg)
                    .horizontalScroll(rememberScrollState())
                    .padding(ChatCardTokens.cardPaddingH, ChatCardTokens.cardPaddingV),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
                    parsed.headers.forEach { h ->
                        Text(h, style = TTFonts.captionSemibold, color = ChatCardTokens.textSecondary(), modifier = Modifier.width(120.dp))
                    }
                }
                HorizontalDivider(color = ChatCardTokens.borderDefault(), modifier = Modifier.padding(vertical = TTSpacing.xxs))
                parsed.rows.forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
                        row.forEach { cell ->
                            Text(
                                cell, style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                                color = ChatCardTokens.textPrimary(), maxLines = 2,
                                overflow = TextOverflow.Ellipsis, modifier = Modifier.width(120.dp),
                            )
                        }
                    }
                }
                if (parsed.totalRows > parsed.rows.size) {
                    Spacer(Modifier.height(TTSpacing.xs))
                    Text(
                        stringResource(R.string.chat_card_showing_rows, parsed.rows.size, parsed.totalRows),
                        style = TTFonts.caption, color = ChatCardTokens.textMuted(),
                    )
                }
            }
        } else if (output.isNotBlank()) {
            RawTextView(output.take(2000))
        }
    }
}

private data class SqlParsedResult(val headers: List<String>, val rows: List<List<String>>, val totalRows: Int)

private fun parseSqlResult(raw: String): SqlParsedResult? = try {
    when {
        raw.startsWith("[") -> {
            val arr = JSONArray(raw)
            val first = arr.optJSONObject(0)
            if (first != null) {
                val headers = first.keys().asSequence().toList()
                val rows = (0 until arr.length().coerceAtMost(50)).mapNotNull { i ->
                    val obj = arr.optJSONObject(i) ?: return@mapNotNull null
                    headers.map { h -> obj.opt(h)?.toString() ?: "null" }
                }
                if (rows.isEmpty()) null else SqlParsedResult(headers, rows, arr.length())
            } else null
        }
        raw.startsWith("{") -> {
            val obj = JSONObject(raw)
            val data = obj.optJSONArray("rows") ?: obj.optJSONArray("data") ?: obj.optJSONArray("results")
            val total = obj.optInt("total", obj.optInt("count", data?.length() ?: 0))
            val first = data?.optJSONObject(0)
            if (first != null) {
                val headers = first.keys().asSequence().toList()
                val rows = (0 until data.length().coerceAtMost(50)).mapNotNull { i ->
                    val row = data.optJSONObject(i) ?: return@mapNotNull null
                    headers.map { h -> row.opt(h)?.toString() ?: "null" }
                }
                if (rows.isEmpty()) null else SqlParsedResult(headers, rows, total)
            } else null
        }
        else -> null
    }
} catch (_: Exception) { null }
