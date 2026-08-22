package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.ui.device.MobileFormFactor
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal const val MOBILE_HOST_CONTEXT_EVENT = "tabtin:host-context"

internal fun mobileHostContextJson(formFactor: MobileFormFactor): String = buildJsonObject {
    put("version", 1)
    put("platform", "android")
    put("formFactor", formFactor.wireValue)
    put("capabilities", buildJsonObject {
        put("filePicker", true)
        put("nativeFocus", true)
        put("fullEditor", true)
    })
}.toString()

/**
 * Installs the versioned native-host snapshot only for the trusted workbench origin.
 * Re-dispatching is intentional: every document navigation receives a fresh snapshot.
 */
internal fun mobileHostInjectionScript(
    expectedOrigin: String,
    formFactor: MobileFormFactor,
): String {
    val origin = JsonPrimitive(expectedOrigin).toString()
    val context = mobileHostContextJson(formFactor)
    val eventName = JsonPrimitive(MOBILE_HOST_CONTEXT_EVENT).toString()
    return """
        (() => {
          if (window.location.origin !== $origin) return;
          const context = $context;
          window.__TABTIN_MOBILE_HOST__ = context;
          window.dispatchEvent(new CustomEvent($eventName, { detail: context }));
        })();
    """.trimIndent()
}
