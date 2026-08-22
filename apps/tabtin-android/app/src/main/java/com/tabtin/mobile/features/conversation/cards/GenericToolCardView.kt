package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.features.conversation.ToolRowPresentation
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import org.json.JSONArray
import org.json.JSONObject

@Composable
internal fun GenericToolCardView(step: AgentStep) {
    val header = stringResource(ToolRowPresentation.of(step.name).labelResId)

    ToolCardContainer(
        header = {
            Text(
                header,
                style = TTFonts.captionSemibold,
                color = ChatCardTokens.textPrimary(),
                modifier = Modifier.weight(1f),
            )
        },
    ) {
        step.output?.takeIf { it.isNotBlank() }?.let { RenderJsonContent(it) }
        if (step.output.isNullOrBlank() && !step.input.isNullOrBlank()) {
            RenderJsonContent(step.input)
        }
    }
}

private sealed class ParsedContent {
    data class Obj(val json: JSONObject) : ParsedContent()
    data class ObjArray(val items: List<JSONObject>, val total: Int) : ParsedContent()
    data class Raw(val text: String) : ParsedContent()
}

private fun parseContent(raw: String): ParsedContent {
    val trimmed = raw.trim()
    return try {
        when {
            trimmed.startsWith("{") -> ParsedContent.Obj(JSONObject(trimmed))
            trimmed.startsWith("[") -> {
                val arr = JSONArray(trimmed)
                val items = (0 until arr.length().coerceAtMost(10)).mapNotNull { arr.optJSONObject(it) }
                if (items.isNotEmpty()) ParsedContent.ObjArray(items, arr.length())
                else ParsedContent.Raw(trimmed)
            }
            else -> ParsedContent.Raw(trimmed)
        }
    } catch (_: Exception) {
        ParsedContent.Raw(trimmed)
    }
}

@Composable
internal fun RenderJsonContent(raw: String) {
    val parsed = remember(raw) { parseContent(raw) }
    when (parsed) {
        is ParsedContent.Obj -> KeyValuePairsView(parsed.json)
        is ParsedContent.ObjArray -> {
            parsed.items.forEachIndexed { i, obj ->
                KeyValuePairsView(obj)
                if (i < parsed.items.size - 1) Spacer(Modifier.height(TTSpacing.xs))
            }
            if (parsed.total > parsed.items.size) {
                Text(
                    stringResource(R.string.chat_card_more_items, parsed.total - parsed.items.size),
                    style = TTFonts.caption,
                    color = ChatCardTokens.textMuted(),
                )
            }
        }
        is ParsedContent.Raw -> RawTextView(parsed.text)
    }
}

@Composable
internal fun KeyValuePairsView(obj: JSONObject) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs)) {
        for (key in obj.keys()) {
            Row {
                Text(
                    fieldLabel(key),
                    style = TTFonts.captionSemibold,
                    color = ChatCardTokens.textSecondary(),
                    modifier = Modifier.width(100.dp),
                )
                Spacer(Modifier.width(TTSpacing.xs))
                Text(
                    formatValue(obj.opt(key)),
                    style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                    color = ChatCardTokens.textPrimary(),
                    maxLines = 5,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun fieldLabel(key: String): String {
    val resId = ToolRowPresentation.cardFieldLabelResId(key)
    return if (resId != null) stringResource(resId) else key
}

@Composable
internal fun RawTextView(text: String) {
    SelectionContainer {
        Text(
            text.take(2000),
            style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
            color = ChatCardTokens.textPrimary(),
        )
    }
}

private fun formatValue(v: Any?): String = when (v) {
    null, JSONObject.NULL -> "—"
    is String -> v.take(200)
    is JSONObject -> v.toString(2).take(200)
    is JSONArray -> v.toString(2).take(200)
    else -> v.toString()
}
