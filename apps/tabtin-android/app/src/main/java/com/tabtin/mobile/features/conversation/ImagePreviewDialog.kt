package com.tabtin.mobile.features.conversation

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import coil.imageLoader
import coil.request.ImageRequest
import coil.request.SuccessResult
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun ImagePreviewDialog(
    imageUrl: String,
    filename: String?,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var containerSize by remember { mutableStateOf(IntSize.Zero) }

    val transformState = rememberTransformableState { zoomChange, panChange, _ ->
        scale = (scale * zoomChange).coerceIn(0.5f, 5f)
        offset = if (scale > 1f) {
            val maxX = containerSize.width * (scale - 1f) / 2f
            val maxY = containerSize.height * (scale - 1f) / 2f
            Offset(
                (offset.x + panChange.x).coerceIn(-maxX, maxX),
                (offset.y + panChange.y).coerceIn(-maxY, maxY),
            )
        } else {
            Offset.Zero
        }
    }

    LaunchedEffect(transformState.isTransformInProgress) {
        if (!transformState.isTransformInProgress && scale < 1f) {
            animate(
                initialValue = scale,
                targetValue = 1f,
                animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
            ) { value, _ ->
                scale = value
            }
            offset = Offset.Zero
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(TTColors.FullscreenBackground)
                .statusBarsPadding(),
        ) {
            AsyncImage(
                model = ImageRequest.Builder(context)
                    .data(imageUrl)
                    .crossfade(true)
                    .build(),
                contentDescription = filename ?: stringResource(R.string.chat_image_preview),
                modifier = Modifier
                    .fillMaxSize()
                    .onSizeChanged { containerSize = it }
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    }
                    .transformable(state = transformState)
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onDoubleTap = {
                                if (scale > 1.1f) {
                                    scale = 1f
                                    offset = Offset.Zero
                                } else {
                                    scale = 2.5f
                                    offset = Offset.Zero
                                }
                            },
                        )
                    },
                contentScale = ContentScale.Fit,
            )

            TopAppBar(
                title = { },
                navigationIcon = {
                    IconButton(onClick = onDismiss) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_close),
                            tint = TTColors.FullscreenForeground,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = {
                        scope.launch { saveImageToGallery(context, imageUrl, filename) }
                    }) {
                        Icon(Icons.Default.Download, contentDescription = stringResource(R.string.common_save), tint = TTColors.FullscreenForeground)
                    }
                    IconButton(onClick = { shareImageUrl(context, imageUrl) }) {
                        Icon(Icons.Default.Share, contentDescription = stringResource(R.string.common_share), tint = TTColors.FullscreenForeground)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = androidx.compose.ui.graphics.Color.Transparent,
                ),
            )
        }
    }
}

private fun shareImageUrl(context: Context, url: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, url)
    }
    context.startActivity(Intent.createChooser(intent, context.getString(R.string.chat_share_image)))
}

private suspend fun saveImageToGallery(context: Context, url: String, filename: String?) {
    try {
        val result = withContext(Dispatchers.IO) {
            val request = ImageRequest.Builder(context).data(url).build()
            context.imageLoader.execute(request)
        }
        if (result !is SuccessResult) {
            withContext(Dispatchers.Main) { Toast.makeText(context, context.getString(R.string.error_image_load_failed), Toast.LENGTH_SHORT).show() }
            return
        }

        val bitmap = (result.drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap
        if (bitmap == null) {
            withContext(Dispatchers.Main) { Toast.makeText(context, context.getString(R.string.error_image_format_unsupported), Toast.LENGTH_SHORT).show() }
            return
        }

        val savedUri = withContext(Dispatchers.IO) { saveBitmapToMediaStore(context, bitmap, filename) }
        withContext(Dispatchers.Main) {
            if (savedUri != null) {
                Toast.makeText(context, context.getString(R.string.chat_saved_to_album), Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(context, context.getString(R.string.error_save_failed), Toast.LENGTH_SHORT).show()
            }
        }
    } catch (e: Exception) {
        withContext(Dispatchers.Main) { Toast.makeText(context, context.getString(R.string.error_save_failed_detail, e.message ?: ""), Toast.LENGTH_SHORT).show() }
    }
}

private fun saveBitmapToMediaStore(context: Context, bitmap: Bitmap, filename: String?): Uri? {
    val ext = filename?.substringAfterLast('.', "")?.lowercase()
    val (format, mime, quality) = when (ext) {
        "png" -> Triple(Bitmap.CompressFormat.PNG, "image/png", 100)
        "webp" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Triple(Bitmap.CompressFormat.WEBP_LOSSLESS, "image/webp", 100)
        } else {
            @Suppress("DEPRECATION")
            Triple(Bitmap.CompressFormat.WEBP, "image/webp", 95)
        }
        else -> Triple(Bitmap.CompressFormat.JPEG, "image/jpeg", 95)
    }

    val name = filename ?: "TabTin_${System.currentTimeMillis()}.jpg"
    val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, name)
        put(MediaStore.Images.Media.MIME_TYPE, mime)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/TabTin")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
    }

    val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null

    val outputStream = context.contentResolver.openOutputStream(uri)
    if (outputStream == null) {
        context.contentResolver.delete(uri, null, null)
        return null
    }
    try {
        outputStream.use { out ->
            if (!bitmap.compress(format, quality, out)) {
                context.contentResolver.delete(uri, null, null)
                return null
            }
        }
    } catch (_: Exception) {
        context.contentResolver.delete(uri, null, null)
        return null
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        values.clear()
        values.put(MediaStore.Images.Media.IS_PENDING, 0)
        context.contentResolver.update(uri, values, null, null)
    }

    return uri
}
