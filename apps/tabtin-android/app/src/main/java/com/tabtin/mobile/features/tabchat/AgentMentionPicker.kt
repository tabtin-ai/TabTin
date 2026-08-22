package com.tabtin.mobile.features.tabchat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ImAgentSummary
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.launch

/**
 * @Agent 选择器：会话内 Agent 可直接 @；其他 Agent 必须先选择执行现场并建立 binding。
 *
 * 状态自管（query / 列表 / 加载 / 加入中），网络通过注入的挂起 lambda 打，
 * 与 Hilt / 具体 service 解耦，便于会话屏复用其 ViewModel 的能力。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AgentMentionPickerSheet(
    isMember: (String) -> Boolean,
    onSearch: suspend (String) -> Result<List<ImAgentSummary>>,
    onLoadWorkspaces: suspend () -> Result<List<Space>>,
    onPick: suspend (ImAgentSummary, String?) -> Result<Unit>,
    onPicked: (ImAgentSummary) -> Unit,
    onDismiss: () -> Unit,
    titleRes: Int = R.string.im_mention_agent_title,
    searchHintRes: Int = R.string.im_mention_agent_search_hint,
    emptyRes: Int = R.string.im_mention_agent_empty,
    memberStatusRes: Int = R.string.im_mention_agent_in_conversation,
    joinStatusRes: Int = R.string.im_mention_agent_join_and_mention,
) {
    var query by remember { mutableStateOf("") }
    var agents by remember { mutableStateOf<List<ImAgentSummary>>(emptyList()) }
    var isLoading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var joiningId by remember { mutableStateOf<String?>(null) }
    var pendingAgent by remember { mutableStateOf<ImAgentSummary?>(null) }
    var workspaces by remember { mutableStateOf<List<Space>>(emptyList()) }
    var isLoadingWorkspaces by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // 输入去抖：query 变更后 300ms 再搜（对齐 iOS `.task(id: query)` 的取消语义）。
    LaunchedEffect(query) {
        isLoading = true
        errorMessage = null
        kotlinx.coroutines.delay(300)
        onSearch(query)
            .onSuccess { agents = it }
            .onFailure { errorMessage = it.message }
        isLoading = false
    }

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(),
    ) {
        // 内部已有 LazyColumn，避免再套 verticalScroll。
        TTSheetColumn(
            scrollable = false,
            modifier = Modifier
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
            Text(
                text = if (pendingAgent == null) stringResource(titleRes)
                    else stringResource(R.string.im_agent_workspace_title),
                style = MaterialTheme.typography.titleMedium,
            )
            if (pendingAgent == null) {
                TabSearchField(
                    query = query,
                    onQueryChange = { query = it },
                    placeholder = stringResource(searchHintRes),
                    modifier = Modifier.fillMaxWidth(),
                    showCancelOnFocus = false,
                )
            } else {
                Text(
                    text = stringResource(R.string.im_agent_workspace_back),
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .clickable(enabled = joiningId == null) { pendingAgent = null }
                        .padding(vertical = TTSpacing.xs),
                )
            }

            Box(modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 360.dp)) {
                val selectedAgent = pendingAgent
                when {
                    selectedAgent != null && isLoadingWorkspaces -> Box(
                        Modifier.fillMaxWidth().padding(TTSpacing.xl),
                        contentAlignment = Alignment.Center,
                    ) { CircularProgressIndicator() }

                    selectedAgent != null && workspaces.isEmpty() -> EmptyHint(
                        text = errorMessage ?: stringResource(R.string.im_agent_workspace_empty),
                    )

                    selectedAgent != null -> LazyColumn(
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                    ) {
                        items(workspaces, key = { it.id }) { workspace ->
                            Surface(
                                onClick = {
                                    if (joiningId == null) {
                                        joiningId = selectedAgent.id
                                        scope.launch {
                                            val result = onPick(selectedAgent, workspace.id)
                                            joiningId = null
                                            if (result.isSuccess) {
                                                onPicked(selectedAgent)
                                                onDismiss()
                                            } else {
                                                errorMessage = result.exceptionOrNull()?.message
                                            }
                                        }
                                    }
                                },
                                enabled = joiningId == null,
                                color = MaterialTheme.colorScheme.surface,
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
                                ) {
                                    Icon(Icons.Default.Folder, contentDescription = null)
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(workspace.name, style = MaterialTheme.typography.bodyLarge)
                                        Text(
                                            stringResource(
                                                R.string.im_agent_workspace_description,
                                                selectedAgent.displayName,
                                            ),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    if (joiningId == selectedAgent.id) {
                                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                                    }
                                }
                            }
                        }
                    }

                    isLoading && agents.isEmpty() -> Box(
                        Modifier.fillMaxWidth().padding(TTSpacing.xl),
                        contentAlignment = Alignment.Center,
                    ) { CircularProgressIndicator() }

                    errorMessage != null && agents.isEmpty() -> EmptyHint(
                        text = errorMessage ?: stringResource(emptyRes),
                    )

                    agents.isEmpty() -> EmptyHint(text = stringResource(emptyRes))

                    else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                        items(agents, key = { it.id }) { agent ->
                            AgentRow(
                                agent = agent,
                                isMember = isMember(agent.id),
                                isJoining = joiningId == agent.id,
                                memberStatusRes = memberStatusRes,
                                joinStatusRes = joinStatusRes,
                                onClick = {
                                    if (joiningId == null) {
                                        if (isMember(agent.id)) {
                                            joiningId = agent.id
                                            scope.launch {
                                                val result = onPick(agent, null)
                                                joiningId = null
                                                if (result.isSuccess) {
                                                    onPicked(agent)
                                                    onDismiss()
                                                } else {
                                                    errorMessage = result.exceptionOrNull()?.message
                                                }
                                            }
                                        } else {
                                            pendingAgent = agent
                                            isLoadingWorkspaces = true
                                            errorMessage = null
                                            scope.launch {
                                                onLoadWorkspaces()
                                                    .onSuccess { workspaces = selectableAgentWorkspaces(it) }
                                                    .onFailure { errorMessage = it.message }
                                                isLoadingWorkspaces = false
                                            }
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
            }
            }
        }
    }
}

/** 群设置中的纯成员管理模式：加入成功后不向输入框插入 @。 */
@Composable
internal fun AgentMembershipPickerSheet(
    existingAgentIds: Set<String>,
    onSearch: suspend (String) -> Result<List<ImAgentSummary>>,
    onLoadWorkspaces: suspend () -> Result<List<Space>>,
    onPick: suspend (ImAgentSummary, String?) -> Result<Unit>,
    onPicked: (ImAgentSummary) -> Unit,
    onDismiss: () -> Unit,
) {
    AgentMentionPickerSheet(
        isMember = existingAgentIds::contains,
        onSearch = { query ->
            onSearch(query).map { agents ->
                addableAgentMembershipCandidates(agents, existingAgentIds)
            }
        },
        onLoadWorkspaces = onLoadWorkspaces,
        onPick = onPick,
        onPicked = onPicked,
        onDismiss = onDismiss,
        titleRes = R.string.im_settings_add_agent,
        searchHintRes = R.string.im_settings_add_agent_search_hint,
        emptyRes = R.string.im_settings_add_agent_empty,
        memberStatusRes = R.string.im_settings_agent_in_conversation,
        joinStatusRes = R.string.im_settings_agent_join,
    )
}

