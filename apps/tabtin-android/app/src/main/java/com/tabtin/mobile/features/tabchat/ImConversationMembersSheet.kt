package com.tabtin.mobile.features.tabchat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.SubcomposeAsyncImage
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ImConversationDetail
import com.tabtin.mobile.data.im.ImMember
import com.tabtin.mobile.data.im.ImMemberType
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * 会话成员通讯录：从顶栏入口 present，替代原先消息区上方的横向成员条。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ImConversationMembersSheet(
    detail: ImConversationDetail,
    currentUserId: String?,
    onHumanClick: (String, String) -> Unit,
    onAgentClick: (ImMember) -> Unit,
    onAddAgent: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    val members = detail.members.filterNot { it.userId == currentUserId }
    val canOpenMemberDM = detail.isGroup || detail.isTeamSpaceChannel

    TTBottomSheet(
        onDismissRequest = onDismiss,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 240.dp, max = 560.dp)
                .padding(bottom = TTSpacing.lg),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.im_contacts),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                if (onAddAgent != null) {
                    TextButton(onClick = onAddAgent) {
                        Text(stringResource(R.string.im_settings_add_agent))
                    }
                }
                TextButton(onClick = onDismiss) {
                    Text(stringResource(R.string.common_close))
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
            LazyColumn(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
            ) {
                items(
                    members,
                    key = { member -> member.userId ?: member.agentId ?: member.displayName },
                ) { member ->
                    ImConversationMemberRow(
                        member = member,
                        actionable = canOpenMemberDM,
                        onHumanClick = onHumanClick,
                        onAgentClick = onAgentClick,
                    )
                }
            }
        }
    }
}

@Composable
private fun ImConversationMemberRow(
    member: ImMember,
    actionable: Boolean,
    onHumanClick: (String, String) -> Unit,
    onAgentClick: (ImMember) -> Unit,
) {
    val name = member.displayName.ifBlank {
        if (member.isAgent) "Agent" else stringResource(R.string.im_member_unknown)
    }
    val subtitle = if (member.isAgent) "Agent" else stringResource(R.string.im_member_role_human)
    val description = when {
        member.isAgent && actionable -> stringResource(R.string.im_member_agent_dm_unavailable_a11y, name)
        member.isAgent -> stringResource(R.string.im_member_agent_a11y, name)
        actionable -> stringResource(R.string.im_member_human_open_dm_a11y, name)
        else -> stringResource(R.string.im_member_human_a11y, name)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = description }
            .then(
                if (actionable) {
                    Modifier.clickable {
                        if (member.isAgent) {
                            onAgentClick(member)
                        } else {
                            member.userId?.takeIf { it.isNotBlank() }?.let { onHumanClick(it, name) }
                        }
                    }
                } else Modifier,
            )
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ImMemberAvatar(member = member, displayName = name)
        Spacer(Modifier.size(TTSpacing.md))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = name,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ImMemberAvatar(member: ImMember, displayName: String) {
    val placeholder: @Composable () -> Unit = {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            if (member.memberType == ImMemberType.AGENT) {
                Icon(Icons.Default.SmartToy, contentDescription = null, modifier = Modifier.size(20.dp))
            } else if (displayName.isNotBlank()) {
                Text(displayName.take(1), style = MaterialTheme.typography.labelLarge)
            } else {
                Icon(Icons.Default.Person, contentDescription = null, modifier = Modifier.size(20.dp))
            }
        }
    }
    if (member.avatar.isNotBlank()) {
        SubcomposeAsyncImage(
            model = member.avatar,
            contentDescription = null,
            modifier = Modifier.size(40.dp).clip(CircleShape),
            loading = { placeholder() },
            error = { placeholder() },
        )
    } else {
        placeholder()
    }
}
