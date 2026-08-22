package com.tabtin.mobile.features.workspace

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CreditCard
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Switch
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.features.profile.SettingsHomeDivider
import com.tabtin.mobile.features.profile.SettingsHomeRow
import com.tabtin.mobile.features.profile.SettingsHomeSection
import com.tabtin.mobile.features.profile.SettingsReadOnlyRow
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun OrganizationSettingsScreen(
    viewModel: OrganizationSettingsViewModel,
    initialSection: String? = null,
    onBack: () -> Unit,
    onNavigateToUsage: (String) -> Unit,
    onNavigateToWallet: (String) -> Unit,
    onNavigateToTrash: (String) -> Unit,
    onNavigateToImConversation: (conversationId: String, title: String) -> Unit = { _, _ -> },
) {
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val state by viewModel.uiState.collectAsState()
    val ws = state.organization

    var selectedSection by remember(ws?.id, initialSection) {
        mutableStateOf(initialSection)
    }

    LaunchedEffect(Unit) {
        viewModel.toastEvent.collect { toast ->
            snackbar.showSnackbar(context.getString(toast.messageRes))
        }
    }

    BackHandler(enabled = selectedSection != null) {
        selectedSection = null
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(organizationSettingsTitle(selectedSection)) },
                navigationIcon = {
                    IconButton(onClick = {
                        if (selectedSection != null) selectedSection = null else onBack()
                    }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        when {
            state.isLoading -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
                return@Scaffold
            }
            ws == null -> {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .padding(horizontal = TTSpacing.xl),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        stringResource(R.string.ws_load_failed),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.error,
                    )
                    state.error?.takeIf { it.isNotBlank() }?.let { detail ->
                        Spacer(Modifier.height(TTSpacing.sm))
                        Text(
                            detail,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.height(TTSpacing.md))
                    TextButton(onClick = { viewModel.retryLoadOrganization() }) {
                        Text(stringResource(R.string.common_retry))
                    }
                }
                return@Scaffold
            }
        }

        val isPersonal = ws.isPersonal
        LaunchedEffect(selectedSection, ws.id) {
            when (selectedSection) {
                "ai" -> viewModel.loadLlmCatalog()
                else -> Unit
            }
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when (selectedSection) {
                null -> OrganizationSettingsHome(
                    ws = ws,
                    isPersonal = isPersonal,
                    memberCount = state.members.size.takeIf { it > 0 } ?: ws.memberCount,
                    invitationCount = state.invitations.size,
                    onOpenSection = { selectedSection = it },
                    onOpenUsage = { onNavigateToUsage(ws.id) },
                    onOpenWallet = { onNavigateToWallet(ws.id) },
                )
                "basic" -> BasicInfoTab(
                    ws = ws,
                    canEdit = state.canEdit,
                    isOwner = state.isOwner,
                    isMutating = state.isMutating,
                    isUploadingLogo = state.isUploadingLogo,
                    members = state.members,
                    onSave = viewModel::updateOrganization,
                    onSelectLogo = { uri ->
                        viewModel.uploadOrganizationLogo(uri, context.contentResolver) { success, message ->
                            scope.launch {
                                snackbar.showSnackbar(
                                    if (success) context.getString(R.string.ws_avatar_updated)
                                    else message ?: context.getString(R.string.ws_avatar_upload_failed)
                                )
                            }
                        }
                    },
                    onDelete = { viewModel.deleteOrganization(onBack) },
                    onLeave = { viewModel.leaveOrganization(onBack) },
                    onTransfer = viewModel::transferOwnership,
                )
                "ai" -> AICapabilitiesTab(
                    settings = ws.settings,
                    canEdit = state.canEdit,
                    canManage = state.canManage,
                    isSavingTools = state.isMutating,
                    isSettingDefault = state.isSettingDefaultModel,
                    llmLoading = state.llmCatalogLoading,
                    llmError = state.llmCatalogError,
                    modelsResponse = state.llmModelsResponse,
                    onRetryLlm = viewModel::loadLlmCatalog,
                    onSetDefaultModel = viewModel::setOrganizationDefaultModel,
                    onSaveTools = viewModel::updateCapabilities,
                )
                "members" -> MembersTab(
                    members = state.members,
                    operatorRole = state.currentUserRole,
                    isPersonal = isPersonal,
                    isMutating = state.isMutating,
                    onUpdateRole = viewModel::updateMemberRole,
                    onRemoveMember = viewModel::removeMember,
                    currentUserId = viewModel.currentUserId,
                )
                "recovery" -> OrganizationRecoveryTab(onOpenTrash = { onNavigateToTrash(ws.id) })
                "invite" -> InviteTab(
                    invitations = state.invitations,
                    canManage = state.canManage,
                    isPersonal = isPersonal,
                    isMutating = state.isMutating,
                    generatedLink = state.generatedLink,
                    onEmailInvite = viewModel::createEmailInvitation,
                    onPhoneInvite = viewModel::createPhoneInvitation,
                    onLinkInvite = viewModel::createLinkInvitation,
                    onDirectInvite = viewModel::createDirectInvitation,
                    onCancelInvitation = viewModel::cancelInvitation,
                    onClearLink = viewModel::clearGeneratedLink,
                    onShowSnackbar = { msg -> scope.launch { snackbar.showSnackbar(msg) } },
                )
                "externalContacts" -> ExternalContactsTab(
                    organizationId = ws.id,
                    onOpenConversation = onNavigateToImConversation,
                )
            }
        }
    }
}

