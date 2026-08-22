package com.tabtin.mobile.data.repository

import android.util.Log
import com.tabtin.mobile.data.api.NotificationApi
import com.tabtin.mobile.data.model.NotificationItem
import com.tabtin.mobile.data.model.WSEnvelope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

public data class NotificationState(
    val organizationId: String? = null,
    val notifications: List<NotificationItem> = emptyList(),
    val unreadCount: Int = 0,
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val isMarkingAllRead: Boolean = false,
    val markAllReadFailed: Boolean = false,
) {
    /** 列表和独立 count 请求任一路证明有未读时，都应保留批量已读入口。 */
    public val hasUnreadNotifications: Boolean
        get() = unreadCount > 0 || notifications.any { !it.isRead }
}

@Singleton
public class NotificationRepository @Inject constructor(
    private val api: NotificationApi,
) {
    private val _state = MutableStateFlow(NotificationState())
    public val state: StateFlow<NotificationState> = _state.asStateFlow()

    private var activationGeneration = 0
    private var listRequestSequence = 0
    private var localMutationRevision = 0

    public suspend fun activate(organizationId: String?) {
        if (_state.value.organizationId != organizationId) {
            activationGeneration += 1
            listRequestSequence += 1
            _state.value = NotificationState(organizationId = organizationId)
        }
        reload()
        reloadUnreadCount()
    }

    public suspend fun reload() {
        val organizationId = _state.value.organizationId
        val sequence = ++listRequestSequence
        val mutationRevision = localMutationRevision
        _state.update { it.copy(isLoading = it.notifications.isEmpty(), errorMessage = null) }
        try {
            val data = api.listNotifications(
                organizationId = organizationId,
                includePersonalInvitations = !organizationId.isNullOrBlank(),
            ).unwrap()
            if (sequence != listRequestSequence || _state.value.organizationId != organizationId) return
            _state.update { current ->
                val serverItems = data.items.sortedByDescending(NotificationItem::createdAt)
                current.copy(
                    notifications = if (mutationRevision == localMutationRevision) {
                        serverItems
                    } else {
                        mergeServerItems(serverItems, current.notifications)
                    },
                    isLoading = false,
                )
            }
        } catch (e: Exception) {
            if (sequence != listRequestSequence) return
            Log.w(TAG, "notification list reload failed: ${e.message}")
            _state.update { it.copy(isLoading = false, errorMessage = e.message) }
        }
    }

    public suspend fun reloadUnreadCount() {
        val organizationId = _state.value.organizationId
        val mutationRevision = localMutationRevision
        try {
            val count = api.getUnreadCount(
                organizationId = organizationId,
                includePersonalInvitations = !organizationId.isNullOrBlank(),
            ).unwrap().count
            if (_state.value.organizationId == organizationId && mutationRevision == localMutationRevision) {
                _state.update { it.copy(unreadCount = count.coerceAtLeast(0)) }
            }
        } catch (e: Exception) {
            Log.d(TAG, "notification unread reload failed: ${e.message}")
        }
    }

    public fun markRead(item: NotificationItem) {
        val currentItem = _state.value.notifications.firstOrNull { it.id == item.id }
        if (currentItem?.isRead ?: item.isRead) return
        localMutationRevision += 1
        _state.update { state ->
            state.copy(
                notifications = state.notifications.map {
                    if (it.id == item.id) it.copy(isRead = true) else it
                },
                unreadCount = (state.unreadCount - 1).coerceAtLeast(0),
            )
        }
    }

    public suspend fun persistRead(item: NotificationItem) {
        if (item.isRead) return
        try {
            api.markRead(item.id).requireSuccess()
        } catch (e: Exception) {
            Log.d(TAG, "mark notification read failed id=${item.id}: ${e.message}")
            reload()
            reloadUnreadCount()
        }
    }

    public suspend fun markAllRead() {
        val initialState = _state.value
        if (initialState.isMarkingAllRead || !initialState.hasUnreadNotifications) return
        val organizationId = initialState.organizationId
        val generation = activationGeneration
        val unreadIds = initialState.notifications.filterNot(NotificationItem::isRead).mapTo(mutableSetOf()) { it.id }
        val previousUnreadCount = maxOf(initialState.unreadCount, unreadIds.size)
        localMutationRevision += 1
        val optimisticMutationRevision = localMutationRevision
        _state.update { state ->
            state.copy(
                notifications = state.notifications.map { it.copy(isRead = true) },
                unreadCount = 0,
                isMarkingAllRead = true,
                markAllReadFailed = false,
            )
        }
        try {
            api.markAllRead(
                organizationId = organizationId,
                includePersonalInvitations = !organizationId.isNullOrBlank(),
            ).unwrap()
            if (!isActive(generation, organizationId)) return

            val hasConcurrentLocalMutation = localMutationRevision != optimisticMutationRevision
            if (!hasConcurrentLocalMutation) {
                reload()
                if (!isActive(generation, organizationId)) return
                if (localMutationRevision == optimisticMutationRevision) reloadUnreadCount()
                if (!isActive(generation, organizationId)) return
            }
            _state.update { it.copy(isMarkingAllRead = false) }
        } catch (e: CancellationException) {
            if (isActive(generation, organizationId)) {
                _state.update { it.copy(isMarkingAllRead = false) }
            }
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "mark all notifications read failed: ${e.message}")
            if (!isActive(generation, organizationId)) return

            val hasConcurrentLocalMutation = localMutationRevision != optimisticMutationRevision
            localMutationRevision += 1
            _state.update { state ->
                val restoredNotifications = state.notifications.map { item ->
                    if (item.id in unreadIds) item.copy(isRead = false) else item
                }
                val unlistedInitialUnreadCount = (previousUnreadCount - unreadIds.size).coerceAtLeast(0)
                state.copy(
                    notifications = restoredNotifications,
                    unreadCount = restoredNotifications.count { !it.isRead } + unlistedInitialUnreadCount,
                    isMarkingAllRead = false,
                    markAllReadFailed = true,
                )
            }
            if (!hasConcurrentLocalMutation) {
                reload()
                if (!isActive(generation, organizationId)) return
                if (localMutationRevision == optimisticMutationRevision + 1) reloadUnreadCount()
                if (!isActive(generation, organizationId)) return
            }
            _state.update {
                it.copy(
                    isMarkingAllRead = false,
                    markAllReadFailed = true,
                )
            }
        }
    }

    public fun consumeMarkAllReadFailure() {
        _state.update { it.copy(markAllReadFailed = false) }
    }

    private fun isActive(generation: Int, organizationId: String?): Boolean =
        activationGeneration == generation && _state.value.organizationId == organizationId

    public fun handleRealtimeEnvelope(envelope: WSEnvelope) {
        if (envelope.type != "agent.user.notification.new") return
        if (
            envelope.payload["metadata"]?.let { runCatching { it.jsonObject }.getOrNull() }
                ?.get("desktop_only")
                ?.jsonPrimitive
                ?.booleanOrNull == true
        ) return
        val item = envelope.toNotificationItem() ?: return
        val organizationId = _state.value.organizationId
        if (!organizationId.isNullOrBlank() &&
            item.organizationId.isNotBlank() &&
            item.organizationId != organizationId &&
            !item.type.startsWith(PERSONAL_INVITATION_TYPE_PREFIX)
        ) {
            return
        }
        localMutationRevision += 1
        _state.update { state ->
            val previous = state.notifications.firstOrNull { it.id == item.id }
            val notifications = listOf(item) + state.notifications.filterNot { it.id == item.id }
            val delta = (if (item.isRead) 0 else 1) - (if (previous?.isRead == false) 1 else 0)
            state.copy(
                notifications = notifications.sortedByDescending(NotificationItem::createdAt),
                unreadCount = (state.unreadCount + delta).coerceAtLeast(0),
            )
        }
    }

    private fun mergeServerItems(
        serverItems: List<NotificationItem>,
        localItems: List<NotificationItem>,
    ): List<NotificationItem> = buildMap {
        serverItems.forEach { put(it.id, it) }
        localItems.forEach { put(it.id, it) }
    }.values.sortedByDescending(NotificationItem::createdAt).take(50)

    public companion object {
        private const val TAG = "NotificationRepository"
        private const val PERSONAL_INVITATION_TYPE_PREFIX = "organization.invitation"
    }
}

