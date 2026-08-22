package com.tabtin.mobile.features.capabilities

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import com.tabtin.mobile.R
import com.tabtin.mobile.data.adb.AdbConnectionState
import com.tabtin.mobile.data.privileged.PrivilegedProcessState
import com.tabtin.mobile.data.websocket.AutoRecoverState
import com.tabtin.mobile.data.websocket.L2AutoRecoveryManager
import com.tabtin.mobile.ui.theme.TTSpacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun DeviceCapabilitiesScreen(
    viewModel: CapabilitiesViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val lifecycleState by lifecycle.currentStateFlow.collectAsState()

    LaunchedEffect(lifecycleState) {
        if (lifecycleState.isAtLeast(Lifecycle.State.RESUMED)) {
            viewModel.refreshPermissions()
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        viewModel.refreshPermissions()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.capabilities_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = null,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(TTSpacing.lg),
        ) {
            L1PermissionsCard(
                permissions = state.l1Permissions,
                onRequestPermission = { item ->
                    if (item.isSpecial) {
                        context.startActivity(
                            Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                    } else {
                        item.permission?.let { permissionLauncher.launch(arrayOf(it)) }
                    }
                },
            )

            Spacer(Modifier.height(TTSpacing.lg))

            L2DeveloperCard(
                state = state,
                onPairAndConnect = viewModel::pairAndConnect,
                onReconnect = viewModel::connectOnly,
                onStop = viewModel::stopPrivilegedProcess,
                onRestartPrivileged = viewModel::startPrivilegedProcess,
                onOpenDevSettings = {
                    context.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                },
            )
        }
    }
}

@Composable
private fun L1PermissionsCard(
    permissions: List<PermissionItem>,
    onRequestPermission: (PermissionItem) -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
    ) {
        Column(Modifier.padding(TTSpacing.lg)) {
            Text(
                stringResource(R.string.capabilities_l1_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                stringResource(R.string.capabilities_l1_subtitle),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(TTSpacing.md))

            permissions.forEach { item ->
                PermissionRow(
                    item = item,
                    onRequest = { onRequestPermission(item) },
                )
            }
        }
    }
}

@Composable
private fun PermissionRow(
    item: PermissionItem,
    onRequest: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (item.granted) Icons.Default.CheckCircle else Icons.Default.RadioButtonUnchecked,
            contentDescription = null,
            tint = if (item.granted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Text(
            stringResource(item.labelRes),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        if (item.granted) {
            Text(
                stringResource(R.string.capabilities_granted),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
            )
        } else {
            if (item.isSpecial) {
                TextButton(onClick = onRequest) {
                    Text(stringResource(R.string.capabilities_go_settings))
                }
            } else {
                TextButton(onClick = onRequest) {
                    Text(stringResource(R.string.capabilities_request))
                }
            }
        }
    }
}

@Composable
private fun L2DeveloperCard(
    state: CapabilitiesUiState,
    onPairAndConnect: (String) -> Unit,
    onReconnect: () -> Unit,
    onStop: () -> Unit,
    onRestartPrivileged: () -> Unit,
    onOpenDevSettings: () -> Unit,
) {
    var pairingCode by rememberSaveable { mutableStateOf("") }
    var showGuide by remember { mutableStateOf(false) }

    val isL2Active = state.privilegedState == PrivilegedProcessState.RUNNING
    val isAdbBusy = state.adbState in setOf(
        AdbConnectionState.PAIRING,
        AdbConnectionState.DISCOVERING,
        AdbConnectionState.CONNECTING,
        AdbConnectionState.AWAITING_APPROVAL,
    )
    val isBusy = state.isOperating || isAdbBusy || state.privilegedState == PrivilegedProcessState.STARTING

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
    ) {
        Column(Modifier.padding(TTSpacing.lg)) {
            Text(
                stringResource(R.string.capabilities_l2_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                stringResource(R.string.capabilities_l2_subtitle),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(TTSpacing.md))

            if (!state.l2Supported) {
                val isHarmonyNext = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Default.Warning,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(20.dp),
                    )
                    Spacer(Modifier.width(TTSpacing.sm))
                    Text(
                        stringResource(
                            if (isHarmonyNext) R.string.capabilities_l2_not_supported_harmony
                            else R.string.capabilities_l2_not_supported
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                return@Column
            }

            Text(
                stringResource(R.string.capabilities_l2_screen_auto),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                stringResource(R.string.capabilities_l2_app_mgmt),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(TTSpacing.md))

            if (isL2Active) {
                L2ActiveSection(
                    onStop = onStop,
                )
                return@Column
            }

            when (val recover = state.autoRecoverState) {
                is AutoRecoverState.Recovering -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(TTSpacing.sm))
                        Text(
                            "${stringResource(R.string.capabilities_l2_auto_recovering)} (${recover.attempt}/${recover.maxAttempts})",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.height(TTSpacing.xs))
                }
                is AutoRecoverState.Succeeded -> {
                    Text(
                        stringResource(R.string.capabilities_l2_auto_recover_succeeded),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.height(TTSpacing.xs))
                }
                is AutoRecoverState.Failed -> {
                    val failText = when (recover.reason) {
                        L2AutoRecoveryManager.RECOVER_REASON_WIRELESS_NOT_ENABLED ->
                            stringResource(R.string.capabilities_l2_recover_wireless_off)
                        L2AutoRecoveryManager.RECOVER_REASON_MAX_ATTEMPTS ->
                            stringResource(R.string.capabilities_l2_recover_max_attempts)
                        else -> stringResource(R.string.capabilities_l2_auto_recover_failed)
                    }
                    Text(
                        failText,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                    if (recover.reason == L2AutoRecoveryManager.RECOVER_REASON_WIRELESS_NOT_ENABLED) {
                        TextButton(onClick = onOpenDevSettings) {
                            Text(stringResource(R.string.capabilities_l2_open_wireless_settings))
                        }
                    }
                    Spacer(Modifier.height(TTSpacing.xs))
                }
                else -> {}
            }

            if (isBusy) {
                L2ProgressSection(adbState = state.adbState, privilegedState = state.privilegedState)
                return@Column
            }

            if (state.adbState == AdbConnectionState.ERROR || state.privilegedState == PrivilegedProcessState.ERROR) {
                L2ErrorSection(
                    adbError = state.adbError,
                    privilegedError = state.privilegedError,
                    adbState = state.adbState,
                    privilegedState = state.privilegedState,
                )
                if (state.privilegedState == PrivilegedProcessState.ERROR && state.adbState == AdbConnectionState.CONNECTED) {
                    Spacer(Modifier.height(TTSpacing.xs))
                    FilledTonalButton(onClick = onRestartPrivileged) {
                        Text(stringResource(R.string.capabilities_l2_restart_privileged))
                    }
                }
                Spacer(Modifier.height(TTSpacing.sm))
            }

            HorizontalDivider(Modifier.padding(vertical = TTSpacing.xs))

            // Step 1: Developer options guide
            Text(
                stringResource(R.string.capabilities_l2_step1_title),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(TTSpacing.xs))

            state.setupGuide?.let { guide ->
                TextButton(onClick = { showGuide = !showGuide }) {
                    Text(
                        if (showGuide) stringResource(R.string.capabilities_l2_guide_collapse, guide.title)
                        else stringResource(R.string.capabilities_l2_guide_expand, guide.title),
                    )
                }
                AnimatedVisibility(visible = showGuide) {
                    Column(Modifier.padding(start = TTSpacing.md)) {
                        guide.steps.forEachIndexed { idx, step ->
                            Text(
                                "${idx + 1}. $step",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        guide.warnings.forEach { warning ->
                            Spacer(Modifier.height(TTSpacing.xs))
                            Row(verticalAlignment = Alignment.Top) {
                                Icon(
                                    Icons.Default.Info,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.tertiary,
                                    modifier = Modifier.size(16.dp),
                                )
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    warning,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.tertiary,
                                )
                            }
                        }
                    }
                }
            }

            if (state.xiaomiDeveloperWaitDays != null) {
                Spacer(Modifier.height(TTSpacing.xs))
                Row(verticalAlignment = Alignment.Top) {
                    Icon(
                        Icons.Default.Warning,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        stringResource(R.string.capabilities_l2_xiaomi_wait_days, state.xiaomiDeveloperWaitDays),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }

            if (state.requiresSpecialBackgroundSettings) {
                Spacer(Modifier.height(TTSpacing.xs))
                Row(verticalAlignment = Alignment.Top) {
                    Icon(
                        Icons.Default.Info,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.tertiary,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        stringResource(R.string.capabilities_l2_background_settings),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
            }

            Spacer(Modifier.height(TTSpacing.sm))
            FilledTonalButton(onClick = onOpenDevSettings) {
                Text(stringResource(R.string.capabilities_l2_setup))
            }

            Spacer(Modifier.height(TTSpacing.lg))
            HorizontalDivider(Modifier.padding(vertical = TTSpacing.xs))

            // Step 2: Pairing code input
            Text(
                stringResource(R.string.capabilities_l2_step2_title),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(TTSpacing.xs))
            Text(
                stringResource(R.string.capabilities_l2_step2_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(TTSpacing.sm))

            if (state.autoPairingInProgress) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(TTSpacing.sm))
                    Text(
                        stringResource(R.string.capabilities_l2_auto_pairing),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                Spacer(Modifier.height(TTSpacing.sm))
            }

            OutlinedTextField(
                value = pairingCode,
                onValueChange = { v -> pairingCode = v.filter { it.isDigit() }.take(6) },
                label = { Text(stringResource(R.string.capabilities_l2_pair_code_label)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Number,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(
                    onDone = {
                        if (pairingCode.length == 6) onPairAndConnect(pairingCode)
                    },
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(TTSpacing.sm))

            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                FilledTonalButton(
                    onClick = { onPairAndConnect(pairingCode) },
                    enabled = pairingCode.length == 6,
                ) {
                    Text(stringResource(R.string.capabilities_l2_pair_btn))
                }
                if (state.hasPreviouslyPaired) {
                    OutlinedButton(onClick = onReconnect) {
                        Text(stringResource(R.string.capabilities_l2_reconnect_btn))
                    }
                }
            }
        }
    }
}

@Composable
private fun L2ActiveSection(onStop: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Default.CheckCircle,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(TTSpacing.xs))
            Text(
                stringResource(R.string.capabilities_l2_connected),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        OutlinedButton(onClick = onStop) {
            Text(stringResource(R.string.capabilities_l2_stop))
        }
    }
}

@Composable
private fun L2ProgressSection(adbState: AdbConnectionState, privilegedState: PrivilegedProcessState) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(TTSpacing.sm))
        val messageRes = when {
            adbState == AdbConnectionState.PAIRING -> R.string.capabilities_l2_pairing
            adbState == AdbConnectionState.DISCOVERING -> R.string.capabilities_l2_discovering
            adbState == AdbConnectionState.CONNECTING -> R.string.capabilities_l2_connecting
            adbState == AdbConnectionState.AWAITING_APPROVAL -> R.string.capabilities_l2_awaiting_approval
            privilegedState == PrivilegedProcessState.STARTING -> R.string.capabilities_l2_starting
            else -> R.string.capabilities_l2_starting
        }
        Text(
            stringResource(messageRes),
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun L2ErrorSection(
    adbError: String?,
    privilegedError: String?,
    adbState: AdbConnectionState,
    privilegedState: PrivilegedProcessState,
) {
    val errorMsg = when {
        adbState == AdbConnectionState.ERROR && adbError != null -> adbError
        privilegedState == PrivilegedProcessState.ERROR && privilegedError != null -> privilegedError
        else -> return
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            Icons.Default.Warning,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.error,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Text(
            errorMsg,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.weight(1f),
        )
    }
}
