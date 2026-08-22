package com.tabtin.mobile.features.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.FileDownload
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.app.NotificationManagerCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.OrganizationRole
import com.tabtin.mobile.features.workspace.roleDisplayString
import com.tabtin.mobile.ui.theme.TTSpacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SettingsHomeScreen(
    onLogout: () -> Unit,
    onBack: () -> Unit,
    onNavigateToAccount: () -> Unit,
    onNavigateToChangePassword: () -> Unit,
    onNavigateToAppearance: () -> Unit,
    onNavigateToNotifications: () -> Unit,
    onNavigateToPrivacy: () -> Unit,
    onNavigateToDeviceInfo: () -> Unit,
    onNavigateToDebugEnvironment: () -> Unit,
    onNavigateToDiagnostics: () -> Unit,
    onNavigateToAbout: () -> Unit,
    onNavigateToOrganizationSummary: (String) -> Unit,
    onNavigateToOrganizationSettings: (String) -> Unit,
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val profile = viewModel.profileState
    val selectedOrganization by viewModel.selectedOrganization.collectAsState()
    val currentTheme by viewModel.themeMode.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    val verifiedContactCount = remember(profile.isVerifiedPhone, profile.isVerifiedEmail) {
        listOf(profile.isVerifiedPhone, profile.isVerifiedEmail).count { it == true }
    }
    var systemNotificationsEnabled by remember(context) {
        mutableStateOf(NotificationManagerCompat.from(context).areNotificationsEnabled())
    }
    var showLogoutConfirm by remember { mutableStateOf(false) }

    LaunchedEffect(viewModel.error) {
        viewModel.error?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearError()
        }
    }

    DisposableEffect(context, lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                systemNotificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
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
                .padding(innerPadding),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                horizontal = TTSpacing.lg,
                vertical = TTSpacing.lg,
            ),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            item {
                SettingsHomeSection(title = stringResource(R.string.settings_section_account_security)) {
                    SettingsHomeRow(
                        icon = Icons.Default.Shield,
                        title = stringResource(R.string.settings_account_and_verification),
                        subtitle = stringResource(R.string.settings_account_info_subtitle),
                        trailing = verifiedContactTrailing(verifiedContactCount),
                        trailingStyle = SettingsHomeTrailingStyle.Badge,
                        trailingTone = SettingsHomeIconTone.Success,
                        tone = if (verifiedContactCount > 0) SettingsHomeIconTone.Success else SettingsHomeIconTone.Accent,
                        onClick = onNavigateToAccount,
                    )
                    SettingsHomeDivider()
                    SettingsHomeRow(
                        icon = Icons.Default.Lock,
                        title = stringResource(R.string.settings_change_password),
                        subtitle = stringResource(R.string.settings_change_password_subtitle),
                        onClick = onNavigateToChangePassword,
                    )
                    SettingsHomeDivider()
                    SettingsHomeRow(
                        icon = Icons.Default.Lock,
                        title = stringResource(R.string.settings_privacy_and_data),
                        subtitle = stringResource(R.string.settings_privacy_and_data_subtitle),
                        onClick = onNavigateToPrivacy,
                    )
                }
            }

            item {
                SettingsHomeSection(title = stringResource(R.string.settings_section_preferences)) {
                    SettingsHomeRow(
                        icon = Icons.Default.Palette,
                        title = stringResource(R.string.settings_appearance_and_language),
                        subtitle = stringResource(R.string.settings_appearance_and_language_subtitle),
                        trailing = themeLabel(currentTheme),
                        trailingStyle = SettingsHomeTrailingStyle.ColorSwatch,
                        trailingTone = SettingsHomeIconTone.Accent,
                        onClick = onNavigateToAppearance,
                    )
                    SettingsHomeDivider()
                    SettingsHomeRow(
                        icon = Icons.Default.Notifications,
                        title = stringResource(R.string.profile_notification),
                        subtitle = stringResource(R.string.settings_notifications_subtitle),
                        trailing = if (systemNotificationsEnabled) {
                            stringResource(R.string.settings_enabled)
                        } else {
                            stringResource(R.string.settings_disabled)
                        },
                        trailingStyle = SettingsHomeTrailingStyle.Badge,
                        trailingTone = if (systemNotificationsEnabled) {
                            SettingsHomeIconTone.Success
                        } else {
                            SettingsHomeIconTone.Warning
                        },
                        tone = if (systemNotificationsEnabled) {
                            SettingsHomeIconTone.Success
                        } else {
                            SettingsHomeIconTone.Warning
                        },
                        onClick = onNavigateToNotifications,
                    )
                }
            }

            item {
                SettingsHomeSection(title = stringResource(R.string.settings_section_organization)) {
                    SettingsHomeRow(
                        icon = Icons.Default.Business,
                        title = selectedOrganization?.name ?: stringResource(R.string.settings_organization_summary),
                        subtitle = stringResource(R.string.settings_organization_summary_subtitle),
                        trailing = organizationRoleTrailing(viewModel.currentOrganizationRole),
                        trailingStyle = SettingsHomeTrailingStyle.Badge,
                        trailingTone = SettingsHomeIconTone.Accent,
                        onClick = {
                            selectedOrganization?.id?.let(onNavigateToOrganizationSummary)
                        },
                    )
                    SettingsHomeDivider()
                    SettingsHomeRow(
                        icon = Icons.Default.Tune,
                        title = stringResource(R.string.settings_organization_settings),
                        subtitle = stringResource(R.string.settings_organization_settings_subtitle),
                        onClick = {
                            selectedOrganization?.id?.let(onNavigateToOrganizationSettings)
                        },
                    )
                }
            }

            item {
                SettingsHomeSection(title = stringResource(R.string.settings_section_device)) {
                    SettingsHomeRow(
                        icon = Icons.Default.PhoneAndroid,
                        title = stringResource(R.string.settings_this_device),
                        subtitle = stringResource(R.string.settings_device_info_subtitle),
                        trailing = profile.deviceId.takeIf { it.isNotBlank() }?.let { it.take(8) + "…" },
                        tone = SettingsHomeIconTone.Neutral,
                        onClick = onNavigateToDeviceInfo,
                    )
                    SettingsHomeDivider()
                    SettingsHomeRow(
                        icon = Icons.Default.FileDownload,
                        title = stringResource(R.string.settings_diagnostics_title),
                        subtitle = stringResource(R.string.settings_diagnostics_subtitle),
                        onClick = onNavigateToDiagnostics,
                        tone = SettingsHomeIconTone.Accent,
                    )
                    SettingsHomeDivider()
                    SettingsHomeRow(
                        icon = Icons.Default.BugReport,
                        title = stringResource(R.string.settings_debug_environment),
                        subtitle = stringResource(R.string.settings_debug_environment_subtitle),
                        trailing = viewModel.debugEnvironment.preset,
                        onClick = onNavigateToDebugEnvironment,
                        tone = SettingsHomeIconTone.Warning,
                    )
                }
            }

            item {
                SettingsHomeSection(title = stringResource(R.string.settings_section_about_support)) {
                    SettingsHomeRow(
                        icon = Icons.Default.Info,
                        title = stringResource(R.string.profile_about),
                        subtitle = stringResource(R.string.settings_about_subtitle),
                        trailing = "v${BuildConfig.VERSION_NAME}",
                        onClick = onNavigateToAbout,
                        tone = SettingsHomeIconTone.Neutral,
                    )
                }
            }

            item {
                LogoutSettingsButton(onClick = { showLogoutConfirm = true })
            }
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

}

@Composable
private fun verifiedContactTrailing(count: Int): String? {
    return if (count > 0) stringResource(R.string.settings_verified_count, count) else null
}

@Composable
private fun organizationRoleTrailing(role: OrganizationRole?): String? =
    role?.let { roleDisplayString(it) }
