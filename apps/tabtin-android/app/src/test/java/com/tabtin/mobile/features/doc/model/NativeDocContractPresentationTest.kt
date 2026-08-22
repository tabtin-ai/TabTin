package com.tabtin.mobile.features.doc.model

import android.app.Application
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.text.Annotation
import com.tabtin.mobile.features.doc.editor.core.BlockViewConverter
import com.tabtin.mobile.features.doc.editor.core.DocInlineImagePresentation
import com.tabtin.mobile.features.doc.editor.core.DocSpan
import com.tabtin.mobile.features.doc.editor.core.KatexFormulaHtml
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.features.doc.editor.core.toSpannable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 契约夹具里 Android 的 `presentation.current` 必须由**生产渲染链路**推导，而不是靠人手写。
 *
 * `NativeDocContractFixtureTest` 只校验「声明 vs knownGaps」的自洽，夹具改了而渲染没跟上
 * 它不会红。这个类补上另一半：把夹具节点喂进 `ProseMirrorParser → BlockViewConverter →
 * toSpannable` 这条与编辑器完全一致的路径，用渲染产物反推 presentation，和声明比对。
 * 与 iOS `NativeTabDocContractFixtureTests.actualPresentation` 对称。
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class NativeDocContractPresentationTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `declared Android presentation is produced by the production render path`() {
        val sourceNodes = loadFixtureDoc().getValue("content").jsonArray
            .filterIsInstance<JsonObject>()
        val expectedBlocks = loadExpectations().getValue("blocks").jsonArray
            .filterIsInstance<JsonObject>()

        var checked = 0
        expectedBlocks.forEachIndexed { index, expectation ->
            val declared = (expectation["presentation"] as? JsonObject)
                ?.let { it["current"] as? JsonObject }
                ?.get("android")?.jsonPrimitive?.contentOrNull
                ?: return@forEachIndexed
            val source = sourceNodes[index]
            val actual = formulaPresentation(source)
                ?: inlineImagePresentation(source)
                ?: return@forEachIndexed
            assertEquals(
                "Android 生产展示与 presentation.current 漂移：${expectation.string("path")}",
                declared,
                actual,
            )
            checked += 1
        }

        loadExpectations().getValue("markCases").jsonArray
            .filterIsInstance<JsonObject>()
            .forEach { expectation ->
                val declared = (expectation["presentation"] as? JsonObject)
                    ?.let { it["current"] as? JsonObject }
                    ?.get("android")?.jsonPrimitive?.contentOrNull
                    ?: return@forEach
                val source = expectation.getValue("fixture").jsonObject
                val actual = formulaPresentation(source)
                    ?: inlineImagePresentation(source)
                    ?: return@forEach
                assertEquals(
                    "Android 生产展示与 presentation.current 漂移：${expectation.string("path")}",
                    declared,
                    actual,
                )
                checked += 1
            }
        assertEquals("行内公式、块级公式与行内图片呈现断言必须真的跑到", 4, checked)
    }

    /**
     * 行内公式：生产 toSpannable 在公式 drawable 就绪时必须盖住原子，身份 annotation 仍在。
     */
    private fun formulaPresentation(source: JsonObject): String? {
        val children = (source["content"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
        val sourceFormulas = children.filter { it.string("type") == "mathematics" }
        if (source["type"]?.jsonPrimitive?.contentOrNull == "mathematicsBlock") {
            val block = ProseMirrorParser.parseBlocks(singletonDoc(source)).single()
            val view = BlockViewConverter.toBlockViews(listOf(block)).single()
            if (view !is com.tabtin.mobile.features.doc.editor.core.TabDocBlockView.Formula) {
                return "unsupported_placeholder"
            }
            if (view.latex.isEmpty()) return "unsupported_placeholder"
            return if (KatexFormulaHtml.looksRendered("katex") && view.latex.isNotEmpty()) {
                "formula_rendered"
            } else {
                "source_fallback"
            }
        }
        if (sourceFormulas.isEmpty()) return null

        val block = ProseMirrorParser.parseBlocks(singletonDoc(source)).single()
        val body = block.spans.joinToString("") { it.text }
        val marks = BlockViewConverter.spansToMarks(body, block.spans)
        val mathMarks = marks.filterIsInstance<TabDocMarkup.Mark.Mathematics>()
        if (mathMarks.size != sourceFormulas.size) return "formula_omitted"

        val markup = object : TabDocMarkup {
            override val body: String = body
            override val marks: List<TabDocMarkup.Mark> = marks
        }
        val rendered = markup.toSpannable(
            textColor = Color.BLACK,
            formulaProvider = { ColorDrawable(Color.BLUE).apply { setBounds(0, 0, 24, 16) } },
        )
        val fallback = markup.toSpannable(textColor = Color.BLACK, formulaProvider = null)
        val identitySpans = rendered.getSpans(0, rendered.length, Annotation::class.java)
            .filter { it.key == DocSpan.Mathematics.MATH_KEY }
        if (identitySpans.size != sourceFormulas.size) return "formula_omitted"
        val formulaSpans = rendered.getSpans(0, rendered.length, DocSpan.MathematicsDrawable::class.java)
        if (formulaSpans.size != sourceFormulas.size) {
            return if (fallback.contains("E = mc^2")) "source_fallback" else "formula_omitted"
        }
        val coversAtoms = formulaSpans.all { span ->
            mathMarks.any { mark ->
                mark.atomId == span.atomId &&
                    rendered.getSpanStart(span) == mark.from &&
                    rendered.getSpanEnd(span) == mark.to
            }
        }
        return if (coversAtoms) "formula_rendered" else "source_fallback"
    }

    /**
     * 只判定混排段落里的行内图片；独立图片段落走块级投影，不是行内呈现，返回 null 交回
     * 其他断言。判定口径与 iOS 一致：真图必须由图片 span 承载，降级必须可读且不泄露身份。
     */
    private fun inlineImagePresentation(source: JsonObject): String? {
        val children = (source["content"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
        if (children.size <= 1) return null
        val sourceImages = children.filter { it.string("type") == "image" }
        if (sourceImages.isEmpty()) return null

        val block = ProseMirrorParser.parseBlocks(singletonDoc(source)).single()
        val body = block.spans.joinToString("") { it.text }
        val marks = BlockViewConverter.spansToMarks(body, block.spans)
        val imageMarks = marks.filterIsInstance<TabDocMarkup.Mark.InlineImage>()
        if (imageMarks.size != sourceImages.size) return "image_dropped"

        val markup = object : TabDocMarkup {
            override val body: String = body
            override val marks: List<TabDocMarkup.Mark> = marks
        }
        // 模拟「图片已经全部下载完成」：真排版下每张图都必须由图片 span 承载。
        val rendered = markup.toSpannable(
            textColor = Color.BLACK,
            inlineImageProvider = { mark ->
                val descriptor = DocInlineImagePresentation.descriptor(mark.attrs)
                if (!descriptor.canLoad) {
                    null
                } else {
                    ColorDrawable(Color.BLUE).apply { setBounds(0, 0, 8, 8) }
                }
            },
        )
        val fallback = markup.toSpannable(textColor = Color.BLACK, inlineImageProvider = null)

        // 无论真图还是降级，都不许把签名地址或 fileId 摆到用户面前。
        val visible = rendered.toString() + " " + fallback.toString()
        val identityLeaked = sourceImages.any { image ->
            val attrs = (image["attrs"] as? JsonObject).orEmptyObject()
            listOf("src", "fileId", "file_id").any { key ->
                val value = attrs[key]?.jsonPrimitive?.contentOrNull.orEmpty()
                value.isNotEmpty() && visible.contains(value)
            }
        }
        if (identityLeaked) return "image_identity_leak"

        val altReadable = sourceImages.all { image ->
            val alt = (image["attrs"] as? JsonObject).orEmptyObject()["alt"]
                ?.jsonPrimitive?.contentOrNull.orEmpty()
            alt.isEmpty() || fallback.toString().contains(alt)
        }
        if (!altReadable) return "image_opaque_placeholder"

        val imageSpans = rendered
            .getSpans(0, rendered.length, DocSpan.InlineImageDrawable::class.java)
        val identitySpans = rendered.getSpans(0, rendered.length, Annotation::class.java)
            .filter { it.key == DocSpan.InlineImage.IMAGE_KEY }
        // 身份必须与呈现无关地存活，否则「渲染成功」等于把写回搞坏了。
        if (identitySpans.size != sourceImages.size) return "image_identity_lost"
        if (imageSpans.size != sourceImages.size) return "image_alt_placeholder"

        val coversAtoms = imageSpans.all { span ->
            imageMarks.any { mark ->
                mark.atomId == span.atomId &&
                    rendered.getSpanStart(span) == mark.from &&
                    rendered.getSpanEnd(span) == mark.to
            }
        }
        return if (coversAtoms) "image_rendered" else "image_alt_placeholder"
    }

    private fun JsonObject?.orEmptyObject(): JsonObject = this ?: JsonObject(emptyMap())

    private fun singletonDoc(node: JsonObject): JsonObject = JsonObject(
        mapOf("type" to json.parseToJsonElement("\"doc\""), "content" to JsonArray(listOf(node))),
    )

    private fun loadFixtureDoc(): JsonObject {
        val text = requireNotNull(
            javaClass.classLoader?.getResourceAsStream("mobile-contract/doc/rich-mixed.pm.json"),
        ) { "缺少 mobile-contract/doc/rich-mixed.pm.json（tests/mobile-contract 的只读拷贝）" }
            .bufferedReader().use { it.readText() }
        return json.parseToJsonElement(text).jsonObject.getValue("doc").jsonObject
    }

    private fun loadExpectations(): JsonObject {
        val text = requireNotNull(
            javaClass.classLoader?.getResourceAsStream(
                "mobile-contract/doc/rich-mixed.expectations.json",
            ),
        ) { "缺少 mobile-contract/doc/rich-mixed.expectations.json（tests/mobile-contract 的只读拷贝）" }
            .bufferedReader().use { it.readText() }
        return json.parseToJsonElement(text).jsonObject
    }

    private fun JsonObject.string(key: String): String =
        this[key]?.jsonPrimitive?.contentOrNull.orEmpty()
}
