package com.tabtin.mobile.features.doc.editor.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 行内图片呈现策略的纯函数证据。
 *
 * 与 iOS `NativeTabDocInlineImageRenderingTests` 的策略段一一对应：两端排版口径必须一致，
 * 否则同一篇文档在两台设备上会排出不同的版面。
 */
class DocInlineImagePresentationTest {

    private val fixtureAttrs = mapOf<String, Any?>(
        "src" to "https://oss.example.com/tabtin/demo-image.png",
        "fileId" to "file-demo-0001",
        "alt" to "示例图片",
        "title" to "示例图片标题",
        "width" to 640,
        "height" to 360,
    )

    @Test
    fun `descriptor extracts identity and intrinsic size from attrs`() {
        val descriptor = DocInlineImagePresentation.descriptor(fixtureAttrs)
        assertEquals("file-demo-0001", descriptor.fileId)
        assertEquals("https://oss.example.com/tabtin/demo-image.png", descriptor.source)
        assertEquals("示例图片", descriptor.alt)
        assertEquals("示例图片标题", descriptor.title)
        assertEquals(640, descriptor.intrinsicWidth)
        assertEquals(360, descriptor.intrinsicHeight)
        assertTrue(descriptor.canLoad)
    }

    @Test
    fun `descriptor accepts snake case fileId and reports unloadable image`() {
        val snake = DocInlineImagePresentation.descriptor(
            mapOf("src" to "", "file_id" to "file-legacy", "alt" to "旧字段"),
        )
        assertEquals("file-legacy", snake.fileId)
        assertTrue(snake.canLoad)

        val empty = DocInlineImagePresentation.descriptor(
            mapOf("src" to "", "fileId" to "", "alt" to "没有地址"),
        )
        assertFalse("既没有 fileId 也没有 src 时不该发起加载", empty.canLoad)
    }

    /** 签名地址会过期漂移，同一张图必须按稳定引用命中缓存。 */
    @Test
    fun `cache key prefers fileId over expiring signed source`() {
        val first = DocInlineImagePresentation.Descriptor(
            fileId = "file-demo-0001",
            source = "https://oss.example.com/a.png?sig=1",
        )
        val second = DocInlineImagePresentation.Descriptor(
            fileId = "file-demo-0001",
            source = "https://oss.example.com/a.png?sig=2",
        )
        assertEquals(
            DocInlineImagePresentation.cacheKey(first),
            DocInlineImagePresentation.cacheKey(second),
        )
        assertEquals(
            "src:https://oss.example.com/b.png",
            DocInlineImagePresentation.cacheKey(
                DocInlineImagePresentation.Descriptor(source = "https://oss.example.com/b.png"),
            ),
        )
        assertNull(DocInlineImagePresentation.cacheKey(DocInlineImagePresentation.Descriptor()))
    }

    @Test
    fun `declared size keeps aspect ratio and fits content width`() {
        val size = DocInlineImagePresentation.displaySize(
            intrinsicWidth = 640,
            intrinsicHeight = 360,
            lineHeight = 24,
            availableWidth = 320,
        )
        assertEquals("超过正文宽度必须收进正文宽度", 320, size.width)
        assertEquals("收缩后必须保持 16:9 宽高比", 180, size.height)
    }

    @Test
    fun `rounded display size never exceeds maximum height on fractional line height`() {
        val lineHeight = 17
        val size = DocInlineImagePresentation.displaySize(
            intrinsicWidth = 640,
            intrinsicHeight = 360,
            lineHeight = lineHeight,
            availableWidth = 320,
        )
        assertTrue(
            "四舍五入后仍不得冲破 8 行上限",
            size.height <= (lineHeight * DocInlineImagePresentation.MAXIMUM_HEIGHT_IN_LINES).toInt(),
        )
        assertTrue(size.width <= 320)
    }

