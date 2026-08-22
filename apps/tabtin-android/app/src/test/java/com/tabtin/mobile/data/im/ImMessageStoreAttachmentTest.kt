package com.tabtin.mobile.data.im

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.tabtin.mobile.features.tabchat.ImConversationForegroundCatchUp
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.advanceTimeBy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class ImMessageStoreAttachmentTest {
    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `cancelling send scope keeps in flight pending unresolved`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val cache = RecordingPendingCache()
        val storeScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val store = ImMessageStore(
            conversationId = "conv-cancel",
            transport = GatedTransport(gate),
            scope = storeScope,
            pendingCache = cache,
            cacheScopeId = "user-1",
        )

        store.enqueueSend(content = "in flight", clientRequestId = "cancel-request")
        runCurrent()
        storeScope.cancel()
        runCurrent()

        assertEquals(ImPendingMessage.Status.SENDING, store.pending.value.single().status)
        assertEquals(ImPendingMessage.Status.SENDING, cache.rawPending().single().status)
    }

    @Test
    fun `preferences snapshot cache restores recent messages`() {
        val cache = ImMessagePreferencesCache(ApplicationProvider.getApplicationContext())
        cache.clear("conv-cache")
        val message = ImMessage(
            id = 7,
            seq = 7,
            conversationId = "conv-cache",
            senderId = "user-1",
            content = "缓存里的消息",
            reactions = mapOf("👍" to listOf("user-2")),
            isPinned = true,
        )

        cache.store("conv-cache", listOf(message))

        assertEquals(listOf(message), cache.messages("conv-cache"))
        cache.clear("conv-cache")
    }

    @Test
    fun `reference attachment uses backend message id for download`() {
        val message = ImMessage(
            id = 44,
            seq = 44,
            conversationId = "conv-1",
            messageType = ImMessageType.IMAGE,
            hasAttachment = true,
            metadata = ImMessageMetadata(
                kind = "tabtin_ref",
                tabtinMessageId = "912",
                fileId = "file-1",
            ),
        )

        assertEquals(912, message.attachmentLookupMessageId)
    }

    @Test
    fun `REST attachment keeps message id for download`() {
        val message = ImMessage(
            id = 45,
            seq = 45,
            conversationId = "conv-1",
            messageType = ImMessageType.FILE,
            hasAttachment = true,
            metadata = ImMessageMetadata(fileId = "file-2"),
        )

        assertEquals(45, message.attachmentLookupMessageId)
    }

    @Test
    fun `full attachment snapshot prefers backend message id for download`() {
        val message = ImMessage(
            id = 10,
            seq = 10,
            conversationId = "conv-1",
            messageType = ImMessageType.IMAGE,
            hasAttachment = true,
            metadata = ImMessageMetadata(
                kind = "message",
                tabtinMessageId = "914",
                fileId = "file-3",
            ),
        )

        assertEquals(914, message.attachmentLookupMessageId)
    }

    @Test
    fun `metadata exposes compatible inline attachment urls`() {
        val raw = """
            {
              "download_url": " https://example-assets.oss-cn-shanghai.aliyuncs.com/a.png ",
              "cdn_url": "https://assets.example.com/a.png",
              "access_url": "ftp://ignored.test/a.png",
              "url": "https://assets.example.com/a.png"
            }
        """.trimIndent()

        val metadata = Json { ignoreUnknownKeys = true }
            .decodeFromString<ImMessageMetadata>(raw)

        assertEquals(
            listOf(
                "https://example-assets.oss-cn-shanghai.aliyuncs.com/a.png",
                "https://assets.example.com/a.png",
            ),
            metadata.inlineAttachmentUrls,
        )
    }

    @Test
    fun `attachment url exposes distinct http display candidates`() {
        val attachment = ImAttachmentUrl(
            downloadUrl = "https://assets.example.com/a.png",
            candidateUrls = listOf(
                "https://assets.example.com/a.png",
                "http://fallback.tabtin.test/a.png",
                "file:///local-only.png",
            ),
        )

        assertEquals(
            listOf("https://assets.example.com/a.png", "http://fallback.tabtin.test/a.png"),
            attachment.displayUrls,
        )
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `reopened store restores cached snapshot before history returns`() = runTest {
        val cached = ImMessage(id = 88, seq = 88, conversationId = "conv-1", content = "本地快照")
        val fresh = ImMessage(id = 89, seq = 89, conversationId = "conv-1", content = "权威历史")
        val cache = ImMessageMemoryCache().apply {
            store("conv-1", listOf(cached))
        }
        val gate = CompletableDeferred<Unit>()
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(historyGate = gate, history = listOf(fresh)),
            scope = this,
            snapshotCache = cache,
        )

        store.loadInitial()
        runCurrent()
        assertEquals(listOf(88), store.messages.value.map { it.id })

        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf(88, 89), store.messages.value.map { it.id })
    }

    @Test
    fun `silent state reconcile can authoritatively clear stale pinned state`() = runTest {
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(
                history = listOf(ImMessage(id = 77, seq = 77, conversationId = "conv-1", content = "远端未置顶")),
            ),
            scope = this,
        )
        store.ingestRealtimeMessage(
            ImMessage(id = 77, seq = 77, conversationId = "conv-1", content = "本地旧置顶", isPinned = true),
        )

        store.reconcileLatestState()

        assertFalse("历史页已 enrich 的置顶 false 应覆盖本地旧 true", store.messages.value.single().isPinned)
    }

    @Test
    fun `realtime session share edit updates card status cache`() = runTest {
        val shareId = "share-${java.util.UUID.randomUUID()}"
        val store = ImMessageStore("conv-1", RecordingTransport(), this)
        val message = ImMessage(
            id = 81,
            seq = 81,
            conversationId = "conv-1",
            senderId = "owner-1",
            content = "[任务共享] 示例任务",
            metadata = ImMessageMetadata(
                cardPayload = Json.parseToJsonElement(
                    """
                    {
                      "type": "session_share",
                      "share_id": "$shareId",
                      "session_id": "session-1",
                      "session_title": "示例任务",
                      "owner_user_id": "owner-1",
                      "grantee_user_id": "grantee-1",
                      "can_fork": false,
                      "can_chat": false,
                      "status": "revoked"
                    }
                    """.trimIndent(),
                ),
            ),
        )

        store.ingestRealtimeMessage(message)

        assertEquals("revoked", ImCardStatusMemoryCache.cachedSessionShare(shareId)?.normalizedStatus)
    }

    @Test
    fun `business projection refresh replaces the original card by message ref`() = runTest {
        val store = ImMessageStore("conv-1", RecordingTransport(), this)
        val messageRef = "33333333-3333-4333-8333-333333333333"
        val original = ImMessage(
            id = 81,
            seq = 81,
            conversationId = "conv-1",
            senderId = "owner-1",
            content = "[任务共享] 原状态",
            metadata = ImMessageMetadata(messageRef = messageRef),
        )
        val refreshed = original.copy(
            id = 99,
            seq = 99,
            content = "[任务共享] 已更新",
        )

        store.ingestRealtimeMessage(original)
        store.ingestRealtimeMessage(refreshed)

        assertEquals(1, store.messages.value.size)
        assertEquals(99, store.messages.value.single().id)
        assertEquals("[任务共享] 已更新", store.messages.value.single().content)
    }

    @Test
    fun `duplicate unpin failure converges to authoritative remote state`() = runTest {
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(
                failPin = true,
                history = listOf(ImMessage(id = 79, seq = 79, conversationId = "conv-1", content = "远端已取消置顶")),
            ),
            scope = this,
        )
        store.ingestRealtimeMessage(
            ImMessage(id = 79, seq = 79, conversationId = "conv-1", content = "本地旧置顶", isPinned = true),
        )

        store.pinMessage(messageId = 79, pinned = false)

        assertFalse(store.messages.value.single().isPinned)
    }

    @Test
    fun `pinned snapshot includes unloaded messages and sorts newest first`() = runTest {
        val older = ImMessage(
            id = 31,
            seq = 31,
            conversationId = "conv-1",
            content = "较早置顶",
            isPinned = true,
        )
        val latest = ImMessage(
            id = 45,
            seq = 45,
            conversationId = "conv-1",
            content = "最新置顶",
            isPinned = true,
        )
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(pinned = listOf(older, latest)),
            scope = this,
        )

        store.refreshPinnedMessages()

        assertEquals(listOf(45, 31), store.pinnedMessages.value.map { it.id })
        assertTrue(store.messages.value.isEmpty())
    }

    @Test
    fun `reopened store restores pinned snapshot before network refresh`() = runTest {
        val cache = ImPinnedMessageMemoryCache().apply {
            storePinnedMessages(
                "conv-1",
                listOf(
                    ImMessage(
                        id = 61,
                        seq = 61,
                        conversationId = "conv-1",
                        content = "缓存置顶",
                        isPinned = true,
                        pinStateKnown = true,
                    ),
                ),
            )
        }
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(),
            scope = this,
            pinnedSnapshotCache = cache,
        )

        assertEquals(listOf(61), store.pinnedMessages.value.map { it.id })
        assertTrue(store.messages.value.isEmpty())
    }

    @Test
    fun `authoritative empty pinned snapshot clears persisted snapshot`() = runTest {
        val cache = ImPinnedMessageMemoryCache().apply {
            storePinnedMessages(
                "conv-1",
                listOf(
                    ImMessage(
                        id = 62,
                        seq = 62,
                        conversationId = "conv-1",
                        isPinned = true,
                        pinStateKnown = true,
                    ),
                ),
            )
        }
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(),
            scope = this,
            pinnedSnapshotCache = cache,
        )

        store.refreshPinnedMessages()

        assertTrue(store.pinnedMessages.value.isEmpty())
        assertTrue(cache.pinnedMessages("conv-1").isEmpty())
    }

    @Test
    fun `clearing local history removes pinned state and persisted snapshot`() = runTest {
        val pinned = ImMessage(
            id = 63,
            seq = 63,
            conversationId = "conv-1",
            content = "清空前的置顶消息",
            isPinned = true,
            pinStateKnown = true,
        )
        val cache = ImPinnedMessageMemoryCache().apply {
            storePinnedMessages("conv-1", listOf(pinned))
        }
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(),
            scope = this,
            pinnedSnapshotCache = cache,
        )

        store.clearLocalHistory(clearedThroughSeq = pinned.seq)

        assertTrue(store.pinnedMessages.value.isEmpty())
        assertTrue(cache.pinnedMessages("conv-1").isEmpty())
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `clearing history invalidates an in-flight pinned refresh`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val stale = ImMessage(
            id = 64,
            seq = 64,
            conversationId = "conv-1",
            content = "清空前仍在请求中的置顶消息",
            isPinned = true,
            pinStateKnown = true,
        )
        val cache = ImPinnedMessageMemoryCache()
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(pinnedGate = gate, pinned = listOf(stale)),
            scope = this,
            pinnedSnapshotCache = cache,
        )

        val refresh = async { store.refreshPinnedMessages() }
        runCurrent()
        store.clearLocalHistory(clearedThroughSeq = stale.seq)
        gate.complete(Unit)
        refresh.await()

        assertTrue(store.pinnedMessages.value.isEmpty())
        assertTrue(cache.pinnedMessages("conv-1").isEmpty())
    }

    @Test
    fun `pinned refresh filters messages at or below the clear watermark`() = runTest {
        val cleared = ImMessage(
            id = 65,
            seq = 65,
            conversationId = "conv-1",
            isPinned = true,
        )
        val fresh = ImMessage(
            id = 66,
            seq = 66,
            conversationId = "conv-1",
            isPinned = true,
        )
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(pinned = listOf(cleared, fresh)),
            scope = this,
        )
        store.clearLocalHistory(clearedThroughSeq = cleared.seq)

        store.refreshPinnedMessages()

        assertEquals(listOf(fresh.id), store.pinnedMessages.value.map { it.id })
    }

    @Test
    fun `clear history watermark includes unloaded pinned messages`() = runTest {
        val transport = RecordingTransport(allowClearHistory = true)
        val pinned = ImMessage(
            id = 84,
            seq = 84,
            conversationId = "conv-1",
            content = "未加载到普通历史页的置顶消息",
            isPinned = true,
            pinStateKnown = true,
        )
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = transport,
            scope = this,
            pinnedSnapshotCache = ImPinnedMessageMemoryCache().apply {
                storePinnedMessages("conv-1", listOf(pinned))
            },
        )

        store.clearHistory()
        store.ingestRealtimeMessage(pinned.copy(content = "清空后迟到的旧事件"))

        assertEquals(1, transport.clearHistoryCalls)
        assertTrue(store.messages.value.isEmpty())
        assertTrue(store.pinnedMessages.value.isEmpty())
    }

    @Test
    fun `pinned refresh failure keeps cached snapshot`() = runTest {
        val cached = ImMessage(
            id = 65,
            seq = 65,
            conversationId = "conv-1",
            content = "离线仍展示",
            isPinned = true,
            pinStateKnown = true,
        )
        val cache = ImPinnedMessageMemoryCache().apply {
            storePinnedMessages("conv-1", listOf(cached))
        }
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(failPinnedFetch = true),
            scope = this,
            pinnedSnapshotCache = cache,
        )

        store.refreshPinnedMessages()

        assertEquals(listOf(65), store.pinnedMessages.value.map { it.id })
        assertEquals(listOf(65), cache.pinnedMessages("conv-1").map { it.id })
    }

    @Test
    fun `late pinned hydration cannot overwrite authoritative snapshot`() = runTest {
        val store = ImMessageStore("conv-1", RecordingTransport(), this)
        store.refreshPinnedMessages()

        store.hydratePinnedSnapshotIfNeeded(
            listOf(
                ImMessage(
                    id = 63,
                    seq = 63,
                    conversationId = "conv-1",
                    isPinned = true,
                    pinStateKnown = true,
                ),
            ),
        )

        assertTrue(store.pinnedMessages.value.isEmpty())
    }

    @Test
    fun `local and realtime unpin immediately remove pinned snapshot`() = runTest {
        val first = ImMessage(
            id = 51,
            seq = 51,
            conversationId = "conv-1",
            content = "第一条",
            isPinned = true,
        )
        val second = ImMessage(
            id = 52,
            seq = 52,
            conversationId = "conv-1",
            content = "第二条",
            isPinned = true,
        )
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(pinned = listOf(first, second)),
            scope = this,
        )
        store.refreshPinnedMessages()

        store.pinMessage(messageId = 51, pinned = false)
        assertEquals(listOf(52), store.pinnedMessages.value.map { it.id })

        store.ingestRealtimeMessage(second.copy(isPinned = false, pinStateKnown = true))
        assertTrue(store.pinnedMessages.value.isEmpty())
    }

    @Test
    fun `local pin mutation persists pinned snapshot`() = runTest {
        val cache = ImPinnedMessageMemoryCache()
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(),
            scope = this,
            pinnedSnapshotCache = cache,
        )
        store.ingestRealtimeMessage(ImMessage(id = 64, seq = 64, conversationId = "conv-1"))

        store.pinMessage(messageId = 64, pinned = true)

        assertEquals(listOf(64), cache.pinnedMessages("conv-1").map { it.id })
    }

    @Test
    fun `silent state reconcile does not resurrect optimistically recalled message`() = runTest {
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(
                history = listOf(ImMessage(id = 78, seq = 78, conversationId = "conv-1", content = "旧历史")),
            ),
            scope = this,
        )
        store.ingestRealtimeMessage(
            ImMessage(id = 78, seq = 78, conversationId = "conv-1", content = "已撤回", isDeleted = true),
        )

        store.reconcileLatestState()

        val message = store.messages.value.single()
        assertTrue("本地/实时撤回态不能被旧历史刷回未撤回", message.isDeleted)
        assertEquals("", message.content)
    }

    @Test
    fun `read progress merges aggregate and realtime receipt`() {
        val store = ImMessageStore("conv-1", RecordingTransport(), kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined))
        store.currentUserId = "me"
        val mine = ImMessage(
            id = 12,
            seq = 12,
            conversationId = "conv-1",
            senderId = "me",
            content = "群聊消息",
            readReceipt = ImReadReceipt(readCount = 1, recipientCount = 3),
        )
        store.ingestRealtimeMessage(mine)
        store.applyRealtime(
            """
            {"type": "im.read.receipt", "data": {"conversation_id": "conv-1", "user_id": "peer-2",
              "last_read_message_id": 12, "last_read_seq": 12}}
            """.trimIndent().encodeToByteArray(),
        )
        store.applyRealtime(
            """
            {"type": "im.read.receipt", "data": {"conversation_id": "conv-1", "user_id": "peer-3",
              "last_read_message_id": 12, "last_read_seq": 12}}
            """.trimIndent().encodeToByteArray(),
        )

        assertEquals(ImReadReceipt(readCount = 2, recipientCount = 3), store.readProgress(mine))
    }

    @Test
    fun `realtime synchronizes pinned and business card state`() {
        val store = ImMessageStore(
            "conv-1",
            RecordingTransport(),
            kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
        )
        store.applyRealtime(
            """{"type":"im.message.pinned","data":{"id":8,"seq":8,"conversation_id":"conv-1","content":"重点","is_pinned":true}}"""
                .encodeToByteArray(),
        )
        assertEquals(listOf(8), store.pinnedMessages.value.map { it.id })

        store.applyRealtime(
            """{"type":"im.message.unpinned","data":{"message_id":8,"conversation_id":"conv-1"}}"""
                .encodeToByteArray(),
        )
        assertTrue(store.pinnedMessages.value.isEmpty())
        assertFalse(store.messages.value.single().isPinned)

        store.applyRealtime(
            """{"type":"im.session_share.update","data":{"share_id":"share-1","conversation_id":"conv-1"}}"""
                .encodeToByteArray(),
        )
        assertEquals(1, store.sessionShareVersions.value["share-1"])

        store.applyRealtime(
            """{"type":"im.conversation.updated","data":{"conversation_id":"conv-1","name":"新群名"}}"""
                .encodeToByteArray(),
        )
        assertEquals(1, store.conversationRevision.value)
    }

    @Test
    fun `agent projection stream final and error converge by message ref`() {
        val store = ImMessageStore(
            "conv-1",
            RecordingTransport(),
            kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined),
        )
        fun event(type: String, data: String): ByteArray =
            "{\"type\":\"$type\",\"data\":$data}".encodeToByteArray()

        store.applyRealtime(event("im.agent.message.stream", """{"conversation_id":"conv-1","message_ref":"job-1","agent_session_ref":"session-1","sender_id":"agent-1","sender_name":"研究员","sender_avatar":"","delta":"你","stream_seq":1,"created_at":"2026-08-22T10:00:00Z"}"""))
        store.applyRealtime(event("im.agent.message.stream", """{"conversation_id":"conv-1","message_ref":"job-1","agent_session_ref":"session-1","sender_id":"agent-1","sender_name":"研究员","sender_avatar":"","delta":"错误重复","stream_seq":1,"created_at":"2026-08-22T10:00:01Z"}"""))
        store.applyRealtime(event("im.agent.message.stream", """{"conversation_id":"conv-1","message_ref":"job-1","agent_session_ref":"session-1","sender_id":"agent-1","sender_name":"研究员","sender_avatar":"","delta":"好","stream_seq":3,"created_at":"2026-08-22T10:00:02Z"}"""))
        assertEquals(1, store.messages.value.size)
        assertEquals("你好", store.messages.value.single().content)
        assertEquals("agent_stream", store.messages.value.single().metadata?.kind)

        store.applyRealtime(event("im.agent.message.final", """{"conversation_id":"conv-1","message_ref":"job-1","agent_session_ref":"session-1","sender_id":"agent-1","sender_name":"研究员","sender_avatar":"","content":"完整回答","message_type":1,"metadata":{},"created_at":"2026-08-22T10:00:03Z"}"""))
        store.applyRealtime(event("im.agent.message.stream", """{"conversation_id":"conv-1","message_ref":"job-1","agent_session_ref":"session-1","sender_id":"agent-1","sender_name":"研究员","sender_avatar":"","delta":"迟到","stream_seq":4,"created_at":"2026-08-22T10:00:04Z"}"""))
        assertEquals("完整回答", store.messages.value.single().content)
        assertEquals("agent_final", store.messages.value.single().metadata?.kind)

        store.applyRealtime(event("im.agent.message.stream", """{"conversation_id":"conv-1","message_ref":"job-2","agent_session_ref":"session-2","sender_id":"agent-1","sender_name":"研究员","sender_avatar":"","delta":"临时","stream_seq":1,"created_at":"2026-08-22T10:00:05Z"}"""))
        store.applyRealtime(event("im.agent.message.error", """{"conversation_id":"conv-1","message_ref":"job-2","agent_session_ref":"session-2","sender_id":"agent-1","sender_name":"研究员","sender_avatar":""}"""))
        assertFalse(store.messages.value.any { it.metadata?.messageRef == "job-2" })
    }

    @Test
    fun `silent state reconcile does not regress read receipt counts`() = runTest {
        val positiveReceipt = ImReadReceipt(readCount = 2, recipientCount = 3)
        val message = ImMessage(
            id = 12,
            seq = 12,
            conversationId = "conv-1",
            senderId = "me",
            content = "群聊消息",
            readReceipt = positiveReceipt,
        )
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(
                history = listOf(message.copy(readReceipt = ImReadReceipt(readCount = 0, recipientCount = 3))),
            ),
            scope = this,
        )
        store.currentUserId = "me"
        store.ingestRealtimeMessage(message)

        store.reconcileLatestState()

        assertEquals(positiveReceipt, store.messages.value.single().readReceipt)
    }

    @Test
    fun `read receipt details delegate the active conversation and message id`() = runTest {
        val expected = ImMessageReadReceipts(
            readers = listOf(ImReadReceiptMember(userId = "read-1", name = "已读成员")),
            unreaders = listOf(ImReadReceiptMember(userId = "unread-1", name = "未读成员")),
        )
        val transport = RecordingTransport(readReceipts = expected)
        val store = ImMessageStore("conv-read", transport, this)

        val actual = store.fetchReadReceipts(
            ImMessage(id = 42, seq = 42, conversationId = "conv-read", content = "群消息"),
        )

        assertEquals(expected, actual)
        assertEquals(listOf("conv-read" to 42), transport.readReceiptCalls)
    }

    private data class SendCall(
        val requestId: String,
        val attachment: ImOutgoingAttachment?,
        val card: ImOutgoingCard? = null,
    )

    private class RecordingTransport(
        override val isSendAvailable: Boolean = true,
        private val failFirst: Boolean = false,
        private val alwaysFail: Boolean = false,
        private val failPin: Boolean = false,
        private val failPinnedFetch: Boolean = false,
        private val historyGate: CompletableDeferred<Unit>? = null,
        private val historyFailure: Throwable? = null,
        private val pinnedGate: CompletableDeferred<Unit>? = null,
        var history: List<ImMessage> = emptyList(),
        private val historyClearedSeq: Int = 0,
        private val pinned: List<ImMessage> = emptyList(),
        private val readReceipts: ImMessageReadReceipts = ImMessageReadReceipts(emptyList(), emptyList()),
        private val allowRecall: Boolean = false,
        private val allowClearHistory: Boolean = false,
        private val authoritativeClearedSeq: Int = 0,
    ) : ImMessageTransport {
        val calls: MutableList<SendCall> = mutableListOf()
        val editCalls: MutableList<String> = mutableListOf()
        val readReceiptCalls: MutableList<Pair<String, Int>> = mutableListOf()
        var clearHistoryCalls: Int = 0
            private set
        var historyFetchCalls: Int = 0
            private set
        private var hasFailed = false

        override suspend fun fetchMessages(conversationId: String, before: Int?, limit: Int): List<ImMessage> {
            historyFetchCalls++
            historyGate?.await()
            historyFailure?.let { throw it }
            return history
        }

        override suspend fun fetchHistoryClearedSeq(conversationId: String): Int = historyClearedSeq

        override suspend fun fetchPinnedMessages(conversationId: String): List<ImMessage> {
            if (failPinnedFetch) throw java.io.IOException("offline")
            pinnedGate?.await()
            return pinned
        }

        override suspend fun clearHistory(conversationId: String) {
            check(allowClearHistory) { "not used" }
            clearHistoryCalls++
        }

        override suspend fun clearHistoryAndFetchWatermark(conversationId: String): Int {
            clearHistory(conversationId)
            return authoritativeClearedSeq
        }

        override suspend fun sendMessage(
            conversationId: String,
            content: String,
            messageType: Int,
            replyToId: Int?,
            mentionedUserIds: List<String>,
            mentionedAgentIds: List<String>,
            mentionAll: Boolean,
            attachment: ImOutgoingAttachment?,
            clientRequestId: String,
        ): ImSendMessageResult = recordSend(
            clientRequestId = clientRequestId,
            attachment = attachment,
            card = null,
            conversationId = conversationId,
        )

        override suspend fun sendMessage(
            conversationId: String,
            content: String,
            messageType: Int,
            replyToId: Int?,
            mentionedUserIds: List<String>,
            mentionedAgentIds: List<String>,
            mentionAll: Boolean,
            attachment: ImOutgoingAttachment?,
            card: ImOutgoingCard?,
            clientRequestId: String,
        ): ImSendMessageResult = recordSend(
            clientRequestId = clientRequestId,
            attachment = attachment,
            card = card,
            conversationId = conversationId,
        )

        private fun recordSend(
            clientRequestId: String,
            attachment: ImOutgoingAttachment?,
            card: ImOutgoingCard?,
            conversationId: String,
        ): ImSendMessageResult {
            calls += SendCall(clientRequestId, attachment, card)
            if (alwaysFail) throw java.io.IOException("offline")
            if (failFirst && !hasFailed) {
                hasFailed = true
                throw java.io.IOException("accepted response lost")
            }
            return ImSendMessageResult(
                id = 91,
                seq = 12,
                conversationId = conversationId,
                createdAt = "2026-07-21T10:00:00Z",
            )
        }

        override suspend fun editMessage(conversationId: String, messageId: Int, content: String): ImMessage {
            editCalls += content
            return ImMessage(
                id = messageId,
                seq = messageId,
                conversationId = conversationId,
                senderId = "me",
                content = content,
                editedAt = "2026-07-21T10:00:00Z",
            )
        }

        override suspend fun recallMessage(conversationId: String, messageId: Int) {
            check(allowRecall) { "not used" }
        }
        override suspend fun pinMessage(conversationId: String, messageId: Int, pinned: Boolean) {
            if (failPin) throw java.io.IOException("already unpinned")
        }
        override suspend fun addReaction(conversationId: String, messageId: Int, emoji: String): Unit = error("not used")
        override suspend fun removeReaction(conversationId: String, messageId: Int, emoji: String): Unit = error("not used")
        override suspend fun markRead(conversationId: String, lastMessageId: Int): Unit = error("not used")
        override suspend fun fetchReadReceipts(
            conversationId: String,
            messageId: Int,
        ): ImMessageReadReceipts {
            readReceiptCalls += conversationId to messageId
            return readReceipts
        }
    }

    private val image = ImOutgoingAttachment(
        fileId = "00000000-0000-0000-0000-000000000001",
        fileName = "photo.jpg",
        fileSize = 1024,
        fileType = "image/jpeg",
        remoteUrl = "https://cdn.example.com/photo.jpg",
    )

    @Test
    fun `attachment metadata is forwarded and reflected in confirmed local message`() = runTest {
        val transport = RecordingTransport()
        val confirmedForDirectory = mutableListOf<ImMessage>()
        val store = ImMessageStore(
            "conv-1",
            transport,
            this,
            onMessageConfirmed = confirmedForDirectory::add,
        )
        store.currentUserId = "me"

        val outcome = store.performSend(
            content = "图片附言",
            messageType = ImMessageType.IMAGE,
            attachment = image,
            clientRequestId = "attachment-request",
        )

        assertEquals(ImSendOutcome.CONFIRMED, outcome)
        assertTrue(store.pending.value.isEmpty())
        assertEquals(listOf(SendCall("attachment-request", image)), transport.calls)
        val message = store.messages.value.single()
        assertTrue(message.isImageAttachment)
        assertEquals(image.fileId, message.metadata?.fileId)
        assertEquals(image.fileName, message.metadata?.fileName)
        assertEquals(image.fileSize.toInt(), message.metadata?.fileSize)
        assertEquals(image.remoteUrl, message.metadata?.accessUrl)
        assertEquals(listOf(message), confirmedForDirectory)
    }

    @Test
    fun `editing unchanged content is a no-op`() = runTest {
        val transport = RecordingTransport()
        val store = ImMessageStore("conv-1", transport, this)
        store.ingestRealtimeMessage(
            ImMessage(id = 5, seq = 5, conversationId = "conv-1", senderId = "me", content = "原文"),
        )

        val ok = store.editMessage(5, " 原文 ")

        assertTrue(ok)
        assertEquals("原文", store.messages.value.single().content)
        assertEquals(null, store.messages.value.single().editedAt)
        assertEquals(emptyList<String>(), transport.editCalls)
    }

    @Test
    fun `realtime edit from another sender refreshes loaded reply previews`() = runTest {
        val store = ImMessageStore("conv-1", RecordingTransport(), this)
        store.ingestRealtimeMessage(
            ImMessage(
                id = 5,
                seq = 5,
                conversationId = "conv-1",
                senderId = "peer",
                content = "编辑前的原文",
            ),
        )
        store.ingestRealtimeMessage(
            ImMessage(
                id = 6,
                seq = 6,
                conversationId = "conv-1",
                senderId = "reply-sender",
                content = "回复",
                replyToId = 5,
                replyToPreview = ImReplyPreview(content = "编辑前的原文", senderId = "peer"),
            ),
        )

        store.ingestRealtimeMessage(
            ImMessage(
                id = 5,
                seq = 5,
                conversationId = "conv-1",
                senderId = "peer",
                content = "编辑后的原文",
                editedAt = "2026-08-13T10:00:00Z",
            ),
        )

        assertEquals("编辑后的原文", store.messages.value.last().replyToPreview?.content)
    }

    @Test
    fun `recalling a loaded source message makes reply previews unavailable`() = runTest {
        val store = ImMessageStore("conv-1", RecordingTransport(allowRecall = true), this)
        store.ingestRealtimeMessage(
            ImMessage(
                id = 8,
                seq = 8,
                conversationId = "conv-1",
                senderId = "me",
                content = "不应继续展示",
            ),
        )
        store.ingestRealtimeMessage(
            ImMessage(
                id = 9,
                seq = 9,
                conversationId = "conv-1",
                senderId = "reply-sender",
                content = "回复",
                replyToId = 8,
                replyToPreview = ImReplyPreview(content = "不应继续展示", senderId = "me"),
            ),
        )

        val ok = store.recallMessage(8)

        val preview = store.messages.value.last().replyToPreview
        assertTrue(ok)
        assertEquals("消息内容不可用", preview?.content)
        assertTrue(preview?.isUnavailable ?: false)
    }

    @Test
    fun `card pending retry and optimistic echo retain the card payload`() = runTest {
        val card = ImOutgoingCard.resource(
            type = ImResourceCardType.DOCUMENT,
            resourceId = "doc-42",
            name = "项目方案",
            spaceId = "space-1",
            organizationId = "org-1",
        )
        val transport = RecordingTransport(failFirst = true)
        val store = ImMessageStore("conv-1", transport, this)
        store.currentUserId = "me"

        val first = store.performSend(
            content = card.fallbackContent,
            card = card,
            clientRequestId = "card-retry-request",
        )
        assertEquals(ImSendOutcome.FAILED_PENDING, first)
        val failed = store.pending.value.single()
        assertEquals(card, failed.card)

        val retried = store.performSend(
            content = failed.content,
            messageType = failed.messageType,
            replyToId = failed.replyToId,
            mentionedUserIds = failed.mentionedUserIds,
            mentionedAgentIds = failed.mentionedAgentIds,
            mentionAll = failed.mentionAll,
            attachment = failed.attachment,
            card = failed.card,
            clientRequestId = failed.clientRequestId,
            isRetry = true,
        )

        assertEquals(ImSendOutcome.CONFIRMED, retried)
        assertEquals(listOf(card, card), transport.calls.map { it.card })
        val optimistic = store.messages.value.single()
        assertTrue(optimistic.hasStructuredCard)
        assertEquals(ImResourceCardType.DOCUMENT, optimistic.resourceCard?.type)
        assertFalse(optimistic.isPlainText)
    }

    @Test
    fun `failed attachment send retains snapshot and retry reuses request id`() = runTest {
        val transport = RecordingTransport(failFirst = true)
        val store = ImMessageStore("conv-1", transport, this)

        val first = store.performSend(
            content = "文件附言",
            messageType = ImMessageType.FILE,
            attachment = image.copy(fileName = "report.pdf", fileType = "application/pdf"),
            clientRequestId = "retry-request",
        )

        assertEquals(ImSendOutcome.FAILED_PENDING, first)
        val failed = store.pending.value.single()
        assertEquals(ImPendingMessage.Status.FAILED, failed.status)
        assertNull(failed.errorMessage)
        assertEquals("report.pdf", failed.attachment?.fileName)

        val retried = store.performSend(
            content = failed.content,
            messageType = failed.messageType,
            replyToId = failed.replyToId,
            mentionedAgentIds = failed.mentionedAgentIds,
            attachment = failed.attachment,
            clientRequestId = failed.clientRequestId,
            isRetry = true,
        )

        assertEquals(ImSendOutcome.CONFIRMED, retried)
        assertTrue(store.pending.value.isEmpty())
        assertEquals(listOf("retry-request", "retry-request"), transport.calls.map { it.requestId })
        assertEquals(1, store.messages.value.size)
    }

    @Test
    fun `failed attachment send does not expose transport details`() = runTest {
        val transport = RecordingTransport(failFirst = true)
        val store = ImMessageStore("conv-1", transport, this)

        val outcome = store.performSend(
            content = "文件附言",
            messageType = ImMessageType.FILE,
            attachment = image.copy(fileName = "report.pdf", fileType = "application/pdf"),
            clientRequestId = "sanitized-error-request",
        )

        assertEquals(ImSendOutcome.FAILED_PENDING, outcome)
        assertNull(store.pending.value.single().errorMessage)
    }

    /** 在 sendMessage 处挂起，用于制造「首发在途」窗口以验证单飞。 */
    private class GatedTransport(private val gate: CompletableDeferred<Unit>) : ImMessageTransport {
        var sendCount = 0
            private set
        val sentClientRequestIds = mutableListOf<String>()

        override suspend fun fetchMessages(conversationId: String, before: Int?, limit: Int): List<ImMessage> =
            emptyList()

        override suspend fun sendMessage(
            conversationId: String,
            content: String,
            messageType: Int,
            replyToId: Int?,
            mentionedUserIds: List<String>,
            mentionedAgentIds: List<String>,
            mentionAll: Boolean,
            attachment: ImOutgoingAttachment?,
            clientRequestId: String,
        ): ImSendMessageResult {
            sendCount++
            sentClientRequestIds += clientRequestId
            val sequence = 69 + sendCount
            gate.await()
            return ImSendMessageResult(id = 630 + sequence, seq = sequence, conversationId = conversationId)
        }

        override suspend fun editMessage(conversationId: String, messageId: Int, content: String): ImMessage =
            error("not used")
        override suspend fun recallMessage(conversationId: String, messageId: Int): Unit = error("not used")
        override suspend fun addReaction(conversationId: String, messageId: Int, emoji: String): Unit = error("not used")
        override suspend fun removeReaction(conversationId: String, messageId: Int, emoji: String): Unit =
            error("not used")
        override suspend fun markRead(conversationId: String, lastMessageId: Int): Unit = error("not used")
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `clearing history invalidates an in-flight history response`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val transport = RecordingTransport(
            historyGate = gate,
            history = listOf(
                ImMessage(id = 41, seq = 41, conversationId = "conv-1", content = "旧消息"),
            ),
        )
        val store = ImMessageStore("conv-1", transport, this, pageSize = 1)

        val loading = async { store.loadHistory(reset = true) }
        runCurrent()
        assertTrue(store.isLoadingHistory.value)

        store.clearLocalHistory(clearedThroughSeq = 41)
        gate.complete(Unit)
        loading.await()

        assertTrue("清空后在途响应不得写回旧消息", store.messages.value.isEmpty())
        store.ingestRealtimeMessage(
            ImMessage(id = 41, seq = 41, conversationId = "conv-1", content = "延迟旧消息"),
        )
        assertTrue("清空水位应拒绝迟到的共享实时事件", store.messages.value.isEmpty())
        assertFalse("清空后不得恢复可继续翻页状态", store.hasMoreHistory.value)
        assertFalse(store.isLoadingHistory.value)
    }

    @Test
    fun `clear response preserves its nonzero watermark for delayed realtime`() = runTest {
        val result = Json.decodeFromString<ImClearHistoryResult>("""{"cleared_seq": 41}""")
        val store = ImMessageStore("conv-1", RecordingTransport(), this)

        store.clearLocalHistory(clearedThroughSeq = result.clearedSeq)
        store.ingestRealtimeMessage(
            ImMessage(id = 41, seq = 41, conversationId = "conv-1", content = "已清空的旧消息"),
        )

        assertEquals(41, result.clearedSeq)
        assertTrue("POST 清空水位应阻止迟到 realtime 复活", store.messages.value.isEmpty())
    }

    @Test
    fun `clear history uses server watermark beyond locally loaded messages`() = runTest {
        val transport = RecordingTransport(
            allowClearHistory = true,
            authoritativeClearedSeq = 51,
        )
        val store = ImMessageStore("conv-1", transport, this)
        store.ingestRealtimeMessage(
            ImMessage(id = 41, seq = 41, conversationId = "conv-1", content = "本地最后一条"),
        )

        store.clearHistory()
        store.ingestRealtimeMessage(
            ImMessage(id = 50, seq = 50, conversationId = "conv-1", content = "未加载的迟到旧事件"),
        )

        assertEquals(1, transport.clearHistoryCalls)
        assertTrue(store.messages.value.isEmpty())
    }

    @Test
    fun `startup history watermark removes stale cache and rejects delayed realtime`() = runTest {
        val cached = listOf(
            ImMessage(id = 40, seq = 40, conversationId = "conv-1", content = "已清空缓存"),
            ImMessage(id = 43, seq = 43, conversationId = "conv-1", content = "仍可见缓存"),
        )
        val transport = RecordingTransport(historyClearedSeq = 42)
        val store = ImMessageStore(
            "conv-1",
            transport,
            this,
            snapshotCache = object : ImMessageSnapshotCache {
                override fun messages(conversationId: String): List<ImMessage> = cached
                override fun store(conversationId: String, messages: List<ImMessage>) = Unit
                override fun clear(conversationId: String) = Unit
            },
        )

        assertTrue(store.initializeHistoryVisibility())
        store.ingestRealtimeMessage(
            ImMessage(id = 41, seq = 41, conversationId = "conv-1", content = "迟到旧事件"),
        )
        store.ingestRealtimeMessage(
            ImMessage(id = 44, seq = 44, conversationId = "conv-1", content = "新事件"),
        )

        assertEquals(listOf(43, 44), store.messages.value.map { it.seq })
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `initial history keeps realtime message arriving before fetch returns`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val snapshot = ImMessage(id = 100, seq = 100, conversationId = "conv-1", content = "首屏快照")
        val realtime = ImMessage(id = 101, seq = 101, conversationId = "conv-1", content = "订阅后的实时消息")
        val store = ImMessageStore(
            "conv-1",
            RecordingTransport(historyGate = gate, history = listOf(snapshot)),
            this,
            pageSize = 30,
        )

        store.loadInitial()
        runCurrent()
        store.ingestRealtimeMessage(realtime)
        gate.complete(Unit)
        runCurrent()

        assertEquals(listOf(100, 101), store.messages.value.map { it.id })
    }

    @Test
    fun `listed last message compensation merges after stale history page`() = runTest {
        val staleHistory = listOf(10, 11, 12).map { id ->
            ImMessage(
                id = id,
                seq = id,
                conversationId = "conv-1",
                content = "旧消息$id",
                createdAt = "2026-08-18T12:0${id}:00Z",
            )
        }
        val listedLatest = ImMessage(
            id = 40,
            seq = 40,
            conversationId = "conv-1",
            senderId = "peer",
            content = "入口已更新的最新消息",
            createdAt = "2026-08-19T05:46:00Z",
        )
        val store = ImMessageStore(
            "conv-1",
            RecordingTransport(history = staleHistory),
            this,
            pageSize = 30,
        )

        store.loadHistory(reset = true)
        store.ingestRealtimeMessage(listedLatest)

        assertEquals(listOf(10, 11, 12, 40), store.messages.value.map { it.id })
        assertEquals("入口已更新的最新消息", store.messages.value.last().content)
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `returning to a retained conversation catches up messages missed while covered`() = runTest {
        val beforeNavigation = ImMessage(
            id = 12,
            seq = 12,
            conversationId = "conv-1",
            content = "离开前消息",
        )
        val arrivedWhileCovered = ImMessage(
            id = 13,
            seq = 13,
            conversationId = "conv-1",
            content = "离开期间的新消息",
        )
        val transport = RecordingTransport(history = listOf(beforeNavigation))
        val store = ImMessageStore("conv-1", transport, this)
        store.loadHistory(reset = true)
        val catchUp = ImConversationForegroundCatchUp(this, store::reconcileLatestState)

        catchUp.onForeground()
        runCurrent()
        transport.history = listOf(beforeNavigation, arrivedWhileCovered)

        catchUp.onForeground()
        runCurrent()

        assertEquals(listOf(12, 13), store.messages.value.map { it.seq })
        assertEquals("离开期间的新消息", store.messages.value.last().content)
    }

    @Test
    fun `c2c listed last message with lower seq still appears as latest by createdAt`() = runTest {
        val staleHistory = listOf(
            ImMessage(
                id = 100,
                seq = 100,
                conversationId = "dm-1",
                content = "昨晚旧消息",
                createdAt = "2026-08-18T12:27:00Z",
            ),
            ImMessage(
                id = 101,
                seq = 101,
                conversationId = "dm-1",
                content = "卡u合适的sa经典款式l史蒂夫af",
                createdAt = "2026-08-18T12:27:30Z",
            ),
        )
        val listedLatest = ImMessage(
            id = 5,
            seq = 5,
            conversationId = "dm-1",
            senderId = "peer",
            content = "计划落实1231",
            createdAt = "2026-08-19T05:46:00Z",
        )
        val store = ImMessageStore(
            "dm-1",
            RecordingTransport(history = staleHistory),
            this,
            pageSize = 30,
        )

        store.loadHistory(reset = true)
        store.ingestRealtimeMessage(listedLatest)

        assertEquals("计划落实1231", store.messages.value.last().content)
        assertEquals(listOf(100, 101, 5), store.messages.value.map { it.id })
    }

    @Test
    fun `history keeps latest page and exposes more when sentinel message exists`() = runTest {
        val history = listOf(4, 1, 3, 2).map { id ->
            ImMessage(id = id, seq = id, conversationId = "conv-1", content = "消息$id")
        }
        val store = ImMessageStore(
            "conv-1",
            RecordingTransport(history = history),
            this,
            pageSize = 3,
        )

        store.loadHistory(reset = true)

        assertEquals(listOf(2, 3, 4), store.messages.value.map { it.id })
        assertTrue(store.hasMoreHistory.value)
    }

    @Test
    fun `silent state reconcile merges latest reactions without showing loading`() = runTest {
        val local = ImMessage(
            id = 201,
            seq = 201,
            conversationId = "conv-1",
            senderId = "peer",
            content = "实时回调可能漏掉的消息",
            reactions = mapOf("👍" to listOf("peer")),
        )
        val authoritative = local.copy(
            reactions = mapOf(
                "👍" to listOf("peer"),
                "😂" to listOf("me"),
            ),
        )
        val store = ImMessageStore(
            "conv-1",
            RecordingTransport(history = listOf(authoritative)),
            this,
        )

        store.ingestRealtimeMessage(local)
        store.reconcileLatestState()

        assertFalse("静默对账不应该让会话 UI 进入 loading", store.isLoadingHistory.value)
        assertEquals(listOf("peer"), store.messages.value.single().reactions["👍"])
        assertEquals(listOf("me"), store.messages.value.single().reactions["😂"])
    }

    @Test
    fun `silent state reconcile can authoritatively clear stale reactions`() = runTest {
        val local = ImMessage(
            id = 202,
            seq = 202,
            conversationId = "conv-1",
            senderId = "peer",
            content = "本地旧 Reaction",
            reactions = mapOf("👍" to listOf("peer")),
            reactionOrder = listOf("👍"),
        )
        val authoritative = local.copy(
            content = "远端已移除 Reaction",
            reactions = emptyMap(),
            reactionOrder = emptyList(),
            reactionStateKnown = true,
        )
        val store = ImMessageStore(
            "conv-1",
            RecordingTransport(history = listOf(authoritative)),
            this,
        )

        store.ingestRealtimeMessage(local)
        store.reconcileLatestState()

        assertTrue(store.messages.value.single().reactions.isEmpty())
        assertTrue(store.messages.value.single().reactionOrder.isEmpty())
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `silent state reconcile does not reopen exhausted earlier history`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val local = ImMessage(
            id = 202,
            seq = 202,
            conversationId = "conv-1",
            senderId = "peer",
            content = "已加载到最早一条",
        )
        val store = ImMessageStore(
            "conv-1",
            RecordingTransport(historyGate = gate, history = listOf(local)),
            this,
        )
        store.clearLocalHistory(clearedThroughSeq = 0)
        store.ingestRealtimeMessage(local)

        val reconcile = async { store.reconcileLatestState() }
        runCurrent()

        assertFalse(
            "静默最新页对账在请求期间也不能把已到底状态重新标成可翻页",
            store.hasMoreHistory.value,
        )

        gate.complete(Unit)
        reconcile.await()
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `subscription catch up waits for initial history then fetches again`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val transport = RecordingTransport(historyGate = gate)
        val store = ImMessageStore("conv-1", transport, this)

        store.loadInitial()
        runCurrent()
        store.reconcileLatestState()
        assertEquals(1, transport.historyFetchCalls)

        gate.complete(Unit)
        advanceUntilIdle()

        assertEquals(2, transport.historyFetchCalls)
    }

    @Test
    fun `realtime reply restores preview from a loaded source message`() = runTest {
        val store = ImMessageStore("conv-1", RecordingTransport(), this)
        store.ingestRealtimeMessage(
            ImMessage(
                id = 41,
                seq = 41,
                conversationId = "conv-1",
                senderId = "source-sender",
                content = "本地可见的原消息",
            ),
        )

        store.ingestRealtimeMessage(
            ImMessage(
                id = 42,
                seq = 42,
                conversationId = "conv-1",
                senderId = "reply-sender",
                content = "实时回复",
                replyToId = 41,
                replyToPreview = ImReplyPreview(
                    content = "消息内容不可用",
                    isUnavailable = true,
                ),
            ),
        )

        val preview = store.messages.value.last().replyToPreview
        assertEquals("本地可见的原消息", preview?.content)
        assertEquals("source-sender", preview?.senderId)
        assertFalse(preview?.isUnavailable ?: true)
    }

    @Test
    fun `reply with missing preview restores preview from a loaded source message`() = runTest {
        val store = ImMessageStore("conv-1", RecordingTransport(), this)
        store.ingestRealtimeMessage(
            ImMessage(
                id = 41,
                seq = 41,
                conversationId = "conv-1",
                senderId = "source-sender",
                content = "权威完整消息里的原文",
            ),
        )

        store.ingestRealtimeMessage(
            ImMessage(
                id = 42,
                seq = 42,
                conversationId = "conv-1",
                senderId = "reply-sender",
                content = "实时回复",
                replyToId = 41,
                replyToPreview = null,
            ),
        )

        val preview = store.messages.value.last().replyToPreview
        assertEquals("权威完整消息里的原文", preview?.content)
        assertEquals("source-sender", preview?.senderId)
        assertFalse(preview?.isUnavailable ?: true)
    }

    @Test
    fun `realtime reply keeps unavailable preview without a loaded source message`() = runTest {
        val store = ImMessageStore("conv-1", RecordingTransport(), this)
        store.ingestRealtimeMessage(
            ImMessage(
                id = 42,
                seq = 42,
                conversationId = "conv-1",
                senderId = "reply-sender",
                content = "实时回复",
                replyToId = 41,
                replyToPreview = ImReplyPreview(
                    content = "消息内容不可用",
                    isUnavailable = true,
                ),
            ),
        )

        val preview = store.messages.value.single().replyToPreview
        assertEquals("消息内容不可用", preview?.content)
        assertTrue(preview?.isUnavailable ?: false)
    }

    @Test
    fun `realtime reply keeps unavailable preview for a deleted loaded source message`() = runTest {
        val store = ImMessageStore("conv-1", RecordingTransport(), this)
        store.ingestRealtimeMessage(
            ImMessage(
                id = 41,
                seq = 41,
                conversationId = "conv-1",
                senderId = "source-sender",
                content = "已撤回的原消息",
                isDeleted = true,
            ),
        )

        store.ingestRealtimeMessage(
            ImMessage(
                id = 42,
                seq = 42,
                conversationId = "conv-1",
                senderId = "reply-sender",
                content = "实时回复",
                replyToId = 41,
                replyToPreview = ImReplyPreview(
                    content = "消息内容不可用",
                    isUnavailable = true,
                ),
            ),
        )

        val preview = store.messages.value.last().replyToPreview
        assertEquals("消息内容不可用", preview?.content)
        assertTrue(preview?.isUnavailable ?: false)
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `concurrent fresh sends keep independent pending identities`() = runTest {
        // 回归 ：两次不同的用户提交都必须入队，不能用全局单飞吞掉第二条。
        val gate = CompletableDeferred<Unit>()
        val transport = GatedTransport(gate)
        val store = ImMessageStore("conv-1", transport, this)
        store.currentUserId = "me"

        val first = async { store.performSend(content = "first", clientRequestId = "request-1") }
        val second = async { store.performSend(content = "second", clientRequestId = "request-2") }
        runCurrent()
        assertEquals(listOf("first", "second"), store.pending.value.map { it.content })
        assertEquals(listOf("request-1", "request-2"), store.pending.value.map { it.clientRequestId })
        gate.complete(Unit)
        val results = awaitAll(first, second)

        assertTrue(results.all { it == ImSendOutcome.CONFIRMED })
        assertEquals(2, transport.sendCount)
        assertEquals(listOf("request-1", "request-2"), transport.sentClientRequestIds)
        assertEquals(listOf("first", "second"), store.messages.value.map { it.content })
        assertTrue(store.pending.value.isEmpty())
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `composer enqueue returns before remote transport completes`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val transport = GatedTransport(gate)
        val enqueuedPreviews = mutableListOf<String>()
        val store = ImMessageStore(
            "conv-1",
            transport,
            this,
            onMessageEnqueued = enqueuedPreviews::add,
        )

        val outcome = store.enqueueSend(content = "offline", clientRequestId = "queued-request")
        assertEquals("返回列表前必须同步拿到乐观摘要，不能等待 POST", listOf("offline"), enqueuedPreviews)
        runCurrent()

        assertEquals(ImSendOutcome.ENQUEUED, outcome)
        assertEquals(listOf("queued-request"), store.pending.value.map { it.clientRequestId })
        assertTrue(store.isSending.value)
        gate.complete(Unit)
        runCurrent()
        assertTrue(store.pending.value.isEmpty())
    }

    @Test
    fun `send outcome didEnqueue governs composer clear`() {
        // Composer 仅在内容已入队后清理；本地校验拒绝时保留内容。
        assertTrue("已同步创建 pending：可立即清理 composer", ImSendOutcome.ENQUEUED.didEnqueue)
        assertTrue("成功：可清理 composer", ImSendOutcome.CONFIRMED.didEnqueue)
        assertTrue("已入队为可重试 pending：可清理 composer", ImSendOutcome.FAILED_PENDING.didEnqueue)
        assertFalse("只读拒绝：未入队，必须保留 composer", ImSendOutcome.REJECTED_READ_ONLY.didEnqueue)
    }

    @Test
    fun `failed pending survives store recreation and restores as retryable history`() = runTest {
        val cache = RecordingPendingCache()
        val firstStore = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(failFirst = true),
            scope = this,
            pendingCache = cache,
            cacheScopeId = "user-1",
        )

        assertEquals(
            ImSendOutcome.FAILED_PENDING,
            firstStore.performSend(content = "offline", clientRequestId = "persisted-request"),
        )
        val restoredStore = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(),
            scope = this,
            pendingCache = cache,
            cacheScopeId = "user-1",
        )

        assertEquals(listOf("offline"), restoredStore.pending.value.map { it.content })
        assertEquals("persisted-request", restoredStore.pending.value.single().clientRequestId)
        assertEquals(ImPendingMessage.Status.FAILED, restoredStore.pending.value.single().status)
    }

    @Test
    fun `preferences restored sending becomes retryable when initial history is offline`() = runTest {
        val cache = ImPendingMessagePreferencesCache(ApplicationProvider.getApplicationContext())
        val cacheScopeId = "preferences-offline-user"
        val conversationId = "preferences-offline-conversation"
        val requestId = "preferences-offline-request"
        cache.clearPending(cacheScopeId, conversationId)
        cache.storePending(
            cacheScopeId,
            conversationId,
            listOf(restoredSendingPending(requestId, "进程退出前仍在发送", createdAtEpochMs = 1_234L)),
        )

        try {
            val transport = RecordingTransport(historyFailure = java.io.IOException("offline history"))
            val store = ImMessageStore(
                conversationId = conversationId,
                transport = transport,
                scope = this,
                pendingCache = cache,
                cacheScopeId = cacheScopeId,
            )
            assertEquals(ImPendingMessage.Status.SENDING, store.pending.value.single().status)

            store.loadHistory(reset = true)

            val failed = store.pending.value.single()
            assertEquals(ImPendingMessage.Status.FAILED, failed.status)
            assertEquals(requestId, failed.clientRequestId)
            assertEquals(1_234L, failed.createdAtEpochMs)
            assertNull(failed.errorMessage)
            assertEquals(ImPendingMessage.Status.FAILED, cache.pending(cacheScopeId, conversationId).single().status)

            assertEquals(
                ImSendOutcome.CONFIRMED,
                store.performSend(
                    content = failed.content,
                    clientRequestId = failed.clientRequestId,
                    isRetry = true,
                ),
            )
            assertEquals(listOf(requestId), transport.calls.map { it.requestId })
            assertTrue(store.pending.value.isEmpty())
            assertTrue(cache.pending(cacheScopeId, conversationId).isEmpty())
        } finally {
            cache.clearPending(cacheScopeId, conversationId)
        }
    }

    @Test
    fun `history refresh preserves failed pending until remote confirms it`() = runTest {
        val store = ImMessageStore(
            conversationId = "conv-1",
            transport = RecordingTransport(
                alwaysFail = true,
                history = listOf(ImMessage(id = 81, seq = 81, conversationId = "conv-1", content = "远端历史")),
            ),
            scope = this,
        )

        assertEquals(
            ImSendOutcome.FAILED_PENDING,
            store.performSend(content = "离线失败消息", clientRequestId = "failed-history-request"),
        )
        store.loadHistory(reset = true)

        assertEquals(listOf("远端历史"), store.messages.value.map { it.content })
        assertEquals(listOf("离线失败消息"), store.pending.value.map { it.content })
        assertEquals(ImPendingMessage.Status.FAILED, store.pending.value.single().status)
    }

    @Test
    fun `first failed transport does not block the second queued message`() = runTest {
        val transport = RecordingTransport(failFirst = true)
        var now = 1_500L
        val store = ImMessageStore("conv-1", transport, this, nowEpochMs = { now })
        store.currentUserId = "me"

        store.enqueueSend(content = "first", clientRequestId = "request-1")
        now = 1_700L
        store.enqueueSend(content = "second", clientRequestId = "request-2")
        runCurrent()

        assertEquals(listOf("request-1", "request-2"), transport.calls.map { it.requestId })
        assertEquals(listOf("first"), store.pending.value.map { it.content })
        assertEquals(ImPendingMessage.Status.FAILED, store.pending.value.single().status)
        assertEquals(listOf("second"), store.messages.value.map { it.content })
        assertEquals("1970-01-01T00:00:01.700Z", store.messages.value.single().createdAt)
    }

    @Test
    fun `two queued offline messages both remain failed and retryable`() = runTest {
        val transport = RecordingTransport(alwaysFail = true)
        val store = ImMessageStore("conv-1", transport, this)

        store.enqueueSend(content = "first", clientRequestId = "request-1")
        store.enqueueSend(content = "second", clientRequestId = "request-2")
        runCurrent()

        assertEquals(listOf("request-1", "request-2"), transport.calls.map { it.requestId })
        assertEquals(listOf("first", "second"), store.pending.value.map { it.content })
        assertTrue(store.pending.value.all { it.status == ImPendingMessage.Status.FAILED })
        assertTrue(store.messages.value.isEmpty())
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `known offline sends fail without entering remote transport`() = runTest {
        val transport = RecordingTransport(isSendAvailable = false)
        val store = ImMessageStore("conv-1", transport, this)

        store.enqueueSend(content = "first", clientRequestId = "request-1")
        store.enqueueSend(content = "second", clientRequestId = "request-2")
        runCurrent()

        assertTrue(transport.calls.isEmpty())
        assertEquals(listOf("first", "second"), store.pending.value.map { it.content })
        assertTrue(store.pending.value.all { it.status == ImPendingMessage.Status.FAILED })
        assertTrue(store.messages.value.isEmpty())
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `stalled transport calls time out each queued message into retryable failure`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val transport = GatedTransport(gate)
        val store = ImMessageStore("conv-1", transport, this)

        store.enqueueSend(content = "first", clientRequestId = "request-1")
        store.enqueueSend(content = "second", clientRequestId = "request-2")
        runCurrent()
        advanceTimeBy(30_001)
        runCurrent()

        assertEquals(listOf("request-1", "request-2"), transport.sentClientRequestIds)
        assertEquals(listOf("first", "second"), store.pending.value.map { it.content })
        assertTrue(store.pending.value.all { it.status == ImPendingMessage.Status.FAILED })
        assertFalse(store.isSending.value)
    }

    @Test
    fun `out of order realtime echoes clear only their matching failed pending`() = runTest {
        var now = 1_500L
        val store = ImMessageStore(
            "conv-1",
            RecordingTransport(alwaysFail = true),
            this,
            nowEpochMs = { now },
        )

        store.performSend(content = "first", clientRequestId = "request-1")
        now = 1_700L
        store.performSend(content = "second", clientRequestId = "request-2")
        assertEquals(listOf("request-1", "request-2"), store.pending.value.map { it.clientRequestId })

        store.ingestRealtimeMessage(
            ImMessage(
                id = 92,
                seq = 92,
                conversationId = "conv-1",
                content = "second",
                metadata = ImMessageMetadata(clientRequestId = "request-2"),
            ),
        )
        assertEquals(listOf("request-1"), store.pending.value.map { it.clientRequestId })
        assertEquals("1970-01-01T00:00:01.700Z", store.messages.value.single().createdAt)

        store.ingestRealtimeMessage(
            ImMessage(
                id = 91,
                seq = 91,
                conversationId = "conv-1",
                content = "first",
                metadata = ImMessageMetadata(clientRequestId = "request-1"),
            ),
        )
        assertTrue(store.pending.value.isEmpty())
        assertEquals(listOf("first", "second"), store.messages.value.map { it.content })
    }

    private class RecordingPendingCache : ImPendingMessageCache {
        private var value: List<ImPendingMessage> = emptyList()
        override fun pending(cacheScopeId: String, conversationId: String): List<ImPendingMessage> =
            value.map { it.copy(status = ImPendingMessage.Status.FAILED) }
        override fun storePending(
            cacheScopeId: String,
            conversationId: String,
            pending: List<ImPendingMessage>,
        ) {
            value = pending
        }
        override fun clearPending(cacheScopeId: String, conversationId: String) {
            value = emptyList()
        }

        fun rawPending(): List<ImPendingMessage> = value
    }

    private fun restoredSendingPending(
        clientRequestId: String,
        content: String,
        createdAtEpochMs: Long,
    ): ImPendingMessage = ImPendingMessage(
        clientRequestId = clientRequestId,
        content = content,
        messageType = ImMessageType.TEXT,
        replyToId = null,
        mentionedUserIds = emptyList(),
        mentionedAgentIds = emptyList(),
        mentionAll = false,
        attachment = null,
        card = null,
        createdAtEpochMs = createdAtEpochMs,
        errorMessage = null,
        status = ImPendingMessage.Status.SENDING,
    )

    @Test
    fun `read only policy rejects before pending is created`() = runTest {
        val transport = RecordingTransport()
        val store = ImMessageStore(
            conversationId = "conv-read-only",
            transport = transport,
            scope = this,
            canSend = { false },
        )

        val outcome = store.performSend(content = "不会发出")

        assertEquals(ImSendOutcome.REJECTED_READ_ONLY, outcome)
        assertTrue(store.pending.value.isEmpty())
        assertTrue(transport.calls.isEmpty())
    }

    @Test
    fun `transport read only race removes optimistic pending`() = runTest {
        val transport = object : ImMessageTransport {
            override suspend fun fetchMessages(
                conversationId: String,
                before: Int?,
                limit: Int,
            ): List<ImMessage> = emptyList()

            override suspend fun sendMessage(
                conversationId: String,
                content: String,
                messageType: Int,
                replyToId: Int?,
                mentionedUserIds: List<String>,
                mentionedAgentIds: List<String>,
                mentionAll: Boolean,
                attachment: ImOutgoingAttachment?,
                clientRequestId: String,
            ): ImSendMessageResult = throw ImConversationReadOnlyException()

            override suspend fun editMessage(conversationId: String, messageId: Int, content: String): ImMessage =
                throw UnsupportedOperationException()

            override suspend fun recallMessage(conversationId: String, messageId: Int) = Unit
            override suspend fun addReaction(conversationId: String, messageId: Int, emoji: String) = Unit
            override suspend fun removeReaction(conversationId: String, messageId: Int, emoji: String) = Unit
            override suspend fun markRead(conversationId: String, lastMessageId: Int) = Unit
        }
        val store = ImMessageStore("conv-race", transport, this)

        val outcome = store.performSend(content = "竞态消息", clientRequestId = "read-only-race")

        assertEquals(ImSendOutcome.REJECTED_READ_ONLY, outcome)
        assertTrue("最终成员门禁拒绝后不能留下失败消息", store.pending.value.isEmpty())
    }

    @Test
    fun `retry is not blocked by single-flight`() = runTest {
        // 首发失败后重试（复用原键 + isRetry）不受在途标记影响。
        val transport = RecordingTransport(failFirst = true)
        val store = ImMessageStore("conv-1", transport, this)

        val first = store.performSend(content = "once", clientRequestId = "cr-1")
        assertEquals(ImSendOutcome.FAILED_PENDING, first)
        assertFalse(store.isSending.value)

        val retried = store.performSend(content = "once", clientRequestId = "cr-1", isRetry = true)
        assertEquals(ImSendOutcome.CONFIRMED, retried)
        assertEquals(1, store.messages.value.size)
    }

    @Test
    fun `realtime echo clears failed pending and stays deduplicated`() = runTest {
        val transport = RecordingTransport(failFirst = true)
        val store = ImMessageStore("conv-1", transport, this)

        assertEquals(
            ImSendOutcome.FAILED_PENDING,
            store.performSend(
                content = "图片",
                messageType = ImMessageType.IMAGE,
                attachment = image,
                clientRequestId = "echo-request",
            ),
        )
        assertEquals(1, store.pending.value.size)

        val echo = ImMessage(
            id = 91,
            seq = 12,
            conversationId = "conv-1",
            senderId = "me",
            content = "图片",
            messageType = ImMessageType.IMAGE,
            hasAttachment = true,
            metadata = ImMessageMetadata(
                clientRequestId = "echo-request",
                fileId = image.fileId,
                fileName = image.fileName,
                fileSize = image.fileSize.toInt(),
                fileType = image.fileType,
            ),
        )
        store.ingestRealtimeMessage(echo)
        store.ingestRealtimeMessage(echo)

        assertTrue(store.pending.value.isEmpty())
        assertEquals(listOf(91), store.messages.value.map { it.id })
        assertTrue(store.messages.value.single().isImageAttachment)
    }

    @Test
    fun `explicitly discarded failed attachment releases upload stage usage`() = runTest {
        val released = mutableListOf<String>()
        val transport = RecordingTransport(failFirst = true)
        val store = ImMessageStore(
            "conv-1",
            transport,
            this,
            onReleaseAbandonedAttachment = { released += it.fileId },
        )

        val outcome = store.performSend(
            content = "看这张图",
            messageType = ImMessageType.IMAGE,
            attachment = image,
            clientRequestId = "leave-attachment",
        )
        assertEquals(ImSendOutcome.FAILED_PENDING, outcome)
        assertEquals(image.fileId, store.pending.value.single().attachment?.fileId)

        // 只有清空本地历史等显式丢弃动作才调用；普通离开会话必须保留重试所有权。
        store.releaseAbandonedPendingAttachments()
        assertEquals(listOf(image.fileId), released)
    }

    @Test
    fun `realtime echo releases failed attachment usage exactly once`() = runTest {
        val released = mutableListOf<String>()
        val requestId = "failed-then-realtime"
        val store = ImMessageStore(
            "conv-1",
            RecordingTransport(failFirst = true),
            this,
            onReleaseAbandonedAttachment = { released += it.fileId },
        )

        val outcome = store.performSend(
            content = "HTTP 回包丢失",
            messageType = ImMessageType.IMAGE,
            attachment = image,
            clientRequestId = requestId,
        )
        assertEquals(ImSendOutcome.FAILED_PENDING, outcome)

        store.ingestRealtimeMessage(
            ImMessage(
                id = 701,
                seq = 71,
                conversationId = "conv-1",
                metadata = ImMessageMetadata(clientRequestId = requestId),
            ),
        )
        store.releaseAbandonedPendingAttachments()

        assertEquals(listOf(image.fileId), released)
    }

    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun `clearing in flight attachment releases upload stage usage exactly once`() = runTest {
        val released = mutableListOf<String>()
        val gate = CompletableDeferred<Unit>()
        val store = ImMessageStore(
            "conv-1",
            GatedTransport(gate),
            this,
            onReleaseAbandonedAttachment = { released += it.fileId },
        )

        val sending = async {
            store.performSend(
                content = "在途附件",
                messageType = ImMessageType.IMAGE,
                attachment = image,
                clientRequestId = "inflight-then-clear",
            )
        }
        runCurrent()

        store.clearLocalHistory(clearedThroughSeq = 0)
        assertEquals(listOf(image.fileId), released)

        gate.complete(Unit)
        val outcome = sending.await()
        store.releaseAbandonedPendingAttachments()
        assertEquals(listOf(image.fileId), released)
        assertEquals(ImSendOutcome.DISCARDED_AFTER_CLEAR, outcome)
        assertTrue("清空前已进入发送管线的内容仍可从 composer 收敛", outcome.didEnqueue)
        assertTrue("清空期间完成的 POST 回包不得在本地复活消息", store.messages.value.isEmpty())
        assertTrue("清空期间完成的发送不得重建失败 pending", store.pending.value.isEmpty())
    }

    @Test
    fun `confirmed attachment releases upload stage usage once even after leave`() = runTest {
        // Store 在 HTTP 成功时收敛 request-id 所有权；离开会话不得再重复释放。
        val released = mutableListOf<String>()
        val transport = RecordingTransport()
        val store = ImMessageStore(
            "conv-1",
            transport,
            this,
            onReleaseAbandonedAttachment = { released += it.fileId },
        )

        val outcome = store.performSend(
            content = "已送达",
            messageType = ImMessageType.IMAGE,
            attachment = image,
            clientRequestId = "confirmed-attachment",
        )
        assertEquals(ImSendOutcome.CONFIRMED, outcome)
        assertTrue(store.pending.value.isEmpty())

        store.releaseAbandonedPendingAttachments()
        assertEquals(listOf(image.fileId), released)
    }
}
