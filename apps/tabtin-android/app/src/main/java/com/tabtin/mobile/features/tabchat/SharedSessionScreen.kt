package com.tabtin.mobile.features.tabchat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.api.ChatApi
import com.tabtin.mobile.data.api.SharedForkRequest
import com.tabtin.mobile.data.im.ImApi
import com.tabtin.mobile.data.im.ImCardStatusMemoryCache
import com.tabtin.mobile.data.im.ImSessionShareCard
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.StreamEvent
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.data.websocket.StreamManager
import com.tabtin.mobile.features.conversation.ChatBubble
import com.tabtin.mobile.features.conversation.ConversationProjector
import com.tabtin.mobile.features.space.AgentIdentityAvatar
import com.tabtin.mobile.ui.theme.TTSpacing
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import javax.inject.Inject
import java.util.UUID

@Serializable
public data class SharedSessionRoute(
    val shareId: String,
    val sessionId: String,
    val title: String,
    val organizationId: String,
)

public data class SharedSessionUiState(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val loadingEarlier: Boolean = false,
    val share: ImSessionShareCard? = null,
    val messages: List<ChatMessage> = emptyList(),
    val agents: List<Agent> = emptyList(),
    val workspaces: List<Space> = emptyList(),
    val hasMoreEarlier: Boolean = false,
    val error: String? = null,
    val actionError: String? = null,
    val executionTargetError: String? = null,
    val forking: Boolean = false,
    val sendingSharedChat: Boolean = false,
)

internal object SharedSessionExecutionTargetPolicy {
    fun agents(agents: List<Agent>, organizationId: String): List<Agent> =
        agents.filter { it.isActive && it.organizationId == organizationId }

    fun workspaces(spaces: List<Space>, organizationId: String): List<Space> =
        spaces.filter {
            it.isExecutionSpace && it.organizationId == organizationId && it.isArchived != true
        }

    fun defaultAgent(agents: List<Agent>): Agent? =
        agents.firstOrNull { it.isDefault == true } ?: agents.firstOrNull()

    fun defaultWorkspace(workspaces: List<Space>): Space? =
        workspaces.firstOrNull { it.isDefault == true } ?: workspaces.firstOrNull()
}

internal object SharedSessionMessageVisibility {
    fun filter(messages: List<ChatMessage>): List<ChatMessage> =
        messages.filterNot { it.isInternalContext || it.isCompactionSummary }
}

