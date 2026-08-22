package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.im.ImApi
import com.tabtin.mobile.data.im.ImConversationService
import com.tabtin.mobile.data.im.ImConversationStore
import com.tabtin.mobile.data.im.ImSessionShareRequest
import com.tabtin.mobile.data.im.ImSessionShareResponse
import com.tabtin.mobile.data.im.ImSessionContinuationCreateRequest
import com.tabtin.mobile.data.im.ImSessionContinuationDetail
import com.tabtin.mobile.data.im.ImTaskShareMode
import com.tabtin.mobile.data.im.resolveDirectMessageConversationId
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.lifecycle.HiltViewModel
import java.util.UUID
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** 会话更多菜单里的信息页，只展示服务端会话快照实际提供的字段。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationSessionInfoSheet(
    session: ChatSession,
    isSavingTitle: Boolean,
    isRunning: Boolean,
    onDismiss: () -> Unit,
    onSaveTitle: (String) -> Unit,
) {
    val sheetState = rememberTTSheetState()
    var title by rememberSaveable(session.id, session.title) { mutableStateOf(session.title.orEmpty()) }
    val normalizedTitle = title.trim()

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            item {
                Text(
                    text = "会话信息",
                    modifier = Modifier.padding(horizontal = TTSpacing.lg),
                    style = MaterialTheme.typography.titleLarge,
                )
            }
            item {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = TTSpacing.lg),
                    label = { Text("会话标题") },
                    singleLine = true,
                    enabled = !isSavingTitle,
                )
            }
            item {
                TextButton(
                    onClick = { onSaveTitle(normalizedTitle) },
                    enabled = normalizedTitle.isNotEmpty() && normalizedTitle != session.title && !isSavingTitle,
                    modifier = Modifier.padding(horizontal = TTSpacing.md),
                ) {
                    if (isSavingTitle) {
                        CircularProgressIndicator(strokeWidth = TTSpacing.xxs)
                    } else {
                        Text("保存标题")
                    }
                }
            }
            item { HorizontalDivider() }
            item {
                SessionInfoRow("会话 ID", session.id)
                SessionInfoRow("会话状态", session.status.orEmpty().ifBlank { "未提供" })
                if (isRunning) SessionInfoRow("当前运行", "正在运行")
                session.createdAt?.takeIf { it.isNotBlank() }?.let { SessionInfoRow("创建时间", it) }
            }
            item { HorizontalDivider() }
            item {
                Text(
                    text = "冻结配置",
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                    style = MaterialTheme.typography.titleMedium,
                )
                SessionInfoRow("Agent", session.agentId.orEmpty().ifBlank { "未提供" })
                SessionInfoRow("模式", session.agentMode.orEmpty().ifBlank { "未提供" })
                SessionInfoRow("审批", session.approvalMode.orEmpty().ifBlank { "未提供" })
                SessionInfoRow(
                    "模型",
                    session.currentModelName
                        ?: session.currentModelId
                        ?: session.defaultModelName
                        ?: session.defaultModelId
                        ?: "未提供",
                )
            }
            item { HorizontalDivider() }
            item {
                Text(
                    text = "执行现场",
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                    style = MaterialTheme.typography.titleMedium,
                )
                SessionInfoRow("Workspace", session.workspaceId ?: session.spaceId ?: "未提供")
                session.projectId?.takeIf { it.isNotBlank() }?.let { SessionInfoRow("Project", it) }
            }
            if (session.forkedFromId != null || session.forkPointMessageId != null || (session.forkCount ?: 0) > 0) {
                item { HorizontalDivider() }
                item {
                    Text(
                        text = "分支血缘",
                        modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    session.forkedFromId?.let { SessionInfoRow("来源会话", it) }
                    session.forkPointMessageId?.let { SessionInfoRow("分叉消息", it) }
                    session.forkCount?.let { SessionInfoRow("子分支", it.toString()) }
                }
            }
            item { Spacer(Modifier.padding(bottom = TTSpacing.xl)) }
        }
    }
}

@Composable
private fun SessionInfoRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Text(label, modifier = Modifier.weight(0.34f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, modifier = Modifier.weight(0.66f), fontWeight = FontWeight.Medium)
    }
}

