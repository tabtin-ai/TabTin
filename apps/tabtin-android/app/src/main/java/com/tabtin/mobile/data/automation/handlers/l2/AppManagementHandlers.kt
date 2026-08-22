package com.tabtin.mobile.data.automation.handlers.l2

import android.content.Context
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.handlers.l2.AppNameResolver.ResolveResult
import com.tabtin.mobile.data.privileged.PrivilegedProcessManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
internal class ScreenLaunchAppHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_launch_app"
}

@Singleton
internal class ScreenForceStopAppHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
    @ApplicationContext private val context: Context,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_force_stop_app"

    override suspend fun delegateToPrivileged(params: JsonObject): DeviceActionResult {
        val packageName = params["package_name"]?.jsonPrimitive?.contentOrNull?.trim()
        val appName = params["app_name"]?.jsonPrimitive?.contentOrNull?.trim()

        if (packageName.isNullOrEmpty() && appName.isNullOrEmpty()) {
            return DeviceActionResult(success = false, error = "Either 'package_name' or 'app_name' must be provided")
        }

        val resolvedPkg: String
        val resolvedLabel: String

        if (!packageName.isNullOrEmpty()) {
            if (packageName == context.packageName) {
                return DeviceActionResult(
                    success = false,
                    error = "Cannot force-stop TabTin itself",
                    errorCode = "SELF_STOP_BLOCKED",
                )
            }
            resolvedPkg = packageName
            resolvedLabel = AppNameResolver.getAppLabel(context.packageManager, packageName) ?: packageName
        } else {
            when (val result = AppNameResolver.resolve(context, appName!!)) {
                is ResolveResult.Found -> {
                    if (result.packageName == context.packageName) {
                        return DeviceActionResult(
                            success = false,
                            error = "Cannot force-stop TabTin itself",
                            errorCode = "SELF_STOP_BLOCKED",
                        )
                    }
                    resolvedPkg = result.packageName
                    resolvedLabel = result.label
                }
                is ResolveResult.NotInstalled -> {
                    return DeviceActionResult(
                        success = false,
                        error = "'${appName}' (${result.packageName}) is not installed on this device",
                        errorCode = "APP_NOT_INSTALLED",
                    )
                }
                is ResolveResult.Ambiguous -> {
                    return DeviceActionResult(
                        success = false,
                        error = "No confident match for '$appName'. See candidates in data.",
                        errorCode = "AMBIGUOUS_MATCH",
                        data = buildJsonObject {
                            put("candidates", buildJsonArray {
                                result.candidates.forEach { m ->
                                    add(buildJsonObject {
                                        put("package", m.packageName)
                                        put("name", m.label)
                                    })
                                }
                            })
                        },
                    )
                }
                is ResolveResult.NotFound -> {
                    return DeviceActionResult(
                        success = false,
                        error = "No installed app matches '$appName'",
                        errorCode = "APP_NOT_FOUND",
                    )
                }
            }
        }

        val forceStopParams = buildJsonObject { put("package_name", resolvedPkg) }
        val result = privilegedManager.execute("screen_force_stop_app", forceStopParams)

        return DeviceActionResult(
            success = result.success,
            data = buildJsonObject {
                put("package_name", resolvedPkg)
                put("app_name", resolvedLabel)
                result.data?.get("was_running")?.let { put("was_running", it) }
            },
            error = result.error,
            errorCode = result.errorCode,
        )
    }
}

/**
 * Resolves a human-readable app name to a package name via local
 * [android.content.pm.PackageManager] lookup, then delegates launch to the
 * privileged process via `screen_launch_app`.
 *
 * Resolution is handled by [AppNameResolver]:
 * alias → intent action → exact label → prefix → substring → package-name.
 * Only apps with a LAUNCHER intent are considered.
 */
@Singleton
internal class ScreenOpenAppHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
    @ApplicationContext private val context: Context,
) : L2Handler(privilegedManager) {

    override val actionName: String = "screen_open_app"

    public companion object {
        private const val MAX_OTHER_MATCHES = 4
    }

    override suspend fun delegateToPrivileged(params: JsonObject): DeviceActionResult {
        val appName = params["app_name"]?.jsonPrimitive?.contentOrNull?.trim()
        if (appName.isNullOrEmpty()) {
            return DeviceActionResult(success = false, error = "Missing 'app_name'")
        }

        return when (val result = AppNameResolver.resolve(context, appName)) {
            is ResolveResult.Found -> {
                launchApp(result.packageName, result.label, result.score)
            }
            is ResolveResult.NotInstalled -> {
                DeviceActionResult(
                    success = false,
                    error = "'$appName' (${result.packageName}) is not installed on this device",
                    errorCode = "APP_NOT_INSTALLED",
                )
            }
            is ResolveResult.Ambiguous -> {
                DeviceActionResult(
                    success = false,
                    error = "No confident match for '$appName'. See candidates in data.",
                    errorCode = "AMBIGUOUS_MATCH",
                    data = buildJsonObject {
                        put("candidates", buildJsonArray {
                            result.candidates.forEach { m ->
                                add(buildJsonObject {
                                    put("package", m.packageName)
                                    put("name", m.label)
                                })
                            }
                        })
                    },
                )
            }
            is ResolveResult.NotFound -> {
                DeviceActionResult(
                    success = false,
                    error = "No installed app matches '$appName'",
                    errorCode = "APP_NOT_FOUND",
                )
            }
        }
    }

    private suspend fun launchApp(
        packageName: String,
        label: String,
        matchScore: Int = AppNameResolver.SCORE_ALIAS,
    ): DeviceActionResult {
        val launchParams = buildJsonObject { put("package_name", packageName) }
        val result = privilegedManager.execute("screen_launch_app", launchParams)

        return DeviceActionResult(
            success = result.success,
            data = buildJsonObject {
                put("package_name", packageName)
                put("app_name", label)
                put("match_score", matchScore)
                if (matchScore < AppNameResolver.SCORE_EXACT) {
                    val allScored = AppNameResolver.scoreLaunchableApps(context.packageManager, label.lowercase())
                    val others = allScored.filter { it.packageName != packageName }.take(MAX_OTHER_MATCHES)
                    if (others.isNotEmpty()) {
                        put("other_matches", buildJsonArray {
                            others.forEach { m ->
                                add(buildJsonObject {
                                    put("package", m.packageName)
                                    put("name", m.label)
                                })
                            }
                        })
                    }
                }
            },
            error = result.error,
            errorCode = result.errorCode,
        )
    }
}

@Singleton
internal class SetSystemSettingHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "set_system_setting"
}

@Singleton
internal class GetSystemSettingHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "get_system_setting"
}
