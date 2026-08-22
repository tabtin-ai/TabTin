package com.tabtin.mobile.features.skills

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SecondaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.MobileConnectorMarketFilters
import com.tabtin.mobile.data.model.MobileConnectorMarketItem
import com.tabtin.mobile.data.model.MobileConnectorMarketSource
import com.tabtin.mobile.data.model.SkillQuickUsePreset
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/** 技能库市场分段；路由可用 raw 名 `skills` / `connectors` 传入。 */
public enum class MobileSkillMarketTab {
    SKILLS,
    CONNECTORS,
    ;

    public companion object {
        public fun fromRouteParam(value: String?): MobileSkillMarketTab =
            when (value?.lowercase()) {
                "connectors", "connector" -> CONNECTORS
                else -> SKILLS
            }
    }
}

/** 组织级「技能和连接器」市场：浏览 + 只读详情；携带管理在 AI 分身详情完成。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MobileSkillLibraryScreen(
    onBack: () -> Unit,
    initialAgentId: String? = null,
    initialMarketTab: MobileSkillMarketTab = MobileSkillMarketTab.SKILLS,
    onOpenDetail: (String, String?) -> Unit,
    viewModel: MobileSkillLibraryViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    // initialAgentId 保留路由兼容；携带管理已迁到 Agent 详情页，市场始终展示全量筛选。
    @Suppress("UNUSED_PARAMETER")
    val unusedAgentScope = initialAgentId
    var marketTab by remember { mutableStateOf(initialMarketTab) }
    var skillSource by remember { mutableStateOf(SkillMarketSourceChip.RECOMMENDED) }
    var skillCategory by remember { mutableStateOf(SkillMarketCategoryChip.ALL) }
    var skillSearchQuery by remember { mutableStateOf("") }
    var connectorSource by remember { mutableStateOf(MobileConnectorMarketSource.RECOMMENDED) }
    var connectorSearchQuery by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { viewModel.start() }
    LaunchedEffect(marketTab, connectorSource) {
        if (marketTab == MobileSkillMarketTab.CONNECTORS) {
            viewModel.ensureConnectorShelf(connectorSource)
        }
    }

    val filteredSkills = remember(
        state.skills, state.currentUserId, skillSource, skillCategory, skillSearchQuery,
    ) {
        val userId = state.currentUserId
        state.skills.filter { skill ->
            val input = skill.toMarketFilterInput()
            val matchesSource = SkillMarketFilters.matchesMarketplaceSourceFilter(input, skillSource, userId)
            val matchesCategory = SkillMarketFilters.matchesMarketplaceCategoryFilter(input, skillCategory)
            matchesSource && matchesCategory &&
                SkillMarketFilters.matchesVisibleSearch(
                    query = skillSearchQuery,
                    visibleFields = listOf(
                        skill.name,
                        skill.description,
                        skill.sourceLabel,
                        skill.version,
                    ) + skill.tags.take(2),
                )
        }
    }
    val connectorShelf = state.connectorShelves.getValue(connectorSource)
    val filteredConnectors = remember(connectorSource, connectorShelf.items, connectorSearchQuery) {
        MobileConnectorMarketFilters.visibleItems(
            source = connectorSource,
            query = connectorSearchQuery,
            recommended = if (connectorSource == MobileConnectorMarketSource.RECOMMENDED) connectorShelf.items else emptyList(),
            organization = if (connectorSource == MobileConnectorMarketSource.ORGANIZATION) connectorShelf.items else emptyList(),
            mine = if (connectorSource == MobileConnectorMarketSource.MINE) connectorShelf.items else emptyList(),
        )
    }

    Scaffold(
        topBar = {
            // Tab 紧贴 TopAppBar，避免内容区再空一截把切换键顶下去。
            Column {
                TopAppBar(
                    title = { Text(stringResource(R.string.mobile_skill_library_title)) },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.common_back))
                        }
                    },
                )
                SecondaryTabRow(selectedTabIndex = marketTab.ordinal) {
                    Tab(
                        selected = marketTab == MobileSkillMarketTab.SKILLS,
                        onClick = { marketTab = MobileSkillMarketTab.SKILLS },
                        text = { Text(stringResource(R.string.mobile_skill_library_tab_skills)) },
                    )
                    Tab(
                        selected = marketTab == MobileSkillMarketTab.CONNECTORS,
                        onClick = { marketTab = MobileSkillMarketTab.CONNECTORS },
                        text = { Text(stringResource(R.string.mobile_skill_library_tab_connectors)) },
                    )
                }
            }
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = when (marketTab) {
                MobileSkillMarketTab.SKILLS -> state.isRefreshing
                MobileSkillMarketTab.CONNECTORS -> connectorShelf.isRefreshing
            },
            onRefresh = {
                when (marketTab) {
                    MobileSkillMarketTab.SKILLS -> viewModel.refresh()
                    MobileSkillMarketTab.CONNECTORS -> viewModel.refreshConnectorShelf(connectorSource)
                }
            },
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            when (marketTab) {
                MobileSkillMarketTab.SKILLS -> SkillsMarketPanel(
                    state = state,
                    filteredSkills = filteredSkills,
                    sourceChip = skillSource,
                    categoryChip = skillCategory,
                    searchQuery = skillSearchQuery,
                    onSelectSource = { skillSource = it },
                    onSelectCategory = { skillCategory = it },
                    onSearchChange = { skillSearchQuery = it },
                    onOpenDetail = onOpenDetail,
                    onRetry = viewModel::refresh,
                )
                MobileSkillMarketTab.CONNECTORS -> ConnectorsMarketPanel(
                    source = connectorSource,
                    shelf = connectorShelf,
                    items = filteredConnectors,
                    searchQuery = connectorSearchQuery,
                    onSearchChange = { connectorSearchQuery = it },
                    onSelectSource = { newSource ->
                        connectorSearchQuery = MobileConnectorMarketFilters.searchAfterSelecting(
                            currentSource = connectorSource,
                            newSource = newSource,
                            currentQuery = connectorSearchQuery,
                        )
                        connectorSource = newSource
                    },
                    onRetry = { viewModel.refreshConnectorShelf(connectorSource) },
                )
            }
        }
    }
}

@Composable
private fun SkillsMarketPanel(
    state: MobileSkillLibraryUiState,
    filteredSkills: List<MobileSkillItem>,
    sourceChip: SkillMarketSourceChip,
    categoryChip: SkillMarketCategoryChip,
    searchQuery: String,
    onSelectSource: (SkillMarketSourceChip) -> Unit,
    onSelectCategory: (SkillMarketCategoryChip) -> Unit,
    onSearchChange: (String) -> Unit,
    onOpenDetail: (String, String?) -> Unit,
    onRetry: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        SkillLibraryHeader(
            sourceChip = sourceChip,
            categoryChip = categoryChip,
            searchQuery = searchQuery,
            onSelectSource = onSelectSource,
            onSelectCategory = onSelectCategory,
            onSearchChange = onSearchChange,
        )
        state.errorMessage?.let { message ->
            Text(
                text = message,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
            )
        }
        when {
            state.isLoading && state.skills.isEmpty() -> SkillLibraryLoading()
            state.loadErrorRes != null && state.skills.isEmpty() -> CapabilityLibraryError(
                message = stringResource(state.loadErrorRes),
                fallbackMessage = stringResource(R.string.mobile_skill_library_load_failed),
                onRetry = onRetry,
            )
            filteredSkills.isEmpty() -> SkillLibraryEmpty()
            else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                state.loadErrorRes?.let { warningRes ->
                    item(key = "skill-refresh-warning") {
                        CapabilityShelfWarning(
                            message = stringResource(warningRes),
                            fallbackMessage = stringResource(R.string.mobile_skill_library_load_failed),
                        )
                    }
                }
                items(filteredSkills, key = { it.canonicalKey }) { skill ->
                    MobileSkillRow(
                        skill = skill,
                        onClick = { onOpenDetail(skill.canonicalKey, null) },
                    )
                }
            }
        }
    }
}

/** 连接器 Tab：三来源独立只读货架；添加 / 挂载请在电脑端完成，无假 Switch。 */
@Composable
private fun ConnectorsMarketPanel(
    source: MobileConnectorMarketSource,
    shelf: MobileConnectorShelfState,
    items: List<MobileConnectorMarketItem>,
    searchQuery: String,
    onSearchChange: (String) -> Unit,
    onSelectSource: (MobileConnectorMarketSource) -> Unit,
    onRetry: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        ConnectorLibraryHeader(
            source = source,
            searchQuery = searchQuery,
            onSearchChange = onSearchChange,
            onSelectSource = onSelectSource,
        )
        val allDeviceReadsFailed = source == MobileConnectorMarketSource.MINE &&
            shelf.totalDeviceCount > 0 &&
            shelf.failedDeviceCount == shelf.totalDeviceCount
        if (source == MobileConnectorMarketSource.MINE &&
            shelf.failedDeviceCount > 0 &&
            !allDeviceReadsFailed
        ) {
            ConnectorPartialFailureWarning(
                failedDeviceCount = shelf.failedDeviceCount,
                totalDeviceCount = shelf.totalDeviceCount,
            )
        }
        when {
            shelf.isLoading && shelf.items.isEmpty() -> SkillLibraryLoading()
            allDeviceReadsFailed && shelf.items.isEmpty() -> ConnectorLibraryError(
                message = stringResource(R.string.mobile_connector_all_devices_failed),
                onRetry = onRetry,
            )
            shelf.errorRes != null && shelf.items.isEmpty() -> ConnectorLibraryError(
                message = stringResource(shelf.errorRes),
                onRetry = onRetry,
            )
            items.isEmpty() -> ConnectorLibraryEmpty(source = source, isSearchEmpty = searchQuery.isBlank())
            else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                shelf.errorRes?.let { warningRes ->
                    item(key = "shelf-refresh-warning") {
                        ConnectorShelfWarning(message = stringResource(warningRes))
                    }
                }
                items(items, key = { it.stableKey }) { connection ->
                    MarketMcpConnectionRow(connection)
                    HorizontalDivider(modifier = Modifier.padding(horizontal = TTSpacing.lg))
                }
                item(key = "desktop-management-hint") {
                    Text(
                        text = stringResource(R.string.mobile_connector_manage_on_desktop),
                        style = TTFonts.caption,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                    )
                }
            }
        }
    }
}

