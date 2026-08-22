package com.tabtin.mobile.data.automation.handlers.l1

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.PermissionChecker
import com.tabtin.mobile.data.automation.safeGetInt
import com.tabtin.mobile.data.automation.safeGetLong
import com.tabtin.mobile.data.automation.safeGetString
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume
import kotlin.math.min

@Singleton
internal class SmsReadHandler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val permissionChecker: PermissionChecker,
) : ActionHandler {
    override val actionName: String = "read_sms"

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        permissionChecker.checkOrError(Manifest.permission.READ_SMS)?.let { return it }

        return try {
            val limit = min(params["limit"]?.jsonPrimitive?.intOrNull ?: 20, 200)
            val filter = params["filter"]?.jsonPrimitive?.contentOrNull ?: "inbox"

            val uri = when (filter) {
                "inbox" -> Uri.parse("content://sms/inbox")
                "sent" -> Uri.parse("content://sms/sent")
                else -> Uri.parse("content://sms")
            }

            val cursor = context.contentResolver.query(
                uri,
                arrayOf("address", "body", "date", "type"),
                null, null,
                "date DESC",
            )

            if (cursor == null) {
                return DeviceActionResult(
                    success = false,
                    error = "SMS query failed: ContentResolver returned null",
                    errorCode = "QUERY_FAILED",
                )
            }

            val messages = buildJsonArray {
                cursor.use {
                    var count = 0
                    while (it.moveToNext() && count < limit) {
                        add(buildJsonObject {
                            put("address", it.safeGetString("address"))
                            put("body", it.safeGetString("body"))
                            put("date", it.safeGetLong("date"))
                            put("type", smsTypeLabel(it.safeGetInt("type")))
                        })
                        count++
                    }
                }
            }
            DeviceActionResult(
                success = true,
                data = buildJsonObject {
                    put("messages", messages)
                    put("count", messages.size)
                    put("filter", filter)
                },
            )
        } catch (e: SecurityException) {
            DeviceActionResult(
                success = false,
                error = "SMS read permission revoked: ${e.message}",
                errorCode = "PERMISSION_DENIED",
            )
        } catch (e: Exception) {
            DeviceActionResult(
                success = false,
                error = "SMS read failed: ${e.message}",
                errorCode = "SMS_READ_FAILED",
            )
        }
    }

    private fun smsTypeLabel(type: Int): String = when (type) {
        1 -> "received"
        2 -> "sent"
        3 -> "draft"
        4 -> "outbox"
        5 -> "failed"
        6 -> "queued"
        else -> "unknown"
    }
}

@Singleton
internal class SmsSendHandler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val permissionChecker: PermissionChecker,
) : ActionHandler {
    override val actionName: String = "send_sms"

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        permissionChecker.checkOrError(Manifest.permission.SEND_SMS)?.let { return it }

        val to = params["to"]?.jsonPrimitive?.contentOrNull?.trim()
            ?: return DeviceActionResult(success = false, error = "Missing 'to' parameter", errorCode = "INVALID_PARAMS")
        if (to.isBlank() || !to.matches(Regex("^[+]?[0-9\\s\\-()]{3,20}$"))) {
            val masked = if (to.length > 4) to.take(2) + "***" + to.takeLast(2) else "***"
            return DeviceActionResult(
                success = false,
                error = "Invalid or empty phone number: '$masked'",
                errorCode = "INVALID_PHONE_NUMBER",
            )
        }
        val message = params["message"]?.jsonPrimitive?.contentOrNull
            ?: return DeviceActionResult(success = false, error = "Missing 'message' parameter", errorCode = "INVALID_PARAMS")
        if (message.isBlank()) {
            return DeviceActionResult(
                success = false,
                error = "Message body cannot be empty",
                errorCode = "EMPTY_MESSAGE",
            )
        }

        val telephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        if (telephonyManager == null || telephonyManager.simState != TelephonyManager.SIM_STATE_READY) {
            return DeviceActionResult(
                success = false,
                error = "SIM card not ready or not inserted",
                errorCode = "NO_SIM",
            )
        }

        return try {
            @Suppress("DEPRECATION")
            val smsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                context.getSystemService(SmsManager::class.java)
            } else {
                SmsManager.getDefault()
            }
            val parts = smsManager.divideMessage(message)

            val (sent, sendError) = awaitSendResult(smsManager, to, message, parts)

            if (sent) {
                DeviceActionResult(
                    success = true,
                    data = buildJsonObject {
                        put("to", to)
                        put("message_length", message.length)
                        put("parts", parts.size)
                    },
                )
            } else {
                DeviceActionResult(
                    success = false,
                    error = "SMS send failed: $sendError",
                    errorCode = "SMS_SEND_FAILED",
                )
            }
        } catch (e: Exception) {
            DeviceActionResult(success = false, error = "SMS send failed: ${e.message}", errorCode = "SMS_SEND_FAILED")
        }
    }

    private suspend fun awaitSendResult(
        smsManager: SmsManager,
        to: String,
        message: String,
        parts: ArrayList<String>,
    ): Pair<Boolean, String?> {
        val action = "com.tabtin.mobile.SMS_SENT_${UUID.randomUUID()}"
        val totalParts = parts.size
        val piFlags = PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE

        return withTimeoutOrNull(10_000L) {
            suspendCancellableCoroutine { cont ->
                val resultCodes = mutableListOf<Int>()

                val receiver = object : BroadcastReceiver() {
                    override fun onReceive(ctx: Context?, intent: Intent?) {
                        resultCodes.add(getResultCode())
                        if (resultCodes.size >= totalParts) {
                            try { context.unregisterReceiver(this) } catch (_: Exception) {}
                            val allOk = resultCodes.all { it == Activity.RESULT_OK }
                            val result = if (allOk) {
                                true to null
                            } else {
                                val failCode = resultCodes.first { it != Activity.RESULT_OK }
                                false to smsSendErrorLabel(failCode)
                            }
                            try { cont.resume(result) } catch (_: IllegalStateException) {}
                        }
                    }
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    context.registerReceiver(
                        receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED,
                    )
                } else {
                    context.registerReceiver(receiver, IntentFilter(action))
                }

                cont.invokeOnCancellation {
                    try { context.unregisterReceiver(receiver) } catch (_: Exception) {}
                }

                if (totalParts > 1) {
                    val sentIntents = ArrayList<PendingIntent>(totalParts)
                    for (i in 0 until totalParts) {
                        sentIntents.add(
                            PendingIntent.getBroadcast(context, i, Intent(action), piFlags),
                        )
                    }
                    smsManager.sendMultipartTextMessage(to, null, parts, sentIntents, null)
                } else {
                    val sentIntent = PendingIntent.getBroadcast(context, 0, Intent(action), piFlags)
                    smsManager.sendTextMessage(to, null, message, sentIntent, null)
                }
            }
        } ?: (false to "Send timeout (10s)")
    }

    private fun smsSendErrorLabel(code: Int): String = when (code) {
        SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "Generic failure"
        SmsManager.RESULT_ERROR_NO_SERVICE -> "No service"
        SmsManager.RESULT_ERROR_NULL_PDU -> "Null PDU"
        SmsManager.RESULT_ERROR_RADIO_OFF -> "Radio off"
        SmsManager.RESULT_ERROR_LIMIT_EXCEEDED -> "SMS limit exceeded"
        else -> "Unknown error (code=$code)"
    }
}
