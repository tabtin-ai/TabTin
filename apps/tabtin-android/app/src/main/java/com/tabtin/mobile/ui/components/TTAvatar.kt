package com.tabtin.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.tabtin.mobile.ui.theme.LocalTTDarkTheme
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.IdentityAvatar
import kotlin.math.absoluteValue

@Composable
public fun TTAvatar(
    name: String,
    imageUrl: String? = null,
    size: Dp = 44.dp,
    shape: Shape = RoundedCornerShape(size * 0.25f),
    fallbackText: String? = null,
    modifier: Modifier = Modifier,
) {
    val isDark = LocalTTDarkTheme.current
    val colorIndex = remember(name) {
        name.fold(0) { acc, c -> acc + c.code }.absoluteValue % 6
    }
    val bgColor = if (isDark) TTColors.Dark.DecorativeBackgrounds[colorIndex]
    else TTColors.DecorativeBackgrounds[colorIndex]
    val textColor = if (isDark) TTColors.Dark.DecorativeTexts[colorIndex]
    else TTColors.DecorativeTexts[colorIndex]

    val textStyle = when {
        size <= 20.dp -> TTFonts.captionSemibold.copy(fontSize = 7.sp, lineHeight = 9.sp)
        size <= 28.dp -> TTFonts.captionSemibold
        size <= 40.dp -> TTFonts.captionSemibold
        else -> TTFonts.bodySemibold
    }

    // 头像图挂了不能留白洞：加载中 / 失败一律回落到首字母块，加载成功才让位给图片。
    // 本机 dev OSS 直链是 127.0.0.1，Android 模拟器 / 真机根本取不到，没有兜底就是一片空白。
    var imageLoaded by remember(imageUrl) { mutableStateOf(false) }
    var imageFailed by remember(imageUrl) { mutableStateOf(false) }
    val showImage = !imageUrl.isNullOrBlank() && !imageFailed

    Box(
        modifier = modifier
            .size(size)
            .clip(shape)
            .background(bgColor),
        contentAlignment = Alignment.Center,
    ) {
        if (!imageLoaded) {
            Text(
                text = fallbackText ?: IdentityAvatar.initials(name),
                style = textStyle,
                color = textColor,
            )
        }
        if (showImage) {
            AsyncImage(
                model = imageUrl,
                contentDescription = name,
                modifier = Modifier.size(size).clip(shape),
                contentScale = ContentScale.Crop,
                onSuccess = { imageLoaded = true },
                onError = { imageFailed = true },
            )
        }
    }
}
