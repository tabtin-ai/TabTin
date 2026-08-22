package com.tabtin.mobile.features.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.PendingInvitation
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun InvitationResponseSheet(
    invitation: PendingInvitation,
    isResponding: Boolean,
    onAccept: () -> Unit,
    onReject: () -> Unit,
    onDismiss: () -> Unit,
) {
    TTBottomSheet(
        onDismissRequest = onDismiss,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.xl, vertical = TTSpacing.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = stringResource(R.string.invitation_response_title),
                style = TTFonts.bodySemibold,
            )

            Spacer(Modifier.height(TTSpacing.xl))

            if (invitation.workspaceIcon.isNotBlank()) {
                Text(
                    text = invitation.workspaceIcon,
                    style = TTFonts.iconEmptyLG,
                )
                Spacer(Modifier.height(TTSpacing.md))
            }

            Text(
                text = invitation.workspaceName,
                style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.onSurface,
            )

            Spacer(Modifier.height(TTSpacing.sm))

            if (invitation.invitedByName.isNotBlank()) {
                Text(
                    text = stringResource(R.string.invited_by_user, invitation.invitedByName),
                    style = TTFonts.body,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(TTSpacing.xs))

            val roleLabel = localizedRoleName(invitation.role)
            Text(
                text = stringResource(R.string.ws_invite_accept_role, roleLabel),
                style = TTFonts.caption,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(TTSpacing.xxl))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
            ) {
                OutlinedButton(
                    onClick = onReject,
                    enabled = !isResponding,
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                    ),
                ) {
                    Text(stringResource(R.string.reject_invitation))
                }

                Button(
                    onClick = onAccept,
                    enabled = !isResponding,
                    modifier = Modifier.weight(1f),
                ) {
                    if (isResponding) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                        Spacer(Modifier.width(TTSpacing.sm))
                    }
                    Text(stringResource(R.string.accept_invitation))
                }
            }

            Spacer(Modifier.height(TTSpacing.xl))
        }
    }
}
