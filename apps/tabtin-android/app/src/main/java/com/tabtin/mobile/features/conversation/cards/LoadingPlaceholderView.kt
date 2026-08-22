package com.tabtin.mobile.features.conversation.cards

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTSpacing

@Composable
internal fun LoadingPlaceholderView(
    lines: Int = 3,
    lineHeight: Dp = 12.dp,
    modifier: Modifier = Modifier,
) {
    val infiniteTransition = rememberInfiniteTransition(label = "pulse")
    val alpha by infiniteTransition.animateFloat(
        initialValue = 0.08f,
        targetValue = 0.2f,
        animationSpec = infiniteRepeatable(
            animation = tween(800),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pulseAlpha",
    )
    val bgColor = ChatCardTokens.textMuted().copy(alpha = alpha)

    Column(modifier = modifier) {
        repeat(lines) { i ->
            Box(
                modifier = Modifier
                    .fillMaxWidth(if (i == lines - 1) 0.6f else 1f)
                    .height(lineHeight)
                    .clip(ChatCardTokens.cardRadius)
                    .background(bgColor),
            )
            if (i < lines - 1) Spacer(Modifier.height(TTSpacing.sm))
        }
    }
}
