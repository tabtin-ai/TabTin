package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.AuthApi
import com.tabtin.mobile.data.api.AuthEventBus
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.api.TokenRefreshCoordinator
import com.tabtin.mobile.data.api.TokenRefreshResult
import com.tabtin.mobile.data.api.apiErrorMessage
import com.tabtin.mobile.data.api.apiErrorCode
import com.tabtin.mobile.data.local.MessageDao
import com.tabtin.mobile.data.local.SessionListDao
import com.tabtin.mobile.data.model.ActionLabel
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.LoginRequest
import com.tabtin.mobile.data.model.LoginResponse
import com.tabtin.mobile.data.model.CurrentPasswordResetRequest
import com.tabtin.mobile.data.model.PasswordChangeRequest
import com.tabtin.mobile.data.model.RedeemInviteCodeRequest
import com.tabtin.mobile.data.model.SendCodeRequest
import com.tabtin.mobile.data.im.CentrifugoClient
import com.tabtin.mobile.data.im.ImConversationStore
import com.tabtin.mobile.data.im.ImMessageRoomCache
import com.tabtin.mobile.data.model.UserInfo
import com.tabtin.mobile.data.model.needsInviteCode
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.push.PushService
import com.tabtin.mobile.sentry.SentryContextProvider
import com.tabtin.mobile.util.TokenManager
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import retrofit2.HttpException

