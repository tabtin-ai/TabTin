// legacy: 底栏 Memo Tab 已退役，零调用保留。
package com.tabtin.mobile.features.memo

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import coil.compose.AsyncImage
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.memo.MemoColor
import com.tabtin.mobile.data.model.memo.MemoCollection
import com.tabtin.mobile.features.memo.components.MemoColorPicker
import com.tabtin.mobile.features.memo.voice.MemoVoiceRecorderOverlay
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MemoTabScreen(
    viewModel: TabMemoViewModel = hiltViewModel(),
    organizationId: String,
    spaces: List<Space>,
    onBack: (() -> Unit)? = null,
) {
    val state by viewModel.uiState.collectAsState()
    var selectedSpaceId by remember { mutableStateOf<String?>(null) }
    var isSearchPresented by remember { mutableStateOf(false) }
    var isEditorPresented by remember { mutableStateOf(false) }
    var isVoiceRecorderPresented by remember { mutableStateOf(false) }
    var detailMemoId by remember { mutableStateOf<String?>(null) }
    var showColorFilter by remember { mutableStateOf(false) }
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

    val isArchiveMode = state.filterStatus == FilterStatus.ARCHIVED
    val effectiveSpaceId = selectedSpaceId ?: ""

    if (onBack != null) {
        BackHandler(onBack = onBack)
    }

    LaunchedEffect(organizationId, selectedSpaceId) {
        viewModel.loadMemos(organizationId, effectiveSpaceId, force = true)
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Scaffold(
            modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
            topBar = {
                LargeTopAppBar(
                    navigationIcon = {
                        if (onBack != null) {
                            IconButton(onClick = onBack) {
                                Icon(
                                    Icons.AutoMirrored.Filled.ArrowBack,
                                    contentDescription = stringResource(R.string.common_back),
                                )
                            }
                        }
                    },
                    title = { Text(stringResource(R.string.memo_tab_title)) },
                    scrollBehavior = scrollBehavior,
                    actions = {
                        IconButton(onClick = { showColorFilter = !showColorFilter }) {
                            if (state.filterColor.isNotEmpty()) {
                                MemoColor.from(state.filterColor)?.let { mc ->
                                    Box(
                                        modifier = Modifier
                                            .size(14.dp)
                                            .clip(RoundedCornerShape(TTRadius.full))
                                            .background(mc.displayColor),
                                    )
                                } ?: Icon(
                                    Icons.Filled.Palette,
                                    contentDescription = stringResource(R.string.memo_filter_by_color),
                                    modifier = Modifier.size(14.dp),
                                    tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                )
                            } else {
                                Icon(
                                    Icons.Filled.Palette,
                                    contentDescription = stringResource(R.string.memo_filter_by_color),
                                    modifier = Modifier.size(14.dp),
                                    tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                )
                            }
                        }
                        IconButton(
                            onClick = { isSearchPresented = true },
                            enabled = organizationId.isNotEmpty(),
                        ) {
                            Icon(
                                Icons.Filled.Search,
                                contentDescription = stringResource(R.string.memo_search_placeholder),
                                modifier = Modifier.size(14.dp),
                                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                            )
                        }
                        IconButton(
                            onClick = {
                                viewModel.setFilterStatus(if (isArchiveMode) FilterStatus.ACTIVE else FilterStatus.ARCHIVED)
                                viewModel.setFilterCollectionId("")
                            },
                        ) {
                            Icon(
                                imageVector = if (isArchiveMode) Icons.Filled.Inbox else Icons.Filled.Archive,
                                contentDescription = if (isArchiveMode) stringResource(R.string.memo_show_active) else stringResource(R.string.memo_archive),
                                modifier = Modifier.size(14.dp),
                                tint = if (isArchiveMode) ttColor(TTColors.Primary, TTColors.Dark.Primary)
                                else ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                            )
                        }
                    },
                )
            },
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(top = 0.dp),
            ) {
                FilterBar(
                    spaces = spaces,
                    selectedSpaceId = selectedSpaceId,
                    onSpaceSelect = { selectedSpaceId = it },
                    collections = if (isArchiveMode) emptyList() else state.collections,
                    filterCollectionId = state.filterCollectionId,
                    onCollectionSelect = {
                        viewModel.setFilterCollectionId(if (state.filterCollectionId == it) "" else it)
                    },
                    onRetryCollections = { viewModel.loadCollections() },
                    isArchiveMode = isArchiveMode,
                    filterColor = state.filterColor,
                    onClearAll = {
                        viewModel.setFilterStatus(FilterStatus.ACTIVE)
                        viewModel.setFilterColor("")
                        viewModel.setFilterCollectionId("")
                    },
                    viewModel = viewModel,
                )
                if (organizationId.isEmpty()) {
                    NoOrganizationView(modifier = Modifier.fillMaxSize())
                } else {
                    MemoListContent(
                        viewModel = viewModel,
                        organizationId = organizationId,
                        spaceId = effectiveSpaceId,
                        onMemoClick = { detailMemoId = it },
                        onZenEditorTap = { isEditorPresented = true },
                        onVoiceRecordTap = { isVoiceRecorderPresented = true },
                    )
                }
            }
        }

        if (showColorFilter) {
            DropdownMenu(
                expanded = showColorFilter,
                onDismissRequest = { showColorFilter = false },
            ) {
                Box(Modifier.padding(TTSpacing.md)) {
                    MemoColorPicker(
                        selectedColor = state.filterColor,
                        circleSize = 24.dp,
                        onSelect = { color ->
                            viewModel.setFilterColor(color)
                            showColorFilter = false
                        },
                    )
                }
            }
        }

        if (isEditorPresented) {
            MemoEditorOverlay(
                isPresented = isEditorPresented,
                viewModel = viewModel,
                onDismiss = { isEditorPresented = false },
                onCreated = { isEditorPresented = false },
            )
        }

        if (isVoiceRecorderPresented) {
            MemoVoiceRecorderOverlay(
                viewModel = viewModel,
                webSocketService = viewModel.webSocketService,
                tokenManager = viewModel.tokenManager,
                onDismiss = { isVoiceRecorderPresented = false },
                onCreated = {
                    isVoiceRecorderPresented = false
                    viewModel.loadMemos(organizationId, effectiveSpaceId, force = true)
                },
            )
        }

        detailMemoId?.let { memoId ->
            Box(Modifier.fillMaxSize()) {
                MemoDetailScreen(
                    memoId = memoId,
                    viewModel = viewModel,
                    onDismiss = { detailMemoId = null },
                )
            }
        }

        if (isSearchPresented) {
            Box(Modifier.fillMaxSize()) {
                MemoSearchScreen(
                    organizationId = organizationId,
                    spaceId = effectiveSpaceId,
                    viewModel = viewModel,
                    onMemoClick = { detailMemoId = it },
                    onDismiss = {
                        isSearchPresented = false
                        viewModel.loadMemos(organizationId, effectiveSpaceId, force = true)
                    },
                )
            }
        }
    }
}

