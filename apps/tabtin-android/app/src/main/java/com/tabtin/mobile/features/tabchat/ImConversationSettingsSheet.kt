package com.tabtin.mobile.features.tabchat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import android.widget.Toast
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ImAgentSummary
import com.tabtin.mobile.data.im.ExternalContact
import com.tabtin.mobile.data.im.ImConversationDetail
import com.tabtin.mobile.data.im.ImConversationAgentBinding
import com.tabtin.mobile.data.im.ImConversationLabel
import com.tabtin.mobile.data.im.ImConversationTitlePolicy
import com.tabtin.mobile.data.im.ImMemberDisplayPolicy
import com.tabtin.mobile.data.im.ImMessage
import com.tabtin.mobile.data.im.ImMessageType
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.navigation.navigateOnce
import com.tabtin.mobile.navigation.popBackStackSafely
import com.tabtin.mobile.ui.components.IdentityColorAvatar
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.launch

/**
 * 会话设置是独立导航目的地；成员、邀请和资产使用其内部 NavHost 继续 push。
 * 主屏布局对齐 Electron `ConversationDetailPanel`：英雄区 + 免打扰/置顶磁贴 + 清空记录卡。
 */
@Composable
internal fun ImConversationSettingsDestination(
    onBack: () -> Unit,
    onLeaveConversation: () -> Unit,
    viewModel: ImConversationViewModel,
) {
    val detail by viewModel.detail.collectAsState()
    val conversations by viewModel.conversations.collectAsState()
    val organizationMembers by viewModel.organizationMembers.collectAsState()
    val agentBindings by viewModel.agentBindings.collectAsState()
    val labelLibrary by viewModel.conversationLabelLibrary.collectAsState()
    val conversation = conversations.firstOrNull { it.id == viewModel.conversationId }
    val conversationDetail = detail
    if (conversationDetail == null) {
        SettingsFrame(title = "聊天信息", onBack = onBack) {
            Text("正在加载…", modifier = Modifier.padding(TTSpacing.lg))
        }
    } else {
        ImConversationSettingsScreen(
            detail = conversationDetail,
            currentUserId = viewModel.currentUserId,
            peerUserId = conversation?.dmPeerUserId,
            isMuted = conversation?.isMuted ?: false,
            isPinned = conversation?.pinned ?: false,
            catalogIsExternal = conversation?.isExternal,
            organizationMembers = organizationMembers,
            agentBindings = agentBindings,
            labelLibrary = labelLibrary,
            onUpdateAvatar = viewModel::updateGroupAvatar,
            onRename = viewModel::renameConversation,
            onToggleMute = viewModel::toggleMute,
            onTogglePin = viewModel::togglePin,
            onInvite = viewModel::inviteMembers,
            onLoadExternalContacts = viewModel::loadExternalContacts,
            onInviteExternal = viewModel::inviteExternalMembers,
            onSearchAgents = viewModel::searchAgents,
            onLoadAgentWorkspaces = viewModel::loadAgentWorkspaces,
            onAddAgent = viewModel::addAgentToConversation,
            onUpdateAgentWorkspace = viewModel::updateAgentWorkspace,
            onRemoveMember = viewModel::removeMember,
            onRemoveAgent = viewModel::removeAgent,
            onCreateLabel = viewModel::createConversationLabel,
            onUpdateLabel = viewModel::updateConversationLabel,
            onDeleteLabel = viewModel::deleteConversationLabel,
            onSetLabelAssigned = viewModel::setConversationLabelAssigned,
            onClearHistory = viewModel::clearHistory,
            onLeave = viewModel::leaveGroup,
            onLoadAssets = viewModel::loadConversationAssets,
            onBack = onBack,
            onLeaveConversation = onLeaveConversation,
        )
    }
}

