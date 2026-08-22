package com.tabtin.mobile.features.space

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SpaceSecurityScreen(
    onBack: () -> Unit,
    viewModel: SpaceSecurityViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    var showClearAllDialog by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }
    val context = LocalContext.current

    LaunchedEffect(state.saveSuccess) {
        if (state.saveSuccess) {
            viewModel.clearSaveSuccess()
            onBack()
        }
    }

    LaunchedEffect(state.errorRes) {
        state.errorRes?.let { res ->
            snackbarHostState.showSnackbar(context.getString(res))
            viewModel.clearError()
        }
    }

    if (showClearAllDialog) {
        AlertDialog(
            onDismissRequest = { showClearAllDialog = false },
            title = { Text("清空已记忆授权") },
            text = { Text("确定要清空所有已记忆的授权决策吗？") },
            confirmButton = {
                TextButton(onClick = {
                    showClearAllDialog = false
                    viewModel.revokeAllMemos()
                }) { Text("清空") }
            },
            dismissButton = {
                TextButton(onClick = { showClearAllDialog = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.security_settings)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
                actions = {
                    if (state.isDirty) {
                        TextButton(
                            onClick = { viewModel.save() },
                            enabled = !state.isSaving,
                        ) {
                            if (state.isSaving) {
                                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                            } else {
                                Text(stringResource(R.string.common_save))
                            }
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        if (state.isLoading) {
            Column(
                Modifier.fillMaxSize().padding(padding),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator()
            }
        } else {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
            ) {
                YoloSection(
                    enabled = state.allowYoloMode,
                    orgAllowsYolo = state.orgAllowsYolo,
                    onToggle = { viewModel.setAllowYoloMode(it) },
                )

                WorkspaceSection(
                    workspaceRoot = state.agent?.agentConfig?.workspaceRoot,
                )

                MemoSection(
                    entries = state.memoEntries,
                    onRevoke = { viewModel.revokeMemo(it) },
                    onClearAll = { showClearAllDialog = true },
                )
            }
        }
    }
}

@Composable
private fun YoloSection(enabled: Boolean, orgAllowsYolo: Boolean, onToggle: (Boolean) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("YOLO 模式", style = TTFonts.body)
                Text(
                    "开启后 Agent 在工作区内自由执行，仅红线规则拦截",
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }
            Spacer(Modifier.width(TTSpacing.md))
            Switch(checked = enabled, onCheckedChange = onToggle, enabled = orgAllowsYolo)
        }
        if (!orgAllowsYolo) {
            Text(
                "组织未开放 YOLO，请联系组织所有者在团队设置中开启「允许成员使用宽松审批」后再启用。",
                style = TTFonts.caption,
                color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
            )
        }
    }
}

@Composable
private fun WorkspaceSection(workspaceRoot: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
        Text(
            "工作区",
            style = TTFonts.captionSemibold,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
        if (!workspaceRoot.isNullOrBlank()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(TTRadius.Shapes.sm)
                    .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                    .padding(TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Default.Folder,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                )
                Spacer(Modifier.width(TTSpacing.xs))
                Text(
                    workspaceRoot,
                    style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    maxLines = 2,
                )
            }
        } else {
            Text(
                "未配置工作区",
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

@Composable
private fun MemoSection(
    entries: List<Pair<String, com.tabtin.mobile.data.model.ApprovalMemoEntry>>,
    onRevoke: (String) -> Unit,
    onClearAll: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "已记忆的授权",
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                modifier = Modifier.weight(1f),
            )
            if (entries.isNotEmpty()) {
                TextButton(onClick = onClearAll) {
                    Text(
                        "清空全部",
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                    )
                }
            }
        }

        if (entries.isEmpty()) {
            Text(
                "暂无已记忆的授权决策",
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.md),
            )
        } else {
            entries.forEach { (key, entry) ->
                MemoRow(key = key, entry = entry, onRevoke = { onRevoke(key) })
            }
        }
    }
}

@Composable
private fun MemoRow(
    key: String,
    entry: com.tabtin.mobile.data.model.ApprovalMemoEntry,
    onRevoke: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (entry.decision == "allow") Icons.Default.CheckCircle else Icons.Default.RemoveCircle,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = if (entry.decision == "allow")
                ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
            else
                ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
        )
        Spacer(Modifier.width(TTSpacing.xs))
        // M4.2 L-W6-30 修复：Kotlin `?:` 只对 null 触发；JSON 解码出空字符串 `""` 时
        // `?:` **不会** fallback —— 设置页就显示空白。这里改为显式 isNotEmpty 判断，
        // 让 Electron / Daemon 已写入但人话标签为空的旧 entry 也能回退到 key 显示。
        val memoLabel = entry.scopeDescription?.takeIf { it.isNotEmpty() } ?: key
        Text(
            memoLabel,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            modifier = Modifier.weight(1f),
            maxLines = 2,
        )
        IconButton(onClick = onRevoke, modifier = Modifier.size(32.dp)) {
            Icon(
                Icons.Default.Delete,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}