internal typealias ConversationSessionShareMode = ImTaskShareMode

private val ConversationSessionShareMode.title: String
    get() = when (this) {
        ConversationSessionShareMode.VIEW -> "实时查看"
        ConversationSessionShareMode.COLLABORATE -> "实时协作"
        ConversationSessionShareMode.CONTINUE -> "任务续接"
    }

private val ConversationSessionShareMode.description: String
    get() = when (this) {
        ConversationSessionShareMode.VIEW -> "对方可以持续查看原任务的最新内容，不能操作你的执行现场。"
        ConversationSessionShareMode.COLLABORATE -> "对方可以实时查看并参与 Agent 对话。"
        ConversationSessionShareMode.CONTINUE -> "冻结发送时的任务上下文，交给对方创建一个独立新任务。"
    }

internal data class ConversationSessionShareUiState(
    val members: List<OrganizationMember> = emptyList(),
    val query: String = "",
    val selectedUserId: String? = null,
    val mode: ConversationSessionShareMode = ConversationSessionShareMode.VIEW,
    val isLoading: Boolean = true,
    val hasLoadedRecipients: Boolean = false,
    val isSearching: Boolean = false,
    val isSubmitting: Boolean = false,
    val searchError: String? = null,
    val error: String? = null,
    val completedShare: ImSessionShareResponse? = null,
    val completedContinuation: ImSessionContinuationDetail? = null,
)

internal object ConversationSessionSharePresentation {
    fun memberDisplayName(member: OrganizationMember): String = listOf(
        member.user?.nickname,
        member.user?.username,
    )
        .firstNotNullOfOrNull { it?.trim()?.takeIf(String::isNotEmpty) }
        ?: "成员"

    fun emptyRecipientsMessage(query: String): String =
        if (query.trim().isEmpty()) {
            "组织内没有其他可共享成员。"
        } else {
            "未找到匹配成员。"
        }

    fun recipientSubtitle(member: OrganizationMember): String? = member.user?.username
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?.let { "@$it" }
}

