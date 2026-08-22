package com.tabtin.mobile.features.profile

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTSpacing
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

internal data class MobileEnvironmentConfiguration(
    val apiUrl: String,
    val websocketUrl: String,
    val webUrl: String,
    val centrifugoUrl: String,
)

internal object MobileEnvironmentQr {
    private const val SCHEME = "tabtin"
    private const val HOST = "mobile-environment"
    private const val SUPPORTED_VERSION = "1"
    private const val MAXIMUM_PAYLOAD_LENGTH = 4_096

    fun parse(rawValue: String): MobileEnvironmentConfiguration? {
        val value = rawValue.trim()
        if (value.length > MAXIMUM_PAYLOAD_LENGTH) return null
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() != SCHEME || uri.host?.lowercase() != HOST) return null
        val parameters = parseQuery(uri.rawQuery ?: return null) ?: return null
        if (parameters["v"] != SUPPORTED_VERSION) return null

        val apiUrl = validUrl(parameters["api"], setOf("http", "https")) ?: return null
        val websocketUrl = validUrl(parameters["ws"], setOf("ws", "wss")) ?: return null
        val webUrl = validUrl(parameters["web"], setOf("http", "https")) ?: return null
        val centrifugoUrl = validUrl(parameters["centrifugo"], setOf("ws", "wss")) ?: return null
        return MobileEnvironmentConfiguration(apiUrl, websocketUrl, webUrl, centrifugoUrl)
    }

    private fun parseQuery(rawQuery: String): Map<String, String>? {
        val values = mutableMapOf<String, String>()
        for (part in rawQuery.split('&')) {
            val separator = part.indexOf('=')
            if (separator <= 0) return null
            val key = decode(part.substring(0, separator)) ?: return null
            val value = decode(part.substring(separator + 1)) ?: return null
            if (values.put(key, value) != null) return null
        }
        return values
    }

    private fun decode(value: String): String? = runCatching {
        URLDecoder.decode(value, StandardCharsets.UTF_8.name())
    }.getOrNull()

    private fun validUrl(rawValue: String?, schemes: Set<String>): String? {
        val value = rawValue?.trim().orEmpty()
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() !in schemes || uri.rawAuthority.isNullOrBlank()) return null
        return value
    }
}

@Composable
internal fun MobileEnvironmentQrScanButton(
    onConfiguration: (MobileEnvironmentConfiguration) -> Unit,
    onInvalidQrCode: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val prompt = stringResource(R.string.settings_debug_scan_qr_prompt)
    val launcher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val rawValue = result.contents ?: return@rememberLauncherForActivityResult
        val configuration = MobileEnvironmentQr.parse(rawValue)
        if (configuration == null) onInvalidQrCode() else onConfiguration(configuration)
    }

    OutlinedButton(
        onClick = {
            launcher.launch(
                ScanOptions()
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt(prompt)
                    .setBeepEnabled(false)
                    .setOrientationLocked(false),
            )
        },
        modifier = modifier.fillMaxWidth(),
    ) {
        Icon(Icons.Default.QrCodeScanner, contentDescription = null)
        Spacer(Modifier.width(TTSpacing.sm))
        Text(stringResource(R.string.settings_debug_scan_qr))
    }
}
