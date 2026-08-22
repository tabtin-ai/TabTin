package com.tabtin.mobile.features.files

import android.text.format.Formatter
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import coil.compose.AsyncImage
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CloudDriveRecentPreviewSheet(
    row: CloudDriveResourceRow,
    onOpen: () -> Unit,
    onDismiss: () -> Unit,
) {
    val palette = cloudDriveRedesignPalette()
    val category = CloudDriveFilePresentation.classify(row.normalizedType, row.displayTitle, row.mimeType)
    val categoryLabel = cloudDriveCategoryLabel(category)
    val context = LocalContext.current
    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(
            skipPartiallyExpanded = false,
            confirmValueChange = { target -> target != SheetValue.Expanded },
        ),
        containerColor = palette.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xxl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CloudDriveResourceArtwork(category = category, size = 44.dp)
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = row.displayTitle,
                        style = TTFonts.subtitleSemibold,
                        color = palette.textPrimary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val meta = buildList {
                        add(categoryLabel)
                        row.fileSizeBytes?.takeIf { it > 0L }?.let { add(Formatter.formatFileSize(context, it)) }
                    }.joinToString(" · ")
                    Text(text = meta, style = TTFonts.meta, color = palette.textTertiary)
                }
            }
            CloudDriveAdaptivePreview(row = row, category = category)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                OutlinedButton(onClick = onDismiss, modifier = Modifier.weight(1f)) {
                    Text(stringResource(R.string.cloud_drive_redesign_later))
                }
                Button(
                    onClick = {
                        onDismiss()
                        onOpen()
                    },
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringResource(R.string.cloud_drive_redesign_continue_open))
                }
            }
        }
    }
}

@Composable
internal fun CloudDriveAdaptivePreview(
    row: CloudDriveResourceRow,
    category: CloudDriveFileCategory,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val palette = cloudDriveRedesignPalette()
    val colors = cloudDriveCategoryColors(category)
    val height = if (compact) 118.dp else 210.dp
    val isLiveImage = category == CloudDriveFileCategory.IMAGE
    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = height)
            .clip(RoundedCornerShape(if (compact) 15.dp else TTRadius.lg))
            .background(colors.background)
            .then(if (isLiveImage) Modifier else Modifier.padding(if (compact) TTSpacing.sm else TTSpacing.md)),
        contentAlignment = Alignment.Center,
    ) {
        when (category) {
            CloudDriveFileCategory.CLOUD_TABLE,
            CloudDriveFileCategory.SPREADSHEET,
            -> CloudDriveTablePreview(row = row, compact = compact)
            CloudDriveFileCategory.IMAGE -> CloudDriveImagePreview(row = row, compact = compact)
            CloudDriveFileCategory.PDF -> CloudDrivePagePreview(
                label = "PDF",
                body = row.preview,
                category = category,
                compact = compact,
            )
            CloudDriveFileCategory.PRESENTATION -> CloudDrivePagePreview(
                label = stringResource(R.string.cloud_drive_redesign_type_presentation),
                body = row.preview,
                category = category,
                compact = compact,
            )
            CloudDriveFileCategory.AUDIO -> CloudDriveAudioPreview(compact = compact)
            CloudDriveFileCategory.VIDEO -> CloudDriveVideoPreview(compact = compact)
            CloudDriveFileCategory.ARCHIVE -> CloudDriveCenteredPreview(
                category = category,
                label = stringResource(R.string.cloud_drive_redesign_preview_archive_hint),
                compact = compact,
            )
            CloudDriveFileCategory.CLOUD_DOCUMENT,
            CloudDriveFileCategory.DOCUMENT,
            CloudDriveFileCategory.TEXT,
            CloudDriveFileCategory.GENERIC,
            -> CloudDrivePagePreview(
                label = cloudDriveCategoryLabel(category),
                body = row.preview,
                category = category,
                compact = compact,
            )
        }
    }
}

@Composable
private fun CloudDrivePagePreview(
    label: String,
    body: String?,
    category: CloudDriveFileCategory,
    compact: Boolean,
) {
    val palette = cloudDriveRedesignPalette()
    val colors = cloudDriveCategoryColors(category)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = if (compact) 98.dp else 182.dp)
            .clip(RoundedCornerShape(TTRadius.sm))
            .background(palette.surface)
            .padding(if (compact) TTSpacing.sm else TTSpacing.lg),
    ) {
        Text(text = label.uppercase(), style = TTFonts.captionSemibold, color = colors.foreground)
        Text(
            text = cloudDriveSafePreviewText(body)
                ?: stringResource(R.string.cloud_drive_redesign_preview_document_empty),
            style = if (compact) TTFonts.caption else TTFonts.body,
            color = palette.textSecondary,
            maxLines = if (compact) 4 else 7,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = TTSpacing.sm),
        )
    }
}

