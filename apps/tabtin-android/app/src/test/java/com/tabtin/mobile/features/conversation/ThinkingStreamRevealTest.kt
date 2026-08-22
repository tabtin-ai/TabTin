package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ThinkingStreamRevealTest {
    @Test
    fun `previewTail keeps short text intact`() {
        assertEquals("hello", ThinkingStreamReveal.previewTail("hello", maxCharacters = 10))
    }

    @Test
    fun `previewTail takes last budget characters`() {
        val long = "a".repeat(1000)
        val tail = ThinkingStreamReveal.previewTail(long, maxCharacters = 720)
        assertEquals(720, tail.length)
        assertTrue(long.endsWith(tail))
    }
}
