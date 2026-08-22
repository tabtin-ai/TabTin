package com.tabtin.mobile.ui.components

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.delay

private const val INDICATOR_SIZE_DP: Float = 72f

internal fun brandedRefreshIndicatorOffsetDp(
    isRefreshing: Boolean,
    pullProgress: Float,
): Float = if (isRefreshing) {
    0f
} else {
    -INDICATOR_SIZE_DP + INDICATOR_SIZE_DP * pullProgress.coerceIn(0f, 1f)
}

/**
 * TabTin 品牌下拉刷新容器。
 *
 * 手势、阈值和刷新请求仍由 Material3 管理；这里只替换视觉反馈，避免页面各自实现
 * nested scroll。刷新完成后让内容自然回弹。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun BrandedPullToRefreshBox(
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    val state = rememberPullToRefreshState()
    var visualRefreshing by remember { mutableStateOf(false) }
    var refreshObserved by remember { mutableStateOf(false) }

    LaunchedEffect(isRefreshing, visualRefreshing) {
        if (isRefreshing) {
            refreshObserved = true
            visualRefreshing = true
        } else if (visualRefreshing) {
            if (!refreshObserved) delay(150)
            if (isRefreshing) return@LaunchedEffect
            visualRefreshing = false
            refreshObserved = false
        }
    }

    PullToRefreshBox(
        isRefreshing = visualRefreshing,
        onRefresh = {
            visualRefreshing = true
            onRefresh()
        },
        modifier = modifier,
        state = state,
        indicator = {
            val progress = state.distanceFraction.coerceIn(0f, 1.25f)
            val offset = brandedRefreshIndicatorOffsetDp(
                isRefreshing = visualRefreshing,
                pullProgress = progress,
            ).dp
            BrandedRefreshIndicator(
                pullProgress = progress,
                isRefreshing = visualRefreshing,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .offset(y = offset),
            )
        },
        content = content,
    )
}

@Composable
private fun BrandedRefreshIndicator(
    pullProgress: Float,
    isRefreshing: Boolean,
    modifier: Modifier = Modifier,
) {
    val ink = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    val paper = ttColor(TTColors.Background, TTColors.Dark.Background)
    val context = LocalContext.current
    val reduceMotion = remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    val rotation = remember { Animatable(0f) }
    LaunchedEffect(isRefreshing, reduceMotion) {
        if (!isRefreshing || reduceMotion) {
            rotation.snapTo(0f)
            return@LaunchedEffect
        }
        var nextTurn = 1f
        while (true) {
            rotation.animateTo(
                targetValue = nextTurn,
                animationSpec = tween(
                    durationMillis = 930,
                    easing = Easing { fraction ->
                        1f - (1f - fraction) * (1f - fraction) * (1f - fraction) * (1f - fraction)
                    },
                ),
            )
            nextTurn += 1f
        }
    }
    val rotationProgress = rotation.value
    val rotationPhase = rotationProgress % 1f
    val visibleProgress = pullProgress.coerceIn(0f, 1f)

    Canvas(modifier = modifier.size(INDICATOR_SIZE_DP.dp)) {
        val unit = size.minDimension / INDICATOR_SIZE_DP
        fun point(x: Float, y: Float): Offset = Offset(x * unit, y * unit)

        drawCircle(color = paper, radius = 35f * unit, center = point(36f, 36f))
        drawCircle(
            color = ink.copy(alpha = 0.18f * visibleProgress),
            radius = 31f * unit,
            center = point(36f, 36f),
            style = Stroke(width = 1.2f * unit),
        )
        drawArc(
            color = ink.copy(alpha = 0.92f * visibleProgress),
            startAngle = -90f,
            sweepAngle = 360f * visibleProgress,
            useCenter = false,
            topLeft = point(12f, 12f),
            size = Size(48f * unit, 48f * unit),
            style = Stroke(width = 2f * unit, cap = StrokeCap.Round),
        )
        drawCircle(
            color = ink.copy(alpha = 0.34f * visibleProgress),
            radius = 17f * unit,
            center = point(36f, 36f),
            style = Stroke(
                width = 1.2f * unit,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(3f * unit, 4f * unit)),
            ),
        )

        if (isRefreshing) {
            rotate(degrees = 360f * rotationProgress, pivot = point(36f, 36f)) {
                drawArc(
                    color = ink,
                    startAngle = -90f,
                    sweepAngle = 112f,
                    useCenter = false,
                    topLeft = point(8f, 8f),
                    size = Size(56f * unit, 56f * unit),
                    style = Stroke(width = 6f * unit, cap = StrokeCap.Butt),
                )
            }
        }

        val tinAlpha = if (isRefreshing) 1f else (0.3f * visibleProgress)
        drawRoundRect(
            color = paper,
            topLeft = point(24.6f, 30.4f),
            size = Size(23.8f * unit, 14.3f * unit),
            cornerRadius = CornerRadius(5.2f * unit),
        )
        drawRoundRect(
            color = ink.copy(alpha = tinAlpha),
            topLeft = point(24.6f, 30.4f),
            size = Size(23.8f * unit, 14.3f * unit),
            cornerRadius = CornerRadius(5.2f * unit),
            style = Stroke(width = 2f * unit),
        )
        drawLine(
            color = ink.copy(alpha = tinAlpha),
            start = point(36.5f, 30.4f),
            end = point(36.5f, 26.5f),
            strokeWidth = 2f * unit,
            cap = StrokeCap.Round,
        )
        drawCircle(color = ink.copy(alpha = tinAlpha), radius = 2.2f * unit, center = point(36.5f, 24.8f))
        val eyeScale = if (isRefreshing && rotationPhase in 0.62f..0.76f) {
            maxOf(0.08f, kotlin.math.abs(rotationPhase - 0.69f) / 0.07f)
        } else {
            1f
        }
        for (eyeX in listOf(32.5f, 40.5f)) {
            drawOval(
                color = ink.copy(alpha = tinAlpha),
                topLeft = point(eyeX - 2f, 37.6f - 2f * eyeScale),
                size = Size(4f * unit, 4f * eyeScale * unit),
            )
        }
    }
}