@HiltViewModel
public class SharedSessionViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val imApi: ImApi,
    private val chatApi: ChatApi,
    private val spaceRepository: SpaceRepository,
    private val streamManager: StreamManager,
) : ViewModel() {
    private val shareId: String = savedStateHandle["shareId"] ?: ""
    private var activeShareId: String = shareId
    private val sessionId: String = savedStateHandle["sessionId"] ?: ""
    private val organizationId: String = savedStateHandle["organizationId"] ?: ""
    private val projector = ConversationProjector()
    private var streamJob: Job? = null

    private val _state = MutableStateFlow(SharedSessionUiState())
    public val state: StateFlow<SharedSessionUiState> = _state.asStateFlow()

    init {
        load()
        viewModelScope.launch {
            ImCardStatusMemoryCache.sessionShares.collect { shares ->
                val latest = shares[activeShareId] ?: return@collect
                if (latest.normalizedStatus != "active") {
                    streamJob?.cancel()
                    streamManager.releaseSession(sessionId, keepAlive = false)
                    _state.value = _state.value.copy(share = latest, error = null, loading = false)
                }
            }
        }
    }

    public fun load() {
        if (shareId.isBlank() || sessionId.isBlank()) {
            _state.value = SharedSessionUiState(loading = false, error = "共享任务信息不完整")
            return
        }
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = _state.value.messages.isEmpty(), refreshing = true, error = null)
            try {
                var share: ImSessionShareCard
                try {
                    share = imApi.getSessionShare(shareId).unwrap().toCardSnapshot()
                } catch (shareError: Throwable) {
                    share = latestIncomingShareForSession() ?: throw shareError
                }
                if (share.sessionId != sessionId) {
                    share = latestIncomingShareForSession()
                        ?: error("共享任务信息已变化")
                } else if (share.normalizedStatus != "active") {
                    // 旧卡可能已经被撤销，但同一任务已重新发出有效授权；撤销状态不能
                    // 直接终止恢复流程，要先尝试切换到当前 incoming 授权。
                    share = latestIncomingShareForSession() ?: share
                }
                if (share.normalizedStatus != "active") {
                    streamJob?.cancel()
                    streamManager.releaseSession(sessionId, keepAlive = false)
                    _state.value = _state.value.copy(loading = false, refreshing = false, share = share)
                    return@launch
                }
                try {
                    chatApi.getSession(sessionId, share.shareId).unwrap()
                } catch (preflightError: Throwable) {
                    // 消息卡是持久快照；同一任务可能已经轮换授权。与 Electron
                    // resolveRestoredIncomingSessionShare 保持一致，回退到最新有效卡。
                    val replacement = latestIncomingShareForSession()
                        ?: throw preflightError
                    share = replacement
                    chatApi.getSession(sessionId, share.shareId).unwrap()
                }
                activeShareId = share.shareId
                ImCardStatusMemoryCache.putAuthoritativeSessionShare(share)
                val page = chatApi.getMessages(
                    sessionId = sessionId,
                    limit = 50,
                    before = LATEST_PAGE_CURSOR,
                    shareId = activeShareId,
                    expandArtifacts = true,
                ).unwrap()
                projector.replaceWithHistory(page.messages)
                val workspacesResult = runCatching { spaceRepository.getSpaces() }
                val agentsResult = runCatching { spaceRepository.getAgents() }
                val workspaces = SharedSessionExecutionTargetPolicy.workspaces(
                    spaces = workspacesResult.getOrDefault(emptyList()),
                    organizationId = organizationId,
                )
                val agents = SharedSessionExecutionTargetPolicy.agents(
                    agents = agentsResult.getOrDefault(emptyList()),
                    organizationId = organizationId,
                )
                val executionTargetError = when {
                    agentsResult.isFailure -> "AI 分身加载失败"
                    workspacesResult.isFailure -> "Workspace 加载失败"
                    else -> null
                }
                _state.value = _state.value.copy(
                    loading = false,
                    refreshing = false,
                    share = share,
                    messages = SharedSessionMessageVisibility.filter(projector.messages),
                    agents = agents,
                    workspaces = workspaces,
                    hasMoreEarlier = page.hasMore,
                    error = null,
                    executionTargetError = executionTargetError,
                )
                startRealtime()
            } catch (_: Throwable) {
                streamJob?.cancel()
                streamManager.releaseSession(sessionId, keepAlive = false)
                _state.value = _state.value.copy(
                    loading = false,
                    refreshing = false,
                    error = "共享已停止或你已无权查看",
                )
            }
        }
    }

    private suspend fun latestIncomingShareForSession(): ImSessionShareCard? {
        return imApi.listIncomingSessionShares(organizationId).unwrap()
            .shares
            .firstOrNull { it.status == "active" && it.sessionId == sessionId }
            ?.toCardSnapshot()
    }

    public fun loadEarlier() {
        val current = _state.value
        if (!current.hasMoreEarlier || current.loadingEarlier) return
        val before = projector.oldestServerId ?: return
        viewModelScope.launch {
            _state.value = current.copy(loadingEarlier = true)
            try {
                val page = chatApi.getMessages(
                    sessionId = sessionId,
                    limit = 30,
                    before = before,
                    shareId = activeShareId,
                    expandArtifacts = true,
                ).unwrap()
                projector.prependHistory(page.messages)
                _state.value = _state.value.copy(
                    loadingEarlier = false,
                    messages = SharedSessionMessageVisibility.filter(projector.messages),
                    hasMoreEarlier = page.hasMore,
                )
            } catch (_: Throwable) {
                _state.value = _state.value.copy(loadingEarlier = false)
            }
        }
    }

    public fun fork(agentId: String, workspace: Space, onCreated: (ChatSession) -> Unit) {
        if (agentId.isBlank()) return
        if (_state.value.share?.canFork != true || _state.value.forking) return
        viewModelScope.launch {
            _state.value = _state.value.copy(forking = true, actionError = null)
            try {
                val session = chatApi.sharedFork(
                    sessionId,
                    SharedForkRequest(agentId = agentId, workspaceId = workspace.id, shareId = activeShareId),
                ).unwrap()
                _state.value = _state.value.copy(forking = false)
                onCreated(session)
            } catch (error: Throwable) {
                _state.value = _state.value.copy(
                    forking = false,
                    actionError = error.message ?: "创建副本失败",
                )
            }
        }
    }

    private fun startRealtime() {
        if (streamJob?.isActive == true) return
        streamJob = viewModelScope.launch {
            streamManager.observeSession(sessionId, activeShareId).collect { event ->
                when (event) {
                    is StreamEvent.NeedsResync -> refreshHistory()
                    is StreamEvent.Done,
                    is StreamEvent.MessagePersisted,
                    is StreamEvent.MessageCommitted,
                    -> {
                        projector.apply(event)
                        _state.value = _state.value.copy(
                            messages = SharedSessionMessageVisibility.filter(projector.messages),
                        )
                        refreshHistory()
                    }
                    else -> if (projector.apply(event)) {
                        _state.value = _state.value.copy(
                            messages = SharedSessionMessageVisibility.filter(projector.messages),
                        )
                    }
                }
            }
        }
    }

    private suspend fun refreshHistory() {
        runCatching {
            chatApi.getMessages(
                sessionId = sessionId,
                limit = 50,
                before = LATEST_PAGE_CURSOR,
                shareId = activeShareId,
                expandArtifacts = true,
            ).unwrap()
        }.onSuccess { page ->
            projector.replaceWithHistory(page.messages)
            _state.value = _state.value.copy(
                messages = SharedSessionMessageVisibility.filter(projector.messages),
                hasMoreEarlier = page.hasMore,
            )
        }.onFailure {
            load()
        }
    }

    public fun sendCollaborativeMessage(text: String, onSuccess: () -> Unit = {}) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()
            || _state.value.share?.canChat != true
            || _state.value.sendingSharedChat
        ) return
        viewModelScope.launch {
            _state.value = _state.value.copy(actionError = null, sendingSharedChat = true)
            try {
                val executionStatus = chatApi.sharedExecutionStatus(
                    sessionId,
                    shareId = activeShareId,
                ).unwrap()
                if (!executionStatus.reachable) {
                    _state.value = _state.value.copy(
                        actionError = executionStatus.errorCategory ?: "远程执行设备暂未在线",
                    )
                    return@launch
                }
                val result = chatApi.sharedChat(
                    sessionId,
                    com.tabtin.mobile.data.api.SharedChatRequest(
                        text = trimmed,
                        shareId = activeShareId,
                        clientMessageId = UUID.randomUUID().toString(),
                    ),
                ).unwrap()
                val category = result.errorCategory?.trim().orEmpty()
                if (result.messageId != null || category.isEmpty()) {
                    refreshHistory()
                    onSuccess()
                }
                if (category.isNotEmpty()) {
                    _state.value = _state.value.copy(
                        actionError = result.reply ?: result.errorMessage ?: "协作消息发送失败",
                    )
                }
            } catch (error: Throwable) {
                _state.value = _state.value.copy(
                    actionError = error.message ?: "协作消息发送失败",
                )
            } finally {
                _state.value = _state.value.copy(sendingSharedChat = false)
            }
        }
    }

    override fun onCleared() {
        streamManager.releaseSession(sessionId, keepAlive = false)
        super.onCleared()
    }

    private companion object {
        const val LATEST_PAGE_CURSOR = "00000000-0000-0000-0000-000000000000"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SharedSessionScreen(
    onBack: () -> Unit,
    onOpenFork: (sessionId: String, workspace: Space, title: String) -> Unit,
    viewModel: SharedSessionViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    var showExecutionTargetPicker by remember { mutableStateOf(false) }
    var executionTargetStep by remember { mutableStateOf(SharedSessionExecutionTargetStep.AGENT) }
    var selectedAgentId by remember { mutableStateOf<String?>(null) }
    var selectedWorkspaceId by remember { mutableStateOf<String?>(null) }
    var sharedChatDraft by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    var pinnedToBottom by remember { mutableStateOf(true) }

    LaunchedEffect(listState) {
        snapshotFlow { !listState.canScrollForward }.collect { pinnedToBottom = it }
    }
    LaunchedEffect(state.messages.size) {
        if (pinnedToBottom && state.messages.isNotEmpty()) {
            listState.scrollToItem(state.messages.lastIndex)
        }
    }

    if (showExecutionTargetPicker) {
        ModalBottomSheet(onDismissRequest = { showExecutionTargetPicker = false }) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (executionTargetStep == SharedSessionExecutionTargetStep.WORKSPACE) {
                    IconButton(onClick = { executionTargetStep = SharedSessionExecutionTargetStep.AGENT }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回选择 AI 分身")
                    }
                } else {
                    Spacer(Modifier.size(48.dp))
                }
                Text(
                    if (executionTargetStep == SharedSessionExecutionTargetStep.AGENT) "选择 AI 分身" else "选择 Workspace",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { showExecutionTargetPicker = false }) { Text("取消") }
            }
            LazyColumn(
                modifier = Modifier.fillMaxWidth().heightIn(max = 440.dp),
            ) {
                when (executionTargetStep) {
                    SharedSessionExecutionTargetStep.AGENT -> items(state.agents, key = Agent::id) { agent ->
                        val displayName = agent.displayName?.trim()?.takeIf(String::isNotEmpty) ?: agent.name
                        ListItem(
                            headlineContent = { Text(displayName) },
                            leadingContent = {
                                AgentIdentityAvatar(
                                    name = displayName,
                                    avatarKey = agent.settings?.avatarKey,
                                    avatarUrl = agent.settings?.avatarUrl,
                                    size = 36.dp,
                                )
                            },
                            trailingContent = {
                                if (selectedAgentId == agent.id) {
                                    Icon(Icons.Default.Check, contentDescription = "已选择")
                                }
                            },
                            modifier = Modifier.fillMaxWidth().clickable { selectedAgentId = agent.id },
                        )
                    }

                    SharedSessionExecutionTargetStep.WORKSPACE -> items(state.workspaces, key = Space::id) { workspace ->
                        ListItem(
                            headlineContent = { Text(workspace.name) },
                            supportingContent = { Text("在该 Workspace 中创建独立副本") },
                            trailingContent = {
                                if (selectedWorkspaceId == workspace.id) {
                                    Icon(Icons.Default.Check, contentDescription = "已选择")
                                }
                            },
                            modifier = Modifier.fillMaxWidth().clickable { selectedWorkspaceId = workspace.id },
                        )
                    }
                }
            }
            Button(
                onClick = {
                    if (executionTargetStep == SharedSessionExecutionTargetStep.AGENT) {
                        executionTargetStep = SharedSessionExecutionTargetStep.WORKSPACE
                    } else {
                        val agentId = selectedAgentId ?: return@Button
                        val workspace = state.workspaces.firstOrNull { it.id == selectedWorkspaceId } ?: return@Button
                        showExecutionTargetPicker = false
                        viewModel.fork(agentId, workspace) { session ->
                            onOpenFork(session.id, workspace, session.title ?: state.share?.displayTitle.orEmpty())
                        }
                    }
                },
                enabled = when (executionTargetStep) {
                    SharedSessionExecutionTargetStep.AGENT -> selectedAgentId != null
                    SharedSessionExecutionTargetStep.WORKSPACE -> selectedWorkspaceId != null && !state.forking
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(TTSpacing.md)
                    .heightIn(min = 48.dp),
            ) {
                Text(if (executionTargetStep == SharedSessionExecutionTargetStep.AGENT) "下一步" else "创建")
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        state.share?.displayTitle ?: "共享任务",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    IconButton(onClick = viewModel::load, enabled = !state.refreshing) {
                        Icon(Icons.Default.Refresh, contentDescription = "刷新")
                    }
                },
            )
        },
        bottomBar = {
            if (state.share?.normalizedStatus == "active" && state.error == null) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding()
                        .padding(TTSpacing.md),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    HorizontalDivider()
                    if (state.share?.canChat == true) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.Bottom,
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                        ) {
                            OutlinedTextField(
                                value = sharedChatDraft,
                                onValueChange = { sharedChatDraft = it },
                                modifier = Modifier.weight(1f),
                                placeholder = { Text("输入消息，驱动 Agent…") },
                                maxLines = 4,
                            )
                            Button(
                                onClick = {
                                    viewModel.sendCollaborativeMessage(sharedChatDraft) {
                                        sharedChatDraft = ""
                                    }
                                },
                                enabled = sharedChatDraft.trim().isNotEmpty() && !state.sendingSharedChat,
                            ) {
                                if (state.sendingSharedChat) {
                                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                                } else {
                                    Text("发送")
                                }
                            }
                        }
                        Text(
                            text = "实时协作：消息会在原任务中执行",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.labelMedium,
                        )
                        state.actionError?.let {
                            Text(it, color = MaterialTheme.colorScheme.error)
                        }
                    } else if (state.share?.canFork == true) {
                        Button(
                            onClick = {
                                selectedAgentId = SharedSessionExecutionTargetPolicy.defaultAgent(state.agents)?.id
                                selectedWorkspaceId = SharedSessionExecutionTargetPolicy.defaultWorkspace(state.workspaces)?.id
                                executionTargetStep = SharedSessionExecutionTargetStep.AGENT
                                showExecutionTargetPicker = true
                            },
                            enabled = !state.forking && state.agents.isNotEmpty() && state.workspaces.isNotEmpty(),
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 52.dp),
                        ) {
                            if (state.forking) CircularProgressIndicator()
                            else {
                                Icon(Icons.Default.AccountTree, contentDescription = null)
                                Text("创建我的副本", modifier = Modifier.padding(start = TTSpacing.xs))
                            }
                        }
                        when {
                            state.executionTargetError != null -> Text(state.executionTargetError.orEmpty())
                            state.agents.isEmpty() -> Text("当前组织没有可用的 AI 分身")
                            state.workspaces.isEmpty() -> Text("当前组织没有可用的执行 Workspace")
                        }
                        state.actionError?.let {
                            Text(it, color = MaterialTheme.colorScheme.error)
                        }
                    } else {
                        Icon(Icons.Default.Visibility, contentDescription = null)
                        Text("仅查看", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        },
    ) { padding ->
        when {
            state.loading -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            state.share?.normalizedStatus != "active" -> SharedSessionUnavailable(
                "共享已停止或你已无权查看",
                Modifier.padding(padding),
            )
            state.error != null -> SharedSessionUnavailable(state.error.orEmpty(), Modifier.padding(padding)) {
                TextButton(onClick = viewModel::load) { Text("重试") }
            }
            else -> LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                if (state.hasMoreEarlier) {
                    item("load-earlier") {
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            TextButton(onClick = viewModel::loadEarlier, enabled = !state.loadingEarlier) {
                                if (state.loadingEarlier) CircularProgressIndicator()
                                else Text("加载更早消息")
                            }
                        }
                    }
                }
                if (state.messages.isEmpty()) {
                    item("empty") {
                        Box(Modifier.fillParentMaxSize(), contentAlignment = Alignment.Center) {
                            Text("暂无可查看的消息", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                } else {
                    items(state.messages, key = { it.effectiveId }) { message ->
                        ChatBubble(message = message)
                    }
                }
            }
        }
    }
}

private enum class SharedSessionExecutionTargetStep {
    AGENT,
    WORKSPACE,
}

@Composable
private fun SharedSessionUnavailable(
    message: String,
    modifier: Modifier = Modifier,
    action: @Composable (() -> Unit)? = null,
) {
    Column(
        modifier = modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
        action?.invoke()
    }
}
