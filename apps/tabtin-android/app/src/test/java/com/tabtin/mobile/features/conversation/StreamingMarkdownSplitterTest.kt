package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamingMarkdownSplitterTest {
    /** 与 Electron 测例一致：length≥200 且 last `\n\n` 索引≥100 才会切 stable。 */
    private val head = "H".repeat(120)

    @Test
    fun `keeps completed blocks in stable and only grows tail`() {
        val a = StreamingMarkdownSplitter.split(
            "$head\n\nPara two is streaming ${"t".repeat(60)}",
        )
        val b = StreamingMarkdownSplitter.split(
            "$head\n\nPara two is streaming ${"t".repeat(60)} further",
        )
        assertTrue(b.stable.startsWith(a.stable) || b.stable == a.stable)
        assertEquals(
            "$head\n\nPara two is streaming ${"t".repeat(60)} further",
            b.stable + b.tail,
        )
        assertTrue(a.stable.isNotEmpty())
        assertEquals(a.stable, b.stable)
    }

    @Test
    fun `moves unclosed fence entirely into tail`() {
        val src = "$head\n\n```ts\nconst x = 1\n${"z".repeat(80)}"
        val (stable, tail) = StreamingMarkdownSplitter.split(src)
        assertFalse(stable.contains("```"))
        assertTrue(tail.contains("```ts"))
        assertEquals(src, stable + tail)
    }

    @Test
    fun `short content stays entirely in tail`() {
        val src = "hello world"
        val (stable, tail) = StreamingMarkdownSplitter.split(src)
        assertEquals("", stable)
        assertEquals(src, tail)
    }

    @Test
    fun `closed fence can enter stable`() {
        val body = "line\n".repeat(40)
        val src = "$head\n\n```ts\n$body```\n\nAfter"
        val (stable, tail) = StreamingMarkdownSplitter.split(src)
        assertTrue(stable.contains("```ts"))
        assertTrue(stable.contains("```\n"))
        assertEquals(src, stable + tail)
        assertTrue(tail.isNotEmpty() || stable.endsWith("After"))
    }
}
