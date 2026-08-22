package com.tabtin.mobile.features.space

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * 当前 Organization 的记忆记录偏好。
 *
 * 总开关读写 TabMemo 的组织级记录偏好。长对话的压缩策略当前由平台统一管理；
 * 运行时并不消费旧 ``agent_config.memory.working_memory``，所以不展示无效开关。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MemorySettingsScreen(
    viewModel: MemorySettingsViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val context = androidx.compose.ui.platform.LocalContext.current

    val saveSuccessText = stringResource(R.string.space_settings_save_success)

    LaunchedEffect(state.saveSuccess) {
        if (state.saveSuccess) {
            snackbar.showSnackbar(saveSuccessText)
            viewModel.clearSaveSuccess()
        }
    }

    LaunchedEffect(state.errorRes) {
        state.errorRes?.let { res ->
            // errorRes 是动态 @StringRes Int —— 无法用 stringResource，只能 context.getString。
            // 与项目里其他错误展示 ViewModel 同款 idiom，避免引入新的 LocalContextGetResourceValueCall lint。
            snackbar.showSnackbar(context.getString(res))
            viewModel.clearError()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
                title = { Text(stringResource(R.string.memory_title)) },
                actions = {
                    Button(
                        onClick = viewModel::save,
                        enabled = state.isDirty && !state.isSaving,
                        modifier = Modifier.padding(end = TTSpacing.sm),
                    ) {
                        Text(stringResource(R.string.common_save))
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        if (state.isLoading) {
            Box(
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
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.lg),
        ) {
            Spacer(Modifier.height(TTSpacing.md))

            // ── 说明 ───────────────────────────────────────
            Text(
                text = stringResource(R.string.memory_description),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(TTSpacing.lg))

            // ── 记忆记录总开关 ──────────────────────────────
            SectionTitle(stringResource(R.string.memory_title))
            SwitchRow(
                title = stringResource(R.string.memory_enable),
                subtitle = stringResource(R.string.user_portrait_enable_hint),
                checked = state.enabled,
                enabled = !state.isSaving,
                onCheckedChange = viewModel::setEnabled,
            )

            if (!state.enabled) {
                Text(
                    text = stringResource(R.string.user_portrait_disabled),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.md),
                )
            }

            Text(
                text = stringResource(R.string.my_agents_memory_overview_location_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = TTSpacing.sm),
            )

            Spacer(Modifier.height(TTSpacing.xl))
        }
    }
}

@Composable
private fun SectionTitle(title: String) {
    Text(
        text = title,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(vertical = TTSpacing.xs),
    )
}

@Composable
private fun SwitchRow(
    title: String,
    subtitle: String? = null,
    checked: Boolean,
    enabled: Boolean = true,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f).padding(end = TTSpacing.md)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (!subtitle.isNullOrBlank()) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            enabled = enabled,
        )
    }
}
