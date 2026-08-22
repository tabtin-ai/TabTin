package com.tabtin.mobile.features.conversation

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 胶囊菜单选「文字」后的迷你输入条：自动聚焦键盘，发送走会话既有 send 路径。
 */
@Composable
internal fun CapsuleTextComposerOverlay(
    disabledReason: String?,
    onSend: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    Popup(
        onDismissRequest = onDismiss,
        properties = PopupProperties(
            focusable = true,
            dismissOnBackPress = true,
            dismissOnClickOutside = true,
        ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .imePadding(),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.18f))
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = onDismiss,
                    ),
            )
            CapsuleTextComposerBar(
                disabledReason = disabledReason,
                onSend = onSend,
                onCancel = onDismiss,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm)
                    .fillMaxWidth(),
            )
        }
    }
}

@Composable
internal fun CapsuleTextComposerBar(
    disabledReason: String?,
    onSend: (String) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var value by remember { mutableStateOf(TextFieldValue("")) }
    val focusRequester = remember { FocusRequester() }
    val view = LocalView.current
    val trimmed = value.text.trim()
    val canSend = trimmed.isNotEmpty() && disabledReason == null
    val placeholder = stringResource(R.string.agent_capsule_text_composer_placeholder)
    val sendA11y = stringResource(R.string.agent_capsule_text_composer_send_a11y)
    val shape = RoundedCornerShape(18.dp)

    LaunchedEffect(disabledReason) {
        if (disabledReason == null) {
            focusRequester.requestFocus()
        }
    }

    Column(
        modifier = modifier
            .shadow(10.dp, shape)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surface)
            .border(
                width = 0.5.dp,
                color = MaterialTheme.colorScheme.outlineVariant,
                shape = shape,
            )
            .padding(TTSpacing.md),
    ) {
        if (disabledReason != null) {
            Text(
                text = disabledReason,
                style = ConversationTypography.meta,
                color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                maxLines = 2,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = TTSpacing.sm),
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Bottom,
        ) {
            BasicTextField(
                value = value,
                onValueChange = { value = it },
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 36.dp)
                    .focusRequester(focusRequester)
                    .semantics { contentDescription = placeholder },
                textStyle = ConversationTypography.composer.copy(
                    color = if (disabledReason != null) {
                        ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                    } else {
                        ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
                    },
                ),
                cursorBrush = SolidColor(ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent)),
                maxLines = 5,
                enabled = disabledReason == null,
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (value.text.isEmpty()) {
                            Text(
                                text = placeholder,
                                style = ConversationTypography.composer,
                                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                maxLines = 1,
                            )
                        }
                        inner()
                    }
                },
            )

            Spacer(modifier = Modifier.width(TTSpacing.sm))

            IconButton(
                onClick = {
                    if (!canSend) return@IconButton
                    // 发送确认触觉；CONFIRM 需要 API 30，低版本退回 LONG_PRESS。
                    val haptic = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        HapticFeedbackConstants.CONFIRM
                    } else {
                        HapticFeedbackConstants.LONG_PRESS
                    }
                    view.performHapticFeedback(haptic)
                    onSend(trimmed)
                    value = TextFieldValue("")
                },
                enabled = canSend,
                modifier = Modifier
                    .semantics { contentDescription = sendA11y },
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Send,
                    contentDescription = null,
                    tint = if (canSend) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
                    },
                )
            }

            TextButton(onClick = onCancel) {
                Text(
                    text = stringResource(R.string.common_cancel),
                    style = TTFonts.meta,
                )
            }
        }
    }
}
