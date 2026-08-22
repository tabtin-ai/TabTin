package com.tabtin.mobile.data.automation.handlers.l2

import android.content.Context
import com.tabtin.mobile.data.adb.AdbConnectionManager
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.api.UploadScope
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.privileged.PrivilegedProcessManager
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

private const val OSS_UPLOAD_TIMEOUT_MS = 30_000L

private fun writeToTempFile(context: Context, data: ByteArray, name: String): File {
    val dir = File(context.cacheDir, "screenshots").also { it.mkdirs() }
    val file = File(dir, name)
    file.outputStream().use { it.write(data) }
    return file
}

private val FOREGROUND_PKG_REGEX = Regex("""(\S+)/\S+\s""")

private suspend fun queryForegroundPackage(adb: AdbConnectionManager): String? {
    return try {
        val output = adb.executeShellCommand(
            "dumpsys activity activities | grep -m1 mResumedActivity",
        ) ?: return null
        FOREGROUND_PKG_REGEX.find(output)?.groupValues?.get(1)
    } catch (_: Exception) {
        null
    }
}

private suspend fun isScreenLocked(adb: AdbConnectionManager): Boolean {
    return try {
        val output = adb.executeShellCommand("dumpsys power | grep mWakefulness") ?: return false
        output.contains("Asleep") || output.contains("Dozing")
    } catch (_: Exception) {
        false
    }
}

@Singleton
internal class ScreenCaptureHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
    private val ossUploadService: OSSUploadService,
    private val adbConnectionManager: AdbConnectionManager,
    private val tokenManager: TokenManager,
    @ApplicationContext private val appContext: Context,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_capture"

    override suspend fun delegateToPrivileged(params: JsonObject): DeviceActionResult {
        val result = privilegedManager.execute(actionName, params)
        if (!result.success) {
            if (result.errorCode == "FLAG_SECURE_SCREEN" && isScreenLocked(adbConnectionManager)) {
                return DeviceActionResult(
                    success = false,
                    error = "Screen is locked. Unlock the device to continue.",
                    errorCode = "SCREEN_LOCKED",
                )
            }
            return DeviceActionResult(success = false, error = result.error, errorCode = result.errorCode)
        }

        val binary = result.binaryData
        if (binary == null || binary.isEmpty()) {
            return DeviceActionResult(success = false, error = "Screenshot captured but binary data is empty", errorCode = "EMPTY_SCREENSHOT")
        }

        val contextId = params["session_id"]?.jsonPrimitive?.contentOrNull ?: ""
        val fileName = "screenshot_${System.currentTimeMillis()}.png"
        return try {
            val tempFile = withContext(Dispatchers.IO) {
                writeToTempFile(appContext, binary, fileName)
            }
            try {
                val uploadResult = withTimeout(OSS_UPLOAD_TIMEOUT_MS) {
                    ossUploadService.directUploadFromFile(
                        file = tempFile,
                        fileName = fileName,
                        contentType = "image/png",
                        folder = "device/screenshots",
                        scope = UploadScope(
                            module = "device",
                            contextType = "screenshot",
                            contextId = contextId,
                            organizationId = tokenManager.organizationId.orEmpty(),
                            isPublic = false,
                        ),
                    )
                }
                if (uploadResult.accessUrl.isBlank()) {
                    return DeviceActionResult(
                        success = false,
                        error = "Screenshot uploaded but received empty URL",
                        errorCode = "EMPTY_URL",
                    )
                }
                DeviceActionResult(
                    success = true,
                    data = buildJsonObject {
                        put("image_url", uploadResult.accessUrl)
                        put("file_id", uploadResult.fileId)
                        put("size", binary.size)
                    },
                )
            } finally {
                tempFile.delete()
            }
        } catch (e: Exception) {
            DeviceActionResult(success = false, error = "Screenshot captured but upload failed: ${e.message}", errorCode = "UPLOAD_FAILED")
        }
    }
}

