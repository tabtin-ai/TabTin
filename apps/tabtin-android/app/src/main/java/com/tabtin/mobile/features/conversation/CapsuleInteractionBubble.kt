package com.tabtin.mobile.features.conversation

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.rememberReduceMotion

/**
 * 胶囊旁的轻量 HITL 交互层。它只投影现有 pending 状态，提交和错误生命周期仍由
 * [ConversationViewModel] 持有，因此失败后原动作可以直接重试，成功后随 pending 清除。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CapsuleInteractionBubble(
    model: CapsuleInteractionBubbleModel,
    dockSide: CapsuleDockSide,
    aboveCapsule: Boolean,
    onIntent: (CapsuleInteractionIntent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val reduceMotion = rememberReduceMotion()
    var appeared by remember(model.stableId) { mutableStateOf(false) }
    LaunchedEffect(model.stableId) { appeared = true }

    val alpha by animateFloatAsState(
        targetValue = if (appeared) 1f else 0f,
        animationSpec = if (reduceMotion) snap() else spring(stiffness = Spring.StiffnessHigh),
        label = "capsuleInteractionBubbleAlpha",
    )
    val scale by animateFloatAsState(
        targetValue = if (appeared || reduceMotion) 1f else 0.96f,
        animationSpec = if (reduceMotion) snap() else spring(dampingRatio = 0.84f, stiffness = 420f),
        label = "capsuleInteractionBubbleScale",
    )
    val animatedTranslationY by animateDpAsState(
        targetValue = when {
            appeared || reduceMotion -> 0.dp
            aboveCapsule -> 8.dp
            else -> (-8).dp
        },
        animationSpec = if (reduceMotion) snap() else spring(dampingRatio = 0.84f, stiffness = 420f),
        label = "capsuleInteractionBubbleTranslationY",
    )
    val kindLabel = stringResource(
        when (model) {
            is CapsuleInteractionBubbleModel.Approval -> R.string.agent_capsule_bubble_approval_kind
            is CapsuleInteractionBubbleModel.Choice -> R.string.agent_capsule_bubble_answer_kind
            is CapsuleInteractionBubbleModel.ReadOnly -> R.string.agent_capsule_bubble_waiting_kind
        },
    )
    val semanticState = when {
        model.submitting -> stringResource(R.string.chat_approval_dock_title_submitting)
        model.errorMessage != null -> stringResource(R.string.agent_capsule_bubble_retry_hint)
        else -> kindLabel
    }

    Surface(
        modifier = modifier
            .widthIn(min = 248.dp, max = 288.dp)
            .graphicsLayer {
                this.alpha = alpha
                scaleX = scale
                scaleY = scale
                translationY = animatedTranslationY.toPx()
                transformOrigin = TransformOrigin(
                    pivotFractionX = if (dockSide == CapsuleDockSide.LEFT) 0f else 1f,
                    pivotFractionY = if (aboveCapsule) 1f else 0f,
                )
            }
            .semantics {
                paneTitle = kindLabel
                liveRegion = LiveRegionMode.Polite
                isTraversalGroup = true
                stateDescription = semanticState
            },
        shape = TTRadius.Shapes.lg,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shadowElevation = 10.dp,
    ) {
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .padding(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = kindLabel,
                    style = TTFonts.captionSemibold,
                    color = MaterialTheme.colorScheme.primary,
                )
                if (model.submitting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                    )
                }
            }

            if (model.title.isNotBlank()) {
                Text(
                    text = model.title,
                    style = TTFonts.subtitleSemibold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            if (model.message.isNotBlank() && model.message != model.title) {
                Text(
                    text = model.message,
                    style = TTFonts.body,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (
                model is CapsuleInteractionBubbleModel.Approval &&
                model.title.isBlank() &&
                model.message.isBlank()
            ) {
                Text(
                    text = stringResource(R.string.agent_capsule_bubble_details_in_chat),
                    style = TTFonts.body,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (model is CapsuleInteractionBubbleModel.ReadOnly) {
                Text(
                    text = stringResource(R.string.chat_hitl_readonly_title),
                    style = TTFonts.subtitleSemibold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = stringResource(R.string.chat_hitl_readonly_message),
                    style = TTFonts.body,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            model.errorMessage?.let { error ->
                Text(
                    text = error,
                    style = TTFonts.caption,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            when (model) {
                is CapsuleInteractionBubbleModel.Approval -> {
                    FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    ) {
                        model.actions.forEach { action ->
                            CapsuleApprovalAction(
                                action = action,
                                onIntent = onIntent,
                            )
                        }
                    }
                }
                is CapsuleInteractionBubbleModel.Choice -> {
                    FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    ) {
                        model.options.forEach { option ->
                            AssistChip(
                                onClick = { onIntent(option.intent) },
                                label = { Text(option.label, style = TTFonts.bodyMedium) },
                                enabled = option.enabled,
                                modifier = Modifier.heightIn(min = 48.dp),
                            )
                        }
                        model.openConversationAction?.let { action ->
                            TextButton(
                                onClick = { onIntent(action.intent) },
                                enabled = action.enabled,
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) {
                                Text(stringResource(R.string.agent_capsule_bubble_answer_in_chat))
                            }
                        }
                    }
                }
                is CapsuleInteractionBubbleModel.ReadOnly -> {
                    TextButton(
                        onClick = { onIntent(model.openConversationAction.intent) },
                        enabled = model.openConversationAction.enabled,
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) {
                        Text(stringResource(R.string.agent_capsule_bubble_view))
                    }
                }
            }
        }
    }
}

@Composable
private fun CapsuleApprovalAction(
    action: CapsuleInteractionAction,
    onIntent: (CapsuleInteractionIntent) -> Unit,
) {
    val modifier = Modifier.heightIn(min = 48.dp)
    when (action.intent) {
        is CapsuleInteractionIntent.ApproveRequest,
        is CapsuleInteractionIntent.SubmitToolApproval -> {
            val allowAction = action.intent is CapsuleInteractionIntent.ApproveRequest ||
                (action.intent as? CapsuleInteractionIntent.SubmitToolApproval)?.outcome == "allow"
            if (allowAction) {
                Button(
                    onClick = { onIntent(action.intent) },
                    enabled = action.enabled,
                    modifier = modifier,
                ) {
                    Text(
                        action.label
                            ?: stringResource(R.string.agent_capsule_bubble_approve),
                    )
                }
            } else {
                OutlinedButton(
                    onClick = { onIntent(action.intent) },
                    enabled = action.enabled,
                    modifier = modifier,
                ) {
                    Text(stringResource(R.string.chat_approval_deny))
                }
            }
        }
        is CapsuleInteractionIntent.RejectRequest -> {
            OutlinedButton(
                onClick = { onIntent(action.intent) },
                enabled = action.enabled,
                modifier = modifier,
            ) {
                Text(action.label ?: stringResource(R.string.chat_approval_deny))
            }
        }
        is CapsuleInteractionIntent.OpenConversation -> {
            TextButton(
                onClick = { onIntent(action.intent) },
                enabled = action.enabled,
                modifier = modifier,
            ) {
                Text(
                    stringResource(
                        if (action.intent.reviewChanges) {
                            R.string.agent_capsule_bubble_review_changes
                        } else {
                            R.string.agent_capsule_bubble_view_details
                        },
                    ),
                )
            }
        }
        is CapsuleInteractionIntent.SubmitAskUserOption -> Unit
    }
}