@Composable
private fun ImConversationSettingsScreen(
    detail: ImConversationDetail,
    currentUserId: String?,
    peerUserId: String?,
    isMuted: Boolean,
    isPinned: Boolean,
    catalogIsExternal: Boolean?,
    organizationMembers: List<OrganizationMember>,
    agentBindings: List<ImConversationAgentBinding>,
    labelLibrary: List<ImConversationLabel>,
    onUpdateAvatar: suspend (android.net.Uri?) -> Result<String>,
    onRename: suspend (String) -> Result<Unit>,
    onToggleMute: suspend () -> Result<Boolean>,
    onTogglePin: suspend () -> Result<Boolean>,
    onInvite: suspend (List<String>) -> Result<Int>,
    onLoadExternalContacts: suspend () -> Result<List<ExternalContact>>,
    onInviteExternal: suspend (List<String>) -> Result<Int>,
    onSearchAgents: suspend (String) -> Result<List<ImAgentSummary>>,
    onLoadAgentWorkspaces: suspend () -> Result<List<com.tabtin.mobile.data.model.Space>>,
    onAddAgent: suspend (ImAgentSummary, String?) -> Result<Unit>,
    onUpdateAgentWorkspace: suspend (String, String) -> Result<Unit>,
    onRemoveMember: suspend (com.tabtin.mobile.data.im.ImMember) -> Result<Unit>,
    onRemoveAgent: suspend (com.tabtin.mobile.data.im.ImMember) -> Result<Unit>,
    onCreateLabel: suspend (String, String) -> Result<ImConversationLabel>,
    onUpdateLabel: suspend (String, String, String) -> Result<Unit>,
    onDeleteLabel: suspend (String) -> Result<Unit>,
    onSetLabelAssigned: suspend (String, Boolean) -> Result<Unit>,
    onClearHistory: suspend () -> Result<Unit>,
    onLeave: suspend () -> Result<Unit>,
    onLoadAssets: suspend () -> List<ImMessage>,
    onBack: () -> Unit,
    onLeaveConversation: () -> Unit,
) {
    val navController = rememberNavController()
    var renameDraft by remember(detail.name) { mutableStateOf(detail.name) }
    var showRename by remember { mutableStateOf(false) }
    var showAgentPicker by remember { mutableStateOf(false) }
    var rebindingAgentId by remember { mutableStateOf<String?>(null) }
    var memberPendingRemoval by remember { mutableStateOf<com.tabtin.mobile.data.im.ImMember?>(null) }
    var showLeaveConfirm by remember { mutableStateOf(false) }
    var showClearConfirm by remember { mutableStateOf(false) }
    var localMuted by remember(detail.id) { mutableStateOf<Boolean?>(null) }
    var localPinned by remember(detail.id) { mutableStateOf<Boolean?>(null) }
    var localAvatarUrl by remember(detail.id) { mutableStateOf<String?>(null) }
    var isUpdatingAvatar by remember { mutableStateOf(false) }
    var isMutating by remember { mutableStateOf(false) }
    var externalContacts by remember(detail.id) { mutableStateOf<List<ExternalContact>>(emptyList()) }
    var externalContactsLoading by remember(detail.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val isGroup = detail.isGroup
    val memberIds = detail.members.mapNotNull { it.userId }.toSet()
    val externalCandidates = externalContacts.filter { it.peerUserId !in memberIds }
    val displayedMuted = localMuted ?: isMuted
    val displayedPinned = localPinned ?: isPinned
    val title = if (isGroup) "群聊信息" else "聊天信息"
    val canEditAvatar = ImConversationAvatarPolicy.canEditGroupAvatar(detail, currentUserId)
    val canAddAgent = ImGroupAgentMembershipPolicy.canAddAgent(
        detail = detail,
        currentUserId = currentUserId,
        catalogIsExternal = catalogIsExternal,
    )
    val agentJoinedMessage = stringResource(R.string.im_settings_agent_joined)
    val displayedAvatarUrl = localAvatarUrl ?: detail.avatarUrl
    val displayName = if (isGroup) {
        detail.name.trim().ifBlank { "群聊" }
    } else {
        ImMemberDisplayPolicy.directMessageDisplayName(
            members = detail.members,
            currentUserId = currentUserId,
            peerUserId = peerUserId,
            organizationMembers = organizationMembers,
        )
    }
    val avatarPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null || isUpdatingAvatar) return@rememberLauncherForActivityResult
        scope.launch {
            isUpdatingAvatar = true
            onUpdateAvatar(uri)
                .onSuccess { localAvatarUrl = it }
                .onFailure {
                    Toast.makeText(context, it.message ?: "群头像更新失败", Toast.LENGTH_LONG).show()
                }
            isUpdatingAvatar = false
        }
    }

    NavHost(
        navController = navController,
        startDestination = "main",
        modifier = Modifier.fillMaxSize(),
    ) {
        composable("main") {
            SettingsFrame(title = title, onBack = onBack) {
                SettingsMain(
                    detail = detail,
                    currentUserId = currentUserId,
                    peerUserId = peerUserId,
                    displayName = displayName,
                    isMuted = displayedMuted,
                    isPinned = displayedPinned,
                    avatarUrl = displayedAvatarUrl,
                    canEditAvatar = canEditAvatar,
                    isUpdatingAvatar = isUpdatingAvatar,
                    isMutating = isMutating,
                    onToggleMute = {
                        if (isMutating) return@SettingsMain
                        scope.launch {
                            isMutating = true
                            onToggleMute()
                                .onSuccess { localMuted = it }
                                .onFailure {
                                    Toast.makeText(context, "免打扰设置失败", Toast.LENGTH_SHORT).show()
                                }
                            isMutating = false
                        }
                    },
                    onTogglePin = {
                        if (isMutating) return@SettingsMain
                        scope.launch {
                            isMutating = true
                            onTogglePin()
                                .onSuccess { localPinned = it }
                                .onFailure {
                                    Toast.makeText(context, "置顶设置失败", Toast.LENGTH_SHORT).show()
                                }
                            isMutating = false
                        }
                    },
                    onPickAvatar = {
                        avatarPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    },
                    onRemoveAvatar = {
                        if (isUpdatingAvatar) return@SettingsMain
                        scope.launch {
                            isUpdatingAvatar = true
                            onUpdateAvatar(null)
                                .onSuccess { localAvatarUrl = it }
                                .onFailure {
                                    Toast.makeText(context, it.message ?: "群头像移除失败", Toast.LENGTH_LONG).show()
                                }
                            isUpdatingAvatar = false
                        }
                    },
                    onMembers = { navController.navigateOnce("members") },
                    onInvite = { navController.navigateOnce("invite") },
                    onAddAgent = if (canAddAgent) {
                        { showAgentPicker = true }
                    } else null,
                    onRename = { showRename = true },
                    onAssets = { navController.navigateOnce("assets") },
                    onLabels = { navController.navigateOnce("labels") },
                    onClearHistory = { showClearConfirm = true },
                    onLeave = { showLeaveConfirm = true },
                )
            }
        }
        composable("members") {
            SettingsFrame(title = "成员（${detail.memberCount}）", onBack = { navController.popBackStackSafely() }) {
                MemberList(
                    detail = detail,
                    currentUserId = currentUserId,
                    members = detail.members,
                    agentBindings = agentBindings,
                    onRebindAgent = { rebindingAgentId = it },
                    onRemove = { memberPendingRemoval = it },
                    isMutating = isMutating,
                )
            }
        }
        composable("invite") {
            SettingsFrame(title = "邀请成员", onBack = { navController.popBackStackSafely() }) {
                LaunchedEffect(detail.id, detail.isExternal) {
                    if (!detail.isExternal || externalContactsLoading) return@LaunchedEffect
                    externalContactsLoading = true
                    onLoadExternalContacts()
                        .onSuccess { externalContacts = it }
                        .onFailure {
                            Toast.makeText(context, it.message ?: "外部联系人加载失败", Toast.LENGTH_LONG).show()
                        }
                    externalContactsLoading = false
                }
                InviteList(
                    candidates = organizationMembers.filter { it.userId !in memberIds && it.userId != currentUserId },
                    externalCandidates = externalCandidates,
                    showExternalContacts = detail.isExternal,
                    isLoadingExternalContacts = externalContactsLoading,
                    onInvite = { userId ->
                        scope.launch {
                            if (isMutating) return@launch
                            isMutating = true
                            onInvite(listOf(userId))
                                .onSuccess { navController.popBackStackSafely() }
                                .onFailure {
                                    Toast.makeText(context, it.message ?: "邀请失败", Toast.LENGTH_LONG).show()
                                }
                            isMutating = false
                        }
                    },
                    onInviteExternal = { contactId ->
                        scope.launch {
                            if (isMutating) return@launch
                            isMutating = true
                            onInviteExternal(listOf(contactId))
                                .onSuccess { navController.popBackStackSafely() }
                                .onFailure {
                                    Toast.makeText(context, it.message ?: "邀请失败", Toast.LENGTH_LONG).show()
                                }
                            isMutating = false
                        }
                    },
                    enabled = !isMutating,
                )
            }
        }
        composable("assets") {
            SettingsFrame(title = "会话资产", onBack = { navController.popBackStackSafely() }) {
                AssetList(onLoadAssets = onLoadAssets)
            }
        }
        composable("labels") {
            SettingsFrame(title = "会话标签", onBack = { navController.popBackStackSafely() }) {
                ConversationLabelsPanel(
                    labels = labelLibrary,
                    assignedLabelIds = detail.labels.map { it.id }.toSet(),
                    onCreate = onCreateLabel,
                    onUpdate = onUpdateLabel,
                    onDelete = onDeleteLabel,
                    onSetAssigned = onSetLabelAssigned,
                )
            }
        }
    }

    if (showAgentPicker && canAddAgent) {
        AgentMembershipPickerSheet(
            existingAgentIds = detail.agentMemberIds,
            onSearch = onSearchAgents,
            onLoadWorkspaces = onLoadAgentWorkspaces,
            onPick = onAddAgent,
            onPicked = {
                Toast.makeText(context, agentJoinedMessage, Toast.LENGTH_SHORT).show()
            },
            onDismiss = { showAgentPicker = false },
        )
    }

    val rebindingId = rebindingAgentId
    val currentBinding = agentBindings.firstOrNull { it.agentId == rebindingId }
    if (rebindingId != null && currentBinding != null) {
        AgentWorkspaceBindingSheet(
            agentId = rebindingId,
            agentName = detail.members.firstOrNull { it.agentId == rebindingId }
                ?.let { ImMemberDisplayPolicy.displayName(it) }
                ?: "Agent",
            currentWorkspaceId = currentBinding.workspaceId,
            onLoadWorkspaces = onLoadAgentWorkspaces,
            onPickWorkspace = { workspaceId -> onUpdateAgentWorkspace(rebindingId, workspaceId) },
            onDismiss = { rebindingAgentId = null },
        )
    }

    val removalTarget = memberPendingRemoval
    if (removalTarget != null) {
        val displayName = ImMemberDisplayPolicy.displayName(removalTarget)
        AlertDialog(
            onDismissRequest = { if (!isMutating) memberPendingRemoval = null },
            title = { Text(if (removalTarget.isAgent) "移除 Agent" else "移除成员") },
            text = { Text("确定将 $displayName 移出当前群聊吗？") },
            confirmButton = {
                TextButton(
                    enabled = !isMutating,
                    onClick = {
                        scope.launch {
                            isMutating = true
                            val result = if (removalTarget.isAgent) {
                                onRemoveAgent(removalTarget)
                            } else {
                                onRemoveMember(removalTarget)
                            }
                            result
                                .onSuccess { memberPendingRemoval = null }
                                .onFailure {
                                    Toast.makeText(context, it.message ?: "移除失败", Toast.LENGTH_LONG).show()
                                }
                            isMutating = false
                        }
                    },
                ) { Text("移除") }
            },
            dismissButton = {
                TextButton(
                    enabled = !isMutating,
                    onClick = { memberPendingRemoval = null },
                ) { Text("取消") }
            },
        )
    }

    if (showRename) {
        AlertDialog(
            onDismissRequest = { showRename = false },
            title = { Text("修改群聊名称") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
                    OutlinedTextField(
                        value = renameDraft,
                        onValueChange = { renameDraft = it },
                        singleLine = true,
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End,
                    ) {
                        TextButton(onClick = { showRename = false }) { Text("取消") }
                        TextButton(onClick = {
                            val trimmed = renameDraft.trim()
                            if (trimmed.isEmpty()) {
                                Toast.makeText(context, "群聊名称不能为空", Toast.LENGTH_SHORT).show()
                            } else {
                                scope.launch {
                                    onRename(trimmed)
                                        .onSuccess { showRename = false }
                                        .onFailure {
                                            Toast.makeText(context, "群聊名称保存失败", Toast.LENGTH_SHORT).show()
                                        }
                                }
                            }
                        }) {
                            Text("保存")
                        }
                    }
                }
            },
            confirmButton = {},
        )
    }
    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            title = { Text("清空聊天记录？") },
            text = { Text("将清除你在此会话中的本地聊天记录。") },
            confirmButton = {
                TextButton(onClick = {
                    showClearConfirm = false
                    scope.launch {
                        onClearHistory().onFailure {
                            Toast.makeText(context, "清空失败", Toast.LENGTH_SHORT).show()
                        }
                    }
                }) { Text("清空") }
            },
            dismissButton = { TextButton(onClick = { showClearConfirm = false }) { Text("取消") } },
        )
    }
    if (showLeaveConfirm) {
        AlertDialog(
            onDismissRequest = { showLeaveConfirm = false },
            title = { Text("退出群聊？") },
            text = { Text("退出后将不再接收该群消息。") },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch {
                        onLeave().onSuccess { onLeaveConversation() }
                    }
                }) { Text("退出") }
            },
            dismissButton = { TextButton(onClick = { showLeaveConfirm = false }) { Text("取消") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsFrame(title: String, onBack: () -> Unit, content: @Composable () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) { content() }
    }
}

