package com.tabtin.mobile.data.repository

import android.app.Application
import android.content.Context
import com.tabtin.mobile.data.model.PendingSessionReadAck
import com.tabtin.mobile.util.TokenManager
import io.mockk.every
import io.mockk.mockk
import java.io.IOException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import retrofit2.HttpException
import retrofit2.Response

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class SessionReadAckStoreTest {
    private lateinit var context: Context
    private lateinit var store: SessionReadAckStore
    private val sent = mutableListOf<PendingSessionReadAck>()
    private val failuresBySession = mutableMapOf<String, Exception>()

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.deleteSharedPreferences(PREFERENCES_NAME)
        val tokenManager = mockk<TokenManager>()
        every { tokenManager.isLoggedIn } returns true
        every { tokenManager.userId } returns USER_ID
        every { tokenManager.organizationId } returns ORGANIZATION_ID
        sent.clear()
        failuresBySession.clear()
        store = SessionReadAckStore(context, mockk(), tokenManager)
        store.sendReadAck = { candidate ->
            sent += candidate
            failuresBySession[candidate.sessionId]?.let { throw it }
        }
    }

    @After
    fun tearDown() {
        context.deleteSharedPreferences(PREFERENCES_NAME)
    }

    @Test
    fun `http 400 drops the poison ack and delivers later acks in the same flush`() = runTest {
        assertTerminalFailureDropsEntryAndUnblocksQueue(httpError(400))
    }

    @Test
    fun `http 404 drops the poison ack and delivers later acks in the same flush`() = runTest {
        assertTerminalFailureDropsEntryAndUnblocksQueue(httpError(404))
    }

    @Test
    fun `http 409 drops the poison ack and delivers later acks in the same flush`() = runTest {
        assertTerminalFailureDropsEntryAndUnblocksQueue(httpError(409))
    }

    @Test
    fun `http 409 settles the cursor so a later same-watermark ack is not resent`() = runTest {
        val first = ack(sessionId = "session-stale", sequence = 4)
        val sameCursorNewMutation = first.copy(mutationId = "mutation-retry")
        failuresBySession[first.sessionId] = httpError(409)

        store.acknowledgeContentDisplayed(first)
        store.acknowledgeContentDisplayed(sameCursorNewMutation)
        store.flush()

        assertEquals(listOf(first), sent)
        assertTrue(persisted(PENDING_KEY).isEmpty())
        assertEquals(first, persisted(ACKNOWLEDGED_KEY)[first.sessionId])
    }

    @Test
    fun `wrapped http 409 also settles the cursor`() = runTest {
        val first = ack(sessionId = "session-wrapped", sequence = 4)
        failuresBySession[first.sessionId] = RuntimeException("wrapped", httpError(409))

        store.acknowledgeContentDisplayed(first)
        store.acknowledgeContentDisplayed(first.copy(mutationId = "mutation-retry"))

        assertEquals(listOf(first), sent)
        assertEquals(first, persisted(ACKNOWLEDGED_KEY)[first.sessionId])
    }

    @Test
    fun `io failure keeps the entry pending and stops the flush`() = runTest {
        val poison = ack(sessionId = "session-poison", sequence = 1)
        val queued = ack(sessionId = "session-queued", sequence = 2)
        failuresBySession[poison.sessionId] = IOException("network down")

        store.acknowledgeContentDisplayed(poison)
        store.acknowledgeContentDisplayed(queued)
        store.flush()

        // 队首条目反复失败但不会被丢弃，后面的条目也不会被尝试。
        assertTrue(sent.isNotEmpty())
        assertTrue(sent.all { it == poison })
        val pending = persisted(PENDING_KEY)
        assertEquals(setOf(poison.sessionId, queued.sessionId), pending.keys)
        assertTrue(persisted(ACKNOWLEDGED_KEY).isEmpty())
    }

    @Test
    fun `successful ack moves the entry to acknowledged and persists`() = runTest {
        val candidate = ack(sessionId = "session-ok", sequence = 3)

        store.acknowledgeContentDisplayed(candidate)

        assertEquals(listOf(candidate), sent)
        assertTrue(persisted(PENDING_KEY).isEmpty())
        assertEquals(candidate, persisted(ACKNOWLEDGED_KEY)[candidate.sessionId])
    }

    private suspend fun assertTerminalFailureDropsEntryAndUnblocksQueue(error: Exception) {
        val poison = ack(sessionId = "session-poison", sequence = 1)
        val queued = ack(sessionId = "session-queued", sequence = 2)
        failuresBySession[poison.sessionId] = error

        store.acknowledgeContentDisplayed(poison)
        store.acknowledgeContentDisplayed(queued)
        store.flush()

        // 毒消息只尝试一次即被丢弃；同一次 flush 继续投递后续合法 ACK。
        assertEquals(listOf(poison, queued), sent)
        assertTrue(persisted(PENDING_KEY).isEmpty())
        val acknowledged = persisted(ACKNOWLEDGED_KEY)
        assertEquals(poison, acknowledged[poison.sessionId])
        assertEquals(queued, acknowledged[queued.sessionId])
    }

    private fun ack(
        sessionId: String,
        sequence: Int,
    ): PendingSessionReadAck = PendingSessionReadAck(
        sessionId = sessionId,
        throughRunId = "run-$sequence",
        throughSequence = sequence,
        throughRevision = sequence.toLong(),
        mutationId = "mutation-$sessionId",
    )

    private fun httpError(code: Int): HttpException =
        HttpException(Response.error<Any>(code, "error".toResponseBody(null)))

    private fun persisted(key: String): Map<String, PendingSessionReadAck> {
        val prefs = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
        val encoded = prefs.getString("$key.$USER_ID.$ORGANIZATION_ID", null) ?: return emptyMap()
        return Json { ignoreUnknownKeys = true }.decodeFromString(encoded)
    }

    private companion object {
        private const val PREFERENCES_NAME = "tabtin_session_read_ack"
        private const val PENDING_KEY = "pending.v1"
        private const val ACKNOWLEDGED_KEY = "acknowledged.v1"
        private const val USER_ID = "user-1"
        private const val ORGANIZATION_ID = "org-1"
    }
}