    @Test
    fun `maximum height stops tall image from swallowing the screen`() {
        val size = DocInlineImagePresentation.displaySize(
            intrinsicWidth = 400,
            intrinsicHeight = 4000,
            lineHeight = 20,
            availableWidth = 320,
        )
        assertEquals("最多 8 行高，否则一行正文会撑成一屏", 160, size.height)
        assertEquals("限高后仍须等比", 16, size.width)
    }

    /** 声明尺寸在下载之前就已知，占位框与真图必须完全同尺寸，否则图片一到就跳版。 */
    @Test
    fun `declared size makes placeholder and loaded image identical`() {
        val placeholder = DocInlineImagePresentation.displaySize(
            intrinsicWidth = 640,
            intrinsicHeight = 360,
            lineHeight = 24,
            availableWidth = 320,
        )
        val loaded = DocInlineImagePresentation.displaySize(
            intrinsicWidth = 640,
            intrinsicHeight = 360,
            loadedWidth = 1920,
            loadedHeight = 1080,
            lineHeight = 24,
            availableWidth = 320,
        )
        assertEquals(placeholder, loaded)
        assertEquals(DocInlineImagePresentation.DisplaySize(320, 180), placeholder)
    }

    @Test
    fun `undeclared size locks height and uses loaded aspect ratio`() {
        val placeholder = DocInlineImagePresentation.displaySize(
            intrinsicWidth = null,
            intrinsicHeight = null,
            lineHeight = 20,
            availableWidth = 320,
        )
        assertEquals(
            "缺声明尺寸先占一个 3 行高方块",
            DocInlineImagePresentation.DisplaySize(60, 60),
            placeholder,
        )

        val loaded = DocInlineImagePresentation.displaySize(
            intrinsicWidth = null,
            intrinsicHeight = null,
            loadedWidth = 200,
            loadedHeight = 100,
            lineHeight = 20,
            availableWidth = 320,
        )
        assertEquals("缺声明尺寸时高度必须锁定，避免行高跳变", 60, loaded.height)
        assertEquals("宽度按实际宽高比展开", 120, loaded.width)
    }

    /** 双端同一份 attrs 必须排出同一块版面，否则跨设备阅读同一篇文档会看到不同布局。 */
    @Test
    fun `display size matches the iOS policy on the shared fixture`() {
        val descriptor = DocInlineImagePresentation.descriptor(fixtureAttrs)
        assertEquals(
            DocInlineImagePresentation.DisplaySize(320, 180),
            DocInlineImagePresentation.displaySize(
                intrinsicWidth = descriptor.intrinsicWidth,
                intrinsicHeight = descriptor.intrinsicHeight,
                lineHeight = 24,
                availableWidth = 320,
            ),
        )
    }

    @Test
    fun `async image refresh is skipped when the user already edited the body`() {
        val original = "行内图片：🖼 示例图片"
        assertTrue(DocInlineImagePresentation.canRefreshRenderedImages(original, original))
        assertFalse(
            "用户已改过正文时不得用绑定时的快照重刷，否则会盖掉正在输入的字",
            DocInlineImagePresentation.canRefreshRenderedImages(original, original + "续写"),
        )
    }

    @Test
    fun `fallback text stays readable and never leaks source or file id`() {
        val fallback = DocInlineImagePresentation.fallbackText(fixtureAttrs)
        assertEquals("🖼 示例图片", fallback)
        assertFalse("降级不得泄露签名 URL", fallback.contains("oss.example.com"))
        assertFalse("降级不得泄露 fileId", fallback.contains("file-demo-0001"))
        assertFalse("降级不得暴露实现类型名", fallback.contains("image"))
    }

    @Test
    fun `accessibility label falls back through alt then title`() {
        assertEquals("示例图片", DocInlineImagePresentation.accessibilityLabel(fixtureAttrs, "图片"))
        assertEquals(
            "只有标题",
            DocInlineImagePresentation.accessibilityLabel(
                mapOf("src" to "https://x/a.png", "alt" to "", "title" to "只有标题"),
                "图片",
            ),
        )
        assertEquals(
            "图片",
            DocInlineImagePresentation.accessibilityLabel(mapOf("src" to "https://x/a.png"), "图片"),
        )
    }
}