@Composable
private fun SettingsMain(
    detail: ImConversationDetail,
    currentUserId: String?,
    peerUserId: String?,
    displayName: String,
    isMuted: Boolean,
    isPinned: Boolean,
    avatarUrl: String,
    canEditAvatar: Boolean,
    isUpdatingAvatar: Boolean,
    isMutating: Boolean,
    onToggleMute: () -> Unit,
    onTogglePin: () -> Unit,
    onPickAvatar: () -> Unit,
    onRemoveAvatar: () -> Unit,
    onMembers: () -> Unit,
    onInvite: () -> Unit,
    onAddAgent: (() -> Unit)?,
    onRename: () -> Unit,
    onAssets: () -> Unit,
    onLabels: () -> Unit,
    onClearHistory: () -> Unit,
    onLeave: () -> Unit,
) {
    val isGroup = detail.isGroup
    val addAgentLabel = stringResource(R.string.im_settings_add_agent)
    val subtitle = when {
        isGroup && detail.memberCount > 0 -> "${detail.memberCount} 位成员"
        isGroup -> "群聊"
        else -> "私聊"
    }
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val mutedFg = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    val subtleBg = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    val border = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    val canvas = MaterialTheme.colorScheme.surface
    val cardShape = RoundedCornerShape(12.dp)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(bottom = TTSpacing.xl),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(top = TTSpacing.xl, bottom = TTSpacing.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Box(contentAlignment = Alignment.Center) {
                IdentityColorAvatar(
                    name = displayName,
                    seed = if (isGroup) detail.id else (peerUserId ?: detail.id),
                    imageUrl = avatarUrl.takeIf { it.isNotBlank() },
                    size = 80.dp,
                    group = isGroup,
                    modifier = Modifier.then(
                        if (canEditAvatar && !isUpdatingAvatar) Modifier.clickable(onClick = onPickAvatar)
                        else Modifier,
                    ),
                )
                if (canEditAvatar) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .size(26.dp)
                            .clip(androidx.compose.foundation.shape.CircleShape)
                            .background(canvas)
                            .border(1.dp, border, androidx.compose.foundation.shape.CircleShape)
                            .clickable(enabled = !isUpdatingAvatar, onClick = onPickAvatar),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Filled.CameraAlt,
                            contentDescription = "修改群头像",
                            tint = accent,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
                if (isUpdatingAvatar) {
                    Box(
                        modifier = Modifier
                            .size(80.dp)
                            .clip(androidx.compose.foundation.shape.CircleShape)
                            .background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.28f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(30.dp),
                            color = androidx.compose.ui.graphics.Color.White,
                            strokeWidth = 3.dp,
                        )
                    }
                }
            }
            if (canEditAvatar && avatarUrl.isNotBlank()) {
                TextButton(onClick = onRemoveAvatar, enabled = !isUpdatingAvatar) {
                    Text("移除群头像", color = MaterialTheme.colorScheme.error)
                }
            }
            Text(
                text = displayName,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = mutedFg,
            )
        }

        HorizontalDivider(color = border.copy(alpha = 0.35f))

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(top = TTSpacing.lg, bottom = TTSpacing.md),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SettingsTile(
                title = "免打扰",
                icon = if (isMuted) Icons.Filled.NotificationsOff else Icons.Filled.Notifications,
                active = isMuted,
                enabled = !isMutating,
                accent = accent,
                mutedFg = mutedFg,
                subtleBg = subtleBg,
                modifier = Modifier.weight(1f),
                onClick = onToggleMute,
            )
            SettingsTile(
                title = "置顶",
                icon = Icons.Filled.PushPin,
                active = isPinned,
                enabled = !isMutating,
                accent = accent,
                mutedFg = mutedFg,
                subtleBg = subtleBg,
                modifier = Modifier.weight(1f),
                onClick = onTogglePin,
            )
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp)
                .clip(cardShape)
                .border(BorderStroke(1.dp, border.copy(alpha = 0.45f)), cardShape)
                .background(subtleBg.copy(alpha = 0.55f))
                .clickable(onClick = onClearHistory)
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Filled.Delete,
                contentDescription = null,
                tint = mutedFg,
                modifier = Modifier.size(18.dp),
            )
            Spacer(modifier = Modifier.width(10.dp))
            Text(
                text = "清空聊天记录",
                style = MaterialTheme.typography.bodyLarge,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
        }

        Spacer(modifier = Modifier.height(TTSpacing.md))
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp)
                .clip(cardShape)
                .border(BorderStroke(1.dp, border.copy(alpha = 0.45f)), cardShape)
                .background(subtleBg.copy(alpha = 0.55f)),
        ) {
            SettingsRow("会话标签", onLabels)
        }

        if (isGroup) {
            Spacer(modifier = Modifier.height(TTSpacing.md))
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp)
                    .clip(cardShape)
                    .border(BorderStroke(1.dp, border.copy(alpha = 0.45f)), cardShape)
                    .background(subtleBg.copy(alpha = 0.55f)),
            ) {
                SettingsRow("当前成员", onMembers)
                SettingsRow("邀请新成员", onInvite)
                if (onAddAgent != null) {
                    SettingsRow(addAgentLabel, onAddAgent)
                }
                SettingsRow("修改群聊名称", onRename)
                SettingsRow("会话资产", onAssets)
                SettingsRow("退出群聊", onLeave, destructive = true, showChevron = false)
            }
        }
    }
}