@Composable
private fun MarketMcpConnectionRow(connection: MobileConnectorMarketItem) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ConnectorBrandGlyph(
            query = ConnectorBrandIconResolver.Query(
                catalogId = connection.catalogId,
                name = connection.name,
                endpointUrl = connection.endpoint,
            ),
            size = 38.dp,
        )
        Spacer(Modifier.width(TTSpacing.md))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = connection.name,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val metadata = listOfNotNull(
                connection.deviceName?.takeIf(String::isNotBlank),
                connection.transport.takeIf(String::isNotBlank)?.uppercase(),
            ).joinToString(" · ")
            if (metadata.isNotBlank()) {
                Text(
                    text = metadata,
                    style = TTFonts.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            connection.description.takeIf { it.isNotBlank() }?.let { description ->
                Spacer(Modifier.height(2.dp))
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (connection.description.isBlank() && connection.source == MobileConnectorMarketSource.RECOMMENDED) {
                Spacer(Modifier.height(2.dp))
                Text(
                    text = recommendedConnectorDescription(connection.descriptionKey),
                    style = TTFonts.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun recommendedConnectorDescription(descriptionKey: String?): String = stringResource(
    when (descriptionKey) {
        "vercel" -> R.string.mobile_connector_recommended_vercel
        "github" -> R.string.mobile_connector_recommended_github
        "stripe" -> R.string.mobile_connector_recommended_stripe
        "notion" -> R.string.mobile_connector_recommended_notion
        "supabase" -> R.string.mobile_connector_recommended_supabase
        "neon" -> R.string.mobile_connector_recommended_neon
        "cloudflare" -> R.string.mobile_connector_recommended_cloudflare
        "tianyancha" -> R.string.mobile_connector_recommended_tianyancha
        "hithink-a-share" -> R.string.mobile_connector_recommended_hithink_a_share
        "dingtalk" -> R.string.mobile_connector_recommended_dingtalk
        else -> R.string.mobile_connector_manage_on_desktop
    },
)

@Composable
private fun ConnectorLibraryHeader(
    source: MobileConnectorMarketSource,
    searchQuery: String,
    onSearchChange: (String) -> Unit,
    onSelectSource: (MobileConnectorMarketSource) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        TabSearchField(
            query = searchQuery,
            onQueryChange = onSearchChange,
            placeholder = stringResource(R.string.mobile_connector_search),
            modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.lg),
        )
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            contentPadding = PaddingValues(horizontal = TTSpacing.lg),
        ) {
            items(MobileConnectorMarketSource.entries) { item ->
                SourceFilterChip(
                    title = connectorSourceTitle(item),
                    selected = source == item,
                    onClick = { onSelectSource(item) },
                )
            }
        }
        Text(
            text = stringResource(R.string.mobile_connector_read_only_hint),
            style = TTFonts.caption,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = TTSpacing.lg),
        )
    }
}

@Composable
private fun connectorSourceTitle(source: MobileConnectorMarketSource): String = stringResource(
    when (source) {
        MobileConnectorMarketSource.RECOMMENDED -> R.string.mobile_connector_source_recommended
        MobileConnectorMarketSource.ORGANIZATION -> R.string.mobile_connector_source_organization
        MobileConnectorMarketSource.MINE -> R.string.mobile_connector_source_mine
    },
)

@Composable
private fun ConnectorLibraryError(message: String?, onRetry: () -> Unit) {
    CapabilityLibraryError(
        message = message,
        fallbackMessage = stringResource(R.string.mobile_connector_load_failed),
        onRetry = onRetry,
    )
}

@Composable
private fun CapabilityLibraryError(
    message: String?,
    fallbackMessage: String,
    onRetry: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = TTSpacing.xl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = message.orEmpty().ifBlank { fallbackMessage },
            style = TTFonts.body,
            color = MaterialTheme.colorScheme.error,
        )
        Spacer(Modifier.height(TTSpacing.sm))
        TextButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
    }
}

