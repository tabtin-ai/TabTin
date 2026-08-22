package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamingTailRevealPolicyTest {
    @Test
    fun `growing tail fades only the new suffix`() {
        val reveal = StreamingTailRevealPolicy.reveal(
            previousTail = "hello",
            nextTail = "hello world",
        )

        assertEquals("hello", reveal.prefix)
        assertEquals(" world", reveal.incoming)
        assertTrue(reveal.shouldAnimateIncoming)
    }

    @Test
    fun `rewritten tail does not animate`() {
        val reveal = StreamingTailRevealPolicy.reveal(
            previousTail = "hello",
            nextTail = "other",
        )

        assertEquals("other", reveal.prefix)
        assertEquals("", reveal.incoming)
        assertFalse(reveal.shouldAnimateIncoming)
    }

    @Test
    fun `first tail chunk treats empty previous as a prefix`() {
        val reveal = StreamingTailRevealPolicy.reveal(
            previousTail = "",
            nextTail = "hi",
        )

        assertEquals("", reveal.prefix)
        assertEquals("hi", reveal.incoming)
        assertTrue(reveal.shouldAnimateIncoming)
    }

    @Test
    fun `unchanged tail has nothing incoming`() {
        val reveal = StreamingTailRevealPolicy.reveal(
            previousTail = "hello",
            nextTail = "hello",
        )

        assertEquals("hello", reveal.prefix)
        assertEquals("", reveal.incoming)
        assertFalse(reveal.shouldAnimateIncoming)
    }
}
