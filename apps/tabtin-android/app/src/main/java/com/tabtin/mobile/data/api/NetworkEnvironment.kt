package com.tabtin.mobile.data.api

import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.util.TokenManager
import java.net.URI

internal data class NetworkEnvironment(
    val apiBaseUrl: String,
    val wsBaseUrl: String,
    val webBaseUrl: String,
    val centrifugoWsUrl: String,
)

@Suppress("UNUSED_PARAMETER")
internal fun resolveEffectiveNetworkEnvironment(
    tokenManager: TokenManager,
    isDebugBuild: Boolean = BuildConfig.DEBUG,
): NetworkEnvironment {
    val buildEnvironment = buildConfigEnvironment()
    if (tokenManager.isDaemonMode) {
        val apiBaseUrl = tokenManager.apiBaseUrl?.takeIf { it.isNotBlank() }
            ?: buildEnvironment.apiBaseUrl
        val daemonEnvironment = environmentFromApiBaseUrl(apiBaseUrl)
        return daemonEnvironment.copy(
            wsBaseUrl = tokenManager.wsBaseUrl?.takeIf { it.isNotBlank() }
                ?: daemonEnvironment.wsBaseUrl,
        )
    }
    val storedApiBaseUrl = tokenManager.debugApiBaseUrl?.takeIf { it.isNotBlank() }
        // `apiBaseUrl` 是旧版 Debug 面板复用的 Daemon key，只作为升级兼容锚点。
        ?: tokenManager.apiBaseUrl?.takeIf { it.isNotBlank() }
    val storedWsBaseUrl = tokenManager.debugWsBaseUrl?.takeIf { it.isNotBlank() }
        ?: tokenManager.wsBaseUrl?.takeIf { it.isNotBlank() }
    val storedWebBaseUrl = tokenManager.webBaseUrl?.takeIf { it.isNotBlank() }
    val storedCentrifugoWsUrl = tokenManager.centrifugoWsUrl?.takeIf { it.isNotBlank() }
    val inferredEnvironment = when (tokenManager.debugEnvironmentPreset) {
        PRESET_PRODUCTION -> productionEnvironment
        PRESET_DEVELOPMENT -> developmentEnvironment
        PRESET_CUSTOM -> tokenManager.debugCustomBaseUrl
            ?.takeIf { it.isNotBlank() }
            ?.let(::environmentFromCustomBaseUrl)
            ?: storedApiBaseUrl?.let(::environmentFromApiBaseUrl)
            ?: storedWsBaseUrl?.let(::environmentFromWsBaseUrl)
            ?: buildEnvironment
        else -> when {
            storedApiBaseUrl != null -> environmentFromApiBaseUrl(storedApiBaseUrl)
            storedWsBaseUrl != null -> environmentFromWsBaseUrl(storedWsBaseUrl)
            else -> buildEnvironment
        }
    }
    // 旧版扫码会把四个端点写入独立 key，但没有新版 advanced 标记。API 只能作为
    // 环境锚点，不能据此覆盖二维码明确携带的 Web / Centrifugo 端口。
    val automaticEnvironment = inferredEnvironment.copy(
        wsBaseUrl = storedWsBaseUrl ?: inferredEnvironment.wsBaseUrl,
        webBaseUrl = storedWebBaseUrl ?: inferredEnvironment.webBaseUrl,
        centrifugoWsUrl = storedCentrifugoWsUrl ?: inferredEnvironment.centrifugoWsUrl,
    )
    val effectiveEnvironment = if (!tokenManager.debugAdvancedEnabled) {
        automaticEnvironment
    } else {
        automaticEnvironment.copy(
            apiBaseUrl = tokenManager.debugAdvancedApiUrl
                ?.takeIf { it.isNotBlank() }
                ?: automaticEnvironment.apiBaseUrl,
            wsBaseUrl = tokenManager.debugAdvancedWsUrl
                ?.takeIf { it.isNotBlank() }
                ?: automaticEnvironment.wsBaseUrl,
            webBaseUrl = tokenManager.debugAdvancedWebUrl
                ?.takeIf { it.isNotBlank() }
                ?: automaticEnvironment.webBaseUrl,
            centrifugoWsUrl = tokenManager.debugAdvancedCentrifugoUrl
                ?.takeIf { it.isNotBlank() }
                ?: automaticEnvironment.centrifugoWsUrl,
        )
    }
    return effectiveEnvironment.repairLocalDevCentrifugoPort()
}

private fun NetworkEnvironment.repairLocalDevCentrifugoPort(): NetworkEnvironment {
    val api = runCatching { URI(apiBaseUrl) }.getOrNull() ?: return this
    val centrifugo = runCatching { URI(centrifugoWsUrl) }.getOrNull() ?: return this
    if (
        api.port != 6060 ||
        centrifugo.port != 6060 ||
        !api.host.equals(centrifugo.host, ignoreCase = true) ||
        !centrifugo.path.endsWith("/connection/websocket")
    ) {
        return this
    }
    val repaired = URI(
        centrifugo.scheme,
        centrifugo.userInfo,
        centrifugo.host,
        8100,
        centrifugo.path,
        centrifugo.query,
        centrifugo.fragment,
    ).toString()
    return copy(centrifugoWsUrl = repaired)
}

internal fun resolveEffectiveApiBaseUrl(
    tokenManager: TokenManager,
    isDebugBuild: Boolean = BuildConfig.DEBUG,
): String = resolveEffectiveNetworkEnvironment(tokenManager, isDebugBuild).apiBaseUrl

