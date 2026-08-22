package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

@Composable
internal fun ToolCardContainer(
    modifier: Modifier = Modifier,
    bgColor: Color = ChatCardTokens.bgCard(),
    borderColor: Color = ChatCardTokens.borderDefault(),
    collapsible: Boolean = false,
    initiallyExpanded: Boolean = true,
    header: @Composable RowScope.() -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = ChatCardTokens.cardRadius
    var expanded by remember { mutableStateOf(initiallyExpanded) }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(bgColor)
            .border(0.5.dp, borderColor, shape),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(ChatCardTokens.bgHeader())
                .then(if (collapsible) Modifier.clickable { expanded = !expanded } else Modifier)
                .padding(horizontal = ChatCardTokens.cardPaddingH, vertical = ChatCardTokens.headerPaddingV),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            header()
            if (collapsible) {
                Icon(
                    imageVector = if (expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = ChatCardTokens.textMuted(),
                )
            }
        }
        if (!collapsible || expanded) content()
    }
}

internal fun parseJsonArray(raw: String?, vararg keys: String): JSONArray? = try {
    val trimmed = raw?.trim() ?: return null
    when {
        trimmed.startsWith("[") -> JSONArray(trimmed)
        trimmed.startsWith("{") -> {
            val obj = JSONObject(trimmed)
            keys.firstNotNullOfOrNull { obj.optJSONArray(it) }
        }
        else -> null
    }
} catch (_: Exception) { null }
