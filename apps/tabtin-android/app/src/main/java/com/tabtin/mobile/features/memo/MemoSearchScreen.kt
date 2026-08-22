package com.tabtin.mobile.features.memo

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.data.model.memo.MemoCollection
import com.tabtin.mobile.data.model.memo.MemoSummary
import com.tabtin.mobile.features.memo.components.TagChip
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.delay

private const val SEARCH_DEBOUNCE_MS = 400L

@OptIn(ExperimentalLayoutApi::class)
@Composable
public fun MemoSearchScreen(
    organizationId: String,
    spaceId: String,
    viewModel: TabMemoViewModel,
    onMemoClick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    var searchText by remember { mutableStateOf("") }
    var searchVersion by remember { mutableStateOf(0) }

    LaunchedEffect(searchText) {
        val trimmed = searchText.trim()
        if (trimmed.isEmpty()) {
            viewModel.clearSearchState()
            return@LaunchedEffect
        }
        searchVersion += 1
        val version = searchVersion
        delay(SEARCH_DEBOUNCE_MS)
        if (searchVersion != version) return@LaunchedEffect
        viewModel.performSearchForScreen(organizationId, spaceId, trimmed, cursor = "")
    }

    DisposableEffect(Unit) {
        onDispose { viewModel.clearSearchState() }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TabSearchField(
                query = searchText,
                onQueryChange = { searchText = it },
                placeholder = stringResource(R.string.memo_search_placeholder),
                modifier = Modifier.weight(1f),
                showCancelOnFocus = false,
            )
            Spacer(Modifier.size(TTSpacing.sm))
            IconButton(
                onClick = onDismiss,
                modifier = Modifier
                    .size(28.dp)
                    .clip(RoundedCornerShape(TTRadius.full))
                    .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)),
            ) {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = stringResource(R.string.common_close),
                    modifier = Modifier.size(13.dp),
                    tint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
            }
        }

        when {
            searchText.trim().isEmpty() -> SuggestionsView(
                popularTags = state.popularTags,
                manualCollections = state.manualCollections,
                onTagClick = { searchText = it },
                onCollectionClick = { viewModel.setFilterCollectionId(it); onDismiss() },
            )
            state.isSearching && state.searchResults.isEmpty() -> LoadingView()
            state.searchResults.isEmpty() && !state.isSearching -> EmptyResultView(
                query = searchText.trim(),
                error = state.searchError,
                onRetry = {
                    viewModel.performSearchForScreen(organizationId, spaceId, searchText.trim(), cursor = "")
                },
            )
            else -> SearchResultsView(
                results = state.searchResults,
                isSearching = state.isSearching,
                isLoadingMore = state.searchIsLoadingMore,
                loadMoreError = state.searchLoadMoreError,
                hasMore = state.searchHasMore,
                viewModel = viewModel,
                manualCollections = state.manualCollections,
                onMemoClick = onMemoClick,
                onLoadMore = {
                    if (state.searchNextCursor.isNotEmpty()) {
                        viewModel.performSearchForScreen(
                            organizationId,
                            spaceId,
                            searchText.trim(),
                            cursor = state.searchNextCursor,
                        )
                    }
                },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SuggestionsView(
    popularTags: List<String>,
    manualCollections: List<MemoCollection>,
    onTagClick: (String) -> Unit,
    onCollectionClick: (String) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = TTSpacing.lg, end = TTSpacing.lg, top = TTSpacing.lg),
    ) {
        if (popularTags.isEmpty() && manualCollections.isEmpty()) {
            item {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 60.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
                ) {
                    Icon(
                        imageVector = Icons.Filled.Search,
                        contentDescription = null,
                        modifier = Modifier.size(28.dp),
                        tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary).copy(alpha = 0.3f),
                    )
                    Text(
                        text = stringResource(R.string.memo_search_hint),
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                }
            }
        }
        if (popularTags.isNotEmpty()) {
            item {
                Text(
                    text = stringResource(R.string.memo_quick_search),
                    style = TTFonts.captionSemibold,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    modifier = Modifier.padding(bottom = TTSpacing.sm),
                )
            }
            item {
                FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    popularTags.take(10).forEach { tag ->
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(TTRadius.full))
                                .clickable { onTagClick(tag) }
                        ) {
                            TagChip(text = tag, isAI = false)
                        }
                    }
                }
            }
            item { Spacer(Modifier.height(TTSpacing.lg)) }
        }
        if (manualCollections.isNotEmpty()) {
            item {
                Text(
                    text = stringResource(R.string.memo_collections),
                    style = TTFonts.captionSemibold,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    modifier = Modifier.padding(bottom = TTSpacing.sm),
                )
            }
            items(manualCollections) { col ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(TTRadius.sm))
                        .clickable { onCollectionClick(col.id) }
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    if (col.icon.isNotEmpty()) {
                        Text(text = col.icon, style = TTFonts.caption)
                    } else {
                        Icon(
                            imageVector = Icons.Filled.Folder,
                            contentDescription = null,
                            modifier = Modifier.size(22.dp),
                            tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        )
                    }
                    Text(
                        text = col.title,
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                        modifier = Modifier.weight(1f),
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
}

@Composable
private fun LoadingView() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            CircularProgressIndicator(modifier = Modifier.size(24.dp))
            Text(
                text = stringResource(R.string.memo_searching),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

@Composable
private fun EmptyResultView(
    query: String,
    error: String?,
    onRetry: () -> Unit,
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Icon(
                imageVector = Icons.Filled.Search,
                contentDescription = null,
                modifier = Modifier.size(32.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary).copy(alpha = 0.4f),
            )
            if (error != null) {
                Text(
                    text = error,
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
                TextButton(onClick = onRetry) {
                    Text(
                        text = stringResource(R.string.common_retry),
                        style = TTFonts.caption,
                        color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    )
                }
            } else {
                Text(
                    text = stringResource(R.string.memo_no_results, query),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SearchResultsView(
    results: List<MemoSummary>,
    isSearching: Boolean,
    isLoadingMore: Boolean,
    loadMoreError: String?,
    hasMore: Boolean,
    viewModel: TabMemoViewModel,
    manualCollections: List<MemoCollection>,
    onMemoClick: (String) -> Unit,
    onLoadMore: () -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = TTSpacing.sm, bottom = TTSpacing.lg),
    ) {
        if (isSearching && results.isNotEmpty()) {
            item {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.sm),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(14.dp))
                    Spacer(Modifier.size(TTSpacing.xs))
                    Text(
                        text = stringResource(R.string.memo_searching),
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                }
            }
        }
        items(results) { memo ->
            MemoCardWithContextMenu(
                memo = memo,
                isArchiveMode = false,
                manualCollections = manualCollections,
                viewModel = viewModel,
                onMemoClick = onMemoClick,
            )
        }
        if (isLoadingMore) {
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
        } else if (loadMoreError != null) {
            item {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(TTSpacing.lg),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    Text(
                        text = loadMoreError,
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                    TextButton(onClick = onLoadMore) {
                        Text(stringResource(R.string.common_retry))
                    }
                }
            }
        } else if (hasMore) {
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .padding(vertical = TTSpacing.lg),
                ) {
                    LaunchedEffect(Unit) { onLoadMore() }
                }
            }
        }
    }
}