@Singleton
internal class ScreenSnapshotHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
    private val ossUploadService: OSSUploadService,
    private val adbConnectionManager: AdbConnectionManager,
    private val tokenManager: TokenManager,
    @ApplicationContext private val appContext: Context,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_snapshot"

    override suspend fun delegateToPrivileged(params: JsonObject): DeviceActionResult {
        val result = privilegedManager.execute(actionName, params)
        if (!result.success) {
            return DeviceActionResult(success = false, error = result.error, errorCode = result.errorCode)
        }

        val binary = result.binaryData
        if (binary == null || binary.isEmpty()) {
            val screenshotError = result.data?.get("screenshot_error")?.jsonPrimitive?.contentOrNull
            val isLocked = screenshotError == "FLAG_SECURE_SCREEN" && isScreenLocked(adbConnectionManager)
            return DeviceActionResult(
                success = true,
                data = buildJsonObject {
                    put("has_screenshot", false)
                    result.data?.forEach { (k, v) ->
                        if (k != "has_screenshot") put(k, v)
                    }
                    if (isLocked) {
                        put("is_screen_locked", true)
                        put("screenshot_error", "SCREEN_LOCKED")
                    }
                },
            )
        }

        val contextId = params["session_id"]?.jsonPrimitive?.contentOrNull ?: ""
        val fileName = "snapshot_${System.currentTimeMillis()}.png"
        return try {
            val tempFile = withContext(Dispatchers.IO) {
                writeToTempFile(appContext, binary, fileName)
            }
            try {
                val uploadResult = withTimeout(OSS_UPLOAD_TIMEOUT_MS) {
                    ossUploadService.directUploadFromFile(
                        file = tempFile,
                        fileName = fileName,
                        contentType = "image/png",
                        folder = "device/screenshots",
                        scope = UploadScope(
                            module = "device",
                            contextType = "screenshot",
                            contextId = contextId,
                            organizationId = tokenManager.organizationId.orEmpty(),
                            isPublic = false,
                        ),
                    )
                }
                val imageUrl = uploadResult.accessUrl
                if (imageUrl.isBlank()) {
                    return DeviceActionResult(
                        success = false,
                        error = "Snapshot uploaded but received empty URL",
                        errorCode = "EMPTY_URL",
                        data = buildJsonObject {
                            put("has_screenshot", false)
                            result.data?.forEach { (k, v) ->
                                if (k != "has_screenshot") put(k, v)
                            }
                        },
                    )
                }
                DeviceActionResult(
                    success = true,
                    data = buildJsonObject {
                        put("image_url", imageUrl)
                        put("file_id", uploadResult.fileId)
                        put("has_screenshot", true)
                        result.data?.forEach { (k, v) ->
                            if (k !in setOf("has_screenshot", "file_id")) put(k, v)
                        }
                    },
                )
            } finally {
                tempFile.delete()
            }
        } catch (e: Exception) {
            DeviceActionResult(
                success = false,
                error = "Screenshot captured but upload failed: ${e.message}",
                errorCode = "UPLOAD_FAILED",
                data = buildJsonObject {
                    put("has_screenshot", false)
                    put("upload_error", e.message ?: "Unknown upload error")
                    result.data?.forEach { (k, v) ->
                        if (k !in setOf("has_screenshot", "upload_error")) put(k, v)
                    }
                },
            )
        }
    }
}

@Singleton
internal class ScreenUiTreeHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_ui_tree"
}

@Singleton
internal class ScreenTapHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_tap"
}

@Singleton
internal class ScreenTapAreaHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_tap_area"
}

@Singleton
internal class ScreenSwipeHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_swipe"
}

@Singleton
internal class ScreenLongPressHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_long_press"
}

@Singleton
internal class ScreenTypeTextHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_type_text"
}

@Singleton
internal class ScreenKeyEventHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_key_event"
}

@Singleton
internal class ScreenWaitForIdleHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_wait_for_idle"
}