internal fun resolveEffectiveWsBaseUrl(
    tokenManager: TokenManager,
    isDebugBuild: Boolean = BuildConfig.DEBUG,
): String = resolveEffectiveNetworkEnvironment(tokenManager, isDebugBuild).wsBaseUrl

internal fun resolveEffectiveWebBaseUrl(
    tokenManager: TokenManager,
    isDebugBuild: Boolean = BuildConfig.DEBUG,
): String = resolveEffectiveNetworkEnvironment(tokenManager, isDebugBuild).webBaseUrl

internal fun resolveEffectiveCentrifugoWsUrl(
    tokenManager: TokenManager,
    isDebugBuild: Boolean = BuildConfig.DEBUG,
): String = resolveEffectiveNetworkEnvironment(tokenManager, isDebugBuild).centrifugoWsUrl

private fun buildConfigEnvironment(): NetworkEnvironment {
    val configured = NetworkEnvironment(
        apiBaseUrl = BuildConfig.API_BASE_URL,
        wsBaseUrl = BuildConfig.WS_BASE_URL,
        webBaseUrl = BuildConfig.WEB_BASE_URL,
        centrifugoWsUrl = BuildConfig.CENTRIFUGO_WS_URL,
    )
    return when (runCatching { URI(configured.apiBaseUrl).host?.lowercase() }.getOrNull()) {
        PRODUCTION_API_HOST -> productionEnvironment
        DEVELOPMENT_API_HOST -> developmentEnvironment
        else -> configured
    }
}

private fun environmentFromCustomBaseUrl(baseUrl: String): NetworkEnvironment =
    environmentFromApiBaseUrl("${baseUrl.trimEnd('/')}/api")

private fun environmentFromWsBaseUrl(wsBaseUrl: String): NetworkEnvironment {
    val normalizedWsBaseUrl = wsBaseUrl.trimEnd('/')
    val uri = runCatching { URI(normalizedWsBaseUrl) }.getOrNull()
        ?: return buildConfigEnvironment().copy(wsBaseUrl = normalizedWsBaseUrl)
    val scheme = uri.scheme?.lowercase()
    val authority = uri.rawAuthority
    if (scheme !in setOf("ws", "wss") || authority.isNullOrBlank()) {
        return buildConfigEnvironment().copy(wsBaseUrl = normalizedWsBaseUrl)
    }
    return when (uri.host?.lowercase()) {
        PRODUCTION_API_HOST -> productionEnvironment
        DEVELOPMENT_API_HOST -> developmentEnvironment
        else -> {
            val basePath = uri.rawPath.orEmpty().removeSuffix("/ws/v1/gateway").trimEnd('/')
            val httpScheme = if (scheme == "wss") "https" else "http"
            val httpBaseUrl = "$httpScheme://$authority$basePath"
            NetworkEnvironment(
                apiBaseUrl = "$httpBaseUrl/api",
                wsBaseUrl = normalizedWsBaseUrl,
                webBaseUrl = httpBaseUrl,
                centrifugoWsUrl = "$scheme://$authority$basePath/connection/websocket",
            )
        }
    }
}

private fun environmentFromApiBaseUrl(apiBaseUrl: String): NetworkEnvironment {
    val normalizedApiBaseUrl = apiBaseUrl.trimEnd('/')
    val uri = runCatching { URI(normalizedApiBaseUrl) }.getOrNull()
        ?: return buildConfigEnvironment().copy(apiBaseUrl = normalizedApiBaseUrl)
    val scheme = uri.scheme?.lowercase()
    val authority = uri.rawAuthority
    if (scheme !in setOf("http", "https") || authority.isNullOrBlank()) {
        return buildConfigEnvironment().copy(apiBaseUrl = normalizedApiBaseUrl)
    }
    val basePath = uri.rawPath.orEmpty().removeSuffix("/api").trimEnd('/')
    val httpBaseUrl = "$scheme://$authority$basePath"
    val wsBaseUrl = httpBaseUrl.replaceFirst(
        "$scheme://",
        if (scheme == "https") "wss://" else "ws://",
    )
    return when (uri.host?.lowercase()) {
        PRODUCTION_API_HOST -> productionEnvironment
        DEVELOPMENT_API_HOST -> developmentEnvironment
        else -> NetworkEnvironment(
            apiBaseUrl = normalizedApiBaseUrl,
            wsBaseUrl = "$wsBaseUrl/ws/v1/gateway",
            webBaseUrl = httpBaseUrl,
            centrifugoWsUrl = "$wsBaseUrl/connection/websocket",
        )
    }
}

private const val PRESET_PRODUCTION = "production"
private const val PRESET_DEVELOPMENT = "development"
private const val PRESET_CUSTOM = "custom"
private const val PRODUCTION_API_HOST = "api.example.com"
private const val DEVELOPMENT_API_HOST = "api-test.example.com"

private val productionEnvironment = NetworkEnvironment(
    apiBaseUrl = "https://api.example.com/api",
    wsBaseUrl = "wss://api.example.com/ws/v1/gateway",
    webBaseUrl = "https://web.example.com",
    centrifugoWsUrl = "wss://centrifugo.example.com/connection/websocket",
)

private val developmentEnvironment = NetworkEnvironment(
    apiBaseUrl = "https://api-test.example.com/api",
    wsBaseUrl = "wss://api-test.example.com/ws/v1/gateway",
    webBaseUrl = "https://web-test.example.com",
    centrifugoWsUrl = "wss://centrifugo-test.example.com/connection/websocket",
)
