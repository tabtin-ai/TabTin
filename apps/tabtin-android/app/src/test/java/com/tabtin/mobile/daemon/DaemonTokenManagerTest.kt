package com.tabtin.mobile.daemon

import com.tabtin.mobile.util.TokenManager
import org.junit.Assert.*
import org.junit.Test

/**
 * AD-001-B 回归测试：验证 daemon 模式下 Token 过期判定逻辑。
 *
 * daemon 模式的 setDaemonCredentials 将 expiresAt 设为 0L，
 * 此时 isLoggedIn 应返回 true（过期时间未知视为有效），
 * 但 hasExpiredButRefreshableSession 应返回 false（无 refresh_token）。
 */
class DaemonTokenManagerTest {

    @Test
    fun `daemon credentials with expiresAt=0 is treated as logged in`() {
        val accessToken = "daemon_jwt_token"
        val expiresAt = 0L

        assertTrue(
            "expiresAt=0L (unknown expiry) should be treated as logged in",
            TokenManager.computeIsLoggedIn(accessToken, expiresAt),
        )
    }

    @Test
    fun `daemon mode has no refreshable session since no refresh token`() {
        val accessToken = "daemon_jwt_token"
        val expiresAt = 0L
        val refreshToken: String? = null

        assertFalse(
            "Daemon mode has no refresh token, should not be refreshable",
            TokenManager.computeHasExpiredButRefreshableSession(accessToken, expiresAt, refreshToken),
        )
    }

    @Test
    fun `daemon token is considered logged in even without expiry info`() {
        assertTrue(
            TokenManager.computeIsLoggedIn("any_valid_token", 0L),
        )
    }

    @Test
    fun `daemon token with actual future expiry is still logged in`() {
        val futureMs = System.currentTimeMillis() + 3600_000
        assertTrue(
            TokenManager.computeIsLoggedIn("daemon_token", futureMs),
        )
    }

    @Test
    fun `daemon token with actual past expiry is NOT logged in`() {
        val pastMs = System.currentTimeMillis() - 1000
        assertFalse(
            "Even daemon token should be rejected if explicitly expired",
            TokenManager.computeIsLoggedIn("daemon_token", pastMs),
        )
    }
}
