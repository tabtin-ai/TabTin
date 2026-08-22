package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor

@Composable
public fun SessionReadyIndicatorDot(
    wsConnected: Boolean,
    remoteExecutionState: RemoteExecutionState,
    modifier: Modifier = Modifier,
) {
    val ready = SessionReadyIndicatorPolicy.showsReady(wsConnected, remoteExecutionState)
    val color = if (ready) {
        ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess)
    } else {
        ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    }
    Box(
        modifier = modifier
            .size(7.dp)
            .background(color, CircleShape),
    )
}
