package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ImConversation
import com.tabtin.mobile.data.im.ImConversationType
import com.tabtin.mobile.data.im.ImMessageSearchResult
import org.junit.Assert.assertEquals
import org.junit.Test

class ImInboxSearchRowsTest {
    @Test
    fun `local title matches remain visible and cloud body matches override duplicate previews`() {
        val local = conversation("local", "项目讨论", "昨天的摘要")
        val duplicate = conversation("duplicate", "其他会话", "最后一条包含 66")
        val cloudOnly = conversation("cloud", "云命中", "最新摘要")

        val rows = resolveImInboxRows(
            conversations = listOf(local, duplicate),
            resolvedTitles = mapOf(local.id to "项目 66", duplicate.id to duplicate.name),
            searchResults = listOf(
                ImMessageSearchResult(duplicate, "更早的正文 66", 2),
                ImMessageSearchResult(cloudOnly, "云端正文 66", 1),
            ),
            query = "66",
        )

        assertEquals(listOf("local", "duplicate", "cloud"), rows.map { it.conversation.id })
        assertEquals(listOf("昨天的摘要", "更早的正文 66", "云端正文 66"), rows.map { it.preview })
    }

    private fun conversation(id: String, name: String, preview: String): ImConversation = ImConversation(
        id = id,
        organizationId = "org-a",
        type = ImConversationType.DM,
        name = name,
        lastMessagePreview = preview,
    )
}
