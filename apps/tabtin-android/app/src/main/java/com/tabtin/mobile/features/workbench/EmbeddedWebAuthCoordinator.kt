package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.data.api.AuthEventBus
import com.tabtin.mobile.data.api.TokenRefreshCoordinator
import com.tabtin.mobile.data.api.TokenRefreshResult
import com.tabtin.mobile.util.TokenManager
import org.json.JSONObject
import javax.inject.Inject
import javax.inject.Singleton

internal sealed interface EmbeddedWebCredentialResult {
    data class Ready(val snapshot: WorkbenchWebAuthSnapshot) : EmbeddedWebCredentialResult
    data object Unauthenticated : EmbeddedWebCredentialResult
    data object TemporarilyUnavailable : EmbeddedWebCredentialResult
}

/** Native owner for embedded Web authentication. Refresh tokens never cross
 * the WebView boundary; every host page shares the app's single-flight lock. */
@Singleton
public class EmbeddedWebAuthCoordinator @Inject internal constructor(
    private val tokenManager: TokenManager,
    private val refreshCoordinator: TokenRefreshCoordinator,
) {
    internal fun resolve(forceRefresh: Boolean): EmbeddedWebCredentialResult {
        if (tokenManager.accessToken.isNullOrBlank()) return invalidateSession()

        if (forceRefresh || tokenManager.isAccessTokenExpiringSoon) {
            when (refreshCoordinator.refreshBlockingResult()) {
                is TokenRefreshResult.Success -> Unit
                TokenRefreshResult.Invalid -> return invalidateSession()
                TokenRefreshResult.Conflict,
                TokenRefreshResult.TemporarilyUnavailable -> {
                    if (forceRefresh || !tokenManager.isLoggedIn) {
                        return EmbeddedWebCredentialResult.TemporarilyUnavailable
                    }
                }
            }
        }

        val accessToken = tokenManager.accessToken
            ?.takeIf { it.isNotBlank() }
            ?: return invalidateSession()
        return EmbeddedWebCredentialResult.Ready(
            WorkbenchWebAuthSnapshot(
                accessToken = accessToken,
                expiresAtSeconds = tokenManager.accessTokenExpiresAt
                    .takeIf { it > 0L }
                    ?.div(1000L),
                userJson = buildUserJson(),
            ),
        )
    }

    private fun invalidateSession(): EmbeddedWebCredentialResult {
        tokenManager.clear()
        AuthEventBus.emitLogoutRequired()
        return EmbeddedWebCredentialResult.Unauthenticated
    }

    private fun buildUserJson(): String? {
        val id = tokenManager.userId?.takeIf { it.isNotBlank() } ?: return null
        return JSONObject().apply {
            put("id", id)
            tokenManager.userUsername?.let { put("username", it) }
            tokenManager.userPhone?.let { put("phone", it) }
            tokenManager.userNickname?.let { put("nickname", it) }
            tokenManager.userAvatar?.let { put("avatar", it) }
            tokenManager.userEmail?.let { put("email", it) }
            tokenManager.userBio?.let { put("bio", it) }
            tokenManager.userDateJoined?.let { put("date_joined", it) }
            tokenManager.userLastLogin?.let { put("last_login", it) }
            tokenManager.userLoginCount?.let { put("login_count", it) }
            tokenManager.userIsVerifiedEmail?.let { put("is_verified_email", it) }
            tokenManager.userIsVerifiedPhone?.let { put("is_verified_phone", it) }
        }.toString()
    }
}
