package com.tabtin.mobile.features.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.NetworkCheck
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SettingsEthernet
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import android.widget.Toast
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.BuildConfig
import com.chuckerteam.chucker.api.Chucker
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SettingsDebugEnvironmentScreen(
    onBack: () -> Unit,
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val focusManager = LocalFocusManager.current
    val context = LocalContext.current
    val state = viewModel.debugEnvironment
    val snackbarHostState = remember { SnackbarHostState() }
    var showInvalidDraft by remember { mutableStateOf(false) }

    var preset by remember(state.preset) { mutableStateOf(state.preset) }
    var customBaseUrl by remember(state.customBaseUrl) { mutableStateOf(state.customBaseUrl) }
    var advancedEnabled by remember(state.advancedEnabled) { mutableStateOf(state.advancedEnabled) }
    var advancedApiUrl by remember(state.advancedApiUrl) { mutableStateOf(state.advancedApiUrl) }
    var advancedWsUrl by remember(state.advancedWsUrl) { mutableStateOf(state.advancedWsUrl) }
    var advancedWebUrl by remember(state.advancedWebUrl) { mutableStateOf(state.advancedWebUrl) }
    var advancedCentrifugoUrl by remember(state.advancedCentrifugoUrl) { mutableStateOf(state.advancedCentrifugoUrl) }
    var sentryDsn by remember(state.sentryDsn) { mutableStateOf(state.sentryDsn) }
    val hasNetworkDraftChanges = preset != state.preset ||
        customBaseUrl != state.customBaseUrl ||
        advancedEnabled != state.advancedEnabled ||
        advancedApiUrl != state.advancedApiUrl ||
        advancedWsUrl != state.advancedWsUrl ||
        advancedWebUrl != state.advancedWebUrl ||
        advancedCentrifugoUrl != state.advancedCentrifugoUrl
    val hasDraftChanges = hasNetworkDraftChanges ||
        sentryDsn.trim() != state.sentryDsn

    LaunchedEffect(showInvalidDraft) {
        if (showInvalidDraft) {
            snackbarHostState.showSnackbar("地址无效，请检查环境配置")
            showInvalidDraft = false
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_debug_environment)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .imePadding()
                .pointerInput(Unit) {
                    detectTapGestures(onTap = { focusManager.clearFocus() })
                },
            contentPadding = androidx.compose.foundation.layout.PaddingValues(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            if (BuildConfig.DEBUG) {
                item {
                    SettingsHomeSection(title = stringResource(R.string.settings_debug_tools)) {
                        TextButton(
                            onClick = { context.startActivity(Chucker.getLaunchIntent(context)) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(Icons.Default.NetworkCheck, contentDescription = null)
                            Spacer(Modifier.width(TTSpacing.sm))
                            Text(stringResource(R.string.settings_chucker_network_inspector))
                        }
                    }
                }
            }

            item {
                SettingsHomeSection(title = "当前连接") {
                    DebugEndpointRow(
                        icon = Icons.Default.NetworkCheck,
                        title = "API（通知等 REST 请求同此地址）",
                        value = state.effectiveApiUrl,
                    )
                    SettingsHomeDivider()
                    DebugEndpointRow(
                        icon = Icons.Default.SettingsEthernet,
                        title = "任务 WebSocket",
                        value = state.effectiveWsUrl,
                    )
                    SettingsHomeDivider()
                    DebugEndpointRow(
                        icon = Icons.Default.Language,
                        title = "Web",
                        value = state.effectiveWebUrl,
                    )
                    SettingsHomeDivider()
                    DebugEndpointRow(
                        icon = Icons.Default.NetworkCheck,
                        title = "消息实时连接",
                        value = state.effectiveCentrifugoUrl,
                    )
                }
            }

            item {
                SettingsHomeSection(title = "环境") {
                    Column(
                        modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.md),
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
                    ) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            DebugPresetButton(
                                label = "正式",
                                selected = preset == "production",
                                onClick = { preset = "production" },
                                modifier = Modifier.weight(1f),
                            )
                            DebugPresetButton(
                                label = "开发",
                                selected = preset == "development",
                                onClick = { preset = "development" },
                                modifier = Modifier.weight(1f),
                            )
                            DebugPresetButton(
                                label = "自定义",
                                selected = preset == "custom",
                                onClick = { preset = "custom" },
                                modifier = Modifier.weight(1f),
                            )
                        }

                        if (preset == "custom") {
                            DebugUrlField(
                                label = "基础地址",
                                value = customBaseUrl,
                                onValueChange = { customBaseUrl = it },
                                placeholder = "http://1.2.3.4:1234",
                            )
                            Text(
                                text = "自动生成 /api、/ws/v1/gateway、Web 根路径和 /connection/websocket。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            MobileEnvironmentQrScanButton(
                                onConfiguration = { configuration ->
                                    preset = "custom"
                                    customBaseUrl = configuration.webUrl
                                    advancedEnabled = true
                                    advancedApiUrl = configuration.apiUrl
                                    advancedWsUrl = configuration.websocketUrl
                                    advancedWebUrl = configuration.webUrl
                                    advancedCentrifugoUrl = configuration.centrifugoUrl
                                    Toast.makeText(
                                        context,
                                        R.string.settings_debug_scan_qr_succeeded,
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                },
                                onInvalidQrCode = {
                                    Toast.makeText(
                                        context,
                                        R.string.settings_debug_scan_qr_invalid,
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                },
                            )
                        }
                    }
                }
            }

            item {
                SettingsHomeSection(title = "高级自定义") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            modifier = Modifier
                                .size(32.dp)
                                .background(SettingsHomeIconTone.Accent.backgroundColor(), shape = TTRadius.Shapes.sm),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = Icons.Default.Tune,
                                contentDescription = null,
                                tint = SettingsHomeIconTone.Accent.foregroundColor(),
                                modifier = Modifier.size(18.dp),
                            )
                        }
                        Spacer(Modifier.width(TTSpacing.md))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                "独立覆盖某个地址",
                                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                "仅在需要拆分服务主机时逐项覆盖。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Switch(checked = advancedEnabled, onCheckedChange = { advancedEnabled = it })
                    }
                    if (advancedEnabled) {
                        SettingsHomeDivider()
                        Column(
                            modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.md),
                            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
                        ) {
                            DebugUrlField("API", advancedApiUrl, { advancedApiUrl = it }, "https://api.example.com/api")
                            DebugUrlField("任务 WebSocket", advancedWsUrl, { advancedWsUrl = it }, "wss://api.example.com/ws/v1/gateway")
                            DebugUrlField("Web", advancedWebUrl, { advancedWebUrl = it }, "https://web.example.com")
                            DebugUrlField("消息实时连接", advancedCentrifugoUrl, { advancedCentrifugoUrl = it }, "wss://centrifugo.example.com/connection/websocket")
                            Text(
                                text = "留空即沿用上方环境自动生成的地址。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            item {
                SettingsHomeSection(title = stringResource(R.string.settings_debug_sentry_section)) {
                    Column(
                        modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.md),
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
                    ) {
                        DebugUrlField(
                            stringResource(R.string.settings_debug_sentry_dsn),
                            sentryDsn,
                            { sentryDsn = it },
                            "https://key@host/1",
                        )
                        Text(
                            text = stringResource(R.string.settings_debug_sentry_dsn_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            item {
                SettingsHomeSection(title = "操作") {
                    TextButton(
                        onClick = viewModel::resetDebugEnvironment,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Default.Refresh, contentDescription = null)
                        Spacer(Modifier.width(TTSpacing.sm))
                        Text("Reset")
                    }
                    SettingsHomeDivider()
                    Button(
                        onClick = {
                            val applied = viewModel.applyDebugEnvironment(
                                DebugEnvironmentDraft(
                                    preset = preset,
                                    customBaseUrl = customBaseUrl,
                                    advancedEnabled = advancedEnabled,
                                    advancedApiUrl = advancedApiUrl,
                                    advancedWsUrl = advancedWsUrl,
                                    advancedWebUrl = advancedWebUrl,
                                    advancedCentrifugoUrl = advancedCentrifugoUrl,
                                    sentryDsn = sentryDsn,
                                ),
                            )
                            if (!applied) showInvalidDraft = true
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
                        enabled = hasDraftChanges,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess),
                        ),
                    ) {
                        Icon(Icons.Default.CheckCircle, contentDescription = null)
                        Spacer(Modifier.width(TTSpacing.sm))
                        Text("Apply")
                    }
                }
            }
        }
    }
}

@Composable
private fun DebugEndpointRow(
    icon: ImageVector,
    title: String,
    value: String,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .background(SettingsHomeIconTone.Neutral.backgroundColor(), shape = TTRadius.Shapes.sm),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = SettingsHomeIconTone.Neutral.foregroundColor(),
                modifier = Modifier.size(18.dp),
            )
        }
        Spacer(Modifier.width(TTSpacing.md))
        Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs)) {
            Text(
                text = title,
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = value,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.MiddleEllipsis,
            )
        }
    }
}

@Composable
private fun DebugPresetButton(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedButton(
        onClick = onClick,
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = if (selected) {
                SettingsHomeIconTone.Accent.backgroundColor()
            } else {
                MaterialTheme.colorScheme.surface
            },
        ),
        modifier = modifier,
    ) {
        Text(label, maxLines = 1)
    }
}

@Composable
private fun DebugUrlField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = { Text(placeholder) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        modifier = Modifier.fillMaxWidth(),
    )
}
