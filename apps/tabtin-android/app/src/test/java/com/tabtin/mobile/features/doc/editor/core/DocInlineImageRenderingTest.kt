package com.tabtin.mobile.features.doc.editor.core

import android.app.Application
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.text.Annotation
import android.text.SpannableStringBuilder
import com.tabtin.mobile.features.doc.model.InlineMark
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.RuntimeEnvironment

/**
 * 行内图片「真排版」的呈现层证据（Android）。
 *
 * 身份保真由 `ProseMirrorParserTest` / `NativeDocContractFixtureTest` 覆盖；这里只回答呈现
 * 问题：图片有没有真的排进正文、加载不出来时会不会退回可读文案、以及身份 span 是否在两种
 * 呈现下都原样存活。与 iOS `NativeTabDocInlineImageRenderingTests` 对称。
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class DocInlineImageRenderingTest {

    private data class SimpleMarkup(
        override val body: String,
        override val marks: List<TabDocMarkup.Mark>,
    ) : TabDocMarkup

    private val fixtureAttrs = mapOf<String, Any?>(
        "src" to "https://oss.example.com/tabtin/demo-image.png",
        "fileId" to "file-demo-0001",
        "alt" to "示例图片",
        "title" to "示例图片标题",
        "width" to 640,
        "height" to 360,
    )

    private val placeholder = InlineMark.InlineImage.placeholderText(fixtureAttrs)

    private fun markup(
        attrs: Map<String, Any?> = fixtureAttrs,
        atomId: String = "atom-1",
        prefix: String = "行内图片：",
        suffix: String = "\n硬换行后的文字。",
    ): SimpleMarkup {
        val text = InlineMark.InlineImage.placeholderText(attrs)
        return SimpleMarkup(
            body = prefix + text + suffix,
            marks = listOf(
                TabDocMarkup.Mark.InlineImage(
                    from = prefix.length,
                    to = prefix.length + text.length,
                    attrs = attrs,
                    atomId = atomId,
                ),
            ),
        )
    }

    private fun loadedDrawable(width: Int = 320, height: Int = 180): Drawable =
        ColorDrawable(Color.BLUE).apply { setBounds(0, 0, width, height) }

    private fun SpannableStringBuilder.imageDrawables() =
        getSpans(0, length, DocSpan.InlineImageDrawable::class.java)

    private fun SpannableStringBuilder.identityAnnotations() =
        getSpans(0, length, Annotation::class.java)
            .filter { it.key == DocSpan.InlineImage.IMAGE_KEY }

    // MARK: - 真排版

    /** 图片就绪后，那一段正文由真图承载，而不是继续显示 alt 占位。 */
    @Test
    fun `loaded inline image renders as image span over the placeholder range`() {
        val markup = markup()
        val drawable = loadedDrawable()
        val spannable = markup.toSpannable(
            textColor = Color.BLACK,
            inlineImageProvider = { drawable },
        )

        val images = spannable.imageDrawables()
        assertEquals("行内图片必须排成一个图片 span", 1, images.size)
        assertEquals("atom-1", images.single().atomId)
        assertEquals(
            "图片 span 必须精确覆盖这张图的原子范围",
            "行内图片：".length,
            spannable.getSpanStart(images.single()),
        )
        assertEquals(
            "行内图片：".length + placeholder.length,
            spannable.getSpanEnd(images.single()),
        )
        assertEquals(
            "真图使用加载器按声明宽高比算出的尺寸",
            DocInlineImagePresentation.DisplaySize(320, 180),
            images.single().drawable.bounds.let {
                DocInlineImagePresentation.DisplaySize(it.width(), it.height())
            },
        )
        assertTrue("同行文字必须与图片并排保留", spannable.toString().startsWith("行内图片："))
        assertTrue(spannable.toString().endsWith("硬换行后的文字。"))
    }

    /** 呈现换了形态，身份不许跟着变——写回仍然靠身份 span，不靠画成什么样。 */
    @Test
    fun `identity annotation survives both rendered and fallback presentation`() {
        val markup = markup()
        val rendered = markup.toSpannable(
            textColor = Color.BLACK,
            inlineImageProvider = { loadedDrawable() },
        )
        val fallback = markup.toSpannable(textColor = Color.BLACK, inlineImageProvider = null)

        for ((label, spannable) in listOf("真图" to rendered, "降级" to fallback)) {
            val identities = spannable.identityAnnotations()
            assertEquals("$label 呈现下身份 span 必须唯一存在", 1, identities.size)
            val decoded = requireNotNull(DocSpan.InlineImage.fromAnnotation(identities.single()))
            assertEquals("atom-1", decoded.atomId)
            assertEquals("image", decoded.nodeType)
            assertEquals("file-demo-0001", decoded.attrs["fileId"])
            assertEquals("示例图片", decoded.attrs["alt"])
            assertEquals("示例图片标题", decoded.attrs["title"])
            assertEquals(640, (decoded.attrs["width"] as Number).toInt())
            assertEquals(360, (decoded.attrs["height"] as Number).toInt())
        }
    }

    /** 底层文本始终是占位串：真图只是盖在上面，删除范围与编辑保护不会因呈现而变。 */
    @Test
    fun `rendered image does not rewrite the underlying atom text`() {
        val rendered = markup().toSpannable(
            textColor = Color.BLACK,
            inlineImageProvider = { loadedDrawable() },
        )
        val fallback = markup().toSpannable(textColor = Color.BLACK, inlineImageProvider = null)
        assertEquals(
            "真图与降级必须共享同一份底层文本，否则光标位置会在图片加载完成时突然漂移",
            fallback.toString(),
            rendered.toString(),
        )
    }

    /** 一段里的两张图各自成原子，不能被并成一张。 */
    @Test
    fun `two inline images in one paragraph stay independent atoms`() {
        val second = fixtureAttrs + mapOf("fileId" to "file-demo-0002", "alt" to "第二张")
        val firstText = InlineMark.InlineImage.placeholderText(fixtureAttrs)
        val secondText = InlineMark.InlineImage.placeholderText(second)
        val markup = SimpleMarkup(
            body = firstText + "、" + secondText,
            marks = listOf(
                TabDocMarkup.Mark.InlineImage(
                    from = 0,
                    to = firstText.length,
                    attrs = fixtureAttrs,
                    atomId = "atom-1",
                ),
                TabDocMarkup.Mark.InlineImage(
                    from = firstText.length + 1,
                    to = firstText.length + 1 + secondText.length,
                    attrs = second,
                    atomId = "atom-2",
                ),
            ),
        )
        val spannable = markup.toSpannable(
            textColor = Color.BLACK,
            inlineImageProvider = { loadedDrawable() },
        )
        val images = spannable.imageDrawables().sortedBy(spannable::getSpanStart)
        assertEquals(listOf("atom-1", "atom-2"), images.map { it.atomId })
        assertEquals(2, spannable.identityAnnotations().size)
    }

    // MARK: - 诚实降级

    /** 拿不到图时保持可读的 alt 占位，绝不显示空框、破图或原始地址。 */
    @Test
    fun `missing image keeps readable alt and never leaks source or file id`() {
        val spannable = markup().toSpannable(textColor = Color.BLACK, inlineImageProvider = null)
        assertTrue("降级不得产生任何图片 span", spannable.imageDrawables().isEmpty())

        val visible = spannable.toString()
        assertTrue("降级必须是人能读懂的文案", visible.contains("🖼 示例图片"))
        assertFalse("降级不得泄露签名 URL", visible.contains("oss.example.com"))
        assertFalse("降级不得泄露 fileId", visible.contains("file-demo-0001"))
        assertFalse("降级不得暴露实现类型名", visible.contains("image"))
    }

    /** 有的图没有任何可加载地址，加载器永远给不出图，必须一路走到可读占位。 */
    @Test
    fun `image without any source never yields a drawable and stays as alt text`() = runTest {
        val attrs = mapOf<String, Any?>("src" to "", "fileId" to "", "alt" to "缺地址的图")
        val loader = DocInlineImageLoader(
            context = RuntimeEnvironment.getApplication(),
            scope = this,
            resolveDisplayUrl = { null },
        )
        val mark = TabDocMarkup.Mark.InlineImage(from = 0, to = 1, attrs = attrs, atomId = "atom-1")

        var readyCount = 0
        loader.requestMissing(listOf(mark)) { readyCount += 1 }
        advanceUntilIdle()
        assertEquals("拿不到图就不该通知界面刷新", 0, readyCount)
        assertNull(loader.drawable(mark, lineHeight = 20, availableWidth = 320))

        val spannable = markup(attrs = attrs).toSpannable(
            textColor = Color.BLACK,
            inlineImageProvider = { loader.drawable(it, lineHeight = 20, availableWidth = 320) },
        )
        assertTrue(spannable.imageDrawables().isEmpty())
        assertTrue(spannable.toString().contains("🖼 缺地址的图"))
    }

    /**
     * 缓存命中必须真的给出 drawable。上一轮曾把 `drawable()` 改成恒返回 null
     * 做变异验证，结果没改回来——这条断言就是为了再挡住那一类漏改。
     */
    @Test
    fun `primed bitmap is served as drawable keyed by fileId across signed url drift`() {
        val bitmap = android.graphics.Bitmap.createBitmap(64, 36, android.graphics.Bitmap.Config.ARGB_8888)
        val loader = DocInlineImageLoader(
            context = RuntimeEnvironment.getApplication(),
            scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
            resolveDisplayUrl = { error("缓存命中后不应再走网络") },
        )
        loader.prime(bitmap, DocInlineImagePresentation.descriptor(fixtureAttrs))

        val drifted = fixtureAttrs + mapOf("src" to "https://oss.example.com/a.png?sig=2")
        val mark = TabDocMarkup.Mark.InlineImage(
            from = 0,
            to = 1,
            attrs = drifted,
            atomId = "atom-1",
        )
        val drawable = loader.drawable(mark, lineHeight = 24, availableWidth = 320)
        assertNotNull("缓存命中必须给出真图，不能继续走占位", drawable)
        val size = requireNotNull(drawable).bounds
        assertEquals(
            "声明尺寸下必须按 16:9 收进正文宽度",
            DocInlineImagePresentation.DisplaySize(320, 180),
            DocInlineImagePresentation.DisplaySize(size.width(), size.height()),
        )

        val spannable = markup(attrs = drifted).toSpannable(
            textColor = Color.BLACK,
            inlineImageProvider = { loader.drawable(it, lineHeight = 24, availableWidth = 320) },
        )
        assertEquals("缓存命中必须排成图片 span", 1, spannable.imageDrawables().size)
        assertEquals("atom-1", spannable.imageDrawables().single().atomId)
    }

    /** 一张坏图不能在每次滚动重绑定时都重打一次网络。 */
    @Test
    fun `failed load is remembered and not retried on every bind`() = runTest {
        var resolveCount = 0
        val loader = DocInlineImageLoader(
            context = RuntimeEnvironment.getApplication(),
            scope = this,
            resolveDisplayUrl = { resolveCount += 1; null },
        )
        val mark = TabDocMarkup.Mark.InlineImage(
            from = 0,
            to = 1,
            attrs = fixtureAttrs + mapOf("src" to ""),
            atomId = "atom-1",
        )

        repeat(3) {
            loader.requestMissing(listOf(mark)) {}
            advanceUntilIdle()
        }
        assertEquals("失败必须记账，不能每次绑定都重试", 1, resolveCount)
        assertNull("失败后仍然拿不到图", loader.drawable(mark, lineHeight = 20, availableWidth = 320))

        loader.reset()
        loader.requestMissing(listOf(mark)) {}
        advanceUntilIdle()
        assertEquals("用户主动重试（换会话/刷新）后必须给坏图一次机会", 2, resolveCount)
    }

    // MARK: - 加载完成后的刷新

    /** 图片是异步到的：第二次 setMarkup 必须把真图接上，同时不破坏身份与正文。 */
    @Test
    fun `refreshing after load swaps fallback for the real image without touching identity`() {
        val markup = markup()
        val editable = SpannableStringBuilder()
        editable.setMarkup(markup, textColor = Color.BLACK, inlineImageProvider = null)
        assertTrue("首帧图片还没到，先走占位", editable.imageDrawables().isEmpty())
        val textBeforeLoad = editable.toString()

        editable.setMarkup(
            markup,
            textColor = Color.BLACK,
            inlineImageProvider = { loadedDrawable() },
        )
        assertEquals("刷新真图不得改写正文", textBeforeLoad, editable.toString())
        assertEquals("真图必须接上", 1, editable.imageDrawables().size)
        assertEquals("身份 span 不得被刷新重复叠加", 1, editable.identityAnnotations().size)
        assertNotNull(
            DocSpan.InlineImage.fromAnnotation(editable.identityAnnotations().single()),
        )
    }

    /** 图片失效后（例如换了会话）要能退回占位，不能把上一张图留在屏幕上骗人。 */
    @Test
    fun `refreshing after invalidation drops the stale image span`() {
        val markup = markup()
        val editable = SpannableStringBuilder()
        editable.setMarkup(
            markup,
            textColor = Color.BLACK,
            inlineImageProvider = { loadedDrawable() },
        )
        assertEquals(1, editable.imageDrawables().size)

        editable.setMarkup(markup, textColor = Color.BLACK, inlineImageProvider = null)
        assertTrue("失效后必须退回占位，不能留着旧图", editable.imageDrawables().isEmpty())
        assertTrue(editable.toString().contains("🖼 示例图片"))
    }
}
