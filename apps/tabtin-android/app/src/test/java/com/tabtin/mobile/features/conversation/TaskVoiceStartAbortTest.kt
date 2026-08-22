package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.websocket.AckResult
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.features.memo.voice.ASRStreamClient
import com.tabtin.mobile.features.memo.voice.ASRStreamTransport
import com.tabtin.mobile.features.profile.AIDataSharingConsentStore
import com.tabtin.mobile.util.TokenManager
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * R2-4：ASR start 确认返回前松手 —— generation/abort 保证服务端流被 stop。
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class TaskVoiceStartAbortTest {
    private val dispatcher = StandardTestDispatcher()
    private val focus = ConversationFocusContext(
        appType = "tabdoc",
        spaceId = "space-1",
        workspaceMode = "desktop",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        ASRStreamClient.resetOwnerForTests()
        AIDataSharingConsentStore.grant(RuntimeEnvironment.getApplication())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        ASRStreamClient.resetOwnerForTests()
        AIDataSharingConsentStore.revoke(RuntimeEnvironment.getApplication())
    }

    @Test
    fun `completeHold before start ack aborts and stops stream`() = runTest(dispatcher) {
        val transport = GateFakeTransport()
        val vm = newViewModel(transport)

        vm.beginHold(focus)
        runCurrent()
        assertEquals(TaskVoiceSessionPhase.RECORDING, vm.uiState.value.phase)
        assertTrue(transport.startAwaiting)

        vm.completeHold()
        runCurrent()
        assertEquals(TaskVoiceSessionPhase.IDLE, vm.uiState.value.phase)

        transport.releaseStartAck()
        advanceUntilIdle()

        assertTrue("start 返回后必须发出 stop", transport.stopSent)
        assertFalse(ASRStreamClient.isOwnerHeld())
        assertEquals(TaskVoiceSessionPhase.IDLE, vm.uiState.value.phase)
    }

    @Test
    fun `cancelHold before start ack releases owner`() = runTest(dispatcher) {
        val transport = GateFakeTransport()
        val vm = newViewModel(transport)

        vm.beginHold(focus)
        runCurrent()
        vm.cancelHold()
        runCurrent()
        transport.releaseStartAck()
        advanceUntilIdle()

        assertTrue("cancel 后 ack 返回仍须 stop，避免孤儿流", transport.stopSent)
        assertFalse(ASRStreamClient.isOwnerHeld())
        assertEquals(TaskVoiceSessionPhase.IDLE, vm.uiState.value.phase)
    }

    private fun newViewModel(transport: GateFakeTransport): TaskVoiceViewModel {
        val vm = TaskVoiceViewModel(
            context = RuntimeEnvironment.getApplication(),
            webSocketService = mockk<WebSocketService>(relaxed = true),
            tokenManager = mockk<TokenManager>(relaxed = true),
        )
        vm.clientFactory = { ASRStreamClient(transport) }
        vm.audioFactory = null
        return vm
    }

    private class GateFakeTransport : ASRStreamTransport {
        var stopSent: Boolean = false
        var startAwaiting: Boolean = false
        private val startGate = CompletableDeferred<Unit>()
        private val handlers = mutableMapOf<String, (WSEnvelope) -> Unit>()
        private val streamId: String = "stream-gate-1"

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
            if (type == "asr.stream.start") {
                startAwaiting = true
                startGate.await()
                return AckResult.Ok(buildJsonObject { put("stream_id", streamId) })
            }
            return AckResult.Ok(buildJsonObject {})
        }

        override fun onEnvelope(key: String, handler: (WSEnvelope) -> Unit) {
            handlers[key] = handler
        }

        override fun removeHandler(key: String) {
            handlers.remove(key)
        }

        override fun sendASR(envelope: WSEnvelope) {
            if (envelope.type == "asr.stream.stop") {
                stopSent = true
            }
        }

        fun releaseStartAck() {
            startGate.complete(Unit)
        }
    }
}