@Composable
private fun ConnectorLibraryEmpty(source: MobileConnectorMarketSource, isSearchEmpty: Boolean) {
    val title = if (!isSearchEmpty) {
        stringResource(R.string.mobile_connector_search_empty)
    } else {
        stringResource(
            when (source) {
                MobileConnectorMarketSource.RECOMMENDED -> R.string.mobile_connector_recommended_empty
                MobileConnectorMarketSource.ORGANIZATION -> R.string.mobile_connector_organization_empty
                MobileConnectorMarketSource.MINE -> R.string.mobile_connector_mine_empty
            },
        )
    }
    val description = if (!isSearchEmpty) {
        stringResource(R.string.mobile_connector_search_empty_hint)
    } else {
        stringResource(
            when (source) {
                MobileConnectorMarketSource.RECOMMENDED -> R.string.mobile_connector_recommended_empty_hint
                MobileConnectorMarketSource.ORGANIZATION -> R.string.mobile_connector_organization_empty_hint
                MobileConnectorMarketSource.MINE -> R.string.mobile_connector_mine_empty_hint
            },
        )
    }
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = TTSpacing.xl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            painter = painterResource(R.drawable.lucide_plug),
            contentDescription = null,
            modifier = Modifier.size(36.dp),
            tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
        )
        Spacer(Modifier.height(TTSpacing.sm))
        Text(title, style = TTFonts.subtitleMedium)
        Spacer(Modifier.height(TTSpacing.xs))
        Text(
            text = description,
            style = TTFonts.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ConnectorShelfWarning(message: String) {
    CapabilityShelfWarning(
        message = message,
        fallbackMessage = stringResource(R.string.mobile_connector_load_failed),
    )
}

@Composable
private fun CapabilityShelfWarning(message: String, fallbackMessage: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Icon(
            imageVector = Icons.Default.WarningAmber,
            contentDescription = null,
            tint = ttColor(TTColors.TextWarning, TTColors.Dark.TextWarning),
            modifier = Modifier.size(18.dp),
        )
        Text(
            text = message.ifBlank { fallbackMessage },
            style = TTFonts.caption,
            color = ttColor(TTColors.TextWarning, TTColors.Dark.TextWarning),
        )
    }
}

