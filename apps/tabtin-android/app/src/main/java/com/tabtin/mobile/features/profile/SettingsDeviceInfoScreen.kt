package com.tabtin.mobile.features.profile

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTSpacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SettingsDeviceInfoScreen(
    onBack: () -> Unit,
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val deviceId = viewModel.profileState.deviceId
    val copiedText = stringResource(R.string.profile_copied)

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.profile_device_id)) },
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
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            SettingsHomeSection(title = stringResource(R.string.profile_device_id)) {
                SettingsHomeRow(
                    icon = Icons.Default.ContentCopy,
                    title = stringResource(R.string.profile_device_id),
                    subtitle = deviceId.takeIf { it.isNotBlank() }?.let { "${it.take(8)}…" }
                        ?: stringResource(R.string.settings_not_set),
                    onClick = {
                        if (deviceId.isNotBlank()) {
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("device_id", deviceId))
                            Toast.makeText(context, copiedText, Toast.LENGTH_SHORT).show()
                        }
                    },
                    tone = SettingsHomeIconTone.Neutral,
                )
            }
        }
    }
}
