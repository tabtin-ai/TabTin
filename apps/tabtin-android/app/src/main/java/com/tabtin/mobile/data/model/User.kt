package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
public data class LoginRequest(
    val username: String,
    val password: String? = null,
    @SerialName("verification_code") val verificationCode: String? = null,
    @SerialName("remember_me") val rememberMe: Boolean = false,
    @SerialName("challenge_key") val challengeKey: String? = null,
)

@Serializable
public data class SendCodeRequest(
    val username: String,
    @SerialName("code_type") val codeType: String = "login",
    @SerialName("challenge_key") val challengeKey: String? = null,
)

@Serializable
public data class LoginResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String? = null,
    @SerialName("expires_in") val expiresIn: Int? = null,
    val user: UserInfo? = null,
)

@Serializable
public data class UserInfo(
    val id: String,
    val username: String? = null,
    val phone: String? = null,
    val nickname: String? = null,
    val avatar: String? = null,
    val email: String? = null,
    val bio: String? = null,
    @SerialName("is_verified_email") val isVerifiedEmail: Boolean? = null,
    @SerialName("is_verified_phone") val isVerifiedPhone: Boolean? = null,
    @SerialName("login_count") val loginCount: Int? = null,
    @SerialName("date_joined") val dateJoined: String? = null,
    @SerialName("last_login") val lastLogin: String? = null,
    @SerialName("invite_code_required") val inviteCodeRequired: Boolean? = null,
    @SerialName("invite_code_redeemed") val inviteCodeRedeemed: Boolean? = null,
    @SerialName("has_usable_password") val hasUsablePassword: Boolean? = null,
)

/** 已登录但尚未完成邀请码兑换时，客户端必须保持在准入层。 */
public val UserInfo.needsInviteCode: Boolean
    get() = inviteCodeRequired == true && inviteCodeRedeemed != true

/** 仅在服务端明确确认账号没有密码时，默认进入验证码设置流程。 */
public val UserInfo.prefersVerificationPasswordSetup: Boolean
    get() = hasUsablePassword == false

@Serializable
public data class RedeemInviteCodeRequest(
    @SerialName("invite_code") val inviteCode: String,
)

@Serializable
public data class RedeemInviteCodeResponse(
    val user: UserInfo,
)

@Serializable
public data class SendCodeResponse(
    val success: Boolean = true,
    val message: String? = null,
)

@Serializable
public data class PasswordChangeRequest(
    @SerialName("old_password") val oldPassword: String,
    @SerialName("new_password") val newPassword: String,
)

@Serializable
public data class CurrentPasswordResetRequest(
    @SerialName("verification_code") val verificationCode: String,
    @SerialName("new_password") val newPassword: String,
)

@Serializable
public data class RefreshTokenRequest(
    @SerialName("refresh_token") val refreshToken: String,
)

@Serializable
public data class RefreshTokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String? = null,
    @SerialName("token_type") val tokenType: String? = null,
    @SerialName("expires_in") val expiresIn: Int? = null,
)
