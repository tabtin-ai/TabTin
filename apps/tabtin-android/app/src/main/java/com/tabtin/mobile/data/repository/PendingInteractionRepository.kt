package com.tabtin.mobile.data.repository

import android.util.Log
import com.tabtin.mobile.data.api.ChatApi
import com.tabtin.mobile.data.model.PendingInteraction
import com.tabtin.mobile.data.model.WSEnvelope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class PendingInteractionRepository @Inject constructor(
    private val chatApi: ChatApi,
) {
    private val interactions = ConcurrentHashMap<String, PendingInteraction>()
    private val terminalKeys = ConcurrentHashMap.newKeySet<String>()
    private val terminalKeyOrder = ConcurrentLinkedQueue<String>()
    private val _updates = MutableSharedFlow<PendingInteractionUpdate>(extraBufferCapacity = 16)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var expiryJob: Job? = null
    public val updates: SharedFlow<PendingInteractionUpdate> = _updates.asSharedFlow()

    // 可观察快照：存在待处理事项的 sessionId 集合。除 `refreshAll` 为补回重连
    // 期间新出现的事项而补发 Requested 外，updates 由 WS 事件 / 过期 sweep 驱动；
    // 会话列表 pill 这类「订阅当前状态」的消费方需要 StateFlow 语义。
    private val _pendingSessionIds = MutableStateFlow<Set<String>>(emptySet())
    public val pendingSessionIds: StateFlow<Set<String>> = _pendingSessionIds.asStateFlow()

    public fun start() {
        if (expiryJob != null) return
        expiryJob = scope.launch {
            while (true) {
                delay(1_000L)
                sweepExpiredInteractions()
            }
        }
    }

    public fun stop() {
        expiryJob?.cancel()
        expiryJob = null
        clear()
    }

    public suspend fun refreshAll(organizationId: String? = null): List<PendingInteraction> {
        return try {
            val items = chatApi.getPendingInteractions(organizationId).unwrap().interactions
            // WebSocket 在后台期间可能错过 interaction_requested。只为这次
            // 全量同步中新发现的事项补发事件，让仍打开着的会话投影出 HITL 卡；
            // 已存在的事项不重复投影。
            merge(items).forEach { interaction ->
                _updates.tryEmit(PendingInteractionUpdate.Requested(interaction))
            }
            items
        } catch (e: Exception) {
            Log.w(TAG, "refreshAll failed: ${e.message}")
            emptyList()
        }
    }

    public suspend fun refreshSession(sessionId: String): List<PendingInteraction> {
        return try {
            val items = chatApi.getSessionPendingInteractions(sessionId).unwrap().interactions
            merge(items)
            pendingForSession(sessionId)
        } catch (e: Exception) {
            Log.w(TAG, "refreshSession failed: ${e.message}")
            emptyList()
        }
    }

    public fun handleUserEvent(envelope: WSEnvelope) {
        if (!envelope.type.startsWith(USER_INTERACTION_PREFIX)) return
        val interactionJson = envelope.payload["interaction"] ?: run {
            Log.w(TAG, "interaction user event missing payload.interaction")
            return
        }
        val interaction = try {
            json.decodeFromJsonElement(PendingInteraction.serializer(), interactionJson)
        } catch (e: Exception) {
            Log.w(TAG, "decode interaction failed: ${e.message}")
            return
        }
        when (envelope.type) {
            EVENT_REQUESTED -> {
                if (!interaction.isPending || interaction.isExpired || terminalKeys.contains(interaction.stableKey)) {
                    merge(listOf(interaction))
                    return
                }
                // 与 refreshAll 对齐：仅对新进本地快照的事项 emit，避免 stream + WS 双投递重复弹 Ask User。
                val newlyPending = merge(listOf(interaction))
                if (newlyPending.isNotEmpty()) {
                    _updates.tryEmit(PendingInteractionUpdate.Requested(interaction))
                }
            }
            EVENT_RESOLVED, EVENT_EXPIRED -> {
                rememberTerminalKey(interaction.stableKey)
                interactions.remove(interaction.stableKey)
                rebuildPendingSessionIds()
                _updates.tryEmit(PendingInteractionUpdate.Terminal(interaction))
            }
        }
    }

    public fun markResolved(kind: String, threadId: String, requestKey: String) {
        val key = "$kind:$threadId:$requestKey"
        rememberTerminalKey(key)
        interactions.remove(key)
        rebuildPendingSessionIds()
    }

    public fun clear() {
        interactions.clear()
        terminalKeys.clear()
        terminalKeyOrder.clear()
        _pendingSessionIds.value = emptySet()
    }

    public fun pendingForSession(sessionId: String): List<PendingInteraction> {
        return interactions.values
            .filter {
                (it.sessionId == sessionId || it.threadId == "chat-session-$sessionId") &&
                    it.isPending &&
                    !it.isExpired
            }
            .sortedBy { it.expiresAtMs ?: Long.MAX_VALUE }
    }

    /**
     * 合并服务端事实源，并返回此前不在本地快照中的有效待处理事项。
     *
     * `refreshSession` 会自行把返回值 hydrate 到会话，不能据此再 emit；只有
     * `refreshAll`（重连 / 前台恢复）消费这个返回值来补偿丢失的实时事件。
     */
    private fun merge(items: List<PendingInteraction>): List<PendingInteraction> {
        val newlyPending = mutableListOf<PendingInteraction>()
        for (item in items) {
            if (item.isPending && !item.isExpired && !terminalKeys.contains(item.stableKey)) {
                if (interactions.put(item.stableKey, item) == null) {
                    newlyPending += item
                }
            } else {
                interactions.remove(item.stableKey)
            }
        }
        sweepExpiredInteractions()
        rebuildPendingSessionIds()
        return newlyPending
    }

    private fun sweepExpiredInteractions() {
        val expired = interactions.values.filter { it.isExpired }
        if (expired.isEmpty()) return
        for (item in expired) {
            rememberTerminalKey(item.stableKey)
            interactions.remove(item.stableKey)
            _updates.tryEmit(PendingInteractionUpdate.Terminal(item))
            scope.launch { dismissExpiredInteraction(item.id) }
        }
        rebuildPendingSessionIds()
    }

    private fun rebuildPendingSessionIds() {
        _pendingSessionIds.value = interactions.values
            .asSequence()
            .filter { it.isPending && !it.isExpired }
            .mapNotNull { it.effectiveSessionId }
            .toSet()
    }

    private fun rememberTerminalKey(key: String) {
        if (terminalKeys.add(key)) {
            terminalKeyOrder.add(key)
        }
        while (terminalKeyOrder.size > MAX_TERMINAL_KEYS) {
            val oldest = terminalKeyOrder.poll() ?: break
            terminalKeys.remove(oldest)
        }
    }

    private suspend fun dismissExpiredInteraction(interactionId: String) {
        try {
            chatApi.dismissPendingInteraction(interactionId).unwrap()
        } catch (e: Exception) {
            Log.w(TAG, "dismissExpiredInteraction failed: ${e.message}")
        }
    }

    private companion object {
        private const val TAG = "PendingInteractionRepo"
        private const val USER_INTERACTION_PREFIX = "agent.user.interaction_"
        private const val EVENT_REQUESTED = "agent.user.interaction_requested"
        private const val EVENT_RESOLVED = "agent.user.interaction_resolved"
        private const val EVENT_EXPIRED = "agent.user.interaction_expired"
        private const val MAX_TERMINAL_KEYS = 512
        private val json = Json { ignoreUnknownKeys = true }
    }
}

public sealed interface PendingInteractionUpdate {
    public data class Requested(val interaction: PendingInteraction) : PendingInteractionUpdate
    public data class Terminal(val interaction: PendingInteraction) : PendingInteractionUpdate
}
