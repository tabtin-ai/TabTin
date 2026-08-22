@file:JvmName("Server")

package com.tabtin.mobile.privileged

import android.net.LocalServerSocket
import android.net.LocalSocket
import com.tabtin.mobile.data.privileged.FrameProtocol
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.put
import android.content.ClipData
import android.graphics.BitmapFactory
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.json.JsonPrimitive

private const val SOCKET_NAME = "tabtin_privileged"
private const val TAG = "TabTinPrivileged"
private const val VERSION = 1
private const val MAX_SCREENSHOT_SIZE = 20 * 1024 * 1024
private const val SHELL_TIMEOUT_SECONDS = 30L

private val PACKAGE_NAME_RE = Regex("^[a-zA-Z][a-zA-Z0-9_.]{0,200}$")
private val SETTING_KEY_RE = Regex("^[a-zA-Z][a-zA-Z0-9_.]{0,200}$")
private val SETTING_NS_ALLOW = setOf("system", "secure", "global")
private val SETTINGS_VALUE_RE = Regex("""^[\x20-\x7E]{1,256}$""")
private const val MIN_SUPPORTED_VERSION = 1
private const val MAX_ELEMENTS = 300
private const val CLIENT_IDLE_TIMEOUT_MS = 60_000

// Coordinate limits — no phone/tablet exceeds 10000px on any axis.
private const val MAX_COORD = 10_000
private const val MAX_DURATION_MS = 30_000
private const val MAX_WAIT_TIMEOUT_MS = 60_000
private const val INPUT_TEXT_MAX_LENGTH = 500
private const val MAX_KEY_CODE = 999
private const val NORMALIZED_MAX = 1000
private const val MIN_ELEMENT_SIZE = 5
private const val MIN_VISIBILITY_PERCENT = 30
private const val MAX_REGEX_PATTERN_LENGTH = 200
private const val REGEX_MATCH_TIMEOUT_MS = 2000L

private val SURFACE_VIEW_CLASSES = setOf("SurfaceView", "TextureView", "GLSurfaceView")
private val WEBVIEW_FULL_CLASSES = setOf(
    "android.webkit.WebView",
    "com.tencent.smtt.sdk.WebView",
    "org.chromium.content.browser.ContentViewCore",
)
private val WEBVIEW_SHORT_CLASSES = setOf("WebView", "ContentViewCore")
private const val SURFACE_VIEW_AREA_THRESHOLD = 0.80
private const val WEBVIEW_AREA_THRESHOLD = 0.50
private val OEM_BLOCKED_KEYWORDS = arrayOf("INJECT_EVENTS", "Permission denied", "Security exception")

/**
 * CharSequence wrapper that throws on regex backtracking timeout.
 * Every 64th character access checks whether the deadline has been exceeded.
 * java.util.regex.Pattern.matcher() calls charAt() during matching, so
 * wrapping the input detects catastrophic backtracking without a separate thread.
 */
private class InterruptibleCharSequence(
    private val inner: CharSequence,
    private val deadlineMs: Long,
) : CharSequence {
    override val length get() = inner.length
    override fun get(index: Int): Char {
        if (index and 63 == 0 && System.currentTimeMillis() > deadlineMs)
            throw RuntimeException("regex_timeout")
        return inner[index]
    }
    override fun subSequence(startIndex: Int, endIndex: Int): CharSequence =
        InterruptibleCharSequence(inner.subSequence(startIndex, endIndex), deadlineMs)
    override fun toString() = inner.toString()
}

/** Class name patterns for dialog/popup detection (matched as suffix or exact substring). */
private val DIALOG_CLASS_PATTERNS = listOf(
    "AlertDialog", "AppCompatDialog", "MaterialAlertDialog",
    "BottomSheet", "BottomSheetDialog",
    "PopupWindow", "GrantPermissions",
    "Snackbar",
    "Dialog", "PopupMenu", "DatePicker", "TimePicker",
    "RequestPermission",
    "ActionSheet",
    "PermissionController",
)

/** Common Android dialog resource-id suffixes for fallback detection. */
private val DIALOG_RESOURCE_ID_SUFFIXES = listOf(
    "alertTitle", "button1", "button2", "button3",
    "parentPanel", "contentPanel", "buttonPanel",
    "message",
    "permission_allow_button", "permission_deny_button",
    "permission_allow_foreground_only_button",
)

private fun validateCoord(value: Int, name: String): String? =
    if (value < 0 || value > MAX_COORD) "Invalid '$name': $value (must be 0..$MAX_COORD)" else null

// ---------------------------------------------------------------------------
// UI Element indexing (inspired by DroidRun)
// ---------------------------------------------------------------------------

private data class UiElement(
    val index: Int,
    val className: String,
    val text: String,
    val resourceId: String,
    val contentDesc: String,
    val boundsLeft: Int,
    val boundsTop: Int,
    val boundsRight: Int,
    val boundsBottom: Int,
    val clickable: Boolean,
    val checkable: Boolean,
    val checked: Boolean,
    val editable: Boolean,
    val scrollable: Boolean,
    val longClickable: Boolean,
    val focused: Boolean,
    val enabled: Boolean,
    val selected: Boolean,
    val depth: Int,
)

private data class DegradationSignals(
    val surfaceViewDetected: Boolean = false,
    val webviewDetected: Boolean = false,
)

@Volatile private var lastCaptureStderr: String = ""
@Volatile private var cachedElements: List<UiElement> = emptyList()
@Volatile private var cachedConciseMode: Boolean = true
@Volatile private var cachedGeneration: Int = 0
@Volatile private var lastDumpDepth: Int = 10
@Volatile private var cachedScreenWidth: Int = 0
@Volatile private var cachedScreenHeight: Int = 0
@Volatile private var cachedRotation: Int = 0
@Volatile private var cachedRotationTime: Long = 0L
private const val ROTATION_CACHE_TTL_MS = 2000L

// ---------------------------------------------------------------------------
// Stealth mode — human-like interaction to avoid automation detection (C13–C16)
//
// Activation: global toggle (`set_stealth_mode`) OR per-request `stealth` param.
// ---------------------------------------------------------------------------

@Volatile private var stealthEnabled: Boolean = false
@Volatile private var running = true
@Volatile private var currentClient: LocalSocket? = null

private val shellExecutor: java.util.concurrent.ExecutorService =
    java.util.concurrent.Executors.newCachedThreadPool { r ->
        Thread(r, "shell-io").apply { isDaemon = true }
    }

private const val STEALTH_SAFE_ZONE = 0.4
private const val STEALTH_BEZIER_POINTS = 15
private const val STEALTH_MIN_JITTER_PX = 3
private const val STEALTH_WORD_DELAY_MIN_MS = 80L
private const val STEALTH_WORD_DELAY_MAX_MS = 300L

private val stealthRng = java.util.Random()

/** Check if stealth is active — either globally enabled or per-request. */
private fun isStealthActive(params: JsonObject): Boolean =
    stealthEnabled || ((params["stealth"] as? JsonPrimitive)?.booleanOrNull ?: false)

/** Cubic ease-in/ease-out for natural acceleration/deceleration. */
private fun easeInOutCubic(t: Double): Double =
    if (t < 0.5) 4.0 * t * t * t else 1.0 - Math.pow(-2.0 * t + 2.0, 3.0) / 2.0

/** Multi-frequency sine composition for micro-jitter.
 *  Frequencies are fixed; only phase is randomized by seed so adjacent
 *  x values produce smooth, continuous output. */
private fun perlinNoise1D(x: Double, seed: Int): Double {
    val rng = java.util.Random(seed.toLong())
    val p1 = rng.nextDouble() * Math.PI * 2
    val p2 = rng.nextDouble() * Math.PI * 2
    val p3 = rng.nextDouble() * Math.PI * 2
    return Math.sin(x * 1.3 + p1) * 0.5 + Math.sin(x * 2.7 + p2) * 0.3 + Math.sin(x * 5.1 + p3) * 0.2
}

/** Quadratic Bezier path with easing, random curvature, and Perlin micro-jitter. */
private fun generateCurvedPath(
    sx: Int, sy: Int, ex: Int, ey: Int, numPoints: Int = STEALTH_BEZIER_POINTS,
): List<Pair<Int, Int>> {
    val dx = (ex - sx).toDouble()
    val dy = (ey - sy).toDouble()
    val distance = Math.sqrt(dx * dx + dy * dy)
    val actualPoints = if (distance <= 100) (numPoints / 3).coerceAtLeast(5) else numPoints

    val midX = (sx + ex) / 2.0
    val midY = (sy + ey) / 2.0
    val curveMax = distance * (stealthRng.nextDouble() * 0.15 + 0.1)
    val offset = stealthRng.nextDouble() * curveMax * 2 - curveMax

    val (ctrlX, ctrlY) = if (distance > 0) {
        Pair(midX + (-dy / distance) * offset, midY + (dx / distance) * offset)
    } else Pair(midX, midY)

    val noiseSeed = stealthRng.nextInt(10000)
    val jitter = (distance * 0.01).coerceAtMost(2.0)

    return (0 until actualPoints).map { i ->
        val lt = i.toDouble() / (actualPoints - 1)
        val t = easeInOutCubic(lt)
        val bx = (1 - t) * (1 - t) * sx + 2 * (1 - t) * t * ctrlX + t * t * ex
        val by = (1 - t) * (1 - t) * sy + 2 * (1 - t) * t * ctrlY + t * t * ey
        Pair(
            (bx + perlinNoise1D(lt * 10, noiseSeed) * jitter).toInt(),
            (by + perlinNoise1D(lt * 10, noiseSeed + 1000) * jitter).toInt(),
        )
    }
}

/** Randomize a tap point within the element's safe zone.
 *  Gracefully degrades to center for areas < 4px wide/tall. */
private fun randomizeInBounds(
    cx: Int, cy: Int, left: Int, top: Int, right: Int, bottom: Int,
    zoneFraction: Double = STEALTH_SAFE_ZONE,
): Pair<Int, Int> {
    val w = right - left
    val h = bottom - top
    if (w < 4 || h < 4) return Pair(cx, cy)
    val xRange = (w * zoneFraction).toInt().coerceAtLeast(STEALTH_MIN_JITTER_PX)
    val yRange = (h * zoneFraction).toInt().coerceAtLeast(STEALTH_MIN_JITTER_PX)
    val safeLeft = left + 2
    val safeRight = (right - 2).coerceAtLeast(safeLeft)
    val safeTop = top + 2
    val safeBottom = (bottom - 2).coerceAtLeast(safeTop)
    return Pair(
        (cx + stealthRng.nextInt(xRange + 1) - xRange / 2).coerceIn(safeLeft, safeRight),
        (cy + stealthRng.nextInt(yRange + 1) - yRange / 2).coerceIn(safeTop, safeBottom),
    )
}

/** Curved Bezier swipe via motionevent DOWN/MOVE/UP.
 *  Falls back to regular `input swipe` when motionevent is unavailable (Android < 11).
 *  Uses try-finally to guarantee UP event release even on unexpected errors. */
private fun executeBezierSwipe(sx: Int, sy: Int, ex: Int, ey: Int, durationMs: Int): ShellResult {
    val points = generateCurvedPath(sx, sy, ex, ey)
    if (points.isEmpty()) return ShellResult(false, "Empty path")

    val (x0, y0) = points.first()
    val down = execShellArgs(arrayOf("input", "motionevent", "DOWN", "$x0", "$y0"))
    if (!down.success) {
        log("motionevent unavailable, falling back to input swipe")
        return execShellArgs(arrayOf("input", "swipe", "$sx", "$sy", "$ex", "$ey", "$durationMs"))
    }

    val shellOverheadMs = 25L
    val delayMs = ((durationMs.toLong() / points.size) - shellOverheadMs).coerceAtLeast(1L)
    val (xEnd, yEnd) = points.last()
    try {
        for (i in 1 until points.size - 1) {
            Thread.sleep(delayMs)
            val (x, y) = points[i]
            val move = execShellArgs(arrayOf("input", "motionevent", "MOVE", "$x", "$y"))
            if (!move.success) return move
        }
        Thread.sleep(delayMs)
    } finally {
        execShellArgs(arrayOf("input", "motionevent", "UP", "$xEnd", "$yEnd"))
    }
    return ShellResult(true, "")
}

/** Type ASCII text word-by-word with random inter-word delays.
 *  Uses `nextInt` instead of `nextLong` for Android API < 35 compatibility. */
private fun stealthTypeAscii(text: String): ActionResult {
    val words = text.split(" ")
    for ((i, word) in words.withIndex()) {
        if (word.isNotEmpty()) {
            val escaped = word.replace("%", "%%")
            val r = execShellArgs(arrayOf("input", "text", escaped))
            if (!r.success) {
                if (isOemBlocked(r.output)) return oemBlockedResult()
                return errorResult("Stealth type failed at word ${i + 1}: ${r.output.trim()}")
            }
        }
        if (i < words.size - 1) {
            val spaceResult = execShellArgs(arrayOf("input", "text", "%s"))
            if (!spaceResult.success) {
                if (isOemBlocked(spaceResult.output)) return oemBlockedResult()
                return errorResult("Stealth type failed at space: ${spaceResult.output.trim()}")
            }
            val delay = STEALTH_WORD_DELAY_MIN_MS +
                stealthRng.nextInt((STEALTH_WORD_DELAY_MAX_MS - STEALTH_WORD_DELAY_MIN_MS).toInt() + 1).toLong()
            Thread.sleep(delay)
        }
    }
    return ActionResult(buildJsonObject {
        put("success", true)
        put("data", buildJsonObject {
            put("method", "stealth_word_by_word")
            put("word_count", words.size)
        })
    })
}

