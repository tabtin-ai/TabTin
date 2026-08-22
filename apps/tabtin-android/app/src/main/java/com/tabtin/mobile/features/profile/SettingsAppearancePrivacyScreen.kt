package com.tabtin.mobile.features.profile

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.BrightnessAuto
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
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
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.features.conversation.CapsuleOnboardingStore
import com.tabtin.mobile.ui.theme.AppLanguage
import com.tabtin.mobile.ui.theme.LocalTTDarkTheme
import com.tabtin.mobile.ui.theme.TTColorSchemeId
import com.tabtin.mobile.ui.theme.TTColorSchemePalette
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ThemeMode

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SettingsAppearanceScreen(
    onBack: () -> Unit,
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val currentTheme by viewModel.themeMode.collectAsState()
    val currentColorScheme by viewModel.colorSchemeId.collectAsState()
    val darkTheme = LocalTTDarkTheme.current
    val context = LocalContext.current
    val capsuleOnboardingStore = remember(context) { CapsuleOnboardingStore(context) }
    var capsuleGuideReset by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_appearance_and_language)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            SettingsHomeSection(title = stringResource(R.string.profile_appearance)) {
                ThemeMode.entries.forEachIndexed { index, mode ->
                    SettingsSelectionRow(
                        icon = themeIcon(mode),
                        title = themeLabel(mode),
                        selected = currentTheme == mode,
                        onClick = { viewModel.setThemeMode(mode) },
                    )
                    if (index != ThemeMode.entries.lastIndex) {
                        SettingsHomeDivider()
                    }
                }
            }

            SettingsHomeSection(title = stringResource(R.string.settings_color_scheme)) {
                TTColorSchemeId.entries.forEachIndexed { index, schemeId ->
                    ThemeColorSelectionRow(
                        title = stringResource(schemeId.labelRes),
                        color = TTColorSchemePalette.accentColor(schemeId, dark = darkTheme),
                        selected = currentColorScheme == schemeId,
                        onClick = { viewModel.setColorSchemeId(schemeId) },
                    )
                    if (index != TTColorSchemeId.entries.lastIndex) {
                        SettingsHomeDivider()
                    }
                }
            }

            SettingsHomeSection(title = stringResource(R.string.profile_language)) {
                AppLanguage.entries.forEachIndexed { index, language ->
                    SettingsSelectionRow(
                        icon = languageIcon(language),
                        title = stringResource(language.labelRes),
                        selected = viewModel.currentLanguage == language,
                        onClick = { viewModel.setLanguage(language) },
                    )
                    if (index != AppLanguage.entries.lastIndex) {
                        SettingsHomeDivider()
                    }
                }
            }

            SettingsHomeSection(title = stringResource(R.string.agent_capsule_onboarding_settings_section)) {
                SettingsHomeRow(
                    icon = Icons.Default.Refresh,
                    title = stringResource(R.string.agent_capsule_onboarding_replay_title),
                    subtitle = stringResource(
                        if (capsuleGuideReset) {
                            R.string.agent_capsule_onboarding_replay_done
                        } else {
                            R.string.agent_capsule_onboarding_replay_detail
                        },
                    ),
                    onClick = {
                        capsuleOnboardingStore.reset()
                        capsuleGuideReset = true
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SettingsPrivacyScreen(
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val hasAiConsent = remember { mutableStateOf(AIDataSharingConsentStore.hasGranted(context)) }
    var showConsentDialog by remember { mutableStateOf(false) }
    var showRevokeConfirm by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_privacy_and_data)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            SettingsHomeSection(title = stringResource(R.string.settings_privacy_and_data)) {
                SettingsReadOnlyRow(
                    icon = if (hasAiConsent.value) Icons.Default.VerifiedUser else Icons.Default.Lock,
                    title = stringResource(R.string.settings_ai_data_sharing_status),
                    value = if (hasAiConsent.value) stringResource(R.string.settings_enabled) else stringResource(R.string.settings_disabled),
                    iconTone = if (hasAiConsent.value) SettingsHomeIconTone.Success else SettingsHomeIconTone.Neutral,
                    valueAsBadge = true,
                    valueTone = if (hasAiConsent.value) SettingsHomeIconTone.Success else SettingsHomeIconTone.Neutral,
                )
            }

            Text(
                text = stringResource(R.string.settings_ai_data_sharing_footer),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = TTSpacing.xs),
            )

            SettingsHomeSection(title = stringResource(R.string.settings_privacy_actions)) {
                SettingsHomeRow(
                    icon = Icons.Default.Description,
                    title = stringResource(R.string.settings_review_ai_consent),
                    subtitle = stringResource(R.string.settings_review_ai_consent_subtitle),
                    onClick = { showConsentDialog = true },
                )
                SettingsHomeDivider()
                SettingsHomeRow(
                    icon = Icons.Default.Info,
                    title = stringResource(R.string.about_privacy_policy),
                    subtitle = stringResource(R.string.settings_privacy_policy_subtitle),
                    onClick = {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.example.com/privacy")))
                    },
                    tone = SettingsHomeIconTone.Neutral,
                )
                if (hasAiConsent.value) {
                    SettingsHomeDivider()
                    SettingsHomeRow(
                        icon = Icons.Default.RemoveCircle,
                        title = stringResource(R.string.settings_revoke_ai_consent),
                        subtitle = stringResource(R.string.settings_revoke_ai_consent_subtitle),
                        onClick = { showRevokeConfirm = true },
                        tone = SettingsHomeIconTone.Critical,
                    )
                }
            }
        }
    }

    if (showConsentDialog) {
        AIDataSharingConsentDialog(
            onAgree = {
                AIDataSharingConsentStore.grant(context)
                hasAiConsent.value = true
                showConsentDialog = false
            },
            onDisagree = {
                showConsentDialog = false
            },
        )
    }

    if (showRevokeConfirm) {
        AlertDialog(
            onDismissRequest = { showRevokeConfirm = false },
            title = { Text(stringResource(R.string.settings_revoke_ai_consent_title)) },
            text = { Text(stringResource(R.string.settings_revoke_ai_consent_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        AIDataSharingConsentStore.revoke(context)
                        hasAiConsent.value = false
                        showRevokeConfirm = false
                    },
                ) {
                    Text(stringResource(R.string.settings_revoke_ai_consent))
                }
            },
            dismissButton = {
                TextButton(onClick = { showRevokeConfirm = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

@Composable
private fun ThemeColorSelectionRow(
    title: String,
    color: androidx.compose.ui.graphics.Color,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .background(color, shape = CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .background(color, shape = CircleShape),
            )
        }

        Spacer(Modifier.width(TTSpacing.md))

        Text(
            text = title,
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )

        if (selected) {
            Spacer(Modifier.width(TTSpacing.sm))
            Icon(
                Icons.Default.Check,
                contentDescription = null,
                tint = color,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun SettingsSelectionRow(
    icon: ImageVector,
    title: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val tone = if (selected) SettingsHomeIconTone.Accent else SettingsHomeIconTone.Neutral

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .background(tone.backgroundColor(), shape = TTRadius.Shapes.sm),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = tone.foregroundColor(),
                modifier = Modifier.size(18.dp),
            )
        }

        Spacer(Modifier.width(TTSpacing.md))

        Text(
            text = title,
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )

        if (selected) {
            Spacer(Modifier.width(TTSpacing.sm))
            Icon(
                Icons.Default.Check,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
internal fun themeLabel(mode: ThemeMode): String = when (mode) {
    ThemeMode.SYSTEM -> stringResource(R.string.profile_theme_system)
    ThemeMode.LIGHT -> stringResource(R.string.profile_theme_light)
    ThemeMode.DARK -> stringResource(R.string.profile_theme_dark)
}

private fun themeIcon(mode: ThemeMode): ImageVector = when (mode) {
    ThemeMode.SYSTEM -> Icons.Default.BrightnessAuto
    ThemeMode.LIGHT -> Icons.Default.LightMode
    ThemeMode.DARK -> Icons.Default.DarkMode
}

private fun languageIcon(language: AppLanguage): ImageVector = when (language) {
    AppLanguage.SYSTEM -> Icons.Default.Language
    AppLanguage.ZH_CN -> Icons.Default.Description
    AppLanguage.EN -> Icons.Default.TextFields
}
