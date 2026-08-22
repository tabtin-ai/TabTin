package com.tabtin.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTFonts

private val EMOJI_CATEGORIES = mapOf(
    "表情" to listOf("😀", "😃", "😄", "😁", "😊", "🥰", "😎", "🤩", "🤗", "🤔", "😇", "🙃", "😴", "🤖", "👻", "🎃"),
    "动物" to listOf("🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🦄"),
    "物品" to listOf("💡", "🔧", "🔑", "💎", "🎯", "🚀", "⚡", "🔥", "💫", "⭐", "🌈", "🎨", "📚", "💻", "🎮", "🎵"),
    "手势" to listOf("👍", "👋", "✌️", "🤝", "👊", "✊", "🤞", "💪", "🙏", "👏", "🫡", "🫶", "🤙", "👌", "✋", "🖐️"),
    "食物" to listOf("🍎", "🍕", "🍔", "🌮", "🍣", "🍩", "🎂", "☕", "🍺", "🧋", "🍿", "🧁", "🍪", "🍰", "🥤", "🧀"),
    "自然" to listOf("🌸", "🌺", "🌻", "🌹", "🌿", "🍀", "🌴", "🌊", "☀️", "🌙", "⛅", "❄️", "🌍", "🏔️", "🌵", "🍄"),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun EmojiPickerField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    enabled: Boolean = true,
) {
    var showPicker by remember { mutableStateOf(false) }

    Column {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(8.dp))
                .clickable(enabled = enabled) { showPicker = true }
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (value.isNotBlank()) {
                Text(value, style = TTFonts.iconEmpty)
            } else {
                Text(
                    "点击选择图标",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }

    if (showPicker) {
        TTBottomSheet(
            onDismissRequest = { showPicker = false },
        ) {
            EmojiGrid(
                onSelect = { emoji ->
                    onValueChange(emoji)
                    showPicker = false
                },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EmojiGrid(onSelect: (String) -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        EMOJI_CATEGORIES.forEach { (category, emojis) ->
            Text(
                category,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 8.dp),
            )
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                emojis.forEach { emoji ->
                    Box(
                        modifier = Modifier
                            .size(44.dp)
                            .clip(CircleShape)
                            .clickable { onSelect(emoji) }
                            .background(
                                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(emoji, style = TTFonts.iconFeature, textAlign = TextAlign.Center)
                    }
                }
            }
        }

        Box(Modifier.padding(bottom = 32.dp))
    }
}
