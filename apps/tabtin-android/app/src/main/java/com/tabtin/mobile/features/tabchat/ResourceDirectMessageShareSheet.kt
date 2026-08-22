package com.tabtin.mobile.features.tabchat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ImResourceCardType
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ResourceDirectMessageShareSheet(
    resource: ResourceDirectMessageResource,
    onDismiss: () -> Unit,
    onSent: (recipientName: String) -> Unit,
    viewModel: ResourceDirectMessageShareViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val sheetState = rememberTTSheetState(confirmValueChange = { !state.isSending })

    LaunchedEffect(resource) {
        viewModel.activate(resource)
    }
    LaunchedEffect(state.phase, state.sentRecipientName) {
        if (state.phase == ResourceDirectMessageSharePhase.SENT) {
            val recipientName = state.sentRecipientName
            viewModel.reset()
            onSent(recipientName)
        }
    }

    val dismissSheet = {
        if (!state.isSending) {
            viewModel.reset()
            onDismiss()
        }
    }
    TTBottomSheet(
        onDismissRequest = dismissSheet,
        sheetState = sheetState,
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 640.dp),
            contentPadding = PaddingValues(bottom = TTSpacing.xxl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        ) {
            item {
                Column(
                    modifier = Modifier.padding(horizontal = TTSpacing.lg),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    Text(
                        text = stringResource(R.string.resource_dm_share_title),
                        style = TTFonts.subtitleSemibold,
                    )
                    Text(
                        text = stringResource(R.string.resource_dm_share_description),
                        style = TTFonts.body,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    ResourceSummary(resource)
                }
            }
            item { HorizontalDivider(modifier = Modifier.padding(vertical = TTSpacing.xs)) }

            when {
                state.isLoading -> item {
                    StatusRow(message = stringResource(R.string.resource_dm_share_loading))
                }
                !state.hasLoadedRecipients -> item {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = TTSpacing.lg)
                            .semantics { liveRegion = LiveRegionMode.Polite },
                    ) {
                        Text(
                            text = state.errorRes?.let { stringResource(it) }.orEmpty(),
                            style = TTFonts.body,
                            color = MaterialTheme.colorScheme.error,
                        )
                        TextButton(onClick = viewModel::reloadMembers) {
                            Text(stringResource(R.string.common_retry), style = TTFonts.bodyMedium)
                        }
                    }
                }
                else -> {
                    item {
                        TabSearchField(
                            query = state.query,
                            onQueryChange = viewModel::setQuery,
                            placeholder = stringResource(R.string.resource_dm_share_search),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = TTSpacing.lg),
                            showCancelOnFocus = false,
                            enabled = !state.isSending,
                        )
                    }
                    if (state.visibleMembers.isEmpty()) {
                        item {
                            Text(
                                text = stringResource(
                                    if (state.query.isBlank()) R.string.resource_dm_share_empty
                                    else R.string.resource_dm_share_no_matches,
                                ),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xl)
                                    .semantics { liveRegion = LiveRegionMode.Polite },
                                style = TTFonts.body,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else {
                        items(state.visibleMembers, key = { it.userId }) { member ->
                            RecipientRow(
                                member = member,
                                selected = member.userId == state.selectedUserId,
                                enabled = !state.isSending,
                                onClick = { viewModel.selectRecipient(member.userId) },
                            )
                        }
                    }
                }
            }

            if (state.phase == ResourceDirectMessageSharePhase.FAILED) {
                item {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = TTSpacing.lg)
                            .semantics { liveRegion = LiveRegionMode.Assertive },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = state.errorRes?.let { stringResource(it) }.orEmpty(),
                            modifier = Modifier.weight(1f),
                            style = TTFonts.body,
                            color = MaterialTheme.colorScheme.error,
                        )
                        TextButton(onClick = viewModel::retrySend) {
                            Text(stringResource(R.string.common_retry), style = TTFonts.bodyMedium)
                        }
                    }
                }
            }
            item {
                Button(
                    onClick = viewModel::submit,
                    enabled = state.selectedUserId != null && !state.isSending &&
                        state.phase != ResourceDirectMessageSharePhase.FAILED,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                ) {
                    if (state.isSending) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(TTSpacing.sm))
                        Text(stringResource(R.string.resource_dm_share_sending), style = TTFonts.bodyMedium)
                    } else {
                        Text(stringResource(R.string.resource_dm_share_send), style = TTFonts.bodyMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun ResourceSummary(resource: ResourceDirectMessageResource) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = MaterialTheme.shapes.medium,
    ) {
        Row(
            modifier = Modifier.padding(TTSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = if (resource.resourceType == ImResourceCardType.DOCUMENT) {
                    Icons.Default.Description
                } else {
                    Icons.Default.TableChart
                },
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.width(TTSpacing.sm))
            Text(
                text = resource.name,
                style = TTFonts.bodyMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun StatusRow(message: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xl)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(TTSpacing.md))
        Text(message, style = TTFonts.body)
    }
}

@Composable
private fun RecipientRow(
    member: OrganizationMember,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(
                selected = selected,
                enabled = enabled,
                role = Role.RadioButton,
                onClick = onClick,
            )
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TTAvatar(
            name = member.displayName,
            imageUrl = member.user?.avatar,
            size = 36.dp,
            shape = CircleShape,
        )
        Spacer(Modifier.width(TTSpacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = member.displayName,
                style = TTFonts.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            member.user?.username
                ?.trim()
                ?.takeIf { it.isNotEmpty() && it != member.displayName }
                ?.let { username ->
                    Text(
                        text = "@$username",
                        style = TTFonts.caption,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
        }
        RadioButton(selected = selected, onClick = null, enabled = enabled)
    }
}