internal fun addableAgentMembershipCandidates(
    agents: List<ImAgentSummary>,
    existingAgentIds: Set<String>,
): List<ImAgentSummary> = agents.filterNot { it.id in existingAgentIds }

internal fun selectableAgentWorkspaces(spaces: List<Space>): List<Space> = spaces.filter {
    it.isExecutionSpace && it.isArchived != true && it.executionDeviceId != null
}

/** 群成员页更换已有 Agent 的执行现场；权限与最终合法性由 binding API 权威校验。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AgentWorkspaceBindingSheet(
    agentId: String,
    agentName: String,
    currentWorkspaceId: String?,
    onLoadWorkspaces: suspend () -> Result<List<Space>>,
    onPickWorkspace: suspend (String) -> Result<Unit>,
    onDismiss: () -> Unit,
) {
    var workspaces by remember { mutableStateOf<List<Space>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var savingWorkspaceId by remember { mutableStateOf<String?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(agentId) {
        isLoading = true
        errorMessage = null
        onLoadWorkspaces()
            .onSuccess { workspaces = selectableAgentWorkspaces(it) }
            .onFailure { errorMessage = it.message }
        isLoading = false
    }

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(),
    ) {
        TTSheetColumn(
            scrollable = false,
            modifier = Modifier
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
        ) {
            Text("更换执行现场", style = MaterialTheme.typography.titleMedium)
            Box(modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 360.dp)) {
                when {
                    isLoading -> Box(
                        Modifier.fillMaxWidth().padding(TTSpacing.xl),
                        contentAlignment = Alignment.Center,
                    ) { CircularProgressIndicator() }

                    workspaces.isEmpty() -> EmptyHint(errorMessage ?: "没有可用执行现场")

                    else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                        items(workspaces, key = { it.id }) { workspace ->
                            val isCurrent = workspace.id == currentWorkspaceId
                            Surface(
                                onClick = {
                                    if (!isCurrent && savingWorkspaceId == null) {
                                        savingWorkspaceId = workspace.id
                                        scope.launch {
                                            onPickWorkspace(workspace.id)
                                                .onSuccess { onDismiss() }
                                                .onFailure { errorMessage = it.message }
                                            savingWorkspaceId = null
                                        }
                                    }
                                },
                                enabled = !isCurrent && savingWorkspaceId == null,
                                color = MaterialTheme.colorScheme.surface,
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
                                ) {
                                    Icon(Icons.Default.Folder, contentDescription = null)
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(workspace.name, style = MaterialTheme.typography.bodyLarge)
                                        Text(
                                            if (isCurrent) "当前执行现场" else "用于 $agentName 执行群聊任务",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    if (savingWorkspaceId == workspace.id) {
                                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            errorMessage?.takeIf { workspaces.isNotEmpty() }?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun EmptyHint(text: String) {
    Box(Modifier.fillMaxWidth().padding(TTSpacing.xl), contentAlignment = Alignment.Center) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun AgentRow(
    agent: ImAgentSummary,
    isMember: Boolean,
    isJoining: Boolean,
    memberStatusRes: Int,
    joinStatusRes: Int,
    onClick: () -> Unit,
) {
    Surface(onClick = onClick, enabled = !isJoining, color = MaterialTheme.colorScheme.surface) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Default.AutoAwesome,
                    contentDescription = null,
                    tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    modifier = Modifier.size(18.dp),
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = agent.displayName,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = stringResource(
                        if (isMember) memberStatusRes else joinStatusRes,
                    ),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (isJoining) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            }
        }
    }
}
