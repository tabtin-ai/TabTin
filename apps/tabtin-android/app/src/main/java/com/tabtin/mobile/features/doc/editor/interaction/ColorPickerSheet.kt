package com.tabtin.mobile.features.doc.editor.interaction

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.FormatColorReset
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState

public data class ColorOption(val hex: String, val labelRes: Int)

public val TEXT_COLORS: List<ColorOption> = listOf(
    ColorOption("#E03E3E", R.string.doc_color_red),
    ColorOption("#D9730D", R.string.doc_color_orange),
    ColorOption("#DFAB01", R.string.doc_color_yellow),
    ColorOption("#0F7B6C", R.string.doc_color_green),
    ColorOption("#0B6E99", R.string.doc_color_blue),
    ColorOption("#6940A5", R.string.doc_color_purple),
    ColorOption("#AD1A72", R.string.doc_color_pink),
    ColorOption("#787774", R.string.doc_color_gray),
)

public val HIGHLIGHT_COLORS: List<ColorOption> = listOf(
    ColorOption("#FBF3DB", R.string.doc_highlight_yellow),
    ColorOption("#DDEDEA", R.string.doc_highlight_green),
    ColorOption("#D3E5EF", R.string.doc_highlight_blue),
    ColorOption("#F4DFEB", R.string.doc_highlight_pink),
    ColorOption("#E8DEEE", R.string.doc_highlight_purple),
    ColorOption("#FBE4E4", R.string.doc_highlight_red),
    ColorOption("#FADEC9", R.string.doc_highlight_orange),
    ColorOption("#E3E2E0", R.string.doc_highlight_gray),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun TextColorPickerSheet(
    currentColor: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberTTSheetState()
    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        ColorGrid(
            title = stringResource(R.string.doc_text_color_title),
            options = TEXT_COLORS,
            currentColor = currentColor,
            onSelect = onSelect,
            showReset = currentColor.isNotBlank(),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun HighlightPickerSheet(
    currentColor: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberTTSheetState()
    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        ColorGrid(
            title = stringResource(R.string.doc_highlight_title),
            options = HIGHLIGHT_COLORS,
            currentColor = currentColor,
            onSelect = onSelect,
            showReset = currentColor.isNotBlank(),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ColorGrid(
    title: String,
    options: List<ColorOption>,
    currentColor: String,
    onSelect: (String) -> Unit,
    showReset: Boolean,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 32.dp),
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
        )
        HorizontalDivider()
        FlowRow(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (showReset) {
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .clickable { onSelect("") },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.FormatColorReset,
                        contentDescription = stringResource(R.string.doc_color_reset),
                        modifier = Modifier.size(20.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            options.forEach { option ->
                val isCurrent = option.hex.equals(currentColor, ignoreCase = true)
                val color = try { Color(android.graphics.Color.parseColor(option.hex)) } catch (_: Exception) { Color.Gray }
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(color)
                        .then(
                            if (isCurrent) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, CircleShape)
                            else Modifier
                        )
                        .clickable { onSelect(option.hex) },
                    contentAlignment = Alignment.Center,
                ) {
                    if (isCurrent) {
                        Icon(
                            Icons.Filled.Check,
                            contentDescription = null,
                            tint = Color.White,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }
    }
}
