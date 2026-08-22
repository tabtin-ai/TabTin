package com.tabtin.mobile.features.auth

import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ActionLabel
import com.tabtin.mobile.data.model.AppError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LoginPhoneNumberTest {
    @Test
    fun `normalizes country code and grouped phone suggestion`() {
        assertEquals("13800138000", LoginPhoneNumber.editingValue("+86 138 0013 8000"))
        assertEquals("13800138000", LoginPhoneNumber.normalized("+86 138 0013 8000"))
    }

    @Test
    fun `normalizes grouped local phone and rejects non mobile number`() {
        assertEquals("13800138000", LoginPhoneNumber.normalized("138 0013 8000"))
        assertNull(LoginPhoneNumber.normalized("+86 10 1234 5678"))
    }

    @Test
    fun `editing value caps local phone at eleven digits`() {
        assertEquals("13800138000", LoginPhoneNumber.editingValue("138001380001234"))
    }

    @Test
    fun `verification code editing value keeps six digits at most`() {
        assertEquals("123456", LoginVerificationCode.editingValue("12 34a56789"))
    }

    @Test
    fun `email login switch only treats lowercase false as off`() {
        assertEquals(true, LoginPhoneNumber.parseEmailLoginEnabled(null))
        assertEquals(true, LoginPhoneNumber.parseEmailLoginEnabled(""))
        assertEquals(true, LoginPhoneNumber.parseEmailLoginEnabled("true"))
        assertEquals(false, LoginPhoneNumber.parseEmailLoginEnabled("false"))
        assertEquals(false, LoginPhoneNumber.parseEmailLoginEnabled(" FALSE "))
    }

    @Test
    fun `keeps in-progress email letters when email login is enabled`() {
        assertEquals("u", LoginPhoneNumber.editingValue("u", emailLoginEnabled = true))
        assertEquals("user", LoginPhoneNumber.editingValue("user", emailLoginEnabled = true))
        assertEquals("user@", LoginPhoneNumber.editingValue("user@", emailLoginEnabled = true))
        assertEquals(
            "User@Example.com",
            LoginPhoneNumber.editingValue("User@Example.com", emailLoginEnabled = true),
        )
        assertEquals(
            "13800138000",
            LoginPhoneNumber.editingValue("13800138000", emailLoginEnabled = true),
        )
        assertEquals(
            "13800138000",
            LoginPhoneNumber.editingValue("abc13800138000xyz", emailLoginEnabled = false),
        )
    }

    @Test
    fun `normalizes email to lowercase and still accepts mainland mobile`() {
        assertEquals(
            "user@example.com",
            LoginPhoneNumber.normalized("  User@Example.COM ", emailLoginEnabled = true),
        )
        assertEquals(
            "13800138000",
            LoginPhoneNumber.normalized("13800138000", emailLoginEnabled = true),
        )
        assertNull(LoginPhoneNumber.normalized("user@example.com", emailLoginEnabled = false))
        assertNull(LoginPhoneNumber.normalized("user@", emailLoginEnabled = true))
        assertNull(LoginPhoneNumber.normalized("not-an-email", emailLoginEnabled = true))
    }

    @Test
    fun `login errors expose short product copy instead of server detail`() {
        val raw = AppError.ActionFailed(ActionLabel.LOGIN, "[AUTH_INVALID] internal auth detail")

        assertEquals(
            R.string.auth_error_invalid_password,
            LoginErrorPresentation.messageRes(raw, LoginErrorContext.PASSWORD),
        )
        assertEquals(
            R.string.auth_error_invalid_code,
            LoginErrorPresentation.messageRes(raw, LoginErrorContext.VERIFICATION_CODE),
        )
        assertEquals(
            R.string.auth_error_network,
            LoginErrorPresentation.messageRes(
                AppError.NetworkUnavailable,
                LoginErrorContext.PASSWORD,
            ),
        )
        assertEquals(
            R.string.auth_error_send_code,
            LoginErrorPresentation.messageRes(
                AppError.SendCodeFailed("internal provider detail"),
                LoginErrorContext.SEND_CODE,
            ),
        )
        assertEquals(
            R.string.auth_error_login,
            LoginErrorPresentation.messageRes(
                AppError.ActionFailed(ActionLabel.LOGIN, "internal server detail"),
                LoginErrorContext.PASSWORD,
            ),
        )
    }
}
