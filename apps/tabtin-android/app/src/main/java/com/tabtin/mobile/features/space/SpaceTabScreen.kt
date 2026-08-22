package com.tabtin.mobile.features.space

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SecondaryScrollableTabRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.doc.DocumentQuotaExceededDialog
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import com.tabtin.mobile.features.workbench.WorkbenchSheet
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SpaceTabScreen(
    viewModel: SpaceTabViewModel,
    onNavigateToDocEditor: (documentId: String) -> Unit,
    onNavigateToSlideViewer: (slideId: String, name: String) -> Unit,
    onNavigateToSitePreview: (siteId: String, siteName: String, siteUrl: String, siteStatus: String) -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }
    var openWorkbenchRequest by remember { mutableStateOf<WorkbenchResourceOpenRequest?>(null) }
    var openWorkbenchSpaceId by remember { mutableStateOf<String?>(null) }
    var openWorkbenchOrganizationId by remember { mutableStateOf<String?>(null) }
    val latestState by rememberUpdatedState(state)

    LaunchedEffect(Unit) {
        viewModel.navigateToDoc.collect { docId ->
            val space = latestState.selectedSpace
            if (space != null) {
                openWorkbenchRequest = WorkbenchResourceOpenRequest(
                    resourceType = "tabdoc",
                    resourceId = docId,
                    title = "TabDoc",
                )
                openWorkbenchSpaceId = space.id
                openWorkbenchOrganizationId = space.organizationId
            } else {
                onNavigateToDocEditor(docId)
            }
        }
    }

    LaunchedEffect(Unit) {
        viewModel.toastRes.collect { resId ->
            snackbarHostState.showSnackbar(context.getString(resId))
        }
    }

    state.createDocumentQuotaExceeded?.let { quotaExceeded ->
        DocumentQuotaExceededDialog(
            error = quotaExceeded,
            onDismiss = viewModel::dismissCreateDocumentQuotaExceeded,
        )
    }

    Box(modifier = Modifier.fillMaxSize()) {
        when {
            !state.hasOrganization -> EmptyStateView(
                emoji = "🏢",
                title = stringResource(R.string.space_tab_no_workspace),
                subtitle = stringResource(R.string.space_tab_no_workspace_hint),
            )
            state.isLoadingSpaces && state.spaces.isEmpty() -> LoadingView()
            state.spaces.isEmpty() && state.errorRes != null -> ErrorView(
                message = stringResource(state.errorRes!!),
                onRetry = { viewModel.refresh() },
            )
            state.spaces.isEmpty() -> EmptyStateView(
                emoji = "📂",
                title = stringResource(R.string.space_tab_no_spaces),
                subtitle = stringResource(R.string.space_tab_no_spaces_hint),
            )
            else -> {
                PullToRefreshBox(
                    isRefreshing = state.isRefreshing,
                    onRefresh = { viewModel.refresh() },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    Column(modifier = Modifier.fillMaxSize()) {
                        SpacePicker(
                            spaces = state.spaces,
                            selectedSpaceId = state.selectedSpaceId,
                            onSelect = viewModel::selectSpace,
                        )

                        ContentTabRow(
                            selectedTab = state.selectedTab,
                            onTabSelect = viewModel::selectTab,
                        )

                        ResourceList(
                            state = state,
                            onResourceClick = { resource ->
                                val webRequest = workbenchOpenRequest(resource)
                                if (webRequest != null) {
                                    openWorkbenchRequest = webRequest
                                    openWorkbenchSpaceId = resource.spaceId
                                    openWorkbenchOrganizationId = state.selectedSpace?.organizationId
                                } else {
                                    handleResourceClick(
                                        resource = resource,
                                        onNavigateToDocEditor = onNavigateToDocEditor,
                                        onNavigateToSlideViewer = onNavigateToSlideViewer,
                                        onNavigateToSitePreview = onNavigateToSitePreview,
                                    )
                                }
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                if (state.selectedTab == SpaceContentTab.DOCUMENTS && state.selectedSpaceId != null) {
                    FloatingActionButton(
                        onClick = { viewModel.createDocument() },
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .padding(16.dp),
                        containerColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                        contentColor = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
                    ) {
                        if (state.isCreatingDoc) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp),
                                color = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(Icons.Default.Add, contentDescription = stringResource(R.string.space_tab_new_document))
                        }
                    }
                }
            }
        }

        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }

    val request = openWorkbenchRequest
    val sheetSpaceId = openWorkbenchSpaceId
    val sheetOrganizationId = openWorkbenchOrganizationId
    if (request != null && !sheetSpaceId.isNullOrBlank() && !sheetOrganizationId.isNullOrBlank()) {
        WorkbenchSheet(
            organizationId = sheetOrganizationId,
            spaceId = sheetSpaceId,
            initialOpenRequest = request,
            onDismiss = {
                openWorkbenchRequest = null
                openWorkbenchSpaceId = null
                openWorkbenchOrganizationId = null
            },
            onDelegateToAgent = {},
            onResourceOpen = { resource ->
                openWorkbenchRequest = null
                openWorkbenchSpaceId = null
                openWorkbenchOrganizationId = null
                handleResourceClick(
                    resource = resource,
                    onNavigateToDocEditor = onNavigateToDocEditor,
                    onNavigateToSlideViewer = onNavigateToSlideViewer,
                    onNavigateToSitePreview = onNavigateToSitePreview,
                )
            },
        )
    }
}

@Composable
private fun SpacePicker(
    spaces: List<Space>,
    selectedSpaceId: String?,
    onSelect: (String) -> Unit,
) {
    val scrollState = rememberScrollState()
    val brandColor = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val bgSubtle = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    val textPrimary = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    val textSecondary = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(scrollState)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        spaces.forEach { space ->
            val isSelected = space.id == selectedSpaceId
            val bgColor = if (isSelected) brandColor.copy(alpha = 0.12f) else bgSubtle
            val textColor = if (isSelected) textPrimary else textSecondary

            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(20.dp))
                    .background(bgColor)
                    .clickable { onSelect(space.id) }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SpaceAvatar(space = space, size = 20)
                Spacer(Modifier.width(6.dp))
                Text(
                    text = space.name,
                    style = MaterialTheme.typography.bodySmall,
                    color = textColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun SpaceAvatar(space: Space, size: Int) {
    val initial = space.icon?.takeIf { it.isNotBlank() }
        ?: space.name.firstOrNull()?.uppercase()
        ?: "?"
    val hashIndex = (space.id.hashCode() and 0x7FFFFFFF) % TTColors.DecorativeBackgrounds.size
    val bgColor = ttColor(
        TTColors.DecorativeBackgrounds[hashIndex],
        TTColors.Dark.DecorativeBackgrounds[hashIndex],
    )
    val textColor = ttColor(
        TTColors.DecorativeTexts[hashIndex],
        TTColors.Dark.DecorativeTexts[hashIndex],
    )

    Box(
        modifier = Modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(bgColor),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = initial,
            fontSize = (size * 0.5).sp,
            color = textColor,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun ContentTabRow(
    selectedTab: SpaceContentTab,
    onTabSelect: (SpaceContentTab) -> Unit,
) {
    val tabs = SpaceContentTab.entries
    val selectedIndex = tabs.indexOf(selectedTab)
    val brandColor = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val textSecondary = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)

    SecondaryScrollableTabRow(
        selectedTabIndex = selectedIndex,
        edgePadding = 16.dp,
        containerColor = ttColor(TTColors.Surface, TTColors.Dark.Surface),
        contentColor = brandColor,
        divider = { HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider)) },
    ) {
        tabs.forEach { tab ->
            val isSelected = tab == selectedTab
            Tab(
                selected = isSelected,
                onClick = { onTabSelect(tab) },
                text = {
                    Text(
                        text = stringResource(tab.labelRes),
                        style = MaterialTheme.typography.bodyMedium.copy(
                            fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                        ),
                        color = if (isSelected) brandColor else textSecondary,
                    )
                },
            )
        }
    }
}

@Composable
private fun ResourceList(
    state: SpaceTabUiState,
    onResourceClick: (SpaceResource) -> Unit,
    modifier: Modifier = Modifier,
) {
    val items = state.filteredResources

    when {
        state.isLoadingResources && state.resources.isEmpty() -> {
            Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(
                    color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                )
            }
        }
        state.errorRes != null && state.resources.isEmpty() -> {
            Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    text = stringResource(state.errorRes),
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
            }
        }
        items.isEmpty() -> {
            val (emoji, emptyText) = when (state.selectedTab) {
                SpaceContentTab.DOCUMENTS -> "📄" to stringResource(R.string.space_tab_empty_documents)
                SpaceContentTab.TABLES -> "📊" to stringResource(R.string.space_tab_empty_tables)
                SpaceContentTab.SLIDES -> "📑" to stringResource(R.string.space_tab_empty_slides)
                SpaceContentTab.SITES -> "🌐" to stringResource(R.string.space_tab_empty_sites)
            }
            EmptyStateView(
                emoji = emoji,
                title = emptyText,
                subtitle = if (state.selectedTab == SpaceContentTab.DOCUMENTS)
                    stringResource(R.string.space_tab_empty_hint) else null,
                modifier = modifier,
            )
        }
        else -> {
            LazyColumn(
                modifier = modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = 80.dp),
            ) {
                items(items, key = { it.id }) { resource ->
                    ResourceRow(
                        resource = resource,
                        onClick = { onResourceClick(resource) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ResourceRow(
    resource: SpaceResource,
    onClick: () -> Unit,
) {
    val textPrimary = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    val textTertiary = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    val dividerColor = ttColor(TTColors.Divider, TTColors.Dark.Divider)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = resource.emoji,
                style = TTFonts.iconFeature,
            )
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = resource.displayTitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (resource.updatedAt != null) {
                    Text(
                        text = resource.typeLabel + " · " + formatRelativeTime(resource.updatedAt),
                        style = MaterialTheme.typography.bodySmall,
                        color = textTertiary,
                        maxLines = 1,
                    )
                } else {
                    Text(
                        text = resource.typeLabel,
                        style = MaterialTheme.typography.bodySmall,
                        color = textTertiary,
                    )
                }
            }
        }
    }
    HorizontalDivider(
        modifier = Modifier.padding(start = 50.dp),
        color = dividerColor,
    )
}

@Composable
private fun LoadingView() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(
            color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
        )
    }
}

