package com.tabtin.mobile.features.conversation

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Article
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.FolderZip
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Slideshow
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AttachmentStatus
import com.tabtin.mobile.data.model.AttachmentType
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatAttachment
import com.tabtin.mobile.data.oss.UploadConfig
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
internal fun AttachmentPreviewBar(
    attachments: List<ChatAttachment>,
    onRemove: (String) -> Unit,
    onRetry: ((String) -> Unit)? = null,
) {
    LazyRow(
        modifier = Modifier
            .fillMaxWidth()
            .background(ttColor(TTColors.Background, TTColors.Dark.Background))
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        items(attachments, key = { it.id }) { attachment ->
            AttachmentPreviewItem(
                attachment = attachment,
                onRemove = { onRemove(attachment.id) },
                onRetry = if (attachment.status == AttachmentStatus.ERROR) {
                    { onRetry?.invoke(attachment.id) }
                } else null,
            )
        }
    }
}

@Composable
private fun AttachmentPreviewItem(
    attachment: ChatAttachment,
    onRemove: () -> Unit,
    onRetry: (() -> Unit)? = null,
) {
    val removeDescription = stringResource(R.string.common_remove)

    Box(modifier = Modifier.size(72.dp)) {
        Box(
            modifier = Modifier
                .size(64.dp)
                .clip(TTRadius.Shapes.sm)
                .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
                .align(Alignment.BottomStart),
            contentAlignment = Alignment.Center,
        ) {
            if (attachment.type == AttachmentType.IMAGE) {
                AsyncImage(
                    model = attachment.uri,
                    contentDescription = attachment.filename,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop,
                )
            } else {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        Icons.AutoMirrored.Filled.InsertDriveFile,
                        contentDescription = null,
                        modifier = Modifier.size(24.dp),
                        tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                    )
                    Text(
                        text = attachment.filename.substringAfterLast('.', "").uppercase().ifEmpty { "FILE" },
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        maxLines = 1,
                    )
                }
            }

            if (attachment.status == AttachmentStatus.UPLOADING) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(ttColor(TTColors.OverlayBackground, TTColors.Dark.OverlayBackground)),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(
                            progress = { attachment.progress },
                            modifier = Modifier.size(24.dp),
                            strokeWidth = 2.dp,
                            color = ttColor(TTColors.TextOnOverlay, TTColors.Dark.TextOnOverlay),
                        )
                        Text(
                            text = "${(attachment.progress * 100).toInt()}%",
                            style = TTFonts.caption,
                            color = ttColor(TTColors.TextOnOverlay, TTColors.Dark.TextOnOverlay),
                        )
                    }
                }
            }

            if (attachment.status == AttachmentStatus.PENDING) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(ttColor(TTColors.OverlayBackground, TTColors.Dark.OverlayBackground)),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = ttColor(TTColors.TextOnOverlay, TTColors.Dark.TextOnOverlay),
                    )
                }
            }

            if (attachment.status == AttachmentStatus.ERROR) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical).copy(alpha = 0.3f))
                        .clickable { onRetry?.invoke() },
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(
                            Icons.Default.ErrorOutline,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = ttColor(TTColors.TextOnOverlay, TTColors.Dark.TextOnOverlay),
                        )
                        if (onRetry != null) {
                            Text(
                                stringResource(R.string.common_retry),
                                color = ttColor(TTColors.TextOnOverlay, TTColors.Dark.TextOnOverlay),
                                style = TTFonts.caption,
                            )
                        }
                    }
                }
            }
        }

        Box(
            modifier = Modifier
                .size(48.dp)
                .align(Alignment.TopEnd)
                .semantics {
                    contentDescription = removeDescription
                    role = Role.Button
                }
                .clickable(onClick = onRemove),
            contentAlignment = Alignment.TopEnd,
        ) {
            Box(
                modifier = Modifier
                    .size(20.dp)
                    .clip(CircleShape)
                    .background(ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = null,
                    modifier = Modifier.size(12.dp),
                    tint = ttColor(TTColors.TextOnOverlay, TTColors.Dark.TextOnOverlay),
                )
            }
        }
    }
}

