package com.tabtin.mobile.features.main

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.features.space.AgentListViewModel
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * push drawer 内容（chat tab 左侧抽屉）。结构：
 * - 顶部应用名 + 搜索
 * - "全部对话" 行（DrawerSelection.AllConversations）
 * - SPACES section: Space 列表。移动端不创建本地执行环境。
 * - 底部固定: "个人资料" 行
 *
 * 与 iOS `DrawerSidebar.swift` 行为对齐。
 */
@Composable
public fun DrawerSidebar(
    drawer: ChatDrawerController,
    modifier: Modifier = Modifier,
    agentVm: AgentListViewModel = hiltViewModel(),
) {
    val state by agentVm.uiState.collectAsState()
    val selection by drawer.selection.collectAsState()
    var searchQuery by remember { mutableStateOf("") }

    val filteredSpaces = remember(state.spaces, searchQuery) {
        if (searchQuery.isBlank()) state.spaces
        else state.spaces.filter { it.name.contains(searchQuery, ignoreCase = true) }
    }

    Surface(
        modifier = modifier
            .fillMaxHeight(),
        color = ttColor(TTColors.Surface, TTColors.Dark.Surface),
    ) {
        Column(modifier = Modifier.fillMaxHeight()) {
            // 顶部应用名
            Text(
                text = stringResource(R.string.app_name),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(
                    start = TTSpacing.lg,
                    end = TTSpacing.lg,
                    top = TTSpacing.xxl,
                    bottom = TTSpacing.md,
                ),
            )

            // 搜索框
            TabSearchField(
                query = searchQuery,
                onQueryChange = { searchQuery = it },
                placeholder = stringResource(R.string.drawer_search_placeholder),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg),
            )

            Spacer(Modifier.height(TTSpacing.md))

            LazyColumn(
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = TTSpacing.sm),
            ) {
                // "全部对话" 行
                item(key = "all") {
                    DrawerNavRow(
                        icon = Icons.Default.Inbox,
                        label = stringResource(R.string.drawer_all_conversations),
                        isSelected = selection is DrawerSelection.AllConversations,
                        onClick = { drawer.selectAndClose(DrawerSelection.AllConversations) },
                    )
                }

                // SPACES section：Space 是执行现场，不是 Agent 的别名。
                item(key = "agents_header") {
                    Text(
                        text = stringResource(R.string.drawer_agents_header),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(
                            start = TTSpacing.md,
                            end = TTSpacing.md,
                            top = TTSpacing.lg,
                            bottom = TTSpacing.sm,
                        ),
                    )
                }

                items(filteredSpaces, key = { it.id }) { space ->
                    AgentRowItem(
                        space = space,
                        isSelected = (selection as? DrawerSelection.Agent)?.spaceId == space.id,
                        onClick = { drawer.selectAndClose(DrawerSelection.Agent(space.id)) },
                    )
                }

            }

            HorizontalDivider()

            // 底部"个人资料"
            DrawerNavRow(
                icon = Icons.Default.AccountCircle,
                label = stringResource(R.string.drawer_profile),
                isSelected = selection is DrawerSelection.Profile,
                onClick = { drawer.selectAndClose(DrawerSelection.Profile) },
                modifier = Modifier.padding(
                    horizontal = TTSpacing.sm,
                    vertical = TTSpacing.sm,
                ),
            )
        }
    }

}

@Composable
private fun DrawerNavRow(
    icon: ImageVector,
    label: String,
    isSelected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    Surface(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
        color = if (isSelected) accent.copy(alpha = 0.12f) else androidx.compose.ui.graphics.Color.Transparent,
        shape = RoundedCornerShape(10.dp),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                icon,
                contentDescription = null,
                tint = if (isSelected) accent else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.size(TTSpacing.md))
            Text(
                text = label,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                color = if (isSelected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun AgentRowItem(
    space: Space,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    Surface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        color = if (isSelected) accent.copy(alpha = 0.12f) else androidx.compose.ui.graphics.Color.Transparent,
        shape = RoundedCornerShape(10.dp),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TTAvatar(name = space.name, imageUrl = space.avatar, size = 28.dp)
            Spacer(Modifier.size(TTSpacing.md))
            Text(
                text = space.name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
            )
        }
    }
}
