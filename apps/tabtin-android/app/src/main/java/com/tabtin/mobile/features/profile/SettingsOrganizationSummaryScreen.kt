package com.tabtin.mobile.features.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.features.workspace.OrganizationSettingsViewModel
import com.tabtin.mobile.features.workspace.roleDisplayString
import com.tabtin.mobile.ui.theme.TTSpacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SettingsOrganizationSummaryScreen(
    onBack: () -> Unit,
    viewModel: OrganizationSettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    val organization = state.organization

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_organization_summary)) },
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
        when {
            state.isLoading -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(innerPadding),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }
            organization == null -> {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(innerPadding)
                        .padding(horizontal = TTSpacing.xl),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        stringResource(R.string.ws_load_failed),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Spacer(Modifier.height(TTSpacing.md))
                    TextButton(onClick = viewModel::retryLoadOrganization) {
                        Text(stringResource(R.string.common_retry))
                    }
                }
            }
            else -> {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(innerPadding)
                        .padding(TTSpacing.lg),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
                ) {
                    SettingsHomeSection(title = stringResource(R.string.settings_organization_summary)) {
                        SettingsReadOnlyRow(
                            icon = Icons.Default.Business,
                            title = stringResource(R.string.settings_organization_name),
                            value = organization.name,
                            iconTone = SettingsHomeIconTone.Accent,
                        )
                        state.currentUserRole?.let { role ->
                            SettingsHomeDivider()
                            SettingsReadOnlyRow(
                                icon = Icons.Default.Person,
                                title = stringResource(R.string.settings_organization_role),
                                value = roleDisplayString(role),
                                iconTone = SettingsHomeIconTone.Accent,
                                valueAsBadge = true,
                                valueTone = SettingsHomeIconTone.Accent,
                            )
                        }
                    }
                }
            }
        }
    }
}
