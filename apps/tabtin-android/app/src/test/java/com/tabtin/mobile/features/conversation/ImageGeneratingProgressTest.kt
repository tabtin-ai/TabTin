package com.tabtin.mobile.features.conversation

import kotlin.math.exp
import kotlin.math.min
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageGeneratingProgressTest {
    @Test
    fun elapsedZero_nearZero() {
        val value = ImageGeneratingProgress.compute(elapsedMs = 0, tauMs = 18_000, done = false)
        assertTrue(value >= 0f)
        assertTrue(value < 5f)
    }

    @Test
    fun elapsedEqualsTau_capsBelow93() {
        val value = ImageGeneratingProgress.compute(elapsedMs = 18_000, tauMs = 18_000, done = false)
        assertTrue(value < 93f)
    }

    @Test
    fun longElapsed_capsAt92() {
        assertEquals(
            92f,
            ImageGeneratingProgress.compute(elapsedMs = 600_000, tauMs = 18_000, done = false),
            0.0001f,
        )
    }

    @Test
    fun done_is100() {
        assertEquals(
            100f,
            ImageGeneratingProgress.compute(elapsedMs = 5_000, tauMs = 18_000, done = true),
            0.0001f,
        )
    }

    @Test
    fun defaultTau_matchesExplicit() {
        assertEquals(18_000L, ImageGeneratingProgress.DEFAULT_TAU_MS)
        assertEquals(
            ImageGeneratingProgress.compute(elapsedMs = 18_000, done = false),
            ImageGeneratingProgress.compute(elapsedMs = 18_000, tauMs = 18_000, done = false),
            0.0001f,
        )
    }

    @Test
    fun formula_continuous() {
        val elapsedMs = 5_000L
        val tauMs = 18_000L
        val expected = min(92.0, 100.0 * (1.0 - exp(-elapsedMs.toDouble() / tauMs))).toFloat()
        assertEquals(
            expected,
            ImageGeneratingProgress.compute(elapsedMs = elapsedMs, tauMs = tauMs, done = false),
            0.0001f,
        )
    }

    @Test
    fun continuousAdvance_withoutIntegerSteps() {
        val a = ImageGeneratingProgress.compute(elapsedMs = 1_000, tauMs = 18_000, done = false)
        val b = ImageGeneratingProgress.compute(elapsedMs = 1_016, tauMs = 18_000, done = false)
        assertTrue(b > a)
        assertTrue(b - a < 1f)
    }
}
