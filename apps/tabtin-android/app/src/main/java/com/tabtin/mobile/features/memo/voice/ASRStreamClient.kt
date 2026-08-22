package com.tabtin.mobile.features.memo.voice

import android.util.Base64
import android.util.Log
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.websocket.AckResult
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.TokenManager
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * ASR 流式识别客户端，通过 Gateway WebSocket 与后端 ASR 服务通信。
 *
 * 协议流程：
 *   1. `sendAndWaitAck(asr.stream.start)` → `asr.stream.started`（request_id / stream_id）
 *   2. 发送 `asr.stream.audio` → `asr.stream.event`
 *   3. 发送 `asr.stream.stop` → `asr.stream.done`
 *
 * 同一时刻只允许一个录音 owner（进程级）。
 */
public class ASRStreamClient(
    private val transport: ASRStreamTransport,
) {
    public constructor(
        webSocketService: WebSocketService,
        tokenManager: TokenManager,
    ) : this(WebSocketASRStreamTransport(webSocketService, tokenManager))

    public companion object {
        private const val TAG = "ASRStreamClient"
        private const val START_TIMEOUT_MS = 10_000L

        private val activeOwner = AtomicReference<String?>(null)

        public fun isOwnerHeld(): Boolean = activeOwner.get() != null

        /** 测试钩子：释放全局 owner。 */
        internal fun resetOwnerForTests() {
            activeOwner.set(null)
        }

        internal fun currentOwnerForTests(): String? = activeOwner.get()
    }

    private val ownerToken: String = "asr_${UUID.randomUUID()}"
    private var streamId: String? = null
    private val handlerKey = "asr_stream_${UUID.randomUUID().toString().take(8)}"
    private var isActive = false
    /** start 确认返回前若调用方已松手/取消，置位；start 成功后立即 stop。 */
    @Volatile private var abortRequested: Boolean = false
    private var terminalSignal: CompletableDeferred<Unit> = CompletableDeferred()

    public var onTranscript: ((text: String, isFinal: Boolean) -> Unit)? = null
    public var onError: ((errorMsg: String) -> Unit)? = null

    /** 当前实例是否仍持有进程级 ASR owner（供终态释放断言）。 */
    public fun holdsOwner(): Boolean = activeOwner.get() == ownerToken

    /** 服务端流是否已确认启动（有 stream_id 且未 cleanup）。 */
    public fun isStreamActive(): Boolean = isActive && streamId != null

    /**
     * R2-4：在 start 确认前/中请求中止。若流已 active 则立即 stop+cleanup；
     * 若仍在 await ack，[start] 返回后调用方或本方法内会立刻 stop。
     */
    public fun requestAbort() {
        abortRequested = true
        if (isActive && streamId != null) {
            stop()
            cleanup()
        }
    }

    /** 消费 abort 标记（调用方在 start 成功后检查）。 */
    public fun consumeAbortIfRequested(): Boolean {
        val aborted = abortRequested
        abortRequested = false
        return aborted
    }

    public suspend fun start(
        sampleRate: Int = 16000,
        language: String = "",
        hotwords: List<String> = emptyList(),
        enablePunctuation: Boolean = true,
    ): String {
        if (isActive) throw ASRException("ASR session already active")
        if (!activeOwner.compareAndSet(null, ownerToken)) {
            throw ASRException("ASR owner already held")
        }
        // 勿在此清 abortRequested：start 调用前松手可能已 requestAbort

        try {
            if (abortRequested) {
                releaseOwner()
                throw ASRException("ASR start aborted")
            }
            val wsReady = transport.connectAndWait(timeoutMs = 10_000L)
            if (!wsReady) throw ASRException("WebSocket not connected")

            val payloadPairs = mutableListOf<Pair<String, Any?>>(
                // AudioRecordingService streams headerless PCM 16-bit LE chunks.
                // The .wav container exists only for the local saved recording.
                "audio_format" to "pcm",
                "sample_rate" to sampleRate,
                "provider" to "bytedance",
                "ws_endpoint" to "bigmodel_async",
                "enable_nonstream" to true,
                "enable_itn" to true,
                "enable_punc" to enablePunctuation,
                "enable_ddc" to true,
                "show_utterances" to true,
            )
            if (language.isNotEmpty()) {
                payloadPairs.add("language" to language)
            }
            if (hotwords.isNotEmpty()) {
                payloadPairs.add("hotwords" to hotwords)
            }

            val ack = transport.sendAndWaitAck(
                type = "asr.stream.start",
                payload = WSEnvelope.buildPayload(*payloadPairs.toTypedArray()),
                okType = "asr.stream.started",
                nakType = "asr.stream.error",
                timeoutMs = START_TIMEOUT_MS,
            )

            val sid = when (ack) {
                is AckResult.Ok -> ack.payload.stringField("stream_id")
                    ?: throw ASRException("ASR start missing stream_id")
                is AckResult.Nak -> throw ASRException(ack.errorMessage.ifBlank { "ASR start rejected" })
                AckResult.Timeout -> throw ASRException("ASR start timeout")
                AckResult.Disconnected -> throw ASRException("WebSocket not connected")
            }

            registerHandler()
            streamId = sid
            isActive = true
            terminalSignal = CompletableDeferred()
            Log.i(TAG, "ASR stream started: $sid owner=$ownerToken")

            // R2-4：ack 已返回则服务端有流——abort 时必须立刻 stop，不能只 releaseOwner
            if (abortRequested) {
                stop()
                cleanup()
                throw ASRException("ASR start aborted")
            }
            return sid
        } catch (error: Exception) {
            if (!isActive) {
                releaseOwner()
            }
            throw if (error is ASRException) error else ASRException(error.message ?: "ASR start failed")
        }
    }

    /**
     * 等待 `asr.stream.done` / error / cleanup。超时返回 false（调用方须 cleanup 释放 owner）。
     */
    public suspend fun awaitDone(timeoutMs: Long = 5_000L): Boolean {
        if (terminalSignal.isCompleted) return true
        return withTimeoutOrNull(timeoutMs) {
            terminalSignal.await()
            true
        } ?: false
    }

    public fun sendAudio(data: ByteArray) {
        val sid = streamId ?: return
        if (!isActive || activeOwner.get() != ownerToken) return

        val base64 = Base64.encodeToString(data, Base64.NO_WRAP)
        val deviceId = transport.deviceId
        val wsId = transport.organizationId ?: ""

        val envelope = WSEnvelope.build(
            type = "asr.stream.audio",
            deviceId = deviceId,
            payload = WSEnvelope.buildPayload(
                "stream_id" to sid,
                "data" to base64,
            ),
            organizationId = wsId,
        )
        transport.sendASR(envelope)
    }

    public fun stop() {
        val sid = streamId ?: return
        if (!isActive) return

        val deviceId = transport.deviceId
        val wsId = transport.organizationId ?: ""

        val envelope = WSEnvelope.build(
            type = "asr.stream.stop",
            deviceId = deviceId,
            payload = WSEnvelope.buildPayload("stream_id" to sid),
            organizationId = wsId,
        )
        transport.sendASR(envelope)
        Log.i(TAG, "ASR stream stop sent: $sid")
    }

    public fun cleanup() {
        isActive = false
        streamId = null
        abortRequested = false
        transport.removeHandler(handlerKey)
        onTranscript = null
        onError = null
        releaseOwner()
        completeTerminal()
    }

    private fun releaseOwner() {
        activeOwner.compareAndSet(ownerToken, null)
    }

    private fun completeTerminal() {
        if (!terminalSignal.isCompleted) {
            terminalSignal.complete(Unit)
        }
    }

    private fun registerHandler() {
        transport.onEnvelope(handlerKey) { envelope ->
            handleEnvelope(envelope)
        }
    }

    private fun handleEnvelope(envelope: WSEnvelope) {
        when (envelope.type) {
            "asr.stream.event" -> {
                val sid = envelope.payloadString("stream_id")
                if (sid != null && sid == streamId) {
                    val text = envelope.payloadString("text") ?: ""
                    onTranscript?.invoke(text, false)
                }
            }

            "asr.stream.done" -> {
                val sid = envelope.payloadString("stream_id")
                if (sid != null && sid == streamId) {
                    val text = envelope.payloadString("text") ?: ""
                    onTranscript?.invoke(text, true)
                    isActive = false
                    transport.removeHandler(handlerKey)
                    releaseOwner()
                    completeTerminal()
                }
            }

            "asr.stream.error" -> {
                val sid = envelope.payloadString("stream_id")
                // start 阶段 error 已由 sendAndWaitAck 消费；此处只处理流中错误。
                if (sid != null && sid == streamId) {
                    val errorMsg = envelope.payloadString("error") ?: "语音识别出错"
                    Log.e(TAG, "ASR error: $errorMsg")
                    onError?.invoke(errorMsg)
                    isActive = false
                    transport.removeHandler(handlerKey)
                    releaseOwner()
                    completeTerminal()
                }
            }
        }
    }
}

private fun JsonObject.stringField(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

public class ASRException(message: String) : Exception(message)
