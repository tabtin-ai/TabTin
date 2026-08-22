package com.tabtin.mobile.features.conversation

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.tabtin.mobile.R
import com.tabtin.mobile.features.space.AgentIdentityAvatar
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.rememberReduceMotion
import com.tabtin.mobile.ui.theme.ttColor

/**
 * Agent 状态胶囊：完整态高度 48dp；待命 mini 为 44dp 视觉圆 + 48dp 命中区。
 * 短按 / 拖拽 / 长按菜单由 [CapsulePositionedHost] 承接；语音主路径经菜单「语音」触发。
 * TalkBack「开始语音指令」仍可直达录音。
 */
@Composable
public fun AgentStatusCapsule(
    status: TaskCapsuleStatus,
    visual: TaskCapsuleVisual = TaskCapsuleModel.resolveVisual(status),
    statusLabel: String = "",
    agentName: String = "Agent",
    avatarKey: String? = null,
    avatarUrl: String? = null,
    privacyGranted: Boolean = true,
    queuedCount: Int = 0,
    unreadCount: Int = 0,
    copyContext: AgentStatusCapsuleContext = AgentStatusCapsuleContext(),
    voiceActive: Boolean = false,
    /** latch 录音控制指上滑到取消区时的描边反馈。 */
    voiceCancelArmed: Boolean = false,
    onHoldStart: () -> Unit = {},
    onHoldCancel: () -> Unit = {},
    onHoldComplete: () -> Unit = {},
    onNeedsPrivacyConsent: () -> Unit = {},
    onTap: () -> Unit = {},
    onDockLeft: () -> Unit = {},
    onDockRight: () -> Unit = {},
    /**
     * 菜单选「语音」时递增。须配合 [voiceFromMenuConsumedTick] / [onVoiceFromMenuConsumed]：
     * 只在 request > consumed 时开录一次，避免胶囊切面卸载再挂载时粘性 tick 重开火。
     */
    voiceFromMenuTick: Int = 0,
    voiceFromMenuConsumedTick: Int = 0,
    onVoiceFromMenuConsumed: () -> Unit = {},
    /** R2-动效：上报 chrome LayoutCoordinates，供宿主换算实测 MorphRect。 */
    onChromePositioned: ((LayoutCoordinates) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val holdStart by rememberUpdatedState(onHoldStart)
    val holdCancel by rememberUpdatedState(onHoldCancel)
    val holdComplete by rememberUpdatedState(onHoldComplete)
    val needsConsent by rememberUpdatedState(onNeedsPrivacyConsent)
    val tap by rememberUpdatedState(onTap)
    val privacy by rememberUpdatedState(privacyGranted)
    val chromeCallback by rememberUpdatedState(onChromePositioned)
    var a11ySessionLive by remember { mutableStateOf(false) }
    val sessionLive = a11ySessionLive || voiceActive

    val copy = remember(status, queuedCount, unreadCount, copyContext) {
        AgentStatusCapsuleCopy.resolve(
            status = status,
            queuedCount = queuedCount,
            unreadCount = unreadCount,
            context = copyContext,
        )
    }
    val statusColor = copy.colorRole.toComposeColor()
    val titleText = resolveCopyTitle(copy)
    val subtitleText = resolveCopySubtitle(copy)
    val statusLineText = remember(titleText, subtitleText) {
        subtitleText?.takeIf { it.isNotBlank() }?.let { "$titleText · $it" } ?: titleText
    }
    val resolvedLabel = statusLabel.ifBlank { statusLineText }

    val micLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { _ ->
        // 权限弹窗返回后不自动开录，须再次激活 a11y 或菜单
    }

    val dragHint = stringResource(R.string.agent_capsule_a11y_drag_hint)
    val contentDesc = "$dragHint · $resolvedLabel"
    val a11yReturnChat = stringResource(R.string.agent_capsule_a11y_return_chat)
    val a11yStartVoice = stringResource(R.string.agent_capsule_a11y_start_voice)
    val a11yDockLeft = stringResource(R.string.agent_capsule_a11y_dock_left)
    val a11yDockRight = stringResource(R.string.agent_capsule_a11y_dock_right)
    val dockLeft by rememberUpdatedState(onDockLeft)
    val dockRight by rememberUpdatedState(onDockRight)
    val a11yEndAndSend = stringResource(R.string.agent_capsule_a11y_end_and_send)
    val a11yCancelVoice = stringResource(R.string.agent_capsule_a11y_cancel_voice)

    val tryBeginHoldRecording by rememberUpdatedState({
        when {
            !privacy -> {
                needsConsent()
                false
            }
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
                PackageManager.PERMISSION_GRANTED -> {
                micLauncher.launch(Manifest.permission.RECORD_AUDIO)
                false
            }
            else -> {
                holdStart()
                a11ySessionLive = true
                true
            }
        }
    })

    val consumeMenuVoice by rememberUpdatedState(onVoiceFromMenuConsumed)
    LaunchedEffect(voiceFromMenuTick, voiceFromMenuConsumedTick) {
        if (CapsuleMenuVoiceHandoff.shouldBegin(voiceFromMenuTick, voiceFromMenuConsumedTick)) {
            // 先消费代数，再开录：权限弹窗 / 同意态失败时也不要因重挂载自动重试。
            consumeMenuVoice()
            tryBeginHoldRecording()
        }
    }

    LaunchedEffect(voiceActive) {
        if (!voiceActive) {
            a11ySessionLive = false
        }
    }

    val a11yModifier = Modifier.semantics {
        contentDescription = contentDesc
        customActions = if (sessionLive) {
            listOf(
                CustomAccessibilityAction(a11yReturnChat) {
                    tap()
                    true
                },
                CustomAccessibilityAction(a11yEndAndSend) {
                    holdComplete()
                    a11ySessionLive = false
                    true
                },
                CustomAccessibilityAction(a11yCancelVoice) {
                    holdCancel()
                    a11ySessionLive = false
                    true
                },
            )
        } else {
            listOf(
                CustomAccessibilityAction(a11yReturnChat) {
                    tap()
                    true
                },
                CustomAccessibilityAction(a11yStartVoice) {
                    tryBeginHoldRecording()
                    true
                },
                CustomAccessibilityAction(a11yDockLeft) {
                    dockLeft()
                    true
                },
                CustomAccessibilityAction(a11yDockRight) {
                    dockRight()
                    true
                },
            )
        }
    }

    val reduceMotion = rememberReduceMotion()
    val morphMs = if (reduceMotion) 0 else TaskSurfaceMorphTiming.PHONE_CAPSULE_MORPH_MS

    val measureModifier = Modifier.onGloballyPositioned { coords ->
        chromeCallback?.invoke(coords)
    }
    val idleBorderColor = when {
        voiceCancelArmed -> MaterialTheme.colorScheme.error
        voiceActive -> statusColor.copy(alpha = 0.65f)
        copy.emphasizesUserAttention -> statusColor.copy(alpha = 0.55f)
        else -> ttColor(
            com.tabtin.mobile.ui.theme.TTColors.BorderLight,
            com.tabtin.mobile.ui.theme.TTColors.Dark.BorderLight,
        )
    }
    val voiceChrome = Modifier
        .scale(if (voiceActive && !voiceCancelArmed) 0.97f else 1f)
        .then(
            if (voiceActive || voiceCancelArmed || copy.emphasizesUserAttention) {
                Modifier.border(
                    width = when {
                        voiceActive -> 1.5.dp
                        copy.emphasizesUserAttention -> 1.dp
                        else -> 1.dp
                    },
                    color = idleBorderColor,
                    shape = RoundedCornerShape(24.dp),
                )
            } else {
                Modifier.border(
                    width = 0.5.dp,
                    color = idleBorderColor,
                    shape = RoundedCornerShape(24.dp),
                )
            },
        )

    AnimatedContent(
        targetState = visual,
        transitionSpec = {
            fadeIn(tween(morphMs, easing = TaskSurfaceMorphTiming.Easing)) togetherWith
                fadeOut(tween(morphMs, easing = TaskSurfaceMorphTiming.Easing))
        },
        label = "agentCapsuleMorph",
        modifier = modifier.then(measureModifier).then(voiceChrome),
    ) { target ->
        when (target) {
            TaskCapsuleVisual.MINI -> {
                Box(
                    modifier = Modifier
                        .size(48.dp)
                        .then(a11yModifier),
                    contentAlignment = Alignment.Center,
                ) {
                    AgentIdentityAvatar(
                        name = agentName,
                        avatarKey = avatarKey,
                        avatarUrl = avatarUrl,
                        size = 32.dp,
                    )
                    // mini 角标与 full 一致：只用色点，不用 Psychology/Build 等状态字形。
                    Box(
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .size(14.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.surface),
                        contentAlignment = Alignment.Center,
                    ) {
                        CapsuleStatusDot(
                            color = statusColor,
                            animated = copy.isBusy && !reduceMotion,
                        )
                    }
                }
            }
            TaskCapsuleVisual.FULL -> {
                Row(
                    modifier = Modifier
                        .height(48.dp)
                        .widthIn(min = 48.dp, max = 360.dp)
                        .clip(RoundedCornerShape(24.dp))
                        .background(
                            if (voiceCancelArmed) {
                                MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.35f)
                            } else {
                                MaterialTheme.colorScheme.surface.copy(alpha = 0.96f)
                            },
                        )
                        .then(a11yModifier)
                        .padding(start = 8.dp, end = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    AgentIdentityAvatar(
                        name = agentName,
                        avatarKey = avatarKey,
                        avatarUrl = avatarUrl,
                        size = 32.dp,
                    )
                    Column(
                        modifier = Modifier.widthIn(max = 270.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(
                            text = agentName,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurface,
                            maxLines = 1,
                        )
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            CapsuleStatusDot(
                                color = statusColor,
                                animated = copy.isBusy && !reduceMotion,
                            )
                            Text(
                                text = if (voiceCancelArmed) {
                                    stringResource(R.string.agent_capsule_slide_to_cancel)
                                } else {
                                    resolvedLabel
                                },
                                style = MaterialTheme.typography.labelMedium,
                                color = if (voiceCancelArmed) {
                                    MaterialTheme.colorScheme.error
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant
                                },
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
            TaskCapsuleVisual.HIDDEN -> Unit
        }
    }
}

@Composable
private fun resolveCopyTitle(copy: AgentStatusCapsuleCopy): String {
    val formatArg = copy.titleFormatArg
    return if (formatArg != null) {
        stringResource(copy.titleResId, formatArg)
    } else {
        stringResource(copy.titleResId)
    }
}

@Composable
private fun resolveCopySubtitle(copy: AgentStatusCapsuleCopy): String? {
    copy.subtitleText?.takeIf { it.isNotBlank() }?.let { return it }
    val resId = copy.subtitleResId ?: return null
    val formatArg = copy.subtitleFormatArg
    return if (formatArg != null) {
        stringResource(resId, formatArg)
    } else {
        stringResource(resId)
    }
}

@Composable
private fun CapsuleStatusDot(
    color: Color,
    animated: Boolean,
) {
    Box(
        modifier = Modifier.size(10.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (animated) {
            val transition = rememberInfiniteTransition(label = "capsulePulse")
            val pulseScale by transition.animateFloat(
                initialValue = 1f,
                targetValue = 1.55f,
                animationSpec = infiniteRepeatable(
                    animation = tween(durationMillis = 700),
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "capsulePulseScale",
            )
            val pulseAlpha by transition.animateFloat(
                initialValue = 0.55f,
                targetValue = 0.15f,
                animationSpec = infiniteRepeatable(
                    animation = tween(durationMillis = 700),
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "capsulePulseAlpha",
            )
            Box(
                modifier = Modifier
                    .size(10.dp)
                    .scale(pulseScale)
                    .clip(CircleShape)
                    .background(color.copy(alpha = pulseAlpha)),
            )
        }
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(color),
        )
    }
}
