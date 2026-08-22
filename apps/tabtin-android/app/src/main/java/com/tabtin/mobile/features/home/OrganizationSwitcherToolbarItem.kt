package com.tabtin.mobile.features.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.features.profile.ProfileViewModel
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
public fun OrganizationSwitcherToolbarItem(
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val organizations by viewModel.organizations.collectAsState()
    val selectedOrganization by viewModel.selectedOrganization.collectAsState()
    val isLoading by viewModel.isOrganizationLoading.collectAsState()
    var menuExpanded by remember { mutableStateOf(false) }

    val displayLabel = organizationSwitcherLabel(
        organization = selectedOrganization,
        isLoading = isLoading && selectedOrganization == null,
    )

    if (organizations.isEmpty()) {
        SwitcherLabel(displayLabel = displayLabel, showsChevron = false)
    } else {
        Box {
            SwitcherLabel(
                displayLabel = displayLabel,
                showsChevron = organizations.size > 1,
                onClick = { if (organizations.size > 1) menuExpanded = true },
            )
            DropdownMenu(
                expanded = menuExpanded,
                onDismissRequest = { menuExpanded = false },
            ) {
                Text(
                    text = stringResource(R.string.workspace_switch_organization),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                )
                organizations.forEach { organization ->
                    val isSelected = organization.id == selectedOrganization?.id
                    val isSwitching = viewModel.isSwitchingOrganization == organization.id
                    DropdownMenuItem(
                        text = {
                            Text(
                                text = organizationSwitcherLabel(organization),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                        onClick = {
                            menuExpanded = false
                            if (!isSelected) viewModel.switchOrganization(organization)
                        },
                        leadingIcon = when {
                            isSwitching -> {
                                {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(18.dp),
                                        strokeWidth = 2.dp,
                                    )
                                }
                            }
                            isSelected -> {
                                {
                                    Icon(
                                        imageVector = Icons.Default.Check,
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            }
                            else -> null
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun SwitcherLabel(
    displayLabel: String,
    showsChevron: Boolean,
    onClick: (() -> Unit)? = null,
) {
    val modifier = Modifier
        .background(
            color = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle).copy(alpha = 0.9f),
            shape = TTRadius.Shapes.sm,
        )
        .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
        .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs)

    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = displayLabel,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (showsChevron) {
            Icon(
                imageVector = Icons.Default.KeyboardArrowDown,
                contentDescription = null,
                modifier = Modifier
                    .size(16.dp)
                    .padding(start = TTSpacing.xxs),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun organizationSwitcherLabel(
    organization: Organization?,
    isLoading: Boolean = false,
): String {
    if (organization != null) return organizationSwitcherLabel(organization)
    if (isLoading) return stringResource(R.string.common_loading)
    return stringResource(R.string.ws_team_group)
}

@Composable
private fun organizationSwitcherLabel(organization: Organization): String =
    if (organization.isPersonal) {
        stringResource(R.string.ws_personal_identity)
    } else {
        organization.name
    }
