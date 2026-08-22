package com.tabtin.mobile.features.conversation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.websocket.ResumeResult
import com.tabtin.mobile.data.websocket.WSConnectionState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.delay

private const val RESUME_DISPLAY_MS = 5_000L

@Composable
public fun ConnectionStatusBar(
    state: WSConnectionState,
    resumeResult: ResumeResult? = null,
    isManualReconnecting: Boolean = false,
    onReconnect: (() -> Unit)? = null,
    onRelogin: (() -> Unit)? = null,
) {
    var hasEverConnected by remember { mutableStateOf(false) }
    var showResumeBanner by remember { mutableStateOf(false) }
    var resumeSyncCount by remember { mutableStateOf(0) }

    LaunchedEffect(state) {
        if (state is WSConnectionState.Connected) hasEverConnected = true
    }

    LaunchedEffect(resumeResult) {
        if (resumeResult != null && resumeResult.syncCount > 0) {
            resumeSyncCount = resumeResult.syncCount
            showResumeBanner = true
            delay(RESUME_DISPLAY_MS)
            showResumeBanner = false
        }
    }

    if (showResumeBanner && state is WSConnectionState.Connected) {
        ResumeBanner(syncCount = resumeSyncCount)
        return
    }

    val visible = when (state) {
        is WSConnectionState.Connected -> false
        is WSConnectionState.Disconnected -> hasEverConnected
        else -> true
    }

    AnimatedVisibility(
        visible = visible,
        enter = expandVertically(),
        exit = shrinkVertically(),
    ) {
        val (bgColor, text) = when (state) {
            is WSConnectionState.Connecting, is WSConnectionState.Authenticating ->
                ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning) to stringResource(R.string.chat_connecting)
            is WSConnectionState.Reconnecting ->
                ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning) to stringResource(R.string.chat_reconnecting, state.attempt)
            is WSConnectionState.Connected ->
                ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess) to stringResource(R.string.chat_connected)
            is WSConnectionState.Disconnected ->
                ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical) to stringResource(R.string.chat_disconnected)
            is WSConnectionState.AuthFailed ->
                ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical) to stringResource(R.string.chat_auth_expired)
            is WSConnectionState.ReconnectGaveUp ->
                ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical) to stringResource(R.string.chat_reconnect_gave_up)
        }

        val fgColor = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary)

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(bgColor)
                .padding(vertical = TTSpacing.xs, horizontal = TTSpacing.md),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (state) {
                is WSConnectionState.Connecting, is WSConnectionState.Authenticating, is WSConnectionState.Reconnecting -> {
                    CircularProgressIndicator(
                        modifier = Modifier.size(12.dp),
                        strokeWidth = 1.5.dp,
                        color = fgColor,
                    )
                }
                is WSConnectionState.Connected -> Icon(
                    Icons.Default.CheckCircle, contentDescription = stringResource(R.string.chat_connected),
                    modifier = Modifier.size(12.dp), tint = fgColor,
                )
                is WSConnectionState.Disconnected, is WSConnectionState.AuthFailed, is WSConnectionState.ReconnectGaveUp -> Icon(
                    Icons.Default.WifiOff, contentDescription = stringResource(R.string.chat_disconnected),
                    modifier = Modifier.size(12.dp), tint = fgColor,
                )
            }

            Text(
                text = text,
                color = fgColor,
                style = ConversationTypography.meta,
                modifier = Modifier.padding(start = TTSpacing.sm),
            )

            when (state) {
                is WSConnectionState.AuthFailed -> {
                    if (onRelogin != null) {
                        Text(
                            text = stringResource(R.string.chat_relogin),
                            color = fgColor,
                            style = TTFonts.caption.copy(textDecoration = TextDecoration.Underline),
                            modifier = Modifier
                                .padding(start = TTSpacing.sm)
                                .clickable { onRelogin() },
                        )
                    }
                }
                is WSConnectionState.Disconnected, is WSConnectionState.ReconnectGaveUp -> {
                    if (onReconnect != null) {
                        if (isManualReconnecting) {
                            CircularProgressIndicator(
                                modifier = Modifier.padding(start = TTSpacing.sm).size(12.dp),
                                strokeWidth = 1.5.dp,
                                color = fgColor,
                            )
                        } else {
                            Text(
                                text = stringResource(R.string.chat_manual_reconnect),
                                color = fgColor,
                                style = TTFonts.caption.copy(textDecoration = TextDecoration.Underline),
                                modifier = Modifier
                                    .padding(start = TTSpacing.sm)
                                    .clickable { onReconnect() },
                            )
                        }
                    }
                }
                is WSConnectionState.Reconnecting -> {
                    if (onReconnect != null && !isManualReconnecting) {
                        Text(
                            text = stringResource(R.string.chat_manual_reconnect),
                            color = fgColor,
                            style = TTFonts.caption.copy(textDecoration = TextDecoration.Underline),
                            modifier = Modifier
                                .padding(start = TTSpacing.sm)
                                .clickable { onReconnect() },
                        )
                    }
                }
                else -> {}
            }
        }
    }
}

@Composable
private fun ResumeBanner(syncCount: Int) {
    val bgColor = ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess)
    val fgColor = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(bgColor)
            .padding(vertical = TTSpacing.xs, horizontal = TTSpacing.md),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Default.CheckCircle,
            contentDescription = null,
            modifier = Modifier.size(12.dp),
            tint = fgColor,
        )
        Text(
            text = stringResource(R.string.chat_resumed_with_sync, syncCount),
            color = fgColor,
            style = ConversationTypography.meta,
            modifier = Modifier.padding(start = TTSpacing.sm),
        )
    }
}
