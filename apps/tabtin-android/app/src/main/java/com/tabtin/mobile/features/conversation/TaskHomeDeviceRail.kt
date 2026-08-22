package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 任务列表顶部的只读设备状态条。
 *
 * 不筛选会话、不提供「全部设备」，也不重复展示离线说明。
 */
@Composable
internal fun TaskHomeDeviceRail(
    items: List<TaskHomeDevicePolicy.DeviceItem>,
    modifier: Modifier = Modifier,
) {
    val offlineSuffix = stringResource(R.string.task_home_device_offline)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Default.Computer,
            contentDescription = null,
            modifier = Modifier.size(14.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Box(
            modifier = Modifier
                .width(1.dp)
                .height(14.dp)
                .background(MaterialTheme.colorScheme.outlineVariant),
        )
        Spacer(Modifier.width(TTSpacing.xs))

        Row(
            modifier = Modifier
                .weight(1f)
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            items.forEach { device ->
                Row(
                    modifier = Modifier
                        .clip(CircleShape)
                        .border(
                            1.dp,
                            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f),
                            CircleShape,
                        )
                        .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs)
                        .semantics {
                            contentDescription = if (device.isOffline) {
                                "${device.fullName}，$offlineSuffix"
                            } else {
                                device.fullName
                            }
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = device.shortName,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.width(TTSpacing.xs))
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(
                                if (device.isOffline) {
                                    ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                                } else {
                                    ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess)
                                },
                            ),
                    )
                }
            }
        }
    }
}
