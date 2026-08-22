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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ReviewActionRequest
import com.tabtin.mobile.data.model.ReviewRequestState
import com.tabtin.mobile.features.conversation.cards.ChatCardTokens
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

@Composable
internal fun ReviewPanelView(
    request: ReviewRequestState,
    isSubmitting: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val allowsReject = request.reviewConfigs.isEmpty()
        || request.reviewConfigs.any { it.allowedDecisions.contains("reject") }
    val shape = TTRadius.Shapes.md

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .border(1.dp, ChatCardTokens.borderWarning(), shape)
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Default.Shield,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = ChatCardTokens.riskMedium(),
            )
            Spacer(Modifier.width(TTSpacing.xs))
            Text(
                stringResource(R.string.chat_review_title),
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
        }

        request.message?.takeIf { it.isNotBlank() }?.let { msg ->
            Text(
                msg,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
        }

        Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
            request.actionRequests.forEach { action ->
                ReviewActionCard(action)
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            if (allowsReject) {
                OutlinedButton(
                    onClick = { if (!isSubmitting) onReject() },
                    modifier = Modifier.weight(1f),
                    enabled = !isSubmitting,
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = ChatCardTokens.riskHigh(),
                    ),
                ) {
                    if (isSubmitting) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Text(
                            stringResource(R.string.chat_review_reject_all),
                            style = TTFonts.captionSemibold,
                        )
                    }
                }
            }

            Button(
                onClick = { if (!isSubmitting) onApprove() },
                modifier = Modifier.weight(1f),
                enabled = !isSubmitting,
                colors = ButtonDefaults.buttonColors(
                    containerColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    contentColor = Color.White,
                ),
            ) {
                if (isSubmitting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = Color.White,
                    )
                } else {
                    Text(
                        stringResource(R.string.chat_review_approve_all),
                        style = TTFonts.captionSemibold,
                    )
                }
            }
        }
    }
}

@Composable
private fun ReviewActionCard(action: ReviewActionRequest) {
    val shape = TTRadius.Shapes.sm

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(ttColor(TTColors.Background, TTColors.Dark.Background))
            .border(1.dp, ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight), shape)
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.chat_review_tool_label),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
            Spacer(Modifier.width(TTSpacing.xxs))
            Text(
                action.toolName,
                style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
        }

        action.description?.takeIf { it.isNotBlank() }?.let { desc ->
            Text(
                desc,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }

        action.arguments?.takeIf { it.isNotBlank() }?.let { argsStr ->
            val preview = formatArgsPreview(argsStr)
            if (preview.isNotBlank()) {
                Text(
                    preview,
                    style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    maxLines = 4,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

private fun formatArgsPreview(argsJson: String): String {
    return try {
        val obj = Json.decodeFromString<JsonObject>(argsJson)
        obj.entries.take(3).joinToString("\n") { (k, v) ->
            val valStr = when (v) {
                is JsonPrimitive -> v.contentOrNull ?: "null"
                else -> v.toString()
            }
            "$k: ${valStr.take(80)}"
        }
    } catch (_: Exception) {
        argsJson.take(200)
    }
}
