package com.tabtin.mobile.features.doc.editor.core

import android.app.Application
import android.graphics.Color
import android.os.Parcel
import android.text.Annotation
import android.text.Spanned
import android.text.SpannableStringBuilder
import android.text.TextUtils
import android.text.style.BackgroundColorSpan
import com.tabtin.mobile.features.doc.editor.holders.extractMarksFromSpannable
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class DocMarkupRendererTest {

    private data class SimpleMarkup(
        override val body: String,
        override val marks: List<TabDocMarkup.Mark>,
    ) : TabDocMarkup

    private fun canonicalLinkMark(
        from: Int,
        to: Int,
        url: String,
        target: String,
    ): TabDocMarkup.Mark.Link {
        val constructor = TabDocMarkup.Mark.Link::class.java.declaredConstructors
            .singleOrNull { it.parameterTypes.size == 4 }
        assertNotNull("Link mark must model its canonical target", constructor)
        return constructor!!.newInstance(from, to, url, target) as TabDocMarkup.Mark.Link
    }

    private fun linkTarget(mark: TabDocMarkup.Mark.Link): String? {
        val getter = mark.javaClass.methods.singleOrNull {
            it.name == "getTarget" && it.parameterCount == 0
        }
        assertNotNull("Recovered Link mark must expose its preserved target", getter)
        return getter!!.invoke(mark) as String?
    }

    @Test
    fun `highlight mark emits both Background span and Highlight annotation`() {
        val markup = SimpleMarkup(
            body = "hello world",
            marks = listOf(TabDocMarkup.Mark.Highlight(from = 0, to = 5, color = "#FFEB3B"))
        )
        val spannable = markup.toSpannable(textColor = Color.BLACK)

        val bgSpans = spannable.getSpans(0, spannable.length, BackgroundColorSpan::class.java)
        assertTrue("Should have at least one BackgroundColorSpan", bgSpans.isNotEmpty())

        val annotations = spannable.getSpans(0, spannable.length, Annotation::class.java)
        val highlightAnnotations = annotations.filter { it.key == DocSpan.Highlight.HIGHLIGHT_KEY }
        assertEquals("Should have exactly one Highlight annotation", 1, highlightAnnotations.size)
        assertEquals("#FFEB3B", highlightAnnotations[0].value)
    }

    @Test
    fun `highlight annotation carries the correct color value`() {
        val markup = SimpleMarkup(
            body = "colored text here",
            marks = listOf(TabDocMarkup.Mark.Highlight(from = 0, to = 7, color = "#FF5722"))
        )
        val spannable = markup.toSpannable(textColor = Color.BLACK)

        val annotations = spannable.getSpans(0, spannable.length, Annotation::class.java)
        val highlight = annotations.first { it.key == DocSpan.Highlight.HIGHLIGHT_KEY }
        assertEquals("#FF5722", highlight.value)
    }

    @Test
    fun `lowercase yellow highlight renders Android yellow and preserves exact identity`() {
        val mark = TabDocMarkup.Mark.Highlight(from = 0, to = 6, color = "yellow")
        val editable = SimpleMarkup(
            body = "yellow",
            marks = listOf(mark),
        ).toSpannable(textColor = Color.BLACK)

        val backgrounds = editable.getSpans(
            0,
            editable.length,
            BackgroundColorSpan::class.java,
        )
        assertEquals(1, backgrounds.size)
        assertEquals(Color.YELLOW, backgrounds.single().backgroundColor)

        val identities = editable.getSpans(0, editable.length, Annotation::class.java)
            .filter { it.key == DocSpan.Highlight.HIGHLIGHT_KEY }
        assertEquals(1, identities.size)
        assertEquals("yellow", identities.single().value)
        assertEquals(listOf(mark), extractMarksFromSpannable(editable))
    }

    @Test
    fun `no highlight annotation when mark list is empty`() {
        val markup = SimpleMarkup(body = "plain", marks = emptyList())
        val spannable = markup.toSpannable(textColor = Color.BLACK)

        val annotations = spannable.getSpans(0, spannable.length, Annotation::class.java)
        val highlights = annotations.filter { it.key == DocSpan.Highlight.HIGHLIGHT_KEY }
        assertTrue("No highlight annotation expected for plain text", highlights.isEmpty())
    }

    @Test
    fun `multiple highlight marks produce separate annotations`() {
        val markup = SimpleMarkup(
            body = "one two three",
            marks = listOf(
                TabDocMarkup.Mark.Highlight(from = 0, to = 3, color = "#FFEB3B"),
                TabDocMarkup.Mark.Highlight(from = 4, to = 7, color = "#FF5722"),
            )
        )
        val spannable = markup.toSpannable(textColor = Color.BLACK)

        val annotations = spannable.getSpans(0, spannable.length, Annotation::class.java)
        val highlights = annotations.filter { it.key == DocSpan.Highlight.HIGHLIGHT_KEY }
        assertEquals(2, highlights.size)

        val colors = highlights.map { it.value }.toSet()
        assertTrue(colors.contains("#FFEB3B"))
        assertTrue(colors.contains("#FF5722"))
    }

    @Test
    fun `native editable color marks recover with exact type and value`() {
        val marks = listOf(
            TabDocMarkup.Mark.TextColor(from = 0, to = 3, color = "#112233"),
            TabDocMarkup.Mark.Highlight(from = 4, to = 7, color = "#FDE68A"),
        )
        val editable = SimpleMarkup(
            body = "one two",
            marks = marks,
        ).toSpannable(textColor = Color.BLACK)

        assertEquals(marks, extractMarksFromSpannable(editable))
    }

    @Test
    fun `invalid hex color does not emit highlight annotation`() {
        val markup = SimpleMarkup(
            body = "invalid",
            marks = listOf(TabDocMarkup.Mark.Highlight(from = 0, to = 7, color = "not-a-color"))
        )
        val spannable = markup.toSpannable(textColor = Color.BLACK)

        val annotations = spannable.getSpans(0, spannable.length, Annotation::class.java)
        val highlights = annotations.filter { it.key == DocSpan.Highlight.HIGHLIGHT_KEY }
        assertTrue("Invalid color should not produce annotation", highlights.isEmpty())
    }

    @Test
    fun `mathematics metadata survives renderer to TextHolder Editable recovery`() {
        val mathematics = TabDocMarkup.Mark.Mathematics(
            from = 0,
            to = 3,
            nodeType = "math_inline",
            valueAttribute = "text",
            attrs = mapOf(
                "display" to false,
                "source" to mapOf("engine" to "latex"),
            ),
            atomId = "atom-runtime-1",
        )
        val editable = SimpleMarkup(
            body = "a+b",
            marks = listOf(mathematics),
        ).toSpannable(textColor = Color.BLACK)

        assertEquals(listOf(mathematics), extractMarksFromSpannable(editable))
    }

    @Test
    fun `mathematics metadata survives Android TextUtils parcel recovery`() {
        val mathematics = TabDocMarkup.Mark.Mathematics(
            from = 0,
            to = 3,
            nodeType = "math_inline",
            valueAttribute = "text",
            attrs = mapOf(
                "display" to false,
                "source" to mapOf("engine" to "latex"),
            ),
            atomId = "atom-runtime-parcel",
        )
        val rendered = SimpleMarkup(
            body = "a+b",
            marks = listOf(mathematics),
        ).toSpannable(textColor = Color.BLACK)
        val parcel = Parcel.obtain()

        val restoredEditable = try {
            TextUtils.writeToParcel(rendered, parcel, 0)
            parcel.setDataPosition(0)
            SpannableStringBuilder(TextUtils.CHAR_SEQUENCE_CREATOR.createFromParcel(parcel))
        } finally {
            parcel.recycle()
        }

        val mathAnnotations = restoredEditable
            .getSpans(0, restoredEditable.length, Annotation::class.java)
            .filter { it.key == DocSpan.Mathematics.MATH_KEY }
        assertEquals(1, mathAnnotations.size)
        assertEquals(Annotation::class.java, mathAnnotations.single().javaClass)
        assertEquals(listOf(mathematics), extractMarksFromSpannable(restoredEditable))
    }

    @Test
    fun `canonical link target survives renderer parcel and TextHolder recovery`() {
        val link = canonicalLinkMark(
            from = 0,
            to = 4,
            url = "https://tabtin.example.com/extra",
            target = "_blank",
        )
        val rendered = SimpleMarkup(
            body = "link",
            marks = listOf(link),
        ).toSpannable(textColor = Color.BLACK)
        val linkIdentities = rendered.getSpans(0, rendered.length, Annotation::class.java)
            .filter { it.key == "tabdoc_mark_link_v2" }
        assertEquals(1, linkIdentities.size)
        val parcel = Parcel.obtain()

        val restoredEditable = try {
            TextUtils.writeToParcel(rendered, parcel, 0)
            parcel.setDataPosition(0)
            SpannableStringBuilder(TextUtils.CHAR_SEQUENCE_CREATOR.createFromParcel(parcel))
        } finally {
            parcel.recycle()
        }

        val recovered = extractMarksFromSpannable(restoredEditable).single()
            as TabDocMarkup.Mark.Link
        assertEquals("https://tabtin.example.com/extra", recovered.url)
        assertEquals("_blank", linkTarget(recovered))
    }

    @Test
    fun `legacy href only link identity survives parcel and TextHolder recovery`() {
        val href = "https://tabtin.example.com/legacy"
        val editable = SpannableStringBuilder("legacy").apply {
            setSpan(
                Annotation(DocSpan.MarkIdentity.LINK_KEY, href),
                0,
                length,
                Spanned.SPAN_EXCLUSIVE_INCLUSIVE,
            )
        }
        val parcel = Parcel.obtain()

        val restoredEditable = try {
            TextUtils.writeToParcel(editable, parcel, 0)
            parcel.setDataPosition(0)
            SpannableStringBuilder(TextUtils.CHAR_SEQUENCE_CREATOR.createFromParcel(parcel))
        } finally {
            parcel.recycle()
        }

        assertEquals(
            listOf(TabDocMarkup.Mark.Link(from = 0, to = 6, url = href)),
            extractMarksFromSpannable(restoredEditable),
        )
    }

    @Test
    fun `legacy JSON looking hrefs remain raw across parcel and TextHolder recovery`() {
        listOf("{}", "{\"href\":\"x\"}").forEach { href ->
            val editable = SpannableStringBuilder("legacy").apply {
                setSpan(
                    Annotation(DocSpan.MarkIdentity.LINK_KEY, href),
                    0,
                    length,
                    Spanned.SPAN_EXCLUSIVE_INCLUSIVE,
                )
            }
            val parcel = Parcel.obtain()

            val restoredEditable = try {
                TextUtils.writeToParcel(editable, parcel, 0)
                parcel.setDataPosition(0)
                SpannableStringBuilder(TextUtils.CHAR_SEQUENCE_CREATOR.createFromParcel(parcel))
            } finally {
                parcel.recycle()
            }

            assertEquals(
                listOf(TabDocMarkup.Mark.Link(from = 0, to = 6, url = href)),
                extractMarksFromSpannable(restoredEditable),
            )
        }
    }

    @Test
    fun `all editable marks survive parcel recovery and setMarkup reconstruction`() {
        val marks = listOf(
            TabDocMarkup.Mark.Bold(from = 0, to = 1),
            TabDocMarkup.Mark.Italic(from = 2, to = 3),
            TabDocMarkup.Mark.Strikethrough(from = 4, to = 5),
            TabDocMarkup.Mark.Underline(from = 6, to = 7),
            TabDocMarkup.Mark.Code(from = 8, to = 9),
            TabDocMarkup.Mark.Link(from = 10, to = 11, url = "https://www.example.com/docs"),
            TabDocMarkup.Mark.TextColor(from = 12, to = 13, color = "#112233"),
            TabDocMarkup.Mark.Highlight(from = 14, to = 15, color = "#FDE68A"),
            TabDocMarkup.Mark.Subscript(from = 16, to = 17),
            TabDocMarkup.Mark.Superscript(from = 18, to = 19),
            TabDocMarkup.Mark.Mathematics(
                from = 20,
                to = 23,
                nodeType = "math_inline",
                valueAttribute = "text",
                attrs = mapOf("display" to false, "latex" to "a+b"),
                atomId = "atom-all-marks-parcel",
            ),
        )
        val markup = SimpleMarkup(
            body = "a b c d e f g h i j a+b",
            marks = marks,
        )
        val rendered = markup.toSpannable(textColor = Color.BLACK)

        assertEquals(marks, extractMarksFromSpannable(rendered))

        val parcel = Parcel.obtain()
        val restoredEditable = try {
            TextUtils.writeToParcel(rendered, parcel, 0)
            parcel.setDataPosition(0)
            SpannableStringBuilder(TextUtils.CHAR_SEQUENCE_CREATOR.createFromParcel(parcel))
        } finally {
            parcel.recycle()
        }

        assertEquals(marks, extractMarksFromSpannable(restoredEditable))

        restoredEditable.setMarkup(markup, textColor = Color.BLACK)

        assertEquals(marks, extractMarksFromSpannable(restoredEditable))
    }

    @Test
    fun `typing at mathematics end stays outside atom before and after parcel recovery`() {
        val mathematics = TabDocMarkup.Mark.Mathematics(
            from = 0,
            to = 3,
            atomId = "atom-runtime-boundary",
        )
        val editable = SimpleMarkup(
            body = "a+b",
            marks = listOf(mathematics),
        ).toSpannable(textColor = Color.BLACK)

        editable.insert(3, "!")

        val annotation = editable
            .getSpans(0, editable.length, Annotation::class.java)
            .single { it.key == DocSpan.Mathematics.MATH_KEY }
        assertEquals(Spanned.SPAN_EXCLUSIVE_EXCLUSIVE, editable.getSpanFlags(annotation))
        assertEquals(listOf(mathematics), extractMarksFromSpannable(editable))

        val parcel = Parcel.obtain()
        val restoredEditable = try {
            TextUtils.writeToParcel(editable, parcel, 0)
            parcel.setDataPosition(0)
            SpannableStringBuilder(TextUtils.CHAR_SEQUENCE_CREATOR.createFromParcel(parcel))
        } finally {
            parcel.recycle()
        }
        restoredEditable.insert(mathematics.to, "?")

        val restoredAnnotation = restoredEditable
            .getSpans(0, restoredEditable.length, Annotation::class.java)
            .single { it.key == DocSpan.Mathematics.MATH_KEY }
        assertEquals(Spanned.SPAN_EXCLUSIVE_EXCLUSIVE, restoredEditable.getSpanFlags(restoredAnnotation))
        assertEquals("a+b?!", restoredEditable.toString())
        assertEquals(listOf(mathematics), extractMarksFromSpannable(restoredEditable))
    }

    @Test
    fun `unknown mark keeps identity annotation without visual style and survives parcel`() {
        val unknown = TabDocMarkup.Mark.Unknown(
            from = 2,
            to = 6,
            type = "futureMark",
            attrs = mapOf("weight" to 9, "source" to "ai"),
        )
        val markup = SimpleMarkup(
            body = "右对齐标记旁",
            marks = listOf(unknown),
        )
        val editable = markup.toSpannable(textColor = Color.BLACK)

        val annotations = editable.getSpans(0, editable.length, Annotation::class.java)
            .filter { it.key == DocSpan.UnknownMark.KEY }
        assertEquals(1, annotations.size)
        assertEquals(Spanned.SPAN_EXCLUSIVE_EXCLUSIVE, editable.getSpanFlags(annotations.single()))
        assertEquals(2, editable.getSpanStart(annotations.single()))
        assertEquals(6, editable.getSpanEnd(annotations.single()))
        assertTrue(
            "未知 mark 不得发明高亮或其它视觉 span",
            editable.getSpans(0, editable.length, BackgroundColorSpan::class.java).isEmpty(),
        )
        val recoveredBeforeEdit = extractMarksFromSpannable(editable)
            .filterIsInstance<TabDocMarkup.Mark.Unknown>()
        assertEquals(1, recoveredBeforeEdit.size)
        assertEquals("futureMark", recoveredBeforeEdit.single().type)
        assertEquals(2, recoveredBeforeEdit.single().from)
        assertEquals(6, recoveredBeforeEdit.single().to)
        assertEquals("ai", recoveredBeforeEdit.single().attrs["source"])
        assertEquals(9L, (recoveredBeforeEdit.single().attrs["weight"] as Number).toLong())

        editable.insert(0, "前")
        editable.insert(editable.length, "后")
        val afterAdjacent = extractMarksFromSpannable(editable).filterIsInstance<TabDocMarkup.Mark.Unknown>()
        assertEquals(1, afterAdjacent.size)
        assertEquals("futureMark", afterAdjacent.single().type)
        assertEquals("ai", afterAdjacent.single().attrs["source"])
        assertEquals(9L, (afterAdjacent.single().attrs["weight"] as Number).toLong())

        val parcel = Parcel.obtain()
        val restored = try {
            TextUtils.writeToParcel(editable, parcel, 0)
            parcel.setDataPosition(0)
            SpannableStringBuilder(TextUtils.CHAR_SEQUENCE_CREATOR.createFromParcel(parcel))
        } finally {
            parcel.recycle()
        }
        val recovered = extractMarksFromSpannable(restored).filterIsInstance<TabDocMarkup.Mark.Unknown>().single()
        assertEquals("futureMark", recovered.type)
        assertEquals("ai", recovered.attrs["source"])
    }
}
