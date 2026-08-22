package com.tabtin.mobile.features.space

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.RuntimeDevice
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun AgentListScreen(
    viewModel: AgentListViewModel,
    onSpaceClick: (Space) -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    var agentToDelete by remember { mutableStateOf<Space?>(null) }
    var agentToEdit by remember { mutableStateOf<Space?>(null) }

    LaunchedEffect(Unit) {
        viewModel.toastEvent.collect { toast ->
            when (toast) {
                is AgentToast.Updated -> {
                    agentToEdit = null
                    snackbar.showSnackbar(context.getString(toast.messageRes))
                }
                else -> snackbar.showSnackbar(context.getString(toast.messageRes))
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        PullToRefreshBox(
            isRefreshing = state.isRefreshing,
            onRefresh = viewModel::refresh,
            modifier = Modifier.fillMaxSize(),
        ) {
            when {
                state.isLoading -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }

                state.errorRes != null && state.spaces.isEmpty() -> {
                    val errorRes = state.errorRes!!
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                text = stringResource(errorRes),
                                color = MaterialTheme.colorScheme.error,
                            )
                            Spacer(Modifier.height(TTSpacing.lg))
                            Button(onClick = { viewModel.loadAgents() }) {
                                Text(stringResource(R.string.common_retry))
                            }
                        }
                    }
                }

                state.spaces.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                stringResource(R.string.space_list_empty),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(TTSpacing.md))
                            Text(
                                stringResource(R.string.space_list_empty_description),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }

                else -> {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(top = TTSpacing.sm, bottom = TTSpacing.lg),
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
                    ) {
                        items(state.spaces, key = { it.id }) { space ->
                            AgentRow(
                                space = space,
                                agent = space.primaryAgentId?.let(state.agentsById::get),
                                device = space.executionDeviceId?.let(state.devicesById::get),
                                isMetadataLoading = state.isLoadingMetadata,
                                onClick = { onSpaceClick(space) },
                                onEdit = { agentToEdit = space },
                                onDelete = { agentToDelete = space },
                            )
                        }

                        item(key = "hint") {
                            Text(
                                text = stringResource(R.string.space_list_long_press_hint),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = TTSpacing.xl, vertical = TTSpacing.md),
                            )
                        }
                    }
                }
            }
        }

        SnackbarHost(
            hostState = snackbar,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }

    agentToEdit?.let { space ->
        EditAgentSheet(
            space = space,
            isSaving = state.isMutatingAgent,
            onDismiss = { agentToEdit = null },
            onSave = { name -> viewModel.updateAgent(space.id, name) },
        )
    }

    agentToDelete?.let { space ->
        AlertDialog(
            onDismissRequest = { agentToDelete = null },
            title = { Text(stringResource(R.string.agent_delete)) },
            text = { Text(stringResource(R.string.agent_delete_confirm, space.name)) },
            confirmButton = {
                Button(
                    onClick = { viewModel.deleteSpace(space.id); agentToDelete = null },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                    ),
                ) { Text(stringResource(R.string.common_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { agentToDelete = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

}

// ── Edit Agent Sheet ────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditAgentSheet(
    space: Space,
    isSaving: Boolean,
    onDismiss: () -> Unit,
    onSave: (name: String?) -> Unit,
) {
    var editName by remember { mutableStateOf(space.name) }

    TTBottomSheet(
        onDismissRequest = { if (!isSaving) onDismiss() },
        sheetState = rememberTTSheetState(),
    ) {
        TTSheetColumn(
            modifier = Modifier
                .padding(horizontal = TTSpacing.xl)
                .padding(bottom = TTSpacing.xxxl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            Text(
                text = stringResource(R.string.agent_edit_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )

            OutlinedTextField(
                value = editName,
                onValueChange = { editName = it },
                label = { Text(stringResource(R.string.agent_edit_name_hint)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                enabled = !isSaving,
            )

            Button(
                onClick = { onSave(editName.takeIf { it != space.name }) },
                enabled = editName.isNotBlank() && !isSaving,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (isSaving) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(TTSpacing.sm))
                }
                Text(stringResource(R.string.common_save))
            }

            Spacer(Modifier.height(TTSpacing.md))
        }
    }
}

// ── Space Row ───────────────────────────────────────────

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AgentRow(
    space: Space,
    agent: Agent?,
    device: RuntimeDevice?,
    isMetadataLoading: Boolean,
    onClick: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    var showMenu by remember { mutableStateOf(false) }
    val agentName = agent?.name?.trim()?.takeIf { it.isNotEmpty() }
    val agentText = when {
        agentName != null -> stringResource(R.string.space_list_primary_agent, agentName)
        space.primaryAgentId == null -> stringResource(R.string.space_list_primary_agent_unassigned)
        isMetadataLoading -> stringResource(R.string.space_list_primary_agent_loading)
        else -> stringResource(R.string.space_list_primary_agent_unavailable)
    }
    val deviceText = when {
        device != null -> {
            val displayName = device.name?.takeIf { it.isNotBlank() }
                ?: stringResource(R.string.space_list_unnamed_device)
            val status = when (device.status?.lowercase()) {
                "online" -> stringResource(R.string.space_list_device_online)
                "busy" -> stringResource(R.string.space_list_device_busy)
                "offline" -> stringResource(R.string.space_list_device_offline)
                else -> stringResource(R.string.space_list_device_unknown)
            }
            stringResource(R.string.space_list_execution_device, displayName, status)
        }
        space.executionDeviceId == null -> stringResource(R.string.space_list_execution_device_unbound)
        isMetadataLoading -> stringResource(R.string.space_list_execution_device_loading)
        else -> stringResource(R.string.space_list_execution_device_unavailable)
    }
    val deviceColor = if (device?.isAvailableForExecution == true) {
        ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess)
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }

    Box {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
            shape = RoundedCornerShape(14.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.36f),
            border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .combinedClickable(onClick = onClick, onLongClick = { showMenu = true })
                    .padding(TTSpacing.md),
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
            ) {
                AgentLeadingIcon(name = space.name, avatar = space.avatar)
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    Text(
                        text = space.name,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    if (space.subtitle.isNotBlank()) {
                        Text(
                            text = space.subtitle,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                        )
                    }
                    SpaceMetadataLine(
                        icon = Icons.Default.SmartToy,
                        text = agentText,
                        tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    )
                    SpaceMetadataLine(
                        icon = Icons.Default.Computer,
                        text = deviceText,
                        tint = deviceColor,
                    )
                }
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        DropdownMenu(
            expanded = showMenu,
            onDismissRequest = { showMenu = false },
        ) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.agent_edit)) },
                onClick = { showMenu = false; onEdit() },
            )
            DropdownMenuItem(
                text = {
                    Text(
                        stringResource(R.string.agent_delete),
                        color = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                    )
                },
                onClick = { showMenu = false; onDelete() },
            )
        }
    }
}

@Composable
private fun SpaceMetadataLine(
    icon: ImageVector,
    text: String,
    tint: androidx.compose.ui.graphics.Color,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(15.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
    }
}

@Composable
private fun AgentLeadingIcon(name: String, avatar: String?) {
    TTAvatar(
        name = name,
        imageUrl = avatar,
    )
}