@HiltViewModel
internal class ConversationSessionShareViewModel @Inject constructor(
    private val organizationRepository: OrganizationRepository,
    private val imApi: ImApi,
    private val imConversationStore: ImConversationStore,
    private val imConversationService: ImConversationService,
    private val tokenManager: TokenManager,
) : ViewModel() {
    private val _uiState = MutableStateFlow(ConversationSessionShareUiState())
    val uiState: StateFlow<ConversationSessionShareUiState> = _uiState.asStateFlow()
    private var loadedSessionId = ""
    private var loadedOrganizationId = ""
    private var shareClientRequestId: String? = null
    private var memberSearchJob: Job? = null
    private var memberRequestGeneration = 0L

    fun activate(sessionId: String, organizationId: String) {
        if (sessionId == loadedSessionId && organizationId == loadedOrganizationId) return
        loadedSessionId = sessionId
        loadedOrganizationId = organizationId
        _uiState.value = ConversationSessionShareUiState()
        scheduleRecipientLoad(isInitialLoad = true)
    }

    fun setQuery(query: String) {
        if (query == _uiState.value.query) return
        _uiState.value = _uiState.value.copy(
            members = emptyList(),
            query = query,
            selectedUserId = null,
            isSearching = _uiState.value.hasLoadedRecipients,
            searchError = null,
        )
        scheduleRecipientLoad(search = query, debounce = true)
    }

    fun selectRecipient(userId: String) {
        if (_uiState.value.selectedUserId != userId) shareClientRequestId = null
        _uiState.value = _uiState.value.copy(selectedUserId = userId, error = null)
    }

    fun selectMode(mode: ConversationSessionShareMode) {
        if (_uiState.value.mode != mode) shareClientRequestId = null
        _uiState.value = _uiState.value.copy(mode = mode, error = null)
    }

    fun retry() = scheduleRecipientLoad(
        search = _uiState.value.query,
        isInitialLoad = !_uiState.value.hasLoadedRecipients,
    )

    /** sheet 关闭后不保留上一次的收件人、权限或成功态。 */
    fun reset() {
        loadedSessionId = ""
        loadedOrganizationId = ""
        shareClientRequestId = null
        memberRequestGeneration += 1
        memberSearchJob?.cancel()
        memberSearchJob = null
        _uiState.value = ConversationSessionShareUiState()
    }

    fun submit() {
        val current = _uiState.value
        val recipient = current.selectedUserId ?: return
        if (
            current.isSubmitting ||
            current.completedShare != null ||
            current.completedContinuation != null ||
            loadedSessionId.isBlank()
        ) return
        viewModelScope.launch {
            _uiState.value = current.copy(isSubmitting = true, error = null)
            try {
                val clientRequestId = shareClientRequestId ?: UUID.randomUUID().toString().also {
                    shareClientRequestId = it
                }
                val recipientName = current.members
                    .firstOrNull { it.userId == recipient }
                    ?.let(ConversationSessionSharePresentation::memberDisplayName)
                    ?: "成员"
                val conversationId = resolveDirectMessageConversationId(
                    conversations = imConversationStore.conversations.value,
                    organizationId = loadedOrganizationId,
                    otherUserId = recipient,
                ) {
                    imConversationService.createOrGetDM(loadedOrganizationId, recipient)
                }
                imConversationStore.rememberDirectMessage(
                    conversationId = conversationId,
                    organizationId = loadedOrganizationId,
                    otherUserId = recipient,
                    displayName = recipientName,
                )
                if (current.mode.isContinuation) {
                    val continuation = imApi.createSessionContinuation(
                        ImSessionContinuationCreateRequest(
                            sourceSessionId = loadedSessionId,
                            recipientUserId = recipient,
                            conversationId = conversationId,
                            clientRequestId = clientRequestId,
                        ),
                    ).unwrap()
                    _uiState.value = _uiState.value.copy(
                        isSubmitting = false,
                        completedContinuation = continuation,
                    )
                } else {
                    val response = imApi.shareChatSession(
                        ImSessionShareRequest(
                            sessionId = loadedSessionId,
                            granteeUserId = recipient,
                            canFork = current.mode.canFork,
                            canChat = current.mode.canChat,
                            conversationId = conversationId,
                            clientRequestId = clientRequestId,
                            accessMode = current.mode.accessMode,
                        ),
                    ).unwrap()
                    _uiState.value = _uiState.value.copy(isSubmitting = false, completedShare = response)
                }
            } catch (error: Exception) {
                _uiState.value = _uiState.value.copy(
                    isSubmitting = false,
                    error = error.message ?: "共享失败，请稍后重试。",
                )
            }
        }
    }

    private fun scheduleRecipientLoad(
        search: String = "",
        debounce: Boolean = false,
        isInitialLoad: Boolean = false,
    ) {
        memberRequestGeneration += 1
        val requestGeneration = memberRequestGeneration
        val requestOrganizationId = loadedOrganizationId
        val normalizedSearch = search.trim()
        memberSearchJob?.cancel()
        memberSearchJob = viewModelScope.launch {
            if (debounce) delay(250)
            loadRecipients(
                organizationId = requestOrganizationId,
                search = normalizedSearch,
                requestGeneration = requestGeneration,
                isInitialLoad = isInitialLoad,
            )
        }
    }

    private suspend fun loadRecipients(
        organizationId: String,
        search: String,
        requestGeneration: Long,
        isInitialLoad: Boolean,
    ) {
        val currentUserId = tokenManager.userId?.takeIf { it.isNotBlank() }
        if (organizationId.isBlank() || currentUserId == null) {
            if (isCurrentMemberRequest(requestGeneration, organizationId, search)) {
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    isSearching = false,
                    error = "无法确认当前组织或用户，请重新登录后重试。",
                )
            }
            return
        }
        if (!isCurrentMemberRequest(requestGeneration, organizationId, search)) return
        _uiState.value = if (isInitialLoad) {
            _uiState.value.copy(
                isLoading = true,
                isSearching = false,
                searchError = null,
                error = null,
                completedShare = null,
            )
        } else {
            _uiState.value.copy(
                isSearching = true,
                searchError = null,
                completedShare = null,
            )
        }
        try {
            val members = organizationRepository.loadMembers(
                organizationId = organizationId,
                search = search.takeIf { it.isNotEmpty() },
                searchMode = "nickname".takeIf { search.isNotEmpty() },
            )
                .filter { it.userId.isNotBlank() && it.userId != currentUserId }
                .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.displayName })
            currentCoroutineContext().ensureActive()
            if (!isCurrentMemberRequest(requestGeneration, organizationId, search)) return
            _uiState.value = _uiState.value.copy(
                members = members,
                selectedUserId = _uiState.value.selectedUserId?.takeIf { selected ->
                    members.any { it.userId == selected }
                },
                isLoading = false,
                hasLoadedRecipients = true,
                isSearching = false,
                searchError = null,
                error = null,
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (!isCurrentMemberRequest(requestGeneration, organizationId, search)) return
            _uiState.value = if (isInitialLoad) {
                _uiState.value.copy(
                    isLoading = false,
                    isSearching = false,
                    error = error.message ?: "加载组织成员失败。",
                )
            } else {
                _uiState.value.copy(
                    members = emptyList(),
                    selectedUserId = null,
                    isSearching = false,
                    searchError = "搜索组织成员失败，请稍后重试。",
                )
            }
        }
    }

    private fun isCurrentMemberRequest(
        requestGeneration: Long,
        organizationId: String,
        search: String,
    ): Boolean = requestGeneration == memberRequestGeneration &&
        organizationId == loadedOrganizationId &&
        search == _uiState.value.query.trim()
}

