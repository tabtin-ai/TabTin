package com.tabtin.mobile.features.conversation

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.rememberReduceMotion

/**
 * 胶囊长按上滑双列菜单：左「文字」/ 右「语音」。
 * Reduce Motion（动画时长缩放为 0）时仅淡入，不上滑。
 */
@Composable
internal fun CapsuleActionMenu(
    highlighted: CapsuleMenuSelection?,
    onSelect: (CapsuleMenuSelection) -> Unit,
    modifier: Modifier = Modifier,
) {
    val reduceMotion = rememberReduceMotion()
    var appeared by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { appeared = true }

    val alpha by animateFloatAsState(
        targetValue = if (appeared) 1f else 0f,
        animationSpec = if (reduceMotion) tween(120) else spring(dampingRatio = 0.84f, stiffness = 380f),
        label = "capsuleMenuAlpha",
    )
    val offsetY by animateFloatAsState(
        targetValue = when {
            reduceMotion -> 0f
            appeared -> 0f
            else -> 10f
        },
        animationSpec = spring(dampingRatio = 0.84f, stiffness = 380f),
        label = "capsuleMenuSlide",
    )

    val textLabel = stringResource(R.string.agent_capsule_menu_text)
    val voiceLabel = stringResource(R.string.agent_capsule_menu_voice)
    val textA11y = stringResource(R.string.agent_capsule_menu_text_a11y)
    val voiceA11y = stringResource(R.string.agent_capsule_menu_voice_a11y)

    val shape = RoundedCornerShape(16.dp)
    Row(
        modifier = modifier
            // graphicsLayer 包住 shadow，上滑动画时阴影跟着走
            .graphicsLayer {
                this.alpha = alpha
                translationY = offsetY
            }
            .widthIn(min = 196.dp)
            .height(56.dp)
            // clip=false，避免阴影被裁成方块/错位；外形靠 background(shape)
            .shadow(elevation = 8.dp, shape = shape, clip = false)
            .background(color = MaterialTheme.colorScheme.surface, shape = shape)
            .clip(shape),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MenuColumn(
            label = textLabel,
            a11y = textA11y,
            highlighted = highlighted == CapsuleMenuSelection.TEXT,
            icon = { Icon(Icons.Default.Edit, contentDescription = null, modifier = Modifier.size(18.dp)) },
            onClick = { onSelect(CapsuleMenuSelection.TEXT) },
            modifier = Modifier.weight(1f),
        )
        VerticalDivider(
            modifier = Modifier
                .fillMaxHeight()
                .padding(vertical = TTSpacing.sm),
            color = MaterialTheme.colorScheme.outlineVariant,
        )
        MenuColumn(
            label = voiceLabel,
            a11y = voiceA11y,
            highlighted = highlighted == CapsuleMenuSelection.VOICE,
            icon = { Icon(Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(18.dp)) },
            onClick = { onSelect(CapsuleMenuSelection.VOICE) },
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun MenuColumn(
    label: String,
    a11y: String,
    highlighted: Boolean,
    icon: @Composable () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxHeight()
            .background(
                if (highlighted) MaterialTheme.colorScheme.surfaceVariant
                else MaterialTheme.colorScheme.surface,
            )
            .clickable(onClick = onClick)
            .semantics { contentDescription = a11y }
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(contentAlignment = Alignment.Center) { icon() }
        Box(modifier = Modifier.height(4.dp))
        Text(
            text = label,
            style = TTFonts.captionMedium,
            color = if (highlighted) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurface
            },
            maxLines = 1,
        )
    }
}
