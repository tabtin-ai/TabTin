package com.tabtin.mobile.data.repository

import android.annotation.SuppressLint
import android.content.Context
import com.tabtin.mobile.data.model.ConversationDraftScope
import com.tabtin.mobile.data.model.ConversationDraftSnapshot
import dagger.hilt.android.qualifiers.ApplicationContext
import java.security.MessageDigest
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.json.Json

/**
 * 每个执行范围保留一份可恢复的新会话草稿。
 *
 * 该存储故意使用同步 `commit()`：调用方必须先看到草稿已落盘，才能向服务端提交带
 * 稳定 UUID 的建会话请求。单例锁把同进程的读改写串行化；进程在写入途中退出时，
 * SharedPreferences 的原子提交会保留旧值或完整新值，而不会留下半份 JSON。
 */
@Singleton
public class ConversationDraftStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )
    private val lock = Any()
    private val json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = true
    }

    public fun load(scope: ConversationDraftScope): ConversationDraftSnapshot? = synchronized(lock) {
        if (!scope.isValid()) return@synchronized null
        val key = keyFor(scope)
        val encoded = preferences.getString(key, null) ?: return@synchronized null
        decode(key, encoded)?.takeIf { it.scope == scope && it.scope.isValid() }
    }

    /**
     * 会话页只持有 sessionId 时，用稳定 UUID 找回尚未入队的首发草稿。
     *
     * 这里不会把 scope 当作 Session 的服务端事实；仅在草稿自己的 draftId 或
     * pendingSessionId 与当前会话完全相等时返回。草稿数量极小，扫描本地 entries
     * 比为这一条恢复窗口引入第二套索引更可靠。
     */
    public fun loadForSession(sessionId: String): ConversationDraftSnapshot? = synchronized(lock) {
        if (sessionId.isBlank()) return@synchronized null
        preferences.all.asSequence()
            .filter { (key, _) -> key.startsWith(DRAFT_KEY_PREFIX) }
            .mapNotNull { (key, value) -> (value as? String)?.let { encoded -> decode(key, encoded) } }
            .firstOrNull { snapshot -> snapshot.matchesSession(sessionId) }
    }

    /**
     * 保存草稿并保留该 scope 既有的 draft / message 幂等键与创建时间。
     *
     * 调用方在已有 pending Session 时应先恢复原始运行配置；这里不猜测用户意图，
     * 只提供稳定的底层读改写语义。
     */
    public fun save(snapshot: ConversationDraftSnapshot): ConversationDraftSnapshot = synchronized(lock) {
        require(snapshot.scope.isValid()) { "草稿必须绑定有效的 Organization 和 Workspace" }
        val existing = load(snapshot.scope)
        val persisted = snapshot.copy(
            draftId = existing?.draftId ?: snapshot.draftId,
            clientEventId = existing?.clientEventId ?: snapshot.clientEventId,
            createdAt = existing?.createdAt ?: snapshot.createdAt,
            updatedAt = System.currentTimeMillis(),
        )
        check(
            preferences.edit()
                .putString(keyFor(snapshot.scope), json.encodeToString(ConversationDraftSnapshot.serializer(), persisted))
                .commit(),
        ) { "无法持久化会话草稿" }
        persisted
    }

    /** 在会话已创建但首条消息尚未入队的恢复窗口记录服务端 Session。 */
    public fun markPendingSession(
        scope: ConversationDraftScope,
        draftId: String,
        sessionId: String,
    ): ConversationDraftSnapshot? = synchronized(lock) {
        val current = load(scope)
            ?.takeIf { it.draftId == draftId }
            ?: return@synchronized null
        if (sessionId.isBlank()) return@synchronized current
        save(current.copy(pendingSessionId = sessionId))
    }

    /**
     * ：幂等 session_id 与服务端冻结配置冲突时，强制轮换 draft UUID。
     *
     * 普通 [save] 会保留既有 draftId（保证附件/首发幂等）；冲突恢复必须绕过该约束，
     * 否则重试仍撞同一行。
     */
    public fun rotateDraftIdentity(
        scope: ConversationDraftScope,
        expectedDraftId: String,
    ): ConversationDraftSnapshot? = synchronized(lock) {
        val current = load(scope)?.takeIf { it.draftId == expectedDraftId } ?: return@synchronized null
        val rotated = current.copy(
            draftId = UUID.randomUUID().toString(),
            pendingSessionId = null,
            updatedAt = System.currentTimeMillis(),
        )
        check(
            preferences.edit()
                .putString(keyFor(scope), json.encodeToString(ConversationDraftSnapshot.serializer(), rotated))
                .commit(),
        ) { "无法轮换会话草稿身份" }
        rotated
    }

    /**
     * 首条消息已安全进入本地队列后才消费草稿；错配 ID 时绝不删新草稿。
     *
     * 这里同步删除，避免下一个进程在旧草稿仍可见时重复走首发恢复路径。队列行已经
     * 是可靠事实，因此失败时宁可保留草稿，下一次会按同一个 client_event_id 去重。
     */
    @SuppressLint("ApplySharedPref")
    public fun consume(scope: ConversationDraftScope, draftId: String): Boolean = synchronized(lock) {
        val current = load(scope) ?: return@synchronized false
        if (current.draftId != draftId) return@synchronized false
        preferences.edit().remove(keyFor(scope)).commit()
    }

    public fun discard(scope: ConversationDraftScope): Boolean = synchronized(lock) {
        if (!scope.isValid()) return@synchronized false
        preferences.edit().remove(keyFor(scope)).commit()
    }

    private fun keyFor(scope: ConversationDraftScope): String =
        "$DRAFT_KEY_PREFIX${scope.storageKeyMaterial().sha256Hex()}"

    private fun decode(key: String, encoded: String): ConversationDraftSnapshot? = runCatching {
        json.decodeFromString(ConversationDraftSnapshot.serializer(), encoded)
    }.getOrElse {
        // 损坏的本地快照不能阻断用户重新开始任务；只清理该 scope，绝不影响其他组织。
        preferences.edit().remove(key).apply()
        null
    }

    private fun String.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
        .digest(toByteArray(Charsets.UTF_8))
        .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private companion object {
        private const val PREFERENCES_NAME = "tabtin_conversation_drafts"
        private const val DRAFT_KEY_PREFIX = "draft."
    }
}
