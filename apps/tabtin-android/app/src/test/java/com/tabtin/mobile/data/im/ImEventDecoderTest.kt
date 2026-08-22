package com.tabtin.mobile.data.im

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [ImEventDecoder] 单测：覆盖 message / edited / deleted / reaction / typing / read.receipt /
 * unread 及未知类型与脏包丢弃。信封字段布局对齐后端 `IMOutboxService.enqueue`。
 */
class ImEventDecoderTest {
    @Test
    fun `decodes agent message projection events`() {
        val stream = ImEventDecoder.decode(
            """{"type":"im.agent.message.stream","data":{"conversation_id":"c1","message_ref":"job-1","agent_session_ref":"session-1","sender_id":"agent-1","sender_name":"研究员","sender_avatar":"","delta":"你","stream_seq":2,"created_at":"2026-08-22T10:00:00Z"}}""",
        ) as ImRealtimeEvent.AgentMessageStream
        assertEquals("job-1", stream.payload.messageRef)
        assertEquals("你", stream.payload.delta)
        assertEquals(2, stream.payload.streamSeq)

        val final = ImEventDecoder.decode(
            """{"type":"im.agent.message.final","data":{"conversation_id":"c1","message_ref":"job-1","agent_session_ref":"session-1","sender_id":"agent-1","sender_name":"研究员","sender_avatar":"","content":"完整回答","message_type":1,"metadata":{"kind":"tabtin_ref"},"created_at":"2026-08-22T10:00:01Z"}}""",
        ) as ImRealtimeEvent.AgentMessageFinal
        assertEquals("完整回答", final.payload.content)
        assertEquals("tabtin_ref", final.payload.metadata?.kind)

        val error = ImEventDecoder.decode(
            """{"type":"im.agent.message.error","data":{"conversation_id":"c1","message_ref":"job-1","agent_session_ref":"session-1","sender_id":"agent-1","sender_name":"研究员","sender_avatar":""}}""",
        ) as ImRealtimeEvent.AgentMessageError
        assertEquals("session-1", error.payload.agentSessionRef)
    }

    @Test
    fun `decodes conversation labels updated`() {
        val event = ImEventDecoder.decode(
            """{"type":"im.conversation.labels.updated","data":{"conversation_id":"conv-1","labels":[{"id":"label-1","name":"重要","color":"#ef4444","is_system":false}]}}""",
        )

        val update = (event as ImRealtimeEvent.ConversationLabelsUpdated).payload
        assertEquals("conv-1", update.conversationId)
        assertEquals("label-1", update.labels.single().id)
        assertEquals("重要", update.labels.single().name)
    }

    @Test
    fun `decodes personal agent feedback events`() {
        assertEquals(
            ImRealtimeEvent.AiError("研究员", "请重新指定执行现场"),
            ImEventDecoder.decode(
                """{"type":"im.ai.error","data":{"agent_name":"研究员","reason":"请重新指定执行现场"}}""",
            ),
        )
        assertEquals(
            ImRealtimeEvent.AiSuggestTask("c1", 9, "研究员"),
            ImEventDecoder.decode(
                """{"type":"im.ai.suggest_task","data":{"conversation_id":"c1","message_id":9,"agent_name":"研究员"}}""",
            ),
        )
    }

    @Test
    fun `decodes user profile updated`() {
        val event = ImEventDecoder.decode(
            """{"type":"im.user.profile.updated","data":{"id":"user-2","nickname":"新昵称","username":"alice","avatar":"https://cdn.example/avatar.png","avatar_version":"7","revision":7}}""",
        ) as ImRealtimeEvent.UserProfileUpdated

        assertEquals("user-2", event.profile.userId)
        assertEquals("新昵称", event.profile.displayName)
        assertEquals("https://cdn.example/avatar.png", event.profile.avatar)
        assertEquals(7, event.profile.revision)
    }


    @Test
    fun `decodes new message from data envelope`() {
        val event = ImEventDecoder.decode(
            """
            {"type":"im.message","event_id":"e1","data":{
              "id":10,"seq":3,"conversation_id":"conv-1","sender_id":"u1",
              "sender_name":"Alice","content":"hi","message_type":0
            }}
            """.trimIndent(),
        )
        val message = (event as ImRealtimeEvent.Message).message
        assertEquals(10, message.id)
        assertEquals("conv-1", message.conversationId)
        assertEquals("hi", message.content)
    }

    @Test
    fun `decodes edited message`() {
        val event = ImEventDecoder.decode(
            """{"type":"im.message.edited","data":{"id":10,"content":"edited","edited_at":"2026-07-20T10:00:00Z"}}""",
        )
        val message = (event as ImRealtimeEvent.MessageEdited).message
        assertEquals("edited", message.content)
        assertTrue(message.isEdited)
    }

    @Test
    fun `decodes deleted message id`() {
        val event = ImEventDecoder.decode("""{"type":"im.message.deleted","data":{"message_id":42}}""")
        assertEquals(42, (event as ImRealtimeEvent.MessageDeleted).messageId)
    }

    @Test
    fun `decodes pin lifecycle`() {
        val pinned = ImEventDecoder.decode(
            """{"type":"im.message.pinned","data":{"id":12,"seq":12,"conversation_id":"c1","content":"重点","is_pinned":true}}""",
        ) as ImRealtimeEvent.MessagePinned
        assertEquals(12, pinned.message.id)
        assertTrue(pinned.message.isPinned)

        val unpinned = ImEventDecoder.decode(
            """{"type":"im.message.unpinned","data":{"message_id":12,"conversation_id":"c1"}}""",
        ) as ImRealtimeEvent.MessageUnpinned
        assertEquals(12, unpinned.messageId)
    }

