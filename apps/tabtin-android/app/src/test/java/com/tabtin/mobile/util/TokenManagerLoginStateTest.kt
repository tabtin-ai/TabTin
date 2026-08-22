package com.tabtin.mobile.util

import org.junit.Assert.*
import org.junit.Test

/**
 * SDI-032 回归测试：验证 isLoggedIn 正确检查 token 过期状态，
 * hasExpiredButRefreshableSession 正确标识可刷新的过期会话。
 */
class TokenManagerLoginStateTest {

    @Test
    fun `isLoggedIn returns false when no token`() {
        assertFalse(TokenManager.computeIsLoggedIn(null, 0L))
    }

    @Test
    fun `isLoggedIn returns false when token is blank`() {
        assertFalse(TokenManager.computeIsLoggedIn("", 0L))
        assertFalse(TokenManager.computeIsLoggedIn("  ", 0L))
    }

    @Test
    fun `isLoggedIn returns true when token exists and not expired`() {
        val futureMs = System.currentTimeMillis() + 3600_000
        assertTrue(TokenManager.computeIsLoggedIn("valid-token", futureMs))
    }

    @Test
    fun `isLoggedIn returns true when token exists and expiresAt is unknown`() {
        assertTrue(TokenManager.computeIsLoggedIn("valid-token", 0L))
    }

    @Test
    fun `isLoggedIn returns false when token exists but expired`() {
        val pastMs = System.currentTimeMillis() - 1000
        assertFalse(
            "SDI-032: isLoggedIn must return false for expired tokens",
            TokenManager.computeIsLoggedIn("expired-token", pastMs),
        )
    }

    @Test
    fun `hasExpiredButRefreshableSession true when expired with refresh token`() {
        val pastMs = System.currentTimeMillis() - 1000
        assertTrue(
            TokenManager.computeHasExpiredButRefreshableSession(
                "expired-token", pastMs, "valid-refresh"
            ),
        )
    }

    @Test
    fun `hasExpiredButRefreshableSession false when expired without refresh token`() {
        val pastMs = System.currentTimeMillis() - 1000
        assertFalse(
            TokenManager.computeHasExpiredButRefreshableSession(
                "expired-token", pastMs, null,
            ),
        )
    }

    @Test
    fun `hasExpiredButRefreshableSession false when token is valid`() {
        val futureMs = System.currentTimeMillis() + 3600_000
        assertFalse(
            TokenManager.computeHasExpiredButRefreshableSession(
                "valid-token", futureMs, "valid-refresh",
            ),
        )
    }

    @Test
    fun `hasExpiredButRefreshableSession false when no token`() {
        val pastMs = System.currentTimeMillis() - 1000
        assertFalse(
            TokenManager.computeHasExpiredButRefreshableSession(
                null, pastMs, "valid-refresh",
            ),
        )
    }

    @Test
    fun `hasExpiredButRefreshableSession false when expiresAt unknown`() {
        assertFalse(
            TokenManager.computeHasExpiredButRefreshableSession(
                "token", 0L, "valid-refresh",
            ),
        )
    }
}
