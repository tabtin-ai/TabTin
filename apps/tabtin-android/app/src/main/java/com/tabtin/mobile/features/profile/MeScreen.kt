package com.tabtin.mobile.features.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Group
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.features.workspace.roleDisplayString
import com.tabtin.mobile.ui.components.IdentityColorAvatar
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.theme.IdentityAvatar
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing

/** Android 版「我的」页：承载头像、简介、编辑资料和当前组织身份，对齐 iOS MeScreen。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MeScreen(
    onBack: () -> Unit,
    onNavigateToEdit: () -> Unit,
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val profile = viewModel.profileState
    val selectedOrganization by viewModel.selectedOrganization.collectAsState()
    val displayName = profile.nickname?.takeIf { it.isNotBlank() }
        ?: stringResource(R.string.profile_default_name)
    val bio = profile.bio?.takeIf { it.isNotBlank() }
        ?: stringResource(R.string.profile_bio_empty)

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            LargeTopAppBar(
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
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.xl),
        ) {
            Spacer(Modifier.height(TTSpacing.xl))

            ProfileHeader(
                displayName = displayName,
                userId = profile.userId,
                username = profile.username,
                bio = bio,
                avatarUrl = profile.avatar,
                bioIsEmpty = profile.bio.isNullOrBlank(),
                onNavigateToEdit = onNavigateToEdit,
            )

            Spacer(Modifier.height(TTSpacing.xxxl))

            Text(
                text = stringResource(R.string.profile_workspace),
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = TTSpacing.xs),
            )
            Spacer(Modifier.height(TTSpacing.sm))
            selectedOrganization?.let { organization ->
                OrganizationIdentityCard(
                    organization = organization,
                    roleLabel = viewModel.currentOrganizationRole?.let { roleDisplayString(it) },
                )
            } ?: OrganizationUnavailableCard()

            Spacer(Modifier.height(TTSpacing.xxxl))
        }
    }
}

@Composable
private fun ProfileHeader(
    displayName: String,
    userId: String?,
    username: String?,
    bio: String,
    avatarUrl: String?,
    bioIsEmpty: Boolean,
    onNavigateToEdit: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IdentityColorAvatar(
                name = displayName,
                seed = IdentityAvatar.colorSeed(userId, displayName),
                imageUrl = avatarUrl,
                size = 64.dp,
            )
            Spacer(Modifier.weight(1f))
            IconButton(onClick = onNavigateToEdit) {
                Icon(
                    imageVector = Icons.Default.Edit,
                    contentDescription = stringResource(R.string.profile_edit_title),
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(28.dp),
                )
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = displayName,
                    style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold),
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                username?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        text = "@$it",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Text(
                text = bio,
                style = MaterialTheme.typography.bodyMedium,
                color = if (bioIsEmpty) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun OrganizationIdentityCard(
    organization: Organization,
    roleLabel: String?,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.md)
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.lg),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OrganizationAvatar(organization = organization)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = organization.name,
                style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            roleLabel?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun OrganizationUnavailableCard() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.md)
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.lg),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Default.Group,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(28.dp),
        )
        Text(
            text = stringResource(R.string.settings_organization_unavailable),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun OrganizationAvatar(organization: Organization) {
    TTAvatar(
        name = organization.name,
        imageUrl = organization.logoUrl,
        size = 32.dp,
        shape = TTRadius.Shapes.sm,
        fallbackText = organization.avatarFallbackText,
    )
}
