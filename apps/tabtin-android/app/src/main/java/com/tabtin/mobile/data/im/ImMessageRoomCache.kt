package com.tabtin.mobile.data.im

import com.tabtin.mobile.data.api.json
import com.tabtin.mobile.data.local.ImCachedMessageEntity
import com.tabtin.mobile.data.local.ImMessageCacheDao
import com.tabtin.mobile.data.local.ImPinnedMessageEntity
import com.tabtin.mobile.data.local.ImReadWaterlineEntity
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicLong

internal class ImSnapshotRevisionClock {
    private val latestByConversation: MutableMap<String, Long> = mutableMapOf()

    fun next(scopeId: String, conversationId: String): Long = synchronized(latestByConversation) {
        val key = key(scopeId, conversationId)
        val revision = (latestByConversation[key] ?: 0L) + 1L
        latestByConversation[key] = revision
        revision
    }

    fun isLatest(scopeId: String, conversationId: String, revision: Long): Boolean =
        synchronized(latestByConversation) {
            latestByConversation[key(scopeId, conversationId)] == revision
        }

    private fun key(scopeId: String, conversationId: String): String = "$scopeId\u0000$conversationId"
}

public interface ImReadStateCache {
    public fun advanceReadWaterline(
        scopeId: String,
        conversationId: String,
        readerId: String,
        seq: Int,
    )

    public fun clearReadState(scopeId: String, conversationId: String)
}

/**
 * IM 的 Room 持久缓存。数据库只保存可从服务端历史重新构建的消息快照和单调已读水位；
 * UI / Store 不接触 DAO，也不依赖 Room schema。
 */
