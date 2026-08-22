package com.tabtin.mobile.features.memo.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.data.model.memo.MemoColor
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
public fun MemoColorPicker(
    selectedColor: String,
    circleSize: Dp = 28.dp,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val tertiaryColor = ttColor(Color(0xFFB5AFA8), Color(0xFF5C5854))

    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(circleSize)
                .clip(CircleShape)
                .border(1.dp, tertiaryColor, CircleShape)
                .clickable { onSelect("") }
                .semantics { contentDescription = context.getString(MemoColor.NONE.displayNameRes) },
            contentAlignment = Alignment.Center,
        ) {
            if (selectedColor.isEmpty()) {
                Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = null,
                    tint = tertiaryColor,
                    modifier = Modifier.size(circleSize * 0.36f),
                )
            }
        }

        for (mc in MemoColor.selectableCases) {
            val isSelected = selectedColor == mc.rawValue

            Box(
                modifier = Modifier
                    .size(circleSize)
                    .clip(CircleShape)
                    .background(mc.displayColor)
                    .clickable { onSelect(mc.rawValue) }
                    .semantics { contentDescription = context.getString(mc.displayNameRes) },
                contentAlignment = Alignment.Center,
            ) {
                if (isSelected) {
                    Icon(
                        imageVector = Icons.Filled.Check,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(circleSize * 0.36f),
                    )
                }
            }
        }
    }
}
