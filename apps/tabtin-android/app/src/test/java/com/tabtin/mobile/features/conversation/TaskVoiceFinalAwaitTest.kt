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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
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
 * P1-4：松手进 PROCESSING，等 asr.stream.done / final；迟到 final 不得打回 TRANSCRIBING。
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class TaskVoiceFinalAwaitTest {
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
    fun `completeHold waits for stream done before READY_TO_SEND`() = runTest(dispatcher) {
        val transport = ControllableFakeTransport()
        val vm = newViewModel(transport)

        vm.beginHold(focus)
        advanceUntilIdle()
        assertEquals(TaskVoiceSessionPhase.RECORDING, vm.uiState.value.phase)
        assertTrue(ASRStreamClient.isOwnerHeld())

        transport.emitEvent(text = "partial hello", isFinal = false)
        advanceUntilIdle()
        assertEquals(TaskVoiceSessionPhase.TRANSCRIBING, vm.uiState.value.phase)

        vm.completeHold()
        // 勿 advanceUntilIdle：会把 awaitDone 的 timeout 一起跑完
        runCurrent()
        assertEquals(TaskVoiceSessionPhase.PROCESSING, vm.uiState.value.phase)
        assertTrue(transport.stopSent)

        transport.emitDone(text = "final hello")
        runCurrent()
        assertEquals(TaskVoiceSessionPhase.READY_TO_SEND, vm.uiState.value.phase)
        assertEquals("final hello", vm.uiState.value.transcript)
        assertFalse(ASRStreamClient.isOwnerHeld())
    }

    @Test
    fun `completeHold timeout with partial still releases owner`() = runTest(dispatcher) {
        val transport = ControllableFakeTransport()
        val vm = newViewModel(transport, finalTimeoutMs = 50L)

        vm.beginHold(focus)
        advanceUntilIdle()
        transport.emitEvent(text = "partial only", isFinal = false)
        advanceUntilIdle()

        vm.completeHold()
        runCurrent()
        assertEquals(TaskVoiceSessionPhase.PROCESSING, vm.uiState.value.phase)

        advanceTimeBy(60)
        runCurrent()
        assertEquals(TaskVoiceSessionPhase.READY_TO_SEND, vm.uiState.value.phase)
        assertEquals("partial only", vm.uiState.value.transcript)
        assertFalse(ASRStreamClient.isOwnerHeld())
    }

    @Test
    fun `late final after cancel does not leave TRANSCRIBING or re-hold owner`() = runTest(dispatcher) {
        val transport = ControllableFakeTransport()
        val vm = newViewModel(transport)

        vm.beginHold(focus)
        advanceUntilIdle()
        transport.emitEvent(text = "gone", isFinal = false)
        advanceUntilIdle()

        vm.cancelHold()
        advanceUntilIdle()
        assertEquals(TaskVoiceSessionPhase.IDLE, vm.uiState.value.phase)
        assertFalse(ASRStreamClient.isOwnerHeld())

        transport.emitDone(text = "late final")
        advanceUntilIdle()
        assertEquals(TaskVoiceSessionPhase.IDLE, vm.uiState.value.phase)
        assertFalse(ASRStreamClient.isOwnerHeld())
    }

    @Test
    fun `cancel during PROCESSING releases owner`() = runTest(dispatcher) {
        val transport = ControllableFakeTransport()
        val vm = newViewModel(transport, finalTimeoutMs = 10_000L)

        vm.beginHold(focus)
        advanceUntilIdle()
        transport.emitEvent(text = "x", isFinal = false)
        advanceUntilIdle()
        vm.completeHold()
        runCurrent()
        assertEquals(TaskVoiceSessionPhase.PROCESSING, vm.uiState.value.phase)

        vm.cancelHold()
        runCurrent()
        assertEquals(TaskVoiceSessionPhase.IDLE, vm.uiState.value.phase)
        assertFalse(ASRStreamClient.isOwnerHeld())

        transport.emitDone(text = "should ignore")
        runCurrent()
        assertEquals(TaskVoiceSessionPhase.IDLE, vm.uiState.value.phase)
    }

    private fun newViewModel(
        transport: ControllableFakeTransport,
        finalTimeoutMs: Long = 5_000L,
    ): TaskVoiceViewModel {
        val vm = TaskVoiceViewModel(
            context = RuntimeEnvironment.getApplication(),
            webSocketService = mockk<WebSocketService>(relaxed = true),
            tokenManager = mockk<TokenManager>(relaxed = true),
        )
        vm.clientFactory = { ASRStreamClient(transport) }
        vm.audioFactory = null
        vm.finalTimeoutMs = finalTimeoutMs
        return vm
    }

    private class ControllableFakeTransport : ASRStreamTransport {
        var stopSent: Boolean = false
        private val handlers = mutableMapOf<String, (WSEnvelope) -> Unit>()
        private val streamId: String = "stream-test-1"

        override val deviceId: String = "device-1"
        override val organizationId: String? = "org-1"

        override suspend fun connectAndWait(timeoutMs: Long): Boolean = true

        override suspend fun sendAndWaitAck(
            type: String,
            payload: JsonObject,
            okType: String,
            nakType: String,
            timeoutMs: Long,
        ): AckResult = AckResult.Ok(buildJsonObject { put("stream_id", streamId) })

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

        fun emitEvent(text: String, isFinal: Boolean) {
            val type = if (isFinal) "asr.stream.done" else "asr.stream.event"
            dispatch(
                WSEnvelope.build(
                    type = type,
                    deviceId = deviceId,
                    payload = WSEnvelope.buildPayload(
                        "stream_id" to streamId,
                        "text" to text,
                    ),
                    organizationId = organizationId,
                ),
            )
        }

        fun emitDone(text: String) = emitEvent(text, isFinal = true)

        private fun dispatch(envelope: WSEnvelope) {
            handlers.values.toList().forEach { it(envelope) }
        }
    }
}