/** 与 PC 对齐：新建入口只提供实时查看、实时协作和冻结上下文续接。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationSessionShareSheet(
    sessionId: String,
    organizationId: String,
    onDismiss: () -> Unit,
    viewModel: ConversationSessionShareViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    val sheetState = rememberTTSheetState()
    LaunchedEffect(sessionId, organizationId) {
        viewModel.activate(sessionId, organizationId)
    }
    val dismissSheet = {
        viewModel.reset()
        onDismiss()
    }
    TTBottomSheet(
        onDismissRequest = { if (!state.isSubmitting) dismissSheet() },
        sheetState = sheetState,
    ) {
        state.completedShare?.let { response ->
            ShareSuccess(response = response, onDismiss = dismissSheet)
        } ?: state.completedContinuation?.let { continuation ->
            ContinuationSuccess(continuation = continuation, onDismiss = dismissSheet)
        } ?: LazyColumn(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        ) {
            item {
                Text(
                    text = "共享会话",
                    modifier = Modifier.padding(horizontal = TTSpacing.lg),
                    style = MaterialTheme.typography.titleLarge,
                )
            }
            item {
                Text(
                    text = "实时模式作用于原任务；任务续接只交付发送时冻结的上下文。",
                    modifier = Modifier.padding(horizontal = TTSpacing.lg),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            item { HorizontalDivider() }
            item {
                Text(
                    text = "共享给",
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                    style = MaterialTheme.typography.titleMedium,
                )
            }
            if (state.isLoading) {
                item {
                    Row(
                        modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator()
                        Spacer(Modifier.width(TTSpacing.md))
                        Text("正在加载组织成员…")
                    }
                }
            } else if (!state.hasLoadedRecipients) {
                item {
                    Column(Modifier.padding(horizontal = TTSpacing.lg)) {
                        Text(state.error.orEmpty(), color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = viewModel::retry) { Text("重试") }
                    }
                }
            } else {
                item {
                    TabSearchField(
                        query = state.query,
                        onQueryChange = viewModel::setQuery,
                        placeholder = "搜索组织成员",
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = TTSpacing.lg),
                        showCancelOnFocus = false,
                        enabled = !state.isSubmitting,
                    )
                }
                when {
                    state.isSearching -> item {
                        Row(
                            modifier = Modifier
                                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md)
                                .semantics { liveRegion = LiveRegionMode.Polite },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            CircularProgressIndicator()
                            Spacer(Modifier.width(TTSpacing.md))
                            Text("正在搜索组织成员…")
                        }
                    }
                    state.searchError != null -> item {
                        Column(
                            Modifier
                                .padding(horizontal = TTSpacing.lg)
                                .semantics { liveRegion = LiveRegionMode.Polite },
                        ) {
                            Text(state.searchError.orEmpty(), color = MaterialTheme.colorScheme.error)
                            TextButton(onClick = viewModel::retry) { Text("重试") }
                        }
                    }
                    state.members.isEmpty() -> item {
                        Text(
                            text = ConversationSessionSharePresentation.emptyRecipientsMessage(state.query),
                            modifier = Modifier
                                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md)
                                .semantics { liveRegion = LiveRegionMode.Polite },
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    else -> items(state.members, key = { it.userId }) { member ->
                        ShareRecipientRow(
                            member = member,
                            selected = member.userId == state.selectedUserId,
                            enabled = !state.isSubmitting,
                            onClick = { viewModel.selectRecipient(member.userId) },
                        )
                    }
                }
            }
            item { HorizontalDivider() }
            item {
                Text(
                    text = "对方可以",
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                    style = MaterialTheme.typography.titleMedium,
                )
            }
            items(ConversationSessionShareMode.entries) { mode ->
                ShareModeRow(
                    mode = mode,
                    selected = mode == state.mode,
                    enabled = !state.isSubmitting,
                    onClick = { viewModel.selectMode(mode) },
                )
            }
            state.error?.takeIf { state.members.isNotEmpty() }?.let { error ->
                item {
                    Text(
                        text = error,
                        modifier = Modifier.padding(horizontal = TTSpacing.lg),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
            item {
                Button(
                    onClick = viewModel::submit,
                    enabled = state.selectedUserId != null && !state.isSubmitting,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                ) {
                    if (state.isSubmitting) {
                        CircularProgressIndicator()
                    } else {
                        Text(if (state.mode.isContinuation) "发送任务续接" else "发送共享卡")
                    }
                }
            }
        }
    }
}

@Composable
private fun ShareRecipientRow(
    member: OrganizationMember,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(
                selected = selected,
                enabled = enabled,
                role = Role.RadioButton,
                onClick = onClick,
            )
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.Person, contentDescription = null)
        Spacer(Modifier.width(TTSpacing.sm))
        Column(Modifier.weight(1f)) {
            Text(
                ConversationSessionSharePresentation.memberDisplayName(member),
                fontWeight = FontWeight.Medium,
            )
            ConversationSessionSharePresentation.recipientSubtitle(member)?.let { subtitle ->
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        RadioButton(selected = selected, onClick = null, enabled = enabled)
    }
}

@Composable
private fun ShareModeRow(
    mode: ConversationSessionShareMode,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = when (mode) {
                ConversationSessionShareMode.VIEW -> Icons.Default.Visibility
                ConversationSessionShareMode.COLLABORATE -> Icons.Default.Group
                ConversationSessionShareMode.CONTINUE -> Icons.Default.AccountTree
            },
            contentDescription = null,
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Column(Modifier.weight(1f)) {
            Text(mode.title, fontWeight = FontWeight.Medium)
            Text(mode.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        RadioButton(selected = selected, onClick = onClick, enabled = enabled)
    }
}

@Composable
private fun ShareSuccess(response: ImSessionShareResponse, onDismiss: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Icon(Icons.Default.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Text("共享成功", style = MaterialTheme.typography.titleLarge)
        Text(
            text = response.messageId?.let { "共享卡已发送到私信（消息 #$it）。" } ?: "共享卡已发送到私信。",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = if (response.canChat) "权限：实时协作" else "权限：实时查看",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(onClick = onDismiss) { Text("完成") }
    }
}

@Composable
private fun ContinuationSuccess(
    continuation: ImSessionContinuationDetail,
    onDismiss: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(TTSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Icon(Icons.Default.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Text("转交成功", style = MaterialTheme.typography.titleLarge)
        Text(
            text = "已发送 ${continuation.snapshotTurnCount} 轮冻结上下文，对方将创建独立新任务。",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = "任务续接不会授予你的原任务权限。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(onClick = onDismiss) { Text("完成") }
    }
}
