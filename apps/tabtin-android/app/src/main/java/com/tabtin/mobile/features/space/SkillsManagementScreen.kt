package com.tabtin.mobile.features.space

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.rememberTTSheetState
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SkillReadiness
import com.tabtin.mobile.data.model.SpaceSkill
import com.tabtin.mobile.ui.theme.TTSpacing

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
public fun SkillsManagementScreen(
    viewModel: SkillsManagementViewModel,
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
                title = { Text(stringResource(R.string.skills_title)) },
            )
        },
    ) { padding ->
        when {
            state.isLoading && state.skills.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
            state.loadErrorRes != null && state.skills.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(R.string.skills_load_error), color = MaterialTheme.colorScheme.error)
                        Spacer(Modifier.height(TTSpacing.md))
                        Button(onClick = { viewModel.loadSkills(true) }) {
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
            }
            state.skills.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(R.string.skills_empty), style = MaterialTheme.typography.bodyLarge)
                        Spacer(Modifier.height(TTSpacing.xs))
                        Text(stringResource(R.string.skills_empty_desc), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
                ) {
                    item { ReadinessSummary(state.readinessCounts()) }
                    item { HorizontalDivider(Modifier.padding(horizontal = TTSpacing.lg)) }

                    items(state.sortedSkills, key = { it.resolvedId }) { skill ->
                        SkillRow(
                            skill = skill,
                            readiness = skill.computeReadiness(state.configs[skill.skillKey ?: ""]),
                            isEnabled = skill.isEnabledInSpace(state.configs),
                            isToggling = skill.resolvedId in state.togglingIds,
                            onToggle = { enabled -> viewModel.toggleSkill(skill, enabled) },
                            onConfigure = { viewModel.selectSkill(skill) },
                        )
                    }
                }
            }
        }
    }

    state.selectedSkill?.let { skill ->
        SkillConfigSheet(
            skill = skill,
            apiKey = state.configApiKey,
            onApiKeyChange = viewModel::setConfigApiKey,
            onSave = viewModel::saveConfig,
            onDismiss = viewModel::dismissSkillConfig,
        )
    }

    state.actionErrorRes?.let { errorRes ->
        AlertDialog(
            onDismissRequest = viewModel::clearActionError,
            title = { Text(stringResource(R.string.skills_load_error)) },
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
private fun ReadinessSummary(counts: Map<SkillReadiness, Int>) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(TTSpacing.lg),
        horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
        SkillReadiness.entries.forEach { readiness ->
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(readinessColor(readiness)),
                )
                Spacer(Modifier.height(TTSpacing.xxs))
                Text(
                    (counts[readiness] ?: 0).toString(),
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    readiness.label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SkillRow(
    skill: SpaceSkill,
    readiness: SkillReadiness,
    isEnabled: Boolean,
    isToggling: Boolean,
    onToggle: (Boolean) -> Unit,
    onConfigure: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                if (!skill.emoji.isNullOrBlank()) {
                    Text(skill.emoji, style = MaterialTheme.typography.bodyLarge)
                }
                Text(skill.name, style = MaterialTheme.typography.titleSmall)
                skill.version?.let { v ->
                    Text("v$v", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Box(Modifier.size(6.dp).clip(CircleShape).background(readinessColor(readiness)))
            }

            skill.description?.takeIf { it.isNotBlank() }?.let { desc ->
                Text(desc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }

            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                skill.source?.let {
                    Chip(skill.sourceLabel)
                }
                skill.category?.takeIf { it.isNotBlank() }?.let {
                    Chip(it)
                }
                if (readiness == SkillReadiness.NEEDS_CONFIG || skill.primaryEnv != null) {
                    TextButton(onClick = onConfigure, modifier = Modifier.height(28.dp)) {
                        Icon(Icons.Default.Settings, contentDescription = null, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(stringResource(R.string.skills_configure), style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }

        if (readiness == SkillReadiness.INCOMPATIBLE) {
            Text(stringResource(R.string.skills_incompatible), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else if (isToggling) {
            CircularProgressIndicator(modifier = Modifier.size(24.dp))
        } else {
            Switch(checked = isEnabled, onCheckedChange = onToggle)
        }
    }
}

@Composable
private fun Chip(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp))
            .padding(horizontal = TTSpacing.sm, vertical = 2.dp),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SkillConfigSheet(
    skill: SpaceSkill,
    apiKey: String,
    onApiKeyChange: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberTTSheetState()

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        TTSheetColumn(
            modifier = Modifier.padding(TTSpacing.lg).padding(bottom = TTSpacing.xxl),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (!skill.emoji.isNullOrBlank()) {
                    Text(skill.emoji, style = MaterialTheme.typography.headlineMedium)
                    Spacer(Modifier.width(TTSpacing.md))
                }
                Column {
                    Text(skill.name, style = MaterialTheme.typography.titleMedium)
                    skill.version?.let { v ->
                        Text("v$v", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }

            skill.description?.takeIf { it.isNotBlank() }?.let { desc ->
                Spacer(Modifier.height(TTSpacing.sm))
                Text(desc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            skill.primaryEnv?.let { envName ->
                Spacer(Modifier.height(TTSpacing.lg))
                Text("API Key", style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(TTSpacing.xs))
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = onApiKeyChange,
                    label = { Text(envName) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Spacer(Modifier.height(TTSpacing.xs))
                Text(
                    stringResource(R.string.skills_api_key_hint, envName),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(TTSpacing.lg))
                Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                    TextButton(onClick = onDismiss) {
                        Text(stringResource(R.string.common_cancel))
                    }
                    Spacer(Modifier.width(TTSpacing.sm))
                    Button(onClick = onSave) {
                        Text(stringResource(R.string.common_save))
                    }
                }
            }

            skill.source?.let {
                Spacer(Modifier.height(TTSpacing.md))
                HorizontalDivider()
                Spacer(Modifier.height(TTSpacing.md))
                Row {
                    Text(stringResource(R.string.skills_source), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.weight(1f))
                    Text(skill.sourceLabel, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

private fun readinessColor(readiness: SkillReadiness): Color = when (readiness) {
    SkillReadiness.READY -> Color(0xFF4CAF50)
    SkillReadiness.NEEDS_CONFIG -> Color(0xFFFFC107)
    SkillReadiness.NEEDS_INSTALL -> Color(0xFF2196F3)
    SkillReadiness.INCOMPATIBLE -> Color(0xFF9E9E9E)
}
