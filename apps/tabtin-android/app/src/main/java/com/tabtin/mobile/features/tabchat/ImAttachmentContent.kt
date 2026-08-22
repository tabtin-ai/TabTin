package com.tabtin.mobile.features.tabchat

import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.DrawableContainer
import android.graphics.drawable.LayerDrawable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.SubcomposeAsyncImage
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ImAttachmentUrl
import com.tabtin.mobile.data.im.ImMessage
import com.tabtin.mobile.features.conversation.ChatFilePreviewDialog
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlinx.coroutines.withTimeout

/**
 * 图片 / 文件消息主体（Phase D）：进入视图时懒加载预签下载 URL（不落库，现换现用）。
 * image → 缩略图，点开全屏查看；file → 文件卡片，点击在 App 内预览。
 *
 * [loadAttachment] 由会话屏注入（先按消息主键，失败后按 file_id 经 OSS 权限接口换链），
 * 失败返回 null → 展示占位，不阻塞其余消息。
 */
@Composable
internal fun ImAttachmentContent(
    message: ImMessage,
    isMine: Boolean,
    loadAttachment: suspend (message: ImMessage) -> ImAttachmentUrl?,
) {
    val cacheKey = remember(message) { message.attachmentCacheKey() }
    var attachment by remember(cacheKey) {
        mutableStateOf(ImAttachmentUrlMemoryCache.get(cacheKey) ?: message.inlineAttachmentUrl())
    }
    var loadFailed by remember(message.id) { mutableStateOf(false) }
    var lookupNonce by remember(cacheKey) { mutableStateOf(0) }
    var attemptedLookupAfterImageFailure by remember(cacheKey) { mutableStateOf(false) }

    LaunchedEffect(cacheKey, lookupNonce) {
        if ((attachment == null || lookupNonce > 0) && !loadFailed) {
            val result = runCatching {
                withTimeout(ImAttachmentUrlLoadTimeoutMs) {
                    loadAttachment(message)
                }
            }.getOrNull()
            if (result != null && result.displayUrls.isNotEmpty()) {
                ImAttachmentUrlMemoryCache.put(cacheKey, result)
                attachment = result
            } else {
                loadFailed = true
            }
        }
    }

    if (message.isImageAttachment) {
        ImImageAttachment(
            cacheKey = cacheKey,
            urls = attachment?.displayUrls.orEmpty(),
            loadFailed = loadFailed,
            stateVersion = lookupNonce,
            onAllUrlsFailed = {
                if (
                    !attemptedLookupAfterImageFailure &&
                    (message.attachmentLookupMessageId != null || message.attachmentFileId != null)
                ) {
                    attemptedLookupAfterImageFailure = true
                    ImAttachmentUrlMemoryCache.remove(cacheKey)
                    attachment = null
                    loadFailed = false
                    lookupNonce += 1
                } else {
                    loadFailed = true
                }
            },
        )
    } else {
        ImFileAttachment(message = message, attachment = attachment, loadFailed = loadFailed, isMine = isMine)
    }
}

private object ImAttachmentUrlMemoryCache {
    private const val MAX_ENTRIES = 128
    private val values = LinkedHashMap<String, ImAttachmentUrl>(MAX_ENTRIES, 0.75f, true)

    fun get(key: String): ImAttachmentUrl? = values[key]

    fun remove(key: String) {
        values.remove(key)
    }

    fun put(key: String, value: ImAttachmentUrl) {
        if (key.isBlank()) return
        values[key] = value
        while (values.size > MAX_ENTRIES) {
            val first = values.keys.firstOrNull() ?: break
            values.remove(first)
        }
    }
}

private object ImAttachmentAspectRatioMemoryCache {
    private const val MAX_ENTRIES = 128
    private val values = LinkedHashMap<String, Float>(MAX_ENTRIES, 0.75f, true)

    fun get(key: String): Float? = values[key]

    fun put(key: String, value: Float) {
        if (key.isBlank() || !value.isFinite() || value <= 0f) return
        values[key] = value
        while (values.size > MAX_ENTRIES) {
            val first = values.keys.firstOrNull() ?: break
            values.remove(first)
        }
    }
}

private fun ImMessage.attachmentCacheKey(): String =
    listOf(conversationId, attachmentLookupMessageId?.toString(), attachmentFileId, id.toString())
        .firstNotBlankKey()

private fun List<String?>.firstNotBlankKey(): String {
    val conversationId = getOrNull(0).orEmpty()
    val stableId = drop(1).firstOrNull { !it.isNullOrBlank() }.orEmpty()
    return "$conversationId:$stableId"
}

