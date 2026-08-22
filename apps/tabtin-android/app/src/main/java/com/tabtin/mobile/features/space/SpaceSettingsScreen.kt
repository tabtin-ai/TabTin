package com.tabtin.mobile.features.space

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.automirrored.filled.Rule
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.annotation.StringRes
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.background
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.components.TTFormDialog
import com.tabtin.mobile.ui.components.TTFormSheet
import com.tabtin.mobile.ui.theme.TTSpacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SpaceSettingsScreen(
    viewModel: SpaceSettingsViewModel,
    onBack: () -> Unit,
    onNavigateToSecurity: (spaceId: String) -> Unit,
    onNavigateToMemory: (spaceId: String) -> Unit,
    onNavigateToSkills: (spaceId: String) -> Unit,
    onNavigateToSubAgents: (spaceId: String) -> Unit,
    onNavigateToArchivedSessions: (spaceId: String) -> Unit = {},
    onNavigateToExecutionLimits: (spaceId: String) -> Unit = {},
) {
    val state by viewModel.uiState.collectAsState()
    val snackbarHostState = remember { androidx.compose.material3.SnackbarHostState() }
    val context = androidx.compose.ui.platform.LocalContext.current

    // 从安全/执行限额等子页返回时重新拉取 Agent，
    // 让右侧摘要（如 YOLO badge）立即反映刚保存的配置，而非显示返回前的旧快照。
    androidx.lifecycle.compose.LifecycleResumeEffect(Unit) {
        viewModel.refreshAgent()
        onPauseOrDispose { }
    }

    LaunchedEffect(state.actionDone) {
        if (state.actionDone) onBack()
    }

    LaunchedEffect(state.toastRes) {
        state.toastRes?.let { res ->
            snackbarHostState.showSnackbar(context.getString(res))
            viewModel.consumeToast()
        }
    }

    LaunchedEffect(state.errorRes) {
        state.errorRes?.let { res ->
            snackbarHostState.showSnackbar(context.getString(res))
            viewModel.clearError()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
                title = { Text(stringResource(R.string.space_settings_title)) },
            )
        },
        snackbarHost = { androidx.compose.material3.SnackbarHost(snackbarHostState) },
    ) { padding ->
        if (state.isLoading) {
            androidx.compose.foundation.layout.Box(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator()
            }
            return@Scaffold
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
        ) {
            state.space?.let { space ->
                SpaceHeader(name = space.name, description = space.description)
            }

            Spacer(Modifier.height(TTSpacing.xl))

            SettingsRow(
                icon = Icons.Default.Edit,
                title = stringResource(R.string.space_settings_basic_info),
                onClick = viewModel::startEditBasicInfo,
            )
            SettingsRow(
                icon = Icons.AutoMirrored.Filled.Rule,
                title = stringResource(R.string.space_settings_rules),
                value = state.rulesPreview,
                onClick = viewModel::startEditRules,
            )
            SettingsRow(
                icon = Icons.Default.FolderOpen,
                title = stringResource(R.string.space_settings_work_type),
                value = state.workTypeLabelRes?.let { stringResource(it) }
                    ?: if (state.hasWorkingDir) stringResource(R.string.work_type_pending) else null,
                onClick = viewModel::startEditWorkType,
            )

            Spacer(Modifier.height(TTSpacing.lg))
            HorizontalDivider(Modifier.padding(horizontal = TTSpacing.lg))
            Spacer(Modifier.height(TTSpacing.lg))

            SettingsRow(
                icon = Icons.Default.Memory,
                title = stringResource(R.string.space_settings_memory),
                onClick = { onNavigateToMemory(viewModel.spaceId) },
            )
            SettingsRow(
                icon = Icons.Default.Star,
                title = stringResource(R.string.space_settings_skills),
                onClick = { onNavigateToSkills(viewModel.spaceId) },
            )
            SettingsRow(
                icon = Icons.Default.SmartToy,
                title = stringResource(R.string.space_settings_subagents),
                onClick = { onNavigateToSubAgents(viewModel.spaceId) },
            )

            Spacer(Modifier.height(TTSpacing.lg))
            HorizontalDivider(Modifier.padding(horizontal = TTSpacing.lg))
            Spacer(Modifier.height(TTSpacing.lg))

            SettingsRow(
                icon = Icons.Default.Security,
                title = stringResource(R.string.security_settings),
                value = state.securityLabel,
                onClick = { onNavigateToSecurity(viewModel.spaceId) },
            )
            SettingsRow(
                icon = Icons.Default.Speed,
                title = stringResource(R.string.execution_limits_title),
                value = state.executionLimitsSummary,
                onClick = { onNavigateToExecutionLimits(viewModel.spaceId) },
            )

            Spacer(Modifier.height(TTSpacing.lg))
            HorizontalDivider(Modifier.padding(horizontal = TTSpacing.lg))
            Spacer(Modifier.height(TTSpacing.lg))

            SettingsRow(
                icon = Icons.Default.Archive,
                title = stringResource(R.string.space_settings_archived_sessions),
                onClick = { onNavigateToArchivedSessions(viewModel.spaceId) },
            )
            if (state.canDelete) {
                Spacer(Modifier.height(TTSpacing.lg))
                HorizontalDivider(Modifier.padding(horizontal = TTSpacing.lg))
                Spacer(Modifier.height(TTSpacing.lg))

                SettingsRow(
                    icon = Icons.Default.Delete,
                    title = stringResource(R.string.space_settings_delete),
                    tint = MaterialTheme.colorScheme.error,
                    onClick = viewModel::showDeleteConfirm,
                )
            }

            Spacer(Modifier.height(TTSpacing.xxl))
        }
    }

    if (state.showDeleteConfirm) {
        TTFormDialog(
            onDismissRequest = viewModel::dismissDeleteConfirm,
            title = { Text(stringResource(R.string.space_settings_delete)) },
            text = {
                Column {
                    Text(stringResource(R.string.space_settings_delete_confirm, state.space?.name ?: ""))
                    Spacer(Modifier.height(TTSpacing.md))
                    Text(
                        stringResource(R.string.space_settings_delete_warning),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(TTSpacing.md))
                    OutlinedTextField(
                        value = state.deleteInputValue,
                        onValueChange = viewModel::setDeleteInput,
                        label = { Text(stringResource(R.string.space_settings_delete_input_hint)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = viewModel::deleteSpace,
                    enabled = !state.isDeleting && state.deleteInputValue.trim() == state.space?.name,
                ) {
                    Text(
                        stringResource(R.string.space_settings_delete),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissDeleteConfirm) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    when (state.editingField) {
        EditField.BASIC_INFO -> {
            TTFormDialog(
                onDismissRequest = viewModel::dismissEdit,
                title = { Text(stringResource(R.string.space_settings_basic_info)) },
                text = {
                    Column {
                        OutlinedTextField(
                            value = state.editName,
                            onValueChange = viewModel::setEditName,
                            label = { Text(stringResource(R.string.space_settings_name_label)) },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = viewModel::saveEdit,
                        enabled = !state.isSaving && state.editName.isNotBlank(),
                    ) {
                        Text(stringResource(R.string.common_save))
                    }
                },
                dismissButton = {
                    TextButton(onClick = viewModel::dismissEdit) {
                        Text(stringResource(R.string.common_cancel))
                    }
                },
            )
        }
        EditField.RULES -> {
            TTFormSheet(
                onDismissRequest = viewModel::dismissEdit,
                title = { Text(stringResource(R.string.space_settings_rules)) },
                dismissEnabled = !state.isSaving,
                content = {
                    OutlinedTextField(
                        value = state.editText,
                        onValueChange = viewModel::setEditText,
                        placeholder = { Text(stringResource(R.string.space_settings_rules_hint)) },
                        minLines = 5,
                        maxLines = 12,
                        enabled = !state.isSaving,
                        modifier = Modifier.fillMaxWidth(),
                    )
                },
                actions = {
                    TextButton(onClick = viewModel::dismissEdit, enabled = !state.isSaving) {
                        Text(stringResource(R.string.common_cancel))
                    }
                    TextButton(onClick = viewModel::saveEdit, enabled = !state.isSaving) {
                        Text(stringResource(R.string.common_save))
                    }
                },
            )
        }
        EditField.WORK_TYPE -> {
            val currentType = state.space?.workingDirType ?: ""
            val canSave = state.hasWorkingDir &&
                state.editWorkType.isNotBlank() &&
                state.editWorkType != currentType
            AlertDialog(
                onDismissRequest = viewModel::dismissEdit,
                title = { Text(stringResource(R.string.space_settings_work_type)) },
                text = {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        WorkingDirReadOnly(workingDir = state.space?.workingDir ?: "")
                        if (state.hasWorkingDir) {
                            Spacer(Modifier.height(TTSpacing.lg))
                            Text(
                                stringResource(R.string.work_type_section_label),
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(TTSpacing.xs))
                            Text(
                                stringResource(R.string.work_type_section_hint),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (state.editWorkType.isBlank()) {
                                Spacer(Modifier.height(TTSpacing.xs))
                                Text(
                                    stringResource(R.string.work_type_pick_hint),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            }
                            Spacer(Modifier.height(TTSpacing.sm))
                            workTypeOptions.forEach { option ->
                                WorkTypeOptionRow(
                                    option = option,
                                    selected = state.editWorkType == option.value,
                                    onSelect = { viewModel.setEditWorkType(option.value) },
                                )
                            }
                        }
                    }
                },
                confirmButton = {
                    if (state.hasWorkingDir) {
                        TextButton(onClick = viewModel::saveEdit, enabled = !state.isSaving && canSave) {
                            Text(stringResource(R.string.common_save))
                        }
                    } else {
                        TextButton(onClick = viewModel::dismissEdit) {
                            Text(stringResource(R.string.common_cancel))
                        }
                    }
                },
                dismissButton = if (state.hasWorkingDir) {
                    {
                        TextButton(onClick = viewModel::dismissEdit) {
                            Text(stringResource(R.string.common_cancel))
                        }
                    }
                } else {
                    null
                },
            )
        }
        null -> {}
    }
}

private data class WorkTypeOption(
    val value: String,
    @StringRes val titleRes: Int,
    @StringRes val descRes: Int,
)

private val workTypeOptions: List<WorkTypeOption> = listOf(
    WorkTypeOption("code", R.string.work_type_code_title, R.string.work_type_code_desc),
    WorkTypeOption("doc", R.string.work_type_doc_title, R.string.work_type_doc_desc),
    WorkTypeOption("mixed", R.string.work_type_mixed_title, R.string.work_type_mixed_desc),
)

@Composable
private fun WorkingDirReadOnly(workingDir: String) {
    if (workingDir.isNotEmpty()) {
        Text(
            stringResource(R.string.work_type_working_dir_label),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(TTSpacing.xs))
        Text(
            workingDir,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(8.dp),
                )
                .padding(TTSpacing.sm),
        )
        Spacer(Modifier.height(TTSpacing.xs))
        Text(
            stringResource(R.string.work_type_working_dir_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    } else {
        Text(
            stringResource(R.string.work_type_no_working_dir),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun WorkTypeOptionRow(
    option: WorkTypeOption,
    selected: Boolean,
    onSelect: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onSelect)
            .padding(vertical = TTSpacing.sm),
        verticalAlignment = Alignment.Top,
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Spacer(Modifier.width(TTSpacing.xs))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                stringResource(option.titleRes),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                stringResource(option.descRes),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SpaceHeader(name: String, description: String?) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(name, style = MaterialTheme.typography.headlineSmall)
        if (!description.isNullOrBlank()) {
            Spacer(Modifier.height(TTSpacing.xs))
            Text(
                description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
internal fun SettingsRow(
    icon: ImageVector,
    title: String,
    value: String? = null,
    tint: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.primary,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(24.dp),
            tint = tint,
        )
        Spacer(Modifier.width(TTSpacing.md))
        Text(
            title,
            style = MaterialTheme.typography.bodyLarge,
            color = if (tint == MaterialTheme.colorScheme.error) tint else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        if (!value.isNullOrBlank()) {
            Text(
                value,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(end = TTSpacing.xs),
            )
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            modifier = Modifier.size(20.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
