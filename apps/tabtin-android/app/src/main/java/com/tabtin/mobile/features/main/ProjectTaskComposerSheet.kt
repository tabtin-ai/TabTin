package com.tabtin.mobile.features.main

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.Project
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

public data class ProjectTaskAgentOption(
    val id: String,
    val name: String,
    val role: String? = null,
    val responsibility: String? = null,
)

/**
 * Project 遥控任务表单：固定 Agent + 当前成员自己的电脑端 companion Space。
 * 手机只发起会话，不读取工作目录，也不把 Project 伪装成执行环境。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ProjectTaskComposerSheet(
    project: Project,
    agentOptions: List<ProjectTaskAgentOption>,
    defaultAgentId: String?,
    isLoadingAgents: Boolean,
    onDismiss: () -> Unit,
    onChatPrepared: (ChatSession, Space) -> Unit,
    viewModel: MainComposeViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val restoredDraft by viewModel.restoredDraft.collectAsState()
    val view = LocalView.current
    var prompt by rememberSaveable(project.id) { mutableStateOf("") }
    var selectedAgentId by rememberSaveable(project.id, defaultAgentId) {
        mutableStateOf(defaultAgentId ?: agentOptions.firstOrNull()?.id)
    }
    var showAgentPicker by rememberSaveable { mutableStateOf(false) }
    var restoredDraftId by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(agentOptions, defaultAgentId) {
        if (agentOptions.none { it.id == selectedAgentId }) {
            selectedAgentId = defaultAgentId?.takeIf { preferredId ->
                agentOptions.any { it.id == preferredId }
            } ?: agentOptions.firstOrNull()?.id
        }
    }
    val selectedAgent = agentOptions.firstOrNull { it.id == selectedAgentId }
    val workspace = remember(project) {
        project.myWorkspace?.let { companion ->
            Space(
                id = companion.id,
                organizationId = project.organizationId,
                agentId = companion.agentId,
                executionAgentId = companion.executionAgentId,
                boundDeviceId = companion.controlDeviceId,
                controlDeviceId = companion.controlDeviceId,
                name = companion.name?.takeIf { it.isNotBlank() } ?: project.name,
                type = "workspace",
            )
        }
    }
    val workspaceIsRunnable = project.myWorkspace?.controlDeviceStatus?.lowercase() in setOf("online", "busy")
    val canSend = workspace != null && workspaceIsRunnable && selectedAgent != null &&
        prompt.trim().isNotEmpty() && !uiState.isSending

    val canvas = ttColor(TTColors.Surface, TTColors.Dark.Surface)
    val subtle = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    val border = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    val textPrimary = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    val textSecondary = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    val textCritical = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
    val iconSecondary = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary)
    val cardShape = RoundedCornerShape(12.dp)

    LaunchedEffect(project.id, workspace?.id) {
        viewModel.clearTransientState()
        viewModel.restoreDraft(workspace, project.id)
    }

    LaunchedEffect(restoredDraft?.draftId) {
        val draft = restoredDraft ?: return@LaunchedEffect
        if (draft.draftId == restoredDraftId) return@LaunchedEffect
        prompt = draft.text
        selectedAgentId = draft.agentId
        restoredDraftId = draft.draftId
    }

    LaunchedEffect(Unit) {
        viewModel.events.collect { event ->
            if (event is MainComposeEvent.ChatPrepared) {
                onChatPrepared(event.session, event.space)
            }
        }
    }

    // 显式钉 TT Surface：Material3 BottomSheet 默认 surfaceContainerLow 未映射到主题，
    // 会落到 primary 衍生脏色，叠在暖底上看起来发浑。
    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(),
        containerColor = canvas,
        contentColor = textPrimary,
        scrimColor = ttColor(TTColors.OverlayBackground, TTColors.Dark.OverlayBackground),
    ) {
        TTSheetColumn {
            TopAppBar(
                title = { Text(stringResource(R.string.project_task_title)) },
                navigationIcon = {
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_close))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    titleContentColor = textPrimary,
                    navigationIconContentColor = textPrimary,
                ),
            )

            Column(
                modifier = Modifier.padding(horizontal = TTSpacing.lg),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
            ) {
                Surface(
                    shape = cardShape,
                    color = subtle,
                    border = BorderStroke(0.5.dp, border),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(TTSpacing.md),
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    ) {
                        Icon(
                            Icons.Default.Computer,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp),
                            tint = iconSecondary,
                        )
                        Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs)) {
                            Text(
                                stringResource(R.string.project_task_execution_section),
                                fontWeight = FontWeight.SemiBold,
                                color = textPrimary,
                            )
                            Text(
                                stringResource(
                                    R.string.project_task_execution_hint,
                                    workspace?.name ?: stringResource(R.string.common_tab_space),
                                ),
                                style = MaterialTheme.typography.bodySmall,
                                color = textSecondary,
                            )
                            if (workspace != null && !workspaceIsRunnable) {
                                Text(
                                    stringResource(R.string.project_task_device_offline),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = textCritical,
                                )
                            }
                        }
                    }
                }

                Surface(
                    onClick = { if (agentOptions.isNotEmpty()) showAgentPicker = true },
                    modifier = Modifier.fillMaxWidth(),
                    shape = cardShape,
                    color = subtle,
                    border = BorderStroke(0.5.dp, border),
                ) {
                    Row(
                        modifier = Modifier.padding(TTSpacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Default.SmartToy,
                            contentDescription = null,
                            tint = iconSecondary,
                        )
                        Spacer(modifier = Modifier.width(TTSpacing.sm))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                selectedAgent?.name ?: if (isLoadingAgents) {
                                    stringResource(R.string.common_loading)
                                } else {
                                    stringResource(R.string.project_task_no_agent)
                                },
                                fontWeight = FontWeight.SemiBold,
                                color = textPrimary,
                            )
                            selectedAgent?.responsibility?.takeIf { it.isNotBlank() }?.let {
                                Text(
                                    it,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = textSecondary,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        Icon(
                            Icons.Default.ArrowDropDown,
                            contentDescription = null,
                            tint = iconSecondary,
                        )
                    }
                }

                TextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    placeholder = {
                        Text(
                            stringResource(R.string.project_task_prompt_placeholder),
                            color = textSecondary,
                        )
                    },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 200.dp),
                    enabled = !uiState.isSending,
                    shape = cardShape,
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = subtle,
                        unfocusedContainerColor = subtle,
                        disabledContainerColor = subtle,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                        cursorColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                        focusedTextColor = textPrimary,
                        unfocusedTextColor = textPrimary,
                    ),
                )

                Button(
                    onClick = {
                        val targetSpace = workspace ?: return@Button
                        val agentId = selectedAgentId ?: return@Button
                        // 发送确认触觉；CONFIRM 需要 API 30，低版本退回 LONG_PRESS。
                        val haptic = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                            HapticFeedbackConstants.CONFIRM
                        } else {
                            HapticFeedbackConstants.LONG_PRESS
                        }
                        view.performHapticFeedback(haptic)
                        viewModel.createChat(
                            workspace = targetSpace,
                            prompt = prompt,
                            agentId = agentId,
                            projectId = project.id,
                        )
                    },
                    enabled = canSend,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (uiState.isSending) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null)
                        Spacer(modifier = Modifier.width(TTSpacing.sm))
                        Text(stringResource(R.string.project_task_send))
                    }
                }
                Spacer(modifier = Modifier.height(TTSpacing.xl))
            }
        }
    }

    if (showAgentPicker) {
        AlertDialog(
            onDismissRequest = { showAgentPicker = false },
            containerColor = canvas,
            title = { Text(stringResource(R.string.project_task_choose_agent)) },
            text = {
                Column {
                    agentOptions.forEach { option ->
                        Surface(
                            onClick = {
                                selectedAgentId = option.id
                                showAgentPicker = false
                            },
                            modifier = Modifier.fillMaxWidth(),
                            color = Color.Transparent,
                        ) {
                            Column(modifier = Modifier.padding(vertical = TTSpacing.sm)) {
                                Text(option.name, fontWeight = FontWeight.SemiBold, color = textPrimary)
                                option.responsibility?.takeIf { it.isNotBlank() }?.let {
                                    Text(
                                        it,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = textSecondary,
                                    )
                                }
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { showAgentPicker = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    uiState.errorMessage?.let { error ->
        AlertDialog(
            onDismissRequest = viewModel::clearTransientState,
            containerColor = canvas,
            title = { Text(stringResource(R.string.common_loading_failed)) },
            text = { Text(error) },
            confirmButton = {
                TextButton(onClick = viewModel::clearTransientState) {
                    Text(stringResource(R.string.common_confirm))
                }
            },
        )
    }
}
