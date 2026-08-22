package com.tabtin.mobile.data.model

import kotlinx.serialization.json.Json
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InviteCodeGateStateTest {
    @Test
    fun needsInviteCodeOnlyWhenServerExplicitlyRequiresAnUnredeemedCode() {
        assertTrue(UserInfo(id = "pending", inviteCodeRequired = true, inviteCodeRedeemed = false).needsInviteCode)
        assertFalse(UserInfo(id = "redeemed", inviteCodeRequired = true, inviteCodeRedeemed = true).needsInviteCode)
        assertFalse(UserInfo(id = "not-required", inviteCodeRequired = false, inviteCodeRedeemed = false).needsInviteCode)
        assertFalse(UserInfo(id = "legacy", inviteCodeRequired = null, inviteCodeRedeemed = null).needsInviteCode)
    }

    @Test
    fun passwordSetupUsesVerificationOnlyWhenServerExplicitlyReportsNoPassword() {
        assertTrue(UserInfo(id = "no-password", hasUsablePassword = false).prefersVerificationPasswordSetup)
        assertFalse(UserInfo(id = "password", hasUsablePassword = true).prefersVerificationPasswordSetup)
        assertFalse(UserInfo(id = "legacy", hasUsablePassword = null).prefersVerificationPasswordSetup)
    }

    @Test
    fun passwordCapabilityDecodesFromAdditiveServerField() {
        val noPassword = Json.decodeFromString<UserInfo>(
            """{"id":"no-password","has_usable_password":false}""",
        )
        val legacy = Json.decodeFromString<UserInfo>("""{"id":"legacy"}""")

        assertTrue(noPassword.prefersVerificationPasswordSetup)
        assertFalse(legacy.prefersVerificationPasswordSetup)
    }
}
