package com.tabtin.mobile.data.automation.handlers.l1

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.provider.CalendarContract
import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.PermissionChecker
import com.tabtin.mobile.data.automation.safeGetInt
import com.tabtin.mobile.data.automation.safeGetLong
import com.tabtin.mobile.data.automation.safeGetString
import com.tabtin.mobile.data.automation.safeGetStringOrNull
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.Calendar
import java.util.TimeZone
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
internal class CalendarReadHandler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val permissionChecker: PermissionChecker,
) : ActionHandler {
    override val actionName: String = "read_calendar"

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        permissionChecker.checkOrError(Manifest.permission.READ_CALENDAR)?.let { return it }

        val daysAhead = (params["days_ahead"]?.jsonPrimitive?.intOrNull ?: 7).coerceIn(1, 365)
        val limit = (params["limit"]?.jsonPrimitive?.intOrNull ?: 50).coerceIn(1, 200)

        val localCal = Calendar.getInstance(TimeZone.getDefault())
        localCal.set(Calendar.HOUR_OF_DAY, 0)
        localCal.set(Calendar.MINUTE, 0)
        localCal.set(Calendar.SECOND, 0)
        localCal.set(Calendar.MILLISECOND, 0)
        val startTime = localCal.timeInMillis
        localCal.add(Calendar.DAY_OF_YEAR, daysAhead)
        val endTime = localCal.timeInMillis

        val instancesUri = CalendarContract.Instances.CONTENT_URI.buildUpon().let {
            ContentUris.appendId(it, startTime)
            ContentUris.appendId(it, endTime)
            it.build()
        }

        val projection = arrayOf(
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.DESCRIPTION,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.EVENT_TIMEZONE,
            CalendarContract.Instances.CALENDAR_ID,
        )

        val events = buildJsonArray {
            context.contentResolver.query(
                instancesUri,
                projection,
                null,
                null,
                "${CalendarContract.Instances.BEGIN} ASC",
            )?.use { cursor ->
                var count = 0
                while (cursor.moveToNext() && count < limit) {
                    val allDay = cursor.safeGetInt(CalendarContract.Instances.ALL_DAY) == 1
                    val start = cursor.safeGetLong(CalendarContract.Instances.BEGIN)
                    var end = cursor.safeGetLong(CalendarContract.Instances.END)
                    if (allDay && end == 0L) end = start + 86_400_000L

                    add(buildJsonObject {
                        put("event_id", cursor.safeGetLong(CalendarContract.Instances.EVENT_ID))
                        put("calendar_id", cursor.safeGetLong(CalendarContract.Instances.CALENDAR_ID))
                        put("title", cursor.safeGetString(CalendarContract.Instances.TITLE))
                        put("start", start)
                        put("end", end)
                        cursor.safeGetStringOrNull(CalendarContract.Instances.EVENT_TIMEZONE)
                            ?.takeIf { it.isNotBlank() }?.let { put("timezone", it) }
                        cursor.safeGetStringOrNull(CalendarContract.Instances.EVENT_LOCATION)
                            ?.takeIf { it.isNotBlank() }?.let { put("location", it) }
                        cursor.safeGetStringOrNull(CalendarContract.Instances.DESCRIPTION)
                            ?.takeIf { it.isNotBlank() }?.let { put("description", it) }
                        put("all_day", allDay)
                    })
                    count++
                }
            }
        }
        return DeviceActionResult(
            success = true,
            data = buildJsonObject {
                put("events", events)
                put("count", events.size)
                put("days_ahead", daysAhead)
            },
        )
    }
}
