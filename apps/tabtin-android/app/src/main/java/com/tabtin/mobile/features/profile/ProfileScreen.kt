package com.tabtin.mobile.features.profile

import android.content.ClipData
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Numbers
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.PendingInvitation
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.features.workspace.InvitationResponseSheet
import com.tabtin.mobile.ui.components.IdentityColorAvatar
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.components.TTFormSheet
import com.tabtin.mobile.ui.theme.AppLanguage
import com.tabtin.mobile.ui.theme.IdentityAvatar
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ThemeMode
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
@Deprecated(
    message = "Legacy profile shell is no longer on the main path. Use MeScreen + SettingsHomeScreen.",
)
public fun ProfileScreen(
    onLogout: () -> Unit,
    onBack: (() -> Unit)? = null,
    onNavigateToCapabilities: () -> Unit = {},
    onNavigateToAbout: () -> Unit = {},
    onNavigateToEdit: () -> Unit = {},
    onNavigateToOrganizationSettings: (String) -> Unit = {},
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val currentTheme by viewModel.themeMode.collectAsState()
    val profile = viewModel.profileState
    val debugEnvironment = viewModel.debugEnvironment
    val isLoading = viewModel.isLoading
    val vmError = viewModel.error
    val organizations by viewModel.organizations.collectAsState()
    val selectedWs by viewModel.selectedOrganization.collectAsState()
    val switchingId = viewModel.isSwitchingOrganization
    val wsError by viewModel.organizationError.collectAsState()
    val clipboard = LocalClipboard.current
    val coroutineScope = rememberCoroutineScope()
    val context = LocalContext.current
    var showLogoutConfirm by remember { mutableStateOf(false) }
    var showDebugEnvironment by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }
    val copiedText = stringResource(R.string.profile_copied)

    LaunchedEffect(vmError) {
        vmError?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearError()
        }
    }

    LaunchedEffect(wsError) {
        wsError?.let {
            snackbarHostState.showSnackbar(it)
        }
    }

    Scaffold(
        topBar = {
            if (onBack != null) {
                TopAppBar(
                    title = { Text(stringResource(R.string.profile_title)) },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = stringResource(R.string.common_back),
                            )
                        }
                    },
                )
            }
        },
    ) { innerPadding ->
        Box(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
            PullToRefreshBox(
                isRefreshing = isLoading,
                onRefresh = { viewModel.refreshProfile() },
                modifier = Modifier.fillMaxSize(),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState()),
                ) {
                    Spacer(Modifier.height(TTSpacing.xl))

                    ProfileHeader(profile = profile, onEditClick = onNavigateToEdit)

                    Spacer(Modifier.height(TTSpacing.xxxl))

                    ContactSection(profile = profile)

                    Spacer(Modifier.height(TTSpacing.xxxl))

                    MenuGroup {
                        ThemeDropdownRow(
                            currentMode = currentTheme,
                            onModeSelected = viewModel::setThemeMode,
                        )

                        LanguageDropdownRow(
                            currentLanguage = viewModel.currentLanguage,
                            onLanguageSelected = viewModel::setLanguage,
                        )

                        MenuRow(
                            icon = Icons.Default.Notifications,
                            title = stringResource(R.string.profile_notification),
                            onClick = {
                                val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                                        putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                                    }
                                } else {
                                    Intent(Settings.ACTION_SETTINGS)
                                }
                                context.startActivity(intent)
                            },
                        ) {
                            Icon(
                                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }

                    Spacer(Modifier.height(TTSpacing.xxxl))

                    DeviceInfoSection(
                        profile = profile,
                        onNavigateToCapabilities = onNavigateToCapabilities,
                        onNavigateToAbout = onNavigateToAbout,
                        clipboard = clipboard,
                        coroutineScope = coroutineScope,
                        copiedText = copiedText,
                        context = context,
                        debugEnvironment = debugEnvironment,
                        onShowDebugEnvironment = { showDebugEnvironment = true },
                    )

                    OrganizationSection(
                        organizations = organizations,
                        selectedOrganization = selectedWs,
                        switchingId = switchingId,
                        onSwitch = viewModel::switchOrganization,
                        onSelectedClick = { wsId -> onNavigateToOrganizationSettings(wsId) },
                        pendingInvitations = viewModel.pendingInvitations,
                        respondingInvitationId = viewModel.respondingInvitationId,
                        onRespondToInvitation = viewModel::respondToInvitation,
                    )

                    AccountStatsSection(profile = profile)

                    Spacer(Modifier.height(TTSpacing.xxxl))

                    LogoutButton(onClick = { showLogoutConfirm = true })

                    Spacer(Modifier.height(TTSpacing.huge))
                }
            }

            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }

    if (showLogoutConfirm) {
        AlertDialog(
            onDismissRequest = { showLogoutConfirm = false },
            title = { Text(stringResource(R.string.profile_logout_confirm_title)) },
            text = { Text(stringResource(R.string.profile_logout_confirm_message)) },
            confirmButton = {
                Button(
                    onClick = {
                        showLogoutConfirm = false
                        onLogout()
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                    ),
                ) {
                    Text(stringResource(R.string.profile_logout))
                }
            },
            dismissButton = {
                TextButton(onClick = { showLogoutConfirm = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    if (showDebugEnvironment) {
        DebugEnvironmentDialog(
            state = debugEnvironment,
            onDismiss = { showDebugEnvironment = false },
            onApply = { draft ->
                if (viewModel.applyDebugEnvironment(draft)) {
                    showDebugEnvironment = false
                }
            },
            onReset = {
                showDebugEnvironment = false
                viewModel.resetDebugEnvironment()
            },
        )
    }
}

@Composable
private fun ProfileHeader(profile: ProfileUiState, onEditClick: () -> Unit) {
    val displayName = profile.nickname?.takeIf { it.isNotBlank() }
        ?: stringResource(R.string.profile_default_name)

    Column(modifier = Modifier.padding(horizontal = TTSpacing.xl)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // 「当前登录的人」在 Android 一律圆形（顶栏入口 / 编辑页同口径）；圆角方留给 Agent、Workspace。
            IdentityColorAvatar(
                name = displayName,
                seed = IdentityAvatar.colorSeed(profile.userId, displayName),
                imageUrl = profile.avatar,
                size = 56.dp,
            )

            Spacer(Modifier.weight(1f))

            IconButton(onClick = onEditClick) {
                Icon(
                    Icons.Default.Edit,
                    contentDescription = stringResource(R.string.profile_edit_title),
                    tint = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                    modifier = Modifier.size(26.dp),
                )
            }
        }

        Spacer(Modifier.height(TTSpacing.lg))

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Text(
                text = displayName,
                style = TTFonts.heading.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
            )

            if (!profile.username.isNullOrBlank()) {
                Text(
                    text = "@${profile.username}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Spacer(Modifier.height(TTSpacing.xs))

        Text(
            text = profile.bio?.takeIf { it.isNotBlank() }
                ?: stringResource(R.string.profile_bio_empty),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ContactSection(profile: ProfileUiState) {
    val hasContact = !profile.phone.isNullOrBlank() || !profile.email.isNullOrBlank()
    if (!hasContact) return

    val successColor = ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess)

    MenuGroup {
        if (!profile.phone.isNullOrBlank()) {
            MenuRow(icon = Icons.Default.Phone, title = maskPhone(profile.phone)) {
                if (profile.isVerifiedPhone == true) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                    ) {
                        Icon(
                            Icons.Default.Check,
                            contentDescription = null,
                            tint = successColor,
                            modifier = Modifier.size(16.dp),
                        )
                        Text(
                            text = stringResource(R.string.profile_verified),
                            style = MaterialTheme.typography.labelSmall,
                            color = successColor,
                        )
                    }
                }
            }
        }
        if (!profile.email.isNullOrBlank()) {
            MenuRow(icon = Icons.Default.Email, title = maskEmail(profile.email)) {
                if (profile.isVerifiedEmail == true) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                    ) {
                        Icon(
                            Icons.Default.Check,
                            contentDescription = null,
                            tint = successColor,
                            modifier = Modifier.size(16.dp),
                        )
                        Text(
                            text = stringResource(R.string.profile_verified),
                            style = MaterialTheme.typography.labelSmall,
                            color = successColor,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ThemeDropdownRow(
    currentMode: ThemeMode,
    onModeSelected: (ThemeMode) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val currentLabel = when (currentMode) {
        ThemeMode.SYSTEM -> stringResource(R.string.profile_theme_system)
        ThemeMode.LIGHT -> stringResource(R.string.profile_theme_light)
        ThemeMode.DARK -> stringResource(R.string.profile_theme_dark)
    }

    Box {
        MenuRow(
            icon = Icons.Default.Palette,
            title = stringResource(R.string.profile_appearance),
            onClick = { expanded = true },
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
            ) {
                Text(
                    text = currentLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Icon(
                    Icons.Default.UnfoldMore,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            ThemeMode.entries.forEach { mode ->
                val label = when (mode) {
                    ThemeMode.SYSTEM -> stringResource(R.string.profile_theme_system)
                    ThemeMode.LIGHT -> stringResource(R.string.profile_theme_light)
                    ThemeMode.DARK -> stringResource(R.string.profile_theme_dark)
                }
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        onModeSelected(mode)
                        expanded = false
                    },
                    leadingIcon = if (currentMode == mode) {
                        {
                            Icon(
                                Icons.Default.Check,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    } else null,
                )
            }
        }
    }
}

@Composable
private fun LanguageDropdownRow(
    currentLanguage: AppLanguage,
    onLanguageSelected: (AppLanguage) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val currentLabel = stringResource(currentLanguage.labelRes)

    Box {
        MenuRow(
            icon = Icons.Default.Language,
            title = stringResource(R.string.profile_language),
            onClick = { expanded = true },
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
            ) {
                Text(
                    text = currentLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Icon(
                    Icons.Default.UnfoldMore,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            AppLanguage.entries.forEach { language ->
                DropdownMenuItem(
                    text = { Text(stringResource(language.labelRes)) },
                    onClick = {
                        onLanguageSelected(language)
                        expanded = false
                    },
                    leadingIcon = if (currentLanguage == language) {
                        {
                            Icon(
                                Icons.Default.Check,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    } else null,
                )
            }
        }
    }
}

@Composable
private fun DeviceInfoSection(
    profile: ProfileUiState,
    onNavigateToCapabilities: () -> Unit,
    onNavigateToAbout: () -> Unit,
    clipboard: Clipboard,
    coroutineScope: CoroutineScope,
    copiedText: String,
    context: android.content.Context,
    debugEnvironment: DebugEnvironmentUiState,
    onShowDebugEnvironment: () -> Unit,
) {
    MenuGroup {
        MenuRow(
            icon = Icons.Default.PhoneAndroid,
            title = stringResource(R.string.profile_device_capabilities),
            onClick = onNavigateToCapabilities,
        ) {
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }

        MenuRow(
            icon = Icons.Default.Key,
            title = stringResource(R.string.profile_device_id),
            onClick = {
                // Compose 1.7+ Clipboard API 是 suspend：用 LocalClipboard + setClipEntry 替代旧
                // LocalClipboardManager.setText(AnnotatedString)。Toast 仍同步触发——剪贴板写入
                // 极快（Android Clipboard 系统服务本地 IPC），用户感知零差异。
                coroutineScope.launch {
                    clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("device_id", profile.deviceId)))
                }
                Toast.makeText(context, copiedText, Toast.LENGTH_SHORT).show()
            },
        ) {
            Text(
                text = profile.deviceId.take(8) + "…",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        MenuRow(
            icon = Icons.Default.BugReport,
            title = "Debug Environment",
            onClick = onShowDebugEnvironment,
        ) {
            Text(
                text = debugEnvironment.effectiveApiUrl,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.width(180.dp),
            )
        }

        MenuRow(
            icon = Icons.Default.Info,
            title = stringResource(R.string.profile_about),
            onClick = onNavigateToAbout,
        ) {
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
internal fun DebugEnvironmentDialog(
    state: DebugEnvironmentUiState,
    onDismiss: () -> Unit,
    onApply: (DebugEnvironmentDraft) -> Unit,
    onReset: () -> Unit,
) {
    var preset by remember(state.preset) { mutableStateOf(state.preset) }
    var customBaseUrl by remember(state.customBaseUrl) { mutableStateOf(state.customBaseUrl) }
    var advancedEnabled by remember(state.advancedEnabled) { mutableStateOf(state.advancedEnabled) }
    var advancedApiUrl by remember(state.advancedApiUrl) { mutableStateOf(state.advancedApiUrl) }
    var advancedWsUrl by remember(state.advancedWsUrl) { mutableStateOf(state.advancedWsUrl) }
    var advancedWebUrl by remember(state.advancedWebUrl) { mutableStateOf(state.advancedWebUrl) }
    var advancedCentrifugoUrl by remember(state.advancedCentrifugoUrl) { mutableStateOf(state.advancedCentrifugoUrl) }
    var sentryDsn by remember(state.sentryDsn) { mutableStateOf(state.sentryDsn) }

    TTFormSheet(
        onDismissRequest = onDismiss,
        title = { Text("Debug Environment") },
        content = {
            Column(
                verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
            ) {
                DebugValue("当前 API（通知 REST 也跟随这里）", state.effectiveApiUrl)
                DebugValue("当前 IM API", state.effectiveImApiUrl)
                DebugValue("当前任务 WebSocket", state.effectiveWsUrl)
                DebugValue("当前 Web", state.effectiveWebUrl)
                DebugValue("当前消息实时连接", state.effectiveCentrifugoUrl)

                Text(
                    text = "环境",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    listOf(
                        "production" to "正式",
                        "development" to "开发",
                        "custom" to "自定义",
                    ).forEach { (value, label) ->
                        val active = preset == value
                        OutlinedButton(
                            onClick = { preset = value },
                            colors = ButtonDefaults.outlinedButtonColors(
                                containerColor = if (active) MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
                                else MaterialTheme.colorScheme.surface,
                            ),
                            modifier = Modifier.weight(1f),
                        ) { Text(label, maxLines = 1) }
                    }
                }
                if (preset == "custom") {
                    OutlinedTextField(
                        value = customBaseUrl,
                        onValueChange = { customBaseUrl = it },
                        label = { Text("基础地址") },
                        placeholder = { Text("http://1.2.3.4:1234") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        text = "自动生成 /api、/ws/v1/gateway、Web 根路径和 /connection/websocket。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    val context = LocalContext.current
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

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("高级自定义", style = MaterialTheme.typography.labelLarge)
                        Text(
                            "仅在需要拆分服务主机时逐项覆盖。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(checked = advancedEnabled, onCheckedChange = { advancedEnabled = it })
                }
                if (advancedEnabled) {
                    DebugUrlField("API", advancedApiUrl, { advancedApiUrl = it }, "https://api.example.com/api")
                    DebugUrlField("任务 WebSocket", advancedWsUrl, { advancedWsUrl = it }, "wss://api.example.com/ws/v1/gateway")
                    DebugUrlField("Web", advancedWebUrl, { advancedWebUrl = it }, "https://web.example.com")
                    DebugUrlField("消息实时连接", advancedCentrifugoUrl, { advancedCentrifugoUrl = it }, "wss://centrifugo.example.com/connection/websocket")
                }

                OutlinedTextField(
                    value = sentryDsn,
                    onValueChange = { sentryDsn = it },
                    label = { Text(stringResource(R.string.settings_debug_sentry_dsn)) },
                    placeholder = { Text("https://key@host/1") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    text = stringResource(R.string.settings_debug_sentry_dsn_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        actions = {
            TextButton(onClick = onReset) { Text("Reset") }
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) }
            Button(onClick = {
                onApply(
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
            }) {
                Text("Apply")
            }
        },
    )
}

@Composable
private fun DebugValue(title: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs)) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun DebugUrlField(label: String, value: String, onValueChange: (String) -> Unit, placeholder: String) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = { Text(placeholder) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun AccountStatsSection(profile: ProfileUiState) {
    val hasStats = profile.dateJoined != null || profile.loginCount != null || profile.lastLogin != null
    if (!hasStats) return

    Spacer(Modifier.height(TTSpacing.xxxl))

    MenuGroup {
        if (profile.dateJoined != null) {
            MenuRow(
                icon = Icons.Default.CalendarMonth,
                title = stringResource(R.string.profile_registered_at),
            ) {
                Text(
                    text = formatDate(profile.dateJoined),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (profile.loginCount != null) {
            MenuRow(
                icon = Icons.Default.Numbers,
                title = stringResource(R.string.profile_login_count),
            ) {
                Text(
                    text = stringResource(R.string.profile_times, profile.loginCount),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (profile.lastLogin != null) {
            MenuRow(
                icon = Icons.Default.AccessTime,
                title = stringResource(R.string.profile_last_login),
            ) {
                Text(
                    text = formatDate(profile.lastLogin),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun MenuGroup(content: @Composable () -> Unit) {
    Column(modifier = Modifier.padding(horizontal = TTSpacing.xl)) {
        content()
    }
}

@Composable
private fun MenuRow(
    icon: ImageVector,
    title: String,
    onClick: (() -> Unit)? = null,
    trailing: @Composable () -> Unit = {},
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(vertical = TTSpacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .background(
                    color = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent).copy(alpha = 0.11f),
                    shape = TTRadius.Shapes.sm,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                modifier = Modifier.size(18.dp),
            )
        }
        Spacer(Modifier.width(TTSpacing.md))

        Text(
            text = title,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )

        Spacer(Modifier.width(TTSpacing.sm))

        trailing()
    }
}

@Composable
private fun LogoutButton(onClick: () -> Unit) {
    val criticalColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)

    Box(
        modifier = Modifier
            .padding(horizontal = TTSpacing.xl)
            .fillMaxWidth()
            .background(
                color = criticalColor.copy(alpha = 0.06f),
                shape = TTRadius.Shapes.md,
            )
            .clickable(onClick = onClick)
            .padding(vertical = TTSpacing.lg),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(R.string.profile_logout),
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
            color = criticalColor,
        )
    }
}

private fun maskPhone(phone: String): String {
    if (phone.length < 7) return phone
    return "${phone.take(3)}****${phone.takeLast(4)}"
}

private fun maskEmail(email: String): String {
    val atIndex = email.indexOf('@')
    if (atIndex < 0 || atIndex < 3) return email
    return "${email.take(2)}***${email.substring(atIndex)}"
}

private fun formatDate(isoDate: String): String {
    return isoDate.take(10)
}

@Composable
private fun OrganizationSection(
    organizations: List<Organization>,
    selectedOrganization: Organization?,
    switchingId: String?,
    onSwitch: (Organization) -> Unit,
    onSelectedClick: (String) -> Unit,
    pendingInvitations: List<PendingInvitation>,
    respondingInvitationId: String?,
    onRespondToInvitation: (String, Boolean) -> Unit,
) {
    var respondingInvitation by remember { mutableStateOf<PendingInvitation?>(null) }

    Spacer(Modifier.height(TTSpacing.xxxl))

    MenuGroup {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = TTSpacing.sm),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.profile_workspace),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // 对齐 iOS ProfileScreen.workspaceSection：所有团队扁平平铺，不再分「个人身份/团队」组
        organizations.forEach { ws ->
            OrganizationRow(
                ws = ws,
                displayName = ws.name,
                isSelected = ws.id == selectedOrganization?.id,
                isSwitching = ws.id == switchingId,
                enabled = switchingId == null,
                onSwitch = onSwitch,
                onSelectedClick = onSelectedClick,
            )
        }

        if (pendingInvitations.isNotEmpty()) {
            Spacer(Modifier.height(TTSpacing.md))

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                Text(
                    text = stringResource(R.string.pending_invitations_label),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .background(
                            color = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                            shape = CircleShape,
                        ),
                )
            }

            pendingInvitations.forEach { invitation ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { respondingInvitation = invitation }
                        .padding(vertical = TTSpacing.lg),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val icon = invitation.workspaceIcon.takeIf { it.isNotBlank() }
                    if (icon != null) {
                        OrganizationEmojiIcon(icon = icon, size = 28.dp)
                    } else {
                        TTAvatar(
                            name = invitation.workspaceName,
                            imageUrl = null,
                            size = 28.dp,
                        )
                    }

                    Spacer(Modifier.width(TTSpacing.md))

                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = invitation.workspaceName,
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurface,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        val inviterText = if (invitation.invitedByName.isNotBlank()) {
                            stringResource(R.string.invited_by_user, invitation.invitedByName)
                        } else {
                            stringResource(R.string.invited_by_user, invitation.invitedBy.take(8))
                        }
                        Text(
                            text = "$inviterText · ${invitation.role}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .background(
                                color = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                                shape = CircleShape,
                            ),
                    )
                }
            }
        }
    }

    respondingInvitation?.let { invitation ->
        val stillPending = pendingInvitations.any { it.id == invitation.id }
        LaunchedEffect(stillPending) {
            if (!stillPending) respondingInvitation = null
        }

        InvitationResponseSheet(
            invitation = invitation,
            isResponding = respondingInvitationId == invitation.id,
            onAccept = { onRespondToInvitation(invitation.id, true) },
            onReject = { onRespondToInvitation(invitation.id, false) },
            onDismiss = { respondingInvitation = null },
        )
    }
}

@Composable
private fun OrganizationRow(
    ws: Organization,
    displayName: String,
    isSelected: Boolean,
    isSwitching: Boolean,
    enabled: Boolean,
    onSwitch: (Organization) -> Unit,
    onSelectedClick: (String) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled) {
                if (isSelected) onSelectedClick(ws.id)
                else onSwitch(ws)
            }
            .padding(vertical = TTSpacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val icon = ws.icon?.takeIf { it.isNotBlank() }
        if (icon != null) {
            OrganizationEmojiIcon(icon = icon, size = 28.dp)
        } else {
            TTAvatar(
                name = displayName,
                imageUrl = null,
                size = 28.dp,
            )
        }

        Spacer(Modifier.width(TTSpacing.md))

        Column(modifier = Modifier.weight(1f)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                Text(
                    text = displayName,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (ws.isDefault == true) {
                    Text(
                        text = stringResource(R.string.ws_default_tag),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
            val statsText = buildList {
                ws.memberCount?.let { add(stringResource(R.string.ws_member_count, it)) }
                ws.spaceCount?.let { add(stringResource(R.string.ws_workspace_count, it)) }
            }.joinToString(" · ")
            if (statsText.isNotEmpty()) {
                Text(
                    text = statsText,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Spacer(Modifier.width(TTSpacing.sm))

        if (isSwitching) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.primary,
            )
        } else if (isSelected) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Default.Check,
                    contentDescription = null,
                    tint = ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess),
                    modifier = Modifier.size(20.dp),
                )
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

/** 与 iOS 的 `organizationIcon` 一样，把表情置于固定的组织图标画布中央。 */
@Composable
private fun OrganizationEmojiIcon(icon: String, size: androidx.compose.ui.unit.Dp) {
    Box(
        modifier = Modifier
            .size(size)
            .background(
                color = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
                shape = TTRadius.Shapes.sm,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = icon,
            style = MaterialTheme.typography.titleMedium,
        )
    }
}