public fun main(args: Array<String>) {
    log("Server starting (pid=${android.os.Process.myPid()}, uid=${android.os.Process.myUid()})")

    // INF-009: Lower OOM priority to reduce chance of being killed under memory pressure
    try {
        File("/proc/self/oom_score_adj").writeText("-900")
        log("Set oom_score_adj to -900")
    } catch (e: Exception) {
        log("Failed to set oom_score_adj: ${e.message}")
    }

    // INF-006: Retry bind with backoff (old process may still be releasing socket)
    var boundServer: LocalServerSocket? = null
    for (attempt in 1..3) {
        try {
            boundServer = LocalServerSocket(SOCKET_NAME)
            break
        } catch (e: Exception) {
            log("Bind attempt $attempt/3 failed: ${e.message}")
            if (attempt < 3) Thread.sleep(500)
        }
    }
    val server = boundServer ?: run {
        log("Failed to bind socket '$SOCKET_NAME' after 3 attempts")
        System.exit(2)
        return
    }

    log("Listening on abstract:$SOCKET_NAME")

    Runtime.getRuntime().addShutdownHook(Thread {
        log("Shutdown hook, closing server socket")
        running = false
        runCatching { server.close() }
    })

    while (running) {
        try {
            val client = server.accept() ?: continue
            log("Client connected")
            // SCN-001: Close previous client so accept loop is never blocked
            currentClient?.let { old ->
                log("Closing previous client connection")
                runCatching { old.close() }
            }
            currentClient = client
            Thread({ handleClient(client) }, "client-handler").start()
        } catch (e: Exception) {
            if (!running) break
            log("Accept error: ${e.message}")
        }
    }

    shellExecutor.shutdownNow()
}

