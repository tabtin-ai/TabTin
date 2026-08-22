package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.LoginRequest
import com.tabtin.mobile.data.model.LoginResponse
import com.tabtin.mobile.data.model.CurrentPasswordResetRequest
import com.tabtin.mobile.data.model.PasswordChangeRequest
import com.tabtin.mobile.data.model.RefreshTokenRequest
import com.tabtin.mobile.data.model.RefreshTokenResponse
import com.tabtin.mobile.data.model.RedeemInviteCodeRequest
import com.tabtin.mobile.data.model.RedeemInviteCodeResponse
import com.tabtin.mobile.data.model.SendCodeRequest
import com.tabtin.mobile.data.model.SendCodeResponse
import com.tabtin.mobile.data.model.UserInfo
import com.tabtin.mobile.data.model.UISettingsResponse
import com.tabtin.mobile.data.model.UISettingsUpdateRequest
import retrofit2.Call
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Headers
import retrofit2.http.POST
import retrofit2.http.PUT

public interface AuthApi {
    @POST("auth/login")
    public suspend fun loginWithPassword(@Body body: LoginRequest): ApiEnvelope<LoginResponse>

    @POST("auth/login/verification-code")
    public suspend fun loginWithCode(@Body body: LoginRequest): ApiEnvelope<LoginResponse>

    @POST("auth/send-verification-code")
    public suspend fun sendVerificationCode(@Body body: SendCodeRequest): ApiEnvelope<SendCodeResponse>

    @POST("auth/send-email-verification")
    public suspend fun sendEmailVerification(): ApiEnvelope<SendCodeResponse>

    @POST("auth/send-phone-verification")
    public suspend fun sendPhoneVerification(): ApiEnvelope<SendCodeResponse>

    @POST("auth/change-password")
    public suspend fun changePassword(@Body body: PasswordChangeRequest): ApiEnvelope<SendCodeResponse>

    @POST("auth/send-current-password-reset-code")
    public suspend fun sendCurrentPasswordResetCode(): ApiEnvelope<SendCodeResponse>

    @POST("auth/reset-current-password")
    public suspend fun resetCurrentPassword(@Body body: CurrentPasswordResetRequest): ApiEnvelope<SendCodeResponse>

    @POST("auth/verify-email")
    public suspend fun verifyEmail(@Body body: Map<String, String>): ApiEnvelope<SendCodeResponse>

    @POST("auth/verify-phone")
    public suspend fun verifyPhone(@Body body: Map<String, String>): ApiEnvelope<SendCodeResponse>

    @POST("auth/invite-code/redeem")
    @Headers("X-TabTin-Error-Status: standard")
    public suspend fun redeemInviteCode(
        @Body body: RedeemInviteCodeRequest,
    ): ApiEnvelope<RedeemInviteCodeResponse>

    @GET("auth/profile")
    public suspend fun getProfile(): ApiEnvelope<UserInfo>

    @PUT("auth/profile")
    public suspend fun updateProfile(@Body body: Map<String, String>): ApiEnvelope<kotlinx.serialization.json.JsonObject>

    @GET("auth/profile/ui-settings")
    public suspend fun getUISettings(): ApiEnvelope<UISettingsResponse>

    @PUT("auth/profile/ui-settings")
    public suspend fun updateUISettings(
        @Body body: UISettingsUpdateRequest,
    ): ApiEnvelope<kotlinx.serialization.json.JsonObject>

    @POST("auth/refresh-token")
    public suspend fun refreshToken(@Body body: RefreshTokenRequest): ApiEnvelope<RefreshTokenResponse>

    /** 同步版本：供 OkHttp Authenticator / Interceptor 在非协程上下文中调用 */
    @POST("auth/refresh-token")
    public fun refreshTokenSync(@Body body: RefreshTokenRequest): Call<ApiEnvelope<RefreshTokenResponse>>
}