@Singleton
public class ImMessageRoomCache @Inject constructor(
    private val dao: ImMessageCacheDao,
) : ImReadStateCache {
    private var ioScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var beforeMessageStoreMutation: suspend () -> Unit = {}
    private val mutationMutex = Mutex()
    private val operationGeneration = AtomicLong(0)
    private val messageRevisionClock = ImSnapshotRevisionClock()
    private val pinnedRevisionClock = ImSnapshotRevisionClock()
    private val maxMessagesPerConversation = 100
    private val maxConversations = 50

    internal constructor(
        dao: ImMessageCacheDao,
        ioScope: CoroutineScope,
        beforeMessageStoreMutation: suspend () -> Unit = {},
    ) : this(dao) {
        this.ioScope = ioScope
        this.beforeMessageStoreMutation = beforeMessageStoreMutation
    }

    public fun snapshotCache(scopeId: String): ImMessageSnapshotCache =
        ScopedRoomSnapshotCache(this, normalizeScopeId(scopeId))

    public fun pinnedSnapshotCache(scopeId: String): ImPinnedMessageSnapshotCache =
        ScopedRoomPinnedSnapshotCache(this, normalizeScopeId(scopeId))

    public suspend fun messagesAsync(scopeId: String, conversationId: String): List<ImMessage> =
        imChronologicallySortedMessages(
            dao.getMessages(normalizeScopeId(scopeId), conversationId)
                .mapNotNull { row -> runCatching { json.decodeFromString<ImMessage>(row.payload) }.getOrNull() },
        ).takeLast(maxMessagesPerConversation)

    public suspend fun pinnedMessagesAsync(scopeId: String, conversationId: String): List<ImMessage> =
        dao.getPinnedMessages(normalizeScopeId(scopeId), conversationId)
            .mapNotNull { row -> runCatching { json.decodeFromString<ImMessage>(row.payload) }.getOrNull() }
            .filter { !it.isDeleted }
            .map { it.copy(isPinned = true, pinStateKnown = true) }
            .sortedByDescending { it.seq }

    public fun store(scopeId: String, conversationId: String, messages: List<ImMessage>) {
        val normalizedScopeId = normalizeScopeId(scopeId)
        val generation = operationGeneration.get()
        val revision = messageRevisionClock.next(normalizedScopeId, conversationId)
        val now = System.currentTimeMillis()
        val rows = imChronologicallySortedMessages(
            messages.filter { it.conversationId == conversationId },
        )
            .takeLast(maxMessagesPerConversation)
            .mapNotNull { message ->
                runCatching {
                    ImCachedMessageEntity(
                        scopeId = normalizedScopeId,
                        conversationId = conversationId,
                        messageId = message.id,
                        seq = message.seq,
                        payload = json.encodeToString(ImMessage.serializer(), message),
                        cachedAt = now,
                    )
                }.getOrNull()
            }
            .toList()
        ioScope.launch {
            beforeMessageStoreMutation()
            mutationMutex.withLock {
                if (generation != operationGeneration.get()) return@withLock
                if (!messageRevisionClock.isLatest(normalizedScopeId, conversationId, revision)) return@withLock
                dao.replaceMessages(normalizedScopeId, conversationId, rows)
                val stale = dao.conversationIdsByRecency(normalizedScopeId).drop(maxConversations)
                if (stale.isNotEmpty()) {
                    dao.deleteConversations(normalizedScopeId, stale)
                    dao.deleteReadWaterlinesForConversations(normalizedScopeId, stale)
                    dao.deletePinnedMessagesForConversations(normalizedScopeId, stale)
                }
            }
        }
    }

    public fun storePinnedMessages(scopeId: String, conversationId: String, messages: List<ImMessage>) {
        val normalizedScopeId = normalizeScopeId(scopeId)
        val generation = operationGeneration.get()
        val revision = pinnedRevisionClock.next(normalizedScopeId, conversationId)
        val now = System.currentTimeMillis()
        val rows = messages
            .filter { it.conversationId == conversationId && !it.isDeleted }
            .sortedByDescending { it.seq }
            .mapNotNull { message ->
                runCatching {
                    ImPinnedMessageEntity(
                        scopeId = normalizedScopeId,
                        conversationId = conversationId,
                        messageId = message.id,
                        seq = message.seq,
                        payload = json.encodeToString(ImMessage.serializer(), message),
                        cachedAt = now,
                    )
                }.getOrNull()
            }
        ioScope.launch {
            mutationMutex.withLock {
                if (generation != operationGeneration.get()) return@withLock
                if (!pinnedRevisionClock.isLatest(normalizedScopeId, conversationId, revision)) return@withLock
                dao.replacePinnedMessages(normalizedScopeId, conversationId, rows)
            }
        }
    }

    public fun clear(scopeId: String, conversationId: String) {
        val normalizedScopeId = normalizeScopeId(scopeId)
        val revision = messageRevisionClock.next(normalizedScopeId, conversationId)
        ioScope.launch {
            mutationMutex.withLock {
                if (!messageRevisionClock.isLatest(normalizedScopeId, conversationId, revision)) return@withLock
                dao.deleteMessages(normalizedScopeId, conversationId)
                dao.deleteReadWaterlines(normalizedScopeId, conversationId)
            }
        }
    }

    override fun advanceReadWaterline(
        scopeId: String,
        conversationId: String,
        readerId: String,
        seq: Int,
    ) {
        val normalizedScopeId = normalizeScopeId(scopeId)
        val normalizedReaderId = readerId.trim()
        if (normalizedReaderId.isEmpty() || seq <= 0) return
        val generation = operationGeneration.get()
        ioScope.launch {
            mutationMutex.withLock {
                if (generation != operationGeneration.get()) return@withLock
                val existing = dao.getReadWaterline(normalizedScopeId, conversationId, normalizedReaderId)
                if (seq <= (existing?.seq ?: 0)) return@withLock
                dao.upsertReadWaterline(
                    ImReadWaterlineEntity(
                        scopeId = normalizedScopeId,
                        conversationId = conversationId,
                        readerId = normalizedReaderId,
                        seq = seq,
                        updatedAt = System.currentTimeMillis(),
                    ),
                )
            }
        }
    }

    public suspend fun readWaterlines(scopeId: String, conversationId: String): Map<String, Int> =
        dao.getReadWaterlines(normalizeScopeId(scopeId), conversationId)
            .associate { it.readerId to it.seq }

    override fun clearReadState(scopeId: String, conversationId: String) {
        val normalizedScopeId = normalizeScopeId(scopeId)
        ioScope.launch {
            mutationMutex.withLock { dao.deleteReadWaterlines(normalizedScopeId, conversationId) }
        }
    }

    public suspend fun clearAll() {
        operationGeneration.incrementAndGet()
        mutationMutex.withLock {
            dao.deleteAllMessages()
            dao.deleteAllReadWaterlines()
            dao.deleteAllPinnedMessages()
        }
    }

    internal suspend fun awaitPendingWrites() {
        while (true) {
            val children = ioScope.coroutineContext[Job]?.children?.toList().orEmpty()
            if (children.isEmpty()) return
            children.joinAll()
        }
    }

    private fun normalizeScopeId(scopeId: String): String = scopeId.trim().ifEmpty { "anonymous" }

    private class ScopedRoomSnapshotCache(
        private val backing: ImMessageRoomCache,
        private val scopeId: String,
    ) : ImMessageSnapshotCache {
        // Room 读取由 ViewModel 首帧后异步 hydrate；构造 Store 时绝不阻塞主线程。
        override fun messages(conversationId: String): List<ImMessage> = emptyList()

        override fun store(conversationId: String, messages: List<ImMessage>) {
            backing.store(scopeId, conversationId, messages)
        }

        override fun clear(conversationId: String) {
            backing.clear(scopeId, conversationId)
        }
    }

    private class ScopedRoomPinnedSnapshotCache(
        private val backing: ImMessageRoomCache,
        private val scopeId: String,
    ) : ImPinnedMessageSnapshotCache {
        // Room 读取由 ViewModel 首帧后异步 hydrate；构造 Store 时绝不阻塞主线程。
        override fun pinnedMessages(conversationId: String): List<ImMessage> = emptyList()

        override fun storePinnedMessages(conversationId: String, messages: List<ImMessage>) {
            backing.storePinnedMessages(scopeId, conversationId, messages)
        }
    }
}
