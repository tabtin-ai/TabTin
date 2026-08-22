package com.tabtin.mobile.ui.splash

import android.animation.ValueAnimator
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * 系统 SplashScreen 后的原生接力层。
 *
 * 与 iOS / 已通过 HTML 样片共用同一时间参数；不创建 WebView，不依赖网络，底下的
 * AppNavigation 可并行完成鉴权与数据恢复。
 */
@Composable
public fun LaunchSplashOverlay(
    modifier: Modifier = Modifier,
) {
    val isDark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val paper = if (isDark) Color.Black else Color.White
    val ink = if (isDark) Color.White else Color(0xFF20201C)
    val reduceMotion = !ValueAnimator.areAnimatorsEnabled()
    val elapsed = remember { mutableFloatStateOf(if (reduceMotion) 2.5f else 0f) }
    var isReady by remember { mutableStateOf(reduceMotion) }

    LaunchedEffect(reduceMotion) {
        if (reduceMotion) return@LaunchedEffect
        val startedAt = withFrameNanos { it }
        do {
            val current = withFrameNanos { frame ->
                ((frame - startedAt) / 1_000_000_000f).coerceAtMost(3.72f)
            }
            elapsed.floatValue = current
            if (!isReady && current >= 2.86f) isReady = true
        } while (current < 3.72f)
    }

    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            .background(paper)
            .semantics { contentDescription = "正在准备你的工作现场" },
    ) {
        val isPad = maxWidth >= 600.dp
        val shortSide = min(maxWidth.value, maxHeight.value)
        val visualSize = if (isPad) {
            min(shortSide * if (maxWidth > maxHeight) 0.48f else 0.52f, 500f).dp
        } else {
            min((maxWidth.value * 0.74f).coerceAtLeast(252f), 332f).dp
        }
        LaunchSplashArtwork(
            elapsed = elapsed,
            ink = ink,
            modifier = Modifier
                .align(Alignment.Center)
                .size(visualSize)
                .graphicsLayer {
                    alpha = ramp(elapsed.floatValue, 0f, 0.28f) *
                        rampDown(elapsed.floatValue, 3.74f, 4.16f)
                },
        )

        Column(
            modifier = Modifier
                .align(Alignment.Center)
                .offset(y = visualSize / 2 + if (isPad) 72.dp else 60.dp)
                .graphicsLayer {
                    alpha = ramp(elapsed.floatValue, 0.62f, 1.06f) *
                        rampDown(elapsed.floatValue, 3.82f, 4.14f)
                },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = if (isReady) "工作现场已就绪" else "正在准备你的工作现场",
                color = ink,
                fontSize = if (isPad) 20.sp else 16.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                repeat(3) { index ->
                    if (index > 0) Spacer(Modifier.width(6.dp))
                    Box(
                        Modifier
                            .size(4.dp)
                            .graphicsLayer { alpha = dotOpacity(elapsed.floatValue, index) }
                            .background(ink, CircleShape),
                    )
                }
            }
        }
    }
}

@Composable
private fun LaunchSplashArtwork(
    elapsed: State<Float>,
    ink: Color,
    modifier: Modifier,
) {
    BoxWithConstraints(modifier, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val current = elapsed.value
            val unit = size.width / 360f
            val center = center
            drawCircle(ink.copy(alpha = 0.16f), radius = 154f * unit, center = center, style = Stroke(1.5f * unit))
            drawCircle(ink, radius = 119f * unit, center = center, style = Stroke(3.2f * unit))
            drawCircle(
                ink.copy(alpha = 0.34f),
                radius = 84f * unit,
                center = center,
                style = Stroke(
                    width = 1.5f * unit,
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(5f * unit, 6f * unit)),
                ),
            )

            val spinnerOpacity = ramp(current, 1.76f, 2.15f) * rampDown(current, 2.78f, 3.6f)
            if (spinnerOpacity > 0f) {
                val diameter = 308f * unit
                drawArc(
                    color = ink.copy(alpha = spinnerOpacity),
                    startAngle = spinnerRotation(current) - 90f,
                    sweepAngle = 90f,
                    useCenter = false,
                    topLeft = androidx.compose.ui.geometry.Offset(center.x - diameter / 2, center.y - diameter / 2),
                    size = androidx.compose.ui.geometry.Size(diameter, diameter),
                    style = Stroke(width = 8f * unit, cap = StrokeCap.Butt),
                )
            }
        }

        val tinContainerWidth = maxWidth * (0.37f * 108f / 68f)
        Box(
            modifier = Modifier
                .width(tinContainerWidth)
                .aspectRatio(1f)
                .graphicsLayer {
                    val current = elapsed.value
                    val enter = ramp(current, 0.26f, 1.02f)
                    val tinScale = 0.78f + enter * 0.22f
                    scaleX = tinScale
                    scaleY = tinScale
                    translationY = if (current in 1.34f..2.32f) {
                        -4f * density * sin((current - 1.34f) / 0.98f * PI.toFloat())
                    } else {
                        0f
                    }
                },
        ) {
            Image(
                painter = painterResource(com.tabtin.mobile.R.drawable.splash_tin_base),
                contentDescription = null,
                colorFilter = ColorFilter.tint(ink),
                modifier = Modifier.fillMaxSize(),
            )
            Canvas(Modifier.fillMaxSize()) {
                val eyeScaleY = blinkScale(elapsed.value)
                val unit = size.width / 108f
                listOf(44f, 64f).forEach { eyeX ->
                    withTransform({
                        translate(left = eyeX * unit, top = 69.5f * unit)
                        scale(scaleX = 1f, scaleY = eyeScaleY)
                    }) {
                        drawCircle(ink, radius = 5f * unit, center = androidx.compose.ui.geometry.Offset.Zero)
                    }
                }
            }
        }
    }
}

private fun ramp(value: Float, start: Float, end: Float): Float =
    if (end <= start) {
        if (value >= end) 1f else 0f
    } else {
        ((value - start) / (end - start)).coerceIn(0f, 1f)
    }

private fun rampDown(value: Float, start: Float, end: Float): Float = 1f - ramp(value, start, end)

private fun spinnerRotation(elapsed: Float): Float = if (elapsed <= 2.78f) {
    220f * easeInOutCubic(ramp(elapsed, 1.76f, 2.78f))
} else {
    220f + 200f * easeOutQuart(ramp(elapsed, 2.78f, 3.6f))
}

private fun easeInOutCubic(progress: Float): Float = if (progress < 0.5f) {
    4f * progress * progress * progress
} else {
    1f - (-2f * progress + 2f).pow(3) / 2f
}

private fun easeOutQuart(progress: Float): Float = 1f - (1f - progress).pow(4)

private fun blinkScale(elapsed: Float): Float {
    if (elapsed !in 1.98f..2.16f) return 1f
    val distance = abs(elapsed - 2.07f) / 0.09f
    return 0.08f + min(distance, 1f) * 0.92f
}

private fun dotOpacity(elapsed: Float, index: Int): Float {
    val raw = elapsed - 0.82f - index * 0.11f
    if (raw < 0f) return 0.2f
    val local = raw % 0.66f
    val pulse = 1f - abs(local / 0.66f * 2f - 1f)
    return 0.2f + pulse * 0.6f
}

private fun Color.luminance(): Float =
    0.2126f * red + 0.7152f * green + 0.0722f * blue