@Composable
private fun ConnectorPartialFailureWarning(failedDeviceCount: Int, totalDeviceCount: Int) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Icon(
            imageVector = Icons.Default.WarningAmber,
            contentDescription = null,
            tint = ttColor(TTColors.TextWarning, TTColors.Dark.TextWarning),
            modifier = Modifier.size(18.dp),
        )
        Text(
            text = stringResource(
                R.string.mobile_connector_partial_failure,
                failedDeviceCount,
                totalDeviceCount,
            ),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextWarning, TTColors.Dark.TextWarning),
        )
    }
}

@Composable
private fun SkillLibraryHeader(
    sourceChip: SkillMarketSourceChip,
    categoryChip: SkillMarketCategoryChip,
    searchQuery: String,
    onSelectSource: (SkillMarketSourceChip) -> Unit,
    onSelectCategory: (SkillMarketCategoryChip) -> Unit,
    onSearchChange: (String) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        TabSearchField(
            query = searchQuery,
            onQueryChange = onSearchChange,
            placeholder = stringResource(R.string.mobile_skill_library_search),
            modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.lg),
        )
        // 第一行：推荐 | 组织精选 | 我的
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            contentPadding = PaddingValues(horizontal = TTSpacing.lg),
        ) {
            items(SkillMarketSourceChip.entries) { chip ->
                SourceFilterChip(
                    title = chip.title,
                    selected = sourceChip == chip,
                    onClick = { onSelectSource(chip) },
                )
            }
        }
        // 第二行：全部 | 文档写作 | …
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            contentPadding = PaddingValues(horizontal = TTSpacing.lg),
        ) {
            items(SkillMarketCategoryChip.entries) { chip ->
                CategoryFilterChip(
                    title = chip.title,
                    selected = categoryChip == chip,
                    onClick = { onSelectCategory(chip) },
                )
            }
        }
    }
}

