package com.tabtin.mobile.data.repository

import android.content.Context
import android.util.Log
import com.tabtin.mobile.data.api.AuthApi
import com.tabtin.mobile.data.model.MobilePushPreferences
import com.tabtin.mobile.data.model.UISettingEnvelope
import com.tabtin.mobile.data.model.UISettingsUpdateRequest
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

@Singleton
public class MobilePushPreferencesRepository @Inject constructor(
    @ApplicationContext context: Context,
    private val authApi: AuthApi,
    private val tokenManager: TokenManager,
    private val webSocketService: WebSocketService,
) {
    private companion object {
        const val TAG = "MobilePushPrefs"
        const val NAMESPACE = "mobilePushPrefs"
        const val WS_HANDLER_KEY = "mobile-push-preferences-ui-settings"
    }

    private val prefs = context.getSharedPreferences("mobile_push_preferences", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _value = MutableStateFlow(loadLocal())
    public val value: StateFlow<MobilePushPreferences> = _value.asStateFlow()

    init {
        webSocketService.onEnvelope(WS_HANDLER_KEY, ::handleEnvelope)
    }

    public fun bootstrap() {
        _value.value = loadLocal()
        scope.launch { syncFromServer() }
    }

    public fun setApproval(enabled: Boolean): Unit = update { copy(approval = enabled) }
    public fun setTaskCompleted(enabled: Boolean): Unit = update { copy(taskCompleted = enabled) }
    public fun setMessages(enabled: Boolean): Unit = update { copy(messages = enabled) }
    public fun setMentions(enabled: Boolean): Unit = update { copy(mentions = enabled) }

    private fun update(transform: MobilePushPreferences.() -> MobilePushPreferences) {
        val next = _value.value.transform()
        if (next == _value.value) return
        val updatedAt = System.currentTimeMillis()
        _value.value = next
        persist(next, updatedAt)
        scope.launch { push(next, updatedAt) }
    }

    private suspend fun syncFromServer() {
        runCatching { authApi.getUISettings().unwrap().settings[NAMESPACE] }
            .onSuccess { envelope ->
                if (envelope == null) {
                    val local = _value.value
                    val updatedAt = localUpdatedAt().takeIf { it > 0 } ?: System.currentTimeMillis()
                    persist(local, updatedAt)
                    push(local, updatedAt)
                    return@onSuccess
                }
                applyRemote(envelope)
            }
            .onFailure { Log.w(TAG, "sync ui-settings failed: ${it.message}") }
    }

    private fun handleEnvelope(envelope: WSEnvelope) {
        if (envelope.type != "ui_settings_changed") return
        val data = envelope.payload["data"] as? JsonObject ?: envelope.payload
        val settings = data["settings"] as? JsonObject
            ?: (data["data"] as? JsonObject)?.get("settings") as? JsonObject
            ?: return
        val raw = settings[NAMESPACE] ?: return
        val remote = runCatching { json.decodeFromJsonElement<UISettingEnvelope>(raw) }.getOrNull() ?: return
        applyRemote(remote)
    }

    private fun applyRemote(envelope: UISettingEnvelope) {
        val remote = runCatching {
            json.decodeFromJsonElement<MobilePushPreferences>(envelope.value)
        }.getOrNull() ?: return
        val localTimestamp = localUpdatedAt()
        if (envelope.updatedAt >= localTimestamp) {
            _value.value = remote
            persist(remote, envelope.updatedAt)
        } else {
            scope.launch { push(_value.value, localTimestamp) }
        }
    }

    private suspend fun push(value: MobilePushPreferences, updatedAt: Long) {
        runCatching {
            authApi.updateUISettings(
                UISettingsUpdateRequest(
                    settings = mapOf(
                        NAMESPACE to UISettingEnvelope(
                            value = json.encodeToJsonElement(value),
                            updatedAt = updatedAt,
                        ),
                    ),
                ),
            ).requireSuccess()
        }.onFailure { Log.w(TAG, "save ui-settings failed: ${it.message}") }
    }

    private fun loadLocal(): MobilePushPreferences {
        val encoded = prefs.getString(valueKey(), null) ?: return MobilePushPreferences()
        return runCatching { json.decodeFromString<MobilePushPreferences>(encoded) }
            .getOrDefault(MobilePushPreferences())
    }

    private fun persist(value: MobilePushPreferences, updatedAt: Long) {
        prefs.edit()
            .putString(valueKey(), json.encodeToString(MobilePushPreferences.serializer(), value))
            .putLong(updatedAtKey(), updatedAt)
            .apply()
    }

    private fun localUpdatedAt(): Long = prefs.getLong(updatedAtKey(), 0L)
    private fun accountKey(): String = tokenManager.userId?.takeIf { it.isNotBlank() } ?: "anonymous"
    private fun valueKey(): String = "${accountKey()}:value"
    private fun updatedAtKey(): String = "${accountKey()}:updated_at"
}
