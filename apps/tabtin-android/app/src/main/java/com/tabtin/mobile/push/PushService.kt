package com.tabtin.mobile.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.model.DevicePushTokenRevokeRequest
import com.tabtin.mobile.navigation.DeepLinkHandler
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 远程推送服务。开源构建不附带腾讯推送 SDK，注册整体 no-op；
 * 仍解析系统通知点击透传的 ext，便于后续接入自建推送。
 */
@Singleton
public class PushService @Inject constructor(
    @ApplicationContext private val context: Context,
    private val contextApi: ContextApi,
    private val tokenManager: TokenManager,
    private val pushSdkClient: PushSdkClient,
    private val deepLinkHandler: DeepLinkHandler,
) {
    private companion object {
        const val TAG = "PushService"
        const val PROVIDER = "tencent_push"
        const val CHANNEL_ID = "tabtin_remote_push"
        const val CHANNEL_NAME = "远程通知"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }

    @Volatile private var uploadedRegistrationId: String? = null
    @Volatile private var registrationId: String? = null

    init {
        pushSdkClient.setNotificationClickHandler(::handleNotificationExt)
    }

    public val isConfigured: Boolean
        get() = pushSdkClient.isAvailable

    public fun start() {
        if (!pushSdkClient.isAvailable) {
            Log.i(TAG, "remote push SDK not bundled; start skipped")
            return
        }
        ensureNotificationChannel()
    }

    public fun prepareForLogout() {
        val regId = uploadedRegistrationId ?: registrationId
        val token = tokenManager.accessToken
        reset()

        if (regId != null && token != null) {
            scope.launch {
                runCatching {
                    contextApi.revokePushToken(
                        DevicePushTokenRevokeRequest(registrationId = regId, provider = PROVIDER),
                        authorization = "Bearer $token",
                    )
                }.onFailure { Log.w(TAG, "revoke push token failed: ${it.message}") }
            }
        }
        pushSdkClient.unregister()
    }

    public fun reset() {
        uploadedRegistrationId = null
        registrationId = null
    }

    public fun handleNotificationExt(ext: String) {
        val payload = runCatching {
            json.parseToJsonElement(ext).jsonObject
        }.getOrNull() ?: return
        fun str(vararg keys: String): String? = keys.firstNotNullOfOrNull { key ->
            (payload[key] as? JsonPrimitive)
                ?.takeIf { it.isString }
                ?.content
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
        }

        if (str("scene") == "im_message") {
            val organizationId = str("organization_id", "organizationId") ?: return
            val conversationId = str("conversation_id", "conversationId") ?: return
            deepLinkHandler.emitImConversationNavigation(
                conversationId = conversationId,
                organizationId = organizationId,
            )
            return
        }

        val workspaceId = str("workspace_id", "workspaceId", "space_id", "spaceId") ?: return
        val organizationId = str("organization_id", "organizationId") ?: return
        deepLinkHandler.emitConversationNavigation(
            workspaceId = workspaceId,
            organizationId = organizationId,
            sessionId = str("session_id", "sessionId"),
            projectId = str("project_id", "projectId"),
        )
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_HIGH,
        )
        manager.createNotificationChannel(channel)
    }
}
