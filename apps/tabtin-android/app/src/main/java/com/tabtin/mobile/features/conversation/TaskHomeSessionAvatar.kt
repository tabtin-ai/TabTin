package com.tabtin.mobile.features.conversation

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PriorityHigh
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 任务行头像：会话所属 Agent 的头像，运行态画在头像四周。对齐 iOS `TaskHomeSessionAvatar`。
 *
 * 圆里放的不是分类图标：任务是**某个 Agent** 在替你跑，头像比抽象气泡更能回答
 * 「这是谁的活」。
 *
 * 信号分三层，互不打架：
 * - 光环：正在跑 = 旋转弧；暂停 = 虚线圈（Agent 自己停下，比「等你」弱一档）
 * - 右下角标：失败 / 等你确认，二选一，按紧迫度取最高
 * - 右上圆点：跑完了但你还没看
 *
 * 「已归档」刻意不上角标：归档会话只在「已归档」范围里成片出现，给每个头像都挂一个
 * 同样的标只是噪音；第二行的「已归档」文字已经说清楚了。
 */
@Composable
internal fun TaskHomeSessionAvatar(
    session: AllChatSession,
    status: TaskRowStatus,
    agentsById: Map<String, Agent> = emptyMap(),
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
) {
    val running = ttColor(TTColors.BgRunning, TTColors.Dark.BgRunning)
    val warning = ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
    val critical = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)
    val surface = MaterialTheme.colorScheme.surface
    val label = stringResource(TaskRowStatusPresentation.accessibilityTextRes(status))

    // 光环画在头像外圈，比头像大一圈；Box 尺寸取大的那个，避免被裁掉。
    val ringSize = size + 5.dp

    Box(
        modifier = modifier.size(ringSize).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        SessionAgentAvatarImage(session = session, agentsById = agentsById, size = size)

        when (status) {
            TaskRowStatus.RUNNING -> SpinningRing(size = ringSize, color = running)
            // 暂停是 Agent 自己停下，不是在等你：虚线圈，比实心信号弱一档。
            TaskRowStatus.PAUSED -> DashedRing(size = ringSize, color = warning.copy(alpha = 0.7f))
            else -> Unit
        }

        // 角标只挂一个：紧迫度高的赢。
        when (status) {
            TaskRowStatus.FAILED -> CornerBadge(
                icon = { tint -> Icon(Icons.Default.Close, null, tint = tint, modifier = Modifier.size(11.dp)) },
                background = critical,
                border = surface,
                boxSize = ringSize,
            )
            TaskRowStatus.WAITING_USER -> CornerBadge(
                icon = { tint -> Icon(Icons.Default.PriorityHigh, null, tint = tint, modifier = Modifier.size(11.dp)) },
                background = warning,
                border = surface,
                boxSize = ringSize,
            )
            else -> Unit
        }

        if (status == TaskRowStatus.DONE_UNREAD) {
            // 蓝色而非红色：红色在这一列已经是「失败」，未读只是「有新东西」。
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .size(10.dp)
                    .clip(CircleShape)
                    .background(running)
                    .border(1.5.dp, surface, CircleShape),
            )
        }
    }
}

/**
 * 运行中的旋转弧。在跑就该动——静态描边没法把「此刻正在推进」和「停在那儿」区分开。
 */
@Composable
private fun SpinningRing(size: Dp, color: Color) {
    val transition = rememberInfiniteTransition(label = "task-row-spin")
    val angle by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "task-row-spin-angle",
    )
    Canvas(modifier = Modifier.size(size)) {
        drawArc(
            color = color,
            startAngle = angle,
            sweepAngle = 108f, // 0.3 圈，与 iOS 同口径
            useCenter = false,
            style = Stroke(width = 1.5.dp.toPx(), cap = androidx.compose.ui.graphics.StrokeCap.Round),
        )
    }
}

@Composable
private fun DashedRing(size: Dp, color: Color) {
    Canvas(modifier = Modifier.size(size)) {
        drawArc(
            color = color,
            startAngle = 0f,
            sweepAngle = 360f,
            useCenter = false,
            style = Stroke(
                width = 1.5.dp.toPx(),
                pathEffect = PathEffect.dashPathEffect(
                    floatArrayOf(4.dp.toPx(), 3.dp.toPx()),
                    0f,
                ),
            ),
            topLeft = Offset.Zero,
            size = Size(this.size.width, this.size.height),
        )
    }
}

@Composable
private fun androidx.compose.foundation.layout.BoxScope.CornerBadge(
    icon: @Composable (Color) -> Unit,
    background: Color,
    border: Color,
    boxSize: Dp,
) {
    Box(
        modifier = Modifier
            .align(Alignment.BottomEnd)
            .size(18.dp)
            .clip(CircleShape)
            .background(background)
            .border(1.5.dp, border, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        icon(Color.White)
    }
}
