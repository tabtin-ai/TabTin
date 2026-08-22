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
 *  项 4：Composer overlay 与胶囊 TaskVoiceViewModel 共用进程级 ASR owner。
 * 一端持有 owner 时，另一端 preflight / beginHold 必须拒绝，防双录。
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class VoiceDualOwnerTest {
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
    fun `preflight reports ASR_OWNER_BUSY when owner held`() = runTest {
        val context = RuntimeEnvironment.getApplication()
        val holder = ASRStreamClient(OkTransport())
        holder.start()
        assertTrue(ASRStreamClient.isOwnerHeld())

        assertEquals(
            VoiceCaptureBlockReason.ASR_OWNER_BUSY,
            VoiceCapturePreflight.evaluate(context),
        )

        holder.cleanup()
        assertEquals(null, VoiceCapturePreflight.evaluate(context))
    }

    @Test
    fun `TaskVoice beginHold rejected when composer-like owner already held`() = runTest(dispatcher) {
        // 模拟 Composer ChatVoiceInputOverlay 已抢到 ASR owner
        val composerClient = ASRStreamClient(OkTransport())
        composerClient.start()
        assertTrue(ASRStreamClient.isOwnerHeld())

        val capsuleTransport = OkTransport()
        val vm = TaskVoiceViewModel(
            context = RuntimeEnvironment.getApplication(),
            webSocketService = mockk<WebSocketService>(relaxed = true),
            tokenManager = mockk<TokenManager>(relaxed = true),
        )
        vm.clientFactory = { ASRStreamClient(capsuleTransport) }
        vm.audioFactory = null

        vm.beginHold(focus)
        runCurrent()
        advanceUntilIdle()

        assertEquals(TaskVoiceSessionPhase.ERROR, vm.uiState.value.phase)
        assertTrue(vm.uiState.value.errorMessage!!.contains("busy", ignoreCase = true))
        // 胶囊不得再发 start
        assertEquals(0, capsuleTransport.startCount)
        assertTrue(composerClient.holdsOwner())

        composerClient.cleanup()
        assertFalse(ASRStreamClient.isOwnerHeld())
    }

    @Test
    fun `composer-like second client rejected while capsule holds owner`() = runTest(dispatcher) {
        val capsuleTransport = OkTransport()
        val vm = TaskVoiceViewModel(
            context = RuntimeEnvironment.getApplication(),
            webSocketService = mockk<WebSocketService>(relaxed = true),
            tokenManager = mockk<TokenManager>(relaxed = true),
        )
        vm.clientFactory = { ASRStreamClient(capsuleTransport) }
        vm.audioFactory = null

        vm.beginHold(focus)
        advanceUntilIdle()
        assertEquals(TaskVoiceSessionPhase.RECORDING, vm.uiState.value.phase)
        assertTrue(ASRStreamClient.isOwnerHeld())
        assertEquals(1, capsuleTransport.startCount)

        // Composer 侧再开 ASRStreamClient（ChatVoiceInputOverlay 路径）
        val composerTransport = OkTransport()
        val composerClient = ASRStreamClient(composerTransport)
        var threw = false
        try {
            composerClient.start()
        } catch (error: Exception) {
            threw = true
            assertTrue(error.message!!.contains("owner"))
        }
        assertTrue(threw)
        assertEquals(0, composerTransport.startCount)
        assertEquals(
            VoiceCaptureBlockReason.ASR_OWNER_BUSY,
            VoiceCapturePreflight.evaluate(RuntimeEnvironment.getApplication()),
        )

        vm.cancelHold()
        advanceUntilIdle()
        assertFalse(ASRStreamClient.isOwnerHeld())
    }

    private class OkTransport : ASRStreamTransport {
        var startCount: Int = 0
            private set
        private val handlers = mutableMapOf<String, (WSEnvelope) -> Unit>()
        private val streamId = "stream-dual-${System.nanoTime()}"

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
                startCount += 1
                return AckResult.Ok(
                    buildJsonObject {
                        put("stream_id", streamId)
                        put("request_id", "req-dual")
                    },
                )
            }
            return AckResult.Ok(buildJsonObject {})
        }

        override fun onEnvelope(key: String, handler: (WSEnvelope) -> Unit) {
            handlers[key] = handler
        }

        override fun removeHandler(key: String) {
            handlers.remove(key)
        }

        override fun sendASR(envelope: WSEnvelope) = Unit
    }
}
