package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

@Composable
internal fun ErrorBannerView(message: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(ChatCardTokens.cardRadius)
            .background(ChatCardTokens.bgError())
            .padding(ChatCardTokens.cardPaddingH, ChatCardTokens.cardPaddingV),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Default.ErrorOutline, null,
            modifier = Modifier.size(ChatCardTokens.iconSizeLg),
            tint = ChatCardTokens.textError(),
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Text(
            message,
            style = TTFonts.caption,
            color = ChatCardTokens.textError(),
        )
    }
}
