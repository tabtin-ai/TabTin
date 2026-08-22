package com.tabtin.mobile.data.im

import android.app.Application
import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.tabtin.mobile.data.local.ChatDatabase
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class ImMessageRoomCacheTest {
    private lateinit var database: ChatDatabase

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext<Context>(),
            ChatDatabase::class.java,
        ).build()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun `database restores messages and monotonic read waterlines`() = runTest {
        val cache = ImMessageRoomCache(database.imMessageCacheDao(), this)
        val message = ImMessage(
            id = 42,
            seq = 42,
            conversationId = "conv-db",
            senderId = "me",
            content = "数据库快照",
            readReceipt = ImReadReceipt(readCount = 1, recipientCount = 1),
        )

        cache.store("user-a", "conv-db", listOf(message))
        cache.advanceReadWaterline("user-a", "conv-db", "peer", 42)
        cache.advanceReadWaterline("user-a", "conv-db", "peer", 21)
        advanceUntilIdle()
        cache.awaitPendingWrites()

        assertEquals(listOf(message), cache.messagesAsync("user-a", "conv-db"))
        assertEquals(42, cache.readWaterlines("user-a", "conv-db")["peer"])
        assertEquals(emptyList<ImMessage>(), cache.messagesAsync("user-b", "conv-db"))
        assertEquals(emptyMap<String, Int>(), cache.readWaterlines("user-b", "conv-db"))
    }

    @Test
    fun `database restores complete pinned snapshot and authoritative empty clears it`() = runTest {
        val cache = ImMessageRoomCache(database.imMessageCacheDao(), this)
        val pinned = ImMessage(
            id = 84,
            seq = 84,
            conversationId = "conv-pinned",
            content = "较早但仍置顶的消息",
            isPinned = true,
            pinStateKnown = true,
        )

        cache.storePinnedMessages("user-a", "conv-pinned", listOf(pinned))
        advanceUntilIdle()
        cache.awaitPendingWrites()

        assertEquals(listOf(pinned), cache.pinnedMessagesAsync("user-a", "conv-pinned"))
        assertEquals(emptyList<ImMessage>(), cache.pinnedMessagesAsync("user-b", "conv-pinned"))

        cache.storePinnedMessages("user-a", "conv-pinned", emptyList())
        advanceUntilIdle()
        cache.awaitPendingWrites()

        assertEquals(emptyList<ImMessage>(), cache.pinnedMessagesAsync("user-a", "conv-pinned"))
    }

    @Test
    fun `pinned snapshot revisions are monotonic per scope and conversation`() {
        val revisions = ImSnapshotRevisionClock()
        val stale = revisions.next("user-a", "conv-pinned")
        val cleared = revisions.next("user-a", "conv-pinned")
        val otherConversation = revisions.next("user-a", "conv-other")
        val otherScope = revisions.next("user-b", "conv-pinned")

        assertFalse(revisions.isLatest("user-a", "conv-pinned", stale))
        assertTrue(revisions.isLatest("user-a", "conv-pinned", cleared))
        assertTrue(revisions.isLatest("user-a", "conv-other", otherConversation))
        assertTrue(revisions.isLatest("user-b", "conv-pinned", otherScope))
    }

    @Test
    fun `late regular snapshot write cannot overwrite a newer clear`() = runTest {
        val staleWriteStarted = CompletableDeferred<Unit>()
        val releaseStaleWrite = CompletableDeferred<Unit>()
        val cache = ImMessageRoomCache(
            dao = database.imMessageCacheDao(),
            ioScope = this,
            beforeMessageStoreMutation = {
                staleWriteStarted.complete(Unit)
                releaseStaleWrite.await()
            },
        )
        val stale = ImMessage(
            id = 85,
            seq = 85,
            conversationId = "conv-regular",
            content = "清空前排队的普通消息快照",
        )

        cache.store("user-a", "conv-regular", listOf(stale))
        runCurrent()
        staleWriteStarted.await()

        cache.clear("user-a", "conv-regular")
        runCurrent()
        releaseStaleWrite.complete(Unit)
        advanceUntilIdle()
        cache.awaitPendingWrites()

        assertTrue(cache.messagesAsync("user-a", "conv-regular").isEmpty())
    }
}
