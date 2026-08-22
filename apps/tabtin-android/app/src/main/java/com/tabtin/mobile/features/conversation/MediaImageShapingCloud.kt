package com.tabtin.mobile.features.conversation

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/** 逻辑空间（边长 [MediaImageShapingCloud.PRESET_SIZE]）中的一颗点。 */
internal data class ShapingDot(val x: Float, val y: Float, val r: Float)

/**
 * 「图正在成形」点云：24 个点沿闭合曲线均匀分布，曲线在 圆 → 三角 → 方 之间循环变形。
 *
 * 移植自 `packages/agent-orb/src/painter.ts` 的 `drawMorph` + `shaping` 预设（64 档）。
 * 常量、采样数、弧长重采样顺序都逐字对齐上游——差一个数就不是同一个形，
 * 一致性由 `MediaImageShapingCloudTest` 对着跨端 fixture 钉死。
 *
 * 刻意不依赖 Compose / Android framework，这样纯数学能进 JVM 单测。
 */
internal object MediaImageShapingCloud {
    /** 上游预设的逻辑边长；调用方按实际 dp 自行缩放。 */
    const val PRESET_SIZE = 64f

    /** 相位走时倍率，与 `shaping` 预设一致：调用方传入的 t 应已是「秒 × SPEED」。 */
    const val SPEED = 2.405f

    private const val ICON_D = 0.702
    private const val R_DOT = 0.008295
    private const val R_MIN = 0.25
    private const val SPREAD = 1.45
    private const val SIZE = 64.0

    private const val HOLD = 1.4
    private const val MORPH_TIME = 0.9
    private const val CYCLE = HOLD + MORPH_TIME
    private const val SAMPLES = 160

    private val SHAPES: List<(Double) -> DoubleArray> = listOf(
        { u ->
            val a = -PI / 2 + u * 2 * PI
            doubleArrayOf(cos(a) * 0.24, sin(a) * 0.24)
        },
        closedPolyline(
            arrayOf(
                doubleArrayOf(0.0, -0.26),
                doubleArrayOf(0.24, 0.16),
                doubleArrayOf(-0.24, 0.16),
            ),
        ),
        closedPolyline(
            arrayOf(
                doubleArrayOf(0.0, -0.2),
                doubleArrayOf(0.2, -0.2),
                doubleArrayOf(0.2, 0.2),
                doubleArrayOf(-0.2, 0.2),
                doubleArrayOf(-0.2, -0.2),
            ),
        ),
    )

    /**
     * 给定相位算出一帧点云。
     *
     * 全程用 Double 算、最后一步才落 Float：坐标要乘 [SIZE] 放大 64 倍，
     * Float 中间量的误差会跟着放大，容易跑出 fixture 容差。
     */
    fun dots(t: Float): List<ShapingDot> {
        val shapeCount = SHAPES.size
        val period = CYCLE * shapeCount
        // Kotlin 的 % 对负数返回负值，而上游读的是循环相位——必须归一到 [0, period)
        var c = t.toDouble() % period
        if (c < 0) c += period
        val idx = floor(c / CYCLE).toInt().coerceIn(0, shapeCount - 1)
        val local = c - idx * CYCLE
        val blend = if (local > HOLD) smoothstep((local - HOLD) / MORPH_TIME) else 0.0

        val from = SHAPES[idx]
        val to = SHAPES[(idx + 1) % shapeCount]
        val pathX = DoubleArray(SAMPLES)
        val pathY = DoubleArray(SAMPLES)
        for (i in 0 until SAMPLES) {
            val u = i.toDouble() / SAMPLES
            val a = from(u)
            val b = to(u)
            pathX[i] = (a[0] + (b[0] - a[0]) * blend) * SPREAD
            pathY[i] = (a[1] + (b[1] - a[1]) * blend) * SPREAD
        }

        val seg = DoubleArray(SAMPLES)
        var total = 0.0
        for (i in 0 until SAMPLES) {
            val j = (i + 1) % SAMPLES
            val d = hypot(pathX[j] - pathX[i], pathY[j] - pathY[i])
            seg[i] = d
            total += d
        }

        val count = max(6, (34 * ICON_D).roundToInt())
        val rDotEff = R_DOT * 1.35 * SPREAD
        val breath = 1 + 0.02 * sin(local * 3.1)
        val half = SIZE / 2
        // 两层钳制都保留：0.35 是上游绘制器的下限，R_MIN 是预设再抬一档，缺一处就跟基准对不上
        val radius = max(R_MIN, max(0.35, rDotEff * SIZE)).toFloat()

        val out = ArrayList<ShapingDot>(count)
        // cursor / walked 在整个循环里连续推进——这是沿弧长前进的游标，每点重置会退化成等参数采样
        var cursor = 0
        var walked = 0.0
        for (i in 0 until count) {
            val want = (i.toDouble() / count) * total
            while (walked + seg[cursor] < want && cursor < SAMPLES - 1) {
                walked += seg[cursor]
                cursor++
            }
            val j = (cursor + 1) % SAMPLES
            val f = if (seg[cursor] != 0.0) min(1.0, (want - walked) / seg[cursor]) else 0.0
            val px = (pathX[cursor] + (pathX[j] - pathX[cursor]) * f) * breath
            val py = (pathY[cursor] + (pathY[j] - pathY[cursor]) * f) * breath
            out.add(
                ShapingDot(
                    x = (half + px * SIZE).toFloat(),
                    y = (half + py * SIZE).toFloat(),
                    r = radius,
                ),
            )
        }
        return out
    }

    private fun smoothstep(x: Double): Double = x * x * (3 - 2 * x)

    /** 把闭合折线包成「按弧长采样」的函数，保证变形过程中点距始终均匀。 */
    private fun closedPolyline(pts: Array<DoubleArray>): (Double) -> DoubleArray {
        val n = pts.size
        val seg = DoubleArray(n)
        var total = 0.0
        for (i in 0 until n) {
            val a = pts[i]
            val b = pts[(i + 1) % n]
            val d = hypot(b[0] - a[0], b[1] - a[1])
            seg[i] = d
            total += d
        }
        return { u ->
            var want = u * total
            var i = 0
            while (want > seg[i] && i < n - 1) {
                want -= seg[i]
                i++
            }
            val a = pts[i]
            val b = pts[(i + 1) % n]
            val f = if (seg[i] != 0.0) min(1.0, want / seg[i]) else 0.0
            doubleArrayOf(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
        }
    }
}