    @Test
    fun `decodes reaction added and removed`() {
        val added = ImEventDecoder.decode(
            """{"type":"im.reaction.added","data":{"message_id":7,"user_id":"u2","emoji":"👍"}}""",
        ) as ImRealtimeEvent.Reaction
        assertEquals(7, added.messageId)
        assertEquals("u2", added.userId)
        assertEquals("👍", added.emoji)
        assertTrue(added.added)

        val removed = ImEventDecoder.decode(
            """{"type":"im.reaction.removed","data":{"message_id":7,"user_id":"u2","emoji":"👍"}}""",
        ) as ImRealtimeEvent.Reaction
        assertFalse(removed.added)
    }

    @Test
    fun `decodes read receipt`() {
        val event = ImEventDecoder.decode(
            """{"type":"im.read.receipt","data":{"conversation_id":"conv-1","user_id":"u3","last_read_seq":9}}""",
        ) as ImRealtimeEvent.ReadReceipt
        assertEquals("u3", event.payload.userId)
        assertEquals(9, event.payload.lastReadSeq)
    }

    @Test
    fun `decodes unread update`() {
        val event = ImEventDecoder.decode(
            """
            {"type":"im.unread.update","data":{
              "conversation_id":"conv-1","organization_id":"org-1","message_id":11,
              "message_seq":4,"sender_id":"u1","sender_name":"Alice","preview":"hi","mention":true
            }}
            """.trimIndent(),
        ) as ImRealtimeEvent.UnreadUpdate
        assertEquals("conv-1", event.payload.conversationId)
        assertEquals(4, event.payload.messageSeq)
        assertTrue(event.payload.mention)
    }

    @Test
    fun `decodes unread update marked_read writeback`() {
        val event = ImEventDecoder.decode(
            """{"type":"im.unread.update","data":{"conversation_id":"conv-1","marked_read":9}}""",
        ) as ImRealtimeEvent.UnreadUpdate
        assertEquals("conv-1", event.payload.conversationId)
        assertTrue(event.payload.isMarkedReadEvent)
    }

    @Test
    fun `new message unread update is not marked_read event`() {
        val event = ImEventDecoder.decode(
            """{"type":"im.unread.update","data":{"conversation_id":"conv-1","message_id":11,"preview":"hi"}}""",
        ) as ImRealtimeEvent.UnreadUpdate
        assertFalse(event.payload.isMarkedReadEvent)
    }

    @Test
    fun `decodes conversation new from data envelope`() {
        // 回归  issue 2：im.conversation.new 需解成 ConversationNew，data 为会话摘要。
        val event = ImEventDecoder.decode(
            """
            {"type":"im.conversation.new","event_id":"cn-1","data":{
              "id":"conv-9","organization_id":"org-1","type":1,"name":"李四",
              "member_count":2,"last_message_at":"2026-07-21T10:00:00Z","dm_peer_user_id":"u2"
            }}
            """.trimIndent(),
        ) as ImRealtimeEvent.ConversationNew
        assertEquals("conv-9", event.conversation.id)
        assertEquals("李四", event.conversation.name)
        assertEquals(ImConversationType.DM, event.conversation.type)
    }

    @Test
    fun `decodes typing from flat top-level fields`() {
        val event = ImEventDecoder.decode("""{"type":"im.typing","user_id":"u9"}""")
        assertEquals("u9", (event as ImRealtimeEvent.Typing).userId)
    }

    @Test
    fun `decodes conversation handoff and session share updates`() {
        assertTrue(
            ImEventDecoder.decode(
                """{"type":"im.conversation.updated","data":{"conversation_id":"c1","name":"新群名"}}""",
            ) is ImRealtimeEvent.ConversationChanged,
        )
        val handoff = ImEventDecoder.decode(
            """{"type":"im.handoff.update","data":{"handoff_id":"handoff-1"}}""",
        ) as ImRealtimeEvent.HandoffUpdate
        assertEquals("handoff-1", handoff.handoffId)
        val share = ImEventDecoder.decode(
            """{"type":"im.session_share.update","data":{"share_id":"share-1"}}""",
        ) as ImRealtimeEvent.SessionShareUpdate
        assertEquals("share-1", share.shareId)
    }

    @Test
    fun `typing without user id is dropped`() {
        assertNull(ImEventDecoder.decode("""{"type":"im.typing"}"""))
    }

    @Test
    fun `unrecognized type becomes Unknown`() {
        val event = ImEventDecoder.decode("""{"type":"im.future.event","data":{}}""")
        assertEquals("im.future.event", (event as ImRealtimeEvent.Unknown).type)
    }

    @Test
    fun `malformed json and missing type are dropped`() {
        assertNull(ImEventDecoder.decode("not-json"))
        assertNull(ImEventDecoder.decode("""{"data":{}}"""))
    }

    @Test
    fun `non string routing fields are dropped without throwing`() {
        assertNull(ImEventDecoder.decode("""{"type":{"unexpected":"im.message"},"data":{}}"""))
        assertNull(ImEventDecoder.decode("""{"type":42,"data":{}}"""))
        assertNull(ImEventDecoder.decode("""{"type":"im.typing","user_id":["u1"]}"""))
        assertNull(ImEventDecoder.decode("""{"type":"im.typing","user_id":true}"""))
    }

    @Test
    fun `envelope missing data is dropped`() {
        assertNull(ImEventDecoder.decode("""{"type":"im.message"}"""))
    }
}
