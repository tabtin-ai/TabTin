package com.tabtin.mobile.features.tabchat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImTextLinksTest {
    @Test
    fun `shared table url excludes trailing Chinese punctuation`() {
        val content = "请查看共享表格：https://www.example.com/shared/tables/table-1。"

        val links = findImTextLinks(content)

        assertEquals(listOf("https://www.example.com/shared/tables/table-1"), links.map { it.url })
        assertRangesMatchSource(content, links)
    }

    @Test
    fun `finds multiple http and https links`() {
        val content = "先打开 http://example.com/a，再打开 https://example.com/b"

        val links = findImTextLinks(content)

        assertEquals(
            listOf("http://example.com/a", "https://example.com/b"),
            links.map { it.url },
        )
        assertRangesMatchSource(content, links)
    }

    @Test
    fun `excludes trailing English punctuation and unmatched brackets`() {
        val content = "A: https://example.com/a, B: (https://example.com/b.)"

        val links = findImTextLinks(content)

        assertEquals(
            listOf("https://example.com/a", "https://example.com/b"),
            links.map { it.url },
        )
        assertRangesMatchSource(content, links)
    }

    @Test
    fun `keeps balanced brackets that are part of a url`() {
        val content = "https://example.com/wiki/Function_(math)"

        assertEquals(listOf(content), findImTextLinks(content).map { it.url })
    }

    @Test
    fun `plain text has no links`() {
        assertTrue(findImTextLinks("这是一条没有链接的普通消息").isEmpty())
    }

    @Test
    fun `non-http schemes are not links`() {
        val content = "javascript:alert(1) file:///tmp/a tabtin://shared/tables/1"

        assertTrue(findImTextLinks(content).isEmpty())
    }

    private fun assertRangesMatchSource(content: String, links: List<ImTextLink>) {
        links.forEach { link ->
            assertEquals(link.url, content.substring(link.start, link.endExclusive))
        }
    }
}