@Composable
private fun ErrorView(
    message: String,
    onRetry: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "⚠️",
            style = TTFonts.iconEmptyLG,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(16.dp))
        Text(
            text = stringResource(R.string.common_retry),
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
            color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable(onClick = onRetry)
                .padding(horizontal = 24.dp, vertical = 10.dp),
        )
    }
}

@Composable
private fun EmptyStateView(
    emoji: String,
    title: String,
    subtitle: String? = null,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = emoji, style = TTFonts.iconEmptyHero)
        Spacer(Modifier.height(12.dp))
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            textAlign = TextAlign.Center,
        )
        if (subtitle != null) {
            Spacer(Modifier.height(6.dp))
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                textAlign = TextAlign.Center,
            )
        }
    }
}

private fun workbenchOpenRequest(resource: SpaceResource): WorkbenchResourceOpenRequest? {
    if (resource.normalizedType !in setOf("tabdoc", "tabdata", "tabslide")) return null
    return WorkbenchResourceOpenRequest(
        resourceType = resource.normalizedType,
        resourceId = resource.resourceId,
        title = resource.displayTitle,
    )
}

private fun handleResourceClick(
    resource: SpaceResource,
    onNavigateToDocEditor: (String) -> Unit,
    onNavigateToSlideViewer: (String, String) -> Unit,
    onNavigateToSitePreview: (String, String, String, String) -> Unit,
) {
    when (resource.normalizedType) {
        "tabdoc" -> onNavigateToDocEditor(resource.resourceId)
        "tabslide" -> onNavigateToSlideViewer(resource.resourceId, resource.displayTitle)
        "tabsite" -> {
            val url = resource.siteUrl ?: ""
            onNavigateToSitePreview(resource.resourceId, resource.displayTitle, url, "published")
        }
    }
}

private fun formatRelativeTime(isoTime: String?): String {
    if (isoTime.isNullOrBlank()) return ""
    return try {
        val instant = java.time.Instant.parse(isoTime)
        val now = java.time.Instant.now()
        val minutes = java.time.Duration.between(instant, now).toMinutes()
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
        isoTime.take(10)
    }
}
