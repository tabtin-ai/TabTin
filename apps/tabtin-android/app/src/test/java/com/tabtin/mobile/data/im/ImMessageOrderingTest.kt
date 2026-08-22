package com.tabtin.mobile.data.im

import org.junit.Assert.assertEquals
import org.junit.Test

class ImMessageOrderingTest {
    @Test
    fun `c2c lower seq with newer createdAt sorts to the end`() {
        val olderHighSeq = ImMessage(
            id = 100,
            seq = 100,
            conversationId = "dm-1",
            content = "昨晚旧消息",
            createdAt = "2026-08-18T12:27:00Z",
        )
        val newerLowSeq = ImMessage(
            id = 5,
            seq = 5,
            conversationId = "dm-1",
            content = "计划落实1231",
            createdAt = "2026-08-19T05:46:00Z",
        )

        val ordered = imChronologicallySortedMessages(listOf(olderHighSeq, newerLowSeq))

        assertEquals(listOf("昨晚旧消息", "计划落实1231"), ordered.map { it.content })
    }

    @Test
    fun `missing createdAt stays before timestamped messages so takeLast keeps latest`() {
        val undated = ImMessage(id = 1, seq = 1, conversationId = "dm-1", content = "无时间戳")
        val dated = ImMessage(
            id = 2,
            seq = 2,
            conversationId = "dm-1",
            content = "有时间戳",
            createdAt = "2026-08-19T05:46:00Z",
        )

        assertEquals(
            listOf("无时间戳", "有时间戳"),
            imChronologicallySortedMessages(listOf(dated, undated)).map { it.content },
        )
    }

    @Test
    fun `equal timestamps preserve input order`() {
        val first = ImMessage(
            id = 1,
            seq = 1,
            conversationId = "dm-1",
            content = "先",
            createdAt = "2026-08-19T05:46:00Z",
        )
        val second = ImMessage(
            id = 2,
            seq = 2,
            conversationId = "dm-1",
            content = "后",
            createdAt = "2026-08-19T05:46:00Z",
        )

        assertEquals(
            listOf("先", "后"),
            imChronologicallySortedMessages(listOf(first, second)).map { it.content },
        )
    }
}
