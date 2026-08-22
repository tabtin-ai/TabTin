package com.tabtin.mobile.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutgoingQueuePolicyTest {

    @Test
    fun `only unsent rows offer retry or removal`() {
        assertEquals(
            setOf(QueuedOutgoingMessageAction.REMOVE_UNSENT),
            OutgoingQueuePolicy.allowedLocalActions(QueuedOutgoingMessageStatus.WAITING),
        )
        assertEquals(
            setOf(
                QueuedOutgoingMessageAction.RETRY,
                QueuedOutgoingMessageAction.REMOVE_UNSENT,
            ),
            OutgoingQueuePolicy.allowedLocalActions(QueuedOutgoingMessageStatus.OFFLINE),
        )
        assertEquals(
            setOf(
                QueuedOutgoingMessageAction.RETRY,
                QueuedOutgoingMessageAction.REMOVE_UNSENT,
            ),
            OutgoingQueuePolicy.allowedLocalActions(QueuedOutgoingMessageStatus.FAILED),
        )
    }

    @Test
    fun `persisted execution failure allows rerouting and hiding local tracking`() {
        assertEquals(
            setOf(
                QueuedOutgoingMessageAction.RETRY_PERSISTED_EXECUTION,
                QueuedOutgoingMessageAction.HIDE_ACCEPTED_TRACKING,
            ),
            OutgoingQueuePolicy.allowedLocalActions(
                QueuedOutgoingMessageStatus.PERSISTED_EXECUTION_FAILED,
            ),
        )
    }

    @Test
    fun `in flight rows do not offer destructive local actions`() {
        assertEquals(
            emptySet<QueuedOutgoingMessageAction>(),
            OutgoingQueuePolicy.allowedLocalActions(QueuedOutgoingMessageStatus.SENDING),
        )
    }

    @Test
    fun `acknowledged delivery uses execution state for device waiting`() {
        assertEquals(
            QueuedOutgoingMessageStatus.AWAITING_DEVICE,
            OutgoingQueuePolicy.statusForAcknowledgedDelivery("persisted", "awaiting_device"),
        )
        assertEquals(
            QueuedOutgoingMessageStatus.AWAITING_DEVICE,
            OutgoingQueuePolicy.statusForAcknowledgedDelivery("persisted", "device_offline"),
        )
        assertEquals(
            QueuedOutgoingMessageStatus.PERSISTED_EXECUTION_FAILED,
            OutgoingQueuePolicy.statusForAcknowledgedDelivery("persisted", "failed_after_persist"),
        )
        assertEquals(
            QueuedOutgoingMessageStatus.ACCEPTED,
            OutgoingQueuePolicy.statusForAcknowledgedDelivery("persisted", "running"),
        )
    }

    @Test
    fun `strip hides happy path and idle waiting`() {
        assertFalse(
            OutgoingQueuePolicy.shouldShowStrip(QueuedOutgoingMessageStatus.SENDING, agentBusy = true),
        )
        assertFalse(
            OutgoingQueuePolicy.shouldShowStrip(QueuedOutgoingMessageStatus.ACCEPTED, agentBusy = true),
        )
        assertFalse(
            OutgoingQueuePolicy.shouldShowStrip(QueuedOutgoingMessageStatus.AWAITING_DEVICE, agentBusy = true),
        )
        assertFalse(
            OutgoingQueuePolicy.shouldShowStrip(QueuedOutgoingMessageStatus.WAITING, agentBusy = false),
        )
    }

    @Test
    fun `strip shows failures offline and busy waiting`() {
        assertTrue(
            OutgoingQueuePolicy.shouldShowStrip(QueuedOutgoingMessageStatus.OFFLINE, agentBusy = false),
        )
        assertTrue(
            OutgoingQueuePolicy.shouldShowStrip(QueuedOutgoingMessageStatus.FAILED, agentBusy = false),
        )
        assertTrue(
            OutgoingQueuePolicy.shouldShowStrip(
                QueuedOutgoingMessageStatus.PERSISTED_EXECUTION_FAILED,
                agentBusy = false,
            ),
        )
        assertTrue(
            OutgoingQueuePolicy.shouldShowStrip(QueuedOutgoingMessageStatus.WAITING, agentBusy = true),
        )
    }

    @Test
    fun `busy strip keeps FIFO order and previews for every waiting message`() {
        val first = queued("q1", "先改首页文案")
        val second = queued("q2", "再补安卓截图")
        val visible = OutgoingQueuePolicy.stripMessages(listOf(first, second), agentBusy = true)

        assertEquals(listOf("q1", "q2"), visible.map { it.id })
        assertEquals(listOf("先改首页文案", "再补安卓截图"), visible.map { it.previewText })
    }

    private fun queued(id: String, text: String): QueuedOutgoingMessage = QueuedOutgoingMessage(
        id = id,
        sessionId = "session-1",
        text = text,
        modelId = null,
        agentMode = "agent",
        approvalMode = "auto",
        blocks = null,
        focus = null,
        clientEventId = id,
        serverMessageId = null,
        taskId = null,
        status = QueuedOutgoingMessageStatus.WAITING,
        attemptCount = 0,
        lastError = null,
        createdAt = 0L,
    )
}
