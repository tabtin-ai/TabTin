package com.tabtin.mobile.features.space

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.RemoveCircleOutline
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AgentMemoryRecord
import com.tabtin.mobile.data.model.AgentProjectTask
import com.tabtin.mobile.data.model.AgentSkillLink
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.VisibleSkillEntry
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter
import kotlinx.coroutines.launch

private enum class AgentDetailSection {
    MEMORY,
    RECENT_TASKS,
    SKILLS,
}

private enum class AgentMemorySection {
    OVERVIEW,
    RECORDS,
}

internal fun agentMemoryTypeLabelRes(memoryType: String): Int = when (memoryType.trim().lowercase()) {
    "about_you" -> R.string.my_agents_memory_type_about_you
    "insight" -> R.string.my_agents_memory_type_insight
    "task_summary" -> R.string.my_agents_memory_type_task_summary
    "diary" -> R.string.my_agents_memory_type_diary
    else -> R.string.my_agents_memory
}

internal fun shouldUseAgentMemoryTypeLabel(memoryType: String, title: String): Boolean {
    val normalizedTitle = title.trim()
    val normalizedType = memoryType.trim()
    return normalizedTitle.isEmpty() || normalizedTitle.equals(normalizedType, ignoreCase = true)
}

/** AI分身的移动工作台详情。进入时请求 /agents/{id}，不以列表摘要代替详情真源。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun AgentDetailScreen(
    viewModel: AgentDetailViewModel,
    agentsViewModel: MyAgentsViewModel,
    onBack: () -> Unit,
    onOpenChatSession: (
        sessionId: String,
        spaceId: String,
        spaceName: String,
        organizationId: String,
    ) -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val agentsState by agentsViewModel.uiState.collectAsState()
    val actionErrorMessage = state.actionErrorRes?.let { stringResource(it) }
    val agentsActionErrorMessage = agentsState.actionErrorRes?.let { stringResource(it) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val portraitViewModel: UserPortraitViewModel = hiltViewModel()
    var editing by remember { mutableStateOf(false) }
    var deactivating by remember { mutableStateOf(false) }
    var forgetTarget by remember { mutableStateOf<AgentMemoryRecord?>(null) }
    var correctTarget by remember { mutableStateOf<AgentMemoryRecord?>(null) }
    var removeSkillTarget by remember { mutableStateOf<AgentSkillLink?>(null) }
    var showSkillPicker by remember { mutableStateOf(false) }
    var isAttachingSkills by remember { mutableStateOf(false) }

    LaunchedEffect(state.actionErrorRes) {
        actionErrorMessage?.let {
            snackbar.showSnackbar(it)
            viewModel.clearActionError()
        }
    }
    LaunchedEffect(agentsState.actionErrorRes) {
        agentsActionErrorMessage?.let {
            snackbar.showSnackbar(it)
            agentsViewModel.clearActionError()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.common_tab_agents)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val agent = state.agent
        when {
            state.isLoading && agent == null -> Box(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }

            agent == null -> Box(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = stringResource(R.string.my_agents_load_failed),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Spacer(Modifier.height(TTSpacing.sm))
                    TextButton(onClick = viewModel::refresh) { Text(stringResource(R.string.common_retry)) }
                }
            }

            else -> PullToRefreshBox(
                isRefreshing = state.isRefreshing,
                onRefresh = viewModel::refresh,
                modifier = Modifier.fillMaxSize().padding(padding),
            ) {
                AgentDetailContent(
                    agent = agent,
                    state = state,
                    isIdentityMutating = agentsState.isMutating,
                    onEdit = { editing = true },
                    onAddSkill = {
                        showSkillPicker = true
                        viewModel.loadSkillPicker()
                    },
                    onToggleSkill = viewModel::toggleSkill,
                    onRemoveSkill = { removeSkillTarget = it },
                    onForgetMemory = { forgetTarget = it },
                    onCorrectMemory = { correctTarget = it },
                    portraitViewModel = portraitViewModel,
                    onOpenChatSession = onOpenChatSession,
                    onDeactivate = { deactivating = true },
                )
            }
        }
    }

    state.agent?.takeIf { editing }?.let { agent ->
        AgentEditDialog(
            agent = agent,
            isSaving = agentsState.isMutating,
            onDismiss = { editing = false },
            onSave = { name, rules, avatarKey ->
                agentsViewModel.updateAgent(agent.id, name, rules, avatarKey) { updated ->
                    viewModel.applyAgent(updated)
                    editing = false
                }
            },
        )
    }

    state.agent?.takeIf { deactivating }?.let { agent ->
        AlertDialog(
            onDismissRequest = { deactivating = false },
            title = { Text(stringResource(R.string.my_agents_deactivate_title)) },
            text = { Text(stringResource(R.string.my_agents_deactivate_body, agent.detailName())) },
            confirmButton = {
                TextButton(
                    onClick = {
                        agentsViewModel.deactivateAgent(agent.id) {
                            deactivating = false
                            onBack()
                        }
                    },
                    enabled = !agentsState.isMutating,
                ) {
                    Text(
                        text = stringResource(R.string.my_agents_deactivate),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { deactivating = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    forgetTarget?.let { memory ->
        AlertDialog(
            onDismissRequest = { forgetTarget = null },
            title = { Text(stringResource(R.string.my_agents_forget_memory_title)) },
            text = { Text(stringResource(R.string.my_agents_forget_memory_body)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        forgetTarget = null
                        viewModel.forgetMemory(memory)
                    },
                ) {
                    Text(stringResource(R.string.my_agents_forget_memory), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { forgetTarget = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }

    correctTarget?.let { memory ->
        MemoryCorrectDialog(
            memory = memory,
            isSaving = memory.id in state.correctingMemoryIds,
            onDismiss = { correctTarget = null },
            onSave = { content ->
                viewModel.correctMemory(memory, content) {
                    correctTarget = null
                }
            },
        )
    }

    removeSkillTarget?.let { skill ->
        AlertDialog(
            onDismissRequest = { removeSkillTarget = null },
            title = { Text(stringResource(R.string.my_agents_remove_skill_title)) },
            text = {
                Text(
                    stringResource(
                        R.string.my_agents_remove_skill_body,
                        skill.name.ifBlank { skill.skillCanonicalKey },
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        removeSkillTarget = null
                        viewModel.removeSkill(skill)
                    },
                ) {
                    Text(stringResource(R.string.my_agents_remove_skill), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { removeSkillTarget = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    if (showSkillPicker) {
        AgentSkillPickerSheet(
            candidates = state.skillPickerCandidates,
            attachedKeys = state.skills.map { it.skillCanonicalKey }.toSet(),
            loading = state.isSkillPickerLoading,
            submitting = isAttachingSkills,
            onDismiss = {
                if (!isAttachingSkills) showSkillPicker = false
            },
            onAttachSelected = { selected ->
                if (selected.isEmpty() || isAttachingSkills) return@AgentSkillPickerSheet
                isAttachingSkills = true
                viewModel.attachSkills(selected.map { it.canonicalKey }) { attached ->
                    isAttachingSkills = false
                    if (attached.isEmpty()) return@attachSkills
                    showSkillPicker = false
                    val names = attached.map { link ->
                        link.name.ifBlank { link.skillCanonicalKey }
                    }
                    AgentSkillAttachFeedback.fromNames(names)?.let { feedback ->
                        val message = when (feedback) {
                            is AgentSkillAttachFeedback.Single -> context.getString(
                                R.string.my_agents_skill_added,
                                feedback.name,
                            )
                            is AgentSkillAttachFeedback.Batch -> context.getString(
                                R.string.my_agents_skills_added_batch,
                                feedback.firstName,
                                feedback.count,
                            )
                        }
                        scope.launch {
                            snackbar.showSnackbar(
                                message = message,
                                duration = SnackbarDuration.Short,
                            )
                        }
                    }
                }
            },
        )
    }
}

@Composable
private fun AgentDetailContent(
    agent: Agent,
    state: AgentDetailUiState,
    isIdentityMutating: Boolean,
    onEdit: () -> Unit,
    onAddSkill: () -> Unit,
    onToggleSkill: (AgentSkillLink, Boolean) -> Unit,
    onRemoveSkill: (AgentSkillLink) -> Unit,
    onForgetMemory: (AgentMemoryRecord) -> Unit,
    onCorrectMemory: (AgentMemoryRecord) -> Unit,
    portraitViewModel: UserPortraitViewModel,
    onOpenChatSession: (String, String, String, String) -> Unit,
    onDeactivate: () -> Unit,
) {
    var selectedSection by remember { mutableStateOf(AgentDetailSection.MEMORY) }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            start = TTSpacing.lg,
            top = TTSpacing.xl,
            end = TTSpacing.lg,
            bottom = TTSpacing.huge,
        ),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xxl),
    ) {
        item { AgentProfileCard(agent = agent, onEdit = onEdit, enabled = !isIdentityMutating) }
        item {
            AgentDetailTabRow(
                selectedSection = selectedSection,
                onSelect = { selectedSection = it },
            )
        }
        when (selectedSection) {
            AgentDetailSection.SKILLS -> item {
                SkillsCard(
                    skills = state.skills,
                    loading = state.isLoading,
                    mutatingKeys = state.mutatingSkillKeys,
                    canAdd = agent.organizationId.isNotBlank(),
                    onAddSkill = onAddSkill,
                    onToggleSkill = onToggleSkill,
                    onRemoveSkill = onRemoveSkill,
                )
            }
            AgentDetailSection.MEMORY -> item {
                MemoryCard(
                    agent = agent,
                    memories = state.memories,
                    loading = state.isLoading,
                    forgettingIds = state.forgettingMemoryIds,
                    correctingIds = state.correctingMemoryIds,
                    onForget = onForgetMemory,
                    onCorrect = onCorrectMemory,
                    portraitViewModel = portraitViewModel,
                )
            }
            AgentDetailSection.RECENT_TASKS -> item {
                RecentTasksCard(
                    sessions = state.sessions,
                    tasks = state.projectTasks,
                    loading = state.isLoading,
                    fallbackOrganizationId = agent.organizationId,
                    onOpenChatSession = onOpenChatSession,
                )
            }
        }
        if (agent.isDefault != true) {
            item {
                TextButton(
                    onClick = onDeactivate,
                    enabled = !isIdentityMutating,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Default.RemoveCircleOutline, contentDescription = null)
                    Spacer(Modifier.width(TTSpacing.xs))
                    Text(
                        text = stringResource(R.string.my_agents_deactivate),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}

@Composable
private fun AgentDetailTabRow(
    selectedSection: AgentDetailSection,
    onSelect: (AgentDetailSection) -> Unit,
) {
    val sections = AgentDetailSection.entries
    val selectedIndex = sections.indexOf(selectedSection)
    PrimaryScrollableTabRow(
        selectedTabIndex = selectedIndex,
        edgePadding = 0.dp,
        divider = { HorizontalDivider() },
    ) {
        sections.forEach { section ->
            Tab(
                selected = section == selectedSection,
                onClick = { onSelect(section) },
                icon = {
                    Icon(
                        imageVector = when (section) {
                            AgentDetailSection.MEMORY -> Icons.Default.SmartToy
                            AgentDetailSection.RECENT_TASKS -> Icons.Default.CheckCircle
                            AgentDetailSection.SKILLS -> Icons.Default.Extension
                        },
                        contentDescription = null,
                    )
                },
                text = {
                    Text(
                        text = stringResource(
                            when (section) {
                                AgentDetailSection.SKILLS -> R.string.my_agents_skills
                                AgentDetailSection.MEMORY -> R.string.my_agents_memory
                                AgentDetailSection.RECENT_TASKS -> R.string.my_agents_recent_tasks
                            },
                        ),
                        maxLines = 1,
                    )
                },
            )
        }
    }
}

@Composable
private fun AgentProfileCard(agent: Agent, onEdit: () -> Unit, enabled: Boolean) {
    val dividerColor = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                val stroke = 1.dp.toPx()
                drawLine(
                    color = dividerColor,
                    start = Offset(0f, size.height - stroke / 2f),
                    end = Offset(size.width, size.height - stroke / 2f),
                    strokeWidth = stroke,
                )
            }
            .padding(bottom = TTSpacing.xxl),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            AgentIdentityAvatar(
                name = agent.detailName(),
                avatarKey = agent.settings?.avatarKey,
                avatarUrl = agent.settings?.avatarUrl,
                size = 72.dp,
            )
            Spacer(Modifier.width(TTSpacing.md))
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                Text(
                    text = agent.detailName(),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(TTSpacing.xs))
                Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                    DetailPill(
                        if (agent.templateId.isNullOrBlank()) {
                            stringResource(R.string.my_agents_source_custom)
                        } else {
                            stringResource(R.string.my_agents_source_template)
                        },
                    )
                    if (agent.isDefault == true) DetailPill(
                        stringResource(R.string.my_agents_default),
                        accent = true,
                    )
                }
                RelativeTimeFormatter.format(androidx.compose.ui.platform.LocalContext.current, agent.updatedAt)
                    ?.let { time ->
                        Text(
                            stringResource(R.string.my_agents_updated_at, time),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
            }
            IconButton(onClick = onEdit, enabled = enabled) {
                Icon(Icons.Default.Edit, contentDescription = stringResource(R.string.my_agents_edit))
            }
        }
        HorizontalDivider(modifier = Modifier.padding(vertical = TTSpacing.lg))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = enabled, onClick = onEdit),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = Icons.Default.SmartToy,
                contentDescription = null,
                tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            )
            Spacer(Modifier.width(TTSpacing.sm))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.my_agents_persona_rules),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(TTSpacing.xs))
                Text(
                    text = agent.customRules.ifBlank { stringResource(R.string.my_agents_detail_rules_empty) },
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (agent.customRules.isBlank()) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun SkillsCard(
    skills: List<AgentSkillLink>,
    loading: Boolean,
    mutatingKeys: Set<String>,
    canAdd: Boolean,
    onAddSkill: () -> Unit,
    onToggleSkill: (AgentSkillLink, Boolean) -> Unit,
    onRemoveSkill: (AgentSkillLink) -> Unit,
) {
    DetailCard {
        Text(
            text = stringResource(R.string.my_agents_skills_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(TTSpacing.sm))
        OutlinedButton(
            onClick = onAddSkill,
            enabled = canAdd,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(TTSpacing.xs))
            Text(stringResource(R.string.my_agents_add_skill))
        }
        Spacer(Modifier.height(TTSpacing.sm))
        when {
            loading && skills.isEmpty() -> DetailLoading()
            skills.isEmpty() -> DetailEmpty(stringResource(R.string.my_agents_skills_empty), Icons.Default.Extension)
            else -> Column {
                skills.forEachIndexed { index, skill ->
                    SkillRow(
                        skill = skill,
                        mutating = skill.skillCanonicalKey in mutatingKeys,
                        onToggle = { onToggleSkill(skill, it) },
                        onRemove = { onRemoveSkill(skill) },
                    )
                    if (index < skills.lastIndex) HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun SkillRow(
    skill: AgentSkillLink,
    mutating: Boolean,
    onToggle: (Boolean) -> Unit,
    onRemove: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painterResource(R.drawable.lucide_book_text),
            contentDescription = null,
            tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            modifier = Modifier.size(24.dp),
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                skill.name.ifBlank { skill.skillCanonicalKey },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            skill.description?.takeIf { it.isNotBlank() }?.let { description ->
                Text(
                    description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (skill.locked) {
                Text(
                    stringResource(R.string.my_agents_skill_locked),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Switch(
            checked = skill.enabled,
            onCheckedChange = onToggle,
            enabled = !skill.locked && !mutating,
        )
        if (!skill.locked) {
            IconButton(onClick = onRemove, enabled = !mutating) {
                Icon(
                    Icons.Default.RemoveCircleOutline,
                    contentDescription = stringResource(R.string.my_agents_remove_skill),
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgentSkillPickerSheet(
    candidates: List<VisibleSkillEntry>,
    attachedKeys: Set<String>,
    loading: Boolean,
    submitting: Boolean,
    onDismiss: () -> Unit,
    onAttachSelected: (List<VisibleSkillEntry>) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    var selectedKeys by remember { mutableStateOf(setOf<String>()) }
    val available = remember(candidates, attachedKeys, query) {
        AgentSkillPickerFilter.available(candidates, attachedKeys, query)
    }
    // 已携带项从列表消失后，清掉过期勾选，避免底部计数虚高。
    LaunchedEffect(attachedKeys) {
        selectedKeys = selectedKeys - attachedKeys
    }
    val selectedSkills = remember(available, selectedKeys) {
        available.filter { it.canonicalKey in selectedKeys }
    }
    TTBottomSheet(onDismissRequest = onDismiss) {
        TTSheetColumn(
            scrollable = false,
            modifier = Modifier
                .padding(horizontal = TTSpacing.xl)
                .padding(bottom = TTSpacing.lg),
        ) {
            Text(
                text = stringResource(R.string.my_agents_add_skill_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(modifier = Modifier.height(TTSpacing.sm))
            TabSearchField(
                query = query,
                onQueryChange = { query = it },
                placeholder = stringResource(R.string.my_agents_add_skill_search),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(modifier = Modifier.height(TTSpacing.sm))
            when {
                loading && candidates.isEmpty() -> Box(
                    modifier = Modifier.fillMaxWidth().height(120.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }
                available.isEmpty() -> Text(
                    text = stringResource(R.string.my_agents_add_skill_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = TTSpacing.lg),
                )
                else -> LazyColumn(
                    modifier = Modifier.fillMaxWidth().height(360.dp),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    items(available, key = { it.canonicalKey }) { skill ->
                        val checked = skill.canonicalKey in selectedKeys
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(enabled = !submitting) {
                                    selectedKeys = if (checked) {
                                        selectedKeys - skill.canonicalKey
                                    } else {
                                        selectedKeys + skill.canonicalKey
                                    }
                                }
                                .padding(vertical = TTSpacing.sm),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(
                                checked = checked,
                                onCheckedChange = { enabled ->
                                    selectedKeys = if (enabled) {
                                        selectedKeys + skill.canonicalKey
                                    } else {
                                        selectedKeys - skill.canonicalKey
                                    }
                                },
                                enabled = !submitting,
                            )
                            Spacer(modifier = Modifier.width(TTSpacing.xs))
                            Icon(
                                painter = painterResource(R.drawable.lucide_book_text),
                                contentDescription = null,
                                tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                                modifier = Modifier.size(24.dp),
                            )
                            Spacer(modifier = Modifier.width(TTSpacing.sm))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    skill.resolvedName,
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.Medium,
                                )
                                skill.description.takeIf { it.isNotBlank() }?.let {
                                    Text(
                                        it,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }
            }
            Spacer(modifier = Modifier.height(TTSpacing.md))
            Button(
                onClick = { onAttachSelected(selectedSkills) },
                enabled = selectedSkills.isNotEmpty() && !submitting,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (submitting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                    Spacer(modifier = Modifier.width(TTSpacing.sm))
                }
                Text(
                    text = if (selectedSkills.size <= 1) {
                        stringResource(R.string.my_agents_add_skill_action)
                    } else {
                        stringResource(R.string.my_agents_add_skill_action_count, selectedSkills.size)
                    },
                )
            }
        }
    }
}

@Composable
private fun MemoryCard(
    agent: Agent,
    memories: List<AgentMemoryRecord>,
    loading: Boolean,
    forgettingIds: Set<String>,
    correctingIds: Set<String>,
    onForget: (AgentMemoryRecord) -> Unit,
    onCorrect: (AgentMemoryRecord) -> Unit,
    portraitViewModel: UserPortraitViewModel,
) {
    var selectedSection by remember(agent.id) { mutableStateOf(AgentMemorySection.OVERVIEW) }
    val dividerColor = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                val stroke = 1.dp.toPx()
                drawLine(
                    color = dividerColor,
                    start = Offset(0f, size.height - stroke / 2f),
                    end = Offset(size.width, size.height - stroke / 2f),
                    strokeWidth = stroke,
                )
            }
            .padding(bottom = TTSpacing.xxl),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(
                    if (selectedSection == AgentMemorySection.OVERVIEW) {
                        R.string.my_agents_memory_overview
                    } else {
                        R.string.my_agents_memory_records
                    },
                ),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            TextButton(
                onClick = {
                    selectedSection = if (selectedSection == AgentMemorySection.OVERVIEW) {
                        AgentMemorySection.RECORDS
                    } else {
                        AgentMemorySection.OVERVIEW
                    }
                },
            ) {
                Text(
                    text = stringResource(
                        if (selectedSection == AgentMemorySection.OVERVIEW) {
                            R.string.my_agents_memory_records
                        } else {
                            R.string.my_agents_memory_overview
                        },
                    ),
                )
            }
        }
        when (selectedSection) {
            AgentMemorySection.OVERVIEW -> UserPortraitPanel(
                organizationId = agent.organizationId,
                agentId = agent.id,
                organizationName = null,
                canManage = true,
                viewModel = portraitViewModel,
            )
            AgentMemorySection.RECORDS -> when {
                loading && memories.isEmpty() -> DetailLoading()
                memories.isEmpty() -> DetailEmpty(stringResource(R.string.my_agents_memory_empty), Icons.Default.SmartToy)
                else -> Column {
                    memories.forEachIndexed { index, memory ->
                        MemoryRow(
                            memory = memory,
                            forgetting = memory.id in forgettingIds,
                            correcting = memory.id in correctingIds,
                            onForget = onForget,
                            onCorrect = onCorrect,
                        )
                        if (index < memories.lastIndex) HorizontalDivider()
                    }
                }
            }
        }
    }
}

@Composable
private fun MemoryRow(
    memory: AgentMemoryRecord,
    forgetting: Boolean,
    correcting: Boolean,
    onForget: (AgentMemoryRecord) -> Unit,
    onCorrect: (AgentMemoryRecord) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val normalizedTitle = memory.title.trim()
            Text(
                text = if (shouldUseAgentMemoryTypeLabel(memory.memoryType, normalizedTitle)) {
                    stringResource(agentMemoryTypeLabelRes(memory.memoryType))
                } else {
                    normalizedTitle
                },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            TextButton(onClick = { onCorrect(memory) }, enabled = !forgetting && !correcting) {
                Text(stringResource(R.string.my_agents_correct_memory))
            }
            TextButton(onClick = { onForget(memory) }, enabled = !forgetting && !correcting) {
                Text(stringResource(R.string.my_agents_forget_memory), color = MaterialTheme.colorScheme.error)
            }
        }
        Text(
            text = memory.content,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        if (memory.tags.isNotEmpty()) {
            Spacer(Modifier.height(2.dp))
            Text(
                text = memory.tags.take(3).joinToString("  ") { "#$it" },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun MemoryCorrectDialog(
    memory: AgentMemoryRecord,
    isSaving: Boolean,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    var draft by remember(memory.id) { mutableStateOf(memory.content) }
    val trimmed = draft.trim()
    AlertDialog(
        onDismissRequest = {
            if (!isSaving) onDismiss()
        },
        title = { Text(stringResource(R.string.my_agents_correct_memory_title)) },
        text = {
            Column {
                Text(
                    text = stringResource(R.string.my_agents_correct_memory_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(TTSpacing.sm))
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    enabled = !isSaving,
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3,
                    maxLines = 6,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onSave(trimmed) },
                enabled = !isSaving && trimmed.isNotBlank() && trimmed != memory.content,
            ) {
                Text(stringResource(R.string.common_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isSaving) {
                Text(stringResource(R.string.common_cancel))
            }
        },
    )
}

@Composable
private fun RecentTasksCard(
    sessions: List<AllChatSession>,
    tasks: List<AgentProjectTask>,
    loading: Boolean,
    fallbackOrganizationId: String,
    onOpenChatSession: (String, String, String, String) -> Unit,
) {
    DetailCard {
        Text(
            text = stringResource(R.string.my_agents_recent_tasks_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(TTSpacing.sm))
        when {
            loading && sessions.isEmpty() && tasks.isEmpty() -> DetailLoading()
            sessions.isEmpty() && tasks.isEmpty() -> DetailEmpty(
                stringResource(R.string.my_agents_recent_tasks_empty),
                Icons.Default.CheckCircle,
            )
            else -> Column {
                sessions.take(10).forEach { session ->
                    SessionActivityRow(session, fallbackOrganizationId, onOpenChatSession)
                }
                tasks.take(10).forEach { task -> TaskActivityRow(task) }
            }
        }
    }
}

@Composable
private fun SessionActivityRow(
    session: AllChatSession,
    fallbackOrganizationId: String,
    onOpenChatSession: (String, String, String, String) -> Unit,
) {
    val executionSpaceId = if (!session.projectId.isNullOrBlank()) session.workspaceId else session.spaceId
    val title = session.displayTitle.ifBlank { stringResource(R.string.my_agents_chat) }
    val subtitle = session.spaceName ?: session.projectName ?: stringResource(R.string.my_agents_chat)
    val time = (session.lastMessageAt ?: session.updatedAt ?: session.createdAt)?.let {
        RelativeTimeFormatter.format(androidx.compose.ui.platform.LocalContext.current, it)
    }
    ActivityRow(
        title = title,
        subtitle = subtitle,
        time = time,
        icon = Icons.AutoMirrored.Filled.Chat,
        modifier = if (!executionSpaceId.isNullOrBlank()) {
            Modifier.clickable {
                onOpenChatSession(
                    session.id,
                    executionSpaceId,
                    session.spaceName ?: session.projectName.orEmpty(),
                    session.organizationId ?: fallbackOrganizationId,
                )
            }
        } else Modifier,
    )
}

@Composable
private fun TaskActivityRow(task: AgentProjectTask) {
    val context = androidx.compose.ui.platform.LocalContext.current
    ActivityRow(
        title = task.title,
        subtitle = task.project?.name ?: task.workStatus ?: task.assignmentStatus
            ?: stringResource(R.string.my_agents_project_task),
        time = task.updatedAt?.let { RelativeTimeFormatter.format(context, it) },
        icon = Icons.Default.CheckCircle,
    )
}

@Composable
private fun ActivityRow(
    title: String,
    subtitle: String,
    time: String?,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(vertical = TTSpacing.sm),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        time?.let {
            Spacer(Modifier.width(TTSpacing.sm))
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun DetailCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    // The agent detail is a continuous workspace rather than a stack of cards.
    // Keep the spacing contract and use a hairline divider to preserve grouping.
    val dividerColor = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(TTSpacing.md)
            .drawBehind {
                val stroke = 1.dp.toPx()
                drawLine(
                    color = dividerColor,
                    start = Offset(0f, size.height - stroke / 2f),
                    end = Offset(size.width, size.height - stroke / 2f),
                    strokeWidth = stroke,
                )
            },
        content = content,
    )
}

@Composable
private fun DetailSectionTitle(title: String, icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp), tint = ttColor(TTColors.Primary, TTColors.Dark.Primary))
        Spacer(Modifier.width(TTSpacing.xs))
        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun DetailPill(title: String, accent: Boolean = false) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = if (accent) ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.12f)
        else MaterialTheme.colorScheme.surface,
    ) {
        Text(
            title,
            style = MaterialTheme.typography.labelSmall,
            color = if (accent) ttColor(TTColors.Primary, TTColors.Dark.Primary) else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 3.dp),
        )
    }
}

@Composable
private fun DetailLoading() {
    Box(modifier = Modifier.fillMaxWidth().height(72.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
    }
}

@Composable
private fun DetailEmpty(title: String, icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Row(
        modifier = Modifier.fillMaxWidth().height(72.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(TTSpacing.xs))
        Text(title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun Agent.detailName(): String = displayName?.trim()?.takeIf { it.isNotEmpty() } ?: name
