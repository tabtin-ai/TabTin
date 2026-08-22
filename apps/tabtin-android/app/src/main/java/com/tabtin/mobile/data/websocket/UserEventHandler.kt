package com.tabtin.mobile.data.websocket

import android.util.Log
import com.tabtin.mobile.data.im.ImCardStatusMemoryCache
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.repository.ChatRepository
import com.tabtin.mobile.data.repository.PendingInteractionRepository
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.NotificationRepository
import com.tabtin.mobile.data.repository.SessionListActivityStore
import com.tabtin.mobile.data.repository.SessionListActivityUpdate
import com.tabtin.mobile.data.repository.SessionReadStateStore
import com.tabtin.mobile.data.repository.SessionRunStateStore
import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 用户级 WS 事件（`agent.user.*`）：auth 后由后端加入 `user.{user_id}` group，无需显式 subscribe。
 * 与 iOS [UserEventHandler] 对齐。
 */
@Singleton
public class UserEventHandler @Inject constructor(
    private val webSocketService: WebSocketService,
    private val chatRepository: ChatRepository,
    private val organizationRepository: OrganizationRepository,
    private val pendingInteractionRepository: PendingInteractionRepository,
    private val notificationRepository: NotificationRepository,
    private val sessionRunStateStore: SessionRunStateStore,
    private val sessionReadStateStore: SessionReadStateStore,
    private val sessionListActivityStore: SessionListActivityStore,
    private val tokenManager: TokenManager,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    @Volatile
    private var started = false

    /**
     * permission.changed debounce job —— 短时间内多次事件只触发最后一次 loadOrganizations，
     * 避免同 batch 权限变更（如批量调整成员角色）触发 N 次全量刷新（详见 L_W4_2）。
     */
    private var permissionDebounceJob: Job? = null
    private var pendingInteractionRefreshJob: Job? = null

    public fun start() {
        if (started) return
        started = true
        webSocketService.onEnvelope(HANDLER_KEY, ::handleEnvelope)
        subscribeContextSyncUserTopic()
        pendingInteractionRepository.start()
        startPendingInteractionReconnectRefresh()
        scope.launch { pendingInteractionRepository.refreshAll() }
        Log.i(TAG, "用户级事件 handler 已注册")
    }

    /**
     * 注销 envelope handler。当前 Singleton 模型下一般不需要主动调用——
     * 与 iOS [UserEventHandler.stop] API 对齐，留接口供未来"切账号清理"
     * 之类的治理场景使用（详见 L_W4_3）。
     */
    public fun stop() {
        if (!started) return
        started = false
        permissionDebounceJob?.cancel()
        permissionDebounceJob = null
        pendingInteractionRefreshJob?.cancel()
        pendingInteractionRefreshJob = null
        webSocketService.removeHandler(HANDLER_KEY)
        currentContextSyncUserTopic()?.let { webSocketService.unsubscribe(listOf(it)) }
        pendingInteractionRepository.stop()
        Log.i(TAG, "用户级事件 handler 已注销")
    }

    private fun startPendingInteractionReconnectRefresh() {
        pendingInteractionRefreshJob?.cancel()
        pendingInteractionRefreshJob = scope.launch {
            var wasConnected = webSocketService.connectionState.value == WSConnectionState.Connected
            webSocketService.connectionState.collect { state ->
                val isConnected = state == WSConnectionState.Connected
                if (isConnected && !wasConnected) {
                    pendingInteractionRepository.refreshAll()
                }
                wasConnected = isConnected
            }
        }
    }

    private fun handleEnvelope(envelope: WSEnvelope) {
        if (handleResourceAccessEvent(envelope)) return
        SessionStateRealtimeEventDecoder.decode(envelope)?.let { event ->
            routeSessionStateUpdate(event)
            return
        }
        if (!envelope.type.startsWith(EVENT_PREFIX)) return
        when (envelope.type.removePrefix(EVENT_PREFIX)) {
            "title_updated" -> routeTitleUpdate(envelope)
            "notification.new" -> handleNotificationNew(envelope)
            "permission.changed" -> handlePermissionChanged(envelope)
            "interaction_requested",
            "interaction_resolved",
            "interaction_expired" -> pendingInteractionRepository.handleUserEvent(envelope)
            else -> Log.d(TAG, "未知用户级事件: ${envelope.type}")
        }
    }

    private fun subscribeContextSyncUserTopic() {
        val topic = currentContextSyncUserTopic() ?: return
        webSocketService.subscribe(listOf(topic))
    }

    private fun currentContextSyncUserTopic(): String? {
        val userId = tokenManager.userId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return "context.sync.user.$userId"
    }

    private fun handleResourceAccessEvent(envelope: WSEnvelope): Boolean {
        if (envelope.type !in RESOURCE_ACCESS_EVENT_TYPES) return false
        val topic = currentContextSyncUserTopic()
        if (topic != null && envelope.topic != null && envelope.topic != topic) return true
        ImCardStatusMemoryCache.handleResourceAccessEvent(
            eventType = envelope.type,
            resourceType = envelope.payloadString("resource_type"),
            resourceId = envelope.payloadString("resource_id"),
        )
        Log.i(TAG, "云资源权限事件: type=${envelope.type} resource=${envelope.payloadString("resource_id")?.take(8)}…")
        return true
    }

    private fun routeTitleUpdate(envelope: WSEnvelope) {
        val sessionId = envelope.payloadString("session_id") ?: return
        val title = envelope.payloadString("title") ?: return
        if (sessionId.isBlank() || title.isBlank()) {
            Log.w(TAG, "title_updated 缺少 session_id 或 title")
            return
        }
        Log.i(TAG, "标题更新: session=${sessionId.take(8)}…")
        chatRepository.applyRemoteSessionTitle(sessionId, title)
    }

    private fun routeSessionStateUpdate(event: SessionStateRealtimeEvent) {
        val selectedOrganizationId = organizationRepository.selectedOrganization.value?.id
        if (!shouldApplySessionStateForOrganization(event.organizationId, selectedOrganizationId)) {
            Log.w(TAG, "忽略非当前组织的会话状态")
            return
        }
        when (event) {
            is SessionStateRealtimeEvent.RunStateUpdated -> {
                if (sessionRunStateStore.accept(event.sessionId, event.runState)) {
                    Log.i(
                        TAG,
                        "运行态更新: sequence=${event.runState.sequence} " +
                            "revision=${event.runState.revision} status=${event.runState.status}",
                    )
                }
            }

            is SessionStateRealtimeEvent.ReadStateUpdated -> {
                if (sessionReadStateStore.accept(event.sessionId, event.readState)) {
                    Log.i(TAG, "阅读水位更新")
                }
            }

            is SessionStateRealtimeEvent.ActivityUpdated -> {
                val accepted = sessionListActivityStore.accept(
                    SessionListActivityUpdate(
                        sessionId = event.sessionId,
                        organizationId = event.organizationId,
                        reason = event.reason,
                        title = event.title,
                        status = event.status,
                        workspaceId = event.workspaceId,
                        projectId = event.projectId,
                        agentId = event.agentId,
                        lastMessageAt = event.lastMessageAt,
                        updatedAt = event.updatedAt,
                        createdAt = event.createdAt,
                        threadId = event.threadId,
                    ),
                )
                if (accepted) {
                    Log.i(
                        TAG,
                        "会话活动更新: session=${event.sessionId.take(8)}… reason=${event.reason}",
                    )
                }
            }
        }
    }

    private fun handleNotificationNew(envelope: WSEnvelope) {
        notificationRepository.handleRealtimeEnvelope(envelope)
        val payloadType = envelope.payload["type"]?.jsonPrimitive?.contentOrNull ?: return
        Log.i(TAG, "收到通知: type=$payloadType")
        if (payloadType.startsWith("organization.invitation")) {
            organizationRepository.notifyInvitationInboxMayHaveChanged()
        }
    }

    private fun handlePermissionChanged(envelope: WSEnvelope) {
        val organizationId = envelope.payloadString("organization_id") ?: ""
        val spaceId = envelope.payloadString("space_id") ?: ""
        Log.i(TAG, "权限变更: organization=${organizationId.take(8)}… space=${spaceId.take(8)}…")

        // L_W4_2 debounce：批量权限变更（如一次性给多个成员调角色）会在 100ms
        // 内连发 N 个 permission.changed，未去重时会触发 N 次 loadOrganizations 全量
        // 拉取 + organization list 闪烁。这里取消上一个未触发的 job，只保留最后一次。
        permissionDebounceJob?.cancel()
        permissionDebounceJob = scope.launch {
            try {
                delay(PERMISSION_DEBOUNCE_MS)
                organizationRepository.loadOrganizations()
            } catch (_: kotlinx.coroutines.CancellationException) {
                // debounce 取消是预期行为，不打 warning
            } catch (e: Exception) {
                Log.w(TAG, "loadOrganizations after permission.changed: ${e.message}")
            }
        }
    }

    private companion object {
        private const val TAG = "UserEventHandler"
        private const val HANDLER_KEY = "user-level-events"
        private const val EVENT_PREFIX = "agent.user."
        private const val PERMISSION_DEBOUNCE_MS = 100L
        private val RESOURCE_ACCESS_EVENT_TYPES = setOf(
            "resource_access_granted",
            "resource_access_changed",
            "resource_access_revoked",
        )
    }
}
