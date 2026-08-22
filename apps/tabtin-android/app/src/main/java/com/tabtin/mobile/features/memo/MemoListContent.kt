package com.tabtin.mobile.features.memo

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Note
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Note
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.memo.MemoCollection
import com.tabtin.mobile.data.model.memo.MemoSummary
import com.tabtin.mobile.features.memo.components.MemoCardView
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MemoListContent(
    viewModel: TabMemoViewModel,
    organizationId: String,
    spaceId: String,
    onMemoClick: (String) -> Unit,
    onZenEditorTap: () -> Unit,
    onVoiceRecordTap: () -> Unit = {},
    /** App Home 使用 [TabMemoUiState.homeSections]（置顶/今天/昨天/本周/更早），空间 Tab 仍走 legacy 日期组。 */
    useHomeSections: Boolean = false,
) {
    val state by viewModel.uiState.collectAsState()
    val listState = rememberLazyListState()

    val isArchiveMode = state.filterStatus == FilterStatus.ARCHIVED

    Box(modifier = Modifier.fillMaxSize()) {
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.memos.isNotEmpty(),
            onRefresh = { viewModel.loadMemos(organizationId, spaceId, force = true) },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    top = TTSpacing.sm,
                    bottom = if (isArchiveMode) 40.dp else 90.dp,
                ),
            ) {
                when {
                    state.isLoading && state.memos.isEmpty() -> {
                        item {
                            LoadingPlaceholder(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 80.dp),
                            )
                        }
                    }
                    state.loadError != null && state.memos.isEmpty() -> {
                        item {
                            ErrorPlaceholder(
                                message = state.loadError!!,
                                onRetry = { viewModel.loadMemos(organizationId, spaceId, force = true) },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 80.dp),
                            )
                        }
                    }
                    state.memos.isEmpty() && !state.isLoading -> {
                        item {
                            EmptyState(
                                isArchiveMode = isArchiveMode,
                                isSearchEmpty = useHomeSections && state.homeSearchQuery.isNotBlank(),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 80.dp),
                            )
                        }
                    }
                    else -> {
                        if (useHomeSections && !isArchiveMode) {
                            state.homeSections.forEach { section ->
                                item(key = "home_section_${section.kind}") {
                                    SectionHeader(
                                        title = homeSectionTitle(section.kind),
                                        icon = if (section.kind == MemoHomeSectionKind.PINNED) {
                                            Icons.Filled.PushPin
                                        } else {
                                            null
                                        },
                                    )
                                }
                                items(section.memos, key = { it.id }) { memo ->
                                    MemoCardWithContextMenu(
                                        memo = memo,
                                        isArchiveMode = isArchiveMode,
                                        manualCollections = state.manualCollections,
                                        viewModel = viewModel,
                                        onMemoClick = onMemoClick,
                                    )
                                }
                            }
                        } else {
                            val pinned = if (isArchiveMode) emptyList() else state.pinnedMemos
                            val grouped = if (isArchiveMode) state.allGroupedMemos else state.groupedMemos

                            if (pinned.isNotEmpty()) {
                                item {
                                    SectionHeader(
                                        title = stringResource(R.string.memo_pinned),
                                        icon = Icons.Filled.PushPin,
                                    )
                                }
                                items(pinned) { memo ->
                                    MemoCardWithContextMenu(
                                        memo = memo,
                                        isArchiveMode = isArchiveMode,
                                        manualCollections = state.manualCollections,
                                        viewModel = viewModel,
                                        onMemoClick = onMemoClick,
                                    )
                                }
                                if (grouped.isNotEmpty()) {
                                    item {
                                        SectionDivider()
                                    }
                                }
                            }

                            grouped.forEach { group ->
                                item(key = "group_${group.key}") {
                                    SectionHeader(title = group.key, icon = null)
                                }
                                items(group.memos) { memo ->
                                    MemoCardWithContextMenu(
                                        memo = memo,
                                        isArchiveMode = isArchiveMode,
                                        manualCollections = state.manualCollections,
                                        viewModel = viewModel,
                                        onMemoClick = onMemoClick,
                                    )
                                }
                            }
                        }

                        if (state.isLoadingMore) {
                            item {
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(TTSpacing.lg),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                                }
                            }
                        } else if (state.loadMoreError != null) {
                            item {
                                LoadMoreError(
                                    message = state.loadMoreError!!,
                                    onRetry = { viewModel.loadMore() },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                        } else if (state.hasMore) {
                            item {
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(1.dp)
                                        .padding(vertical = TTSpacing.sm),
                                ) {
                                    LaunchedEffect(Unit) {
                                        viewModel.loadMore()
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if (!isArchiveMode) {
            FloatingQuickEditor(
                onZenEditorTap = onZenEditorTap,
                onVoiceRecordTap = onVoiceRecordTap,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.lg),
            )
        }
    }
}

@Composable
private fun SectionHeader(
    title: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector?,
    modifier: Modifier = Modifier,
) {
    val tertiaryColor = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    val accentColor = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(start = TTSpacing.lg + TTSpacing.xs, end = TTSpacing.lg + TTSpacing.xs, top = TTSpacing.lg, bottom = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        if (icon != null) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                modifier = Modifier.size(10.dp),
                tint = accentColor.copy(alpha = 0.7f),
            )
        }
        Text(
            text = title,
            style = TTFonts.captionSemibold,
            color = tertiaryColor,
        )
        HorizontalDivider(
            modifier = Modifier.weight(1f),
            thickness = 0.5.dp,
            color = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight).copy(alpha = 0.25f),
        )
    }
}

@Composable
private fun SectionDivider(modifier: Modifier = Modifier) {
    HorizontalDivider(
        modifier = modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
        thickness = 0.5.dp,
        color = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight).copy(alpha = 0.3f),
    )
}

