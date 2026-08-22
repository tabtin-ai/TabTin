package com.tabtin.mobile.features.auth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LoginErrorHintSourceTest {
    @Test
    fun `login errors use a visible top hint instead of snackbar`() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/auth/LoginScreen.kt",
        ).readText()

        assertTrue(source.contains("LoginErrorHint("))
        assertTrue(source.contains(".align(Alignment.TopCenter)"))
        assertFalse(source.contains("snackbarHost.showSnackbar"))
    }
}
