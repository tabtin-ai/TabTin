package com.tabtin.mobile.features.files

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.UploadFile
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.files.CloudDriveBrowseScope
import com.tabtin.mobile.data.model.files.CloudDriveCollection
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.data.model.files.CloudDriveTypeFilter
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing

@Composable
internal fun CloudDriveRedesignedHeader(
    title: String,
    organizationName: String,
    onBack: (() -> Unit)?,
    onAddClick: () -> Unit,
) {
    val palette = cloudDriveRedesignPalette()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            IconButton(onClick = onBack, modifier = Modifier.size(44.dp)) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = stringResource(R.string.workbench_back_to_overview),
                    tint = palette.textPrimary,
                )
            }
        } else {
            Spacer(modifier = Modifier.width(TTSpacing.sm))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = TTFonts.titleSemibold,
                color = palette.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.semantics { heading() },
            )
            if (organizationName.isNotBlank()) {
                Text(
                    text = organizationName,
                    style = TTFonts.caption,
                    color = palette.textTertiary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        IconButton(
            onClick = onAddClick,
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(palette.accentSoft),
        ) {
            Icon(
                imageVector = Icons.Filled.Add,
                contentDescription = stringResource(R.string.cloud_drive_add),
                tint = palette.accent,
            )
        }
    }
}

@Composable
internal fun CloudDriveRedesignedSearch(
    query: String,
    onQueryChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = cloudDriveRedesignPalette()
    OutlinedTextField(
        value = query,
        onValueChange = onQueryChange,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp),
        textStyle = TTFonts.body.copy(color = palette.textPrimary),
        singleLine = true,
        placeholder = {
            Text(
                text = stringResource(R.string.cloud_drive_redesign_search_hint),
                style = TTFonts.body,
                color = palette.textTertiary,
            )
        },
        leadingIcon = {
            Icon(Icons.Filled.Search, contentDescription = null, tint = palette.textTertiary)
        },
        shape = RoundedCornerShape(13.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = palette.surfaceSoft,
            unfocusedContainerColor = palette.surfaceSoft,
            focusedBorderColor = palette.lineStrong,
            unfocusedBorderColor = Color.Transparent,
            cursorColor = palette.accent,
        ),
    )
}

@Composable
internal fun CloudDriveRecentHero(
    row: CloudDriveResourceRow,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = cloudDriveRedesignPalette()
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Bottom,
        ) {
            Text(
                text = stringResource(R.string.cloud_drive_redesign_recent_title),
                style = TTFonts.bodySemibold,
                color = palette.textPrimary,
            )
            cloudDriveRelativeTimeLabel(row.lastVisitedAt)?.let { relativeTime ->
                Text(text = relativeTime, style = TTFonts.caption, color = palette.textTertiary)
            }
        }
        CloudDriveFileViewportCard(row = row, onClick = onClick)
    }
}

@Composable
internal fun CloudDriveFileViewportCard(
    row: CloudDriveResourceRow,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val palette = cloudDriveRedesignPalette()
    val category = CloudDriveFilePresentation.classify(row.normalizedType, row.displayTitle, row.mimeType)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(17.dp))
            .background(palette.surface)
            .border(1.dp, palette.line, RoundedCornerShape(17.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(TTSpacing.lg),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
        verticalAlignment = Alignment.Top,
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .heightIn(min = 118.dp),
        ) {
            Text(
                text = cloudDriveCategoryLabel(category),
                style = TTFonts.metaSemibold,
                color = cloudDriveCategoryColors(category).foreground,
            )
            Text(
                text = row.displayTitle,
                style = TTFonts.subtitleSemibold,
                color = palette.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = TTSpacing.sm),
            )
            cloudDriveSafePreviewText(row.preview)?.let { preview ->
                Text(
                    text = preview,
                    style = TTFonts.caption,
                    color = palette.textSecondary,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = TTSpacing.xs),
                )
            }
        }
        CloudDriveAdaptivePreview(
            row = row,
            category = category,
            compact = true,
            modifier = Modifier.width(114.dp),
        )
    }
}

