package com.tabtin.mobile.features.files

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.FolderZip
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.Slideshow
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.stringResource
import com.tabtin.mobile.R
import com.tabtin.mobile.features.clouddocs.TabTinAppIcon
import com.tabtin.mobile.features.clouddocs.TabTinAppIconVariant
import com.tabtin.mobile.ui.theme.TTRadius

@Composable
internal fun CloudDriveFolderArtwork(
    size: Dp = 40.dp,
    modifier: Modifier = Modifier,
) {
    val dark = com.tabtin.mobile.ui.theme.LocalTTDarkTheme.current
    val foreground = if (dark) Color(0xFFE3B55E) else Color(0xFFD99A28)
    CloudDriveSemanticArtwork(
        icon = Icons.Filled.Folder,
        foreground = foreground,
        background = foreground.copy(alpha = if (dark) 0.16f else 0.13f),
        size = size,
        modifier = modifier,
    )
}

@Composable
internal fun CloudDriveResourceArtwork(
    category: CloudDriveFileCategory,
    size: Dp = 40.dp,
    modifier: Modifier = Modifier,
) {
    val colors = cloudDriveCategoryColors(category)
    Box(
        modifier = modifier
            .size(size)
            .background(colors.background, RoundedCornerShape(TTRadius.md)),
        contentAlignment = Alignment.Center,
    ) {
        CloudDriveResourceIcon(category = category, size = size * 0.58f)
    }
}

/** 云盘资源裸内容图标：Composer 引用候选与云盘缩略图共用，避免重复套背景。 */
@Composable
internal fun CloudDriveResourceIcon(
    category: CloudDriveFileCategory,
    size: Dp = 22.dp,
    modifier: Modifier = Modifier,
) {
    val colors = cloudDriveCategoryColors(category)
    when (category) {
        CloudDriveFileCategory.CLOUD_DOCUMENT -> TabTinAppIcon(
            appId = "tabdoc",
            variant = TabTinAppIconVariant.GLYPH,
            size = size,
            modifier = modifier,
        )
        CloudDriveFileCategory.CLOUD_TABLE -> TabTinAppIcon(
            appId = "tabdata",
            variant = TabTinAppIconVariant.GLYPH,
            size = size,
            modifier = modifier,
        )
        else -> Icon(
            imageVector = cloudDriveCategoryIcon(category),
            contentDescription = null,
            tint = colors.foreground,
            modifier = modifier.size(size),
        )
    }
}

@Composable
private fun CloudDriveSemanticArtwork(
    icon: ImageVector,
    foreground: Color,
    background: Color,
    size: Dp,
    modifier: Modifier,
) {
    Box(
        modifier = modifier
            .size(size)
            .background(background, RoundedCornerShape(TTRadius.md)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = foreground,
            modifier = Modifier.size(size * 0.55f),
        )
    }
}

private fun cloudDriveCategoryIcon(category: CloudDriveFileCategory): ImageVector = when (category) {
    CloudDriveFileCategory.IMAGE -> Icons.Filled.Image
    CloudDriveFileCategory.PDF -> Icons.Filled.PictureAsPdf
    CloudDriveFileCategory.DOCUMENT -> Icons.Filled.Description
    CloudDriveFileCategory.SPREADSHEET -> Icons.Filled.TableChart
    CloudDriveFileCategory.PRESENTATION -> Icons.Filled.Slideshow
    CloudDriveFileCategory.TEXT -> Icons.Filled.Code
    CloudDriveFileCategory.AUDIO -> Icons.Filled.MusicNote
    CloudDriveFileCategory.VIDEO -> Icons.Filled.Movie
    CloudDriveFileCategory.ARCHIVE -> Icons.Filled.FolderZip
    CloudDriveFileCategory.GENERIC -> Icons.AutoMirrored.Filled.InsertDriveFile
    CloudDriveFileCategory.CLOUD_DOCUMENT -> Icons.Filled.Description
    CloudDriveFileCategory.CLOUD_TABLE -> Icons.Filled.TableChart
}

@Composable
internal fun cloudDriveCategoryLabel(category: CloudDriveFileCategory): String = stringResource(
    when (category) {
        CloudDriveFileCategory.CLOUD_DOCUMENT -> R.string.cloud_drive_redesign_type_cloud_doc
        CloudDriveFileCategory.CLOUD_TABLE -> R.string.cloud_drive_redesign_type_cloud_table
        CloudDriveFileCategory.IMAGE -> R.string.cloud_drive_redesign_type_image
        CloudDriveFileCategory.PDF -> R.string.cloud_drive_redesign_type_pdf
        CloudDriveFileCategory.DOCUMENT -> R.string.cloud_drive_redesign_type_document
        CloudDriveFileCategory.SPREADSHEET -> R.string.cloud_drive_redesign_type_spreadsheet
        CloudDriveFileCategory.PRESENTATION -> R.string.cloud_drive_redesign_type_presentation
        CloudDriveFileCategory.TEXT -> R.string.cloud_drive_redesign_type_text
        CloudDriveFileCategory.AUDIO -> R.string.cloud_drive_redesign_type_audio
        CloudDriveFileCategory.VIDEO -> R.string.cloud_drive_redesign_type_video
        CloudDriveFileCategory.ARCHIVE -> R.string.cloud_drive_redesign_type_archive
        CloudDriveFileCategory.GENERIC -> R.string.cloud_drive_redesign_type_generic
    },
)
