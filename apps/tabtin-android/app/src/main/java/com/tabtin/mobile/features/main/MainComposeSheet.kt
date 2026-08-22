package com.tabtin.mobile.features.main

import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.TabMemoApi
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.ConversationDraftScope
import com.tabtin.mobile.data.model.ConversationDraftSnapshot
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import com.tabtin.mobile.data.model.MessageBlock
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.memo.MemoCreateRequest
import com.tabtin.mobile.data.repository.ConversationDraftInput
import com.tabtin.mobile.data.repository.ConversationDraftSessionCoordinator
import com.tabtin.mobile.data.repository.ConversationDraftStore
import com.tabtin.mobile.features.workbench.ResourceReference
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val COMPOSE_PREFS = "tabtin_compose"
private const val KEY_LAST_AGENT_ID = "last_agent_id"
private const val KEY_LAST_WORKSPACE_ID = "last_workspace_id"

internal data class MainComposeUiState(
    val isSending: Boolean = false,
    val isSaving: Boolean = false,
    val errorMessage: String? = null,
    val memoSaved: Boolean = false,
)

internal sealed interface MainComposeEvent {
    data class ChatPrepared(
        val session: ChatSession,
        val space: Space,
    ) : MainComposeEvent
    data object MemoSaved : MainComposeEvent
}

@HiltViewModel
internal class MainComposeViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val draftSessionCoordinator: ConversationDraftSessionCoordinator,
    private val conversationDraftStore: ConversationDraftStore,
    private val tabMemoApi: TabMemoApi,
) : ViewModel() {
    private val _uiState = MutableStateFlow(MainComposeUiState())
    val uiState: StateFlow<MainComposeUiState> = _uiState.asStateFlow()

    private val _restoredDraft = MutableStateFlow<ConversationDraftSnapshot?>(null)
    val restoredDraft: StateFlow<ConversationDraftSnapshot?> = _restoredDraft.asStateFlow()

    private val _events = MutableSharedFlow<MainComposeEvent>(extraBufferCapacity = 1)
    val events: SharedFlow<MainComposeEvent> = _events.asSharedFlow()

    fun clearTransientState() {
        _uiState.update { it.copy(errorMessage = null, memoSaved = false) }
    }

    fun restoreDraft(workspace: Space?, projectId: String? = null) {
        _restoredDraft.value = workspace?.let { space ->
            conversationDraftScope(space, projectId)?.let(conversationDraftStore::load)
        }
    }

    fun createChat(
        workspace: Space,
        prompt: String,
        resourceReferences: List<ResourceReference> = emptyList(),
        agentId: String,
        projectId: String? = null,
    ) {
        if (_uiState.value.isSending || _uiState.value.isSaving) return
        val trimmed = prompt.trim()
        if (trimmed.isEmpty() && resourceReferences.isEmpty()) {
            _uiState.update { it.copy(errorMessage = context.getString(R.string.compose_empty_content)) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isSending = true, errorMessage = null, memoSaved = false) }
            try {
                val payload = buildDraftMessagePayload(context, trimmed, resourceReferences)
                val scope = conversationDraftScope(workspace, projectId)
                    ?: throw IllegalArgumentException("请先选择有效的执行 Workspace")
                // 恢复草稿里已冻结的运行设置；prepareSession 也会从 store 再合并一次。
                val priorDraft = conversationDraftStore.load(scope)
                val prepared = draftSessionCoordinator.prepareSession(
                    executionSpace = workspace,
                    input = ConversationDraftInput(
                        scope = scope,
                        agentId = agentId,
                        text = payload.text,
                        runtimeConfiguration = ConversationRuntimeConfiguration(),
                        contextTierId = priorDraft?.contextTierId,
                        thinkingMode = priorDraft?.thinkingMode,
                        blocks = payload.blocks,
                    ),
                )
                rememberComposeSelection(context, agentId, workspace.id)
                _events.tryEmit(MainComposeEvent.ChatPrepared(prepared.session, workspace))
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSending = false,
                        errorMessage = e.message ?: context.getString(R.string.compose_send_failed),
                    )
                }
                return@launch
            }
            _uiState.update { it.copy(isSending = false) }
        }
    }

    fun saveMemo(workspace: Space, content: String) {
        if (_uiState.value.isSending || _uiState.value.isSaving) return
        val trimmed = content.trim()
        if (trimmed.isEmpty()) {
            _uiState.update { it.copy(errorMessage = context.getString(R.string.compose_empty_content)) }
            return
        }
        if (workspace.organizationId.isBlank()) {
            _uiState.update { it.copy(errorMessage = context.getString(R.string.memo_select_workspace_first)) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isSaving = true, errorMessage = null, memoSaved = false) }
            try {
                tabMemoApi.createMemo(
                    MemoCreateRequest(
                        organizationId = workspace.organizationId,
                        spaceId = workspace.id,
                        contentMarkdown = trimmed,
                        source = "manual",
                    ),
                ).unwrap()
                rememberComposeSelection(context, agentId = null, workspaceId = workspace.id)
                _uiState.update { it.copy(isSaving = false, memoSaved = true) }
                _events.tryEmit(MainComposeEvent.MemoSaved)
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSaving = false,
                        errorMessage = e.message ?: context.getString(R.string.compose_save_failed),
                    )
                }
            }
        }
    }
}

