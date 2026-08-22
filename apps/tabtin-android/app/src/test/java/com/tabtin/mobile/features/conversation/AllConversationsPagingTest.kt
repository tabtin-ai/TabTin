package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AllChatSession
import org.junit.Assert.assertEquals
import org.junit.Test

class AllConversationsPagingTest {
    @Test
    fun `later session pages replace duplicates without losing their original position`() {
        val merged = mergeSessionPage(
            existing = listOf(
                AllChatSession(id = "first", title = "旧标题"),
                AllChatSession(id = "second", title = "保留"),
            ),
            incoming = listOf(
                AllChatSession(id = "first", title = "新标题"),
                AllChatSession(id = "third", title = "新增"),
            ),
        )

        assertEquals(listOf("first", "second", "third"), merged.map { it.id })
        assertEquals("新标题", merged.first().title)
    }
}
