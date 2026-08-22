package com.tabtin.mobile.features.memo.voice

import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.websocket.AckResult
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.TokenManager
import kotlinx.serialization.json.JsonObject

/**
 * ASR 对 WebSocket 的最小依赖面，便于 Fake / mock 覆盖 start ack 路径。
 */
public interface ASRStreamTransport {
    public val deviceId: String
    public val organizationId: String?

    public suspend fun connectAndWait(timeoutMs: Long = 10_000L): Boolean

    public suspend fun sendAndWaitAck(
        type: String,
        payload: JsonObject,
        okType: String,
        nakType: String,
        timeoutMs: Long,
    ): AckResult

    public fun onEnvelope(key: String, handler: (WSEnvelope) -> Unit)

    public fun removeHandler(key: String)

    public fun sendASR(envelope: WSEnvelope)
}

public class WebSocketASRStreamTransport(
    private val webSocketService: WebSocketService,
    private val tokenManager: TokenManager,
) : ASRStreamTransport {
    override val deviceId: String get() = tokenManager.deviceId
    override val organizationId: String? get() = tokenManager.organizationId

    override suspend fun connectAndWait(timeoutMs: Long): Boolean =
        webSocketService.connectAndWait(timeoutMs)

    override suspend fun sendAndWaitAck(
        type: String,
        payload: JsonObject,
        okType: String,
        nakType: String,
        timeoutMs: Long,
    ): AckResult = webSocketService.sendAndWaitAck(
        type = type,
        payload = payload,
        okType = okType,
        nakType = nakType,
        timeoutMs = timeoutMs,
    )

    override fun onEnvelope(key: String, handler: (WSEnvelope) -> Unit) {
        webSocketService.onEnvelope(key, handler)
    }

    override fun removeHandler(key: String) {
        webSocketService.removeHandler(key)
    }

    override fun sendASR(envelope: WSEnvelope) {
        webSocketService.sendASR(envelope)
    }
}
