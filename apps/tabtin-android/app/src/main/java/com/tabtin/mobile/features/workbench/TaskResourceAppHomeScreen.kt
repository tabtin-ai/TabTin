package com.tabtin.mobile.features.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Button
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.clouddocs.TabTinAppIcon
import com.tabtin.mobile.features.clouddocs.TabTinAppIconVariant
import com.tabtin.mobile.features.files.cloudDriveTablePreviewContent
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.LocalTTDarkTheme
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import java.time.Duration
import java.time.Instant
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * 文档 / 多维表任务 App 首页。对齐 iOS `TaskResourceAppHomeView` 主结构：
 * 搜索 → 继续 → 新建/让 Agent → 资料库列表 → 本任务内容。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TaskResourceAppHomeScreen(
    kind: WorkbenchAppHomeKind,
    organizationName: String,
    taskResources: List<SpaceResource>,
    libraryResources: List<SpaceResource>,
    sharedResourceIds: Set<String> = emptySet(),
    collaborations: Map<String, TaskResourceCollaborationState> = emptyMap(),
    isLoading: Boolean,
    isCreating: Boolean,
    onBack: () -> Unit,
    onOpenResource: (SpaceResource) -> Unit,
    onCreateBlank: () -> Unit,
    onRequestAgent: () -> Unit,
    onLoadCollaboration: (WorkbenchAppHomeKind, String) -> Unit = { _, _ -> },
    onDismiss: () -> Unit,
    wrapInModalSheet: Boolean = true,
) {
    val isDarkTheme = LocalTTDarkTheme.current
    val colorScheme = MaterialTheme.colorScheme
    val palette = remember(kind, isDarkTheme, colorScheme) {
        AppHomePalette.forKind(kind, colorScheme, isDarkTheme)
    }
    val title = when (kind) {
        WorkbenchAppHomeKind.TABDOC -> stringResource(R.string.workbench_apphome_doc_title)
        WorkbenchAppHomeKind.TABDATA -> stringResource(R.string.workbench_apphome_table_title)
        else -> kind.displayName
    }
    var searchQuery by remember(kind) { mutableStateOf("") }
    var libraryScope by remember(kind) { mutableStateOf(TaskResourceLibraryScope.RECENT) }
    var previewItem by remember(kind) { mutableStateOf<SpaceResource?>(null) }
    val query = searchQuery.trim()
    val isSearching = query.isNotEmpty()

    val filteredTask = remember(taskResources, query) {
        if (!isSearching) taskResources
        else taskResources.filter {
            it.displayTitle.contains(query, ignoreCase = true) ||
                (it.preview?.contains(query, ignoreCase = true) == true)
        }
    }
    val continueItem = remember(taskResources, libraryResources, isSearching) {
        if (isSearching) null
        else taskResources.firstOrNull()
            ?: libraryResources.filter { !it.lastVisitedAt.isNullOrBlank() }.maxByOrNull {
                TaskWorkbenchProjector.parseTimestampMs(
                    it.lastVisitedAt,
                )
            }
    }
    val continueCollaboration = continueItem?.let { item ->
        collaborations[taskResourceCollaborationKey(kind, item.resourceId)]
    } ?: TaskResourceCollaborationState.Idle
    LaunchedEffect(kind, continueItem?.resourceId, isSearching) {
        if (!isSearching && continueItem != null) {
            onLoadCollaboration(kind, continueItem.resourceId)
        }
    }
    val filteredLibrary = remember(
        libraryResources,
        sharedResourceIds,
        libraryScope,
        query,
        continueItem,
    ) {
        TaskResourceLibraryProjector.project(
            resources = libraryResources,
            sharedResourceIds = sharedResourceIds,
            scope = if (isSearching) TaskResourceLibraryScope.ALL else libraryScope,
            searchQuery = query,
            excludingResourceId = if (isSearching) null else continueItem?.resourceId,
        )
    }

    val body: @Composable () -> Unit = {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(palette.canvas)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xxxl),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onBack) {
                    Text(stringResource(R.string.workbench_back_to_overview))
                }
            }
            Text(
                text = title,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
                color = palette.textPrimary,
            )
            if (organizationName.isNotBlank()) {
                Text(
                    text = organizationName,
                    style = TTFonts.meta,
                    color = palette.textTertiary,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }

            Spacer(modifier = Modifier.height(TTSpacing.md))
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                placeholder = {
                    Text(
                        when (kind) {
                            WorkbenchAppHomeKind.TABDOC ->
                                stringResource(R.string.workbench_apphome_search_doc)
                            WorkbenchAppHomeKind.TABDATA ->
                                stringResource(R.string.workbench_apphome_search_table)
                            else -> stringResource(R.string.cloud_drive_search_hint)
                        },
                    )
                },
                leadingIcon = {
                    Icon(Icons.Filled.Search, contentDescription = null, tint = palette.textTertiary)
                },
                shape = RoundedCornerShape(13.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = palette.surfaceSoft,
                    unfocusedContainerColor = palette.surfaceSoft,
                    focusedBorderColor = Color.Transparent,
                    unfocusedBorderColor = Color.Transparent,
                ),
            )

            if (!isSearching && continueItem != null) {
                Spacer(modifier = Modifier.height(TTSpacing.lg))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.Bottom,
                ) {
                    Text(
                        text = when (kind) {
                            WorkbenchAppHomeKind.TABDOC ->
                                stringResource(R.string.workbench_apphome_continue_write)
                            WorkbenchAppHomeKind.TABDATA ->
                                stringResource(R.string.workbench_apphome_continue_handle)
                            else -> stringResource(R.string.workbench_continue_work)
                        },
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.textPrimary,
                    )
                    val recency = relativeTimeLabel(
                        continueItem.lastVisitedAt ?: continueItem.updatedAt,
                    )
                    if (recency.isNotEmpty()) {
                        Text(recency, style = TTFonts.meta, color = palette.textTertiary)
                    }
                }
                Spacer(modifier = Modifier.height(TTSpacing.sm))
                ContinueResourceCard(
                    kind = kind,
                    item = continueItem,
                    palette = palette,
                    collaboration = continueCollaboration,
                    originText = if (!continueItem.lastVisitedAt.isNullOrBlank()) {
                        stringResource(R.string.workbench_apphome_resume_recent)
                    } else if (taskResources.any { it.resourceId == continueItem.resourceId }) {
                        stringResource(R.string.workbench_apphome_resume_task)
                    } else {
                        stringResource(R.string.workbench_apphome_resume_recent)
                    },
                    onClick = { previewItem = continueItem },
                )
            }

            if (!isSearching) {
                Spacer(modifier = Modifier.height(TTSpacing.md))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    CreateActionCard(
                        title = when (kind) {
                            WorkbenchAppHomeKind.TABDOC ->
                                stringResource(R.string.workbench_apphome_blank_doc)
                            WorkbenchAppHomeKind.TABDATA ->
                                stringResource(R.string.workbench_apphome_blank_table)
                            else -> stringResource(R.string.workbench_new_document)
                        },
                        subtitle = when (kind) {
                            WorkbenchAppHomeKind.TABDOC ->
                                stringResource(R.string.workbench_apphome_blank_doc_sub)
                            else -> stringResource(R.string.workbench_apphome_blank_table_sub)
                        },
                        icon = Icons.Filled.Add,
                        palette = palette,
                        showsProgress = isCreating,
                        enabled = !isCreating,
                        onClick = onCreateBlank,
                        modifier = Modifier.weight(1f),
                    )
                    CreateActionCard(
                        title = when (kind) {
                            WorkbenchAppHomeKind.TABDOC ->
                                stringResource(R.string.workbench_apphome_agent_draft)
                            else -> stringResource(R.string.workbench_apphome_agent_build)
                        },
                        subtitle = when (kind) {
                            WorkbenchAppHomeKind.TABDOC ->
                                stringResource(R.string.workbench_apphome_agent_draft_sub)
                            else -> stringResource(R.string.workbench_apphome_agent_build_sub)
                        },
                        icon = Icons.Filled.AutoAwesome,
                        palette = palette,
                        showsProgress = false,
                        enabled = !isCreating,
                        onClick = onRequestAgent,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            TaskResourceLibrarySection(
                modifier = Modifier.padding(top = TTSpacing.xl),
                resources = filteredLibrary,
                kind = kind,
                palette = palette,
                selectedScope = libraryScope,
                showScopes = !isSearching,
                onSelectScope = { libraryScope = it },
                isSearching = isSearching,
                isLoading = isLoading && filteredLibrary.isEmpty(),
                onOpen = onOpenResource,
            )

            if (!isSearching) {
                Spacer(modifier = Modifier.height(TTSpacing.xl))
                Text(
                    text = stringResource(R.string.workbench_apphome_section_task_content),
                    style = TTFonts.captionMedium,
                    color = palette.textSecondary,
                )
                Spacer(modifier = Modifier.height(TTSpacing.sm))
                ResourceGroupCard(
                    resources = filteredTask,
                    kind = kind,
                    palette = palette,
                    emptyText = stringResource(R.string.workbench_app_home_empty, title),
                    emptySubtitle = stringResource(R.string.workbench_apphome_task_empty_sub),
                    isLoading = isLoading && filteredTask.isEmpty(),
                    onOpen = onOpenResource,
                )
            }
        }
    }

    if (wrapInModalSheet) {
        val sheetState = rememberTTSheetState(skipPartiallyExpanded = false)
        TTBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
            body()
        }
    } else {
        body()
    }

    previewItem?.let { item ->
        TaskResourceNativePreviewSheet(
            kind = kind,
            item = item,
            palette = palette,
            onDismiss = { previewItem = null },
            onContinue = {
                previewItem = null
                onOpenResource(item)
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskResourceNativePreviewSheet(
    kind: WorkbenchAppHomeKind,
    item: SpaceResource,
    palette: AppHomePalette,
    onDismiss: () -> Unit,
    onContinue: () -> Unit,
) {
    val summary = remember(item.metadata) { TaskResourcePreviewSummary.from(item.metadata) }
    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(
            skipPartiallyExpanded = false,
            confirmValueChange = { target -> target != SheetValue.Expanded },
        ),
        containerColor = palette.canvas,
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
                TabTinAppIcon(
                    appId = kind.appId,
                    variant = TabTinAppIconVariant.GLYPH,
                    size = 44.dp,
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = item.displayTitle,
                        style = TTFonts.subtitleSemibold,
                        color = palette.textPrimary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = stringResource(
                            if (kind == WorkbenchAppHomeKind.TABDATA) {
                                R.string.workbench_apphome_table_type
                            } else {
                                R.string.workbench_apphome_doc_type
                            },
                        ),
                        style = TTFonts.meta,
                        color = palette.textTertiary,
                    )
                }
            }

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(210.dp)
                    .clip(RoundedCornerShape(17.dp))
                    .background(palette.accentSoft)
                    .padding(TTSpacing.md),
            ) {
                if (kind == WorkbenchAppHomeKind.TABDATA) {
                    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                        Text(
                            text = item.displayTitle,
                            style = TTFonts.subtitleSemibold,
                            color = palette.textPrimary,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        TaskResourceTablePreviewGrid(
                            summary = summary,
                            preview = item.preview,
                            palette = palette,
                            modifier = Modifier.weight(1f),
                        )
                    }
                } else {
                    Text(
                        text = item.preview?.trim()?.takeIf(String::isNotEmpty)
                            ?: stringResource(R.string.workbench_apphome_preview_empty),
                        style = TTFonts.body,
                        color = palette.textSecondary,
                        maxLines = 8,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .fillMaxSize()
                            .clip(RoundedCornerShape(13.dp))
                            .background(palette.surface)
                            .padding(TTSpacing.lg),
                    )
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                OutlinedButton(onClick = onDismiss, modifier = Modifier.weight(1f)) {
                    Text(stringResource(R.string.cloud_drive_redesign_later))
                }
                Button(onClick = onContinue, modifier = Modifier.weight(1f)) {
                    Text(stringResource(R.string.cloud_drive_redesign_continue_open))
                }
            }
        }
    }
}