private fun WSEnvelope.toNotificationItem(): NotificationItem? {
    val id = payload["id"]?.jsonPrimitive?.contentOrNull ?: return null
    val workspaceId = payload["workspace_id"]?.jsonPrimitive?.contentOrNull
    val projectId = payload["project_id"]?.jsonPrimitive?.contentOrNull
    return NotificationItem(
        id = id,
        type = payload["type"]?.jsonPrimitive?.contentOrNull ?: "system",
        title = payload["title"]?.jsonPrimitive?.contentOrNull ?: "",
        body = payload["body"]?.jsonPrimitive?.contentOrNull ?: "",
        metadata = payload["metadata"]?.let { runCatching { it.jsonObject }.getOrNull() } ?: JsonObject(emptyMap()),
        organizationId = payload["organization_id"]?.jsonPrimitive?.contentOrNull ?: "",
        workspaceId = workspaceId,
        projectId = projectId,
        // Keep the wire snapshot honest. Target resolution gives canonical scope precedence and
        // only consults this ambiguous host when no workspace/project field is available.
        legacyHostId = payload["space_id"]?.jsonPrimitive?.contentOrNull,
        workspaceName = payload["workspace_name"]?.jsonPrimitive?.contentOrNull,
        projectName = payload["project_name"]?.jsonPrimitive?.contentOrNull,
        priority = payload["priority"]?.jsonPrimitive?.contentOrNull,
        category = payload["category"]?.jsonPrimitive?.contentOrNull,
        sourceExtensionId = payload["source_extension_id"]?.jsonPrimitive?.contentOrNull,
        navigateTo = payload["navigate_to"]?.let { runCatching { it.jsonObject }.getOrNull() },
        isRead = payload["is_read"]?.jsonPrimitive?.booleanOrNull ?: false,
        readAt = payload["read_at"]?.jsonPrimitive?.contentOrNull,
        createdAt = payload["created_at"]?.jsonPrimitive?.contentOrNull ?: "",
    )
}
