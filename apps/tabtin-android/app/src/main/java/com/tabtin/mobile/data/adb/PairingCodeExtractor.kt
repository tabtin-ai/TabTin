package com.tabtin.mobile.data.adb

import android.util.Log
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import javax.inject.Inject
import javax.inject.Singleton

public data class PairingInfo(
    val code: String,
    val port: Int,
)

/**
 * Extracts ADB wireless debugging pairing code from system notifications.
 *
 * When the user taps "Pair device with pairing code" in Developer Options > Wireless Debugging,
 * Android posts a notification from com.android.settings containing the 6-digit code and port.
 *
 * Example notification text patterns:
 * - "Wi-Fi pairing code: 123456" / "Port: 37000"
 * - "Pairing code: 123456\nIP address & Port: 192.168.1.x:37000"
 * - "配对码：123456"  (Chinese)
 */
@Singleton
public class PairingCodeExtractor @Inject constructor() {

    public companion object {
        private const val TAG = "PairingCodeExtractor"
        private const val CACHE_TTL_MS = 10_000L

        private val SETTINGS_PACKAGES = setOf(
            "com.android.settings",
            "com.android.systemui",
            "com.miui.securitycenter",
            "com.coloros.safecenter",
            "com.oplus.safecenter",
            "com.samsung.android.app.aasaservice",
            "com.motorola.settings",
            "com.vivo.securitycenter",
            "com.hihonor.systemsettings",
            "com.realme.safety",
        )

        private val STRICT_CODE_PATTERN =
            Regex("""(?:pairing\s*code|配对码|페어링\s*코드|ペアリング\s*コード)[:\s：]+(\d{6})""", RegexOption.IGNORE_CASE)

        private val FALLBACK_CODE_PATTERN = Regex("""\b(\d{6})\b""")

        private val PORT_PATTERNS = listOf(
            Regex("""(?:port|端口|포트|ポート)[:\s：]+(\d{4,5})""", RegexOption.IGNORE_CASE),
            Regex("""\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:(\d{4,5})"""),
        )

        private val STRICT_PAIRING_KEYWORDS = listOf(
            "pairing code", "pair code", "配对码", "페어링 코드", "ペアリング コード",
        )
    }

    private val _pairingDetected = MutableSharedFlow<PairingInfo>(extraBufferCapacity = 1)
    public val pairingDetected: SharedFlow<PairingInfo> = _pairingDetected

    @Volatile private var cachedCode: String? = null
    @Volatile private var cachedPort: Int? = null
    @Volatile private var codeCacheTime: Long = 0L
    @Volatile private var portCacheTime: Long = 0L

    public fun tryExtract(packageName: String, title: String?, text: String?, bigText: String? = null): Boolean {
        if (packageName !in SETTINGS_PACKAGES) return false

        val combined = buildString {
            title?.let { append(it); append(" ") }
            text?.let { append(it); append(" ") }
            bigText?.let { append(" "); append(it) }
        }

        if (combined.isBlank()) return false

        val hasPairingKeyword = combined.contains("pairing", ignoreCase = true) ||
            combined.contains("配对") ||
            combined.contains("페어링") ||
            combined.contains("ペアリング")

        if (!hasPairingKeyword) return false

        val hasStrictKeyword = STRICT_PAIRING_KEYWORDS.any {
            combined.contains(it, ignoreCase = true)
        }

        val now = System.currentTimeMillis()
        val freshCode = extractCode(combined, allowFallback = hasStrictKeyword)
        val freshPort = extractPort(combined)

        if (freshCode != null) { cachedCode = freshCode; codeCacheTime = now }
        if (freshPort != null) { cachedPort = freshPort; portCacheTime = now }

        val code = freshCode ?: cachedCode?.takeIf { now - codeCacheTime < CACHE_TTL_MS }
        val port = freshPort ?: cachedPort?.takeIf { now - portCacheTime < CACHE_TTL_MS }

        if (code != null && port != null) {
            val info = PairingInfo(code, port)
            Log.i(TAG, "Extracted pairing info: code=****${code.takeLast(2)}, port=$port")
            _pairingDetected.tryEmit(info)
            cachedCode = null
            cachedPort = null
            return true
        }

        if (freshCode != null || freshPort != null) {
            Log.d(TAG, "Partial pairing data cached (code=${freshCode != null}, port=${freshPort != null})")
        }
        return false
    }

    private fun extractCode(text: String, allowFallback: Boolean = true): String? {
        STRICT_CODE_PATTERN.find(text)?.let { match ->
            val code = match.groupValues[1]
            if (code.length == 6 && code.all { it.isDigit() }) return code
        }
        if (allowFallback) {
            FALLBACK_CODE_PATTERN.find(text)?.let { match ->
                val code = match.groupValues[1]
                if (code.length == 6 && code.all { it.isDigit() }) return code
            }
        }
        return null
    }

    private fun extractPort(text: String): Int? {
        for (pattern in PORT_PATTERNS) {
            val match = pattern.find(text)
            if (match != null) {
                val port = match.groupValues[1].toIntOrNull()
                if (port != null && port in 1024..65535) return port
            }
        }
        return null
    }
}
