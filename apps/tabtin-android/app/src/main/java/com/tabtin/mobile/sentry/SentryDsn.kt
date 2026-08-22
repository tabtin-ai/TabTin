package com.tabtin.mobile.sentry

import java.net.URI

internal object SentryDsn {
    fun normalize(raw: String): String = raw.trim()

    fun isValid(raw: String): Boolean {
        val value = normalize(raw)
        if (value.isEmpty()) return true
        val uri = runCatching { URI(value) }.getOrNull() ?: return false
        val scheme = uri.scheme?.lowercase()
        return scheme in setOf("http", "https") &&
            !uri.host.isNullOrBlank() &&
            !uri.userInfo.isNullOrBlank()
    }
}