@Composable
internal fun CloudDriveQuickActions(
    enabled: Boolean,
    onUpload: () -> Unit,
    onNewFolder: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        CloudDriveQuickAction(
            title = stringResource(R.string.cloud_drive_upload_file),
            icon = Icons.Filled.UploadFile,
            enabled = enabled,
            onClick = onUpload,
            modifier = Modifier.weight(1f),
        )
        CloudDriveQuickAction(
            title = stringResource(R.string.cloud_drive_new_folder),
            icon = Icons.Filled.Folder,
            enabled = enabled,
            folderTone = true,
            onClick = onNewFolder,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun CloudDriveQuickAction(
    title: String,
    icon: ImageVector,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    folderTone: Boolean = false,
) {
    val palette = cloudDriveRedesignPalette()
    val dark = com.tabtin.mobile.ui.theme.LocalTTDarkTheme.current
    val folder = if (dark) Color(0xFFE3B55E) else Color(0xFFD99A28)
    val foreground = if (folderTone) folder else palette.accent
    val background = if (folderTone) folder.copy(alpha = if (dark) 0.16f else 0.13f) else palette.accentSoft
    Row(
        modifier = modifier
            .heightIn(min = 58.dp)
            .alpha(if (enabled) 1f else 0.5f)
            .clip(RoundedCornerShape(13.dp))
            .background(palette.surface)
            .border(1.dp, palette.line, RoundedCornerShape(13.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(background),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = foreground, modifier = Modifier.size(17.dp))
        }
        Text(
            text = title,
            style = TTFonts.metaSemibold,
            color = palette.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
internal fun CloudDriveLibraryHeader(
    showAllContent: Boolean,
    onAllContent: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = cloudDriveRedesignPalette()
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = stringResource(R.string.cloud_drive_redesign_library_title),
            style = TTFonts.bodySemibold,
            color = palette.textPrimary,
        )
        if (showAllContent) {
            TextButton(onClick = onAllContent) {
                Text(
                    text = stringResource(R.string.cloud_drive_redesign_all_content),
                    style = TTFonts.captionMedium,
                    color = palette.textSecondary,
                )
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = palette.textTertiary,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

@Composable
internal fun CloudDriveLibraryControls(
    selectedScope: CloudDriveBrowseScope,
    selectedType: CloudDriveTypeFilter,
    onSelectScope: (CloudDriveBrowseScope) -> Unit,
    onOpenTypeFilter: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = cloudDriveRedesignPalette()
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .weight(1f)
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            listOf(
                CloudDriveBrowseScope.RECENT,
                CloudDriveBrowseScope.ALL,
                CloudDriveBrowseScope.SHARED,
            ).forEach { scope ->
                val label = when (scope) {
                    CloudDriveBrowseScope.ALL -> stringResource(R.string.cloud_drive_scope_all)
                    CloudDriveBrowseScope.RECENT -> stringResource(R.string.cloud_drive_scope_recent)
                    CloudDriveBrowseScope.SHARED -> stringResource(R.string.cloud_drive_scope_shared)
                }
                CloudDriveScopeButton(
                    label = label,
                    selected = scope == selectedScope,
                    palette = palette,
                    onClick = { onSelectScope(scope) },
                )
            }
        }
        val filterActive = selectedType != CloudDriveTypeFilter.ALL
        val selectedTypeLabel = when (selectedType) {
            CloudDriveTypeFilter.ALL -> stringResource(R.string.cloud_drive_type_all)
            CloudDriveTypeFilter.TABDOC -> stringResource(R.string.cloud_drive_type_doc)
            CloudDriveTypeFilter.TABDATA -> stringResource(R.string.cloud_drive_type_table)
            CloudDriveTypeFilter.TABFILES -> stringResource(R.string.cloud_drive_type_file)
        }
        Row(
            modifier = Modifier
                .heightIn(min = 44.dp)
                .clip(CircleShape)
                .background(if (filterActive) palette.accentSoft else palette.surface)
                .border(1.dp, if (filterActive) palette.accent else palette.line, CircleShape)
                .semantics { stateDescription = selectedTypeLabel }
                .clickable(onClick = onOpenTypeFilter)
                .padding(horizontal = TTSpacing.md),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Filled.FilterList,
                contentDescription = null,
                tint = if (filterActive) palette.accent else palette.textSecondary,
                modifier = Modifier.size(16.dp),
            )
            Text(
                text = selectedTypeLabel,
                style = TTFonts.captionMedium,
                color = if (filterActive) palette.accent else palette.textSecondary,
            )
        }
    }
}

@Composable
private fun CloudDriveScopeButton(
    label: String,
    selected: Boolean,
    palette: CloudDriveRedesignPalette,
    onClick: () -> Unit,
) {
    Text(
        text = label,
        style = if (selected) TTFonts.metaSemibold else TTFonts.meta,
        color = if (selected) palette.textPrimary else palette.textSecondary,
        modifier = Modifier
            .heightIn(min = 44.dp)
            .clip(CircleShape)
            .background(if (selected) palette.surface else Color.Transparent)
            .border(1.dp, if (selected) palette.line else Color.Transparent, CircleShape)
            .semantics { this.selected = selected }
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.md),
    )
}

@Composable
internal fun CloudDriveBreadcrumbs(
    breadcrumb: List<CloudDriveCollection>,
    onRoot: () -> Unit,
    onCrumb: (CloudDriveCollection) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = cloudDriveRedesignPalette()
    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onRoot) {
            Text(
                text = stringResource(R.string.cloud_drive_redesign_root_label),
                style = TTFonts.metaMedium,
                color = if (breadcrumb.isEmpty()) palette.textPrimary else palette.textSecondary,
            )
        }
        breadcrumb.forEach { collection ->
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = palette.textTertiary,
                modifier = Modifier.size(16.dp),
            )
            TextButton(onClick = { onCrumb(collection) }) {
                Text(
                    text = collection.name,
                    style = TTFonts.metaMedium,
                    color = if (collection == breadcrumb.lastOrNull()) palette.textPrimary else palette.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

internal fun Modifier.cloudDriveGroupedRow(
    index: Int,
    total: Int,
    palette: CloudDriveRedesignPalette,
): Modifier {
    val radius = 17.dp
    val shape = when {
        total <= 1 -> RoundedCornerShape(radius)
        index == 0 -> RoundedCornerShape(topStart = radius, topEnd = radius)
        index == total - 1 -> RoundedCornerShape(bottomStart = radius, bottomEnd = radius)
        else -> RoundedCornerShape(0.dp)
    }
    return clip(shape)
        .background(palette.surface)
        .border(1.dp, palette.line, shape)
}

@Composable
internal fun CloudDriveEmptyCard(
    title: String,
    body: String? = null,
    modifier: Modifier = Modifier,
) {
    val palette = cloudDriveRedesignPalette()
    Column(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 148.dp)
            .clip(RoundedCornerShape(17.dp))
            .background(palette.surfaceSoft)
            .padding(TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CloudDriveResourceArtwork(category = CloudDriveFileCategory.GENERIC, size = 44.dp)
        Text(
            text = title,
            style = TTFonts.bodyMedium,
            color = palette.textPrimary,
            modifier = Modifier.padding(top = TTSpacing.sm),
        )
        body?.let {
            Text(
                text = it,
                style = TTFonts.meta,
                color = palette.textSecondary,
                modifier = Modifier.padding(top = TTSpacing.xs),
            )
        }
    }
}

@Composable
internal fun CloudDriveLoadingCard(modifier: Modifier = Modifier) {
    val palette = cloudDriveRedesignPalette()
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(148.dp)
            .clip(RoundedCornerShape(TTRadius.lg))
            .background(palette.surface),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(color = palette.accent, modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
    }
}