@Composable
internal fun ContinueResourceCard(
    kind: WorkbenchAppHomeKind,
    item: SpaceResource,
    palette: AppHomePalette,
    collaboration: TaskResourceCollaborationState,
    originText: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(17.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(palette.surface)
            .border(1.dp, palette.line, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(TTSpacing.lg),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .heightIn(min = 132.dp),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(RoundedCornerShape(50))
                        .background(palette.accent),
                )
                Text(
                    text = originText,
                    style = TTFonts.meta,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.accent,
                )
            }
            Text(
                text = item.displayTitle,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                color = palette.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = TTSpacing.sm),
            )
            item.preview?.takeIf { it.isNotBlank() }?.let { preview ->
                Text(
                    text = preview,
                    style = TTFonts.meta,
                    color = palette.textSecondary,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = TTSpacing.sm),
                )
            }
            TaskResourceCollaborationMeta(
                state = collaboration,
                palette = palette,
                modifier = Modifier.padding(top = TTSpacing.md),
            )
        }
        ContinueResourcePreview(
            kind = kind,
            item = item,
            palette = palette,
        )
    }
}

@Composable
private fun ContinueResourcePreview(
    kind: WorkbenchAppHomeKind,
    item: SpaceResource,
    palette: AppHomePalette,
) {
    val summary = remember(item.metadata) { TaskResourcePreviewSummary.from(item.metadata) }
    val shape = RoundedCornerShape(17.dp)
    Column(
        modifier = Modifier
            .width(116.dp)
            .heightIn(min = 132.dp)
            .clip(shape)
            .background(palette.accentSoft)
            .border(1.dp, palette.accent.copy(alpha = 0.42f), shape)
            .padding(TTSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        TaskResourcePreviewTypePill(kind = kind, palette = palette)
        Text(
            text = item.displayTitle,
            style = TTFonts.captionMedium,
            color = palette.accent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (kind == WorkbenchAppHomeKind.TABDATA) {
            TaskResourceTablePreviewGrid(
                summary = summary,
                preview = item.preview,
                palette = palette,
                modifier = Modifier.weight(1f),
            )
        } else {
            Text(
                text = item.preview?.takeIf { it.isNotBlank() }
                    ?: stringResource(R.string.workbench_apphome_preview_empty),
                style = TTFonts.caption,
                color = palette.textSecondary,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .background(palette.surface.copy(alpha = 0.72f))
                    .padding(TTSpacing.xs),
            )
        }
    }
}

@Composable
private fun TaskResourcePreviewTypePill(
    kind: WorkbenchAppHomeKind,
    palette: AppHomePalette,
) {
    Row(
        modifier = Modifier
            .clip(CircleShape)
            .background(palette.surface.copy(alpha = 0.78f))
            .padding(horizontal = TTSpacing.xs, vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TabTinAppIcon(
            appId = kind.appId,
            variant = TabTinAppIconVariant.GLYPH,
            size = 14.dp,
        )
        Text(
            text = stringResource(
                if (kind == WorkbenchAppHomeKind.TABDATA) {
                    R.string.workbench_apphome_table_type
                } else {
                    R.string.workbench_apphome_doc_type
                },
            ),
            style = TTFonts.captionMedium,
            color = palette.accent,
            maxLines = 1,
        )
    }
}

@Composable
private fun TaskResourceTablePreviewGrid(
    summary: TaskResourcePreviewSummary,
    preview: String?,
    palette: AppHomePalette,
    modifier: Modifier = Modifier,
) {
    val content = cloudDriveTablePreviewContent(summary.fieldNames, preview)
    val fields = content.fieldNames.take(2)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(palette.surface.copy(alpha = 0.72f))
            .padding(TTSpacing.xs),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        if (fields.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                fields.forEach { field ->
                    Text(
                        text = field,
                        style = TTFonts.caption,
                        color = palette.accent,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            HorizontalDivider(color = palette.accent.copy(alpha = 0.16f))
        }
        Text(
            text = content.previewText
                ?: stringResource(R.string.workbench_apphome_table_rows_empty),
            style = TTFonts.caption,
            color = palette.textSecondary,
            maxLines = if (fields.isEmpty()) 3 else 2,
            overflow = TextOverflow.Ellipsis,
        )
        summary.recordCount?.let { count ->
            Text(
                text = stringResource(R.string.workbench_apphome_record_count, count),
                style = TTFonts.caption,
                color = palette.textTertiary,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun TaskResourceCollaborationMeta(
    state: TaskResourceCollaborationState,
    palette: AppHomePalette,
    modifier: Modifier = Modifier,
) {
    when (state) {
        TaskResourceCollaborationState.Loading -> Row(
            modifier = modifier,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(13.dp),
                strokeWidth = 1.5.dp,
                color = palette.textTertiary,
            )
            Text(
                text = stringResource(R.string.workbench_apphome_collaboration_loading),
                style = TTFonts.caption,
                color = palette.textTertiary,
                maxLines = 1,
            )
        }
        is TaskResourceCollaborationState.Loaded -> {
            val people = state.people
            if (people.isNotEmpty()) {
                Row(
                    modifier = modifier,
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .width(if (people.size > 1) 34.dp else 19.dp)
                            .height(19.dp),
                    ) {
                        people.take(2).forEachIndexed { index, person ->
                            val displayName = person.name.ifBlank {
                                stringResource(R.string.workbench_apphome_collaborator_fallback)
                            }
                            TTAvatar(
                                name = displayName,
                                imageUrl = person.avatarUrl,
                                size = 19.dp,
                                shape = CircleShape,
                                modifier = Modifier
                                    .offset(x = (index * 14).dp)
                                    .border(2.dp, palette.surface, CircleShape),
                            )
                        }
                    }
                    Text(
                        text = if (people.size > 1) {
                            stringResource(R.string.workbench_apphome_collaboration_count, people.size)
                        } else {
                            val name = people.first().name.ifBlank {
                                stringResource(R.string.workbench_apphome_collaborator_fallback)
                            }
                            stringResource(R.string.workbench_apphome_maintained_by, name)
                        },
                        style = TTFonts.caption,
                        color = palette.textTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        TaskResourceCollaborationState.Idle,
        TaskResourceCollaborationState.Unavailable,
        -> Unit
    }
}

internal data class TaskResourcePreviewSummary(
    val recordCount: Int?,
    val fieldNames: List<String>,
) {
    companion object {
        fun from(metadata: JsonObject?): TaskResourcePreviewSummary {
            val summary = metadata?.get("summary") as? JsonObject ?: metadata
            val recordCount = (summary?.get("record_count") as? JsonPrimitive)?.intOrNull
            val fieldNames = (summary?.get("field_names") as? JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty) }
                .orEmpty()
            return TaskResourcePreviewSummary(recordCount = recordCount, fieldNames = fieldNames)
        }
    }
}

internal enum class TaskResourceLibraryScope {
    RECENT,
    ALL,
    SHARED,
}

internal object TaskResourceLibraryProjector {
    fun project(
        resources: List<SpaceResource>,
        sharedResourceIds: Set<String>,
        scope: TaskResourceLibraryScope,
        searchQuery: String,
        excludingResourceId: String?,
    ): List<SpaceResource> {
        val query = searchQuery.trim()
        return resources.asSequence()
            .filter { resource ->
                when (scope) {
                    TaskResourceLibraryScope.RECENT -> !resource.lastVisitedAt.isNullOrBlank()
                    TaskResourceLibraryScope.ALL -> true
                    TaskResourceLibraryScope.SHARED -> resource.resourceId in sharedResourceIds
                }
            }
            .filter { it.resourceId != excludingResourceId }
            .filter { resource ->
                query.isEmpty() ||
                    resource.displayTitle.contains(query, ignoreCase = true) ||
                    resource.preview?.contains(query, ignoreCase = true) == true
            }
            .sortedByDescending { resource ->
                TaskWorkbenchProjector.parseTimestampMs(
                    resource.lastVisitedAt ?: resource.updatedAt ?: resource.createdAt,
                )
            }
            .toList()
    }
}

@Composable
private fun TaskResourceLibrarySection(
    resources: List<SpaceResource>,
    kind: WorkbenchAppHomeKind,
    palette: AppHomePalette,
    selectedScope: TaskResourceLibraryScope,
    showScopes: Boolean,
    onSelectScope: (TaskResourceLibraryScope) -> Unit,
    isSearching: Boolean,
    isLoading: Boolean,
    onOpen: (SpaceResource) -> Unit,
    modifier: Modifier = Modifier,
) {
    val title = when (kind) {
        WorkbenchAppHomeKind.TABDOC -> stringResource(R.string.workbench_apphome_library_docs)
        else -> stringResource(R.string.workbench_apphome_library_tables)
    }
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = palette.textPrimary,
        )
        if (showScopes) {
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                TaskResourceLibraryScope.entries.forEach { scope ->
                    TaskResourceLibraryScopeButton(
                        scope = scope,
                        selected = scope == selectedScope,
                        palette = palette,
                        onClick = { onSelectScope(scope) },
                    )
                }
            }
        }
        when {
            isLoading -> ResourceGroupCard(
                resources = emptyList(),
                kind = kind,
                palette = palette,
                emptyText = "",
                isLoading = true,
                onOpen = onOpen,
            )
            resources.isEmpty() -> TaskResourceLibraryEmptyState(
                kind = kind,
                scope = selectedScope,
                isSearching = isSearching,
                palette = palette,
            )
            else -> ResourceGroupCard(
                resources = resources,
                kind = kind,
                palette = palette,
                emptyText = "",
                isLoading = false,
                onOpen = onOpen,
            )
        }
    }
}

@Composable
private fun TaskResourceLibraryScopeButton(
    scope: TaskResourceLibraryScope,
    selected: Boolean,
    palette: AppHomePalette,
    onClick: () -> Unit,
) {
    val label = when (scope) {
        TaskResourceLibraryScope.RECENT -> stringResource(R.string.workbench_apphome_scope_recent)
        TaskResourceLibraryScope.ALL -> stringResource(R.string.workbench_apphome_scope_all)
        TaskResourceLibraryScope.SHARED -> stringResource(R.string.workbench_apphome_scope_shared)
    }
    val shape = RoundedCornerShape(50)
    Text(
        text = label,
        style = if (selected) TTFonts.metaSemibold else TTFonts.meta,
        color = if (selected) palette.textPrimary else palette.textSecondary,
        modifier = Modifier
            .heightIn(min = 44.dp)
            .clip(shape)
            .background(if (selected) palette.surface else Color.Transparent)
            .border(1.dp, if (selected) palette.line else Color.Transparent, shape)
            .semantics { this.selected = selected }
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.md),
    )
}

@Composable
private fun TaskResourceLibraryEmptyState(
    kind: WorkbenchAppHomeKind,
    scope: TaskResourceLibraryScope,
    isSearching: Boolean,
    palette: AppHomePalette,
) {
    val resourceName = when (kind) {
        WorkbenchAppHomeKind.TABDOC -> stringResource(R.string.workbench_apphome_doc_title)
        else -> stringResource(R.string.workbench_apphome_table_title)
    }
    val title = when {
        isSearching -> stringResource(R.string.workbench_apphome_library_search_empty, resourceName)
        scope == TaskResourceLibraryScope.RECENT ->
            stringResource(R.string.workbench_apphome_library_empty, resourceName)
        scope == TaskResourceLibraryScope.ALL ->
            stringResource(R.string.workbench_apphome_library_all_empty, resourceName)
        else -> stringResource(R.string.workbench_apphome_library_shared_empty, resourceName)
    }
    val subtitle = when {
        isSearching -> stringResource(R.string.workbench_apphome_library_search_empty_sub)
        scope == TaskResourceLibraryScope.RECENT ->
            stringResource(R.string.workbench_apphome_library_empty_sub)
        scope == TaskResourceLibraryScope.ALL ->
            stringResource(R.string.workbench_apphome_library_all_empty_sub)
        else -> stringResource(R.string.workbench_apphome_library_shared_empty_sub)
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 150.dp)
            .clip(RoundedCornerShape(17.dp))
            .background(palette.surfaceSoft)
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        TabTinAppIcon(
            appId = kind.appId,
            variant = TabTinAppIconVariant.GLYPH,
            size = 28.dp,
        )
        Text(
            text = title,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = palette.textPrimary,
            modifier = Modifier.padding(top = TTSpacing.sm),
        )
        Text(
            text = subtitle,
            style = TTFonts.meta,
            color = palette.textSecondary,
            modifier = Modifier.padding(top = TTSpacing.xs),
        )
    }
}

@Composable
private fun CreateActionCard(
    title: String,
    subtitle: String,
    icon: ImageVector,
    palette: AppHomePalette,
    showsProgress: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(13.dp)
    Row(
        modifier = modifier
            .heightIn(min = 58.dp)
            .clip(shape)
            .background(palette.surface)
            .border(1.dp, palette.line, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(palette.accentSoft),
            contentAlignment = Alignment.Center,
        ) {
            if (showsProgress) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = palette.accent,
                )
            } else {
                Icon(icon, contentDescription = null, tint = palette.accent, modifier = Modifier.size(16.dp))
            }
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = TTFonts.meta,
                fontWeight = FontWeight.SemiBold,
                color = palette.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = subtitle,
                style = TTFonts.caption,
                color = palette.textTertiary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ResourceGroupCard(
    resources: List<SpaceResource>,
    kind: WorkbenchAppHomeKind,
    palette: AppHomePalette,
    emptyText: String,
    emptySubtitle: String? = null,
    isLoading: Boolean,
    onOpen: (SpaceResource) -> Unit,
) {
    val shape = RoundedCornerShape(17.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(palette.surface)
            .border(1.dp, palette.line, shape),
    ) {
        when {
            isLoading -> {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(TTSpacing.md),
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(
                        stringResource(R.string.workbench_apphome_loading),
                        style = TTFonts.meta,
                        color = palette.textSecondary,
                    )
                }
            }
            resources.isEmpty() -> {
                Column(
                    modifier = Modifier.padding(TTSpacing.md),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
                ) {
                    Text(
                        text = emptyText,
                        style = TTFonts.meta,
                        color = palette.textSecondary,
                    )
                    emptySubtitle?.let { subtitle ->
                        Text(
                            text = subtitle,
                            style = TTFonts.caption,
                            color = palette.textTertiary,
                        )
                    }
                }
            }
            else -> {
                resources.forEachIndexed { index, res ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onOpen(res) }
                            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    ) {
                        TabTinAppIcon(appId = kind.appId, variant = TabTinAppIconVariant.GLYPH, size = 28.dp)
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = res.displayTitle,
                                style = MaterialTheme.typography.bodyMedium,
                                color = palette.textPrimary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            val meta = buildList {
                                add(res.typeLabel)
                                relativeTimeLabel(res.updatedAt).takeIf { it.isNotEmpty() }?.let { add(it) }
                            }.joinToString(" · ")
                            if (meta.isNotEmpty()) {
                                Text(meta, style = TTFonts.caption, color = palette.textTertiary)
                            }
                        }
                    }
                    if (index != resources.lastIndex) {
                        HorizontalDivider(
                            modifier = Modifier.padding(horizontal = TTSpacing.sm),
                            color = palette.line,
                        )
                    }
                }
            }
        }
    }
}

internal data class AppHomePalette(
    val canvas: Color,
    val surface: Color,
    val surfaceSoft: Color,
    val line: Color,
    val accent: Color,
    val accentSoft: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
) {
    companion object {
        fun forKind(
            kind: WorkbenchAppHomeKind,
            colorScheme: ColorScheme,
            isDarkTheme: Boolean,
        ): AppHomePalette {
            val accent = when (kind) {
                WorkbenchAppHomeKind.TABDATA ->
                    if (isDarkTheme) Color(0xFF4ADE80) else Color(0xFF16A34A)
                else -> if (isDarkTheme) Color(0xFF60A5FA) else Color(0xFF2563EB)
            }
            return AppHomePalette(
                canvas = colorScheme.background,
                surface = colorScheme.surface,
                surfaceSoft = colorScheme.surfaceVariant,
                line = colorScheme.outlineVariant,
                accent = accent,
                accentSoft = accent.copy(alpha = 0.12f),
                textPrimary = colorScheme.onSurface,
                textSecondary = colorScheme.onSurfaceVariant,
                textTertiary = colorScheme.onSurfaceVariant.copy(alpha = 0.68f),
            )
        }
    }
}

private fun relativeTimeLabel(isoTime: String?): String {
    if (isoTime.isNullOrBlank()) return ""
    return try {
        val instant = Instant.parse(isoTime)
        val minutes = Duration.between(instant, Instant.now()).toMinutes()
        when {
            minutes < 1 -> "刚刚"
            minutes < 60 -> "${minutes}分钟前"
            minutes < 1440 -> "${minutes / 60}小时前"
            minutes < 2880 -> "昨天"
            else -> {
                val date = instant.atZone(java.time.ZoneId.systemDefault()).toLocalDate()
                "${date.monthValue}/${date.dayOfMonth}"
            }
        }
    } catch (_: Exception) {
        ""
    }
}