@Composable
private fun FilterBar(
    spaces: List<Space>,
    selectedSpaceId: String?,
    onSpaceSelect: (String?) -> Unit,
    collections: List<MemoCollection>,
    filterCollectionId: String,
    onCollectionSelect: (String) -> Unit,
    onRetryCollections: () -> Unit,
    isArchiveMode: Boolean,
    filterColor: String,
    onClearAll: () -> Unit,
    viewModel: TabMemoViewModel,
) {
    Column {
        if (spaces.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                SpaceChip(
                    id = null,
                    name = stringResource(R.string.memo_all),
                    avatar = null,
                    isSelected = selectedSpaceId == null,
                    onClick = { onSpaceSelect(null) },
                )
                spaces.forEach { space ->
                    SpaceChip(
                        id = space.id,
                        name = space.name,
                        avatar = space.avatar,
                        isSelected = selectedSpaceId == space.id,
                        onClick = { onSpaceSelect(space.id) },
                    )
                }
            }
        }
        if (!isArchiveMode && collections.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(start = TTSpacing.lg, end = TTSpacing.lg, bottom = TTSpacing.xs),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                collections.forEach { col ->
                    val isSelected = filterCollectionId == col.id
                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(TTRadius.full))
                            .clickable { onCollectionSelect(col.id) }
                            .padding(horizontal = TTSpacing.sm, vertical = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        if (col.icon.isNotEmpty()) {
                            Text(text = col.icon, style = TTFonts.caption)
                        } else {
                            Icon(
                                Icons.Filled.Folder,
                                contentDescription = null,
                                modifier = Modifier.size(9.dp),
                                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                            )
                        }
                        Text(
                            text = col.title,
                            style = TTFonts.caption,
                            color = if (isSelected) ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
                            else ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        )
                        Text(
                            text = "${col.memoCount}",
                            style = TTFonts.caption,
                            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        )
                    }
                }
            }
        }
        ActiveFilterBadges(
            isArchiveMode = isArchiveMode,
            filterColor = filterColor,
            filterCollectionId = filterCollectionId,
            collections = collections,
            viewModel = viewModel,
            onRemoveArchive = { viewModel.setFilterStatus(FilterStatus.ACTIVE) },
            onRemoveColor = { viewModel.setFilterColor("") },
            onRemoveCollection = { viewModel.setFilterCollectionId("") },
            onClearAll = onClearAll,
        )
    }
}

