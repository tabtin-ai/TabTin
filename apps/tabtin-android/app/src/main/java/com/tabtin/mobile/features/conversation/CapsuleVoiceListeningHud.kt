package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 菜单选语音后的聆听条：显式「取消 / 发送」，不再依赖上滑取消。
 */
@Composable
internal fun CapsuleVoiceListeningHud(
    phase: TaskVoiceSessionPhase,
    transcript: String,
    onCancel: () -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // PROCESSING 也保留取消：空转写 / final 等待期间不能把用户锁死在聆听条上。
    val showCancel = phase == TaskVoiceSessionPhase.RECORDING ||
        phase == TaskVoiceSessionPhase.TRANSCRIBING ||
        phase == TaskVoiceSessionPhase.PROCESSING
    val showSend = phase == TaskVoiceSessionPhase.RECORDING ||
        phase == TaskVoiceSessionPhase.TRANSCRIBING
    val showActions = showCancel || showSend
    val title = when (phase) {
        TaskVoiceSessionPhase.PROCESSING -> stringResource(R.string.agent_capsule_voice_recognizing)
        else -> stringResource(R.string.agent_capsule_voice_listening)
    }
    val body = transcript.trim().ifEmpty {
        when (phase) {
            TaskVoiceSessionPhase.PROCESSING ->
                stringResource(R.string.agent_capsule_voice_processing_hint)
            else -> stringResource(R.string.agent_capsule_voice_listening_hint)
        }
    }
    val cancelLabel = stringResource(R.string.agent_capsule_voice_cancel)
    val sendLabel = stringResource(R.string.agent_capsule_voice_send)
    val cancelA11y = stringResource(R.string.agent_capsule_a11y_cancel_voice)
    val sendA11y = stringResource(R.string.agent_capsule_a11y_end_and_send)
    val shape = RoundedCornerShape(16.dp)
    val accent = ttColor(TTColors.Accent, TTColors.Dark.Accent)

    Column(
        modifier = modifier
            .shadow(14.dp, shape)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.96f))
            .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .semantics(mergeDescendants = !showActions) {
                contentDescription = "$title，$body"
            },
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                imageVector = Icons.Filled.Mic,
                contentDescription = null,
                tint = TTColors.TextOnPrimary,
                modifier = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(accent)
                    .padding(8.dp),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = title,
                    style = TTFonts.captionSemibold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = body,
                    style = TTFonts.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (showActions) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (showCancel) {
                    TextButton(
                        onClick = onCancel,
                        modifier = Modifier
                            .weight(1f)
                            .semantics { contentDescription = cancelA11y },
                    ) {
                        Text(cancelLabel, color = MaterialTheme.colorScheme.onSurface)
                    }
                }
                if (showSend) {
                    TextButton(
                        onClick = onSend,
                        modifier = Modifier
                            .weight(1f)
                            .semantics { contentDescription = sendA11y },
                    ) {
                        Text(sendLabel, color = accent, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}
