package com.tabtin.mobile.features.profile

import org.junit.Assert.assertEquals
import org.junit.Test

class ChangePasswordInitialModeTest {
    @Test
    fun noPasswordAccountStartsInVerificationSetupMode() {
        assertEquals(ChangePasswordMode.RESET, ChangePasswordMode.initial(hasUsablePassword = false))
    }

    @Test
    fun passwordAndLegacyAccountsKeepCurrentPasswordMode() {
        assertEquals(ChangePasswordMode.CHANGE, ChangePasswordMode.initial(hasUsablePassword = true))
        assertEquals(ChangePasswordMode.CHANGE, ChangePasswordMode.initial(hasUsablePassword = null))
    }
}