/** 第一行：选中 Primary 填充，未选 subtle。 */
@Composable
private fun SourceFilterChip(title: String, selected: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(999.dp)
    val primary = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val bg = if (selected) primary else ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    val fg = if (selected) {
        TTColors.TextOnPrimary
    } else {
        ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    }
    Text(
        text = title,
        style = TTFonts.captionMedium,
        color = fg,
        modifier = Modifier
            .clip(shape)
            .background(bg)
            .selectable(
                selected = selected,
                role = Role.Tab,
                onClick = onClick,
            )
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

/** 第二行：选中 Primary 描边 + 浅 Primary 底，未选 subtle。 */
@Composable
private fun CategoryFilterChip(title: String, selected: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(999.dp)
    val primary = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val border = if (selected) {
        primary.copy(alpha = 0.40f)
    } else {
        ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    }
    val bg = if (selected) primary.copy(alpha = 0.10f) else Color.Transparent
    val fg = if (selected) {
        primary
    } else {
        ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    }
    Text(
        text = title,
        style = if (selected) TTFonts.captionSemibold else TTFonts.captionMedium,
        color = fg,
        modifier = Modifier
            .clip(shape)
            .background(bg)
            .border(BorderStroke(1.dp, border), shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp),
    )
}

@Composable
private fun SkillLibraryLoading() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
private fun SkillLibraryEmpty() {
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = TTSpacing.xl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            painter = painterResource(R.drawable.lucide_book_text),
            contentDescription = null,
            modifier = Modifier.size(36.dp),
            tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
        )
        Spacer(Modifier.height(TTSpacing.sm))
        Text(stringResource(R.string.mobile_skill_library_empty), style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(TTSpacing.xs))
        Text(
            "换个来源/分类或关键词，或稍后下拉刷新。添加与启停请到 AI 分身详情的技能携带集。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun MobileSkillRow(skill: MobileSkillItem, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
        verticalAlignment = Alignment.Top,
    ) {
        SkillIcon(size = 38.dp)
        Spacer(Modifier.width(TTSpacing.md))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(skill.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (skill.isAttached) {
                    Spacer(Modifier.width(TTSpacing.xs))
                    Text(if (skill.isEnabled) "已启用" else "已停用", style = MaterialTheme.typography.labelSmall, color = if (skill.isEnabled) ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess) else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            skill.description.takeIf { it.isNotBlank() }?.let { description ->
                Spacer(Modifier.height(2.dp))
                Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(2.dp))
            Text(listOf(skill.sourceLabel, skill.version.takeIf { it.isNotBlank() }, skill.tags.take(2).takeIf { it.isNotEmpty() }?.joinToString(" · ")).filterNotNull().joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(TTSpacing.xs))
        Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SkillIcon(size: androidx.compose.ui.unit.Dp) {
    // 技能 = BookText（对齐 Electron SkillPanel）；入口集合语义仍用 lucide_blocks。
    val tint = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    Box(
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(10.dp))
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(R.drawable.lucide_book_text),
            contentDescription = null,
            modifier = Modifier.size(size * 0.55f),
            tint = tint,
        )
    }
}

/** 技能详情只读：元数据 + 携带概况；添加/启停/移除在 AI 分身携带集完成。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MobileSkillDetailScreen(
    skillKey: String,
    initialAgentId: String?,
    onBack: () -> Unit,
    onQuickUse: (SkillQuickUsePreset, String) -> Unit,
    viewModel: MobileSkillLibraryViewModel,
) {
    val state by viewModel.uiState.collectAsState()
    val skill = state.skills.firstOrNull { it.canonicalKey == skillKey }
    var quickUseAgentId by remember(skillKey, initialAgentId) { mutableStateOf(initialAgentId.orEmpty()) }
    var agentExpanded by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { viewModel.start() }
    LaunchedEffect(skill, state.agents, initialAgentId) {
        if (skill == null) return@LaunchedEffect
        if (quickUseAgentId.isBlank() || state.agents.none { it.id == quickUseAgentId }) {
            quickUseAgentId = initialAgentId?.takeIf { id -> state.agents.any { it.id == id } }
                ?: skill.bindings.firstOrNull { it.enabled }?.agentId
                ?: skill.bindings.firstOrNull()?.agentId
                ?: state.agents.firstOrNull { it.isDefault == true }?.id
                ?: state.agents.firstOrNull()?.id.orEmpty()
        }
    }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("技能详情") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.common_back)) } },
        )
    }) { padding ->
        when {
            state.isLoading && skill == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            skill == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { Text("未找到这个技能") }
            else -> {
                val selectedAgent = state.agents.firstOrNull { it.id == quickUseAgentId }
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
                ) {
                    item { SkillDetailSummary(skill) }
                    item { BoundAgentsSection(skill.bindings) }
                    item { ReadinessSection(skill) }
                    if (skill.quickUse.isNotEmpty() && state.agents.isNotEmpty()) {
                        item {
                            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                                Text("快速使用", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                                Box {
                                    OutlinedButton(
                                        onClick = { agentExpanded = true },
                                        modifier = Modifier.fillMaxWidth(),
                                    ) {
                                        Icon(Icons.Default.Person, contentDescription = null, modifier = Modifier.size(18.dp))
                                        Spacer(Modifier.width(TTSpacing.sm))
                                        Text(
                                            selectedAgent?.displayName?.takeIf { it.isNotBlank() }
                                                ?: selectedAgent?.name
                                                ?: "选择 AI 分身",
                                            modifier = Modifier.weight(1f),
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                        Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                                    }
                                    DropdownMenu(expanded = agentExpanded, onDismissRequest = { agentExpanded = false }) {
                                        state.agents.forEach { agent ->
                                            DropdownMenuItem(
                                                text = { Text(agent.displayName?.takeIf { it.isNotBlank() } ?: agent.name) },
                                                onClick = {
                                                    agentExpanded = false
                                                    quickUseAgentId = agent.id
                                                },
                                            )
                                        }
                                    }
                                }
                                QuickUseSection(skill.quickUse, quickUseAgentId, onQuickUse)
                                Text(
                                    "填写所需信息后，会用所选 AI 分身发起一个新任务。添加或启停请到 AI 分身详情的技能携带集。",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable private fun SkillDetailSummary(skill: MobileSkillItem) = Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        SkillIcon(44.dp)
        Spacer(Modifier.width(TTSpacing.md))
        Column {
            Text(skill.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(skill.sourceLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    skill.description.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    if (skill.tags.isNotEmpty()) {
        Text(
            skill.tags.take(6).joinToString(" · "),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable private fun BoundAgentsSection(bindings: List<MobileSkillAgentBinding>) = Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
    Text("已绑定 AI 分身", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    if (bindings.isEmpty()) Text("尚未添加给任何 AI 分身", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    else bindings.forEach { binding -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { Text(binding.agentName, modifier = Modifier.weight(1f)); Text(if (binding.enabled) "已启用" else "已停用", style = MaterialTheme.typography.labelSmall, color = if (binding.enabled) ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess) else MaterialTheme.colorScheme.onSurfaceVariant) } }
    Text("添加、启用或移除请到对应 AI 分身详情的技能携带集。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable private fun ReadinessSection(skill: MobileSkillItem) = Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
    Text("就绪状态", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    val ready = skill.isEnabled
    Row(verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Default.CheckCircle, contentDescription = null, tint = if (ready) ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess) else MaterialTheme.colorScheme.onSurfaceVariant); Spacer(Modifier.width(TTSpacing.sm)); Text(if (skill.bindings.isEmpty()) "尚未添加到 AI 分身" else if (ready) "已就绪" else "已添加，尚未启用") }
}

@Composable private fun QuickUseSection(presets: List<SkillQuickUsePreset>, agentId: String, onQuickUse: (SkillQuickUsePreset, String) -> Unit) = Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
    presets.forEach { preset ->
        TextButton(
            onClick = { onQuickUse(preset, agentId) },
            enabled = agentId.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(preset.resolvedLabel, modifier = Modifier.weight(1f))
            Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null)
        }
    }
}
