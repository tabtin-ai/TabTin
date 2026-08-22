package com.tabtin.mobile.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `BlockItem.isRichContent` 行为单元测试。
 *
 * W4.5 第二波 P0-2 修复（2026-05-12）回归守卫：
 *
 * Django reassembler 落库时 `block.type` 字段直接来自 daemon emit 的
 * `ContentBlock.type='tabtin_rich_content'`（见
 * `packages/agent-wire/src/stream-content-block.ts::TabTinRichContentBlockSchema`），
 * 而前端 inline 构造 / 旧历史数据则可能使用 `'rich_content'`。
 *
 * 两个字面量都必须算作 `isRichContent=true`，否则 Android 用户打开历史会话时
 * `richContentBlocks` filter 会把 `'tabtin_rich_content'` 整段静默过滤掉，
 * 富内容卡片 100% 不可见。
 */
class BlockItemTest {

    @Test
    fun `rich_content type is recognized as rich content`() {
        val block = BlockItem(type = "rich_content", kind = "image", summary = "示例图片")
        assertTrue(
            "type=='rich_content' 必须算作 rich content（旧前端 inline 构造 / 旧历史数据兼容）",
            block.isRichContent,
        )
    }

    @Test
    fun `tabtin_rich_content type is recognized as rich content`() {
        val block = BlockItem(type = "tabtin_rich_content", kind = "image", summary = "示例图片")
        assertTrue(
            "type=='tabtin_rich_content' 必须算作 rich content——Django reassembler 落库形态，" +
                "缺这条会让 Android 用户打开历史会话时富内容卡片 100% 不可见",
            block.isRichContent,
        )
    }

    @Test
    fun `other types are not rich content`() {
        val text = BlockItem(type = "text", content = "hello")
        val toolUse = BlockItem(type = "tool_use")
        val image = BlockItem(type = "image", url = "https://oss.example.com/a.png")

        assertFalse("text 不算 rich content", text.isRichContent)
        assertFalse("tool_use 不算 rich content", toolUse.isRichContent)
        assertFalse(
            "image 顶层 type 与 rich_content.kind=image 是两种 schema，顶层 type='image' 走附件路径",
            image.isRichContent,
        )
    }

    @Test
    fun `rich_content without kind still counts as rich content`() {
        val block = BlockItem(type = "rich_content")
        assertTrue(
            "Wave 3 协议对照 Review 锁定：仅基于 type 判定，kind 缺失由 RichContentSection " +
                "的 else -> RichFallback 兜底",
            block.isRichContent,
        )
    }

    @Test
    fun `tabtin_rich_content without kind still counts as rich content`() {
        val block = BlockItem(type = "tabtin_rich_content")
        assertTrue(
            "tabtin_rich_content 缺 kind 的兜底逻辑与 rich_content 等价",
            block.isRichContent,
        )
    }

    @Test
    fun `richContentBlocks filter accepts both legacy and reassembler schemas`() {
        val blocks = listOf(
            BlockItem(type = "text", content = "前置说明"),
            BlockItem(type = "rich_content", kind = "image", summary = "前端 inline 构造"),
            BlockItem(type = "tabtin_rich_content", kind = "table_preview", summary = "Django 落库"),
            BlockItem(type = "tool_use"),
        )
        val richBlocks = blocks.filter { it.isRichContent }
        assertEquals(
            "filter 需同时接住 rich_content + tabtin_rich_content——历史会话富内容卡片可见性回归",
            2,
            richBlocks.size,
        )
        assertEquals("rich_content", richBlocks[0].type)
        assertEquals("tabtin_rich_content", richBlocks[1].type)
    }
}
