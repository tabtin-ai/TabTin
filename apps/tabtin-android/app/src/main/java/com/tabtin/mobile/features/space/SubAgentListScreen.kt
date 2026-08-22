package com.tabtin.mobile.features.space

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.rememberTTSheetState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SubAgentTemplate
import com.tabtin.mobile.ui.theme.TTSpacing

private val ICON_OPTIONS = listOf("🤖", "🔍", "🧠", "🛠", "📊", "✍️", "🧪", "🧭")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SubAgentListScreen(
    viewModel: SubAgentListViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
                title = { Text(stringResource(R.string.subagent_title)) },
                actions = {
                    IconButton(onClick = viewModel::showCreate) {
                        Icon(Icons.Default.Add, contentDescription = stringResource(R.string.subagent_create))
                    }
                },
            )
        },
    ) { padding ->
        when {
            state.isLoading && state.templates.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
            state.loadErrorRes != null && state.templates.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(state.loadErrorRes!!), color = MaterialTheme.colorScheme.error)
                        Spacer(Modifier.height(TTSpacing.md))
                        Button(onClick = viewModel::loadTemplates) {
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
            }
            state.templates.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("🤖", style = MaterialTheme.typography.displayMedium)
                        Spacer(Modifier.height(TTSpacing.md))
                        Text(stringResource(R.string.subagent_empty), style = MaterialTheme.typography.bodyLarge)
                        Spacer(Modifier.height(TTSpacing.xs))
                        Text(stringResource(R.string.subagent_empty_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(TTSpacing.lg))
                        Button(onClick = viewModel::showCreate) {
                            Text(stringResource(R.string.subagent_create))
                        }
                    }
                }
            }
            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
                ) {
                    item {
                        Text(
                            stringResource(R.string.subagent_subtitle),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                        )
                    }
                    items(state.templates, key = { it.id }) { tpl ->
                        TemplateRow(
                            template = tpl,
                            onToggle = { enabled -> viewModel.toggleTemplate(tpl, enabled) },
                            onEdit = { viewModel.showEdit(tpl) },
                            onDelete = { viewModel.showDeleteConfirm(tpl) },
                        )
                    }
                }
            }
        }
    }

    if (state.showCreateSheet || state.editingTemplate != null) {
        SubAgentEditSheet(
            viewModel = viewModel,
            isNew = state.editingTemplate == null,
            onDismiss = viewModel::dismissEdit,
        )
    }

    state.deleteTarget?.let { target ->
        AlertDialog(
            onDismissRequest = viewModel::dismissDeleteConfirm,
            title = { Text(stringResource(R.string.subagent_delete_confirm)) },
            text = { Text(stringResource(R.string.subagent_delete_warning)) },
            confirmButton = {
                TextButton(onClick = viewModel::deleteTemplate) {
                    Text(stringResource(R.string.common_confirm), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissDeleteConfirm) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    state.actionErrorRes?.let { errorRes ->
        AlertDialog(
            onDismissRequest = viewModel::clearActionError,
            title = { Text(stringResource(R.string.subagent_operation_failed)) },
            text = { Text(stringResource(errorRes)) },
            confirmButton = {
                TextButton(onClick = viewModel::clearActionError) {
                    Text(stringResource(R.string.common_confirm))
                }
            },
        )
    }
}

@Composable
private fun TemplateRow(
    template: SubAgentTemplate,
    onToggle: (Boolean) -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    var showMenu by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onEdit)
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md)
            .alpha(if (template.isEnabled) 1f else 0.5f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            template.icon.ifEmpty { "🤖" },
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.size(36.dp),
        )
        Spacer(Modifier.width(TTSpacing.md))

        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                Text(
                    template.name,
                    style = MaterialTheme.typography.titleSmall,
                    color = if (template.isEnabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    subagentTypeLabel(template.subagentType),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (template.description.isNotBlank()) {
                Text(
                    template.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        Box {
            IconButton(onClick = { showMenu = true }) {
                Icon(Icons.Default.Edit, contentDescription = stringResource(R.string.subagent_edit_title), modifier = Modifier.size(18.dp))
            }
            DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.subagent_edit_title)) },
                    leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                    onClick = { showMenu = false; onEdit() },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.common_remove), color = MaterialTheme.colorScheme.error) },
                    leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                    onClick = { showMenu = false; onDelete() },
                )
            }
        }

        Switch(checked = template.isEnabled, onCheckedChange = onToggle)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SubAgentEditSheet(
    viewModel: SubAgentListViewModel,
    isNew: Boolean,
    onDismiss: () -> Unit,
) {
    val editState by viewModel.editState.collectAsState()
    val sheetState = rememberTTSheetState()

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        TTSheetColumn(
            modifier = Modifier
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xxl),
        ) {
            Text(
                if (isNew) stringResource(R.string.subagent_create_title) else stringResource(R.string.subagent_edit_title),
                style = MaterialTheme.typography.titleMedium,
            )

            Spacer(Modifier.height(TTSpacing.lg))

            Text(stringResource(R.string.subagent_icon_label), style = MaterialTheme.typography.labelMedium)
            Spacer(Modifier.height(TTSpacing.xs))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                items(ICON_OPTIONS) { emoji ->
                    Card(
                        modifier = Modifier.size(44.dp).clickable { viewModel.setIcon(emoji) },
                        shape = RoundedCornerShape(8.dp),
                        colors = CardDefaults.cardColors(
                            containerColor = if (editState.icon == emoji) MaterialTheme.colorScheme.primaryContainer
                            else MaterialTheme.colorScheme.surfaceVariant,
                        ),
                    ) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text(emoji, style = MaterialTheme.typography.titleLarge)
                        }
                    }
                }
            }

            Spacer(Modifier.height(TTSpacing.lg))

            OutlinedTextField(
                value = editState.name,
                onValueChange = viewModel::setName,
                label = { Text(stringResource(R.string.subagent_name_placeholder)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            Spacer(Modifier.height(TTSpacing.md))

            OutlinedTextField(
                value = editState.description,
                onValueChange = viewModel::setDescription,
                label = { Text(stringResource(R.string.subagent_desc_placeholder)) },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 3,
            )

            Spacer(Modifier.height(TTSpacing.md))

            OutlinedTextField(
                value = editState.systemPrompt,
                onValueChange = viewModel::setSystemPrompt,
                label = { Text(stringResource(R.string.subagent_system_prompt)) },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 6,
            )

            Spacer(Modifier.height(TTSpacing.lg))

            PickerRow(
                label = stringResource(R.string.subagent_task_role),
                selected = editState.subagentType,
                options = listOf(
                    "explore" to stringResource(R.string.subagent_type_explore),
                    "plan" to stringResource(R.string.subagent_type_plan),
                    "execute" to stringResource(R.string.subagent_type_execute),
                ),
                onSelect = viewModel::setSubagentType,
            )

            Spacer(Modifier.height(TTSpacing.md))

            PickerRow(
                label = stringResource(R.string.subagent_mode),
                selected = editState.defaultMode,
                options = listOf(
                    "wait" to stringResource(R.string.subagent_mode_wait),
                    "background" to stringResource(R.string.subagent_mode_background),
                ),
                onSelect = viewModel::setDefaultMode,
            )

            Spacer(Modifier.height(TTSpacing.md))

            PickerRow(
                label = stringResource(R.string.subagent_thinking_level),
                selected = editState.thinkingLevel,
                options = listOf(
                    "" to stringResource(R.string.common_default),
                    "off" to stringResource(R.string.subagent_thinking_off),
                    "low" to stringResource(R.string.subagent_thinking_low),
                    "medium" to stringResource(R.string.subagent_thinking_medium),
                    "high" to stringResource(R.string.subagent_thinking_high),
                ),
                onSelect = viewModel::setThinkingLevel,
            )

            Spacer(Modifier.height(TTSpacing.lg))

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(stringResource(R.string.subagent_enabled), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Switch(checked = editState.isEnabled, onCheckedChange = viewModel::setIsEnabled)
            }

            Spacer(Modifier.height(TTSpacing.xl))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                TextButton(onClick = onDismiss) {
                    Text(stringResource(R.string.common_cancel))
                }
                Spacer(Modifier.width(TTSpacing.sm))
                Button(
                    onClick = viewModel::saveTemplate,
                    enabled = editState.canSave,
                ) {
                    if (editState.isSaving) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Text(stringResource(R.string.common_save))
                    }
                }
            }
        }
    }
}

@Composable
private fun PickerRow(
    label: String,
    selected: String,
    options: List<Pair<String, String>>,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = options.firstOrNull { it.first == selected }?.second ?: selected

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Box {
            TextButton(onClick = { expanded = true }) {
                Text(selectedLabel)
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                options.forEach { (value, text) ->
                    DropdownMenuItem(
                        text = { Text(text) },
                        onClick = { onSelect(value); expanded = false },
                    )
                }
            }
        }
    }
}

@Composable
private fun subagentTypeLabel(type: String): String = when (type) {
    "explore" -> stringResource(R.string.subagent_type_explore)
    "plan" -> stringResource(R.string.subagent_type_plan)
    "execute" -> stringResource(R.string.subagent_type_execute)
    else -> type
}
