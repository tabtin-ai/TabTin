package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
public data class MobilePushPreferences(
    val approval: Boolean = true,
    @SerialName("taskCompleted") val taskCompleted: Boolean = true,
    val messages: Boolean = true,
    val mentions: Boolean = true,
)

@Serializable
public data class UISettingEnvelope(
    val value: JsonElement,
    val updatedAt: Long = 0L,
)

@Serializable
public data class UISettingsResponse(
    val settings: Map<String, UISettingEnvelope> = emptyMap(),
)

@Serializable
public data class UISettingsUpdateRequest(
    val settings: Map<String, UISettingEnvelope>,
)
