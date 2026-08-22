package com.tabtin.mobile.features.files

import android.text.format.DateUtils
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.files.CloudDriveCollection
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import java.time.Instant

/** 资源行副标题片段（类型 · 分享人 · 权限 · 位置 · owner），便于单测。 */
internal fun cloudDriveResourceSubtitleParts(row: CloudDriveResourceRow): List<String> {
    val typeLabel = when (row.normalizedType) {
        "tabdoc" -> "文档"
        "tabdata" -> "多维表"
        "tabfiles" -> "文件"
        else -> row.itemType
    }
    return buildList {
        add(typeLabel)
        row.sharedBy?.presentableName?.let { add("来自 $it") }
        CloudDriveResourceRow.formatSharePermission(row.permission)?.let { add(it) }
        row.locationLabel?.takeIf { it.isNotBlank() }?.let { add(it) }
        if (row.sharedBy == null) {
            row.owner?.presentableName?.let { add(it) }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun CloudDriveFolderRow(
    folder: CloudDriveCollection,
    onClick: () -> Unit,
    onMoreClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = onMoreClick,
    modifier: Modifier = Modifier,
) {
    val palette = cloudDriveRedesignPalette()
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 68.dp)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(start = TTSpacing.md, end = TTSpacing.xs, top = TTSpacing.sm, bottom = TTSpacing.sm),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CloudDriveFolderArtwork()
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = folder.name,
                style = TTFonts.bodyMedium,
                color = palette.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = stringResource(R.string.cloud_drive_redesign_folder_count, folder.itemCount),
                style = TTFonts.caption,
                color = palette.textTertiary,
            )
        }
        CloudDriveMoreButton(title = folder.name, onClick = onMoreClick)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun CloudDriveResourceListRow(
    row: CloudDriveResourceRow,
    onClick: () -> Unit,
    onMoreClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = onMoreClick,
    modifier: Modifier = Modifier,
) {
    val palette = cloudDriveRedesignPalette()
    val category = CloudDriveFilePresentation.classify(
        itemType = row.normalizedType,
        fileName = row.displayTitle,
        mimeType = row.mimeType,
    )
    val semanticType = cloudDriveCategoryLabel(category)
    val secondaryParts = buildList {
        add(semanticType)
        cloudDriveResourceSubtitleParts(row).drop(1).forEach(::add)
        cloudDriveRelativeTimeLabel(row.updatedAt)?.let(::add)
    }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 68.dp)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(start = TTSpacing.md, end = TTSpacing.xs, top = TTSpacing.sm, bottom = TTSpacing.sm),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CloudDriveResourceArtwork(category = category)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = row.displayTitle,
                style = TTFonts.bodyMedium,
                color = palette.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = secondaryParts.joinToString(" · "),
                style = TTFonts.caption,
                color = palette.textTertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        CloudDriveMoreButton(title = row.displayTitle, onClick = onMoreClick)
    }
}

@Composable
private fun CloudDriveMoreButton(
    title: String,
    onClick: (() -> Unit)?,
) {
    if (onClick == null) return
    val palette = cloudDriveRedesignPalette()
    IconButton(onClick = onClick, modifier = Modifier.size(44.dp)) {
        Icon(
            imageVector = Icons.Filled.MoreVert,
            contentDescription = stringResource(R.string.cloud_drive_redesign_more_actions, title),
            tint = palette.textTertiary,
            modifier = Modifier.size(20.dp),
        )
    }
}

internal fun cloudDriveRelativeTimeLabel(rawTime: String?): String? {
    val timestamp = rawTime?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: return null
    return DateUtils.getRelativeTimeSpanString(
        timestamp,
        System.currentTimeMillis(),
        DateUtils.MINUTE_IN_MILLIS,
        DateUtils.FORMAT_ABBREV_RELATIVE,
    ).toString()
}
