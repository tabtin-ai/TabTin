package com.tabtin.mobile.data.im

import com.tabtin.mobile.data.api.json
import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.http.GET
import retrofit2.http.POST

class ImApiSessionShareRouteTest {

    @Test
    fun `session share mutations use the same conversation control plane as desktop`() {
        val methods = ImApi::class.java.methods.associateBy { it.name }
        val chatMethods = com.tabtin.mobile.data.api.ChatApi::class.java.methods.associateBy { it.name }

        val create = requireNotNull(methods.getValue("shareChatSession").getAnnotation(POST::class.java))
        val detail = requireNotNull(methods.getValue("getSessionShare").getAnnotation(GET::class.java))
        val incoming = requireNotNull(methods.getValue("listIncomingSessionShares").getAnnotation(GET::class.java))
        val sharedChat = requireNotNull(chatMethods.getValue("sharedChat").getAnnotation(POST::class.java))
        val executionStatus = requireNotNull(chatMethods.getValue("sharedExecutionStatus").getAnnotation(GET::class.java))
        val revoke = requireNotNull(methods.getValue("revokeSessionShare").getAnnotation(POST::class.java))
        val retryDelivery = requireNotNull(methods.getValue("retrySessionShareV2Delivery").getAnnotation(POST::class.java))
        val createContinuation = requireNotNull(methods.getValue("createSessionContinuation").getAnnotation(POST::class.java))
        val continuationBatch = requireNotNull(methods.getValue("batchGetSessionContinuations").getAnnotation(POST::class.java))
        val createContinuationTask = requireNotNull(
            methods.getValue("createTaskFromSessionContinuation").getAnnotation(POST::class.java),
        )

        assertEquals("chat/session-shares", create.value)
        assertEquals("chat/session-shares/{shareId}", detail.value)
        assertEquals("chat/session-shares", incoming.value)
        assertEquals("chat/sessions/{sessionId}/shared-chat", sharedChat.value)
        assertEquals("chat/sessions/{sessionId}/shared-execution-status", executionStatus.value)
        assertEquals("chat/session-shares/{shareId}/revoke", revoke.value)
        assertEquals("chat/session-shares/{shareId}/delivery/retry", retryDelivery.value)
        assertEquals("chat/session-continuations", createContinuation.value)
        assertEquals("chat/session-continuations/batch-get", continuationBatch.value)
        assertEquals(
            "chat/session-continuations/{objectId}/create-task",
            createContinuationTask.value,
        )
    }

    @Test
    fun `session share response accepts message ids beyond signed int range`() {
        val response = json.decodeFromString<ImSessionShareResponse>(
            """
            {
              "id": "share-1",
              "session_id": "session-1",
              "grantee_user_id": "user-2",
              "message_id": 3640214238
            }
            """.trimIndent(),
        )

        assertEquals(3_640_214_238L, response.messageId)
    }
}
