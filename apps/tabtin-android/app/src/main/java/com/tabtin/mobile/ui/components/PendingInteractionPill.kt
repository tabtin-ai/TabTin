package com.tabtin.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 会话列表行的「待处理」pill——该会话存在打断会话流程、等用户处理的事项
 * （工具审批 / 选择题 / 表单 / 权限请求）时显示。
 *
 * 数据源：[com.tabtin.mobile.data.repository.PendingInteractionRepository.pendingSessionIds]。
 */
@Composable
public fun PendingInteractionPill(modifier: Modifier = Modifier) {
    val contentColor = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
    Text(
        text = stringResource(R.string.chat_session_pending_pill),
        style = TTFonts.captionSemibold,
        color = contentColor,
        maxLines = 1,
        modifier = modifier
            .clip(CircleShape)
            .background(contentColor.copy(alpha = 0.12f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}
