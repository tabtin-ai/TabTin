package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.json as ApiJson
import com.tabtin.mobile.data.local.QueuedOutgoingMessageDao
import com.tabtin.mobile.data.local.QueuedOutgoingMessageEntity
import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import com.tabtin.mobile.data.model.MessageBlock
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.builtins.ListSerializer

public enum class QueuedOutgoingMessageStatus {
    WAITING,
    OFFLINE,
    SENDING,
    ACCEPTED,
    AWAITING_DEVICE,
    PERSISTED_EXECUTION_FAILED,
    FAILED,
}

public data class QueuedOutgoingMessage(
    val id: String,
    val sessionId: String,
    val text: String,
    val modelId: String?,
    val agentMode: String?,
    val approvalMode: String?,
    val blocks: List<MessageBlock>?,
    /** 入队时冻结；重试禁止读取此刻 Workbench。 */
    val focus: ConversationFocusContext?,
    val clientEventId: String,
    val serverMessageId: String?,
    val taskId: String?,
    val status: QueuedOutgoingMessageStatus,
    val attemptCount: Int,
    val lastError: String?,
    val createdAt: Long,
) {
    public val previewText: String
        get() = text.trim().ifEmpty {
            val count = blocks?.size ?: 0
            if (count > 0) "$count 个附件或上下文" else "待发送消息"
        }

    public val isAutoDrainable: Boolean
        get() = OutgoingQueuePolicy.isAutoDrainable(status)

    public val isAwaitingExecutionConfirmation: Boolean
        get() = OutgoingQueuePolicy.isAwaitingExecutionConfirmation(status)

    public val allowedLocalActions: Set<QueuedOutgoingMessageAction>
        get() = OutgoingQueuePolicy.allowedLocalActions(status)

    /**
     * Queue records freeze the user's requested values. Resolve them only when a
     * delivery is about to leave the device so a newly tightened organization
     * policy cannot be bypassed by an older local row.
     */
    public fun resolvingRuntimeConfiguration(
        permitsRelaxedApproval: Boolean,
    ): ConversationRuntimeConfiguration =
        ConversationRuntimeConfiguration.resolving(
            rawAgentMode = agentMode,
            rawApprovalMode = approvalMode,
            permitsRelaxedApproval = permitsRelaxedApproval,
        )
}