private fun handleClient(client: LocalSocket) {
    val input = BufferedInputStream(client.inputStream)
    val output = BufferedOutputStream(client.outputStream)
    val outputLock = Any()
    client.soTimeout = CLIENT_IDLE_TIMEOUT_MS

    try {
        if (!performHandshake(input, output)) {
            log("Handshake failed, closing client")
            return
        }

        // INF-016 / SCN-021: Dedicated reader thread handles heartbeats immediately,
        // even when the main processing thread is blocked on a long dispatch.
        val requestQueue = LinkedBlockingQueue<ByteArray?>()
        val readerActive = AtomicBoolean(true)

        val readerThread = Thread({
            try {
                while (readerActive.get()) {
                    val frame = FrameProtocol.readFrame(input)
                    if (!frame.isJson) {
                        synchronized(outputLock) { sendError(output, "Expected JSON frame") }
                        continue
                    }
                    try {
                        val json = Json.parseToJsonElement(String(frame.payload))
                        val obj = json as? JsonObject
                        if (obj != null) {
                            val action = (obj["action"] as? JsonPrimitive)?.contentOrNull
                            if (action == "heartbeat") {
                                val requestId = (obj["id"] as? JsonPrimitive)?.contentOrNull
                                val response = buildJsonObject {
                                    put("success", true)
                                    put("timestamp", System.currentTimeMillis())
                                    requestId?.let { put("id", it) }
                                }
                                synchronized(outputLock) { sendJsonResponse(output, response) }
                                continue
                            }
                        }
                    } catch (_: Exception) { /* not heartbeat or parse failed — queue for main thread */ }
                    requestQueue.put(frame.payload)
                }
            } catch (_: java.io.EOFException) {
                log("Client disconnected (EOF) in reader")
            } catch (_: java.net.SocketTimeoutException) {
                log("Client idle timeout in reader")
            } catch (e: Exception) {
                if (readerActive.get()) log("Reader thread error: ${e.message}")
            } finally {
                requestQueue.put(null)
            }
        }, "heartbeat-reader")
        readerThread.isDaemon = true
        readerThread.start()

        // Main processing loop — reads queued (non-heartbeat) requests
        while (true) {
            val payload = requestQueue.take() ?: break

            // INF-022 / INF-024: All JSON parsing inside try-catch;
            // use (as? JsonPrimitive) instead of .jsonPrimitive to avoid ISE
            try {
                val request = Json.parseToJsonElement(String(payload)).jsonObject
                val action = (request["action"] as? JsonPrimitive)?.contentOrNull
                if (action.isNullOrBlank()) {
                    synchronized(outputLock) { sendError(output, "Missing 'action' field") }
                    continue
                }

                val params = try { request["params"]?.jsonObject } catch (_: Exception) { null }
                    ?: JsonObject(emptyMap())
                val requestId = (request["id"] as? JsonPrimitive)?.contentOrNull

                try {
                    val result = dispatch(action, params)
                    synchronized(outputLock) { sendResponse(output, result, requestId) }
                } catch (e: OutOfMemoryError) {
                    log("OOM in action '$action': ${e.message}")
                    synchronized(outputLock) {
                        sendJsonResponse(output, buildJsonObject {
                            put("success", false)
                            put("error", "Out of memory")
                            put("error_code", "OOM")
                            requestId?.let { put("id", it) }
                        })
                    }
                } catch (e: Exception) {
                    log("Action '$action' error: ${e.message}")
                    synchronized(outputLock) {
                        sendJsonResponse(output, buildJsonObject {
                            put("success", false)
                            put("error", "Action failed: ${e.message}")
                            requestId?.let { put("id", it) }
                        })
                    }
                }
            } catch (e: Exception) {
                log("Request parse error: ${e.message}")
                synchronized(outputLock) { sendError(output, "Invalid request: ${e.message}") }
            }
        }

        readerActive.set(false)
    } catch (e: java.io.EOFException) {
        log("Client disconnected (EOF)")
    } catch (e: Exception) {
        log("Client error: ${e.message}")
    } finally {
        stealthEnabled = false
        cachedElements = emptyList()
        cachedGeneration = 0
        runCatching { client.close() }
    }
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

private fun performHandshake(input: InputStream, output: OutputStream): Boolean {
    val frame = FrameProtocol.readFrame(input)
    if (!frame.isJson) return false

    val request = try {
        Json.parseToJsonElement(String(frame.payload)).jsonObject
    } catch (e: Exception) {
        log("Handshake JSON parse error: ${e.message}")
        return false
    }
    if ((request["action"] as? JsonPrimitive)?.contentOrNull != "handshake") return false

    val clientVersion = (request["version"] as? JsonPrimitive)?.intOrNull
        ?: (try { request["params"]?.jsonObject } catch (_: Exception) { null })
            ?.let { (it["version"] as? JsonPrimitive)?.intOrNull }
        ?: 0
    if (clientVersion < MIN_SUPPORTED_VERSION) {
        sendJsonResponse(output, buildJsonObject {
            put("success", false)
            put("error", "Unsupported client version $clientVersion (minimum: $MIN_SUPPORTED_VERSION)")
            put("min_version", MIN_SUPPORTED_VERSION)
            put("server_version", VERSION)
        })
        log("Handshake rejected: client version $clientVersion < min $MIN_SUPPORTED_VERSION")
        return false
    }

    sendJsonResponse(output, buildJsonObject {
        put("success", true)
        put("version", VERSION)
        put("pid", android.os.Process.myPid())
        put("uid", android.os.Process.myUid())
    })
    log("Handshake complete (client_version=$clientVersion)")
    return true
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

private data class ActionResult(
    val json: JsonObject,
    val binaryData: ByteArray? = null,
)

private fun dispatch(action: String, params: JsonObject): ActionResult = when (action) {
    "heartbeat" -> ActionResult(buildJsonObject {
        put("success", true)
        put("timestamp", System.currentTimeMillis())
    })

    "screen_capture" -> handleScreenCapture(params)
    "screen_snapshot" -> handleScreenSnapshot(params)
    "screen_ui_tree" -> handleScreenUiTree(params)
    "screen_tap" -> handleScreenTap(params)
    "screen_tap_area" -> handleScreenTapArea(params)
    "screen_swipe" -> handleScreenSwipe(params)
    "screen_long_press" -> handleScreenLongPress(params)
    "screen_type_text" -> handleScreenTypeText(params)
    "screen_key_event" -> handleScreenKeyEvent(params)
    "screen_wait_for_idle" -> handleScreenWaitForIdle(params)
    "screen_tap_element" -> handleScreenTapElement(params)
    "screen_long_press_element" -> handleScreenLongPressElement(params)
    "screen_type_in_element" -> handleScreenTypeInElement(params)
    "screen_find_element" -> handleScreenFindElement(params)
    "screen_get_context" -> handleScreenGetContext()
    "screen_wait_for_element" -> handleScreenWaitForElement(params)
    "screen_launch_app" -> handleScreenLaunchApp(params)
    "screen_force_stop_app" -> handleForceStopApp(params)
    "set_system_setting" -> handleSetSystemSetting(params)
    "get_system_setting" -> handleGetSystemSetting(params)
    "set_stealth_mode" -> handleSetStealthMode(params)
    "launch_with_intent" -> handleLaunchWithIntent(params)
    "save_to_device" -> handleSaveToDevice(params)

    else -> errorResult("Unknown action: $action")
}

// ---------------------------------------------------------------------------
// Screen capture
// ---------------------------------------------------------------------------

private fun handleScreenCapture(params: JsonObject): ActionResult {
    val sessionId = params["session_id"]?.jsonPrimitive?.contentOrNull
    val pngBytes = captureScreen()
        ?: return if (isOemBlocked(lastCaptureStderr)) oemBlockedResult()
                 else errorResult("screencap failed")
    if (looksLikeSecureBlackScreen(pngBytes)) {
        return errorResult("Screen content protected by FLAG_SECURE (solid black frame)", "FLAG_SECURE_SCREEN")
    }

    return ActionResult(
        json = buildJsonObject {
            put("success", true)
            put("data", buildJsonObject {
                put("size", pngBytes.size)
                if (!sessionId.isNullOrEmpty()) put("session_id", sessionId)
            })
            put("has_binary", true)
            put("binary_type", "image/png")
            put("binary_size", pngBytes.size)
        },
        binaryData = pngBytes,
    )
}

private fun handleScreenSnapshot(params: JsonObject): ActionResult {
    val maxDepth = params["max_depth"]?.jsonPrimitive?.intOrNull ?: 10
    lastDumpDepth = maxDepth
    val mode = params["mode"]?.jsonPrimitive?.contentOrNull ?: "raw"
    // INF-015: Use shared executor instead of per-call newSingleThreadExecutor
    val screenshotFuture = shellExecutor.submit<ByteArray?> { captureScreen() }
    val uiXml = dumpUiTree(maxDepth)
    val pngBytes = try {
        screenshotFuture.get(SHELL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    } catch (_: Exception) { screenshotFuture.cancel(true); null }
    val flagSecure = pngBytes != null && looksLikeSecureBlackScreen(pngBytes)
    val effectiveScreenshot = if (flagSecure) null else pngBytes

    if (effectiveScreenshot == null && uiXml == null && !flagSecure) {
        return errorResult("Both screencap and uiautomator dump failed")
    }

    val signals = if (uiXml != null) detectDegradationSignals(uiXml) else DegradationSignals()

    val data = buildJsonObject {
        if (uiXml != null) {
            when (mode) {
                "indexed", "concise" -> {
                    val concise = mode == "concise"
                    val elements = parseUiElements(uiXml, concise)
                    cachedElements = elements
                    cachedConciseMode = concise
                    cachedGeneration++
                    val formatted = formatIndexedElements(elements, showDepth = !concise)
                    val (sw, sh) = getScreenDimensions()
                    put("ui_tree", formatted)
                    put("element_count", elements.size)
                    if (elements.size >= MAX_ELEMENTS) put("elements_truncated", true)
                    put("screen_width", sw)
                    put("screen_height", sh)
                    put("mode", mode)
                }
                else -> put("ui_tree", uiXml)
            }
        } else {
            put("ui_tree_error", "uiautomator dump failed")
        }
        put("has_screenshot", effectiveScreenshot != null)
        if (flagSecure) put("screenshot_error", "FLAG_SECURE_SCREEN")
        else if (effectiveScreenshot == null && isOemBlocked(lastCaptureStderr)) put("screenshot_error", "OEM_BLOCKED")
        if (signals.surfaceViewDetected) put("surface_view_detected", true)
        if (signals.webviewDetected) put("webview_detected", true)
    }

    return ActionResult(
        json = buildJsonObject {
            put("success", true)
            put("data", data)
            if (effectiveScreenshot != null) {
                put("has_binary", true)
                put("binary_type", "image/png")
                put("binary_size", effectiveScreenshot.size)
            }
        },
        binaryData = effectiveScreenshot,
    )
}

private fun handleScreenUiTree(params: JsonObject): ActionResult {
    val maxDepth = params["max_depth"]?.jsonPrimitive?.intOrNull ?: 10
    lastDumpDepth = maxDepth
    val mode = params["mode"]?.jsonPrimitive?.contentOrNull ?: "raw"

    val xml = dumpUiTree(maxDepth)
        ?: return errorResult("uiautomator dump failed")

    val signals = detectDegradationSignals(xml)

    return when (mode) {
        "indexed", "concise" -> {
            val concise = mode == "concise"
            val elements = parseUiElements(xml, concise)
            cachedElements = elements
            cachedConciseMode = concise
            cachedGeneration++
            val formatted = formatIndexedElements(elements, showDepth = !concise)
            val (sw, sh) = getScreenDimensions()
            ActionResult(buildJsonObject {
                put("success", true)
                put("data", buildJsonObject {
                    put("ui_tree", formatted)
                    put("element_count", elements.size)
                    if (elements.size >= MAX_ELEMENTS) put("elements_truncated", true)
                    put("screen_width", sw)
                    put("screen_height", sh)
                    put("mode", mode)
                    if (signals.surfaceViewDetected) put("surface_view_detected", true)
                    if (signals.webviewDetected) put("webview_detected", true)
                })
            })
        }
        else -> {
            ActionResult(buildJsonObject {
                put("success", true)
                put("data", buildJsonObject {
                    put("ui_tree", xml)
                    if (signals.surfaceViewDetected) put("surface_view_detected", true)
                    if (signals.webviewDetected) put("webview_detected", true)
                })
            })
        }
    }
}

private val PNG_MAGIC = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)

private fun captureScreen(): ByteArray? {
    lastCaptureStderr = ""
    val process: Process
    try {
        process = Runtime.getRuntime().exec(arrayOf("screencap", "-p"))
    } catch (e: Exception) {
        log("screencap exec error: ${e.message}")
        return null
    }
    try {
        // INF-015: Use shared executor instead of per-call newSingleThreadExecutor
        // INF-017: Stream-limited read to avoid OOM from abnormally large output
        val future = shellExecutor.submit<ByteArray?> {
            process.inputStream.use { stream ->
                val buffer = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                var totalRead = 0
                while (true) {
                    val n = stream.read(chunk)
                    if (n < 0) break
                    totalRead += n
                    if (totalRead > MAX_SCREENSHOT_SIZE) {
                        log("screencap output exceeds ${MAX_SCREENSHOT_SIZE} bytes, aborting")
                        return@submit null
                    }
                    buffer.write(chunk, 0, n)
                }
                buffer.toByteArray()
            }
        }
        val stderrFuture = shellExecutor.submit<String> {
            process.errorStream.bufferedReader().readText()
        }
        // INF-018: Handle all exception types (not just TimeoutException)
        val bytes = try {
            future.get(SHELL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        } catch (e: Exception) {
            log("screencap read error: ${e.message}")
            future.cancel(true)
            stderrFuture.cancel(true)
            return null
        }
        lastCaptureStderr = try { stderrFuture.get(2, TimeUnit.SECONDS) } catch (_: Exception) { "" }
        if (bytes == null || bytes.isEmpty()) return null
        if (!process.waitFor(5, TimeUnit.SECONDS)) return null
        if (process.exitValue() != 0) return null
        if (bytes.size < 4 || !bytes.copyOfRange(0, 4).contentEquals(PNG_MAGIC)) {
            log("screencap output is not valid PNG (magic mismatch)")
            return null
        }
        return bytes
    } catch (e: Exception) {
        log("screencap error: ${e.message}")
        return null
    } finally {
        // INF-018: Guarantee process cleanup on every exit path
        process.destroyForcibly()
    }
}

/**
 * Detect FLAG_SECURE black screens by sampling downscaled pixels.
 * Returns true if all sampled pixels are near-black (RGB each ≤ 5),
 * indicating the window likely has FLAG_SECURE set.
 */
private fun looksLikeSecureBlackScreen(pngBytes: ByteArray): Boolean {
    return try {
        val options = BitmapFactory.Options().apply { inSampleSize = 8 }
        val bmp = BitmapFactory.decodeByteArray(pngBytes, 0, pngBytes.size, options)
            ?: return false
        try {
            val w = bmp.width
            val h = bmp.height
            if (w < 2 || h < 2) return false

            val ref = bmp.getPixel(0, 0)
            val r0 = (ref shr 16) and 0xFF
            val g0 = (ref shr 8) and 0xFF
            val b0 = ref and 0xFF
            if (r0 > 5 || g0 > 5 || b0 > 5) return false

            val stepX = maxOf(1, w / 32)
            val stepY = maxOf(1, h / 32)
            for (y in 0 until h step stepY) {
                for (x in 0 until w step stepX) {
                    if (bmp.getPixel(x, y) != ref) return false
                }
            }
            true
        } finally {
            bmp.recycle()
        }
    } catch (_: Exception) {
        false
    }
}

private fun dumpUiTree(maxDepth: Int): String? {
    val depth = maxDepth.coerceIn(1, 50)
    val tmpFile = "/data/local/tmp/tabtin_uidump.xml"
    for (attempt in 1..3) {
        try {
            val dumpResult = execShell("uiautomator dump $tmpFile")
            if (!dumpResult.success) {
                File(tmpFile).delete()
                if (attempt < 3) { Thread.sleep(500); continue }
                return null
            }

            val xml = try {
                File(tmpFile).takeIf { it.exists() }?.readText()
            } finally {
                File(tmpFile).delete()
            }
            if (xml.isNullOrBlank()) {
                if (attempt < 3) { Thread.sleep(500); continue }
                return null
            }

            return if (depth < 20) pruneUiTree(xml, depth) else xml
        } catch (e: Exception) {
            log("UI tree dump attempt $attempt error: ${e.message}")
            File(tmpFile).delete()
            if (attempt < 3) Thread.sleep(500)
        }
    }
    return null
}

private fun pruneUiTree(xml: String, maxDepth: Int): String {
    var depth = 0
    val sb = StringBuilder()
    var i = 0
    while (i < xml.length) {
        if (xml[i] == '<') {
            val tagEnd = findTagEnd(xml, i)
            if (tagEnd < 0) break
            val tag = xml.substring(i, tagEnd + 1)
            val isSelfClosing = tag.endsWith("/>")
            val isClosing = tag.startsWith("</")
            if (isClosing) depth--
            if (depth < maxDepth) sb.append(tag)
            if (!isClosing && !isSelfClosing) depth++
            i = tagEnd + 1
        } else {
            if (depth < maxDepth) sb.append(xml[i])
            i++
        }
    }
    return sb.toString()
}

// ---------------------------------------------------------------------------
// UI Element parsing & indexing
// ---------------------------------------------------------------------------

private val BOUNDS_RE = Regex("""\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]""")
private val ATTR_RE = Regex("""([\w-]+)="([^"]*?)"""")

/** Find the closing '>' of an XML tag, respecting quoted attribute values.
 *  Handles cases like text="Price > 100" where '>' appears inside quotes. */
private fun findTagEnd(xml: String, start: Int): Int {
    var inQuote = false
    var quoteChar = ' '
    var j = start
    while (j < xml.length) {
        val c = xml[j]
        if (inQuote) {
            if (c == quoteChar) inQuote = false
        } else {
            when (c) {
                '"', '\'' -> { inQuote = true; quoteChar = c }
                '>' -> return j
            }
        }
        j++
    }
    return -1
}

// Common IME package prefixes — filter keyboard elements from UI tree
private val KEYBOARD_PREFIXES = listOf(
    "com.google.android.inputmethod",
    "com.samsung.android.honeyboard",
    "com.baidu.input",
    "com.sohu.inputmethod",
    "com.iflytek.inputmethod",
    "com.tencent.qqpinyin",
    "com.touchtype.swiftkey",
    "com.huawei.inputmethod",
    "com.vivo.ime",
    "com.oppo.ime",
    "com.meizu.flyme.input",
    "com.android.inputmethod",
)

/** Get current display rotation (0=portrait, 1=landscape-left, 2=upside-down, 3=landscape-right).
 *  Uses a short TTL cache (2s) to avoid repeated dumpsys calls in tight loops. */
private fun getDisplayRotation(): Int {
    val now = System.currentTimeMillis()
    if (now - cachedRotationTime < ROTATION_CACHE_TTL_MS) return cachedRotation

    val result = execShell("dumpsys display | grep -m1 'mCurrentOrientation\\|orientation=\\|mRotation'")
    if (result.success) {
        val m = Regex("""(?:mCurrentOrientation|orientation|mRotation)\s*=\s*(\d)""").find(result.output)
        if (m != null) {
            val rotation = m.groupValues[1].toIntOrNull() ?: 0
            cachedRotation = rotation
            cachedRotationTime = now
            return rotation
        }
    }
    log("Rotation detection failed, defaulting to 0")
    return 0
}

private fun getScreenDimensions(forceRefresh: Boolean = false): Pair<Int, Int> {
    if (!forceRefresh && cachedScreenWidth > 0 && cachedScreenHeight > 0) {
        return Pair(cachedScreenWidth, cachedScreenHeight)
    }
    val result = execShellArgs(arrayOf("wm", "size"))
    if (result.success) {
        // Prefer Override size (actual rendering area) over Physical size
        val overrideMatch = Regex("""Override size:\s*(\d+)x(\d+)""").find(result.output)
        val physicalMatch = Regex("""Physical size:\s*(\d+)x(\d+)""").find(result.output)
        val match = overrideMatch ?: physicalMatch
        if (match != null) {
            var w = match.groupValues[1].toInt()
            var h = match.groupValues[2].toInt()
            // Correct for rotation: wm size always reports physical orientation,
            // but touch coordinates are in the current logical orientation.
            val rotation = getDisplayRotation()
            if (rotation == 1 || rotation == 3) {
                // Landscape: ensure w > h
                if (h > w) { val tmp = w; w = h; h = tmp }
            } else {
                // Portrait: ensure h > w
                if (w > h) { val tmp = w; w = h; h = tmp }
            }
            cachedScreenWidth = w
            cachedScreenHeight = h
            return Pair(w, h)
        }
    }
    return Pair(1080, 2400)
}

private fun denormalize(nx: Int, ny: Int): Pair<Int, Int> {
    val (w, h) = getScreenDimensions(forceRefresh = true)
    return Pair(nx * w / NORMALIZED_MAX, ny * h / NORMALIZED_MAX)
}

private fun parseUiElements(xml: String, concise: Boolean, maxElements: Int = MAX_ELEMENTS): List<UiElement> {
    val elements = mutableListOf<UiElement>()
    var counter = 1
    var depth = 0
    // Force-refresh screen dimensions on every UI tree parse (handles rotation)
    val (sw, sh) = getScreenDimensions(forceRefresh = true)

    var i = 0
    while (i < xml.length) {
        if (xml[i] != '<') { i++; continue }
        val tagEnd = findTagEnd(xml, i)
        if (tagEnd < 0) break
        val tag = xml.substring(i, tagEnd + 1)

        when {
            tag.startsWith("<node ") -> {
                val attrs = mutableMapOf<String, String>()
                for (m in ATTR_RE.findAll(tag)) {
                    attrs[m.groupValues[1]] = m.groupValues[2]
                }

                val boundsMatch = BOUNDS_RE.find(attrs["bounds"] ?: "")
                val bl = boundsMatch?.groupValues?.get(1)?.toIntOrNull() ?: 0
                val bt = boundsMatch?.groupValues?.get(2)?.toIntOrNull() ?: 0
                val br = boundsMatch?.groupValues?.get(3)?.toIntOrNull() ?: 0
                val bb = boundsMatch?.groupValues?.get(4)?.toIntOrNull() ?: 0

                val w = br - bl
                val h = bb - bt
                val onScreen = br > 0 && bb > 0 && bl < sw && bt < sh
                val bigEnough = w >= MIN_ELEMENT_SIZE && h >= MIN_ELEMENT_SIZE

                val fullClass = attrs["class"] ?: ""
                val shortClass = fullClass.substringAfterLast('.')
                val text = attrs["text"] ?: ""
                val resourceId = attrs["resource-id"] ?: ""
                val contentDesc = attrs["content-desc"] ?: ""
                val clickable = attrs["clickable"] == "true"
                val checkable = attrs["checkable"] == "true"
                val checked = attrs["checked"] == "true"
                val scrollable = attrs["scrollable"] == "true"
                val longClickable = attrs["long-clickable"] == "true"
                val focused = attrs["focused"] == "true"
                val enabled = attrs["enabled"] != "false"  // default true if absent
                val selected = attrs["selected"] == "true"
                val editable = shortClass.contains("Edit", ignoreCase = true)

                val interactive = clickable || checkable || editable || scrollable || longClickable
                val hasContent = text.isNotEmpty() || contentDesc.isNotEmpty()
                val pkg = attrs["package"] ?: ""
                val isKeyboard = KEYBOARD_PREFIXES.any { pkg.startsWith(it) }

                val keep = if (concise) {
                    if (!(onScreen && bigEnough && !isKeyboard && (interactive || hasContent))) {
                        false
                    } else {
                        val visLeft = bl.coerceAtLeast(0)
                        val visTop = bt.coerceAtLeast(0)
                        val visRight = br.coerceAtMost(sw)
                        val visBottom = bb.coerceAtMost(sh)
                        val visArea = (visRight - visLeft).toLong() * (visBottom - visTop).toLong()
                        val totalArea = w.toLong() * h.toLong()
                        totalArea <= 0 || visArea * 100 / totalArea >= MIN_VISIBILITY_PERCENT
                    }
                } else {
                    onScreen && bigEnough && !isKeyboard
                }

                if (keep) {
                    // Clip bounds to screen so downstream consumers (tap, findClearPoint,
                    // spatial filter, LLM display) always use the visible portion.
                    // Raw bounds were already used for onScreen/visibility filtering above.
                    elements.add(UiElement(
                        index = counter++,
                        className = shortClass,
                        text = text,
                        resourceId = resourceId,
                        contentDesc = contentDesc,
                        boundsLeft = bl.coerceAtLeast(0),
                        boundsTop = bt.coerceAtLeast(0),
                        boundsRight = br.coerceAtMost(sw),
                        boundsBottom = bb.coerceAtMost(sh),
                        clickable = clickable,
                        checkable = checkable,
                        checked = checked,
                        editable = editable,
                        scrollable = scrollable,
                        longClickable = longClickable,
                        focused = focused,
                        enabled = enabled,
                        selected = selected,
                        depth = depth,
                    ))
                    if (elements.size >= maxElements) {
                        log("UI elements truncated at $maxElements")
                        break
                    }
                }

                if (!tag.endsWith("/>")) depth++
            }
            tag.startsWith("</node") -> depth--
        }

        i = tagEnd + 1
    }

    return elements
}

/**
 * Scan raw UI XML for degradation signals (SurfaceView / WebView).
 * SurfaceView: only root's direct children (depth == 1) with >80% screen area.
 * WebView: any depth with >50% screen area.
 */
private fun detectDegradationSignals(xml: String): DegradationSignals {
    val (sw, sh) = getScreenDimensions()
    val screenArea = sw.toLong() * sh.toLong()
    if (screenArea <= 0) return DegradationSignals()

    var surfaceDetected = false
    var webviewDetected = false
    var depth = 0
    var i = 0

    while (i < xml.length) {
        if (xml[i] != '<') { i++; continue }
        val tagEnd = findTagEnd(xml, i)
        if (tagEnd < 0) break
        val tag = xml.substring(i, tagEnd + 1)

        when {
            tag.startsWith("<node ") -> {
                val attrs = mutableMapOf<String, String>()
                for (m in ATTR_RE.findAll(tag)) {
                    attrs[m.groupValues[1]] = m.groupValues[2]
                }
                val fullClass = attrs["class"] ?: ""
                val shortClass = fullClass.substringAfterLast('.')

                val boundsMatch = BOUNDS_RE.find(attrs["bounds"] ?: "")
                if (boundsMatch != null) {
                    val bl = boundsMatch.groupValues[1].toIntOrNull() ?: 0
                    val bt = boundsMatch.groupValues[2].toIntOrNull() ?: 0
                    val br = boundsMatch.groupValues[3].toIntOrNull() ?: 0
                    val bb = boundsMatch.groupValues[4].toIntOrNull() ?: 0
                    val nodeArea = (br - bl).toLong().coerceAtLeast(0) * (bb - bt).toLong().coerceAtLeast(0)
                    val ratio = nodeArea.toDouble() / screenArea

                    if (!surfaceDetected && depth == 1 &&
                        shortClass in SURFACE_VIEW_CLASSES && ratio > SURFACE_VIEW_AREA_THRESHOLD) {
                        surfaceDetected = true
                    }
                    if (!webviewDetected &&
                        (fullClass in WEBVIEW_FULL_CLASSES || shortClass in WEBVIEW_SHORT_CLASSES) &&
                        ratio > WEBVIEW_AREA_THRESHOLD) {
                        webviewDetected = true
                    }
                }

                if (surfaceDetected && webviewDetected) break
                if (!tag.endsWith("/>")) depth++
            }
            tag.startsWith("</node") -> depth--
        }

        i = tagEnd + 1
    }

    return DegradationSignals(surfaceDetected, webviewDetected)
}

/** Build trait labels for an element (shared by formatIndexedElements, handleScreenFindElement, etc.). */
private fun UiElement.buildTraits(): List<String> = buildList {
    if (clickable) add("click")
    if (checkable) add(if (checked) "checked" else "unchecked")
    if (editable) add("edit")
    if (scrollable) add("scroll")
    if (longClickable) add("long")
    if (focused) add("focused")
    if (selected) add("selected")
    if (!enabled) add("disabled")
}

private fun formatIndexedElements(elements: List<UiElement>, showDepth: Boolean): String {
    val sb = StringBuilder()
    for (el in elements) {
        val indent = if (showDepth) "  ".repeat(el.depth.coerceAtMost(5)) else ""
        val label = when {
            el.text.isNotEmpty() -> "\"${el.text}\""
            el.contentDesc.isNotEmpty() -> "[${el.contentDesc}]"
            el.resourceId.isNotEmpty() -> el.resourceId.substringAfterLast('/')
            else -> ""
        }
        val traits = el.buildTraits()
        val traitsStr = if (traits.isNotEmpty()) " {${traits.joinToString(",")}}" else ""
        sb.appendLine("$indent${el.index}. ${el.className}: $label$traitsStr - [${el.boundsLeft},${el.boundsTop},${el.boundsRight},${el.boundsBottom}]")
    }
    return sb.toString()
}

// ---------------------------------------------------------------------------
// Input injection
// ---------------------------------------------------------------------------

/** Invalidate cached elements after any action that may change the UI. */
private fun invalidateUiCache() {
    cachedElements = emptyList()
}

private fun handleScreenTap(params: JsonObject): ActionResult {
    val normalized = params["normalized"]?.jsonPrimitive?.booleanOrNull ?: false
    val rawX = params["x"]?.jsonPrimitive?.intOrNull
        ?: return errorResult("Missing 'x' parameter")
    val rawY = params["y"]?.jsonPrimitive?.intOrNull
        ?: return errorResult("Missing 'y' parameter")

    val (x, y) = if (normalized) {
        if (rawX < 0 || rawX > NORMALIZED_MAX || rawY < 0 || rawY > NORMALIZED_MAX) {
            return errorResult("Normalized coordinates must be 0..$NORMALIZED_MAX, got ($rawX, $rawY)")
        }
        denormalize(rawX, rawY)
    } else {
        Pair(rawX, rawY)
    }
    validateCoord(x, "x")?.let { return errorResult(it) }
    validateCoord(y, "y")?.let { return errorResult(it) }

    val (tapX, tapY) = if (isStealthActive(params)) {
        val (sw, sh) = getScreenDimensions(forceRefresh = true)
        randomizeInBounds(x, y, (x - 10).coerceAtLeast(0), (y - 10).coerceAtLeast(0),
            (x + 10).coerceAtMost(sw), (y + 10).coerceAtMost(sh), 1.0)
    } else Pair(x, y)

    val result = shellActionResult(arrayOf("input", "tap", "$tapX", "$tapY"))
    if (result.json["success"]?.jsonPrimitive?.booleanOrNull == true) invalidateUiCache()
    return result
}

private fun handleScreenTapArea(params: JsonObject): ActionResult {
    val x1 = params["x1"]?.jsonPrimitive?.intOrNull ?: return errorResult("Missing 'x1'")
    val y1 = params["y1"]?.jsonPrimitive?.intOrNull ?: return errorResult("Missing 'y1'")
    val x2 = params["x2"]?.jsonPrimitive?.intOrNull ?: return errorResult("Missing 'x2'")
    val y2 = params["y2"]?.jsonPrimitive?.intOrNull ?: return errorResult("Missing 'y2'")

    validateCoord(x1, "x1")?.let { return errorResult(it) }
    validateCoord(y1, "y1")?.let { return errorResult(it) }
    validateCoord(x2, "x2")?.let { return errorResult(it) }
    validateCoord(y2, "y2")?.let { return errorResult(it) }

    if (x2 <= x1 || y2 <= y1) return errorResult("Invalid area: x2 must > x1 and y2 must > y1")

    val elements = cachedElements
    val (clearX, clearY) = if (elements.isNotEmpty()) {
        findClearPointForBounds(x1, y1, x2, y2, elements)
    } else {
        Pair((x1 + x2) / 2, (y1 + y2) / 2)
    }

    val (cx, cy) = if (isStealthActive(params)) {
        randomizeInBounds(clearX, clearY, x1, y1, x2, y2)
    } else Pair(clearX, clearY)

    val result = execShellArgs(arrayOf("input", "tap", "$cx", "$cy"))
    if (!result.success && isOemBlocked(result.output)) return oemBlockedResult()
    if (result.success) invalidateUiCache()
    return ActionResult(buildJsonObject {
        put("success", result.success)
        if (result.success) {
            put("data", buildJsonObject {
                put("x", cx)
                put("y", cy)
                put("area", "[$x1,$y1,$x2,$y2]")
                if (isStealthActive(params)) put("stealth_randomized", true)
            })
        } else {
            put("error", result.output.trim())
        }
    })
}

private fun handleScreenSwipe(params: JsonObject): ActionResult {
    val normalized = params["normalized"]?.jsonPrimitive?.booleanOrNull ?: false
    val rawSx = params["start_x"]?.jsonPrimitive?.intOrNull ?: return errorResult("Missing 'start_x'")
    val rawSy = params["start_y"]?.jsonPrimitive?.intOrNull ?: return errorResult("Missing 'start_y'")
    val rawEx = params["end_x"]?.jsonPrimitive?.intOrNull ?: return errorResult("Missing 'end_x'")
    val rawEy = params["end_y"]?.jsonPrimitive?.intOrNull ?: return errorResult("Missing 'end_y'")
    val dur = params["duration_ms"]?.jsonPrimitive?.intOrNull ?: 300

    val (sx, sy) = if (normalized) {
        if (rawSx < 0 || rawSx > NORMALIZED_MAX || rawSy < 0 || rawSy > NORMALIZED_MAX) {
            return errorResult("Normalized start coordinates must be 0..$NORMALIZED_MAX")
        }
        denormalize(rawSx, rawSy)
    } else {
        Pair(rawSx, rawSy)
    }
    val (ex, ey) = if (normalized) {
        if (rawEx < 0 || rawEx > NORMALIZED_MAX || rawEy < 0 || rawEy > NORMALIZED_MAX) {
            return errorResult("Normalized end coordinates must be 0..$NORMALIZED_MAX")
        }
        denormalize(rawEx, rawEy)
    } else {
        Pair(rawEx, rawEy)
    }

    validateCoord(sx, "start_x")?.let { return errorResult(it) }
    validateCoord(sy, "start_y")?.let { return errorResult(it) }
    validateCoord(ex, "end_x")?.let { return errorResult(it) }
    validateCoord(ey, "end_y")?.let { return errorResult(it) }
    if (dur < 1 || dur > MAX_DURATION_MS) return errorResult("Invalid 'duration_ms': $dur (must be 1..$MAX_DURATION_MS)")

    if (isStealthActive(params)) {
        val swipeResult = executeBezierSwipe(sx, sy, ex, ey, dur)
        if (!swipeResult.success && isOemBlocked(swipeResult.output)) return oemBlockedResult()
        if (swipeResult.success) invalidateUiCache()
        return ActionResult(buildJsonObject {
            put("success", swipeResult.success)
            if (swipeResult.success) {
                put("data", buildJsonObject { put("stealth_bezier", true) })
            } else {
                put("error", swipeResult.output.trim())
            }
        })
    }

    val result = shellActionResult(arrayOf("input", "swipe", "$sx", "$sy", "$ex", "$ey", "$dur"))
    if (result.json["success"]?.jsonPrimitive?.booleanOrNull == true) invalidateUiCache()
    return result
}

private fun handleScreenLongPress(params: JsonObject): ActionResult {
    val normalized = params["normalized"]?.jsonPrimitive?.booleanOrNull ?: false
    val rawX = params["x"]?.jsonPrimitive?.intOrNull ?: return errorResult("Missing 'x'")
    val rawY = params["y"]?.jsonPrimitive?.intOrNull ?: return errorResult("Missing 'y'")
    val dur = params["duration_ms"]?.jsonPrimitive?.intOrNull ?: 1000

    val (x, y) = if (normalized) {
        if (rawX < 0 || rawX > NORMALIZED_MAX || rawY < 0 || rawY > NORMALIZED_MAX) {
            return errorResult("Normalized coordinates must be 0..$NORMALIZED_MAX, got ($rawX, $rawY)")
        }
        denormalize(rawX, rawY)
    } else {
        Pair(rawX, rawY)
    }
    validateCoord(x, "x")?.let { return errorResult(it) }
    validateCoord(y, "y")?.let { return errorResult(it) }
    if (dur < 100 || dur > MAX_DURATION_MS) return errorResult("Invalid 'duration_ms': $dur (must be 100..$MAX_DURATION_MS)")

    val (lpX, lpY) = if (isStealthActive(params)) {
        val (sw, sh) = getScreenDimensions(forceRefresh = true)
        randomizeInBounds(x, y, (x - 10).coerceAtLeast(0), (y - 10).coerceAtLeast(0),
            (x + 10).coerceAtMost(sw), (y + 10).coerceAtMost(sh), 1.0)
    } else Pair(x, y)

    val result = shellActionResult(arrayOf("input", "swipe", "$lpX", "$lpY", "$lpX", "$lpY", "$dur"))
    if (result.json["success"]?.jsonPrimitive?.booleanOrNull == true) invalidateUiCache()
    return result
}

private fun handleScreenTypeText(params: JsonObject, skipCacheInvalidation: Boolean = false): ActionResult {
    val text = params["text"]?.jsonPrimitive?.contentOrNull
        ?: return errorResult("Missing 'text'")

    if (text.isEmpty()) {
        return ActionResult(buildJsonObject {
            put("success", true)
            put("data", buildJsonObject { put("method", "noop_empty") })
        })
    }

    val isAscii = text.all { it.code in 0x20..0x7E }

    if (isStealthActive(params) && isAscii && text.length <= INPUT_TEXT_MAX_LENGTH) {
        val result = stealthTypeAscii(text)
        if (!skipCacheInvalidation && result.json["success"]?.jsonPrimitive?.booleanOrNull == true) invalidateUiCache()
        return result
    }

    if (isAscii && text.length <= INPUT_TEXT_MAX_LENGTH) {
        val escaped = text.replace("%", "%%").replace(" ", "%s")
        val result = shellActionResult(arrayOf("input", "text", escaped))
        if (!skipCacheInvalidation && result.json["success"]?.jsonPrimitive?.booleanOrNull == true) invalidateUiCache()
        return result
    }

    return typeViaClipboard(text, skipCacheInvalidation)
}

private fun typeViaClipboard(text: String, skipCacheInvalidation: Boolean): ActionResult {
    val savedClip = getClipboardViaFramework()

    // INF-019: service call s16 mishandles multi-byte (CJK/Emoji) on some Android versions.
    // Only use this fallback for short ASCII-only text.
    val clipSet = setClipboardViaFramework(text) || run {
        val isAsciiSafe = text.all { it.code in 0x20..0x7E } && text.length <= 256
        if (!isAsciiSafe) return@run false
        val shellResult = execShellArgs(arrayOf(
            "sh", "-c",
            "service call clipboard 2 i32 1 i32 1 s16 tabtin s16 ${shellEscape(text)} i32 0 i32 0 2>/dev/null",
        ))
        shellResult.success
    }

    if (!clipSet) {
        if (savedClip != null) setClipboardViaFramework(savedClip)
        return errorResult("Failed to set clipboard for text input")
    }

    val pasteResult = execShellArgs(arrayOf("input", "keyevent", "279"))
    val pasteSuccess = pasteResult.success

    Thread.sleep(150)

    var warning: String? = null
    if (pasteSuccess) {
        val verifyXml = dumpUiTree(8)
        if (verifyXml != null) {
            val verifyElements = parseUiElements(verifyXml, concise = false)
            cachedElements = verifyElements
            cachedGeneration++
            val hasFocusedEditable = verifyElements.any { it.focused && it.editable }
            if (!hasFocusedEditable) {
                warning = "no_focused_editable_field_after_paste"
            }
        }
        val clipAfterPaste = getClipboardViaFramework()
        if (clipAfterPaste != null && clipAfterPaste == text) {
            warning = (warning?.plus("; ") ?: "") + "clipboard_not_consumed_may_not_pasted"
        }
    }

    if (savedClip != null) {
        Thread.sleep(100)
        setClipboardViaFramework(savedClip)
    } else {
        warning = (warning?.plus("; ") ?: "") + "original_clipboard_empty_or_non_text"
    }

    if (!skipCacheInvalidation) invalidateUiCache()

    if (!pasteSuccess) {
        if (isOemBlocked(pasteResult.output)) return oemBlockedResult()
        return errorResult("KEYCODE_PASTE failed: ${pasteResult.output.trim()}")
    }

    return ActionResult(buildJsonObject {
        put("success", true)
        put("data", buildJsonObject {
            put("method", "clipboard_paste")
            if (warning != null) put("warning", warning)
        })
    })
}

/**
 * Set clipboard text via Android framework IClipboard binder interface.
 * Since app_process runs with shell UID and has framework access,
 * we can invoke IClipboard.setPrimaryClip() directly via reflection.
 * This is more reliable than shell commands across Android versions.
 */
private fun setClipboardViaFramework(text: String): Boolean {
    return try {
        val sm = Class.forName("android.os.ServiceManager")
        val binder = sm.getMethod("getService", String::class.java)
            .invoke(null, "clipboard") as? android.os.IBinder ?: return false

        val stubClass = Class.forName("android.content.IClipboard\$Stub")
        val clipboard = stubClass.getMethod("asInterface", android.os.IBinder::class.java)
            .invoke(null, binder) ?: return false

        val clipData = ClipData.newPlainText("tabtin", text)

        // IClipboard.setPrimaryClip signature varies across Android versions.
        // Try each candidate by descending parameter count until one succeeds.
        val methods = clipboard.javaClass.methods
            .filter { it.name == "setPrimaryClip" }
            .sortedByDescending { it.parameterTypes.size }
        if (methods.isEmpty()) return false

        for (method in methods) {
            try {
                when (method.parameterTypes.size) {
                    4 -> method.invoke(clipboard, clipData, "com.android.shell", null, 0)
                    3 -> method.invoke(clipboard, clipData, "com.android.shell", 0)
                    2 -> method.invoke(clipboard, clipData, "com.android.shell")
                    else -> continue
                }
                return true
            } catch (_: Exception) {
                continue
            }
        }
        false
    } catch (e: Exception) {
        log("Framework clipboard API failed: ${e.message}")
        false
    }
}

/**
 * Read clipboard text via Android framework IClipboard binder interface.
 * Returns the current clipboard text, or null if the clipboard is empty or inaccessible.
 */
private fun getClipboardViaFramework(): String? {
    return try {
        val sm = Class.forName("android.os.ServiceManager")
        val binder = sm.getMethod("getService", String::class.java)
            .invoke(null, "clipboard") as? android.os.IBinder ?: return null

        val stubClass = Class.forName("android.content.IClipboard\$Stub")
        val clipboard = stubClass.getMethod("asInterface", android.os.IBinder::class.java)
            .invoke(null, binder) ?: return null

        val methods = clipboard.javaClass.methods
            .filter { it.name == "getPrimaryClip" }
            .sortedByDescending { it.parameterTypes.size }
        if (methods.isEmpty()) return null

        for (method in methods) {
            try {
                val clip = when (method.parameterTypes.size) {
                    3 -> method.invoke(clipboard, "com.android.shell", null, 0)
                    2 -> method.invoke(clipboard, "com.android.shell", 0)
                    1 -> method.invoke(clipboard, "com.android.shell")
                    else -> continue
                }
                if (clip != null) {
                    val clipData = clip as android.content.ClipData
                    if (clipData.itemCount > 0) {
                        return clipData.getItemAt(0).text?.toString()
                    }
                }
                return null
            } catch (_: Exception) {
                continue
            }
        }
        null
    } catch (e: Exception) {
        log("Framework clipboard read failed: ${e.message}")
        null
    }
}

private fun handleScreenKeyEvent(params: JsonObject): ActionResult {
    val keyCode = params["key_code"]?.jsonPrimitive?.intOrNull
        ?: return errorResult("Missing 'key_code'")
    if (keyCode < 0 || keyCode > MAX_KEY_CODE) return errorResult("Invalid 'key_code': $keyCode (must be 0..$MAX_KEY_CODE)")

    val result = shellActionResult(arrayOf("input", "keyevent", "$keyCode"))
    if (result.json["success"]?.jsonPrimitive?.booleanOrNull == true) invalidateUiCache()
    return result
}

private fun handleScreenWaitForIdle(params: JsonObject): ActionResult {
    val timeout = params["timeout_ms"]?.jsonPrimitive?.intOrNull ?: 5000
    if (timeout < 0 || timeout > MAX_WAIT_TIMEOUT_MS) return errorResult("Invalid 'timeout_ms': $timeout (must be 0..$MAX_WAIT_TIMEOUT_MS)")
    val includeText = params["include_text"]?.jsonPrimitive?.booleanOrNull ?: false
    val stableCount = (params["stable_count"]?.jsonPrimitive?.intOrNull ?: 3).coerceIn(1, 10)
    val startTime = System.currentTimeMillis()
    val fastPhaseMs = 2000L
    val fastInterval = 300L
    val slowInterval = 800L

    var previousHash: Int? = null
    var consecutiveStable = 0

    while (System.currentTimeMillis() - startTime < timeout) {
        val xml = dumpUiTree(10)
        val currentHash = if (xml != null) uiStructuralHash(xml, includeText) else null
        if (currentHash != null && currentHash == previousHash) {
            consecutiveStable++
            if (consecutiveStable >= stableCount) {
                if (xml != null) {
                    val elements = parseUiElements(xml, concise = cachedConciseMode)
                    cachedElements = elements
                    cachedGeneration++
                }
                return successResult(buildJsonObject {
                    put("idle", true)
                    put("wait_ms", System.currentTimeMillis() - startTime)
                    put("stable_checks", consecutiveStable)
                })
            }
        } else {
            consecutiveStable = 0
        }
        previousHash = currentHash
        val elapsed = System.currentTimeMillis() - startTime
        Thread.sleep(if (elapsed < fastPhaseMs) fastInterval else slowInterval)
    }

    return successResult(buildJsonObject {
        put("idle", false)
        put("wait_ms", System.currentTimeMillis() - startTime)
        put("stable_checks", consecutiveStable)
    })
}

/** Compute a structural hash of the UI tree that ignores volatile content.
 *  Always includes: class, bounds, interactive state (clickable/scrollable/enabled), resource-id.
 *  Excludes by default: text, content-desc (may contain dynamic counters/notifications),
 *  focused, checked (may flicker).
 *  When [includeText] is true, text AND content-desc are also included — useful for
 *  detecting text content changes (e.g. waiting for a specific page to finish loading). */
private fun uiStructuralHash(xml: String, includeText: Boolean = false): Int {
    var hash = 0
    var i = 0
    while (i < xml.length) {
        if (xml[i] != '<') { i++; continue }
        val tagEnd = findTagEnd(xml, i)
        if (tagEnd < 0) break
        val tag = xml.substring(i, tagEnd + 1)
        if (tag.startsWith("<node ")) {
            val attrs = mutableMapOf<String, String>()
            for (m in ATTR_RE.findAll(tag)) {
                attrs[m.groupValues[1]] = m.groupValues[2]
            }
            hash = hash * 31 + (attrs["class"] ?: "").hashCode()
            hash = hash * 31 + (attrs["bounds"] ?: "").hashCode()
            hash = hash * 31 + (attrs["clickable"] ?: "").hashCode()
            hash = hash * 31 + (attrs["scrollable"] ?: "").hashCode()
            hash = hash * 31 + (attrs["enabled"] ?: "").hashCode()
            hash = hash * 31 + (attrs["resource-id"] ?: "").hashCode()
            if (includeText) {
                hash = hash * 31 + (attrs["content-desc"] ?: "").hashCode()
                hash = hash * 31 + (attrs["text"] ?: "").hashCode()
            }
        }
        i = tagEnd + 1
    }
    return hash
}

// ---------------------------------------------------------------------------
// Element-based actions
// ---------------------------------------------------------------------------

private data class ResolvedElement(val element: UiElement, val autoRefreshed: Boolean)

private fun resolveElement(index: Int, conciseHint: Boolean = true): ResolvedElement? {
    var elements = cachedElements
    var autoRefreshed = false
    if (elements.isEmpty()) {
        val xml = dumpUiTree(lastDumpDepth) ?: return null
        val useConcise = if (cachedGeneration > 0) cachedConciseMode else conciseHint
        elements = parseUiElements(xml, concise = useConcise)
        cachedElements = elements
        cachedConciseMode = useConcise
        cachedGeneration++
        autoRefreshed = true
    }
    val el = elements.find { it.index == index } ?: return null
    return ResolvedElement(el, autoRefreshed)
}

/** Check if a point is covered by any of the given obscuring elements. */
private fun isPointObscured(x: Int, y: Int, obscurers: List<UiElement>): Boolean {
    return obscurers.any { el ->
        x >= el.boundsLeft && x < el.boundsRight && y >= el.boundsTop && y < el.boundsBottom
    }
}

/** Recursively subdivide a rectangle into quadrants to find an unobscured point. */
private fun findClearPointInRect(
    left: Int, top: Int, right: Int, bottom: Int,
    obscurers: List<UiElement>, depth: Int,
): Pair<Int, Int>? {
    if (depth > 2) return null
    if (right - left < MIN_ELEMENT_SIZE || bottom - top < MIN_ELEMENT_SIZE) return null

    val midX = (left + right) / 2
    val midY = (top + bottom) / 2
    if (!isPointObscured(midX, midY, obscurers)) return Pair(midX, midY)

    val quadrants = arrayOf(
        intArrayOf(left, top, midX, midY),
        intArrayOf(midX, top, right, midY),
        intArrayOf(left, midY, midX, bottom),
        intArrayOf(midX, midY, right, bottom),
    )
    for (q in quadrants) {
        val result = findClearPointInRect(q[0], q[1], q[2], q[3], obscurers, depth + 1)
        if (result != null) return result
    }
    return null
}

/**
 * Find a clear (unobscured) tap point for the given element.
 * Uses quadrant subdivision when the center point is covered by a higher z-order element.
 * Falls back to center if no clear point is found.
 */
private fun findClearPoint(target: UiElement, elements: List<UiElement>): Pair<Int, Int> {
    val cx = (target.boundsLeft + target.boundsRight) / 2
    val cy = (target.boundsTop + target.boundsBottom) / 2

    val targetPos = elements.indexOf(target)
    if (targetPos < 0 || targetPos >= elements.size - 1) return Pair(cx, cy)

    // Elements that appear later in DFS order (higher z-order) and overlap target,
    // but are NOT fully contained within target (i.e., not children/descendants).
    val obscurers = elements.subList(targetPos + 1, elements.size).filter { other ->
        other.boundsLeft < target.boundsRight && other.boundsRight > target.boundsLeft &&
        other.boundsTop < target.boundsBottom && other.boundsBottom > target.boundsTop &&
        !(other.boundsLeft >= target.boundsLeft && other.boundsRight <= target.boundsRight &&
          other.boundsTop >= target.boundsTop && other.boundsBottom <= target.boundsBottom)
    }

    if (obscurers.isEmpty() || !isPointObscured(cx, cy, obscurers)) return Pair(cx, cy)

    return findClearPointInRect(
        target.boundsLeft, target.boundsTop, target.boundsRight, target.boundsBottom,
        obscurers, depth = 0,
    ) ?: Pair(cx, cy)
}

/** Find a clear tap point for an arbitrary bounding rect (not necessarily in the elements list).
 *  Used by handleScreenTapArea where the synthetic element has no position in DFS order. */
private fun findClearPointForBounds(
    left: Int, top: Int, right: Int, bottom: Int,
    elements: List<UiElement>,
): Pair<Int, Int> {
    val cx = (left + right) / 2
    val cy = (top + bottom) / 2
    val obscurers = elements.filter { o ->
        o.boundsLeft < right && o.boundsRight > left &&
        o.boundsTop < bottom && o.boundsBottom > top &&
        !(o.boundsLeft >= left && o.boundsRight <= right &&
          o.boundsTop >= top && o.boundsBottom <= bottom)
    }
    if (obscurers.isEmpty() || !isPointObscured(cx, cy, obscurers)) return Pair(cx, cy)
    return findClearPointInRect(left, top, right, bottom, obscurers, 0) ?: Pair(cx, cy)
}

private fun handleScreenTapElement(params: JsonObject): ActionResult {
    val index = params["index"]?.jsonPrimitive?.intOrNull
        ?: return errorResult("Missing 'index' parameter")

    val resolved = resolveElement(index)
        ?: return errorResult("Element index $index not found (available: 1..${cachedElements.size})")

    val el = resolved.element
    val centerX = (el.boundsLeft + el.boundsRight) / 2
    val centerY = (el.boundsTop + el.boundsBottom) / 2
    val (clearX, clearY) = findClearPoint(el, cachedElements)
    val occlusionAvoided = clearX != centerX || clearY != centerY

    val (cx, cy) = if (isStealthActive(params)) {
        randomizeInBounds(clearX, clearY, el.boundsLeft, el.boundsTop, el.boundsRight, el.boundsBottom)
    } else Pair(clearX, clearY)

    val tapResult = execShellArgs(arrayOf("input", "tap", "$cx", "$cy"))
    if (!tapResult.success && isOemBlocked(tapResult.output)) return oemBlockedResult()
    if (tapResult.success) invalidateUiCache()
    return ActionResult(buildJsonObject {
        put("success", tapResult.success)
        if (tapResult.success) {
            put("data", buildJsonObject {
                put("tapped_index", index)
                put("x", cx)
                put("y", cy)
                put("element_class", el.className)
                put("element_text", el.text.ifEmpty { el.contentDesc })
                if (occlusionAvoided) put("occlusion_avoided", true)
                if (isStealthActive(params)) put("stealth_randomized", true)
                if (resolved.autoRefreshed) {
                    put("auto_refreshed", true)
                    put("element_count", cachedElements.size)
                }
            })
        } else {
            put("error", tapResult.output.trim())
        }
    })
}

private fun handleScreenLongPressElement(params: JsonObject): ActionResult {
    val index = params["index"]?.jsonPrimitive?.intOrNull
        ?: return errorResult("Missing 'index' parameter")
    val dur = params["duration_ms"]?.jsonPrimitive?.intOrNull ?: 1000
    if (dur < 100 || dur > MAX_DURATION_MS) return errorResult("Invalid 'duration_ms': $dur (must be 100..$MAX_DURATION_MS)")

    val resolved = resolveElement(index)
        ?: return errorResult("Element index $index not found (available: 1..${cachedElements.size})")

    val el = resolved.element
    val centerX = (el.boundsLeft + el.boundsRight) / 2
    val centerY = (el.boundsTop + el.boundsBottom) / 2
    val (clearX, clearY) = findClearPoint(el, cachedElements)
    val occlusionAvoided = clearX != centerX || clearY != centerY

    val (cx, cy) = if (isStealthActive(params)) {
        randomizeInBounds(clearX, clearY, el.boundsLeft, el.boundsTop, el.boundsRight, el.boundsBottom)
    } else Pair(clearX, clearY)

    val result = execShellArgs(arrayOf("input", "swipe", "$cx", "$cy", "$cx", "$cy", "$dur"))
    if (!result.success && isOemBlocked(result.output)) return oemBlockedResult()
    if (result.success) invalidateUiCache()
    return ActionResult(buildJsonObject {
        put("success", result.success)
        if (result.success) {
            put("data", buildJsonObject {
                put("long_pressed_index", index)
                put("x", cx)
                put("y", cy)
                put("duration_ms", dur)
                put("element_class", el.className)
                put("element_text", el.text.ifEmpty { el.contentDesc })
                if (occlusionAvoided) put("occlusion_avoided", true)
                if (isStealthActive(params)) put("stealth_randomized", true)
                if (resolved.autoRefreshed) {
                    put("auto_refreshed", true)
                    put("element_count", cachedElements.size)
                }
            })
        } else {
            put("error", result.output.trim())
        }
    })
}

private fun handleScreenFindElement(params: JsonObject): ActionResult {
    val query = params["text"]?.jsonPrimitive?.contentOrNull
    val useRegex = params["regex"]?.jsonPrimitive?.booleanOrNull ?: false
    val partial = params["partial"]?.jsonPrimitive?.booleanOrNull ?: true
    val className = params["class_name"]?.jsonPrimitive?.contentOrNull
    val maxResults = (params["max_results"]?.jsonPrimitive?.intOrNull ?: 20).coerceIn(1, 50)
    val sortBy = params["sort_by"]?.jsonPrimitive?.contentOrNull

    // Trait filters (null = don't filter, true/false = require match)
    val filterClickable = params["clickable"]?.jsonPrimitive?.booleanOrNull
    val filterScrollable = params["scrollable"]?.jsonPrimitive?.booleanOrNull
    val filterEditable = params["editable"]?.jsonPrimitive?.booleanOrNull
    val filterEnabled = params["enabled"]?.jsonPrimitive?.booleanOrNull
    val filterChecked = params["checked"]?.jsonPrimitive?.booleanOrNull
    val filterSelected = params["selected"]?.jsonPrimitive?.booleanOrNull
    val filterFocused = params["focused"]?.jsonPrimitive?.booleanOrNull

    val hasTextQuery = !query.isNullOrEmpty()
    val hasTraitFilter = listOf(filterClickable, filterScrollable, filterEditable,
        filterEnabled, filterChecked, filterSelected, filterFocused).any { it != null }
    val hasClassFilter = !className.isNullOrEmpty()
    if (!hasTextQuery && !hasTraitFilter && !hasClassFilter) {
        return errorResult("At least one of 'text', 'class_name', or a trait filter (clickable/scrollable/editable/enabled/checked/selected/focused) is required")
    }

    // Compile regex upfront if needed — with length guard against DoS patterns
    val regex = if (hasTextQuery && useRegex) {
        if (query.length > MAX_REGEX_PATTERN_LENGTH) {
            return errorResult("Regex pattern too long: ${query.length} chars (max $MAX_REGEX_PATTERN_LENGTH)")
        }
        try { Regex(query, RegexOption.IGNORE_CASE) } catch (_: Exception) {
            return errorResult("Invalid regex pattern: $query")
        }
    } else null

    // Auto-dump if no cached elements (preserve last-used concise mode and depth)
    var elements = cachedElements
    if (elements.isEmpty()) {
        val xml = dumpUiTree(lastDumpDepth) ?: return errorResult("uiautomator dump failed")
        elements = parseUiElements(xml, concise = cachedConciseMode)
        cachedElements = elements
        cachedGeneration++
    }

    var regexTimeoutCount = 0
    var matches = elements.filter { el ->
        // 1. Text matching (with newline normalization + regex + resourceId short form)
        val textOk = if (!hasTextQuery) true else {
            val fields = listOf(el.text, el.contentDesc, el.resourceId)
            val shortId = el.resourceId.substringAfterLast('/')
            val allFields = if (shortId != el.resourceId) fields + shortId else fields

            if (regex != null) {
                allFields.any { field ->
                    if (field.isEmpty()) return@any false
                    try {
                        val deadline = System.currentTimeMillis() + REGEX_MATCH_TIMEOUT_MS
                        regex.containsMatchIn(InterruptibleCharSequence(field, deadline)) ||
                            regex.containsMatchIn(InterruptibleCharSequence(field.replace("\n", " "), deadline))
                    } catch (_: RuntimeException) { regexTimeoutCount++; false }
                }
            } else if (partial) {
                allFields.any { field ->
                    if (field.isEmpty()) return@any false
                    field.contains(query, ignoreCase = true) ||
                        field.replace("\n", " ").contains(query, ignoreCase = true)
                }
            } else {
                allFields.any { field ->
                    if (field.isEmpty()) return@any false
                    field.equals(query, ignoreCase = true) ||
                        field.replace("\n", " ").equals(query, ignoreCase = true)
                }
            }
        }
        if (!textOk) return@filter false

        // 2. Class name filtering
        if (hasClassFilter && !el.className.contains(className, ignoreCase = true)) return@filter false

        // 3. Trait filters
        if (filterClickable != null && el.clickable != filterClickable) return@filter false
        if (filterScrollable != null && el.scrollable != filterScrollable) return@filter false
        if (filterEditable != null && el.editable != filterEditable) return@filter false
        if (filterEnabled != null && el.enabled != filterEnabled) return@filter false
        if (filterChecked != null && el.checked != filterChecked) return@filter false
        if (filterSelected != null && el.selected != filterSelected) return@filter false
        if (filterFocused != null && el.focused != filterFocused) return@filter false

        true
    }

    // Spatial filtering: narrow results relative to an anchor element
    val anchorIndex = params["anchor_index"]?.jsonPrimitive?.intOrNull
    val direction = params["direction"]?.jsonPrimitive?.contentOrNull
    if ((anchorIndex != null) != (direction != null)) {
        return errorResult("anchor_index and direction must be used together")
    }
    var spatialFilterWarning: String? = null
    var anchor: UiElement? = null
    if (anchorIndex != null && direction != null) {
        anchor = elements.find { it.index == anchorIndex }
        if (anchor == null) {
            spatialFilterWarning = "anchor_index $anchorIndex not found, spatial filter skipped"
        } else {
            val aCx = (anchor.boundsLeft + anchor.boundsRight) / 2
            val aCy = (anchor.boundsTop + anchor.boundsBottom) / 2
            matches = matches.filter { el ->
                val cx = (el.boundsLeft + el.boundsRight) / 2
                val cy = (el.boundsTop + el.boundsBottom) / 2
                when (direction) {
                    "below" -> cy > anchor.boundsBottom
                    "above" -> cy < anchor.boundsTop
                    "left_of" -> cx < anchor.boundsLeft
                    "right_of" -> cx > anchor.boundsRight
                    "near" -> {
                        val dx = (cx - aCx).toDouble()
                        val dy = (cy - aCy).toDouble()
                        val dist = Math.sqrt(dx * dx + dy * dy)
                        val refSize = ((anchor.boundsRight - anchor.boundsLeft) + (anchor.boundsBottom - anchor.boundsTop)).toDouble()
                        dist < (refSize * 1.5).coerceAtMost(500.0)
                    }
                    else -> true
                }
            }
        }
    }

    // Sort results
    val sortedMatches = when (sortBy) {
        "position" -> matches.sortedWith(compareBy({ it.boundsTop }, { it.boundsLeft }))
        "distance" -> if (anchor != null) {
            val aCx = (anchor.boundsLeft + anchor.boundsRight) / 2.0
            val aCy = (anchor.boundsTop + anchor.boundsBottom) / 2.0
            matches.sortedBy { el ->
                val cx = (el.boundsLeft + el.boundsRight) / 2.0
                val cy = (el.boundsTop + el.boundsBottom) / 2.0
                Math.sqrt((cx - aCx) * (cx - aCx) + (cy - aCy) * (cy - aCy))
            }
        } else {
            return errorResult("sort_by='distance' requires anchor_index")
        }
        else -> if (anchor != null) {
            val aCx = (anchor.boundsLeft + anchor.boundsRight) / 2.0
            val aCy = (anchor.boundsTop + anchor.boundsBottom) / 2.0
            matches.sortedBy { el ->
                val cx = (el.boundsLeft + el.boundsRight) / 2.0
                val cy = (el.boundsTop + el.boundsBottom) / 2.0
                Math.sqrt((cx - aCx) * (cx - aCx) + (cy - aCy) * (cy - aCy))
            }
        } else matches
    }

    return successResult(buildJsonObject {
        put("count", sortedMatches.size)
        put("total_element_count", elements.size)
        if (elements.size >= MAX_ELEMENTS) put("elements_truncated", true)
        val warnings = buildList {
            if (spatialFilterWarning != null) add(spatialFilterWarning)
            if (regexTimeoutCount > 0) add("regex_timeout_skipped_${regexTimeoutCount}_elements_results_may_be_incomplete")
        }
        if (warnings.isNotEmpty()) put("warning", warnings.joinToString("; "))
        put("elements", buildJsonArray {
            for (el in sortedMatches.take(maxResults)) {
                add(buildJsonObject {
                    put("index", el.index)
                    put("class", el.className)
                    put("text", el.text)
                    put("content_desc", el.contentDesc)
                    put("resource_id", el.resourceId)
                    put("bounds", "[${el.boundsLeft},${el.boundsTop},${el.boundsRight},${el.boundsBottom}]")
                    val traits = el.buildTraits()
                    if (traits.isNotEmpty()) put("traits", traits.joinToString(","))
                    if (anchor != null) {
                        val cx = (el.boundsLeft + el.boundsRight) / 2.0
                        val cy = (el.boundsTop + el.boundsBottom) / 2.0
                        val aCx = (anchor.boundsLeft + anchor.boundsRight) / 2.0
                        val aCy = (anchor.boundsTop + anchor.boundsBottom) / 2.0
                        put("distance", Math.round(Math.sqrt((cx - aCx) * (cx - aCx) + (cy - aCy) * (cy - aCy))).toInt())
                    }
                })
            }
        })
    })
}

private fun handleScreenGetContext(): ActionResult {
    // 1. Current foreground app
    val topResult = execShell("dumpsys activity activities | grep -m1 'mResumedActivity\\|mCurrentFocus'")
    var foregroundPkg = ""
    var foregroundActivity = ""
    if (topResult.success) {
        // Pattern: "mResumedActivity: ActivityRecord{... com.app/.Activity t123}"
        val actMatch = Regex("""(\S+)/(\S+)\s""").find(topResult.output)
        if (actMatch != null) {
            foregroundPkg = actMatch.groupValues[1]
            foregroundActivity = actMatch.groupValues[2]
        }
    }

    // 2. Keyboard visible
    val imeResult = execShell("dumpsys input_method | grep -m1 'mInputShown'")
    val keyboardVisible = imeResult.success && imeResult.output.contains("mInputShown=true")

    // 3. Focused element — auto-dump when cache is empty
    var contextElements = cachedElements
    if (contextElements.isEmpty()) {
        val xml = dumpUiTree(10)
        if (xml != null) {
            contextElements = parseUiElements(xml, concise = cachedConciseMode)
            cachedElements = contextElements
            cachedGeneration++
        }
    }
    val focusedElement = contextElements.find { it.focused }

    // 4. Screen dimensions (forceRefresh to handle rotation changes)
    val (sw, sh) = getScreenDimensions(forceRefresh = true)

    // 5. Dialog detection — class name patterns + resource-id fallback
    val dialogElements = contextElements.filter { el ->
        DIALOG_CLASS_PATTERNS.any { pattern -> el.className.contains(pattern, ignoreCase = true) }
    }
    val hasDialogByResource = dialogElements.isEmpty() && contextElements.any { el ->
        el.resourceId.isNotEmpty() && DIALOG_RESOURCE_ID_SUFFIXES.any { suffix ->
            el.resourceId.endsWith("/$suffix") || el.resourceId.endsWith(":id/$suffix")
        }
    }
    val effectiveDialogElements = if (dialogElements.isNotEmpty()) dialogElements else {
        if (hasDialogByResource) contextElements.filter { el ->
            el.resourceId.isNotEmpty() && DIALOG_RESOURCE_ID_SUFFIXES.any { suffix ->
                el.resourceId.endsWith("/$suffix") || el.resourceId.endsWith(":id/$suffix")
            }
        } else emptyList()
    }
    val hasDialog = effectiveDialogElements.isNotEmpty()
    val dialogType = if (hasDialog) {
        val firstClass = effectiveDialogElements.first().className.lowercase()
        val firstResId = effectiveDialogElements.first().resourceId.lowercase()
        when {
            firstClass.contains("grantpermission") || firstClass.contains("requestpermission") || firstClass.contains("permissioncontroller") -> "permission"
            hasDialogByResource && (firstResId.contains("permission_allow") || firstResId.contains("permission_deny")) -> "permission"
            firstClass.contains("bottomsheet") -> "bottom_sheet"
            firstClass.contains("actionsheet") -> "action_sheet"
            firstClass.contains("snackbar") -> "snackbar"
            firstClass.contains("datepicker") -> "date_picker"
            firstClass.contains("timepicker") -> "time_picker"
            firstClass.contains("popupmenu") -> "popup_menu"
            firstClass.contains("alertdialog") || firstClass.contains("appcompatdialog") || firstClass.contains("materialalertdialog") -> "alert"
            hasDialogByResource && firstResId.contains("alerttitle") -> "alert"
            firstClass.contains("dialog") -> "dialog"
            else -> "dialog"
        }
    } else null

    return successResult(buildJsonObject {
        put("foreground_package", foregroundPkg)
        put("foreground_activity", foregroundActivity)
        put("keyboard_visible", keyboardVisible)
        put("screen_width", sw)
        put("screen_height", sh)
        if (focusedElement != null) {
            put("focused_element", buildJsonObject {
                put("index", focusedElement.index)
                put("class", focusedElement.className)
                put("text", focusedElement.text)
                put("content_desc", focusedElement.contentDesc)
                put("bounds", "[${focusedElement.boundsLeft},${focusedElement.boundsTop},${focusedElement.boundsRight},${focusedElement.boundsBottom}]")
            })
        }
        put("has_dialog", hasDialog)
        if (dialogType != null) put("dialog_type", dialogType)
        if (hasDialogByResource) put("dialog_detected_by", "resource_id")
        if (hasDialog) {
            put("dialog_elements", buildJsonArray {
                for (el in effectiveDialogElements.take(10)) {
                    add(buildJsonObject {
                        put("index", el.index)
                        put("class", el.className)
                        put("text", el.text)
                        put("content_desc", el.contentDesc)
                        val traits = el.buildTraits()
                        if (traits.isNotEmpty()) put("traits", traits.joinToString(","))
                    })
                }
            })
        }
    })
}

private fun handleScreenTypeInElement(params: JsonObject): ActionResult {
    val index = params["index"]?.jsonPrimitive?.intOrNull
        ?: return errorResult("Missing 'index' parameter")
    val text = params["text"]?.jsonPrimitive?.contentOrNull
        ?: return errorResult("Missing 'text' parameter")
    if (text.isEmpty()) {
        return errorResult("'text' parameter must not be empty")
    }
    val clearFirst = params["clear"]?.jsonPrimitive?.booleanOrNull ?: false

    val resolved = resolveElement(index)
        ?: return errorResult("Element index $index not found (available: 1..${cachedElements.size})")
    val element = resolved.element

    val (clearX, clearY) = findClearPoint(element, cachedElements)
    val (cx, cy) = if (isStealthActive(params)) {
        randomizeInBounds(clearX, clearY, element.boundsLeft, element.boundsTop, element.boundsRight, element.boundsBottom)
    } else Pair(clearX, clearY)

    val tapResult = execShellArgs(arrayOf("input", "tap", "$cx", "$cy"))
    if (!tapResult.success) {
        if (isOemBlocked(tapResult.output)) return oemBlockedResult()
        return errorResult("Failed to tap element to focus: ${tapResult.output.trim()}")
    }
    Thread.sleep(200L)

    // Verify focus: keyboard shown (editable fields) or focused attribute in UI tree
    var focusConfirmed = false

    val imeCheck = execShell("dumpsys input_method | grep -m1 'mInputShown'")
    if (imeCheck.success && imeCheck.output.contains("mInputShown=true")) {
        focusConfirmed = true
    }

    if (!focusConfirmed) {
        val xml = dumpUiTree(lastDumpDepth)
        if (xml != null) {
            val freshElements = parseUiElements(xml, concise = cachedConciseMode)
            cachedElements = freshElements
            cachedGeneration++
            focusConfirmed = freshElements.any { it.focused && it.editable }
        }
    }

    // Retry tap once if focus not confirmed
    if (!focusConfirmed) {
        val retapResult = execShellArgs(arrayOf("input", "tap", "$cx", "$cy"))
        if (retapResult.success) {
            Thread.sleep(200L)
            val imeRecheck = execShell("dumpsys input_method | grep -m1 'mInputShown'")
            focusConfirmed = imeRecheck.success && imeRecheck.output.contains("mInputShown=true")
        }
        if (!focusConfirmed) {
            // SCN-016: Return hard error — continuing would inject text into wrong app
            return errorResult(
                "Target element lost focus after retry — app may have crashed or navigated away",
                "APP_FOCUS_LOST",
            )
        }
    }

    if (clearFirst) {
        val selectAll = execShell("input keycombination 113 29")
        if (selectAll.success) {
            Thread.sleep(50)
            execShellArgs(arrayOf("input", "keyevent", "67"))
            Thread.sleep(50)
        }
    }

    val typeResult = handleScreenTypeText(buildJsonObject {
        put("text", text)
        if (isStealthActive(params)) put("stealth", true)
    }, skipCacheInvalidation = true)
    return if (typeResult.json["success"]?.jsonPrimitive?.booleanOrNull == true) {
        invalidateUiCache()
        val typeWarning = try {
            typeResult.json["data"]?.jsonObject?.get("warning")?.jsonPrimitive?.contentOrNull
        } catch (_: Exception) { null }
        ActionResult(buildJsonObject {
            put("success", true)
            put("data", buildJsonObject {
                put("typed_in_index", index)
                put("typed_chars_count", text.length)
                put("element_class", element.className)
                if (isStealthActive(params)) put("stealth_mode", true)
                if (typeWarning != null) put("warning", typeWarning)
            })
        })
    } else {
        typeResult
    }
}

// ---------------------------------------------------------------------------
// Wait for element
// ---------------------------------------------------------------------------

private fun handleScreenWaitForElement(params: JsonObject): ActionResult {
    val text = params["text"]?.jsonPrimitive?.contentOrNull
        ?: return errorResult("Missing 'text' parameter")
    val timeout = params["timeout_ms"]?.jsonPrimitive?.intOrNull ?: 10000
    if (timeout < 0 || timeout > MAX_WAIT_TIMEOUT_MS) return errorResult("Invalid 'timeout_ms': $timeout (must be 0..$MAX_WAIT_TIMEOUT_MS)")
    val partial = params["partial"]?.jsonPrimitive?.booleanOrNull ?: true
    val startTime = System.currentTimeMillis()
    // Dynamic polling: 300ms for first 3s, then 1000ms
    val fastInterval = 300L
    val slowInterval = 1000L
    val fastPhaseMs = 3000L

    var elapsed = 0L
    while (elapsed < timeout) {
        val xml = dumpUiTree(15)
        if (xml != null) {
            val elements = parseUiElements(xml, concise = cachedConciseMode)
            cachedElements = elements
            cachedGeneration++

            val match = elements.find { el ->
                val haystack = listOf(el.text, el.contentDesc, el.resourceId)
                if (partial) haystack.any { it.contains(text, ignoreCase = true) }
                else haystack.any { it.equals(text, ignoreCase = true) }
            }

            if (match != null) {
                val actualWait = System.currentTimeMillis() - startTime
                return successResult(buildJsonObject {
                    put("found", true)
                    put("wait_ms", actualWait)
                    put("element", buildJsonObject {
                        put("index", match.index)
                        put("class", match.className)
                        put("text", match.text)
                        put("content_desc", match.contentDesc)
                        put("resource_id", match.resourceId)
                        put("bounds", "[${match.boundsLeft},${match.boundsTop},${match.boundsRight},${match.boundsBottom}]")
                        val traits = match.buildTraits()
                        if (traits.isNotEmpty()) put("traits", traits.joinToString(","))
                    })
                })
            }
        }

        val interval = if (elapsed < fastPhaseMs) fastInterval else slowInterval
        if (elapsed + interval >= timeout) break
        Thread.sleep(interval)
        elapsed += interval
    }

    return successResult(buildJsonObject {
        put("found", false)
        put("wait_ms", System.currentTimeMillis() - startTime)
    })
}

// ---------------------------------------------------------------------------
// App management
// ---------------------------------------------------------------------------

private fun handleScreenLaunchApp(params: JsonObject): ActionResult {
    val pkg = params["package_name"]?.jsonPrimitive?.contentOrNull
        ?: return errorResult("Missing 'package_name'")
    if (!PACKAGE_NAME_RE.matches(pkg)) return errorResult("Invalid package name")

    val pathCheck = execShellArgs(arrayOf("pm", "path", pkg))
    if (!pathCheck.success || pathCheck.output.isBlank()) {
        return errorResult("Package '$pkg' is not installed", "APP_NOT_INSTALLED")
    }

    val tier1 = execShellArgs(arrayOf("monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"))
    if (!tier1.success) {
        // INF-020: Quote subshell output to prevent word-splitting on OEM activity names with spaces
        val tier2 = execShell("am start -n \"\$(cmd package resolve-activity --brief ${shellEscape(pkg)} | tail -1)\" 2>/dev/null")
        if (!tier2.success) {
            val tier3 = execShellArgs(arrayOf("am", "start", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", pkg))
            if (!tier3.success) {
                return errorResult("Failed to launch $pkg after 3 fallback tiers: ${tier3.output}")
            }
        }
    }

    // Poll foreground activity to confirm app actually reached foreground
    val launchStart = System.currentTimeMillis()
    val maxLaunchWaitMs = 3000L
    val launchPollInterval = 300L
    var appInForeground = false

    while (System.currentTimeMillis() - launchStart < maxLaunchWaitMs) {
        val actCheck = execShell("dumpsys activity activities | grep -m1 mResumedActivity")
        if (actCheck.success && actCheck.output.contains("$pkg/")) {
            appInForeground = true
            break
        }
        Thread.sleep(launchPollInterval)
    }

    val launchWaitMs = System.currentTimeMillis() - launchStart
    invalidateUiCache()
    return successResult(buildJsonObject {
        put("package_name", pkg)
        put("wait_ms", launchWaitMs)
        if (!appInForeground) put("warning", "app_not_in_foreground_after_${maxLaunchWaitMs}ms")
    })
}

private fun handleForceStopApp(params: JsonObject): ActionResult {
    val pkg = params["package_name"]?.jsonPrimitive?.contentOrNull
        ?: return errorResult("Missing 'package_name'")
    if (!PACKAGE_NAME_RE.matches(pkg)) return errorResult("Invalid package name")

    val pathCheck = execShellArgs(arrayOf("pm", "path", pkg))
    if (!pathCheck.success || pathCheck.output.isBlank()) {
        return errorResult("Package '$pkg' is not installed", "APP_NOT_FOUND")
    }

    val pidCheck = execShellArgs(arrayOf("pidof", pkg))
    val wasRunning = pidCheck.success && pidCheck.output.trim().isNotEmpty()

    val result = execShellArgs(arrayOf("am", "force-stop", pkg))
    if (!result.success) {
        return errorResult("Failed to force-stop $pkg: ${result.output}")
    }

    invalidateUiCache()
    return successResult(buildJsonObject {
        put("package_name", pkg)
        put("was_running", wasRunning)
    })
}

// ---------------------------------------------------------------------------
// System settings
// ---------------------------------------------------------------------------

private fun handleSetSystemSetting(params: JsonObject): ActionResult {
    val ns = params["namespace"]?.jsonPrimitive?.contentOrNull
        ?: return errorResult("Missing 'namespace'")
    val key = params["key"]?.jsonPrimitive?.contentOrNull
        ?: return errorResult("Missing 'key'")
    val value = params["value"]?.jsonPrimitive?.contentOrNull
        ?: return errorResult("Missing 'value'")

    if (ns !in SETTING_NS_ALLOW) return errorResult("Invalid namespace: $ns")
    if (!SETTING_KEY_RE.matches(key)) return errorResult("Invalid setting key")
    if (!SETTINGS_VALUE_RE.matches(value)) return errorResult("Invalid settings value (must be printable ASCII, max 256 chars)")

    // S51/S53: `settings put global wifi_on` deprecated on Android 10+; use svc wifi
    if (key == "wifi_on" && ns == "global") {
        val cmd = if (value == "1") "svc wifi enable" else "svc wifi disable"
        val svcResult = execShell(cmd)
        if (svcResult.success) {
            return successResult(buildJsonObject {
                put("key", key)
                put("value", value)
                put("method", "svc_wifi")
            })
        }
        log("svc wifi failed (${svcResult.output.trim()}), falling back to settings put")
    }

    // S52: airplane_mode_on needs broadcast on Android 9+; write setting + cmd connectivity
    if (key == "airplane_mode_on" && ns == "global") {
        val settingsResult = execShellArgs(arrayOf("settings", "put", ns, key, value))
        if (!settingsResult.success) return errorResult("Failed to set $key: ${settingsResult.output.trim()}")
        val airplaneCmd = if (value == "1") "cmd connectivity airplane-mode enable" else "cmd connectivity airplane-mode disable"
        val cmdResult = execShell(airplaneCmd)
        return successResult(buildJsonObject {
            put("key", key)
            put("value", value)
            if (!cmdResult.success) put("warning", "settings_written_but_may_not_take_effect_on_android9_plus_without_broadcast")
        })
    }

    return shellActionResult(arrayOf("settings", "put", ns, key, value))
}

private fun handleGetSystemSetting(params: JsonObject): ActionResult {
    val ns = params["namespace"]?.jsonPrimitive?.contentOrNull
        ?: return errorResult("Missing 'namespace'")
    val key = params["key"]?.jsonPrimitive?.contentOrNull
        ?: return errorResult("Missing 'key'")

    if (ns !in SETTING_NS_ALLOW) return errorResult("Invalid namespace: $ns")
    if (!SETTING_KEY_RE.matches(key)) return errorResult("Invalid setting key")

    val result = execShellArgs(arrayOf("settings", "get", ns, key))
    return successResult(buildJsonObject {
        put("namespace", ns)
        put("key", key)
        put("value", result.output.trim())
    })
}

// ---------------------------------------------------------------------------
// Stealth mode toggle
// ---------------------------------------------------------------------------

private fun handleSetStealthMode(params: JsonObject): ActionResult {
    val enabled = params["enabled"]?.jsonPrimitive?.booleanOrNull
        ?: return errorResult("Missing 'enabled' parameter (boolean)")
    stealthEnabled = enabled
    log("Stealth mode ${if (enabled) "enabled" else "disabled"}")
    return successResult(buildJsonObject {
        put("stealth_enabled", enabled)
    })
}

// ---------------------------------------------------------------------------
// Intent launching
// ---------------------------------------------------------------------------

private val INTENT_ACTION_WHITELIST = setOf(
    "android.intent.action.SEND",
    "android.intent.action.VIEW",
    "android.intent.action.SENDTO",
    "android.intent.action.SEND_MULTIPLE",
    "android.intent.action.DIAL",
    "android.intent.action.EDIT",
    "android.intent.action.PICK",
    "android.intent.action.GET_CONTENT",
    "android.intent.action.INSERT",
    "android.intent.action.MAIN",
    "android.intent.action.SEARCH",
    "android.intent.action.WEB_SEARCH",
    "android.intent.action.OPEN_DOCUMENT",
    "android.intent.action.CREATE_DOCUMENT",
    "android.media.action.IMAGE_CAPTURE",
    "android.media.action.VIDEO_CAPTURE",
    "android.settings.SETTINGS",
    "android.settings.WIFI_SETTINGS",
    "android.settings.BLUETOOTH_SETTINGS",
    "android.settings.AIRPLANE_MODE_SETTINGS",
    "android.settings.DISPLAY_SETTINGS",
    "android.settings.SOUND_SETTINGS",
    "android.settings.LOCATION_SOURCE_SETTINGS",
    "android.settings.APPLICATION_DETAILS_SETTINGS",
    "android.settings.DATE_SETTINGS",
    "android.settings.LOCALE_SETTINGS",
    "android.settings.INPUT_METHOD_SETTINGS",
    "android.settings.ACCESSIBILITY_SETTINGS",
    "android.settings.SECURITY_SETTINGS",
    "android.settings.PRIVACY_SETTINGS",
    "android.settings.NFC_SETTINGS",
    "android.settings.BATTERY_SAVER_SETTINGS",
    "android.settings.DATA_USAGE_SETTINGS",
    "android.settings.MANAGE_ALL_APPLICATIONS_SETTINGS",
    "android.settings.NOTIFICATION_LISTENER_SETTINGS",
)

private val TARGET_PACKAGE_RE = Regex("^[a-zA-Z][a-zA-Z0-9_.]{0,200}$")

private fun handleLaunchWithIntent(params: JsonObject): ActionResult {
    val intentAction = params["action"]?.jsonPrimitive?.contentOrNull?.trim()
        ?: return errorResult("Missing required parameter 'action'", "MISSING_PARAM")

    if (intentAction !in INTENT_ACTION_WHITELIST) {
        return errorResult(
            "Intent action '$intentAction' is not in the allowed whitelist",
            "INTENT_ACTION_NOT_ALLOWED",
        )
    }

    val dataUri = params["data_uri"]?.jsonPrimitive?.contentOrNull?.trim()
    val mimeType = params["mime_type"]?.jsonPrimitive?.contentOrNull?.trim()
    val targetPackage = params["target_package"]?.jsonPrimitive?.contentOrNull?.trim()
    val extras = params["extras"]?.let {
        try { it.jsonObject } catch (_: Exception) { null }
    }

    if (targetPackage != null && !TARGET_PACKAGE_RE.matches(targetPackage)) {
        return errorResult(
            "Invalid target_package format: '$targetPackage'",
            "INVALID_PACKAGE",
        )
    }

    val cmdParts = mutableListOf("am", "start", "-a", intentAction)

    if (!dataUri.isNullOrEmpty()) {
        cmdParts += listOf("-d", dataUri)
    }
    if (!mimeType.isNullOrEmpty()) {
        cmdParts += listOf("-t", mimeType)
    }
    if (!targetPackage.isNullOrEmpty()) {
        cmdParts += listOf("-p", targetPackage)
    }

    if (extras != null) {
        for ((key, value) in extras) {
            val prim = try { value.jsonPrimitive } catch (_: Exception) { continue }
            val strVal = prim.contentOrNull ?: ""
            when {
                prim.booleanOrNull != null -> {
                    cmdParts += listOf("--ez", key, prim.booleanOrNull.toString())
                }
                prim.intOrNull != null -> {
                    cmdParts += listOf("--ei", key, prim.intOrNull.toString())
                }
                strVal.startsWith("content://") || strVal.startsWith("file://") -> {
                    cmdParts += listOf("--eu", key, strVal)
                }
                else -> {
                    cmdParts += listOf("--es", key, strVal)
                }
            }
        }
    }

    log("launch_with_intent: ${cmdParts.joinToString(" ")}")
    val result = execShellArgs(cmdParts.toTypedArray())

    if (!result.success) {
        if (isOemBlocked(result.output)) return oemBlockedResult()
        return errorResult("am start failed: ${result.output.trim()}", "INTENT_LAUNCH_FAILED")
    }

    return successResult(buildJsonObject {
        put("launched_intent", buildJsonObject {
            put("action", intentAction)
            if (!dataUri.isNullOrEmpty()) put("data_uri", dataUri)
            if (!mimeType.isNullOrEmpty()) put("mime_type", mimeType)
            if (!targetPackage.isNullOrEmpty()) put("target_package", targetPackage)
        })
    })
}

// ---------------------------------------------------------------------------
// File download / save to device
// ---------------------------------------------------------------------------

private val HTTPS_URL_RE = Regex("^https://\\S+$")
private val FILENAME_SANITIZE_RE = Regex("[^a-zA-Z0-9._\\-]")

private fun handleSaveToDevice(params: JsonObject): ActionResult {
    val url = params["url"]?.jsonPrimitive?.contentOrNull?.trim()
        ?: return errorResult("Missing required parameter 'url'", "MISSING_PARAM")

    if (!HTTPS_URL_RE.matches(url)) {
        return errorResult("URL must start with https:// and contain no whitespace", "INVALID_URL")
    }

    val saveTo = params["save_to"]?.jsonPrimitive?.contentOrNull?.trim()?.lowercase() ?: "gallery"
    val baseDir = when (saveTo) {
        "downloads" -> "/sdcard/Download"
        else -> "/sdcard/DCIM/TabTin"
    }

    val rawFilename = params["filename"]?.jsonPrimitive?.contentOrNull?.trim()
    val filename = if (rawFilename.isNullOrEmpty()) {
        val urlPath = url.substringBefore("?").substringAfterLast("/")
        if (urlPath.isNotEmpty() && urlPath.contains(".")) urlPath else "file_${System.currentTimeMillis()}"
    } else {
        rawFilename
    }
    val sanitizedFilename = FILENAME_SANITIZE_RE.replace(filename, "_")

    val mkdirResult = execShellArgs(arrayOf("mkdir", "-p", baseDir))
    if (!mkdirResult.success) {
        return errorResult("Failed to create directory $baseDir: ${mkdirResult.output.trim()}", "MKDIR_FAILED")
    }

    val localPath = "$baseDir/$sanitizedFilename"
    log("save_to_device: downloading $url -> $localPath")

    val curlResult = execShell("curl -sL -o ${shellEscape(localPath)} --max-time 60 ${shellEscape(url)}")
    if (!curlResult.success) {
        if (isOemBlocked(curlResult.output)) return oemBlockedResult()
        return errorResult("Download failed: ${curlResult.output.trim()}", "DOWNLOAD_FAILED")
    }

    val fileCheck = execShellArgs(arrayOf("ls", "-la", localPath))
    if (!fileCheck.success || fileCheck.output.isBlank()) {
        return errorResult("Download appeared to succeed but file not found at $localPath", "FILE_NOT_FOUND")
    }

    val scanResult = execShell(
        "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${shellEscape(localPath)}",
    )
    val contentUri = if (scanResult.success) {
        val output = scanResult.output.trim()
        val uriMatch = Regex("data=(content://\\S+)").find(output)
        uriMatch?.groupValues?.get(1)
    } else null

    return successResult(buildJsonObject {
        put("local_path", localPath)
        put("saved_path", localPath)
        if (contentUri != null) put("content_uri", contentUri)
        put("save_to", saveTo)
        put("filename", sanitizedFilename)
    })
}

// ---------------------------------------------------------------------------
// Shell helpers (injection-safe)
// ---------------------------------------------------------------------------

private data class ShellResult(val success: Boolean, val output: String)

private fun shellEscape(input: String): String {
    return "'" + input.replace("'", "'\\''") + "'"
}

private fun execShellArgs(args: Array<String>): ShellResult {
    val process: Process
    try {
        process = Runtime.getRuntime().exec(args)
    } catch (e: Exception) {
        return ShellResult(false, "exec error: ${e.message}")
    }
    try {
        // INF-021: Move stdout read into Future so it respects the timeout
        // (previously readText() blocked the calling thread indefinitely)
        val stdoutFuture = shellExecutor.submit<String> {
            process.inputStream.bufferedReader().readText()
        }
        val stderrFuture = shellExecutor.submit<String> {
            process.errorStream.bufferedReader().readText()
        }
        val stdout = try {
            stdoutFuture.get(SHELL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        } catch (_: Exception) {
            stdoutFuture.cancel(true)
            // INF-052: Cancel stderr future on timeout
            stderrFuture.cancel(true)
            return ShellResult(false, "Command timed out after ${SHELL_TIMEOUT_SECONDS}s")
        }
        if (!process.waitFor(5, TimeUnit.SECONDS)) {
            stderrFuture.cancel(true)
            return ShellResult(false, "Process exit timed out after ${SHELL_TIMEOUT_SECONDS}s")
        }
        val stderr = try { stderrFuture.get(2, TimeUnit.SECONDS) } catch (_: Exception) { "" }
        val exitCode = process.exitValue()
        return ShellResult(exitCode == 0, if (exitCode == 0) stdout else stderr.ifBlank { stdout })
    } catch (e: Exception) {
        return ShellResult(false, "exec error: ${e.message}")
    } finally {
        // INF-043: Guarantee process cleanup on every exit path
        process.destroyForcibly()
    }
}

private fun execShell(command: String): ShellResult {
    return execShellArgs(arrayOf("sh", "-c", command))
}

private fun shellActionResult(args: Array<String>): ActionResult {
    val result = execShellArgs(args)
    if (!result.success && isOemBlocked(result.output)) return oemBlockedResult()
    return ActionResult(buildJsonObject {
        put("success", result.success)
        if (!result.success) put("error", result.output.trim())
    })
}

private fun isOemBlocked(output: String): Boolean =
    OEM_BLOCKED_KEYWORDS.any { output.contains(it, ignoreCase = true) }

private fun oemBlockedResult(): ActionResult = errorResult(
    "命令被系统安全策略拦截，请检查设备安全设置（如小米需开启「USB调试(安全设置)」）",
    "OEM_BLOCKED",
)

private fun errorResult(message: String, errorCode: String? = null) = ActionResult(buildJsonObject {
    put("success", false)
    put("error", message)
    if (errorCode != null) put("error_code", errorCode)
})

private fun successResult(data: JsonObject) = ActionResult(buildJsonObject {
    put("success", true)
    put("data", data)
})

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

private fun sendResponse(output: OutputStream, result: ActionResult, requestId: String?) {
    val json = if (requestId != null) {
        buildJsonObject {
            result.json.forEach { (k, v) -> put(k, v) }
            put("id", requestId)
        }
    } else {
        result.json
    }

    sendJsonResponse(output, json)

    if (result.binaryData != null) {
        FrameProtocol.writeFrame(output, FrameProtocol.TYPE_BINARY, result.binaryData)
    }
}

private fun sendJsonResponse(output: OutputStream, json: JsonObject) {
    FrameProtocol.writeFrame(output, FrameProtocol.TYPE_JSON, json.toString().toByteArray())
}

private fun sendError(output: OutputStream, message: String) {
    sendJsonResponse(output, buildJsonObject {
        put("success", false)
        put("error", message)
    })
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

private fun log(message: String) {
    System.err.println("[$TAG] $message")
}
