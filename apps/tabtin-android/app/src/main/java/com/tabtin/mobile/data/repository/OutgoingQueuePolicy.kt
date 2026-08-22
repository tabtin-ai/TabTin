package com.tabtin.mobile.data.repository

/** 本机队列动作；它们不会替代服务端对已送达消息的控制权。 */
public enum class QueuedOutgoingMessageAction {
    RETRY,
    RETRY_PERSISTED_EXECUTION,
    REMOVE_UNSENT,
    HIDE_ACCEPTED_TRACKING,
}

/**
 * 集中解释队列状态的本机安全边界。
 *
 * 尚未送达服务端的记录可以普通重试或移除。保存后执行失败可以复用原
 * client_event_id 重新路由执行，也可以停止本机跟踪；已受理或等待设备的记录
 * 仍不能本地重试，避免重复任务或让用户误以为服务端任务已被取消。
 */
public object OutgoingQueuePolicy {
    private val DEVICE_WAITING_STATES = setOf(
        "awaiting_device",
        "waiting_for_device",
        "device_offline",
    )

    public fun allowedLocalActions(
        status: QueuedOutgoingMessageStatus,
    ): Set<QueuedOutgoingMessageAction> = when (status) {
        QueuedOutgoingMessageStatus.WAITING -> setOf(QueuedOutgoingMessageAction.REMOVE_UNSENT)
        QueuedOutgoingMessageStatus.OFFLINE,
        QueuedOutgoingMessageStatus.FAILED -> setOf(
            QueuedOutgoingMessageAction.RETRY,
            QueuedOutgoingMessageAction.REMOVE_UNSENT,
        )
        QueuedOutgoingMessageStatus.ACCEPTED,
        QueuedOutgoingMessageStatus.AWAITING_DEVICE ->
            setOf(QueuedOutgoingMessageAction.HIDE_ACCEPTED_TRACKING)
        QueuedOutgoingMessageStatus.PERSISTED_EXECUTION_FAILED -> setOf(
            QueuedOutgoingMessageAction.RETRY_PERSISTED_EXECUTION,
            QueuedOutgoingMessageAction.HIDE_ACCEPTED_TRACKING,
        )
        QueuedOutgoingMessageStatus.SENDING -> emptySet()
    }

    public fun isAutoDrainable(status: QueuedOutgoingMessageStatus): Boolean =
        status == QueuedOutgoingMessageStatus.WAITING ||
            status == QueuedOutgoingMessageStatus.OFFLINE ||
            status == QueuedOutgoingMessageStatus.SENDING

    public fun isAwaitingExecutionConfirmation(status: QueuedOutgoingMessageStatus): Boolean =
        status == QueuedOutgoingMessageStatus.ACCEPTED ||
            status == QueuedOutgoingMessageStatus.AWAITING_DEVICE

    /**
     * `delivery` 只说明消息接收情况；`execution_state` 才决定是否在等设备。
     * 对齐 iOS [OutgoingQueuePolicy.statusForAcknowledgedDelivery]。
     */
    public fun statusForAcknowledgedDelivery(
        delivery: String?,
        executionState: String?,
    ): QueuedOutgoingMessageStatus {
        val execution = (executionState ?: "")
            .trim()
            .lowercase()
            .replace('-', '_')
            .replace(' ', '_')
        if (execution == "failed_after_persist") {
            return QueuedOutgoingMessageStatus.PERSISTED_EXECUTION_FAILED
        }
        if (execution in DEVICE_WAITING_STATES) {
            return QueuedOutgoingMessageStatus.AWAITING_DEVICE
        }
        return QueuedOutgoingMessageStatus.ACCEPTED
    }

    /**
     * 对齐 iOS ：happy-path（sending/accepted/awaiting_device）不展示条带；
     * waiting 仅在 Agent 忙时展示；offline/failed/persisted_execution_failed 始终展示。
     */
    public fun shouldShowStrip(
        status: QueuedOutgoingMessageStatus,
        agentBusy: Boolean,
    ): Boolean = when (status) {
        QueuedOutgoingMessageStatus.OFFLINE,
        QueuedOutgoingMessageStatus.FAILED,
        QueuedOutgoingMessageStatus.PERSISTED_EXECUTION_FAILED -> true
        QueuedOutgoingMessageStatus.WAITING -> agentBusy
        QueuedOutgoingMessageStatus.SENDING,
        QueuedOutgoingMessageStatus.ACCEPTED,
        QueuedOutgoingMessageStatus.AWAITING_DEVICE -> false
    }

    public fun stripMessages(
        messages: List<QueuedOutgoingMessage>,
        agentBusy: Boolean,
    ): List<QueuedOutgoingMessage> = messages.filter { shouldShowStrip(it.status, agentBusy) }
}