@Composable
internal fun MemoCardWithContextMenu(
    memo: MemoSummary,
    isArchiveMode: Boolean,
    manualCollections: List<MemoCollection>,
    viewModel: TabMemoViewModel,
    onMemoClick: (String) -> Unit,
) {
    var showMenu by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
    ) {
        MemoCardView(
            memo = memo,
            onClick = { onMemoClick(memo.id) },
            onLongClick = { showMenu = true },
        )
        DropdownMenu(
            expanded = showMenu,
            onDismissRequest = { showMenu = false },
        ) {
            DropdownMenuItem(
                text = {
                    Text(if (memo.isPinned) stringResource(R.string.memo_unpin) else stringResource(R.string.memo_pin))
                },
                onClick = {
                    viewModel.pinMemo(memo.id, !memo.isPinned)
                    showMenu = false
                },
            )
            manualCollections.take(5).forEach { col ->
                DropdownMenuItem(
                    text = { Text(col.title) },
                    onClick = {
                        viewModel.addMemoToCollection(memo.id, col.id)
                        viewModel.loadCollections()
                        showMenu = false
                    },
                )
            }
            if (!isArchiveMode) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.memo_archive)) },
                    onClick = {
                        viewModel.archiveMemo(memo.id)
                        showMenu = false
                    },
                )
            } else {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.memo_restore)) },
                    onClick = {
                        viewModel.restoreFromArchive(memo.id)
                        showMenu = false
                    },
                )
            }
            DropdownMenuItem(
                text = {
                    Text(
                        stringResource(R.string.memo_delete),
                        color = MaterialTheme.colorScheme.error,
                    )
                },
                onClick = {
                    showMenu = false
                    showDeleteConfirm = true
                },
            )
        }
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text(stringResource(R.string.memo_delete_confirm_title)) },
            text = { Text(stringResource(R.string.memo_delete_confirm_message)) },
            confirmButton = {
                TextButton(onClick = {
                    showDeleteConfirm = false
                    scope.launch { viewModel.trashMemo(memo.id) }
                }) {
                    Text(
                        stringResource(R.string.memo_delete),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

@Composable
private fun FloatingQuickEditor(
    onZenEditorTap: () -> Unit,
    onVoiceRecordTap: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val surfaceColor = MaterialTheme.colorScheme.surface
    val tertiaryColor = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    val accentColor = ttColor(TTColors.Primary, TTColors.Dark.Primary)

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(TTRadius.full))
            .fillMaxWidth(0.9f)
            .clickable(onClick = onZenEditorTap)
            .background(surfaceColor.copy(alpha = 0.95f))
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Icon(
            imageVector = Icons.Filled.Add,
            contentDescription = null,
            modifier = Modifier
                .size(30.dp)
                .clip(RoundedCornerShape(TTRadius.full))
                .background(accentColor)
                .padding(6.dp),
            tint = Color.White,
        )
        Text(
            text = stringResource(R.string.memo_write_prompt),
            style = TTFonts.body,
            color = tertiaryColor,
            modifier = Modifier.weight(1f),
        )
        Icon(
            imageVector = Icons.Filled.Mic,
            contentDescription = stringResource(R.string.memo_voice_memo),
            modifier = Modifier
                .size(30.dp)
                .clickable(onClick = onVoiceRecordTap),
            tint = accentColor.copy(alpha = 0.7f),
        )
    }
}

@Composable
private fun LoadingPlaceholder(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.padding(TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        CircularProgressIndicator(modifier = Modifier.size(24.dp))
        Text(
            text = stringResource(R.string.common_loading),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        )
    }
}

@Composable
private fun ErrorPlaceholder(
    message: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(horizontal = TTSpacing.xl, vertical = TTSpacing.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Icon(
            imageVector = Icons.Filled.Archive,
            contentDescription = null,
            modifier = Modifier.size(36.dp),
            tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        )
        Text(
            text = message,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
        TextButton(onClick = onRetry) {
            Text(stringResource(R.string.common_retry))
        }
    }
}

@Composable
private fun homeSectionTitle(kind: MemoHomeSectionKind): String = when (kind) {
    MemoHomeSectionKind.PINNED -> stringResource(R.string.memo_pinned)
    MemoHomeSectionKind.TODAY -> stringResource(R.string.memo_today)
    MemoHomeSectionKind.YESTERDAY -> stringResource(R.string.memo_yesterday)
    MemoHomeSectionKind.THIS_WEEK -> stringResource(R.string.memo_home_group_this_week)
    MemoHomeSectionKind.EARLIER -> stringResource(R.string.memo_home_group_earlier)
}

@Composable
private fun EmptyState(
    isArchiveMode: Boolean,
    isSearchEmpty: Boolean = false,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
    ) {
        Icon(
            imageVector = if (isArchiveMode) Icons.Filled.Archive else Icons.AutoMirrored.Filled.Note,
            contentDescription = null,
            modifier = Modifier.size(40.dp),
            tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary).copy(alpha = 0.4f),
        )
        Text(
            text = when {
                isArchiveMode -> stringResource(R.string.memo_archive_empty)
                isSearchEmpty -> stringResource(R.string.memo_home_empty_search)
                else -> stringResource(R.string.memo_empty_state)
            },
            style = TTFonts.caption,
            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        )
        if (!isArchiveMode && !isSearchEmpty) {
            Text(
                text = stringResource(R.string.memo_empty_hint),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary).copy(alpha = 0.6f),
            )
        }
    }
}

@Composable
private fun LoadMoreError(
    message: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(TTSpacing.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Text(
            text = message,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        )
        TextButton(onClick = onRetry) {
            Text(
                text = stringResource(R.string.common_retry),
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            )
        }
    }
}
