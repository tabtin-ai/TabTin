package com.tabtin.mobile.ui.components

import androidx.compose.foundation.background
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.drawable.toBitmap
import coil.imageLoader
import coil.memory.MemoryCache
import coil.request.ImageRequest
import coil.request.SuccessResult
import com.tabtin.mobile.ui.theme.IdentityAvatar

public sealed interface IdentityAvatarImagePresentation {
    public data object Image : IdentityAvatarImagePresentation
    public data object Loading : IdentityAvatarImagePresentation
    public data object Fallback : IdentityAvatarImagePresentation

    public companion object {
        public fun mode(
            hasRemoteImage: Boolean,
            hasCachedImage: Boolean,
            didFail: Boolean,
        ): IdentityAvatarImagePresentation = when {
            !hasRemoteImage -> Fallback
            hasCachedImage -> Image
            didFail -> Fallback
            else -> Loading
        }
    }
}

internal fun identityAvatarMemoryCacheKey(imageUrl: String, sizePx: Int): String =
    "identity-avatar:$sizePx:$imageUrl"

internal fun identityAvatarImageRequest(
    context: android.content.Context,
    imageUrl: String,
    sizePx: Int,
): ImageRequest = ImageRequest.Builder(context)
    .data(imageUrl)
    .size(sizePx)
    .allowHardware(false)
    .memoryCacheKey(identityAvatarMemoryCacheKey(imageUrl, sizePx))
    .diskCacheKey(imageUrl)
    .build()

/**
 * 对齐 Electron `ColorAvatar`：真实头像优先；否则按 [seed] 生成平台统一彩色首字头像。
 * Agent 也走 [IdentityAvatar] 哈希色（与 Electron IM 固定 agent 色不同，按产品要求）。
 */
@Composable
public fun IdentityColorAvatar(
    name: String,
    seed: String? = null,
    imageUrl: String? = null,
    size: Dp = 40.dp,
    group: Boolean = false,
    channel: Boolean = false,
    fallbackIcon: ImageVector? = when {
        channel -> Icons.Default.Tag
        group -> Icons.Default.Group
        else -> null
    },
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val imageLoader = context.imageLoader
    val sizePx = with(LocalDensity.current) { size.roundToPx() }.coerceAtLeast(1)
    val identity = seed?.takeIf { it.isNotBlank() } ?: name.ifBlank { "?" }
    val background = IdentityAvatar.color(identity)
    val initial = IdentityAvatar.initial(name)
    val normalizedImageUrl = imageUrl?.trim()?.takeIf { it.isNotEmpty() }
    val cacheKey = remember(normalizedImageUrl, sizePx) {
        normalizedImageUrl?.let { identityAvatarMemoryCacheKey(it, sizePx) }
    }
    val initialBitmap = remember(cacheKey) {
        cacheKey?.let { imageLoader.memoryCache?.get(MemoryCache.Key(it))?.bitmap }
    }
    var loadedBitmap by remember(cacheKey) { mutableStateOf<Bitmap?>(initialBitmap) }
    var imageFailed by remember(cacheKey) { mutableStateOf(false) }
    val presentation = IdentityAvatarImagePresentation.mode(
        hasRemoteImage = normalizedImageUrl != null,
        hasCachedImage = loadedBitmap != null,
        didFail = imageFailed,
    )

    LaunchedEffect(normalizedImageUrl, sizePx) {
        if (normalizedImageUrl == null) {
            loadedBitmap = null
            imageFailed = false
            return@LaunchedEffect
        }
        cacheKey?.let { key ->
            imageLoader.memoryCache?.get(MemoryCache.Key(key))?.bitmap?.let { cached ->
                loadedBitmap = cached
                imageFailed = false
                return@LaunchedEffect
            }
        }
        loadedBitmap = null
        imageFailed = false
        when (val result = imageLoader.execute(identityAvatarImageRequest(context, normalizedImageUrl, sizePx))) {
            is SuccessResult -> loadedBitmap = result.drawable.toBitmap()
            else -> imageFailed = true
        }
    }

    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(background),
        contentAlignment = Alignment.Center,
    ) {
        if (presentation == IdentityAvatarImagePresentation.Image && loadedBitmap != null) {
            Image(
                bitmap = loadedBitmap!!.asImageBitmap(),
                contentDescription = name,
                modifier = Modifier.size(size).clip(CircleShape),
                contentScale = ContentScale.Crop,
            )
        } else if (presentation == IdentityAvatarImagePresentation.Fallback && fallbackIcon != null) {
            Icon(
                imageVector = fallbackIcon,
                contentDescription = null,
                tint = Color.White,
                modifier = Modifier.size(size * 0.45f),
            )
        } else if (presentation == IdentityAvatarImagePresentation.Fallback) {
            Text(
                text = initial,
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                fontSize = (size.value * 0.38f).sp,
            )
        }
    }
}
