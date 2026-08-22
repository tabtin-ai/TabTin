package com.tabtin.mobile.data.im

import org.junit.Assert.assertEquals
import org.junit.Test

class ImConversationTitlePolicyTest {
    @Test
    fun `dm prefers peer name over provider fallback`() {
        assertEquals(
            "沈庚涛",
            ImConversationTitlePolicy.resolve(
                conversationName = "TabTin private conversation",
                isDirectMessage = true,
                peerDisplayName = "沈庚涛",
                directMessageFallback = "私信",
                conversationFallback = "会话",
            ),
        )
    }

    @Test
    fun `dm never exposes provider fallback when peer is unavailable`() {
        assertEquals(
            "私信",
            ImConversationTitlePolicy.resolve(
                conversationName = "TabTin private conversation",
                isDirectMessage = true,
                peerDisplayName = null,
                directMessageFallback = "私信",
                conversationFallback = "会话",
            ),
        )
    }

    @Test
    fun `dm never exposes uuid conversation or peer name`() {
        val uuid = "1325c2ff-175e-4751-8f0c-cac5a6676384"

        assertEquals(
            "私信",
            ImConversationTitlePolicy.resolve(
                conversationName = uuid,
                isDirectMessage = true,
                peerDisplayName = uuid,
                directMessageFallback = "私信",
                conversationFallback = "会话",
            ),
        )
    }

    @Test
    fun `group keeps conversation name`() {
        assertEquals(
            "项目群",
            ImConversationTitlePolicy.resolve(
                conversationName = "项目群",
                isDirectMessage = false,
                peerDisplayName = null,
                directMessageFallback = "私信",
                conversationFallback = "会话",
            ),
        )
    }
}
