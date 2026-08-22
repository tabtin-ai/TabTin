package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * Privacy-preserving team-space fallback shared by every full HITL panel.
 *
 * It intentionally accepts no prompt payload, so a non-owner cannot reveal a question, form,
 * rationale, tool arguments, or decision controls through the full conversation surface.
 */
@Composable
internal fun HitlReadonlyPanel(modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = TTRadius.Shapes.lg,
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Column(
            modifier = Modifier.padding(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
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
    }
}