@Composable
private fun organizationSettingsTitle(section: String?): String = when (section) {
    "basic" -> stringResource(R.string.ws_basic_info)
    "ai" -> stringResource(R.string.ws_ai_capabilities)
    "members" -> stringResource(R.string.ws_members)
    "invite" -> stringResource(R.string.ws_invite)
    "recovery" -> stringResource(R.string.org_settings_data_recovery)
    "externalContacts" -> stringResource(R.string.external_contacts_title)
    else -> stringResource(R.string.ws_settings)
}

@Composable
private fun OrganizationSettingsHome(
    ws: Organization,
    isPersonal: Boolean,
    memberCount: Int?,
    invitationCount: Int,
    onOpenSection: (String) -> Unit,
    onOpenUsage: () -> Unit,
    onOpenWallet: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
    ) {
        OrganizationSettingsSummaryCard(ws = ws, memberCount = memberCount)

        SettingsHomeSection(title = stringResource(R.string.ws_settings)) {
            SettingsHomeRow(
                icon = Icons.Default.Edit,
                title = stringResource(R.string.ws_basic_info),
                subtitle = stringResource(R.string.org_settings_basic_subtitle),
                trailing = ws.name,
                onClick = { onOpenSection("basic") },
            )
            SettingsHomeDivider()
            SettingsHomeRow(
                icon = Icons.Default.Group,
                title = stringResource(R.string.ws_members),
                subtitle = stringResource(R.string.org_settings_members_subtitle),
                trailing = memberCount?.let { stringResource(R.string.ws_member_count, it) },
                onClick = { onOpenSection("members") },
            )
            if (!isPersonal) {
                SettingsHomeDivider()
                SettingsHomeRow(
                    icon = Icons.Default.PersonAdd,
                    title = stringResource(R.string.ws_invite),
                    subtitle = stringResource(R.string.org_settings_invite_subtitle),
                    trailing = invitationCount.takeIf { it > 0 }?.toString(),
                    onClick = { onOpenSection("invite") },
                )
            }
            SettingsHomeDivider()
            SettingsHomeRow(
                icon = Icons.Default.PersonAdd,
                title = stringResource(R.string.external_contacts_title),
                subtitle = stringResource(R.string.external_contacts_description),
                onClick = { onOpenSection("externalContacts") },
            )
            SettingsHomeDivider()
            SettingsHomeRow(
                icon = Icons.Default.SmartToy,
                title = stringResource(R.string.ws_ai_capabilities),
                subtitle = stringResource(R.string.org_settings_ai_subtitle),
                onClick = { onOpenSection("ai") },
            )
            SettingsHomeDivider()
            SettingsReadOnlyRow(
                icon = Icons.Default.Info,
                title = stringResource(R.string.org_settings_spaces),
                value = (ws.spaceCount ?: 0).toString(),
            )
        }

        SettingsHomeSection(title = stringResource(R.string.org_settings_billing_data)) {
            SettingsHomeRow(
                icon = Icons.Default.CreditCard,
                title = stringResource(R.string.ws_wallet),
                subtitle = stringResource(R.string.ws_wallet_transactions_subtitle),
                onClick = onOpenWallet,
            )
            SettingsHomeDivider()
            SettingsHomeRow(
                icon = Icons.Default.CreditCard,
                title = stringResource(R.string.ws_usage),
                subtitle = stringResource(R.string.org_settings_usage_subtitle),
                onClick = onOpenUsage,
            )
            SettingsHomeDivider()
            SettingsHomeRow(
                icon = Icons.Default.Delete,
                title = stringResource(R.string.org_settings_data_recovery),
                subtitle = stringResource(R.string.org_settings_data_recovery_desc),
                onClick = { onOpenSection("recovery") },
            )
        }
    }
}

