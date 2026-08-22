package com.tabtin.mobile.features.space

import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AgentTemplate
import com.tabtin.mobile.data.model.DeactivatedAgent
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter

/** 工作 Tab「AI分身」：手机端可完成云端身份配置；本地执行现场仍留在 Workspace。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MyAgentsScreen(
    viewModel: MyAgentsViewModel,
    showCreate: Boolean,
    onCreateRequested: () -> Unit,
    onDismissCreate: () -> Unit,
    onOpenDetail: (String) -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val actionErrorMessage = state.actionErrorRes?.let { stringResource(it) }
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val snackbar = remember { SnackbarHostState() }
    var selectedAgent by remember { mutableStateOf<Agent?>(null) }
    var editingAgent by remember { mutableStateOf<Agent?>(null) }
    var deactivatingAgent by remember { mutableStateOf<Agent?>(null) }
    var permanentlyDeletingAgent by remember { mutableStateOf<DeactivatedAgent?>(null) }
    var searchQuery by remember { mutableStateOf("") }
    var isPullRefreshing by remember { mutableStateOf(false) }
    val dismissSearchKeyboard: () -> Unit = {
        focusManager.clearFocus()
        keyboardController?.hide()
    }
    val filteredAgents = remember(state.agents, searchQuery) {
        filterByVisibleAgentName(state.agents, searchQuery) { it.visibleName() }
    }
    val filteredDeactivatedAgents = remember(state.deactivatedAgents, searchQuery) {
        filterByVisibleAgentName(state.deactivatedAgents, searchQuery) { it.name }
    }

    LaunchedEffect(state.actionErrorRes) {
        actionErrorMessage?.let {
            snackbar.showSnackbar(it)
            viewModel.clearActionError()
        }
    }

    LaunchedEffect(state.isRefreshing) {
        if (!state.isRefreshing) isPullRefreshing = false
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            TabSearchField(
                query = searchQuery,
                placeholder = stringResource(R.string.my_agents_search),
                onQueryChange = { searchQuery = it },
                modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
            )
            PullToRefreshBox(
                isRefreshing = isPullRefreshing && state.isRefreshing,
                onRefresh = {
                    isPullRefreshing = true
                    viewModel.refresh()
                },
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(Unit) {
                        detectTapGestures(onTap = { dismissSearchKeyboard() })
                    },
            ) {
                when {
                    state.isLoading && state.agents.isEmpty() && state.deactivatedAgents.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }

                state.errorRes != null && state.agents.isEmpty() && state.deactivatedAgents.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                text = stringResource(state.errorRes!!),
                                color = MaterialTheme.colorScheme.error,
                            )
                            Spacer(Modifier.height(TTSpacing.lg))
                            Button(onClick = { viewModel.load() }) {
                                Text(stringResource(R.string.common_retry))
                            }
                        }
                    }
                }

                state.agents.isEmpty() && state.deactivatedAgents.isEmpty() -> {
                    EmptyAgentsState(onCreate = onCreateRequested)
                }

                filteredAgents.isEmpty() && filteredDeactivatedAgents.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(
                            stringResource(R.string.my_agents_search_empty),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                else -> {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(
                            start = TTSpacing.md,
                            end = TTSpacing.md,
                            top = TTSpacing.sm,
                            bottom = 88.dp,
                        ),
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    ) {
                        items(filteredAgents, key = { it.id }) { agent ->
                            MyAgentRow(
                                agent = agent,
                                relativeTime = RelativeTimeFormatter.format(context, agent.updatedAt),
                                onClick = { onOpenDetail(agent.id) },
                            )
                        }
                        if (filteredDeactivatedAgents.isNotEmpty()) {
                            item(key = "deactivated-header") {
                                Text(
                                    text = stringResource(R.string.my_agents_deactivated_title),
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.padding(top = TTSpacing.lg, bottom = TTSpacing.xs),
                                )
                            }
                            items(filteredDeactivatedAgents, key = { "deactivated-${it.id}" }) { agent ->
                                DeactivatedAgentRow(
                                    agent = agent,
                                    isRestoring = state.isMutating,
                                    onRestore = { viewModel.reactivateAgent(agent.id) },
                                    onPermanentDelete = { permanentlyDeletingAgent = agent },
                                )
                            }
                        }
                    }
                }
            }
        }
        }

        SnackbarHost(
            hostState = snackbar,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 76.dp),
        )
    }

    if (showCreate) {
        AgentCreateDialog(
            templates = state.templates,
            ownerName = viewModel.ownerName,
            isLoadingTemplates = state.isLoadingTemplates,
            isSaving = state.isMutating,
            onLoadTemplates = viewModel::loadTemplates,
            onDismiss = onDismissCreate,
            onCreate = { name, templateId, avatarKey ->
                viewModel.createAgent(name, templateId, avatarKey) { created ->
                    onDismissCreate()
                    onOpenDetail(created.id)
                }
            },
        )
    }

    permanentlyDeletingAgent?.let { agent ->
        AlertDialog(
            onDismissRequest = { permanentlyDeletingAgent = null },
            title = { Text(stringResource(R.string.my_agents_permanent_delete_title)) },
            text = { Text(stringResource(R.string.my_agents_permanent_delete_body, agent.name)) },
            confirmButton = {
                TextButton(
                    enabled = !state.isMutating,
                    onClick = {
                        viewModel.permanentlyDeleteAgent(agent.id) {
                            permanentlyDeletingAgent = null
                        }
                    },
                ) {
                    Text(
                        stringResource(R.string.my_agents_permanent_delete),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { permanentlyDeletingAgent = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

@Composable
private fun EmptyAgentsState(onCreate: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(horizontal = TTSpacing.xxl),
        ) {
            Icon(
                imageVector = Icons.Default.SmartToy,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                modifier = Modifier.size(40.dp),
            )
            Spacer(Modifier.height(TTSpacing.md))
            Text(
                text = stringResource(R.string.my_agents_empty_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(TTSpacing.sm))
            Text(
                text = stringResource(R.string.my_agents_empty_description),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(TTSpacing.lg))
            Button(onClick = onCreate) {
                Text(stringResource(R.string.my_agents_create))
            }
        }
    }
}

@Composable
private fun DeactivatedAgentRow(
    agent: DeactivatedAgent,
    isRestoring: Boolean,
    onRestore: () -> Unit,
    onPermanentDelete: () -> Unit,
) {
    val context = LocalContext.current
    val relativeTime = agent.deactivatedAt?.let { RelativeTimeFormatter.format(context, it) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        TTAvatar(name = agent.name, size = 40.dp)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = agent.name,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = if (relativeTime.isNullOrBlank()) {
                    stringResource(R.string.my_agents_deactivated_status)
                } else {
                    stringResource(R.string.my_agents_deactivated_at, relativeTime)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }
        TextButton(onClick = onRestore, enabled = !isRestoring) {
            if (isRestoring) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            } else {
                Text(stringResource(R.string.my_agents_reactivate))
            }
        }
        TextButton(onClick = onPermanentDelete, enabled = !isRestoring) {
            Text(
                stringResource(R.string.my_agents_permanent_delete),
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

private fun AgentTemplate.uiName(ownerName: String): String =
    name.replace("{owner}", ownerName)

@Composable
private fun MyAgentRow(
    agent: Agent,
    relativeTime: String?,
    onClick: () -> Unit,
) {
    val title = agent.visibleName()

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AgentIdentityAvatar(
            name = title,
            avatarKey = agent.settings?.avatarKey,
            avatarUrl = agent.settings?.avatarUrl,
            size = 44.dp,
        )
        Spacer(Modifier.width(TTSpacing.md))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (!relativeTime.isNullOrBlank()) {
                    Spacer(Modifier.width(TTSpacing.xs))
                    Text(
                        text = relativeTime,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                        maxLines = 1,
                    )
                }
            }
        }
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
            modifier = Modifier.size(20.dp),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgentCreateDialog(
    templates: List<AgentTemplate>,
    ownerName: String,
    isLoadingTemplates: Boolean,
    isSaving: Boolean,
    onLoadTemplates: () -> Unit,
    onDismiss: () -> Unit,
    onCreate: (String, String?, String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var selectedTemplateId by remember { mutableStateOf<String?>(null) }
    var avatarPreset by remember { mutableStateOf(AgentAvatarPreset.GENERAL_ASSISTANT) }

    LaunchedEffect(Unit) { onLoadTemplates() }

    TTBottomSheet(
        onDismissRequest = { if (!isSaving) onDismiss() },
        sheetState = rememberTTSheetState(confirmValueChange = { !isSaving }),
    ) {
        TTSheetColumn(
            modifier = Modifier
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xxxl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Text(
                stringResource(R.string.my_agents_create),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                stringResource(R.string.my_agents_create_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.my_agents_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            AgentAvatarPresetPicker(
                selection = avatarPreset,
                onSelect = { avatarPreset = it },
                enabled = !isSaving,
            )
            Text(stringResource(R.string.my_agents_template), style = MaterialTheme.typography.titleSmall)
            if (isLoadingTemplates && templates.isEmpty()) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
            } else {
                Column(Modifier.fillMaxWidth()) {
                        TemplateOption(
                            title = stringResource(R.string.my_agents_blank),
                            subtitle = stringResource(R.string.my_agents_blank_hint),
                            selected = selectedTemplateId == null,
                            onClick = { selectedTemplateId = null },
                        )
                        templates.forEach { template ->
                            TemplateOption(
                                title = template.uiName(ownerName),
                                subtitle = template.tagline,
                                selected = selectedTemplateId == template.id,
                                onClick = {
                                    selectedTemplateId = template.id
                                    if (name.isBlank()) name = template.uiName(ownerName)
                                },
                            )
                        }
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onDismiss, enabled = !isSaving) {
                    Text(stringResource(R.string.common_cancel))
                }
                Spacer(Modifier.width(TTSpacing.sm))
                Button(
                    enabled = name.isNotBlank() && !isSaving,
                    onClick = { onCreate(name, selectedTemplateId, avatarPreset.key) },
                ) {
                    Text(stringResource(R.string.my_agents_create_action))
                }
            }
        }
    }
}

@Composable
private fun TemplateOption(
    title: String,
    subtitle: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Spacer(Modifier.width(TTSpacing.sm))
        Column {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            if (subtitle.isNotBlank()) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AgentEditDialog(
    agent: Agent,
    isSaving: Boolean,
    onDismiss: () -> Unit,
    onSave: (String, String, String) -> Unit,
) {
    var name by remember(agent.id) { mutableStateOf(agent.visibleName()) }
    var rules by remember(agent.id) { mutableStateOf(agent.customRules) }
    var avatarPreset by remember(agent.id) {
        mutableStateOf(AgentAvatarPreset.from(agent.settings?.avatarKey) ?: AgentAvatarPreset.GENERAL_ASSISTANT)
    }

    TTBottomSheet(
        onDismissRequest = { if (!isSaving) onDismiss() },
        sheetState = rememberTTSheetState(confirmValueChange = { !isSaving }),
    ) {
        TTSheetColumn(
            modifier = Modifier
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xxxl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Text(
                stringResource(R.string.my_agents_edit),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                AgentIdentityAvatar(
                    name = name,
                    avatarKey = avatarPreset.key,
                    avatarUrl = agent.settings?.avatarUrl,
                    size = 48.dp,
                )
                Spacer(Modifier.width(TTSpacing.md))
                Text(
                    text = stringResource(R.string.my_agents_avatar),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            AgentAvatarPresetPicker(
                selection = avatarPreset,
                onSelect = { avatarPreset = it },
                enabled = !isSaving,
            )
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.my_agents_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = rules,
                onValueChange = { rules = it },
                label = { Text(stringResource(R.string.my_agents_persona_rules)) },
                placeholder = { Text(stringResource(R.string.my_agents_persona_placeholder)) },
                minLines = 6,
                maxLines = 12,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                stringResource(R.string.my_agents_persona_scope_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onDismiss, enabled = !isSaving) {
                    Text(stringResource(R.string.common_cancel))
                }
                Spacer(Modifier.width(TTSpacing.sm))
                Button(enabled = name.isNotBlank() && !isSaving, onClick = { onSave(name, rules, avatarPreset.key) }) {
                    Text(stringResource(R.string.common_save))
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AgentAvatarPresetPicker(
    selection: AgentAvatarPreset,
    onSelect: (AgentAvatarPreset) -> Unit,
    enabled: Boolean,
) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        Text(
            text = stringResource(R.string.my_agents_avatar),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            AgentAvatarPreset.entries.forEach { preset ->
                val selected = preset == selection
                Surface(
                    onClick = { onSelect(preset) },
                    enabled = enabled,
                    modifier = Modifier.size(42.dp),
                    shape = CircleShape,
                    color = if (selected) {
                        ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.14f)
                    } else {
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.58f)
                    },
                ) {
                    androidx.compose.foundation.Image(
                        painter = painterResource(preset.drawableRes),
                        contentDescription = stringResource(preset.labelRes),
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.padding(3.dp).clip(CircleShape),
                    )
                }
            }
        }
    }
}
