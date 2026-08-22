package com.tabtin.mobile.features.profile

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Numbers
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SettingsAccountScreen(
    onBack: () -> Unit,
    onNavigateToVerify: (String) -> Unit,
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val profile = viewModel.profileState
    val phone = profile.phone?.takeIf { it.isNotBlank() }
    val email = profile.email?.takeIf { it.isNotBlank() }
    val hasContactInfo = phone != null || email != null
    val hasAccountActivity = profile.dateJoined != null || profile.loginCount != null || profile.lastLogin != null
    var copiedUserId by remember { mutableStateOf(false) }

    LaunchedEffect(copiedUserId) {
        if (copiedUserId) {
            delay(1800)
            copiedUserId = false
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_account_and_verification)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
            )
        },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            if (hasContactInfo) {
                item {
                    SettingsHomeSection(title = stringResource(R.string.settings_account_contact)) {
                        phone?.let { phoneValue ->
                            ContactVerificationRow(
                                icon = Icons.Default.Phone,
                                title = stringResource(R.string.settings_contact_phone),
                                value = maskSettingsPhone(phoneValue),
                                verified = profile.isVerifiedPhone == true,
                                onClick = { onNavigateToVerify(phoneValue) },
                            )
                        }
                        if (phone != null && email != null) {
                            SettingsHomeDivider()
                        }
                        email?.let { emailValue ->
                            ContactVerificationRow(
                                icon = Icons.Default.Email,
                                title = stringResource(R.string.settings_contact_email),
                                value = maskSettingsEmail(emailValue),
                                verified = profile.isVerifiedEmail == true,
                                onClick = { onNavigateToVerify(emailValue) },
                            )
                        }
                    }
                }
            }

            profile.userId?.takeIf { it.isNotBlank() }?.let { userId ->
                item {
                    SettingsHomeSection(title = stringResource(R.string.settings_account_user_id)) {
                        UserIdCopyRow(
                            userId = userId,
                            copied = copiedUserId,
                            onClick = {
                                copySettingsText(context, "TabTin User ID", userId)
                                copiedUserId = true
                            },
                        )
                    }
                    Text(
                        text = stringResource(R.string.settings_account_user_id_footer),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = TTSpacing.xs, vertical = TTSpacing.sm),
                    )
                }
            }

            if (hasAccountActivity) {
                item {
                    SettingsHomeSection(title = stringResource(R.string.settings_account_activity)) {
                        var needsDivider = false
                        profile.dateJoined?.let { dateJoined ->
                            SettingsReadOnlyRow(
                                icon = Icons.Default.CalendarMonth,
                                title = stringResource(R.string.profile_registered_at),
                                value = dateJoined.take(10),
                            )
                            needsDivider = true
                        }
                        profile.loginCount?.let { loginCount ->
                            if (needsDivider) {
                                SettingsHomeDivider()
                            }
                            SettingsReadOnlyRow(
                                icon = Icons.Default.Numbers,
                                title = stringResource(R.string.profile_login_count),
                                value = loginCount.toString(),
                            )
                            needsDivider = true
                        }
                        profile.lastLogin?.let { lastLogin ->
                            if (needsDivider) {
                                SettingsHomeDivider()
                            }
                            SettingsReadOnlyRow(
                                icon = Icons.Default.AccessTime,
                                title = stringResource(R.string.profile_last_login),
                                value = lastLogin.take(10),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ContactVerificationRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    value: String,
    verified: Boolean,
    onClick: () -> Unit,
) {
    val tone = if (verified) SettingsHomeIconTone.Success else SettingsHomeIconTone.Accent
    val rowModifier = Modifier
        .fillMaxWidth()
        .heightIn(min = 56.dp)
        .then(if (verified) Modifier else Modifier.clickable(onClick = onClick))
        .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm)

    Row(
        modifier = rowModifier,
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
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )

        Spacer(Modifier.width(TTSpacing.sm))

        Row(
            modifier = Modifier.widthIn(max = 168.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = value,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
                modifier = Modifier.weight(1f, fill = false),
                textAlign = TextAlign.End,
            )
            Spacer(Modifier.width(TTSpacing.sm))
            if (verified) {
                Icon(
                    Icons.Default.Check,
                    contentDescription = null,
                    tint = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess),
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(TTSpacing.xs))
                Text(
                    text = stringResource(R.string.profile_verified),
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess),
                    maxLines = 1,
                )
            } else {
                Text(
                    text = stringResource(R.string.settings_go_verify),
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = MaterialTheme.colorScheme.primary,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun UserIdCopyRow(
    userId: String,
    copied: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .background(
                    SettingsHomeIconTone.Neutral.backgroundColor(),
                    shape = TTRadius.Shapes.sm,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Default.Person,
                contentDescription = null,
                tint = SettingsHomeIconTone.Neutral.foregroundColor(),
                modifier = Modifier.size(18.dp),
            )
        }
        Spacer(Modifier.width(TTSpacing.md))
        Text(
            text = userId,
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.MiddleEllipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(TTSpacing.sm))
        if (copied) {
            Icon(
                Icons.Default.Check,
                contentDescription = null,
                tint = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess),
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(TTSpacing.xs))
            Text(
                text = stringResource(R.string.profile_copied),
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                color = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess),
                textAlign = TextAlign.End,
            )
        } else {
            Icon(
                Icons.Default.ContentCopy,
                contentDescription = stringResource(R.string.settings_account_user_id_copy),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

private fun copySettingsText(context: Context, label: String, value: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText(label, value))
}

private fun maskSettingsPhone(phone: String): String {
    if (phone.length < 7) return phone
    return "${phone.take(3)}****${phone.takeLast(4)}"
}

private fun maskSettingsEmail(email: String): String {
    val atIndex = email.indexOf('@')
    if (atIndex < 0 || atIndex < 3) return email
    return "${email.take(2)}***${email.substring(atIndex)}"
}
