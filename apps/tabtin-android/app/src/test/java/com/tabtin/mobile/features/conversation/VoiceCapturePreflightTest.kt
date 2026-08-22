package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.websocket.AckResult
import com.tabtin.mobile.features.memo.voice.ASRStreamClient
import com.tabtin.mobile.features.memo.voice.ASRStreamTransport
import com.tabtin.mobile.features.profile.AIDataSharingConsentStore
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class VoiceCapturePreflightTest {
    @Before
    fun setUp() {
        ASRStreamClient.resetOwnerForTests()
        AIDataSharingConsentStore.revoke(RuntimeEnvironment.getApplication())
    }

    @After
    fun tearDown() {
        ASRStreamClient.resetOwnerForTests()
        AIDataSharingConsentStore.revoke(RuntimeEnvironment.getApplication())
    }

    @Test
    fun `needs consent before grant`() {
        val context = RuntimeEnvironment.getApplication()
        assertEquals(
            VoiceCaptureBlockReason.NEEDS_AI_CONSENT,
            VoiceCapturePreflight.evaluate(context),
        )
    }

    @Test
    fun `allows after consent when owner free`() {
        val context = RuntimeEnvironment.getApplication()
        VoiceCapturePreflight.grantAiConsent(context)
        assertNull(VoiceCapturePreflight.evaluate(context))
    }

    @Test
    fun `rejects when asr owner already held`() = runTest {
        val context = RuntimeEnvironment.getApplication()
        VoiceCapturePreflight.grantAiConsent(context)
        val holder = ASRStreamClient(object : ASRStreamTransport {
            override val deviceId: String = "device-1"
            override val organizationId: String? = "org-1"
            override suspend fun connectAndWait(timeoutMs: Long): Boolean = true
            override suspend fun sendAndWaitAck(
                type: String,
                payload: JsonObject,
                okType: String,
                nakType: String,
                timeoutMs: Long,
            ): AckResult = AckResult.Ok(buildJsonObject { put("stream_id", "preflight-1") })
            override fun onEnvelope(key: String, handler: (WSEnvelope) -> Unit) = Unit
            override fun removeHandler(key: String) = Unit
            override fun sendASR(envelope: WSEnvelope) = Unit
        })
        holder.start()

        assertEquals(
            VoiceCaptureBlockReason.ASR_OWNER_BUSY,
            VoiceCapturePreflight.evaluate(context),
        )
        holder.cleanup()
        assertNull(VoiceCapturePreflight.evaluate(context))
    }
}
