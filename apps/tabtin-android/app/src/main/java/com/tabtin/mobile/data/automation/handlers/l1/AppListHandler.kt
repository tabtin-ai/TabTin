package com.tabtin.mobile.data.automation.handlers.l1

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.installedApplicationsCompat
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
internal class AppListHandler @Inject constructor(
    @ApplicationContext private val context: Context,
) : ActionHandler {
    override val actionName: String = "list_installed_apps"
    override val timeoutMs: Long get() = 60_000L

    public companion object {
        private val VALID_FILTERS = setOf("user", "system", "all")
    }

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        val filter = params["filter"]?.jsonPrimitive?.contentOrNull ?: "user"
        if (filter !in VALID_FILTERS) {
            return DeviceActionResult(
                success = false,
                error = "Invalid filter value: '$filter'. Must be one of: ${VALID_FILTERS.joinToString()}",
                errorCode = "INVALID_PARAMS",
            )
        }
        val search = params["search"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
        val limit = params["limit"]?.jsonPrimitive?.intOrNull?.coerceIn(1, 500) ?: 50
        val pm = context.packageManager

        val apps = pm.installedApplicationsCompat()

        var filtered = when (filter) {
            "user" -> apps.filter { it.flags and ApplicationInfo.FLAG_SYSTEM == 0 }
            "system" -> apps.filter { it.flags and ApplicationInfo.FLAG_SYSTEM != 0 }
            else -> apps
        }

        val labelCache = mutableMapOf<String, String>()
        fun resolveLabel(app: ApplicationInfo): String =
            labelCache.getOrPut(app.packageName) {
                try { pm.getApplicationLabel(app).toString() } catch (_: Exception) { app.packageName }
            }

        if (search != null) {
            val q = search.lowercase()
            filtered = filtered.filter { app ->
                resolveLabel(app).lowercase().contains(q) ||
                    app.packageName.lowercase().contains(q)
            }
        }

        val result = buildJsonArray {
            for (app in filtered.take(limit)) {
                add(buildJsonObject {
                    put("package", app.packageName)
                    put("name", resolveLabel(app))
                    put("system", app.flags and ApplicationInfo.FLAG_SYSTEM != 0)
                })
            }
        }

        return DeviceActionResult(
            success = true,
            data = buildJsonObject {
                put("apps", result)
                put("count", result.size)
                put("total_matched", filtered.size)
                put("filter", filter)
                if (search != null) put("search", search)
                put("limit", limit)
            },
        )
    }
}
