package com.tabtin.mobile.features.doc.editor.core

import android.app.Application
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import com.tabtin.mobile.features.doc.model.ProseMirrorParser
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class DocFormulaRenderingTest {

    @Test
    fun `katex page uses desktop throwOnError false and version`() {
        val page = KatexFormulaHtml.page(textColorHex = "#111111", fontSizePx = 16f)
        assertTrue(page.contains("throwOnError: false"))
        assertTrue(page.contains("katex.min.js"))
        assertTrue(page.contains("katex.min.css"))
        assertEquals("0.16.28", KatexFormulaHtml.KATEX_VERSION)
        assertTrue(KatexFormulaHtml.looksRendered("<span class=\"katex\">E</span>"))
        assertFalse(KatexFormulaHtml.looksRendered("mathematicsBlock"))
    }

    @Test
    fun `rendered drawable covers the atom and identity survives`() {
        val mathematics = TabDocMarkup.Mark.Mathematics(
            from = 5,
            to = 13,
            attrs = mapOf("latex" to "E = mc^2", "display" to false),
            atomId = "atom-e",
        )
        val markup = object : TabDocMarkup {
            override val body: String = "质能方程 E = mc^2。"
            override val marks: List<TabDocMarkup.Mark> = listOf(mathematics)
        }
        val rendered = markup.toSpannable(
            textColor = Color.BLACK,
            formulaProvider = {
                ColorDrawable(Color.BLUE).apply { setBounds(0, 0, 24, 16) }
            },
        )
        val drawables = rendered.getSpans(0, rendered.length, DocSpan.MathematicsDrawable::class.java)
        assertEquals(1, drawables.size)
        assertEquals(5, rendered.getSpanStart(drawables.single()))
        assertEquals(13, rendered.getSpanEnd(drawables.single()))
        assertEquals("atom-e", drawables.single().atomId)
        assertEquals(
            0,
            rendered.getSpans(0, rendered.length, DocSpan.MathematicsStyle::class.java).size,
        )
    }

    @Test
    fun `missing drawable keeps readable latex and identity`() {
        val mathematics = TabDocMarkup.Mark.Mathematics(
            from = 0,
            to = 8,
            attrs = mapOf("latex" to "E = mc^2", "display" to false),
            atomId = "atom-e",
        )
        val markup = object : TabDocMarkup {
            override val body: String = "E = mc^2"
            override val marks: List<TabDocMarkup.Mark> = listOf(mathematics)
        }
        val fallback = markup.toSpannable(textColor = Color.BLACK, formulaProvider = null)
        assertTrue(fallback.toString().contains("E = mc^2"))
        assertEquals(
            1,
            fallback.getSpans(0, fallback.length, DocSpan.MathematicsStyle::class.java).size,
        )
        assertEquals(
            0,
            fallback.getSpans(0, fallback.length, DocSpan.MathematicsDrawable::class.java).size,
        )
    }

    @Test
    fun `mathematicsBlock becomes a readonly formula view not unsupported`() {
        val json = Json { ignoreUnknownKeys = true }
        val node = buildJsonObject {
            put("type", "mathematicsBlock")
            putJsonObject("attrs") {
                put("latex", "\\int_0^1 x^2 \\, dx = \\frac{1}{3}")
            }
        }
        val doc = JsonObject(
            mapOf(
                "type" to json.parseToJsonElement("\"doc\""),
                "content" to JsonArray(listOf(node)),
            ),
        )
        val block = ProseMirrorParser.parseBlocks(doc).single()
        val view = BlockViewConverter.toBlockViews(listOf(block)).single()
        val formula = view as TabDocBlockView.Formula
        assertEquals("\\int_0^1 x^2 \\, dx = \\frac{1}{3}", formula.latex)
        assertFalse(formula.latex.contains("mathematicsBlock"))
    }

    @Test
    fun `parsed mathematics still resolves latex after attrs drop the source`() {
        val json = Json { ignoreUnknownKeys = true }
        val paragraph = buildJsonObject {
            put("type", "paragraph")
            put(
                "content",
                JsonArray(
                    listOf(
                        buildJsonObject {
                            put("type", "text")
                            put("text", "质能方程 ")
                        },
                        buildJsonObject {
                            put("type", "mathematics")
                            putJsonObject("attrs") {
                                put("latex", "E = mc^2")
                                put("display", false)
                            }
                        },
                        buildJsonObject {
                            put("type", "text")
                            put("text", " 同行")
                        },
                    ),
                ),
            )
        }
        val doc = JsonObject(
            mapOf(
                "type" to json.parseToJsonElement("\"doc\""),
                "content" to JsonArray(listOf(paragraph)),
            ),
        )
        val block = ProseMirrorParser.parseBlocks(doc).single()
        val body = block.spans.joinToString("") { it.text }
        val mark = BlockViewConverter.spansToMarks(body, block.spans)
            .filterIsInstance<TabDocMarkup.Mark.Mathematics>()
            .single()

        assertTrue(
            "解析后 latex 必须离开 attrs，只留在正文切片里",
            KatexFormulaHtml.latex(mark.attrs, mark.valueAttribute).isEmpty(),
        )
        assertEquals("E = mc^2", KatexFormulaHtml.sourceLatex(mark, body))

        val loader = DocFormulaLoader()
        assertEquals(
            "i|16.0|-16777216|E = mc^2",
            loader.cacheKey(mark, fontSizePx = 16f, textColor = Color.BLACK, sourceText = body),
        )
    }

    @Test
    fun `snapshot crop keeps only the inked formula not the offscreen canvas`() {
        val bitmap = android.graphics.Bitmap.createBitmap(640, 240, android.graphics.Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.TRANSPARENT)
        for (y in 0 until 18) {
            for (x in 0 until 48) {
                bitmap.setPixel(x, y, Color.BLACK)
            }
        }
        val cropped = checkNotNull(DocFormulaSnapshotCrop.cropped(bitmap))
        assertTrue(cropped.width < 80)
        assertTrue(cropped.height < 40)
        assertTrue(cropped.width >= 48)
        assertTrue(cropped.height >= 18)
    }

    @Test
    fun `css font size divides text pixels by density`() {
        assertEquals(14f, KatexFormulaHtml.cssFontSizePx(42f, 3f), 0.01f)
        assertEquals(16f, KatexFormulaHtml.cssFontSizePx(16f, 1f), 0.01f)
        assertEquals(16f, KatexFormulaHtml.cssFontSizePx(16f, 0f), 0.01f)
    }

    @Test
    fun `snapshot display size uses css measure not the cropped bitmap`() {
        assertEquals(42 to 24, KatexFormulaHtml.snapshotDisplaySize(14, 8, 3f))
        assertEquals(14 to 8, KatexFormulaHtml.snapshotDisplaySize(14, 8, 1f))
        assertTrue(
            "裁切位图若已是屏幕像素，再拿它乘 density 会比正文大出两三倍",
            KatexFormulaHtml.snapshotDisplaySize(14, 8, 3f).first <
                KatexFormulaHtml.snapshotDisplaySize(42, 24, 3f).first,
        )
    }

    @Test
    fun `evaluateJavascript size payload is readable in both encodings`() {
        assertEquals(80 to 20, KatexFormulaHtml.measuredSize("""{"ok":true,"width":80,"height":20}"""))
        assertEquals(
            80 to 20,
            KatexFormulaHtml.measuredSize("\"{\\\"ok\\\":true,\\\"width\\\":80,\\\"height\\\":20}\""),
        )
        assertEquals(null, KatexFormulaHtml.measuredSize("null"))
        assertEquals(null, KatexFormulaHtml.measuredSize("""{"ok":true,"width":0,"height":20}"""))
    }

    @Test
    fun `snapshot host params are margin-capable so FrameLayout measure does not crash`() {
        val params = DocFormulaSnapshotter.hostLayoutParams(80, 20)
        assertTrue(params is android.view.ViewGroup.MarginLayoutParams)
        assertEquals(80, params.width)
        assertEquals(20, params.height)
    }

    @Test
    fun `blank snapshot crop is a failure so source stays visible`() {
        val bitmap = android.graphics.Bitmap.createBitmap(640, 240, android.graphics.Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.TRANSPARENT)
        assertEquals(null, DocFormulaSnapshotCrop.cropped(bitmap))
    }

    @Test
    fun `tiny snapshot crop is a failure so source stays visible`() {
        val bitmap = android.graphics.Bitmap.createBitmap(640, 240, android.graphics.Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.TRANSPARENT)
        for (y in 0 until 4) {
            for (x in 0 until 4) {
                bitmap.setPixel(x, y, Color.BLACK)
            }
        }
        assertEquals(null, DocFormulaSnapshotCrop.cropped(bitmap))
    }
}
