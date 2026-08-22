package com.tabtin.mobile.data.automation.handlers.l1

import android.content.Context
import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.handlers.l2.AppNameResolver
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
internal class NotificationReadHandler @Inject constructor(
    private val store: NotificationStore,
    @ApplicationContext private val context: Context,
) : ActionHandler {
    override val actionName: String = "read_notifications"

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        if (!store.isListenerEnabled) {
            return DeviceActionResult(
                success = false,
                error = "Notification listener not enabled. Please enable TabTin in Settings → Notifications → Notification access.",
                errorCode = "NOTIFICATION_LISTENER_NOT_ENABLED",
            )
        }

        val limit = params["limit"]?.jsonPrimitive?.intOrNull ?: 20
        val rawFilter = params["package"]?.jsonPrimitive?.contentOrNull

        var packageFilter = rawFilter
        var resolvedPackage: String? = null

        // NT-011: 区分不同失败类型，提供可操作的错误信息，而非静默返回空数组
        if (rawFilter != null && '.' !in rawFilter) {
            when (val result = AppNameResolver.resolve(context, rawFilter)) {
                is AppNameResolver.ResolveResult.Found -> {
                    resolvedPackage = result.packageName
                    packageFilter = result.packageName
                }
                is AppNameResolver.ResolveResult.Ambiguous -> {
                    return DeviceActionResult(
                        success = true,
                        data = buildJsonObject {
                            put("notifications", buildJsonArray {})
                            put("count", 0)
                            put("resolve_error", "ambiguous")
                            put(
                                "hint",
                                "Multiple apps match '$rawFilter'. " +
                                    "Use one of the package names in 'candidates' for an exact match.",
                            )
                            put("candidates", buildJsonArray {
                                result.candidates.forEach { candidate ->
                                    add(buildJsonObject {
                                        put("package", candidate.packageName)
                                        put("label", candidate.label)
                                    })
                                }
                            })
                        },
                    )
                }
                is AppNameResolver.ResolveResult.NotInstalled -> {
                    return DeviceActionResult(
                        success = true,
                        data = buildJsonObject {
                            put("notifications", buildJsonArray {})
                            put("count", 0)
                            put("resolve_error", "not_installed")
                            put("known_package", result.packageName)
                            put(
                                "hint",
                                "App '${result.appName}' (${result.packageName}) " +
                                    "is recognized but not installed on this device.",
                            )
                        },
                    )
                }
                is AppNameResolver.ResolveResult.NotFound -> {
                    return DeviceActionResult(
                        success = true,
                        data = buildJsonObject {
                            put("notifications", buildJsonArray {})
                            put("count", 0)
                            put("resolve_error", "not_found")
                            put(
                                "hint",
                                "Could not find any app matching '$rawFilter'. " +
                                    "Pass a package name (e.g. 'com.example.app') — " +
                                    "use list_installed_apps to find it.",
                            )
                        },
                    )
                }
            }
        }

        val filtered = store.getRecent(limit, packageFilter)
        return DeviceActionResult(
            success = true,
            data = buildJsonObject {
                put("notifications", buildJsonArray { filtered.forEach { add(it) } })
                put("count", filtered.size)
                resolvedPackage?.let { put("resolved_package", it) }
            },
        )
    }
}
