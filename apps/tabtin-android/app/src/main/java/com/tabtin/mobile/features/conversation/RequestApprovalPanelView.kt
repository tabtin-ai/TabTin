package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.RequestApprovalRequest
import com.tabtin.mobile.features.conversation.cards.ChatCardTokens
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
internal fun RequestApprovalPanelView(
    request: RequestApprovalRequest,
    isSubmitting: Boolean,
    onSubmit: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = TTRadius.Shapes.md
    var lastClicked by remember(request.requestId) { mutableStateOf<Boolean?>(null) }
    val riskColor = riskColor(request.riskLevel)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .border(1.dp, riskColor.copy(alpha = 0.45f), shape)
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Default.Shield,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = riskColor,
            )
            Spacer(Modifier.width(TTSpacing.xs))
            Text(
                request.title,
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                modifier = Modifier.weight(1f),
            )
            Text(
                riskLabel(request.riskLevel),
                style = TTFonts.captionSemibold,
                color = riskColor,
                modifier = Modifier
                    .clip(TTRadius.Shapes.sm)
                    .background(riskColor.copy(alpha = 0.1f))
                    .padding(horizontal = TTSpacing.xs, vertical = 2.dp),
            )
        }

        request.rationale.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm, Alignment.End),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(
                onClick = {
                    if (!isSubmitting) {
                        lastClicked = false
                        onSubmit(false)
                    }
                },
                enabled = !isSubmitting,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = ChatCardTokens.riskHigh()),
            ) {
                if (isSubmitting && lastClicked == false) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    Text(request.declineLabel ?: stringResource(R.string.chat_approval_deny), style = TTFonts.captionSemibold)
                }
            }

            Button(
                onClick = {
                    if (!isSubmitting) {
                        lastClicked = true
                        onSubmit(true)
                    }
                },
                enabled = !isSubmitting,
                colors = ButtonDefaults.buttonColors(
                    containerColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    contentColor = Color.White,
                ),
            ) {
                if (isSubmitting && lastClicked == true) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = Color.White)
                } else {
                    Text(request.submitLabel ?: stringResource(R.string.chat_approval_allow), style = TTFonts.captionSemibold)
                }
            }
        }
    }
}

@Composable
private fun riskColor(raw: String): Color = when (raw.trim().lowercase()) {
    "low" -> ChatCardTokens.riskLow()
    "high" -> ChatCardTokens.riskHigh()
    "critical" -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
    else -> ChatCardTokens.riskMedium()
}

@Composable
private fun riskLabel(raw: String): String = when (raw.trim().lowercase()) {
    "low" -> stringResource(R.string.chat_permission_risk_low)
    "high" -> stringResource(R.string.chat_permission_risk_high)
    "critical" -> stringResource(R.string.chat_permission_risk_critical)
    else -> stringResource(R.string.chat_permission_risk_medium)
}