@Singleton
public class AuthRepository @Inject constructor(
    private val authApi: AuthApi,
    private val refreshCoordinator: TokenRefreshCoordinator,
    private val contextApi: ContextApi,
    private val tokenManager: TokenManager,
    private val chatRepository: ChatRepository,
    private val sessionRunStateStore: SessionRunStateStore,
    private val sessionReadStateStore: SessionReadStateStore,
    private val sessionReadAckStore: SessionReadAckStore,
    private val messageDao: MessageDao,
    private val sessionListDao: SessionListDao,
    private val deviceRuntimeRepository: DeviceRuntimeRepository,
    private val webSocketService: WebSocketService,
    private val organizationRepository: OrganizationRepository,
    private val sentryContextProvider: SentryContextProvider,
    private val centrifugoClient: CentrifugoClient,
    private val imConversationStore: ImConversationStore,
    private val imMessageRoomCache: ImMessageRoomCache,
    private val pushService: PushService,
    private val nativeCloudDraftCleaner: NativeCloudDraftCleaner,
) {
    private var currentUser: UserInfo? = null

    public val isLoggedIn: Boolean get() = tokenManager.isLoggedIn

    /** 只以本次登录/Profile 明确返回的状态决定是否展示邀请码准入层。 */
    public val needsInviteCode: Boolean get() = currentUser?.needsInviteCode == true

    public val hasExpiredButRefreshableSession: Boolean get() = tokenManager.hasExpiredButRefreshableSession

    public suspend fun attemptTokenRefresh(): TokenRefreshResult {
        val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            refreshCoordinator.refreshBlockingResult()
        }
        if (result == TokenRefreshResult.Invalid) {
            clearSessionReadState()
            imMessageRoomCache.clearAll()
            nativeCloudDraftCleaner.clearAll()
            tokenManager.clear()
        }
        return result
    }

    public suspend fun loginWithPassword(phone: String, password: String): Result<Unit> = runCatching {
        val resp = authApi.loginWithPassword(LoginRequest(username = phone, password = password)).unwrap()
        handleLoginSuccess(resp)
    }.mapAuthFailure(ActionLabel.LOGIN)

    public suspend fun loginWithCode(phone: String, code: String, challengeKey: String): Result<Unit> = runCatching {
        val resp = authApi.loginWithCode(
            LoginRequest(username = phone, verificationCode = code, challengeKey = challengeKey),
        ).unwrap()
        handleLoginSuccess(resp)
    }.mapAuthFailure(ActionLabel.LOGIN)

    public suspend fun sendVerificationCode(phone: String, challengeKey: String): Result<Unit> = runCatching {
        val resp = authApi.sendVerificationCode(
            SendCodeRequest(username = phone, challengeKey = challengeKey),
        )
        if (!resp.success) throw AppError.SendCodeFailed(resp.message)
    }.recoverCatching { error -> throw error.toSendCodeError() }

    public suspend fun sendEmailVerification(): Result<Unit> = runCatching {
        val resp = authApi.sendEmailVerification()
        if (!resp.success) throw AppError.SendCodeFailed(resp.message)
    }

    public suspend fun sendPhoneVerification(): Result<Unit> = runCatching {
        val resp = authApi.sendPhoneVerification()
        if (!resp.success) throw AppError.SendCodeFailed(resp.message)
    }

    public suspend fun verifyEmail(code: String): Result<Unit> = runCatching {
        val resp = authApi.verifyEmail(mapOf("code" to code))
        if (!resp.success) throw AppError.RequestFailed(resp.message)
        fetchProfile().getOrThrow()
    }

    public suspend fun verifyPhone(code: String): Result<Unit> = runCatching {
        val resp = authApi.verifyPhone(mapOf("code" to code))
        if (!resp.success) throw AppError.RequestFailed(resp.message)
        fetchProfile().getOrThrow()
    }

    /** 使用当前密码修改密码；服务端成功后会使所有会话失效。 */
    public suspend fun changePassword(oldPassword: String, newPassword: String): Result<Unit> = runCatching {
        val resp = authApi.changePassword(
            PasswordChangeRequest(oldPassword = oldPassword, newPassword = newPassword),
        )
        if (!resp.success) {
            throw AppError.RequestFailed(resp.message, resp.errorCode ?: resp.code)
        }
    }

    /** 给当前账号可信的手机号/邮箱发送“忘记当前密码”验证码。 */
    public suspend fun sendCurrentPasswordResetCode(): Result<Unit> = runCatching {
        val resp = authApi.sendCurrentPasswordResetCode()
        if (!resp.success) {
            throw AppError.RequestFailed(resp.message, resp.errorCode ?: resp.code)
        }
    }

    /** 使用当前账号验证码重置密码；服务端成功后会使所有会话失效。 */
    public suspend fun resetCurrentPassword(
        verificationCode: String,
        newPassword: String,
    ): Result<Unit> = runCatching {
        val resp = authApi.resetCurrentPassword(
            CurrentPasswordResetRequest(
                verificationCode = verificationCode,
                newPassword = newPassword,
            ),
        )
        if (!resp.success) {
            throw AppError.RequestFailed(resp.message, resp.errorCode ?: resp.code)
        }
    }

    public suspend fun fetchProfile(): Result<UserInfo> = runCatching {
        val user = authApi.getProfile().unwrap()
        saveUserInfo(user)
        user
    }

    public suspend fun redeemInviteCode(inviteCode: String): Result<Unit> = runCatching {
        val normalizedCode = inviteCode.trim()
        require(normalizedCode.isNotEmpty()) { "请输入邀请码" }
        val response = try {
            authApi.redeemInviteCode(
                RedeemInviteCodeRequest(inviteCode = normalizedCode),
            ).unwrap()
        } catch (error: Throwable) {
            throw inviteCodeRedeemError(error)
        }
        saveUserInfo(response.user)
        check(!needsInviteCode) { "邀请码验证未完成" }
        initializeSessionRuntime()
    }

    public suspend fun updateProfile(
        nickname: String? = null,
        username: String? = null,
        bio: String? = null,
        avatarFileId: String? = null,
    ): Result<UserInfo> = runCatching {
        val body = buildMap {
            nickname?.let { put("nickname", it) }
            username?.let { put("username", it) }
            bio?.let { put("bio", it) }
            // 后端 UAVTR 契约：头像走 avatar_file_id 关联 FileRecord，不再接受 avatar URL
            avatarFileId?.let { put("avatar_file_id", it) }
        }
        val resp = authApi.updateProfile(body)
        if (!resp.success) throw AppError.RequestFailed(resp.message)
        val user = authApi.getProfile().unwrap()
        saveUserInfo(user)
        user
    }

    private fun saveUserInfo(user: UserInfo) {
        currentUser = user
        tokenManager.userId = user.id
        // Sentry user context：只放内部 ID + 昵称（契约 A 节红线，见 SentryContextProvider）。
        sentryContextProvider.applyUser(userId = user.id, nickname = user.nickname)
        tokenManager.saveUserProfile(
            nickname = user.nickname,
            username = user.username,
            phone = user.phone,
            email = user.email,
            avatar = user.avatar,
            bio = user.bio,
            dateJoined = user.dateJoined,
            lastLogin = user.lastLogin,
            loginCount = user.loginCount,
            isVerifiedEmail = user.isVerifiedEmail,
            isVerifiedPhone = user.isVerifiedPhone,
            hasUsablePassword = user.hasUsablePassword,
        )
    }

    private suspend fun handleLoginSuccess(resp: LoginResponse) {
        tokenManager.saveTokenPair(resp.accessToken, resp.refreshToken, resp.expiresIn)
        AuthEventBus.markSessionActive()
        saveUserInfo(resp.user ?: authApi.getProfile().unwrap())
        if (needsInviteCode) return
        initializeSessionRuntime()
    }

    /** Profile 已确认不受邀请码拦截后，才初始化组织和设备运行时。 */
    public suspend fun initializeSessionRuntime() {
        loadOrganization()
        val registered = deviceRuntimeRepository.ensureSelectedOrganizationDeviceRegistered()
        if (registered) {
            webSocketService.ensureDeviceRuntimeReady()
        }
        pushService.start()
    }

    private suspend fun loadOrganization() {
        val wsResp = contextApi.getOrganizations()
        val organizations = wsResp.data?.organizations.orEmpty()
        val persistedId = tokenManager.organizationId
        val selected = persistedId?.let { id -> organizations.firstOrNull { it.id == id } }
            ?: organizations.firstOrNull { it.isDefault == true }
            ?: organizations.firstOrNull()
        tokenManager.organizationId = selected?.id
    }

    private fun Result<Unit>.mapAuthFailure(label: ActionLabel): Result<Unit> =
        recoverCatching { error -> throw error.toActionError(label) }

    private fun Throwable.toActionError(label: ActionLabel): Throwable = when (this) {
        is AppError.ActionFailed -> this
        is AppError.RequestFailed -> AppError.ActionFailed(label, serverMessage)
        is HttpException -> AppError.ActionFailed(label, apiErrorMessage(response()?.errorBody()?.string()))
        is IOException -> AppError.NetworkUnavailable
        else -> this
    }

    private fun Throwable.toSendCodeError(): Throwable = when (this) {
        is AppError.SendCodeFailed -> this
        is AppError.RequestFailed -> AppError.SendCodeFailed(serverMessage)
        is HttpException -> AppError.SendCodeFailed(apiErrorMessage(response()?.errorBody()?.string()))
        is IOException -> AppError.NetworkUnavailable
        else -> this
    }

    public suspend fun logout() {
        // 须在 tokenManager.clear() 之前反注册推送 token（此时 accessToken 仍有效）
        pushService.prepareForLogout()
        deviceRuntimeRepository.reportOffline(tokenManager.accessToken)
        webSocketService.fullDisconnect()
        // TabChat IM：断开 Centrifugo 实时通道并清空会话列表（与 Agent 对话各自清理）。
        centrifugoClient.disconnect()
        imConversationStore.clear()
        chatRepository.clearCache()
        clearSessionReadState()
        messageDao.deleteAll()
        sessionListDao.deleteAll()
        imMessageRoomCache.clearAll()
        nativeCloudDraftCleaner.clearAll()
        tokenManager.clear()
        organizationRepository.clearOnLogout()
        sentryContextProvider.clearUser()
    }

    private suspend fun clearSessionReadState() {
        sessionRunStateStore.clear()
        sessionReadStateStore.clear()
        sessionReadAckStore.clear()
    }
}

internal fun inviteCodeRedeemError(error: Throwable): Throwable {
    val requestFailure = when (error) {
        is AppError.RequestFailed -> error
        is HttpException -> {
            val rawBody = error.response()?.errorBody()?.string()
            AppError.RequestFailed(
                serverMessage = apiErrorMessage(rawBody),
                errorCode = apiErrorCode(rawBody),
            )
        }
        else -> return error
    }
    return if (requestFailure.errorCode.equals("RATE_LIMITED", ignoreCase = true)) {
        AppError.InviteCodeRateLimited
    } else {
        requestFailure
    }
}