private val conversationLabelPalette = listOf(
    "#6b7280",
    "#ef4444",
    "#f59e0b",
    "#10b981",
    "#3b82f6",
    "#8b5cf6",
)

private fun conversationLabelColor(raw: String): Color = runCatching {
    Color(android.graphics.Color.parseColor(raw))
}.getOrDefault(Color(0xFF6B7280))

@Composable
private fun ConversationLabelsPanel(
    labels: List<ImConversationLabel>,
    assignedLabelIds: Set<String>,
    onCreate: suspend (String, String) -> Result<ImConversationLabel>,
    onUpdate: suspend (String, String, String) -> Result<Unit>,
    onDelete: suspend (String) -> Result<Unit>,
    onSetAssigned: suspend (String, Boolean) -> Result<Unit>,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var draftName by remember { mutableStateOf("") }
    var draftColor by remember { mutableStateOf(conversationLabelPalette.first()) }
    var busyLabelId by remember { mutableStateOf<String?>(null) }
    var isCreating by remember { mutableStateOf(false) }
    var editingLabel by remember { mutableStateOf<ImConversationLabel?>(null) }
    var deletingLabel by remember { mutableStateOf<ImConversationLabel?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(TTSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Text("给当前会话添加标签", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = draftName,
            onValueChange = { if (it.length <= 32) draftName = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("新标签名称") },
            singleLine = true,
            trailingIcon = {
                IconButton(
                    enabled = draftName.isNotBlank() && !isCreating,
                    onClick = {
                        scope.launch {
                            isCreating = true
                            onCreate(draftName.trim(), draftColor)
                                .onSuccess { created ->
                                    onSetAssigned(created.id, true)
                                        .onSuccess { draftName = "" }
                                        .onFailure {
                                            Toast.makeText(context, it.message ?: "标签已创建，但添加到会话失败", Toast.LENGTH_LONG).show()
                                        }
                                }
                                .onFailure {
                                    Toast.makeText(context, it.message ?: "创建标签失败", Toast.LENGTH_LONG).show()
                                }
                            isCreating = false
                        }
                    },
                ) {
                    if (isCreating) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else Icon(Icons.Filled.Add, contentDescription = "创建标签")
                }
            },
        )
        ConversationLabelColorPicker(selected = draftColor, onSelect = { draftColor = it })

        if (labels.isEmpty()) {
            Text(
                "还没有自定义标签",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        } else {
            labels.filterNot { it.isSystem }.forEach { label ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(
                        checked = label.id in assignedLabelIds,
                        enabled = busyLabelId == null,
                        onCheckedChange = { assigned ->
                            scope.launch {
                                busyLabelId = label.id
                                onSetAssigned(label.id, assigned).onFailure {
                                    Toast.makeText(context, it.message ?: "会话标签更新失败", Toast.LENGTH_LONG).show()
                                }
                                busyLabelId = null
                            }
                        },
                    )
                    Box(
                        Modifier
                            .size(10.dp)
                            .clip(androidx.compose.foundation.shape.CircleShape)
                            .background(conversationLabelColor(label.color)),
                    )
                    Spacer(Modifier.width(TTSpacing.sm))
                    Column(Modifier.weight(1f)) {
                        Text(label.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (label.conversationCount > 0) {
                            Text(
                                "${label.conversationCount} 个会话",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    IconButton(onClick = { editingLabel = label }, enabled = busyLabelId == null) {
                        Icon(Icons.Filled.Edit, contentDescription = "编辑标签")
                    }
                    IconButton(onClick = { deletingLabel = label }, enabled = busyLabelId == null) {
                        Icon(Icons.Filled.Delete, contentDescription = "删除标签")
                    }
                }
            }
        }
    }

    editingLabel?.let { label ->
        var editName by remember(label.id) { mutableStateOf(label.name) }
        var editColor by remember(label.id) { mutableStateOf(label.color) }
        AlertDialog(
            onDismissRequest = { if (busyLabelId == null) editingLabel = null },
            title = { Text("编辑标签") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
                    OutlinedTextField(
                        value = editName,
                        onValueChange = { if (it.length <= 32) editName = it },
                        label = { Text("标签名称") },
                        singleLine = true,
                    )
                    ConversationLabelColorPicker(selected = editColor, onSelect = { editColor = it })
                }
            },
            confirmButton = {
                TextButton(
                    enabled = editName.isNotBlank() && busyLabelId == null,
                    onClick = {
                        scope.launch {
                            busyLabelId = label.id
                            onUpdate(label.id, editName.trim(), editColor)
                                .onSuccess { editingLabel = null }
                                .onFailure {
                                    Toast.makeText(context, it.message ?: "标签更新失败", Toast.LENGTH_LONG).show()
                                }
                            busyLabelId = null
                        }
                    },
                ) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { editingLabel = null }) { Text("取消") } },
        )
    }

    deletingLabel?.let { label ->
        AlertDialog(
            onDismissRequest = { if (busyLabelId == null) deletingLabel = null },
            title = { Text("删除标签？") },
            text = { Text("“${label.name}”将从所有会话移除。") },
            confirmButton = {
                TextButton(
                    enabled = busyLabelId == null,
                    onClick = {
                        scope.launch {
                            busyLabelId = label.id
                            onDelete(label.id)
                                .onSuccess { deletingLabel = null }
                                .onFailure {
                                    Toast.makeText(context, it.message ?: "标签删除失败", Toast.LENGTH_LONG).show()
                                }
                            busyLabelId = null
                        }
                    },
                ) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deletingLabel = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun ConversationLabelColorPicker(selected: String, onSelect: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
        conversationLabelPalette.forEach { color ->
            val selectedBorder = if (color == selected) 3.dp else 0.dp
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .clip(androidx.compose.foundation.shape.CircleShape)
                    .background(conversationLabelColor(color))
                    .border(selectedBorder, MaterialTheme.colorScheme.onSurface, androidx.compose.foundation.shape.CircleShape)
                    .clickable { onSelect(color) },
            )
        }
    }
}

@Composable
private fun SettingsTile(
    title: String,
    icon: ImageVector,
    active: Boolean,
    enabled: Boolean,
    accent: androidx.compose.ui.graphics.Color,
    mutedFg: androidx.compose.ui.graphics.Color,
    subtleBg: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(12.dp)
    val fg = if (active) accent else mutedFg
    Column(
        modifier = modifier
            .clip(shape)
            .then(
                if (active) {
                    Modifier
                        .background(accent.copy(alpha = 0.10f))
                        .border(BorderStroke(1.dp, accent.copy(alpha = 0.30f)), shape)
                } else {
                    Modifier.background(subtleBg.copy(alpha = 0.85f))
                },
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = fg.copy(alpha = if (enabled) 1f else 0.5f),
            modifier = Modifier.size(20.dp),
        )
        Text(
            text = title,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Medium,
            color = fg.copy(alpha = if (enabled) 1f else 0.5f),
        )
    }
}

@Composable
private fun SettingsRow(
    title: String,
    onClick: () -> Unit,
    destructive: Boolean = false,
    showChevron: Boolean = true,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            color = if (destructive) MaterialTheme.colorScheme.error else ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.weight(1f),
        )
        if (showChevron && !destructive) {
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

@Composable
private fun MemberList(
    detail: ImConversationDetail,
    currentUserId: String?,
    members: List<com.tabtin.mobile.data.im.ImMember>,
    agentBindings: List<ImConversationAgentBinding>,
    onRebindAgent: (String) -> Unit,
    onRemove: (com.tabtin.mobile.data.im.ImMember) -> Unit,
    isMutating: Boolean,
) {
    LazyColumn {
        items(members, key = { it.userId ?: it.agentId ?: it.displayName }) { member ->
            val displayName = ImMemberDisplayPolicy.displayName(member)
            val binding = member.agentId?.let { agentId -> agentBindings.firstOrNull { it.agentId == agentId } }
            val bindingLabel = when {
                !member.isAgent -> "成员"
                binding == null -> "未绑定执行现场"
                binding.isExecutable -> binding.workspaceName.ifBlank { "执行现场" }
                else -> "${binding.workspaceName.ifBlank { "执行现场" }} · 已失效"
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IdentityColorAvatar(
                    name = displayName,
                    seed = member.userId ?: member.agentId,
                    size = 36.dp,
                )
                Column(modifier = Modifier.weight(1f).padding(start = TTSpacing.sm)) {
                    Text(displayName, style = MaterialTheme.typography.bodyLarge)
                    Text(
                        text = bindingLabel,
                        color = if (member.isAgent && binding?.isExecutable != true) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (member.isAgent && binding?.canRebind == true) {
                    TextButton(
                        enabled = !isMutating,
                        onClick = { onRebindAgent(member.agentId) },
                    ) {
                        Text("更换")
                    }
                }
                if (ImConversationMemberManagementPolicy.canRemove(detail, currentUserId, member, binding)) {
                    TextButton(
                        enabled = !isMutating,
                        onClick = { onRemove(member) },
                    ) {
                        Text("移除", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}

@Composable
private fun InviteList(
    candidates: List<OrganizationMember>,
    externalCandidates: List<ExternalContact>,
    showExternalContacts: Boolean,
    isLoadingExternalContacts: Boolean,
    onInvite: (String) -> Unit,
    onInviteExternal: (String) -> Unit,
    enabled: Boolean,
) {
    var query by remember { mutableStateOf("") }
    val filteredCandidates = filterImInviteMembers(candidates, query)
    val filteredExternalCandidates = filterImInviteExternalContacts(externalCandidates, query)
    val hasInviteCandidates = candidates.isNotEmpty() || externalCandidates.isNotEmpty()
    val hasSearchResults = filteredCandidates.isNotEmpty() || filteredExternalCandidates.isNotEmpty()
    Column(modifier = Modifier.fillMaxSize()) {
        TabSearchField(
            query = query,
            onQueryChange = { query = it },
            placeholder = "搜索成员",
            modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
        )
        LazyColumn(modifier = Modifier.weight(1f)) {
            if (!hasInviteCandidates && !isLoadingExternalContacts) {
                item {
                    Text(
                        "暂无可邀请成员",
                        modifier = Modifier.padding(TTSpacing.lg),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else if (!hasSearchResults && !isLoadingExternalContacts) {
                item {
                    Text(
                        "没有匹配的成员",
                        modifier = Modifier.padding(TTSpacing.lg),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (filteredCandidates.isNotEmpty()) {
                item { Text("组织成员", modifier = Modifier.padding(TTSpacing.lg), fontWeight = FontWeight.SemiBold) }
            }
            items(filteredCandidates, key = { it.userId }) { member ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(enabled = enabled) { onInvite(member.userId) }
                        .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IdentityColorAvatar(name = member.displayName, seed = member.userId, size = 36.dp)
                    Text(
                        member.displayName,
                        modifier = Modifier.weight(1f).padding(start = TTSpacing.sm),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text("邀请", color = ttColor(TTColors.Primary, TTColors.Dark.Primary))
                }
            }
            if (showExternalContacts) {
                item {
                    Text("外部联系人", modifier = Modifier.padding(TTSpacing.lg), fontWeight = FontWeight.SemiBold)
                }
                if (isLoadingExternalContacts) {
                    item {
                        Box(modifier = Modifier.fillMaxWidth().padding(TTSpacing.lg), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    }
                }
                items(filteredExternalCandidates, key = { "external:${it.contactId}" }) { contact ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(enabled = enabled) { onInviteExternal(contact.contactId) }
                            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IdentityColorAvatar(name = contact.displayName, seed = contact.peerUserId, size = 36.dp)
                        Column(modifier = Modifier.weight(1f).padding(start = TTSpacing.sm)) {
                            Text(contact.displayName.ifBlank { "外部联系人" }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                contact.peerOrganizationName,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Text("邀请", color = ttColor(TTColors.Primary, TTColors.Dark.Primary))
                    }
                }
            }
        }
    }
}

internal fun filterImInviteMembers(
    candidates: List<OrganizationMember>,
    query: String,
): List<OrganizationMember> {
    val normalizedQuery = query.trim()
    if (normalizedQuery.isEmpty()) return candidates
    return candidates.filter { member ->
        listOfNotNull(
            member.displayName,
            member.user?.nickname,
            member.user?.username,
            member.user?.email,
        ).any { it.contains(normalizedQuery, ignoreCase = true) }
    }
}

internal fun filterImInviteExternalContacts(
    candidates: List<ExternalContact>,
    query: String,
): List<ExternalContact> {
    val normalizedQuery = query.trim()
    if (normalizedQuery.isEmpty()) return candidates
    return candidates.filter { contact ->
        listOf(contact.displayName, contact.peerUserId, contact.peerOrganizationName)
            .any { it.contains(normalizedQuery, ignoreCase = true) }
    }
}

@Composable
private fun AssetList(onLoadAssets: suspend () -> List<ImMessage>) {
    var messages by remember { mutableStateOf<List<ImMessage>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        messages = runCatching { onLoadAssets() }.getOrDefault(emptyList())
        loading = false
    }
    when {
        loading -> Text("正在加载…", modifier = Modifier.padding(TTSpacing.lg))
        messages.isEmpty() -> Text("当前会话暂无共享资产", modifier = Modifier.padding(TTSpacing.lg))
        else -> LazyColumn {
            items(messages, key = { it.id }) { message ->
                val title = message.metadata?.fileName
                    ?: message.resourceCardDisplayName
                    ?: message.content.ifBlank {
                        if (message.messageType == ImMessageType.IMAGE) "图片" else "共享资源"
                    }
                Text(
                    title,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