@Singleton
public class OutgoingMessageQueueRepository @Inject constructor(
    private val dao: QueuedOutgoingMessageDao,
) {
    public suspend fun list(sessionId: String): List<QueuedOutgoingMessage> =
        dao.listForSession(sessionId).map { it.toModel() }

    public suspend fun enqueue(
        sessionId: String,
        text: String,
        modelId: String?,
        runtimeConfiguration: ConversationRuntimeConfiguration,
        blocks: List<MessageBlock>?,
        status: QueuedOutgoingMessageStatus,
        lastError: String? = null,
        clientEventId: String = UUID.randomUUID().toString(),
        focus: ConversationFocusContext? = null,
    ): QueuedOutgoingMessage {
        // 首发草稿在“Room 已写入、草稿尚未来得及消费”之间崩溃时会重试同一个
        // client_event_id。不能用一次 upsert 把已 ACK 的事实降回 WAITING。
        dao.find(clientEventId)?.let { return it.toModel() }
        val now = System.currentTimeMillis()
        val entity = QueuedOutgoingMessageEntity(
            id = clientEventId,
            sessionId = sessionId,
            text = text,
            modelId = modelId,
            agentMode = runtimeConfiguration.agentMode.wireValue,
            approvalMode = runtimeConfiguration.approvalMode.wireValue,
            blocksJson = encodeBlocks(blocks),
            clientEventId = clientEventId,
            serverMessageId = null,
            taskId = null,
            focusJson = encodeFocus(focus),
            status = status.name,
            attemptCount = 0,
            lastError = lastError,
            createdAt = now,
            updatedAt = now,
        )
        dao.upsert(entity)
        return entity.toModel()
    }

    public suspend fun updateStatus(
        id: String,
        status: QueuedOutgoingMessageStatus,
        lastError: String? = null,
        incrementAttempt: Boolean = false,
    ) {
        val current = dao.find(id) ?: return
        dao.upsert(
            current.copy(
                status = status.name,
                lastError = lastError,
                attemptCount = current.attemptCount + if (incrementAttempt) 1 else 0,
                updatedAt = System.currentTimeMillis(),
            )
        )
    }

    public suspend fun recordAcknowledgement(
        id: String,
        status: QueuedOutgoingMessageStatus,
        clientEventId: String?,
        serverMessageId: String?,
        taskId: String?,
        lastError: String? = null,
        incrementAttempt: Boolean = false,
    ) {
        val current = dao.find(id) ?: return
        dao.upsert(
            current.copy(
                clientEventId = clientEventId?.takeIf { it.isNotBlank() }
                    ?: current.clientEventId
                    ?: current.id,
                serverMessageId = serverMessageId?.takeIf { it.isNotBlank() }
                    ?: current.serverMessageId,
                taskId = taskId?.takeIf { it.isNotBlank() } ?: current.taskId,
                status = status.name,
                lastError = lastError,
                attemptCount = current.attemptCount + if (incrementAttempt) 1 else 0,
                updatedAt = System.currentTimeMillis(),
            )
        )
    }

    /**
     * A cancelled websocket send has no ACK path to move its durable row out of SENDING.
     * Restore only in-flight rows for this session; ACCEPTED/FAILED rows are server facts and
     * must never be downgraded to a retryable state.
     */
    public suspend fun recoverInterruptedSends(sessionId: String): Int =
        dao.recoverSendingForSession(sessionId, System.currentTimeMillis())

    /** A USER mirror/history match proves persistence, not that execution started. */
    public suspend fun markPersisted(
        sessionId: String,
        identities: Set<String>,
    ): List<String> {
        if (identities.isEmpty()) return emptyList()
        val confirmed = dao.listForSession(sessionId).filter { entity ->
            val status = entity.status.toQueuedStatus()
            status == QueuedOutgoingMessageStatus.ACCEPTED &&
                sequenceOf(entity.id, entity.clientEventId, entity.serverMessageId)
                    .filterNotNull()
                    .any { it in identities }
        }
        confirmed.forEach { entity ->
            dao.upsert(
                entity.copy(
                    status = QueuedOutgoingMessageStatus.AWAITING_DEVICE.name,
                    lastError = null,
                    updatedAt = System.currentTimeMillis(),
                )
            )
        }
        return confirmed.map { it.id }
    }

    /** Remove a durable row only after assistant/runtime progress or task terminal is proven. */
    public suspend fun completeExecution(
        sessionId: String,
        identities: Set<String> = emptySet(),
        taskId: String? = null,
    ): List<String> {
        if (identities.isEmpty() && taskId.isNullOrBlank()) return emptyList()
        val completed = dao.listForSession(sessionId).filter { entity ->
            val status = entity.status.toQueuedStatus()
            val isPendingExecution = status == QueuedOutgoingMessageStatus.ACCEPTED ||
                status == QueuedOutgoingMessageStatus.AWAITING_DEVICE
            isPendingExecution && (
                sequenceOf(entity.id, entity.clientEventId, entity.serverMessageId)
                    .filterNotNull()
                    .any { it in identities } ||
                    (!taskId.isNullOrBlank() && entity.taskId == taskId)
                )
        }
        completed.forEach { dao.deleteById(it.id) }
        return completed.map { it.id }
    }

    /** Retry only a message that was never accepted by the server. */
    public suspend fun retryUnsent(id: String): Boolean {
        val current = dao.find(id) ?: return false
        if (QueuedOutgoingMessageAction.RETRY !in OutgoingQueuePolicy.allowedLocalActions(current.status.toQueuedStatus())) {
            return false
        }
        dao.upsert(
            current.copy(
                status = QueuedOutgoingMessageStatus.WAITING.name,
                lastError = null,
                updatedAt = System.currentTimeMillis(),
            ),
        )
        return true
    }

    /**
     * The USER message already exists on the server, but its route failed before execution.
     * Return the same durable row to WAITING so the existing idempotent send path retries with
     * the original client_event_id instead of creating a second message.
     */
    public suspend fun retryPersistedExecution(id: String): Boolean {
        val current = dao.find(id) ?: return false
        if (
            QueuedOutgoingMessageAction.RETRY_PERSISTED_EXECUTION !in
            OutgoingQueuePolicy.allowedLocalActions(current.status.toQueuedStatus())
        ) {
            return false
        }
        dao.upsert(
            current.copy(
                status = QueuedOutgoingMessageStatus.WAITING.name,
                lastError = null,
                updatedAt = System.currentTimeMillis(),
            ),
        )
        return true
    }

    /**
     * Remove an unsent row or stop showing local tracking for an already accepted row.
     * This intentionally does not make any server cancellation claim.
     */
    public suspend fun dismissLocalRecord(id: String): Boolean {
        val current = dao.find(id) ?: return false
        val actions = OutgoingQueuePolicy.allowedLocalActions(current.status.toQueuedStatus())
        if (
            QueuedOutgoingMessageAction.REMOVE_UNSENT !in actions &&
            QueuedOutgoingMessageAction.HIDE_ACCEPTED_TRACKING !in actions
        ) {
            return false
        }
        dao.delete(current)
        return true
    }

    private fun QueuedOutgoingMessageEntity.toModel(): QueuedOutgoingMessage =
        QueuedOutgoingMessage(
            id = id,
            sessionId = sessionId,
            text = text,
            modelId = modelId,
            agentMode = agentMode,
            approvalMode = approvalMode,
            blocks = decodeBlocks(blocksJson),
            focus = decodeFocus(focusJson),
            clientEventId = clientEventId?.takeIf { it.isNotBlank() } ?: id,
            serverMessageId = serverMessageId,
            taskId = taskId,
            status = status.toQueuedStatus(),
            attemptCount = attemptCount,
            lastError = lastError,
            createdAt = createdAt,
        )

    private fun String.toQueuedStatus(): QueuedOutgoingMessageStatus =
        runCatching { QueuedOutgoingMessageStatus.valueOf(this) }
            .getOrDefault(QueuedOutgoingMessageStatus.WAITING)

    private fun encodeBlocks(blocks: List<MessageBlock>?): String? =
        blocks?.takeIf { it.isNotEmpty() }?.let {
            runCatching {
                ApiJson.encodeToString(ListSerializer(MessageBlock.serializer()), it)
            }.getOrNull()
        }

    private fun decodeBlocks(raw: String?): List<MessageBlock>? =
        raw?.takeIf { it.isNotBlank() }?.let {
            runCatching {
                ApiJson.decodeFromString(ListSerializer(MessageBlock.serializer()), it)
            }.getOrNull()
        }

    private fun encodeFocus(focus: ConversationFocusContext?): String? =
        focus?.let {
            runCatching {
                ApiJson.encodeToString(ConversationFocusContext.serializer(), it)
            }.getOrNull()
        }

    private fun decodeFocus(raw: String?): ConversationFocusContext? =
        raw?.takeIf { it.isNotBlank() }?.let {
            runCatching {
                ApiJson.decodeFromString(ConversationFocusContext.serializer(), it)
            }.getOrNull()
        }
}
