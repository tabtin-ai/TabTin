package com.tabtin.mobile.data.automation.handlers.l1

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.PermissionChecker
import com.tabtin.mobile.data.automation.safeGetLong
import com.tabtin.mobile.data.automation.safeGetString
import com.tabtin.mobile.data.automation.safeGetStringOrNull
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
internal class MediaReadHandler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val permissionChecker: PermissionChecker,
) : ActionHandler {
    override val actionName: String = "read_media"

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        val type = params["type"]?.jsonPrimitive?.contentOrNull ?: "images"
        val limit = (params["limit"]?.jsonPrimitive?.intOrNull ?: 20).coerceIn(1, 200)
        val offset = (params["offset"]?.jsonPrimitive?.intOrNull ?: 0).coerceAtLeast(0)

        val requiredPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (type == "videos") Manifest.permission.READ_MEDIA_VIDEO
            else Manifest.permission.READ_MEDIA_IMAGES
        } else {
            @Suppress("DEPRECATION")
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        permissionChecker.checkOrError(requiredPermission)?.let { return it }

        val contentUri = when (type) {
            "videos" -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            else -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }

        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            @Suppress("deprecation") MediaStore.MediaColumns.DATA,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.MIME_TYPE,
        )

        val total = context.contentResolver.query(
            contentUri, arrayOf(MediaStore.MediaColumns._ID), null, null, null,
        )?.use { it.count } ?: 0

        val items = buildJsonArray {
            val cursor = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val queryArgs = Bundle().apply {
                    putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
                    putInt(ContentResolver.QUERY_ARG_OFFSET, offset)
                    putStringArray(
                        ContentResolver.QUERY_ARG_SORT_COLUMNS,
                        arrayOf(MediaStore.MediaColumns.DATE_MODIFIED),
                    )
                    putInt(
                        ContentResolver.QUERY_ARG_SORT_DIRECTION,
                        ContentResolver.QUERY_SORT_DIRECTION_DESCENDING,
                    )
                }
                context.contentResolver.query(contentUri, projection, queryArgs, null)
            } else {
                @Suppress("deprecation")
                context.contentResolver.query(
                    contentUri, projection, null, null,
                    "${MediaStore.MediaColumns.DATE_MODIFIED} DESC LIMIT $limit OFFSET $offset",
                )
            }

            cursor?.use { c ->
                while (c.moveToNext()) {
                    val idIndex = c.getColumnIndex(MediaStore.MediaColumns._ID)
                    val id = if (idIndex >= 0) c.getLong(idIndex) else -1L

                    add(buildJsonObject {
                        put("name", c.safeGetString(MediaStore.MediaColumns.DISPLAY_NAME))
                        @Suppress("deprecation")
                        val path = c.safeGetStringOrNull(MediaStore.MediaColumns.DATA)
                        if (!path.isNullOrBlank()) put("path", path)
                        if (id >= 0) {
                            put("content_uri", ContentUris.withAppendedId(contentUri, id).toString())
                        }
                        put("size", c.safeGetLong(MediaStore.MediaColumns.SIZE))
                        put("modified", c.safeGetLong(MediaStore.MediaColumns.DATE_MODIFIED))
                        c.safeGetStringOrNull(MediaStore.MediaColumns.MIME_TYPE)?.let { put("mime", it) }
                    })
                }
            }
        }

        return DeviceActionResult(
            success = true,
            data = buildJsonObject {
                put("media", items)
                put("count", items.size)
                put("total", total)
                put("offset", offset)
                put("type", type)
            },
        )
    }
}
