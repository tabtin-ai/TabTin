package com.tabtin.mobile.data.automation.handlers.l1

import android.Manifest
import android.content.Context
import android.provider.ContactsContract
import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.PermissionChecker
import com.tabtin.mobile.data.automation.safeGetInt
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

private val PROJECTION = arrayOf(
    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
    ContactsContract.CommonDataKinds.Phone.NUMBER,
    ContactsContract.CommonDataKinds.Phone.TYPE,
)

@Singleton
internal class ContactsReadHandler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val permissionChecker: PermissionChecker,
) : ActionHandler {
    override val actionName: String = "read_contacts"

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        permissionChecker.checkOrError(Manifest.permission.READ_CONTACTS)?.let { return it }

        val limit = params["limit"]?.jsonPrimitive?.intOrNull ?: 50
        val contacts = buildJsonArray {
            context.contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                PROJECTION, null, null,
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC",
            )?.use { cursor ->
                var count = 0
                while (cursor.moveToNext() && count < limit) {
                    add(buildJsonObject {
                        put("name", cursor.safeGetString(PROJECTION[0]))
                        put("phone", cursor.safeGetString(PROJECTION[1]))
                        put("type", ContactsContract.CommonDataKinds.Phone.getTypeLabel(
                            context.resources,
                            cursor.safeGetInt(PROJECTION[2]),
                            "",
                        ).toString())
                    })
                    count++
                }
            }
        }
        return DeviceActionResult(
            success = true,
            data = buildJsonObject {
                put("contacts", contacts)
                put("count", contacts.size)
            },
        )
    }
}

@Singleton
internal class ContactsSearchHandler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val permissionChecker: PermissionChecker,
) : ActionHandler {
    override val actionName: String = "search_contacts"

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        permissionChecker.checkOrError(Manifest.permission.READ_CONTACTS)?.let { return it }

        val query = params["query"]?.jsonPrimitive?.content
            ?: return DeviceActionResult(success = false, error = "Missing 'query' parameter", errorCode = "INVALID_PARAMS")
        val limit = params["limit"]?.jsonPrimitive?.intOrNull ?: 20

        val contacts = buildJsonArray {
            context.contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                PROJECTION,
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?",
                arrayOf("%$query%"),
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC",
            )?.use { cursor ->
                var count = 0
                while (cursor.moveToNext() && count < limit) {
                    add(buildJsonObject {
                        put("name", cursor.safeGetString(PROJECTION[0]))
                        put("phone", cursor.safeGetString(PROJECTION[1]))
                        put("type", ContactsContract.CommonDataKinds.Phone.getTypeLabel(
                            context.resources,
                            cursor.safeGetInt(PROJECTION[2]),
                            "",
                        ).toString())
                    })
                    count++
                }
            }
        }
        return DeviceActionResult(
            success = true,
            data = buildJsonObject {
                put("contacts", contacts)
                put("count", contacts.size)
                put("query", query)
            },
        )
    }
}