private fun ImMessage.inlineAttachmentUrl(): ImAttachmentUrl? {
    val urls = metadata?.inlineAttachmentUrls.orEmpty()
    if (urls.isEmpty()) return null
    return ImAttachmentUrl(
        downloadUrl = urls.first(),
        fileName = attachmentFileName,
        candidateUrls = urls.drop(1),
    )
}

private val ImAttachmentMaxSide = 220.dp
private val ImAttachmentDefaultPortraitRatio = 9f / 19.5f
private val ImAttachmentUrlLoadingSide = 72.dp
private val ImAttachmentFailedSide = 88.dp
private const val ImAttachmentUrlLoadTimeoutMs = 12_000L

@Composable
private fun ImImageAttachment(
    cacheKey: String,
    urls: List<String>,
    loadFailed: Boolean,
    stateVersion: Int,
    onAllUrlsFailed: () -> Unit,
) {
    var showFull by remember { mutableStateOf(false) }
    var selectedIndex by remember(urls, stateVersion) { mutableStateOf(0) }
    var imageLoadFailed by remember(urls, stateVersion) { mutableStateOf(false) }
    var imageLoaded by remember(urls, stateVersion) { mutableStateOf(false) }
    var imageAspectRatio by remember(cacheKey, urls, stateVersion) {
        mutableStateOf(ImAttachmentAspectRatioMemoryCache.get(cacheKey))
    }
    val url = urls.getOrNull(selectedIndex)
    val shape = RoundedCornerShape(12.dp)
    val imageModifier = if (loadFailed || imageLoadFailed) {
        Modifier.size(ImAttachmentFailedSide)
    } else {
        imageAspectRatio
            ?.takeIf { it.isFinite() && it > 0f }
            ?.let { ratio ->
                Modifier.imImageAttachmentSize(ratio)
            }
            ?: if (url == null) {
                Modifier.size(ImAttachmentUrlLoadingSide)
            } else {
                // 有图片 URL 后不要用方形小框启动 Coil：部分 Android drawable 不暴露 intrinsic size，
                // 会让已加载的手机截图永远停在小方块里。先按常见截图比例占位，成功后能取到真实比例再重排。
                Modifier.imImageAttachmentSize(ImAttachmentDefaultPortraitRatio)
            }
    }

    LaunchedEffect(url, stateVersion) {
        imageLoadFailed = false
        imageLoaded = false
        imageAspectRatio = ImAttachmentAspectRatioMemoryCache.get(cacheKey)
    }

    Box(
        modifier = Modifier
            .then(imageModifier)
            .clip(shape)
            .then(
                if (!imageLoaded || loadFailed || imageLoadFailed) {
                    Modifier.background(MaterialTheme.colorScheme.surfaceVariant)
                } else {
                    Modifier
                },
            )
            .then(if (url != null) Modifier.clickable { showFull = true } else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        when {
            loadFailed || imageLoadFailed -> Icon(
                Icons.Default.BrokenImage,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            url != null -> SubcomposeAsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
                loading = {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(
                            modifier = Modifier.requiredSize(18.dp),
                            strokeWidth = 2.dp,
                        )
                    }
                },
                onSuccess = { state ->
                    val resolvedRatio = state.painter.intrinsicAspectRatioOrNull()
                        ?: state.result.drawable.intrinsicAspectRatioOrNull()
                        ?: imageAspectRatio
                    resolvedRatio?.let { ratio ->
                        imageAspectRatio = ratio
                        ImAttachmentAspectRatioMemoryCache.put(cacheKey, ratio)
                    }
                    imageLoaded = true
                    imageLoadFailed = false
                },
                onError = {
                    if (selectedIndex < urls.lastIndex) {
                        selectedIndex += 1
                    } else {
                        imageLoadFailed = true
                        onAllUrlsFailed()
                    }
                },
                error = {
                    Icon(
                        Icons.Default.BrokenImage,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
            )
            else -> CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
            )
        }
    }

    if (showFull && url != null) {
        ImFullImageDialog(url = url, onDismiss = { showFull = false })
    }
}

private fun Modifier.imImageAttachmentSize(ratio: Float): Modifier =
    if (ratio >= 1f) {
        size(width = ImAttachmentMaxSide, height = ImAttachmentMaxSide / ratio)
    } else {
        size(width = ImAttachmentMaxSide * ratio, height = ImAttachmentMaxSide)
    }

private fun androidx.compose.ui.graphics.painter.Painter.intrinsicAspectRatioOrNull(): Float? {
    val size = intrinsicSize
    return if (size.isSpecified && size.width > 0f && size.height > 0f) {
        size.width / size.height
    } else {
        null
    }
}

private fun Drawable.intrinsicAspectRatioOrNull(): Float? {
    if (intrinsicWidth > 0 && intrinsicHeight > 0) return intrinsicWidth.toFloat() / intrinsicHeight.toFloat()
    if (this is BitmapDrawable && bitmap.width > 0 && bitmap.height > 0) {
        return bitmap.width.toFloat() / bitmap.height.toFloat()
    }
    if (this is LayerDrawable) {
        for (index in 0 until numberOfLayers) {
            getDrawable(index).intrinsicAspectRatioOrNull()?.let { return it }
        }
    }
    if (this is DrawableContainer) {
        current.intrinsicAspectRatioOrNull()?.let { return it }
    }
    return null
}

@Composable
private fun ImFileAttachment(
    message: ImMessage,
    attachment: ImAttachmentUrl?,
    loadFailed: Boolean,
    @Suppress("UNUSED_PARAMETER") isMine: Boolean,
) {
    val context = LocalContext.current
    var previewUrl by remember { mutableStateOf<String?>(null) }
    val codexCard = message.codexSessionCard
    val fileName = message.attachmentFileName.ifEmpty { attachment?.fileName?.ifEmpty { null } }
        ?: stringResource(R.string.im_attachment_default_name)
    val style = remember(fileName, loadFailed) {
        ImFileCardStyles.styleFor(fileName, unavailable = loadFailed)
    }
    val sizeLabel = (message.attachmentFileSize ?: 0).takeIf { it > 0 }?.let {
        android.text.format.Formatter.formatShortFileSize(context, it.toLong())
    }
    val subtitle = when {
        loadFailed -> stringResource(R.string.im_attachment_unavailable)
        codexCard != null -> listOfNotNull("Codex 会话", sizeLabel, "ZIP").joinToString(" · ")
        sizeLabel != null -> sizeLabel
        else -> ""
    }
    val downloadUrl = attachment?.displayUrls?.firstOrNull()
    val canOpen = downloadUrl != null && !loadFailed
    val isLoading = attachment == null && !loadFailed
    val shape = RoundedCornerShape(ImFileCardStyles.CardCornerRadiusDp.dp)
    val openPreview = {
        if (downloadUrl != null) previewUrl = downloadUrl
    }

    Row(
        modifier = Modifier
            .widthIn(max = ImFileCardStyles.CardMaxWidthDp.dp)
            .heightIn(min = ImFileCardStyles.CardMinHeightDp.dp)
            .clip(shape)
            .background(style.background)
            .then(if (canOpen) Modifier.clickable(onClick = openPreview) else Modifier)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = codexCard?.sessionName ?: fileName,
                color = Color.White,
                fontSize = 13.5.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 18.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle.isNotEmpty()) {
                Text(
                    text = subtitle,
                    color = Color.White.copy(alpha = 0.72f),
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            codexCard?.suggestedWorkingDirectory?.let { workingDirectory ->
                Text(
                    text = "建议工作目录：$workingDirectory",
                    color = Color.White.copy(alpha = 0.68f),
                    fontSize = 10.5.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Column(
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = if (codexCard == null) style.badge else "CODEX",
                color = Color.White.copy(alpha = 0.92f),
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.4.sp,
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(Color.Black.copy(alpha = 0.16f))
                    .padding(horizontal = 7.dp, vertical = 3.dp),
            )
            when {
                loadFailed -> Unit
                isLoading -> Box(
                    modifier = Modifier.size(ImFileCardStyles.ActionSizeDp.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = Color.White,
                    )
                }
                canOpen -> Box(
                    modifier = Modifier
                        .size(ImFileCardStyles.ActionSizeDp.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color.White.copy(alpha = 0.22f))
                        .clickable(onClick = openPreview),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Default.Download,
                        contentDescription = stringResource(R.string.im_attachment_open_a11y),
                        tint = Color.White,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
    }
    previewUrl?.let { url ->
        ChatFilePreviewDialog(
            fileUrl = url,
            filename = fileName,
            mimeType = null,
            onDismiss = { previewUrl = null },
        )
    }
}

/** 全屏图片查看器：黑底 + 适配屏幕，右上角关闭。 */
@Composable
private fun ImFullImageDialog(url: String, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black),
            contentAlignment = Alignment.Center,
        ) {
            SubcomposeAsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
                loading = { CircularProgressIndicator(color = Color.White) },
                error = {
                    Icon(
                        Icons.Default.BrokenImage,
                        contentDescription = null,
                        tint = Color.White.copy(alpha = 0.6f),
                        modifier = Modifier.size(48.dp),
                    )
                },
            )
            IconButton(
                onClick = onDismiss,
                modifier = Modifier.align(Alignment.TopEnd).padding(TTSpacing.md),
            ) {
                Icon(Icons.Default.Close, contentDescription = null, tint = Color.White)
            }
        }
    }
}
