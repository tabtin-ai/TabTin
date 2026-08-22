package com.tabtin.mobile.features.skills

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SkillQuickUseVariable
import com.tabtin.mobile.ui.theme.TTSpacing

/** 把技能发布者定义的 Quick Use 模板转为新任务草稿，不在手机本地执行技能。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MobileSkillQuickUseScreen(
    skillKey: String,
    presetId: String,
    agentId: String,
    onBack: () -> Unit,
    onStartTask: (String, String) -> Unit,
    viewModel: MobileSkillLibraryViewModel,
) {
    val state by viewModel.uiState.collectAsState()
    val skill = state.skills.firstOrNull { it.canonicalKey == skillKey }
    val preset = skill?.quickUse?.firstOrNull { it.resolvedId == presetId }
    val values = remember(skillKey, presetId) { mutableStateMapOf<String, String>() }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("快速使用") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.common_back)) } },
        )
    }) { padding ->
        when {
            state.isLoading && preset == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            skill == null || preset == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { Text("这个快速使用模板已不可用") }
            else -> Column(
                modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
            ) {
                Text(skill.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(preset.resolvedLabel, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                preset.variables.forEach { variable ->
                    QuickUseInput(variable = variable, value = values[variable.key].orEmpty(), onValueChange = { values[variable.key] = it })
                }
                Button(
                    onClick = { onStartTask(preset.render(values), agentId) },
                    enabled = preset.promptTemplate.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("用它开始任务") }
                Text("将带着这个技能模板和已选 AI 分身进入新任务。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun QuickUseInput(variable: SkillQuickUseVariable, value: String, onValueChange: (String) -> Unit) {
    if (variable.options.isEmpty()) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(variable.label.ifBlank { variable.key }) },
            placeholder = { Text(variable.placeholder) },
        )
    } else {
        var expanded by remember(variable.key) { mutableStateOf(false) }
        Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
            Text(variable.label.ifBlank { variable.key }, style = MaterialTheme.typography.labelLarge)
            Box {
                OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(variable.options.firstOrNull { it.value == value }?.resolvedLabel ?: variable.placeholder.ifBlank { "请选择" }, modifier = Modifier.weight(1f))
                    Spacer(Modifier.width(TTSpacing.xs))
                    Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                }
                DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    variable.options.forEach { option ->
                        DropdownMenuItem(text = { Text(option.resolvedLabel) }, onClick = { expanded = false; onValueChange(option.value) })
                    }
                }
            }
        }
    }
}