@Composable
private fun CloudDriveTablePreview(row: CloudDriveResourceRow, compact: Boolean) {
    val palette = cloudDriveRedesignPalette()
    val colors = cloudDriveCategoryColors(CloudDriveFileCategory.SPREADSHEET)
    val summary = row.metadata?.get("summary") as? JsonObject ?: row.metadata
    val fields = (summary?.get("field_names") as? JsonArray)
        ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank) }
        .orEmpty()
    val content = cloudDriveTablePreviewContent(fieldNames = fields, preview = row.preview)
    val visibleFields = content.fieldNames.take(if (compact) 2 else 3)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = if (compact) 98.dp else 182.dp)
            .clip(RoundedCornerShape(TTRadius.sm))
            .background(palette.surface)
            .padding(if (compact) TTSpacing.sm else TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        if (!compact) {
            Text(
                text = row.displayTitle,
                style = TTFonts.subtitleSemibold,
                color = palette.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        val headerFields = visibleFields.ifEmpty { listOf("A", "B", "C").take(if (compact) 2 else 3) }
        Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
            headerFields.forEach { field ->
                Text(
                    text = field,
                    style = TTFonts.captionSemibold,
                    color = colors.foreground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .background(colors.background, RoundedCornerShape(TTRadius.xs))
                        .padding(TTSpacing.xs),
                )
            }
        }
        repeat(if (compact) 2 else 4) { index ->
            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                headerFields.forEach { field ->
                    Text(
                        text = if (index == 0 && field == headerFields.first()) {
                            content.previewText
                                ?: stringResource(R.string.cloud_drive_redesign_preview_table_empty)
                        } else {
                            "—"
                        },
                        style = TTFonts.caption,
                        color = palette.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .weight(1f)
                            .padding(TTSpacing.xs),
                    )
                }
            }
        }
    }
}

@Composable
private fun CloudDriveImagePreview(row: CloudDriveResourceRow, compact: Boolean) {
    val previewUrl = rememberCloudFileSignedPreviewUrl(
        organizationId = row.organizationId.orEmpty(),
        contextItemId = row.contextItemId,
        fileRecordId = row.fileRecordId.orEmpty(),
    )
    if (!previewUrl.isNullOrBlank()) {
        AsyncImage(
            model = previewUrl,
            contentDescription = row.displayTitle,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .fillMaxWidth()
                .height(if (compact) 118.dp else 210.dp)
                .fillMaxSize(),
        )
        return
    }
    val colors = cloudDriveCategoryColors(CloudDriveFileCategory.IMAGE)
    val palette = cloudDriveRedesignPalette()
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        CloudDriveResourceArtwork(
            category = CloudDriveFileCategory.IMAGE,
            size = if (compact) 52.dp else 72.dp,
        )
        Text(
            text = stringResource(R.string.cloud_drive_redesign_preview_image_hint),
            style = TTFonts.meta,
            color = palette.textSecondary,
            modifier = Modifier.padding(top = TTSpacing.sm),
        )
        Spacer(
            modifier = Modifier
                .padding(top = TTSpacing.sm)
                .width(if (compact) 68.dp else 108.dp)
                .height(5.dp)
                .clip(CircleShape)
                .background(colors.foreground.copy(alpha = 0.42f)),
        )
    }
}

@Composable
private fun CloudDriveAudioPreview(compact: Boolean) {
    val colors = cloudDriveCategoryColors(CloudDriveFileCategory.AUDIO)
    val palette = cloudDriveRedesignPalette()
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            listOf(12, 25, 38, 18, 31, 44, 23, 35, 16).forEach { barHeight ->
                Box(
                    modifier = Modifier
                        .width(if (compact) 3.dp else 5.dp)
                        .height((if (compact) barHeight * 0.65f else barHeight.toFloat()).dp)
                        .clip(CircleShape)
                        .background(colors.foreground.copy(alpha = 0.74f)),
                )
            }
        }
        Text(
            text = stringResource(R.string.cloud_drive_redesign_preview_audio_hint),
            style = TTFonts.meta,
            color = palette.textSecondary,
            modifier = Modifier.padding(top = TTSpacing.sm),
        )
    }
}

@Composable
private fun CloudDriveVideoPreview(compact: Boolean) {
    val colors = cloudDriveCategoryColors(CloudDriveFileCategory.VIDEO)
    val palette = cloudDriveRedesignPalette()
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(if (compact) 96.dp else 178.dp)
            .clip(RoundedCornerShape(TTRadius.sm))
            .background(palette.textPrimary.copy(alpha = 0.88f)),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(if (compact) 38.dp else 52.dp)
                .clip(CircleShape)
                .background(colors.foreground),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.PlayArrow,
                contentDescription = stringResource(R.string.cloud_drive_redesign_preview_video_hint),
                tint = Color.White,
                modifier = Modifier.size(if (compact) 24.dp else 32.dp),
            )
        }
    }
}

@Composable
private fun CloudDriveCenteredPreview(
    category: CloudDriveFileCategory,
    label: String,
    compact: Boolean,
) {
    val palette = cloudDriveRedesignPalette()
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        CloudDriveResourceArtwork(category = category, size = if (compact) 52.dp else 72.dp)
        Text(
            text = label,
            style = TTFonts.meta,
            color = palette.textSecondary,
            modifier = Modifier.padding(top = TTSpacing.sm),
        )
    }
}
