package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.local.QueuedOutgoingMessageDao
import com.tabtin.mobile.data.local.QueuedOutgoingMessageEntity
import com.tabtin.mobile.data.model.ConversationAgentMode
import com.tabtin.mobile.data.model.ConversationApprovalMode
import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import com.tabtin.mobile.data.model.FocusTabSnapshot
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutgoingMessageQueueRepositoryTest {
    @Test
    fun `new queue row reuses client event id as primary key`() = runTest {
        val dao = FakeQueuedOutgoingMessageDao()
        val repository = OutgoingMessageQueueRepository(dao)

        val queued = repository.enqueue(
            sessionId = "session-1",
            text = "hello",
            modelId = "model-1",
            runtimeConfiguration = ConversationRuntimeConfiguration(
                agentMode = ConversationAgentMode.AGENT,
                approvalMode = ConversationApprovalMode.AUTO,
            ),
            blocks = null,
            status = QueuedOutgoingMessageStatus.WAITING,
            clientEventId = "client-1",
        )

        assertEquals("client-1", queued.id)
        assertEquals("client-1", queued.clientEventId)
        assertEquals("agent", queued.agentMode)
        assertEquals("auto", queued.approvalMode)
        assertEquals("client-1", dao.find("client-1")?.clientEventId)
        assertTrue(queued.isAutoDrainable)
    }

    @Test
    fun `re-enqueueing a stable draft message does not downgrade an accepted row`() = runTest {
        val dao = FakeQueuedOutgoingMessageDao()
        val repository = OutgoingMessageQueueRepository(dao)
        repository.enqueue(
            sessionId = "session-1",
            text = "first draft",
            modelId = "model-1",
            runtimeConfiguration = ConversationRuntimeConfiguration(),
            blocks = null,
            status = QueuedOutgoingMessageStatus.WAITING,
            clientEventId = "stable-first-message",
        )
        repository.recordAcknowledgement(
            id = "stable-first-message",
            status = QueuedOutgoingMessageStatus.ACCEPTED,
            clientEventId = "stable-first-message",
            serverMessageId = "server-message",
            taskId = "task",
        )

        val retried = repository.enqueue(
            sessionId = "session-1",
            text = "changed after crash",
            modelId = "another-model",
            runtimeConfiguration = ConversationRuntimeConfiguration(),
            blocks = null,
            status = QueuedOutgoingMessageStatus.WAITING,
            clientEventId = "stable-first-message",
        )

        assertEquals(QueuedOutgoingMessageStatus.ACCEPTED, retried.status)
        assertEquals("first draft", retried.text)
        assertEquals("server-message", retried.serverMessageId)
    }

    @Test
    fun `legacy null client event id falls back to queue id`() = runTest {
        val dao = FakeQueuedOutgoingMessageDao().apply {
            upsert(entity(id = "legacy-id", clientEventId = null, status = "WAITING"))
        }
        val queued = OutgoingMessageQueueRepository(dao).list("session-1").single()

        assertEquals("legacy-id", queued.clientEventId)
    }

    @Test
    fun `user persistence confirmation keeps row awaiting device`() = runTest {
        val dao = FakeQueuedOutgoingMessageDao()
        val repository = OutgoingMessageQueueRepository(dao)
        repository.enqueue(
            sessionId = "session-1",
            text = "hello",
            modelId = null,
            runtimeConfiguration = ConversationRuntimeConfiguration(),
            blocks = null,
            status = QueuedOutgoingMessageStatus.WAITING,
            clientEventId = "client-1",
        )

        repository.recordAcknowledgement(
            id = "client-1",
            status = QueuedOutgoingMessageStatus.ACCEPTED,
            clientEventId = "client-1",
            serverMessageId = "server-1",
            taskId = "task-1",
        )
        val accepted = repository.list("session-1").single()
        assertEquals(QueuedOutgoingMessageStatus.ACCEPTED, accepted.status)
        assertEquals("server-1", accepted.serverMessageId)
        assertEquals("task-1", accepted.taskId)
        assertFalse(accepted.isAutoDrainable)
        assertTrue(accepted.isAwaitingExecutionConfirmation)

        assertEquals(listOf("client-1"), repository.markPersisted("session-1", setOf("server-1")))
        val awaiting = repository.list("session-1").single()
        assertEquals(QueuedOutgoingMessageStatus.AWAITING_DEVICE, awaiting.status)
        assertEquals("client-1", awaiting.clientEventId)
        assertEquals("server-1", awaiting.serverMessageId)
        assertEquals("task-1", awaiting.taskId)

        assertEquals(
            listOf("client-1"),
            repository.completeExecution("session-1", setOf("client-1")),
        )
        assertNull(dao.find("client-1"))
    }

    @Test
    fun `failed persisted row is never deleted by mirror confirmation`() = runTest {
        val dao = FakeQueuedOutgoingMessageDao().apply {
            upsert(entity(id = "client-1", clientEventId = "client-1", status = "FAILED"))
        }
        val repository = OutgoingMessageQueueRepository(dao)

        assertTrue(repository.markPersisted("session-1", setOf("client-1")).isEmpty())
        assertEquals(QueuedOutgoingMessageStatus.FAILED, repository.list("session-1").single().status)
    }

    @Test
    fun `persisted execution failure retries with the original client event id`() = runTest {
        val dao = FakeQueuedOutgoingMessageDao().apply {
            upsert(
                entity(
                    id = "client-1",
                    clientEventId = "client-1",
                    status = "PERSISTED_EXECUTION_FAILED",
                ),
            )
        }
        val repository = OutgoingMessageQueueRepository(dao)

        assertFalse(repository.retryUnsent("client-1"))
        assertTrue(repository.retryPersistedExecution("client-1"))
        val retried = repository.list("session-1").single()
        assertEquals(QueuedOutgoingMessageStatus.WAITING, retried.status)
        assertEquals("client-1", retried.id)
        assertEquals("client-1", retried.clientEventId)
        assertNull(retried.lastError)

        assertFalse(repository.retryPersistedExecution("client-1"))
    }

    @Test
    fun `persisted execution failure can still hide local tracking`() = runTest {
        val dao = FakeQueuedOutgoingMessageDao().apply {
            upsert(
                entity(
                    id = "client-1",
                    clientEventId = "client-1",
                    status = "PERSISTED_EXECUTION_FAILED",
                ),
            )
        }
        val repository = OutgoingMessageQueueRepository(dao)

        assertEquals(
            QueuedOutgoingMessageStatus.PERSISTED_EXECUTION_FAILED,
            repository.list("session-1").single().status,
        )

        assertTrue(repository.dismissLocalRecord("client-1"))
        assertNull(dao.find("client-1"))
    }

    @Test
    fun `task terminal completes only matching awaiting row`() = runTest {
        val dao = FakeQueuedOutgoingMessageDao().apply {
            upsert(
                entity(id = "client-1", clientEventId = "client-1", status = "AWAITING_DEVICE")
                    .copy(taskId = "task-1")
            )
            upsert(
                entity(id = "client-2", clientEventId = "client-2", status = "AWAITING_DEVICE")
                    .copy(taskId = "task-2", createdAt = 2L)
            )
        }
        val repository = OutgoingMessageQueueRepository(dao)

        assertEquals(listOf("client-1"), repository.completeExecution("session-1", taskId = "task-1"))
        assertNull(dao.find("client-1"))
        assertEquals(QueuedOutgoingMessageStatus.AWAITING_DEVICE, repository.list("session-1").single().status)
    }

    @Test
    fun `enqueue freezes focus json and retry reads record not current workbench`() = runTest {
        val dao = FakeQueuedOutgoingMessageDao()
        val repository = OutgoingMessageQueueRepository(dao)
        val focusA = ConversationFocusContext(
            appType = "tabdoc",
            spaceId = "space-1",
            userTimeZone = "Asia/Shanghai",
            openTabs = listOf(
                FocusTabSnapshot(type = "tabdoc", id = "doc-a", title = "Doc A", active = true),
            ),
        )

        val queued = repository.enqueue(
            sessionId = "session-1",
            text = "voice from A",
            modelId = "model-1",
            runtimeConfiguration = ConversationRuntimeConfiguration(),
            blocks = null,
            status = QueuedOutgoingMessageStatus.WAITING,
            clientEventId = "client-focus",
            focus = focusA,
        )

        assertEquals("tabdoc", queued.focus?.appType)
        assertEquals("doc-a", queued.focus?.openTabs?.single()?.id)

        // Simulate Workbench now on resource B — retry must still restore A.
        val restored = repository.list("session-1").single()
        assertEquals("doc-a", restored.focus?.openTabs?.single()?.id)
        assertEquals(focusA, restored.focus)
    }

    @Test
    fun `legacy null focus json remains compatible`() = runTest {
        val dao = FakeQueuedOutgoingMessageDao().apply {
            upsert(entity(id = "legacy-id", clientEventId = "legacy-id", status = "WAITING"))
        }
        val queued = OutgoingMessageQueueRepository(dao).list("session-1").single()
        assertNull(queued.focus)
    }

    @Test
    fun `interrupted sends return to waiting without downgrading accepted rows`() = runTest {
        val dao = FakeQueuedOutgoingMessageDao().apply {
            upsert(entity(id = "sending-1", clientEventId = "sending-1", status = "SENDING"))
            upsert(entity(id = "accepted-1", clientEventId = "accepted-1", status = "ACCEPTED"))
            upsert(
                entity(id = "other-session", clientEventId = "other-session", status = "SENDING")
                    .copy(sessionId = "session-2")
            )
        }
        val repository = OutgoingMessageQueueRepository(dao)

        assertEquals(1, repository.recoverInterruptedSends("session-1"))
        assertEquals(QueuedOutgoingMessageStatus.WAITING, repository.list("session-1").first().status)
        assertEquals(QueuedOutgoingMessageStatus.ACCEPTED, repository.list("session-1").last().status)
        assertEquals(QueuedOutgoingMessageStatus.SENDING, repository.list("session-2").single().status)
    }

    private fun entity(
        id: String,
        clientEventId: String?,
        status: String,
    ): QueuedOutgoingMessageEntity = QueuedOutgoingMessageEntity(
        id = id,
        sessionId = "session-1",
        text = "hello",
        modelId = null,
        agentMode = null,
        approvalMode = null,
        blocksJson = null,
        clientEventId = clientEventId,
        serverMessageId = null,
        taskId = null,
        focusJson = null,
        status = status,
        attemptCount = 0,
        lastError = null,
        createdAt = 1L,
        updatedAt = 1L,
    )

    private class FakeQueuedOutgoingMessageDao : QueuedOutgoingMessageDao {
        private val rows = linkedMapOf<String, QueuedOutgoingMessageEntity>()

        override suspend fun listForSession(sessionId: String): List<QueuedOutgoingMessageEntity> =
            rows.values.filter { it.sessionId == sessionId }.sortedBy { it.createdAt }

        override suspend fun find(id: String): QueuedOutgoingMessageEntity? = rows[id]

        override suspend fun upsert(entity: QueuedOutgoingMessageEntity) {
            rows[entity.id] = entity
        }

        override suspend fun delete(entity: QueuedOutgoingMessageEntity) {
            rows.remove(entity.id)
        }

        override suspend fun deleteById(id: String) {
            rows.remove(id)
        }

        override suspend fun recoverSendingForSession(sessionId: String, updatedAt: Long): Int {
            val interrupted = rows.values.filter { it.sessionId == sessionId && it.status == "SENDING" }
            interrupted.forEach { row ->
                rows[row.id] = row.copy(
                    status = "WAITING",
                    lastError = null,
                    updatedAt = updatedAt,
                )
            }
            return interrupted.size
        }
    }
}
