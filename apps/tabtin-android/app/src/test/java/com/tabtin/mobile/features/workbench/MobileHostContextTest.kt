package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.ui.device.MobileFormFactor
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileHostContextTest {

    @Test
    fun `tablet context exposes versioned Android capabilities`() {
        val context = Json.parseToJsonElement(
            mobileHostContextJson(MobileFormFactor.TABLET),
        ).jsonObject

        assertEquals("1", context.getValue("version").jsonPrimitive.content)
        assertEquals("android", context.getValue("platform").jsonPrimitive.content)
        assertEquals("tablet", context.getValue("formFactor").jsonPrimitive.content)
        val capabilities = context.getValue("capabilities").jsonObject
        assertEquals("true", capabilities.getValue("filePicker").jsonPrimitive.content)
        assertEquals("true", capabilities.getValue("nativeFocus").jsonPrimitive.content)
        assertEquals("true", capabilities.getValue("fullEditor").jsonPrimitive.content)
    }

    @Test
    fun `injection is origin scoped and publishes the shared event`() {
        val script = mobileHostInjectionScript(
            expectedOrigin = "https://web.example/path'unsafe",
            formFactor = MobileFormFactor.PHONE,
        )

        assertTrue(script.contains("window.location.origin !== \"https://web.example/path'unsafe\""))
        assertTrue(script.contains("window.__TABTIN_MOBILE_HOST__ = context"))
        assertTrue(script.contains("new CustomEvent(\"tabtin:host-context\""))
        assertTrue(script.contains("\"formFactor\":\"phone\""))
    }
}
