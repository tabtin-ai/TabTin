package com.tabtin.mobile.features.profile

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Approval
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.MobilePushPreferences
import com.tabtin.mobile.data.repository.MobilePushPreferencesRepository
import com.tabtin.mobile.ui.theme.TTSpacing
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.StateFlow

@HiltViewModel
public class NotificationSettingsViewModel @Inject constructor(
    private val preferences: MobilePushPreferencesRepository,
) : ViewModel() {
    public val value: StateFlow<MobilePushPreferences> = preferences.value

    init { preferences.bootstrap() }

    public fun setApproval(enabled: Boolean): Unit = preferences.setApproval(enabled)
    public fun setTaskCompleted(enabled: Boolean): Unit = preferences.setTaskCompleted(enabled)
    public fun setMessages(enabled: Boolean): Unit = preferences.setMessages(enabled)
    public fun setMentions(enabled: Boolean): Unit = preferences.setMentions(enabled)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun NotificationSettingsScreen(
    onBack: () -> Unit,
    viewModel: NotificationSettingsViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var systemNotificationsEnabled by remember(context) {
        mutableStateOf(NotificationManagerCompat.from(context).areNotificationsEnabled())
    }
    val preferences by viewModel.value.collectAsStateWithLifecycle()

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
                title = { Text(stringResource(R.string.notif_settings_title)) },
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
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            SettingsHomeSection(title = stringResource(R.string.notif_types)) {
                NotificationSwitchRow(
                    icon = Icons.Default.Approval,
                    title = stringResource(R.string.notif_approval_input),
                    checked = preferences.approval,
                    onCheckedChange = viewModel::setApproval,
                )
                SettingsHomeDivider()
                NotificationSwitchRow(
                    icon = Icons.Default.TaskAlt,
                    title = stringResource(R.string.notif_task_completed),
                    checked = preferences.taskCompleted,
                    onCheckedChange = viewModel::setTaskCompleted,
                )
                SettingsHomeDivider()
                NotificationSwitchRow(
                    icon = Icons.Default.ChatBubble,
                    title = stringResource(R.string.notif_messages),
                    checked = preferences.messages,
                    onCheckedChange = viewModel::setMessages,
                )
                if (!preferences.messages) {
                    SettingsHomeDivider()
                    NotificationSwitchRow(
                        icon = Icons.Default.AlternateEmail,
                        title = stringResource(R.string.notif_mentions),
                        checked = preferences.mentions,
                        onCheckedChange = viewModel::setMentions,
                    )
                }
            }

            SettingsHomeSection(title = stringResource(R.string.notif_system_permission)) {
                SettingsReadOnlyRow(
                    icon = Icons.Default.Notifications,
                    title = stringResource(R.string.notif_system_permission),
                    value = if (systemNotificationsEnabled) {
                        stringResource(R.string.settings_enabled)
                    } else {
                        stringResource(R.string.settings_disabled)
                    },
                    iconTone = if (systemNotificationsEnabled) {
                        SettingsHomeIconTone.Success
                    } else {
                        SettingsHomeIconTone.Warning
                    },
                    valueAsBadge = true,
                    valueTone = if (systemNotificationsEnabled) {
                        SettingsHomeIconTone.Success
                    } else {
                        SettingsHomeIconTone.Warning
                    },
                )
                if (!systemNotificationsEnabled) {
                    SettingsHomeDivider()
                    SettingsHomeRow(
                        icon = Icons.Default.Settings,
                        title = stringResource(R.string.notif_open_system_settings),
                        subtitle = stringResource(R.string.notif_settings_desc),
                        onClick = {
                            context.startActivity(appNotificationSettingsIntent(context))
                        },
                        tone = SettingsHomeIconTone.Neutral,
                    )
                }
            }
        }
    }
}

@Composable
private fun NotificationSwitchRow(
    icon: ImageVector,
    title: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .toggleable(
                value = checked,
                role = Role.Switch,
                onValueChange = onCheckedChange,
            )
            .heightIn(min = 56.dp)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(19.dp),
            )
        }
        Spacer(Modifier.width(TTSpacing.md))
        Text(
            text = title,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        Switch(checked = checked, onCheckedChange = null)
    }
}

private fun appNotificationSettingsIntent(context: Context): Intent {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        }
    } else {
        Intent(Settings.ACTION_SETTINGS)
    }
}
