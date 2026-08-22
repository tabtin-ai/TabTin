package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

@Composable
internal fun WebSearchCardView(step: AgentStep) {
    val input = remember(step.input) { parseJson(step.input) }
    val query = input?.optString("query").takeIf { !it.isNullOrEmpty() }
        ?: input?.optString("search_term").orEmpty()
    val results = remember(step.output) { parseSearchResults(step.output) }
    val uriHandler = LocalUriHandler.current

    ToolCardContainer(
        collapsible = true,
        initiallyExpanded = false,
        header = {
            Icon(Icons.Default.Search, null, modifier = Modifier.size(ChatCardTokens.iconSize), tint = ChatCardTokens.textMuted())
            Spacer(Modifier.width(TTSpacing.xs))
            Text(query.take(60), style = TTFonts.captionSemibold, color = ChatCardTokens.textPrimary(), modifier = Modifier.weight(1f))
            if (results.isNotEmpty()) {
                Text(stringResource(R.string.chat_card_results, results.size), style = TTFonts.caption, color = ChatCardTokens.textMuted())
            }
        },
    ) {
        Column(
            modifier = Modifier.padding(ChatCardTokens.cardPaddingH, ChatCardTokens.cardPaddingV),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            results.take(5).forEach { result ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .then(
                            if (result.url.isNotBlank())
                                Modifier.clickable { try { uriHandler.openUri(result.url) } catch (_: Exception) {} }
                            else Modifier,
                        ),
                ) {
                    Text(result.title, style = TTFonts.captionSemibold, color = ChatCardTokens.textAccent(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (result.url.isNotBlank()) {
                        Text(
                            result.url.removePrefix("https://").removePrefix("http://").take(60),
                            style = TTFonts.caption, color = ChatCardTokens.textMuted(), maxLines = 1,
                        )
                    }
                    if (result.snippet.isNotBlank()) {
                        Text(result.snippet, style = TTFonts.caption, color = ChatCardTokens.textSecondary(), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

private data class SearchResult(val title: String, val url: String, val snippet: String)

private fun parseSearchResults(raw: String?): List<SearchResult> {
    val arr = parseJsonArray(raw, "results", "items")
        ?: raw?.trim()?.takeIf { it.startsWith("[") }?.let { org.json.JSONArray(it) }
        ?: return emptyList()
    return try {
        (0 until arr.length()).mapNotNull { i ->
            val obj = arr.optJSONObject(i) ?: return@mapNotNull null
            SearchResult(
                title = obj.optString("title", ""),
                url = obj.optString("url", obj.optString("link", "")),
                snippet = obj.optString("snippet", obj.optString("description", "")),
            )
        }
    } catch (_: Exception) { emptyList() }
}
