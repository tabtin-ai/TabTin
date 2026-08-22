package com.tabtin.mobile.features.memo.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.ttColor

@Composable
public fun TagChip(
    text: String,
    isAI: Boolean,
    onRemove: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val bgColor = if (isAI) {
        ttColor(Color(0xFFF2F0EE), Color(0xFF322F2B)) // BgSubtle
    } else {
        ttColor(Color(0xFFE07E29).copy(alpha = 0.1f), Color(0xFFE6944C).copy(alpha = 0.1f)) // Primary opacity 0.1
    }
    val textColor = if (isAI) {
        ttColor(Color(0xFFB5AFA8), Color(0xFF5C5854)) // TextTertiary
    } else {
        ttColor(Color(0xFFE07E29), Color(0xFFE6944C)) // Primary / brand
    }
    val tertiaryColor = ttColor(Color(0xFFB5AFA8), Color(0xFF5C5854))

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(percent = 50))
            .background(bgColor)
            .padding(horizontal = 6.dp, vertical = if (isAI) 2.dp else 3.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = text,
            style = if (isAI) TTFonts.codeXS else TTFonts.codeXS.copy(fontWeight = FontWeight.Medium),
            color = textColor,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
        )
        if (onRemove != null) {
            Icon(
                imageVector = Icons.Filled.Close,
                contentDescription = null,
                tint = tertiaryColor,
                modifier = Modifier
                    .size(12.dp)
                    .clickable(onClick = onRemove)
                    .semantics { contentDescription = "移除标签 $text" },
            )
        }
    }
}