@Composable
private fun OrganizationSettingsSummaryCard(ws: Organization, memberCount: Int?) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(16.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(TTSpacing.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            com.tabtin.mobile.ui.components.TTAvatar(
                name = ws.name,
                imageUrl = ws.logoUrl,
                size = 72.dp,
                shape = RoundedCornerShape(18.dp),
                fallbackText = ws.avatarFallbackText,
            )
            Text(
                ws.name,
                style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            ws.description?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                memberCount?.let {
                    OrganizationSettingsPill(stringResource(R.string.ws_member_count, it))
                }
                ws.spaceCount?.let {
                    OrganizationSettingsPill(stringResource(R.string.ws_workspace_count, it))
                }
                if (ws.isDefault == true) {
                    OrganizationSettingsPill(stringResource(R.string.ws_default_tag))
                }
            }
        }
    }
}

@Composable
private fun OrganizationSettingsPill(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f), RoundedCornerShape(50))
            .padding(horizontal = TTSpacing.sm, vertical = 3.dp),
    )
}

@Composable
private fun OrganizationRecoveryTab(onOpenTrash: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(TTSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Text(
            stringResource(R.string.org_settings_data_recovery_desc),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        FinanceNavRow(
            title = stringResource(R.string.trash_title),
            onClick = onOpenTrash,
        )
    }
}

@Composable
private fun FinanceNavRow(
    title: String,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun AICapabilitiesTab(
    settings: com.tabtin.mobile.data.model.OrganizationSettings?,
    canEdit: Boolean,
    canManage: Boolean,
    isSavingTools: Boolean,
    isSettingDefault: Boolean,
    llmLoading: Boolean,
    llmError: String?,
    modelsResponse: com.tabtin.mobile.data.model.ModelsResponse?,
    onRetryLlm: () -> Unit,
    onSetDefaultModel: (String) -> Unit,
    onSaveTools: (Boolean) -> Unit,
) {
    var enableTools by remember(settings?.enableTools) { mutableStateOf(settings?.enableTools ?: true) }
    val toolsDirty = enableTools != (settings?.enableTools ?: true)

    val defaultId = modelsResponse?.defaultModelId?.takeIf { it.isNotBlank() }
    val models = modelsResponse?.models.orEmpty().filter { it.isActive != false }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(TTSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
    ) {
        Text(
            stringResource(R.string.ws_models_title),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        when {
            llmLoading && modelsResponse == null -> {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(modifier = Modifier.size(32.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.height(TTSpacing.sm))
                        Text(
                            stringResource(R.string.ws_models_loading),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            llmError != null && modelsResponse == null -> {
                Text(llmError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                TextButton(onClick = onRetryLlm) {
                    Text(stringResource(R.string.common_retry))
                }
            }
            models.isEmpty() -> {
                Text(
                    stringResource(R.string.ws_models_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            else -> {
                var byokTooltipScope by remember { mutableStateOf<ByokBadgeScope?>(null) }
                models.forEach { model ->
                    val isDefault = defaultId != null && model.id == defaultId
                    val byokScope = byokScopeFromApi(model.providerScope)
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(enabled = canManage && !isSettingDefault && !isDefault) {
                                onSetDefaultModel(model.id)
                            }
                            .padding(vertical = TTSpacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    model.title,
                                    style = MaterialTheme.typography.bodyLarge,
                                )
                                if (isDefault) {
                                    Spacer(Modifier.width(TTSpacing.sm))
                                    Text(
                                        stringResource(R.string.ws_models_default),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                            val providerLine = model.providerDisplayName?.takeIf { it.isNotBlank() }
                                ?: model.providerName?.takeIf { it.isNotBlank() }
                            if (providerLine != null) {
                                Text(
                                    "${stringResource(R.string.ws_models_provider)} · $providerLine",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        if (byokScope != null) {
                            ByokBadge(
                                scope = byokScope,
                                onClick = { byokTooltipScope = byokScope },
                            )
                            Spacer(Modifier.width(TTSpacing.sm))
                        }
                        if (isSettingDefault && !isDefault) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else if (isDefault) {
                            Icon(
                                Icons.Filled.Check,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }

                byokTooltipScope?.let { scope ->
                    AlertDialog(
                        onDismissRequest = { byokTooltipScope = null },
                        title = { Text(stringResource(R.string.ws_models_byok_info_title)) },
                        text = { Text(stringResource(scope.tooltipRes)) },
                        confirmButton = {
                            TextButton(onClick = { byokTooltipScope = null }) {
                                Text(stringResource(R.string.common_close))
                            }
                        },
                    )
                }
            }
        }

        HorizontalDivider()

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(stringResource(R.string.ws_ai_tools_label), style = MaterialTheme.typography.bodyLarge)
                Text(
                    stringResource(R.string.ws_ai_tools_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = enableTools,
                onCheckedChange = { enableTools = it },
                enabled = canEdit,
            )
        }

        if (canEdit && toolsDirty) {
            Button(
                onClick = { onSaveTools(enableTools) },
                enabled = !isSavingTools,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.common_save))
            }
        }
    }
}

// MARK: - BYOK Badge（路线 B）

/// 模型选择器 BYOK 角标的 scope 分类（v0.1）。
///
/// 数据流：API（`/api/services/llm/admin/...`）返回 `provider_scope: "global" | "organization" | "user"` →
/// [byokScopeFromApi] 把字符串归一成本枚举。
///
/// 路线 B（宪法 v0.1 §3 BYOK 边界）：仅 BYOK 域（organization / user）显示 Badge；global 不展示
/// （视觉降噪）。颜色与宪法 07 §1.2.2 Provider 列表 Scope Badge 同色谱：橙 / 紫。
///
/// SYNC: apps/tabtin-ios/.../WorkspaceSettingsScreen.swift `ByokBadgeScope`
private enum class ByokBadgeScope(
    val tint: Color,
    @androidx.annotation.StringRes val tooltipRes: Int,
) {
    ORGANIZATION(
        tint = Color(0xFFF28A1A), // 橙
        tooltipRes = R.string.ws_models_byok_organization_tooltip,
    ),
    USER(
        tint = Color(0xFF8C4DD9), // 紫
        tooltipRes = R.string.ws_models_byok_user_tooltip,
    ),
}

/// 把 API 返回的 `provider_scope` 字符串归一为 [ByokBadgeScope]。
///
/// 仅 'organization' / 'user' 视为 BYOK，其他（含 'global' / null / 未知值）一律返回 null
/// → 不展示 Badge。
///
/// SYNC: apps/tabtin-ios/.../WorkspaceSettingsScreen.swift `byokScope(for:)`
private fun byokScopeFromApi(scope: String?): ByokBadgeScope? = when (scope?.lowercase()) {
    "organization" -> ByokBadgeScope.ORGANIZATION
    "user" -> ByokBadgeScope.USER
    else -> null
}

@Composable
private fun ByokBadge(
    scope: ByokBadgeScope,
    onClick: () -> Unit,
) {
    val label = stringResource(R.string.ws_models_byok_badge)
    val tooltipText = stringResource(scope.tooltipRes)
    Box(
        modifier = Modifier
            .clickable(onClick = onClick)
            .background(
                color = scope.tint.copy(alpha = 0.12f),
                shape = RoundedCornerShape(50),
            )
            .border(
                border = BorderStroke(1.dp, scope.tint.copy(alpha = 0.4f)),
                shape = RoundedCornerShape(50),
            )
            .padding(horizontal = TTSpacing.sm, vertical = 2.dp)
            .semantics { contentDescription = "$label · $tooltipText" },
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = scope.tint,
        )
    }
}
