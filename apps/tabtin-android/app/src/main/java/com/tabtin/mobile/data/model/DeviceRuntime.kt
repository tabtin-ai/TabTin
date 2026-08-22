package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
public data class DeviceRegisterRequest(
    @SerialName("organization_id") val organizationId: String,
    val fingerprint: String,
    @SerialName("device_type") val deviceType: String = "mobile",
    val name: String,
    @SerialName("os_info") val osInfo: JsonObject? = null,
    val capabilities: List<String>? = null,
)

@Serializable
public data class DeviceHeartbeatRequest(
    val fingerprint: String,
    val capabilities: List<String>? = null,
    @SerialName("system_info") val systemInfo: JsonObject? = null,
)

@Serializable
public data class DeviceOfflineRequest(
    val fingerprint: String,
    @SerialName("_token") val token: String? = null,
)

/**
 * 移动端推送 token 上报（，registerPush 成功拿到 RegistrationID 后调用）。
 * 与设备注册解耦：推送按 user 路由（一个人所有端都要收），fingerprint 仅作排障归因。
 */
@Serializable
public data class DevicePushTokenRegisterRequest(
    @SerialName("registration_id") val registrationId: String,
    val platform: String = "android",
    val provider: String = "tencent_push",
    val fingerprint: String? = null,
    @SerialName("app_version") val appVersion: String? = null,
)

/** 登出时反注册推送 token（幂等）。 */
@Serializable
public data class DevicePushTokenRevokeRequest(
    @SerialName("registration_id") val registrationId: String,
    val provider: String = "tencent_push",
)

@Serializable
public data class RuntimeDevice(
    val id: String,
    val name: String? = null,
    @SerialName("device_type") val deviceType: String? = null,
    val status: String? = null,
    @SerialName("last_heartbeat_at") val lastHeartbeatAt: String? = null,
) {
    public val isAvailableForExecution: Boolean
        get() = status?.lowercase() in setOf("online", "busy")
}

@Serializable
public data class RuntimeDeviceListResponse(
    val devices: List<RuntimeDevice> = emptyList(),
    val total: Int? = null,
)