@Composable
internal fun MessageAttachments(attachments: List<BlockItem>) {
    val context = LocalContext.current
    var previewImageUrl by remember { mutableStateOf<String?>(null) }
    var previewFilename by remember { mutableStateOf<String?>(null) }
    var previewFile by remember { mutableStateOf<BlockItem?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        attachments.forEach { block ->
            if (block.isImage) {
                AsyncImage(
                    model = block.previewUrl ?: block.url,
                    contentDescription = block.filename,
                    modifier = Modifier
                        .widthIn(max = 200.dp)
                        .clip(TTRadius.Shapes.sm)
                        .clickable {
                            previewImageUrl = block.url
                            previewFilename = block.filename
                        },
                    contentScale = ContentScale.FillWidth,
                )
            } else if (block.isFile) {
                Row(
                    modifier = Modifier
                        .clip(TTRadius.Shapes.sm)
                        .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
                        .clickable {
                            previewFile = block
                        }
                        .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    Icon(
                        fileTypeIcon(block.mimeType, block.filename),
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                        tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = block.filename ?: stringResource(R.string.common_file),
                            style = TTFonts.caption,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        block.size?.let { size ->
                            Text(
                                text = UploadConfig.formatFileSize(size),
                                style = TTFonts.caption,
                                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                            )
                        }
                    }
                    IconButton(
                        onClick = {
                            block.url?.let { url ->
                                val intent = Intent(Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(Intent.EXTRA_TEXT, url)
                                }
                                context.startActivity(Intent.createChooser(intent, context.getString(R.string.chat_share_file)))
                            }
                        },
                        modifier = Modifier.size(32.dp),
                    ) {
                        Icon(
                            Icons.Default.Share,
                            contentDescription = stringResource(R.string.common_share),
                            modifier = Modifier.size(16.dp),
                            tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        )
                    }
                }
            }
        }
    }

    previewImageUrl?.let { url ->
        ImagePreviewDialog(
            imageUrl = url,
            filename = previewFilename,
            onDismiss = { previewImageUrl = null },
        )
    }

    previewFile?.let { block ->
        block.url?.let { url ->
            ChatFilePreviewDialog(
                fileUrl = url,
                filename = block.filename,
                mimeType = block.mimeType,
                onDismiss = { previewFile = null },
            )
        } ?: run {
            previewFile = null
        }
    }
}

internal val BlockItem.isImage: Boolean get() = type == "image" && !url.isNullOrEmpty()
internal val BlockItem.isFile: Boolean get() = type == "file" && !url.isNullOrEmpty()

internal fun fileTypeIcon(mimeType: String?, filename: String?): ImageVector {
    val ext = filename?.substringAfterLast('.', "")?.lowercase()
    return when (UploadConfig.fileCategory(mimeType, ext)) {
        UploadConfig.FileCategory.PDF -> Icons.Default.PictureAsPdf
        UploadConfig.FileCategory.WORD -> Icons.Default.Description
        UploadConfig.FileCategory.EXCEL -> Icons.Default.TableChart
        UploadConfig.FileCategory.PPT -> Icons.Default.Slideshow
        UploadConfig.FileCategory.IMAGE -> Icons.Default.Image
        UploadConfig.FileCategory.AUDIO -> Icons.Default.MusicNote
        UploadConfig.FileCategory.VIDEO -> Icons.Default.Videocam
        UploadConfig.FileCategory.ARCHIVE -> Icons.Default.FolderZip
        UploadConfig.FileCategory.TEXT -> Icons.AutoMirrored.Filled.Article
        UploadConfig.FileCategory.OTHER -> Icons.AutoMirrored.Filled.InsertDriveFile
    }
}
