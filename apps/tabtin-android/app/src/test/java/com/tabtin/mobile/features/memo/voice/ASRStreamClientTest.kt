package com.tabtin.mobile.features.memo.voice

import android.app.Application
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.websocket.AckResult
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 *  项 3：`sendAndWaitAck(asr.stream.start)` Fake WS 集成测。
 *
 * Fake 模拟 WebSocketService 的 request_id 登记 / 回包关联：
 * start 发出时生成 request_id，ok/nak 回包必须携带同一 request_id 才交付 AckResult；
 * 错配 request_id 被丢弃并最终 timeout。
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class ASRStreamClientTest {
    @Before
    fun setUp() {
        ASRStreamClient.resetOwnerForTests()
    }

    @After
    fun tearDown() {
        ASRStreamClient.resetOwnerForTests()
    }

    @Test
    fun `start ok correlates request_id and returns stream_id`() = runTest {
        val transport = FakeWebSocketASRStreamTransport(AckScenario.OK)
        val client = ASRStreamClient(transport)

        val sid = client.start()

        assertEquals("stream-ok-1", sid)
        assertEquals("asr.stream.start", transport.lastStartType)
        assertEquals("asr.stream.started", transport.lastOkType)
        assertEquals("asr.stream.error", transport.lastNakType)
        assertEquals(
            "bigmodel_async",
            (transport.lastStartPayload?.get("ws_endpoint") as? JsonPrimitive)?.contentOrNull,
        )
        assertEquals(JsonPrimitive(true), transport.lastStartPayload?.get("enable_nonstream"))
        assertEquals(
            "pcm",
            (transport.lastStartPayload?.get("audio_format") as? JsonPrimitive)?.contentOrNull,
        )
        assertNotNull(transport.lastRequestId)
        assertTrue(transport.lastRequestId!!.isNotBlank())
        assertEquals(transport.lastRequestId, transport.lastAckRequestId)
        assertTrue(ASRStreamClient.isOwnerHeld())
        assertTrue(client.holdsOwner())
        assertTrue(client.isStreamActive())

        client.sendAudio(byteArrayOf(1, 2, 3))
        assertEquals("stream-ok-1", transport.lastAudioStreamId)

        client.cleanup()
        assertFalse(ASRStreamClient.isOwnerHeld())
    }

    @Test
    fun `start nak with matching request_id releases owner and throws`() = runTest {
        val transport = FakeWebSocketASRStreamTransport(AckScenario.NAK)
        val client = ASRStreamClient(transport)
        try {
            client.start()
            fail("expected ASRException")
        } catch (error: ASRException) {
            assertTrue(error.message!!.contains("denied"))
        }
        assertEquals("asr.stream.start", transport.lastStartType)
        assertEquals(transport.lastRequestId, transport.lastAckRequestId)
        assertFalse(ASRStreamClient.isOwnerHeld())
        assertFalse(client.holdsOwner())
    }

    @Test
    fun `start timeout when no matching ack releases owner`() = runTest {
        val transport = FakeWebSocketASRStreamTransport(AckScenario.TIMEOUT)
        val client = ASRStreamClient(transport)
        try {
            client.start()
            fail("expected ASRException")
        } catch (error: ASRException) {
            assertTrue(error.message!!.contains("timeout"))
        }
        assertNotNull(transport.lastRequestId)
        assertEquals(null, transport.lastAckRequestId)
        assertFalse(ASRStreamClient.isOwnerHeld())
    }

    @Test
    fun `mismatched request_id ack is ignored then times out`() = runTest {
        val transport = FakeWebSocketASRStreamTransport(AckScenario.MISMATCHED_REQUEST_ID)
        val client = ASRStreamClient(transport)
        try {
            client.start()
            fail("expected ASRException")
        } catch (error: ASRException) {
            assertTrue(error.message!!.contains("timeout"))
        }
        assertNotNull(transport.lastRequestId)
        assertEquals("wrong-request-id", transport.lastAckRequestId)
        assertFalse(ASRStreamClient.isOwnerHeld())
    }

    @Test
    fun `ok missing stream_id releases owner and throws`() = runTest {
        val transport = FakeWebSocketASRStreamTransport(AckScenario.OK_MISSING_STREAM_ID)
        val client = ASRStreamClient(transport)
        try {
            client.start()
            fail("expected ASRException")
        } catch (error: ASRException) {
            assertTrue(error.message!!.contains("stream_id"))
        }
        assertFalse(ASRStreamClient.isOwnerHeld())
    }

    @Test
    fun `second start rejected while owner held`() = runTest {
        val firstTransport = FakeWebSocketASRStreamTransport(AckScenario.OK)
        val first = ASRStreamClient(firstTransport)
        first.start()
        assertEquals(1, firstTransport.startCount.get())

        val secondTransport = FakeWebSocketASRStreamTransport(AckScenario.OK)
        val second = ASRStreamClient(secondTransport)
        try {
            second.start()
            fail("expected ASRException")
        } catch (error: ASRException) {
            assertTrue(error.message!!.contains("owner"))
        }
        // 抢 owner 失败时不得再发 WS start
        assertEquals(0, secondTransport.startCount.get())
        first.cleanup()
    }

    @Test
    fun `same client second start while active is rejected`() = runTest {
        val transport = FakeWebSocketASRStreamTransport(AckScenario.OK)
        val client = ASRStreamClient(transport)
        client.start()
        try {
            client.start()
            fail("expected ASRException")
        } catch (error: ASRException) {
            assertTrue(error.message!!.contains("already active"))
        }
        assertEquals(1, transport.startCount.get())
        client.cleanup()
    }

    private enum class AckScenario {
        OK,
        NAK,
        TIMEOUT,
        MISMATCHED_REQUEST_ID,
        OK_MISSING_STREAM_ID,
    }

    /**
     * 模拟 WebSocketService.sendAndWaitAck：登记 request_id，仅匹配回包才交付结果。
     */
    private class FakeWebSocketASRStreamTransport(
        private val scenario: AckScenario,
    ) : ASRStreamTransport {
        var lastStartType: String? = null
        var lastOkType: String? = null
        var lastNakType: String? = null
        var lastStartPayload: JsonObject? = null
        var lastRequestId: String? = null
        /** 实际用于完成 deferred 的回包 request_id（错配场景可与 lastRequestId 不同）。 */
        var lastAckRequestId: String? = null
        var lastAudioStreamId: String? = null
        val startCount = AtomicInteger(0)
        private val handlers = mutableMapOf<String, (WSEnvelope) -> Unit>()

        override val deviceId: String = "device-1"
        override val organizationId: String? = "org-1"

        override suspend fun connectAndWait(timeoutMs: Long): Boolean = true

        override suspend fun sendAndWaitAck(
            type: String,
            payload: JsonObject,
            okType: String,
            nakType: String,
            timeoutMs: Long,
        ): AckResult {
            lastStartType = type
            lastOkType = okType
            lastNakType = nakType
            lastStartPayload = payload
            val requestId = UUID.randomUUID().toString()
            lastRequestId = requestId
            if (type == "asr.stream.start") {
                startCount.incrementAndGet()
            }

            return when (scenario) {
                AckScenario.OK -> {
                    lastAckRequestId = requestId
                    AckResult.Ok(
                        buildJsonObject {
                            put("stream_id", "stream-ok-1")
                            put("request_id", requestId)
                        },
                    )
                }
                AckScenario.NAK -> {
                    lastAckRequestId = requestId
                    AckResult.Nak(
                        errorCode = "ASR_DENIED",
                        errorMessage = "denied",
                        errorCategory = "asr",
                        retryable = false,
                    )
                }
                AckScenario.TIMEOUT -> {
                    // 无匹配回包
                    lastAckRequestId = null
                    AckResult.Timeout
                }
                AckScenario.MISMATCHED_REQUEST_ID -> {
                    // 模拟收到错配 request_id 的 started：不应交付 Ok，最终 timeout
                    lastAckRequestId = "wrong-request-id"
                    AckResult.Timeout
                }
                AckScenario.OK_MISSING_STREAM_ID -> {
                    lastAckRequestId = requestId
                    AckResult.Ok(
                        buildJsonObject {
                            put("request_id", requestId)
                        },
                    )
                }
            }
        }

        override fun onEnvelope(key: String, handler: (WSEnvelope) -> Unit) {
            handlers[key] = handler
        }

        override fun removeHandler(key: String) {
            handlers.remove(key)
        }

        override fun sendASR(envelope: WSEnvelope) {
            if (envelope.type == "asr.stream.audio") {
                lastAudioStreamId = envelope.payloadString("stream_id")
                    ?: (envelope.payload["stream_id"] as? JsonPrimitive)?.contentOrNull
            }
        }
    }
}
