package com.tabtin.mobile.data.automation.handlers.l1

import android.Manifest
import android.content.Context
import android.provider.CallLog
import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.PermissionChecker
import com.tabtin.mobile.data.automation.safeGetInt
import com.tabtin.mobile.data.automation.safeGetLong
import com.tabtin.mobile.data.automation.safeGetString
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
internal class CallLogHandler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val permissionChecker: PermissionChecker,
) : ActionHandler {
    override val actionName: String = "read_call_log"

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        permissionChecker.checkOrError(Manifest.permission.READ_CALL_LOG)?.let { return it }

        val limit = params["limit"]?.jsonPrimitive?.intOrNull ?: 20

        val projection = arrayOf(
            CallLog.Calls.NUMBER,
            CallLog.Calls.CACHED_NAME,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION,
            CallLog.Calls.TYPE,
        )

        val records = buildJsonArray {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                projection, null, null,
                "${CallLog.Calls.DATE} DESC",
            )?.use { cursor ->
                var count = 0
                while (cursor.moveToNext() && count < limit) {
                    add(buildJsonObject {
                        put("number", cursor.safeGetString(CallLog.Calls.NUMBER))
                        put("name", cursor.safeGetString(CallLog.Calls.CACHED_NAME))
                        put("date", cursor.safeGetLong(CallLog.Calls.DATE))
                        put("duration_seconds", cursor.safeGetLong(CallLog.Calls.DURATION))
                        put("type", callTypeLabel(cursor.safeGetInt(CallLog.Calls.TYPE)))
                    })
                    count++
                }
            }
        }
        return DeviceActionResult(
            success = true,
            data = buildJsonObject {
                put("records", records)
                put("count", records.size)
            },
        )
    }

    private fun callTypeLabel(type: Int): String = when (type) {
        CallLog.Calls.INCOMING_TYPE -> "incoming"
        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
        CallLog.Calls.MISSED_TYPE -> "missed"
        CallLog.Calls.REJECTED_TYPE -> "rejected"
        else -> "unknown"
    }
}
