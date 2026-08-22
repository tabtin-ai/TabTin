package com.tabtin.mobile.features.space

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import coil.compose.AsyncImage
import com.tabtin.mobile.R

/**
 * AI 分身身份头像的单一展示入口。
 *
 * 优先序对齐 Electron `extractAgentAvatarUrl`：自定义 URL → 品牌预设 key → TabTin 图标兜底。
 */
@Composable
internal fun AgentIdentityAvatar(
    name: String,
    avatarKey: String?,
    avatarUrl: String?,
    size: Dp,
    modifier: Modifier = Modifier,
) {
    val imageModifier = modifier.size(size).clip(CircleShape)
    val fallback = painterResource(R.drawable.ic_launcher_foreground)
    val preset = AgentAvatarPreset.from(avatarKey)

    when {
        !avatarUrl.isNullOrBlank() -> AsyncImage(
            model = avatarUrl,
            contentDescription = name,
            contentScale = ContentScale.Crop,
            error = fallback,
            fallback = fallback,
            modifier = imageModifier,
        )

        preset != null -> Image(
            painter = painterResource(preset.drawableRes),
            contentDescription = name,
            contentScale = ContentScale.Crop,
            modifier = imageModifier,
        )

        else -> Image(
            painter = fallback,
            contentDescription = name,
            contentScale = ContentScale.Crop,
            modifier = imageModifier,
        )
    }
}
