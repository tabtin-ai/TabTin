package com.tabtin.mobile.features.doc

import java.net.URI
import java.net.URISyntaxException

internal object DocLinkActivationPolicy {
    private val allowed = setOf("http", "https", "mailto", "tel")

    internal fun canActivate(href: String): Boolean {
        val scheme = try {
            URI(href.trim()).scheme?.lowercase()
        } catch (_: URISyntaxException) {
            return false
        } ?: return false
        return scheme in allowed
    }
}