@Singleton
internal class ScreenTapElementHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
    private val adbConnectionManager: AdbConnectionManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_tap_element"

    override suspend fun delegateToPrivileged(params: JsonObject): DeviceActionResult {
        val checkDialog = params["check_dialog"]?.jsonPrimitive?.booleanOrNull ?: false
        if (checkDialog) {
            val ctxResult = privilegedManager.execute("screen_get_context")
            if (ctxResult.success) {
                val hasDialog = ctxResult.data?.get("has_dialog")?.jsonPrimitive?.booleanOrNull ?: false
                if (hasDialog) {
                    val dialogType = ctxResult.data.get("dialog_type")?.jsonPrimitive?.contentOrNull
                    return DeviceActionResult(
                        success = false,
                        error = "Dialog overlay detected (type: ${dialogType ?: "unknown"}), tap may hit dialog instead of target element",
                        errorCode = "DIALOG_OVERLAY_DETECTED",
                        data = buildJsonObject {
                            put("dialog_type", dialogType ?: "unknown")
                            put("suggestion", "Dismiss the dialog first, or use screen_get_context to inspect")
                        },
                    )
                }
            }
        }

        val preForegroundPkg = queryForegroundPackage(adbConnectionManager)
        val result = privilegedManager.execute(actionName, params)
        if (!result.success) {
            return DeviceActionResult(success = false, error = result.error, errorCode = result.errorCode)
        }

        val postForegroundPkg = queryForegroundPackage(adbConnectionManager)
        val appChanged = preForegroundPkg != null && postForegroundPkg != null &&
            preForegroundPkg != postForegroundPkg

        return if (appChanged) {
            DeviceActionResult(
                success = true,
                data = buildJsonObject {
                    result.data?.forEach { (k, v) -> put(k, v) }
                    put("app_foreground_warning", "APP_FOREGROUND_CHANGED")
                    put("pre_foreground_package", preForegroundPkg)
                    put("post_foreground_package", postForegroundPkg)
                },
            )
        } else {
            DeviceActionResult(
                success = result.success,
                data = result.data,
                error = result.error,
                errorCode = result.errorCode,
            )
        }
    }
}

@Singleton
internal class ScreenLongPressElementHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_long_press_element"
}

@Singleton
internal class ScreenTypeInElementHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
    private val adbConnectionManager: AdbConnectionManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_type_in_element"

    override suspend fun delegateToPrivileged(params: JsonObject): DeviceActionResult {
        val preForegroundPkg = queryForegroundPackage(adbConnectionManager)

        val result = privilegedManager.execute(actionName, params)
        if (!result.success) {
            return DeviceActionResult(success = false, error = result.error, errorCode = result.errorCode)
        }

        val postForegroundPkg = queryForegroundPackage(adbConnectionManager)
        val appChanged = preForegroundPkg != null && postForegroundPkg != null &&
            preForegroundPkg != postForegroundPkg

        return if (appChanged) {
            DeviceActionResult(
                success = true,
                data = buildJsonObject {
                    result.data?.forEach { (k, v) -> put(k, v) }
                    put("app_foreground_warning", "APP_FOREGROUND_CHANGED")
                    put("pre_foreground_package", preForegroundPkg)
                    put("post_foreground_package", postForegroundPkg)
                },
            )
        } else {
            DeviceActionResult(
                success = result.success,
                data = result.data,
                error = result.error,
                errorCode = result.errorCode,
            )
        }
    }
}

@Singleton
internal class ScreenFindElementHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_find_element"
}

@Singleton
internal class ScreenGetContextHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
    private val adbConnectionManager: AdbConnectionManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_get_context"

    override suspend fun delegateToPrivileged(params: JsonObject): DeviceActionResult {
        val result = privilegedManager.execute(actionName, params)
        if (!result.success) {
            return DeviceActionResult(success = false, error = result.error, errorCode = result.errorCode)
        }

        val isLocked = isScreenLocked(adbConnectionManager)
        return DeviceActionResult(
            success = true,
            data = buildJsonObject {
                result.data?.forEach { (k, v) -> put(k, v) }
                put("is_screen_locked", isLocked)
            },
        )
    }
}

@Singleton
internal class ScreenWaitForElementHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "screen_wait_for_element"
}

@Singleton
internal class SetStealthModeHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {
    override val actionName: String = "set_stealth_mode"
}
