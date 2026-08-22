package com.tabtin.mobile.features.conversation

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 跨端点云一致性：Android 的 [MediaImageShapingCloud] 必须和 Electron / iOS 画同一个形。
 *
 * 基准来自 `packages/agent-orb/fixtures/morph-shaping-64.json`（本目录是只读拷贝）。
 * painter 或 shaping 预设改动后重新生成，三处拷贝同步：
 *   node packages/agent-orb/scripts/emit-morph-fixture.mjs
 */
class MediaImageShapingCloudTest {
    // JVM 单测里 org.json 是 stub（同 MediaImageGenerateResultParserTest 的取舍），只能用 kotlinx。
    @Serializable
    private data class Fixture(
        val presetSize: Int,
        val speed: Float,
        val dotCount: Int,
        val frames: List<Frame>,
    )

    @Serializable
    private data class Frame(val t: Float, val tScaled: Float, val dots: List<Dot>)

    @Serializable
    private data class Dot(val x: Float, val y: Float, val r: Float)

    private val fixture: Fixture by lazy {
        val text = checkNotNull(
            javaClass.classLoader?.getResourceAsStream("morph-shaping-64.json"),
        ) { "缺少 morph-shaping-64.json" }.bufferedReader().use { it.readText() }
        JSON.decodeFromString(Fixture.serializer(), text)
    }

    private companion object {
        val JSON = Json { ignoreUnknownKeys = true }
    }

    @Test
    fun `preset constants match fixture`() {
        assertEquals(fixture.presetSize.toFloat(), MediaImageShapingCloud.PRESET_SIZE, 0f)
        assertEquals(fixture.speed, MediaImageShapingCloud.SPEED, 0f)
    }

    @Test
    fun `每个采样相位的 24 个点都与跨端基准一致`() {
        // 实测最大偏差 7.6e-6（≈ 64 量级下 2 ULP），1e-3 容差留足余量
        for (frame in fixture.frames) {
            val actual = MediaImageShapingCloud.dots(frame.tScaled)
            assertEquals("t=${frame.t} 点数不符", fixture.dotCount, actual.size)
            frame.dots.forEachIndexed { i, expected ->
                assertEquals("t=${frame.t} dot[$i].x", expected.x, actual[i].x, 1e-3f)
                assertEquals("t=${frame.t} dot[$i].y", expected.y, actual[i].y, 1e-3f)
                assertEquals("t=${frame.t} dot[$i].r", expected.r, actual[i].r, 1e-3f)
            }
        }
    }

    @Test
    fun `点数在任意相位恒为 24`() {
        var t = -20f
        while (t <= 20f) {
            assertEquals("t=$t", 24, MediaImageShapingCloud.dots(t).size)
            t += 0.137f
        }
    }

    @Test
    fun `负相位与极大相位不崩且无 NaN`() {
        for (t in listOf(-1f, -6.9f, -1234.5f, 1e6f, 1e12f, Float.MAX_VALUE)) {
            val dots = MediaImageShapingCloud.dots(t)
            assertEquals(24, dots.size)
            for (d in dots) {
                assertFalse("t=$t 出现 NaN", d.x.isNaN() || d.y.isNaN() || d.r.isNaN())
                assertTrue("t=$t 出现非有限值", d.x.isFinite() && d.y.isFinite() && d.r.isFinite())
            }
        }
    }

    @Test
    fun `负相位与等价正相位同帧`() {
        // 一整轮是 CYCLE(2.3) × 3 = 6.9，取模后应完全重合
        val negative = MediaImageShapingCloud.dots(-6.9f + 1.443f)
        val positive = MediaImageShapingCloud.dots(1.443f)
        negative.forEachIndexed { i, d ->
            assertEquals(positive[i].x, d.x, 1e-3f)
            assertEquals(positive[i].y, d.y, 1e-3f)
        }
    }
}
