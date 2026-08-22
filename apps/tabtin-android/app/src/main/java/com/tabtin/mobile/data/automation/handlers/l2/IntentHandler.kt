package com.tabtin.mobile.data.automation.handlers.l2

import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.privileged.PrivilegedProcessManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
internal class LaunchWithIntentHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {

    override val actionName: String = "launch_with_intent"

    public companion object {
        private val ALLOWED_INTENT_ACTIONS = setOf(
            "android.intent.action.VIEW",
            "android.intent.action.SEND",
            "android.intent.action.SENDTO",
            "android.intent.action.SEND_MULTIPLE",
            "android.intent.action.DIAL",
            "android.intent.action.WEB_SEARCH",
            "android.intent.action.PICK",
            "android.intent.action.GET_CONTENT",
            "android.intent.action.INSERT",
            "android.intent.action.EDIT",
            "android.intent.action.MAIN",
            "android.intent.action.SEARCH",
            "android.intent.action.OPEN_DOCUMENT",
            "android.intent.action.CREATE_DOCUMENT",
            "android.media.action.IMAGE_CAPTURE",
            "android.media.action.VIDEO_CAPTURE",
            "android.settings.SETTINGS",
            "android.settings.WIFI_SETTINGS",
            "android.settings.BLUETOOTH_SETTINGS",
            "android.settings.AIRPLANE_MODE_SETTINGS",
            "android.settings.DISPLAY_SETTINGS",
            "android.settings.SOUND_SETTINGS",
            "android.settings.LOCATION_SOURCE_SETTINGS",
            "android.settings.APPLICATION_DETAILS_SETTINGS",
            "android.settings.DATE_SETTINGS",
            "android.settings.LOCALE_SETTINGS",
            "android.settings.INPUT_METHOD_SETTINGS",
            "android.settings.ACCESSIBILITY_SETTINGS",
            "android.settings.SECURITY_SETTINGS",
            "android.settings.PRIVACY_SETTINGS",
            "android.settings.NFC_SETTINGS",
            "android.settings.BATTERY_SAVER_SETTINGS",
            "android.settings.DATA_USAGE_SETTINGS",
            "android.settings.MANAGE_ALL_APPLICATIONS_SETTINGS",
            "android.settings.NOTIFICATION_LISTENER_SETTINGS",
        )
    }

    override suspend fun delegateToPrivileged(params: JsonObject): DeviceActionResult {
        val intentAction = params["action"]?.jsonPrimitive?.contentOrNull?.trim()
        if (intentAction.isNullOrEmpty()) {
            return DeviceActionResult(
                success = false,
                error = "Missing required parameter 'action'",
                errorCode = "MISSING_PARAM",
            )
        }

        if (intentAction !in ALLOWED_INTENT_ACTIONS) {
            return DeviceActionResult(
                success = false,
                error = "Intent action '$intentAction' is not allowed. " +
                    "Allowed actions include: android.intent.action.VIEW, SEND, DIAL, " +
                    "android.settings.*, android.media.action.IMAGE_CAPTURE, etc.",
                errorCode = "INTENT_ACTION_NOT_ALLOWED",
            )
        }

        return super.delegateToPrivileged(params)
    }
}
