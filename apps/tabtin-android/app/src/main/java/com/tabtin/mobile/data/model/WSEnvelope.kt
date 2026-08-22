package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * 非 auth 报文的 role 默认值，与 iOS WSEnvelope.build 默认值保持一致。
 * 服务端主要看 auth 时落定的 consumer.role，但部分网关/handler 日志和兜底分支仍可能读取
 * envelope.role；普通移动端报文默认 mobile 可以避免被误归类为 device_runtime。
 * ⚠️ auth 报文例外：网关按 envelope.role 做 role-token 绑定（access token 只配 mobile 等
 * GUI 角色、daemon token 才配 device_runtime）——WebSocketService.sendAuth 按
 * TokenManager.isDaemonMode 显式传 role，勿依赖本默认值（MB-3）。
 */
private const val DEFAULT_WS_ROLE = "mobile"

@Serializable
public data class WSEnvelope(
    val v: Int = 1,
    val type: String,
    @SerialName("request_id") val requestId: String = "",
    val ts: Long = 0,
    @SerialName("device_id") val deviceId: String = "",
    val role: String = DEFAULT_WS_ROLE,
    val payload: JsonObject = JsonObject(emptyMap()),
    @SerialName("event_id") val eventId: String? = null,
    @SerialName("_topic") val topic: String? = null,
    @SerialName("reply_to") val replyTo: String? = null,
    @SerialName("thread_id") val threadId: String? = null,
    @SerialName("trace_id") val traceId: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("session_id") val sessionId: String? = null,
    @SerialName("table_id") val tableId: String? = null,
    @SerialName("instance_id") val instanceId: String? = null,
    @SerialName("resource_type") val resourceType: String? = null,
    @SerialName("resource_id") val resourceId: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("_seq") val seq: Int? = null,
) {
    public fun payloadString(key: String): String? = try {
        payload[key]?.jsonPrimitive?.contentOrNull ?: when (key) {
            "resource_type" -> resourceType
            "resource_id" -> resourceId
            "space_id" -> spaceId
            "organization_id" -> organizationId
            else -> null
        }
    } catch (_: IllegalArgumentException) { null }

    public fun payloadBool(key: String): Boolean? = try {
        payload[key]?.jsonPrimitive?.booleanOrNull
    } catch (_: IllegalArgumentException) { null }

    public fun payloadInt(key: String): Int? = try {
        payload[key]?.jsonPrimitive?.intOrNull
    } catch (_: IllegalArgumentException) { null }

    public fun payloadDict(key: String): JsonObject? = payload[key] as? JsonObject

    public fun toJson(): String = envelopeJson.encodeToString(serializer(), this)

    public companion object {
        private val envelopeJson = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
            explicitNulls = false
        }

        public fun parse(text: String): WSEnvelope? = try {
            envelopeJson.decodeFromString(serializer(), text)
        } catch (_: Exception) {
            null
        }

        public fun build(
            type: String,
            deviceId: String,
            payload: JsonObject,
            organizationId: String? = null,
            role: String = DEFAULT_WS_ROLE,
            replyTo: String? = null,
            threadId: String? = null,
            traceId: String? = null,
            requestId: String? = null,
        ): WSEnvelope = WSEnvelope(
            v = 1,
            type = type,
            requestId = requestId ?: "req_${UUID.randomUUID().toString().take(8)}",
            ts = System.currentTimeMillis() / 1000,
            deviceId = deviceId,
            role = role,
            payload = payload,
            replyTo = replyTo,
            threadId = threadId,
            traceId = traceId,
            organizationId = organizationId,
        )

        public fun buildPayload(vararg pairs: Pair<String, Any?>): JsonObject = buildJsonObject {
            for ((key, value) in pairs) {
                when (value) {
                    is String -> put(key, value)
                    is Boolean -> put(key, value)
                    is Int -> put(key, value)
                    is Long -> put(key, value)
                    is Double -> put(key, value)
                    is List<*> -> put(key, kotlinx.serialization.json.buildJsonArray {
                        value.filterIsInstance<String>().forEach { add(JsonPrimitive(it)) }
                    })
                    null -> { /* skip */ }
                }
            }
        }
    }
}
