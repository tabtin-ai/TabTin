package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.websocket.AckResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutgoingMessageDeliveryTest {
    @Test
    fun `persisted NAK with final execution state preserves delivered user`() {
        assertTrue(nak(delivery = "persisted", executionState = "failed_after_persist").isPersistedDeliveryFailure())
    }

    @Test
    fun `legacy persisted NAK without execution state still preserves delivered user`() {
        assertTrue(nak(delivery = "persisted", executionState = null).isPersistedDeliveryFailure())
    }

    @Test
    fun `ordinary NAK is not treated as persisted`() {
        assertFalse(nak(delivery = null, executionState = null).isPersistedDeliveryFailure())
    }

    @Test
    fun `persisted NAK waiting for device is not a hard execution failure`() {
        assertFalse(nak(delivery = "persisted", executionState = "awaiting_device").isPersistedDeliveryFailure())
        assertEquals(
            QueuedOutgoingMessageStatus.AWAITING_DEVICE,
            OutgoingQueuePolicy.statusForAcknowledgedDelivery("persisted", "awaiting_device"),
        )
    }

    @Test
    fun `matching user alone proves persistence but not execution`() {
        val messages = listOf(ChatMessage(id = "user-1", role = "user", clientEventId = "client-1"))

        assertEquals(
            OutgoingHistoryEvidence.PERSISTED,
            outgoingHistoryEvidence(messages, setOf("client-1")),
        )
    }

    @Test
    fun `assistant after user is not enough to prove queued turn started`() {
        val messages = listOf(
            ChatMessage(id = "user-1", role = "user", clientEventId = "client-1"),
            ChatMessage(id = "assistant-1", role = "assistant"),
            ChatMessage(id = "user-2", role = "user", clientEventId = "client-2"),
        )

        assertEquals(
            OutgoingHistoryEvidence.PERSISTED,
            outgoingHistoryEvidence(messages, setOf("client-1")),
        )
    }

    @Test
    fun `assistant after next user does not prove earlier turn started`() {
        val messages = listOf(
            ChatMessage(id = "user-1", role = "user", clientEventId = "client-1"),
            ChatMessage(id = "user-2", role = "user", clientEventId = "client-2"),
            ChatMessage(id = "assistant-2", role = "assistant"),
        )

        assertEquals(
            OutgoingHistoryEvidence.PERSISTED,
            outgoingHistoryEvidence(messages, setOf("client-1")),
        )
    }

    @Test
    fun `assistant source client event id proves exact execution started`() {
        val messages = listOf(
            ChatMessage(id = "user-1", role = "user", clientEventId = "client-1"),
            ChatMessage(
                id = "assistant-1",
                role = "assistant",
                metadata = mapOf(
                    "source_client_event_id" to kotlinx.serialization.json.JsonPrimitive("client-1")
                ),
            ),
        )

        assertEquals(
            OutgoingHistoryEvidence.EXECUTION_STARTED,
            outgoingHistoryEvidence(messages, setOf("client-1")),
        )
    }

    private fun nak(delivery: String?, executionState: String?): AckResult.Nak = AckResult.Nak(
        errorCode = "device_offline",
        errorMessage = "",
        errorCategory = null,
        retryable = true,
        delivery = delivery,
        executionState = executionState,
    )
}