@Composable
private fun ActiveFilterBadges(
    isArchiveMode: Boolean,
    filterColor: String,
    filterCollectionId: String,
    collections: List<MemoCollection>,
    viewModel: TabMemoViewModel,
    onRemoveArchive: () -> Unit,
    onRemoveColor: () -> Unit,
    onRemoveCollection: () -> Unit,
    onClearAll: () -> Unit,
) {
    val hasColorFilter = filterColor.isNotEmpty()
    val hasCollectionFilter = filterCollectionId.isNotEmpty()
    if (!isArchiveMode && !hasColorFilter && !hasCollectionFilter) return

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        if (isArchiveMode) {
            FilterBadge(
                text = stringResource(R.string.memo_archive),
                icon = Icons.Filled.Archive,
                onRemove = onRemoveArchive,
            )
        }
        if (hasColorFilter) {
            val mc = MemoColor.from(filterColor)
            if (mc != null) {
                FilterBadge(
                    text = memoColorDisplayName(mc.rawValue),
                    color = mc.displayColor,
                    onRemove = onRemoveColor,
                )
            }
        }
        if (hasCollectionFilter) {
            collections.firstOrNull { it.id == filterCollectionId }?.let { col ->
                FilterBadge(
                    text = col.title,
                    icon = Icons.Filled.Folder,
                    onRemove = onRemoveCollection,
                )
            }
        }
        Spacer(Modifier.weight(1f))
        Text(
            text = stringResource(R.string.memo_clear_all),
            style = TTFonts.caption,
            color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            modifier = Modifier.clickable(onClick = onClearAll),
        )
    }
}

@Composable
private fun memoColorDisplayName(raw: String): String {
    val mc = MemoColor.from(raw) ?: return raw
    return stringResource(mc.displayNameRes)
}

@Composable
private fun FilterBadge(
    text: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    color: androidx.compose.ui.graphics.Color? = null,
    onRemove: () -> Unit,
) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(TTRadius.full))
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        if (color != null) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(RoundedCornerShape(TTRadius.full))
                    .background(color),
            )
        } else if (icon != null) {
            Icon(
                icon,
                contentDescription = null,
                modifier = Modifier.size(9.dp),
                tint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }
        Text(
            text = text,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
        Icon(
            imageVector = Icons.Filled.Close,
            contentDescription = stringResource(R.string.memo_remove_filter, text),
            modifier = Modifier
                .size(14.dp)
                .clickable(onClick = onRemove),
            tint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
}

@Composable
private fun SpaceChip(
    id: String?,
    name: String,
    avatar: String?,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(TTRadius.full))
            .clickable(onClick = onClick)
            .background(
                if (isSelected) ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.12f)
                else ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
            )
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        if (!avatar.isNullOrEmpty()) {
            AsyncImage(
                model = avatar,
                contentDescription = name,
                modifier = Modifier
                    .size(16.dp)
                    .clip(CircleShape),
            )
        } else if (id != null) {
            val initial = name.firstOrNull()?.uppercase() ?: "?"
            Box(
                modifier = Modifier
                    .size(16.dp)
                    .clip(CircleShape)
                    .background(ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary).copy(alpha = 0.2f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = initial,
                    style = TTFonts.codeXS.copy(fontWeight = FontWeight.Medium),
                    textAlign = TextAlign.Center,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
            }
        }
        Text(
            text = name,
            style = TTFonts.caption,
            color = if (isSelected) ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
            else ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
}

@Composable
internal fun NoOrganizationView(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = stringResource(R.string.memo_select_workspace_first),
            style = TTFonts.body,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
}
