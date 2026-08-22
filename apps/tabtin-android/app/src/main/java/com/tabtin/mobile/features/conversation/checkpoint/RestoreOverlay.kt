package com.tabtin.mobile.features.conversation.checkpoint

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.tabtin.mobile.R
import com.tabtin.mobile.features.conversation.ConversationTypography
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
public fun RestoreOverlay(phase: String) {
    val phaseText = when (phase) {
        "preparing" -> stringResource(R.string.checkpoint_restore_preparing)
        "files" -> stringResource(R.string.checkpoint_restore_files)
        "resources" -> stringResource(R.string.checkpoint_restore_resources)
        "finalizing" -> stringResource(R.string.checkpoint_restore_finalizing)
        else -> stringResource(R.string.checkpoint_restore_preparing)
    }

    Dialog(
        onDismissRequest = {},
        properties = DialogProperties(
            dismissOnBackPress = false,
            dismissOnClickOutside = false,
            usePlatformDefaultWidth = false,
        ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary).copy(alpha = 0.5f)),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                modifier = Modifier
                    .background(
                        color = ttColor(TTColors.Background, TTColors.Dark.Background),
                        shape = TTRadius.Shapes.lg,
                    )
                    .padding(horizontal = TTSpacing.xxl, vertical = TTSpacing.xxxl),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(40.dp),
                    strokeWidth = 3.dp,
                    color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                )
                Spacer(Modifier.height(TTSpacing.lg))
                Text(
                    phaseText,
                    style = ConversationTypography.bodySemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                )
            }
        }
    }
}