/** 新建对话 Compose：对齐 Electron 任务设置条——可选 AI分身 + Workspace。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MainComposeSheet(
    agents: List<Agent>,
    workspaces: List<Space>,
    defaultWorkspace: Space?,
    defaultAgentId: String? = null,
    isLoadingAgents: Boolean = false,
    initialResourceReferences: List<ResourceReference> = emptyList(),
    /** 从 IM 指令卡进入时只预填正文，仍由用户选择 AI 分身与 Workspace。 */
    initialDraft: String = "",
    onDismiss: () -> Unit,
    onChatPrepared: (ChatSession, Space) -> Unit,
    viewModel: MainComposeViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val restoredDraft by viewModel.restoredDraft.collectAsState()
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences(COMPOSE_PREFS, Context.MODE_PRIVATE) }
    var text by rememberSaveable(initialDraft) { mutableStateOf(initialDraft) }
    var selectedAgentId by rememberSaveable(defaultAgentId) {
        mutableStateOf(defaultAgentId ?: prefs.getString(KEY_LAST_AGENT_ID, null))
    }
    // 有明确入口 Workspace（当前现场 / 资源委托）时优先它，避免被上次选择盖掉。
    var selectedWorkspaceId by rememberSaveable(defaultWorkspace?.id) {
        mutableStateOf(defaultWorkspace?.id ?: prefs.getString(KEY_LAST_WORKSPACE_ID, null))
    }
    var restoredDraftId by rememberSaveable { mutableStateOf<String?>(null) }
    var showAgentPicker by rememberSaveable { mutableStateOf(false) }
    var showWorkspacePicker by rememberSaveable { mutableStateOf(false) }
    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current

    // 与 ProjectTaskComposerSheet 对齐：钉 TT Surface，避免 M3 surfaceContainerLow 脏色。
    val canvas = ttColor(TTColors.Surface, TTColors.Dark.Surface)
    val subtle = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    val border = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    val textPrimary = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    val textSecondary = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    val iconSecondary = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary)
    val chipShape = RoundedCornerShape(12.dp)

    val selectedAgent = agents.firstOrNull { it.id == selectedAgentId }
        ?: agents.firstOrNull()
    val selectedWorkspace = workspaces.firstOrNull { it.id == selectedWorkspaceId }
        ?: defaultWorkspace
        ?: workspaces.firstOrNull()

    LaunchedEffect(agents, workspaces, defaultWorkspace?.id) {
        if (selectedAgentId == null || agents.none { it.id == selectedAgentId }) {
            selectedAgentId = agents.firstOrNull()?.id
        }
        if (selectedWorkspaceId == null || workspaces.none { it.id == selectedWorkspaceId }) {
            selectedWorkspaceId = defaultWorkspace?.id
                ?: prefs.getString(KEY_LAST_WORKSPACE_ID, null)
                ?: workspaces.firstOrNull()?.id
        }
    }

    LaunchedEffect(selectedWorkspace?.id) {
        viewModel.restoreDraft(selectedWorkspace)
    }

    LaunchedEffect(restoredDraft?.draftId) {
        val draft = restoredDraft ?: return@LaunchedEffect
        if (draft.draftId == restoredDraftId) return@LaunchedEffect
        text = draft.text
        selectedAgentId = draft.agentId
        restoredDraftId = draft.draftId
    }

    val canSend = (text.trim().isNotEmpty() || initialResourceReferences.isNotEmpty()) &&
        selectedAgent != null &&
        selectedWorkspace != null &&
        !uiState.isSaving &&
        !uiState.isSending
    val canSaveMemo = text.trim().isNotEmpty() &&
        selectedWorkspace != null &&
        !uiState.isSaving &&
        !uiState.isSending

    LaunchedEffect(Unit) {
        viewModel.clearTransientState()
        delay(250)
        runCatching { focusRequester.requestFocus() }
    }

    LaunchedEffect(Unit) {
        viewModel.events.collect { event ->
            when (event) {
                is MainComposeEvent.ChatPrepared -> onChatPrepared(event.session, event.space)
                MainComposeEvent.MemoSaved -> {
                    text = ""
                    onDismiss()
                }
            }
        }
    }

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(),
        containerColor = canvas,
        contentColor = textPrimary,
        scrimColor = ttColor(TTColors.OverlayBackground, TTColors.Dark.OverlayBackground),
    ) {
        TTSheetColumn {
            TopAppBar(
                title = { Text(stringResource(R.string.compose_title)) },
                navigationIcon = {
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_close))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    titleContentColor = textPrimary,
                    navigationIconContentColor = textPrimary,
                ),
            )

            Text(
                text = stringResource(R.string.compose_task_setup),
                style = MaterialTheme.typography.labelMedium,
                color = textSecondary,
                modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
            )

            when {
                isLoadingAgents && agents.isEmpty() -> {
                    Row(
                        modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.size(TTSpacing.sm))
                        Text(
                            text = stringResource(R.string.common_loading),
                            color = textSecondary,
                        )
                    }
                }
                agents.isEmpty() -> {
                    Text(
                        text = stringResource(R.string.compose_no_agent),
                        modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                        color = textSecondary,
                    )
                }
                workspaces.isEmpty() -> {
                    Text(
                        text = stringResource(R.string.compose_no_workspace),
                        modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                        color = textSecondary,
                    )
                }
                else -> {
                    ComposeTaskSetupChip(
                        label = stringResource(R.string.compose_pick_agent_label),
                        value = selectedAgent?.uiName().orEmpty(),
                        labelColor = textSecondary,
                        valueColor = textPrimary,
                        iconTint = iconSecondary,
                        containerColor = subtle,
                        borderColor = border,
                        shape = chipShape,
                        leading = {
                            TTAvatar(name = selectedAgent?.uiName().orEmpty(), size = 24.dp)
                        },
                        contentDescription = stringResource(R.string.compose_change_agent),
                        onClick = {
                            focusManager.clearFocus()
                            showAgentPicker = true
                        },
                    )
                    ComposeTaskSetupChip(
                        label = stringResource(R.string.compose_pick_workspace_label),
                        value = selectedWorkspace?.name.orEmpty(),
                        labelColor = textSecondary,
                        valueColor = textPrimary,
                        iconTint = iconSecondary,
                        containerColor = subtle,
                        borderColor = border,
                        shape = chipShape,
                        leading = {
                            Icon(
                                Icons.Default.Folder,
                                contentDescription = null,
                                modifier = Modifier.size(20.dp),
                                tint = iconSecondary,
                            )
                        },
                        contentPadding = PaddingValues(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                        contentDescription = stringResource(R.string.compose_change_workspace),
                        onClick = {
                            focusManager.clearFocus()
                            showWorkspacePicker = true
                        },
                    )
                }
            }

            TextField(
                value = text,
                onValueChange = { text = it },
                placeholder = {
                    Text(
                        stringResource(R.string.compose_placeholder),
                        color = textSecondary,
                    )
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 120.dp, max = 200.dp)
                    .padding(horizontal = TTSpacing.lg)
                    .focusRequester(focusRequester),
                enabled = !uiState.isSending && !uiState.isSaving,
                shape = chipShape,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = subtle,
                    unfocusedContainerColor = subtle,
                    disabledContainerColor = subtle,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    disabledIndicatorColor = Color.Transparent,
                    cursorColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    focusedTextColor = textPrimary,
                    unfocusedTextColor = textPrimary,
                ),
            )

            if (initialResourceReferences.isNotEmpty()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    initialResourceReferences.forEach { ref ->
                        Text(
                            text = ref.label,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            color = textSecondary,
                        )
                    }
                }
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
            ) {
                IconButton(enabled = false, onClick = {}) {
                    Icon(Icons.Default.Mic, contentDescription = stringResource(R.string.compose_voice_coming_soon))
                }
                Spacer(Modifier.weight(1f))
                OutlinedButton(
                    onClick = { selectedWorkspace?.let { viewModel.saveMemo(it, text) } },
                    enabled = canSaveMemo,
                ) {
                    if (uiState.isSaving) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Text(stringResource(R.string.compose_save_as_memo))
                    }
                }
                Button(
                    onClick = {
                        val agent = selectedAgent ?: return@Button
                        val workspace = selectedWorkspace ?: return@Button
                        viewModel.createChat(
                            workspace = workspace,
                            prompt = text,
                            resourceReferences = initialResourceReferences,
                            agentId = agent.id,
                        )
                    },
                    enabled = canSend,
                ) {
                    if (uiState.isSending) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.size(TTSpacing.xs))
                        Text(stringResource(R.string.compose_send_as_chat))
                    }
                }
            }
        }
    }

    if (showAgentPicker) {
        AlertDialog(
            onDismissRequest = { showAgentPicker = false },
            containerColor = canvas,
            title = { Text(stringResource(R.string.compose_pick_agent_title)) },
            text = {
                LazyColumn {
                    items(agents, key = { it.id }) { agent ->
                        Surface(
                            onClick = {
                                selectedAgentId = agent.id
                                prefs.edit().putString(KEY_LAST_AGENT_ID, agent.id).apply()
                                showAgentPicker = false
                            },
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = TTSpacing.sm),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                TTAvatar(name = agent.uiName(), size = 32.dp)
                                Spacer(Modifier.size(TTSpacing.md))
                                Text(
                                    text = agent.uiName(),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    fontWeight = if (agent.id == selectedAgent?.id) {
                                        FontWeight.SemiBold
                                    } else {
                                        FontWeight.Normal
                                    },
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { showAgentPicker = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    if (showWorkspacePicker) {
        AlertDialog(
            onDismissRequest = { showWorkspacePicker = false },
            containerColor = canvas,
            title = { Text(stringResource(R.string.compose_pick_workspace_title)) },
            text = {
                LazyColumn {
                    items(workspaces, key = { it.id }) { workspace ->
                        Surface(
                            onClick = {
                                selectedWorkspaceId = workspace.id
                                prefs.edit().putString(KEY_LAST_WORKSPACE_ID, workspace.id).apply()
                                showWorkspacePicker = false
                            },
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = TTSpacing.sm),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(
                                    Icons.Default.Folder,
                                    contentDescription = null,
                                    modifier = Modifier.size(28.dp),
                                )
                                Spacer(Modifier.size(TTSpacing.md))
                                Text(
                                    text = workspace.name,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    fontWeight = if (workspace.id == selectedWorkspace?.id) {
                                        FontWeight.SemiBold
                                    } else {
                                        FontWeight.Normal
                                    },
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { showWorkspacePicker = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    uiState.errorMessage?.let { error ->
        AlertDialog(
            onDismissRequest = viewModel::clearTransientState,
            containerColor = canvas,
            title = { Text(stringResource(R.string.common_loading_failed)) },
            text = { Text(error) },
            confirmButton = {
                TextButton(onClick = viewModel::clearTransientState) {
                    Text(stringResource(R.string.common_confirm))
                }
            },
        )
    }
}

@Composable
private fun ComposeTaskSetupChip(
    label: String,
    value: String,
    labelColor: Color,
    valueColor: Color,
    iconTint: Color,
    containerColor: Color,
    borderColor: Color,
    shape: RoundedCornerShape,
    leading: @Composable () -> Unit,
    contentPadding: PaddingValues = PaddingValues(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
    contentDescription: String,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
        shape = shape,
        color = containerColor,
        border = BorderStroke(0.5.dp, borderColor),
    ) {
        Row(
            modifier = Modifier.padding(contentPadding),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text = label, color = labelColor)
            Spacer(Modifier.size(TTSpacing.sm))
            leading()
            Spacer(Modifier.size(TTSpacing.xs))
            Text(
                text = value,
                color = valueColor,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Icon(
                Icons.Default.ArrowDropDown,
                contentDescription = contentDescription,
                tint = iconTint,
            )
        }
    }
}

private fun Agent.uiName(): String =
    displayName?.trim()?.takeIf { it.isNotEmpty() } ?: name

private data class DraftMessagePayload(
    val text: String,
    val blocks: List<MessageBlock>,
)

/** 与 ConversationViewModel.sendWithReferences 使用同一正文约定，但在建会话前就冻结它。 */
private fun buildDraftMessagePayload(
    context: Context,
    prompt: String,
    references: List<ResourceReference>,
): DraftMessagePayload {
    val trimmed = prompt.trim()
    val blocks = references.mapNotNull { it.toMessageBlock() }
    val text = if (references.isNotEmpty()) {
        val labels = references.joinToString("、") { it.label }
        if (trimmed.isEmpty()) context.getString(R.string.chat_ref_about, labels)
        else context.getString(R.string.chat_ref_about_with_content, labels, trimmed)
    } else {
        trimmed
    }
    return DraftMessagePayload(text = text, blocks = blocks)
}

private fun conversationDraftScope(space: Space, projectId: String?): ConversationDraftScope? {
    val workspaceId = when {
        space.isExecutionSpace -> space.id
        else -> space.executionSpaceId?.takeIf { it.isNotBlank() }
    } ?: return null
    return ConversationDraftScope(
        organizationId = space.organizationId,
        workspaceId = workspaceId,
        projectId = projectId ?: space.id.takeIf { space.isProject },
    ).takeIf { it.isValid() }
}

private fun rememberComposeSelection(
    context: Context,
    agentId: String?,
    workspaceId: String?,
) {
    context.getSharedPreferences(COMPOSE_PREFS, Context.MODE_PRIVATE).edit().apply {
        if (!agentId.isNullOrBlank()) putString(KEY_LAST_AGENT_ID, agentId)
        if (!workspaceId.isNullOrBlank()) putString(KEY_LAST_WORKSPACE_ID, workspaceId)
        apply()
    }
}
