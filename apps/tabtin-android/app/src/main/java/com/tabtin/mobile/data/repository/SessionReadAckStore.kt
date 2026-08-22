package com.tabtin.mobile.data.repository

import android.content.Context
import android.util.Log
import com.tabtin.mobile.data.model.PendingSessionReadAck
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import retrofit2.HttpException

/**
 * 已读 ACK 的本地 outbox。
 *
 * 只有内容已由详情页完成加载后才进入此处；网络失败不会丢失，且同一 Session 只保留
 * 序列号/修订号更高的一条。服务端仍是最终幂等和授权裁决者。
 */
@Singleton
public class SessionReadAckStore @Inject constructor(
    @ApplicationContext context: Context,
    private val chatRepository: ChatRepository,
    private val tokenManager: TokenManager,
) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )
    private val json = Json { ignoreUnknownKeys = true }
    private val mutex = Mutex()
    /**
     * 阅读水位属于「登录用户 × Organization」，而不是安装实例。多账号或多组织共用
     * 设备时绝不能重放其他作用域的 ACK。
     */
    private var activeScope: SessionReadAckScope? = null
    private var pendingBySession: Map<String, PendingSessionReadAck> = emptyMap()
    private var acknowledgedBySession: Map<String, PendingSessionReadAck> = emptyMap()
    private var flushing = false
    /** 当旧作用域的网络请求尚未返回时，确保新作用域的 outbox 不会错过一次 flush。 */
    private var flushRequested = false
    /** 投递动作收敛为单点，单元测试可替换以隔离网络层。 */
    internal var sendReadAck: suspend (PendingSessionReadAck) -> Unit = { candidate ->
        chatRepository.acknowledgeSessionRead(candidate)
    }

    public suspend fun acknowledgeContentDisplayed(candidate: PendingSessionReadAck) {
        val accepted = mutex.withLock {
            if (!ensureCurrentScopeLocked()) return@withLock false
            if (!candidate.isNewerThan(pendingBySession[candidate.sessionId]) ||
                !candidate.isNewerThan(acknowledgedBySession[candidate.sessionId])
            ) {
                false
            } else {
                pendingBySession = pendingBySession + (candidate.sessionId to candidate)
                persistLocked()
                true
            }
        }
        if (accepted) flush()
    }

    /**
     * Organization 切换时丢弃内存中的旧作用域数据，但保留其磁盘 outbox；用户切回后
     * 仍能继续投递尚未成功的 ACK。
     */
    public suspend fun resetInMemoryScope() {
        mutex.withLock {
            activeScope = null
            pendingBySession = emptyMap()
            acknowledgedBySession = emptyMap()
            if (flushing) flushRequested = true
        }
    }

    /** 登出时删除当前账号 / Organization 的本地阅读 outbox。 */
    public suspend fun clear() {
        mutex.withLock {
            val scope = activeScope ?: currentScope() ?: return@withLock
            preferences.edit()
                .remove(scopedKey(PENDING_KEY, scope))
                .remove(scopedKey(ACKNOWLEDGED_KEY, scope))
                .apply()
            activeScope = null
            pendingBySession = emptyMap()
            acknowledgedBySession = emptyMap()
            flushRequested = false
        }
    }

    /** 在进入会话和网络恢复后调用；失败游标留在本地等待下次机会。 */
    public suspend fun flush() {
        if (!tokenManager.isLoggedIn) return
        val scope = mutex.withLock {
            if (!ensureCurrentScopeLocked()) return@withLock null
            if (flushing) {
                flushRequested = true
                return@withLock null
            }
            flushing = true
            activeScope
        } ?: return

        try {
            while (true) {
                val candidate = mutex.withLock {
                    if (activeScope != scope) return@withLock null
                    pendingBySession.values.minWithOrNull(
                        compareBy<PendingSessionReadAck> { it.throughSequence }
                            .thenBy { it.throughRevision },
                    )
                } ?: return
                try {
                    sendReadAck(candidate)
                } catch (error: Exception) {
                    if (isTerminalSessionReadAckFailure(error)) {
                        // 400/404/409 永远不会因重放成功。丢 pending 的同时还要把该水位记成本地
                        // 已结算：进会话 / 可见性 / 600ms 对账每次都会换新 mutationId，若不结算
                        // 同一 sequence/revision 会再次入队，抓包就会看到无限 POST。
                        // 这只挡同游标重发，更高水位仍能发出；未读角标仍跟服务端 read_state。
                        Log.d(TAG, "结算无法送达的阅读水位 ACK: ${error.javaClass.simpleName} ${candidate.sessionId}")
                        mutex.withLock { settleCandidateLocked(scope, candidate) }
                        continue
                    }
                    Log.d(TAG, "会话阅读水位 ACK 延后: ${error.javaClass.simpleName}")
                    return
                }
                mutex.withLock { settleCandidateLocked(scope, candidate) }
            }
        } finally {
            val shouldFlush = mutex.withLock {
                flushing = false
                val requested = flushRequested
                flushRequested = false
                requested && tokenManager.isLoggedIn
            }
            if (shouldFlush) flush()
        }
    }

    private fun ensureCurrentScopeLocked(): Boolean {
        val scope = currentScope() ?: return false
        if (scope == activeScope) return true
        activeScope = scope
        pendingBySession = load(PENDING_KEY, scope)
        acknowledgedBySession = load(ACKNOWLEDGED_KEY, scope)
        return true
    }

    private fun currentScope(): SessionReadAckScope? {
        val userId = tokenManager.userId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val organizationId = tokenManager.organizationId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return SessionReadAckScope(userId = userId, organizationId = organizationId)
    }

    private fun load(key: String, scope: SessionReadAckScope): Map<String, PendingSessionReadAck> =
        preferences.getString(scopedKey(key, scope), null)
            ?.let { encoded -> runCatching { json.decodeFromString<Map<String, PendingSessionReadAck>>(encoded) }.getOrNull() }
            .orEmpty()

    private fun settleCandidateLocked(scope: SessionReadAckScope?, candidate: PendingSessionReadAck) {
        if (activeScope != scope || pendingBySession[candidate.sessionId] != candidate) return
        pendingBySession = pendingBySession - candidate.sessionId
        if (candidate.isNewerThan(acknowledgedBySession[candidate.sessionId])) {
            acknowledgedBySession = acknowledgedBySession + (candidate.sessionId to candidate)
        }
        persistLocked()
    }

    private fun persistLocked() {
        val scope = activeScope ?: return
        preferences.edit().apply {
            writeMap(scopedKey(PENDING_KEY, scope), pendingBySession)
            writeMap(scopedKey(ACKNOWLEDGED_KEY, scope), acknowledgedBySession)
        }.apply()
    }

    private fun android.content.SharedPreferences.Editor.writeMap(
        key: String,
        value: Map<String, PendingSessionReadAck>,
    ) {
        if (value.isEmpty()) remove(key) else putString(key, json.encodeToString(value))
    }

    private fun scopedKey(key: String, scope: SessionReadAckScope): String =
        "$key.${scope.userId}.${scope.organizationId}"

    private data class SessionReadAckScope(
        val userId: String,
        val organizationId: String,
    )

    private companion object {
        private const val TAG = "SessionReadAckStore"
        private const val PREFERENCES_NAME = "tabtin_session_read_ack"
        private const val PENDING_KEY = "pending.v1"
        private const val ACKNOWLEDGED_KEY = "acknowledged.v1"
    }
}

/** 400 参数无效、404 会话不存在、409 水位游标过期：同一 candidate 重放永远不会成功。 */
internal val TERMINAL_SESSION_READ_ACK_FAILURE_CODES = setOf(400, 404, 409)

internal fun isTerminalSessionReadAckFailure(error: Throwable): Boolean {
    var current: Throwable? = error
    while (current != null) {
        if (current is HttpException && current.code() in TERMINAL_SESSION_READ_ACK_FAILURE_CODES) {
            return true
        }
        current = current.cause
    }
    return false
}
