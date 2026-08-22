package com.tabtin.mobile.features.doc.editor

import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.style.*
import com.tabtin.mobile.features.doc.model.InlineMark
import com.tabtin.mobile.features.doc.model.InlineSpan
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import androidx.test.ext.junit.runners.AndroidJUnit4

@RunWith(AndroidJUnit4::class)
class SpanConverterTest {

    @Test
    fun `empty span roundtrips`() {
        val input = listOf(InlineSpan(""))
        val editable = SpanConverter.toEditable(input)
        assertEquals("", editable.toString())
        val result = SpanConverter.toInlineSpans(editable)
        assertEquals(1, result.size)
        assertEquals("", result[0].text)
    }

    @Test
    fun `plain text roundtrips`() {
        val input = listOf(InlineSpan("Hello world"))
        val editable = SpanConverter.toEditable(input)
        assertEquals("Hello world", editable.toString())
        val result = SpanConverter.toInlineSpans(editable)
        assertEquals(1, result.size)
        assertEquals("Hello world", result[0].text)
        assertTrue(result[0].marks.isEmpty())
    }

    @Test
    fun `bold roundtrips`() {
        val input = listOf(InlineSpan("bold", listOf(InlineMark.Bold)))
        val editable = SpanConverter.toEditable(input)
        val styleSpans = editable.getSpans(0, editable.length, StyleSpan::class.java)
        assertTrue(styleSpans.any { it.style == Typeface.BOLD })
        val result = SpanConverter.toInlineSpans(editable)
        assertEquals(1, result.size)
        assertTrue(result[0].marks.contains(InlineMark.Bold))
    }

    @Test
    fun `mixed spans roundtrip`() {
        val input = listOf(
            InlineSpan("Hello "),
            InlineSpan("bold", listOf(InlineMark.Bold)),
            InlineSpan(" world"),
        )
        val editable = SpanConverter.toEditable(input)
        assertEquals("Hello bold world", editable.toString())
        val result = SpanConverter.toInlineSpans(editable)
        assertEquals(3, result.size)
        assertEquals("Hello ", result[0].text)
        assertTrue(result[0].marks.isEmpty())
        assertEquals("bold", result[1].text)
        assertTrue(result[1].marks.contains(InlineMark.Bold))
        assertEquals(" world", result[2].text)
        assertTrue(result[2].marks.isEmpty())
    }

    @Test
    fun `strike roundtrips`() {
        val input = listOf(InlineSpan("strike", listOf(InlineMark.Strike)))
        val editable = SpanConverter.toEditable(input)
        val result = SpanConverter.toInlineSpans(editable)
        assertTrue(result[0].marks.contains(InlineMark.Strike))
    }

    @Test
    fun `link roundtrips`() {
        val input = listOf(InlineSpan("link", listOf(InlineMark.Link("https://x.com"))))
        val editable = SpanConverter.toEditable(input)
        val urlSpans = editable.getSpans(0, editable.length, URLSpan::class.java)
        assertEquals(1, urlSpans.size)
        assertEquals("https://x.com", urlSpans[0].url)
        val result = SpanConverter.toInlineSpans(editable)
        val linkMark = result[0].marks.filterIsInstance<InlineMark.Link>().first()
        assertEquals("https://x.com", linkMark.href)
    }

    @Test
    fun `splitEditableAt splits correctly`() {
        val input = listOf(
            InlineSpan("Hello "),
            InlineSpan("bold", listOf(InlineMark.Bold)),
        )
        val editable = SpanConverter.toEditable(input)
        val (before, after) = SpanConverter.splitEditableAt(editable, 8)
        assertEquals("Hello bo", before.joinToString("") { it.text })
        assertEquals("ld", after.joinToString("") { it.text })
        assertTrue(after[0].marks.contains(InlineMark.Bold))
    }

    @Test
    fun `adjacent same-mark spans merge`() {
        val input = listOf(
            InlineSpan("he", listOf(InlineMark.Bold)),
            InlineSpan("llo", listOf(InlineMark.Bold)),
        )
        val editable = SpanConverter.toEditable(input)
        val result = SpanConverter.toInlineSpans(editable)
        assertEquals(1, result.size)
        assertEquals("hello", result[0].text)
        assertTrue(result[0].marks.contains(InlineMark.Bold))
    }
}
