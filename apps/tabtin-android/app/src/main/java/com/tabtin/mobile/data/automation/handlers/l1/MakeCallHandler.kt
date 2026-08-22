package com.tabtin.mobile.data.automation.handlers.l1

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.PermissionChecker
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
internal class MakeCallHandler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val permissionChecker: PermissionChecker,
) : ActionHandler {
    override val actionName: String = "make_call"

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        permissionChecker.checkOrError(Manifest.permission.CALL_PHONE)?.let { return it }

        val number = params["number"]?.jsonPrimitive?.contentOrNull
            ?: return DeviceActionResult(
                success = false,
                error = "Missing 'number' parameter",
                errorCode = "INVALID_PARAMS",
            )

        if (!number.matches(Regex("^[+]?[*#0-9\\s\\-(),;]{3,30}$"))) {
            return DeviceActionResult(
                success = false,
                error = "Invalid phone number format",
                errorCode = "INVALID_PARAMS",
            )
        }

        return try {
            val normalized = number.replace(Regex("[\\s\\-()]"), "")
            val intent = Intent(Intent.ACTION_CALL).apply {
                data = Uri.parse("tel:${Uri.encode(normalized)}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            DeviceActionResult(
                success = true,
                data = buildJsonObject {
                    put("number", number)
                    put("status", "call_initiated")
                },
            )
        } catch (e: ActivityNotFoundException) {
            DeviceActionResult(
                success = false,
                error = "No dialer app found on this device",
                errorCode = "NO_DIALER_APP",
            )
        } catch (e: SecurityException) {
            DeviceActionResult(
                success = false,
                error = "Call permission denied: ${e.message}",
                errorCode = "PERMISSION_DENIED",
            )
        } catch (e: Exception) {
            DeviceActionResult(
                success = false,
                error = "Failed to initiate call: ${e.message}",
                errorCode = "CALL_FAILED",
            )
        }
    }
}
