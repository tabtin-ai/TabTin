package com.tabtin.mobile.features.auth

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.api.TokenRefreshResult
import com.tabtin.mobile.data.repository.AuthRepository
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

public data class LoginUiState(
    val phone: String = "",
    val password: String = "",
    val verificationCode: String = "",
    val isCodeMode: Boolean = true,
    /** 发验证码与登录分离，避免发码 loading 误伤登录按钮（对齐 iOS） */
    val isSendingCode: Boolean = false,
    val isLoggingIn: Boolean = false,
    val isRedeemingInviteCode: Boolean = false,
    val inviteCodeError: String? = null,
    val codeSent: Boolean = false,
    val cooldownSeconds: Int = 0,
    val error: String? = null,
    /** 登录页右上角直接打开环境配置 */
    val showDebugEnvironment: Boolean = false,
)

public enum class LoginErrorContext {
    SEND_CODE,
    VERIFICATION_CODE,
    PASSWORD,
}

/** 登录页只展示简短、可行动的文案；服务端详情保留在错误对象中，不进入 UI。 */
public object LoginErrorPresentation {
    public fun messageRes(error: Throwable, context: LoginErrorContext): Int = when {
        error is AppError.NetworkUnavailable -> com.tabtin.mobile.R.string.auth_error_network
        context == LoginErrorContext.SEND_CODE -> com.tabtin.mobile.R.string.auth_error_send_code
        isCredentialFailure(error) && context == LoginErrorContext.PASSWORD ->
            com.tabtin.mobile.R.string.auth_error_invalid_password
        isCredentialFailure(error) && context == LoginErrorContext.VERIFICATION_CODE ->
            com.tabtin.mobile.R.string.auth_error_invalid_code
        else -> com.tabtin.mobile.R.string.auth_error_login
    }

    private fun isCredentialFailure(error: Throwable): Boolean {
        val raw = (error as? AppError.ActionFailed)?.serverMessage
            ?.trim()
            ?.lowercase()
            .orEmpty()
        return raw.contains("auth_invalid") ||
            raw.contains("verification_code_invalid") ||
            raw.contains("用户名或密码") ||
            raw.contains("账号或密码") ||
            raw.contains("验证码") ||
            raw.contains("invalid username or password") ||
            raw.contains("verification code is invalid")
    }
}

/**
 * 登录标识符：默认与桌面同一套「邮箱或大陆手机号」口径
 * （`packages/tabtin-shared/src/auth-forms/rules.ts`）。
 * 固定展示 +86 时，仍接受系统电话建议携带的区号和分隔符。
 */
public object LoginPhoneNumber {
    private val emailPattern = Regex("""^[^\s@]+@[^\s@]+\.[^\s@]+$""")
    private val cnMobilePattern = Regex("""^1[3-9]\d{9}$""")
    private val emailDraftMarker = Regex("""[a-zA-Z@]""")

    public fun parseEmailLoginEnabled(raw: String?): Boolean =
        raw.orEmpty().trim().lowercase() != "false"

    public val emailLoginEnabled: Boolean = true

    public fun editingValue(
        input: String,
        emailLoginEnabled: Boolean = LoginPhoneNumber.emailLoginEnabled,
    ): String {
        if (emailLoginEnabled && emailDraftMarker.containsMatchIn(input)) return input
        return sanitizedCnMobilePhone(input)
    }

    public fun normalized(
        input: String,
        emailLoginEnabled: Boolean = LoginPhoneNumber.emailLoginEnabled,
    ): String? {
        val trimmed = input.trim()
        if (emailLoginEnabled && trimmed.contains('@')) {
            return trimmed.lowercase().takeIf { emailPattern.matches(it) }
        }
        val value = sanitizedCnMobilePhone(input)
        return value.takeIf { cnMobilePattern.matches(it) }
    }

    private fun sanitizedCnMobilePhone(input: String): String {
        val digits = buildString {
            input.forEach { character ->
                val digit = Character.digit(character, 10)
                if (digit >= 0) append(digit)
            }
        }
        val localDigits = when {
            digits.length > 11 && digits.startsWith("861") -> digits.drop(2)
            digits.length > 11 && digits.startsWith("00861") -> digits.drop(4)
            else -> digits
        }
        return localDigits.take(11)
    }
}

public object LoginVerificationCode {
    public fun editingValue(input: String): String = buildString {
        input.forEach { character ->
            val digit = Character.digit(character, 10)
            if (digit >= 0 && length < 6) append(digit)
        }
    }
}

@HiltViewModel
public class LoginViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val tokenManager: TokenManager,
    @ApplicationContext private val context: Context,
) : ViewModel() {

    private var verificationChallengeKey: String? = null

    private val _uiState = MutableStateFlow(LoginUiState())
    public val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    private val _isLoggedIn = MutableStateFlow(authRepository.isLoggedIn)
    public val isLoggedIn: StateFlow<Boolean> = _isLoggedIn.asStateFlow()

    private val _isRestoringSession = MutableStateFlow(
        authRepository.isLoggedIn || authRepository.hasExpiredButRefreshableSession,
    )
    public val isRestoringSession: StateFlow<Boolean> = _isRestoringSession.asStateFlow()

    private val _needsInviteCode = MutableStateFlow(false)
    public val needsInviteCode: StateFlow<Boolean> = _needsInviteCode.asStateFlow()

    init {
        if (authRepository.isLoggedIn) {
            viewModelScope.launch {
                resolveInviteGateFromProfile()
                _isRestoringSession.value = false
            }
        } else if (authRepository.hasExpiredButRefreshableSession) {
            attemptColdStartRefresh()
        }
    }

    private fun attemptColdStartRefresh() {
        _isRestoringSession.value = true
        viewModelScope.launch {
            try {
                when (authRepository.attemptTokenRefresh()) {
                    is TokenRefreshResult.Success,
                    TokenRefreshResult.Conflict,
                    TokenRefreshResult.TemporarilyUnavailable -> {
                        resolveInviteGateFromProfile()
                    }
                    TokenRefreshResult.Invalid -> {
                        _isLoggedIn.value = false
                        _needsInviteCode.value = false
                    }
                }
            } finally {
                _isRestoringSession.value = false
            }
        }
    }

    /** Profile 是邀请码门禁的权威信号；缓存从不直接触发弹窗。 */
    private suspend fun resolveInviteGateFromProfile() {
        val result = authRepository.fetchProfile()
        if (result.isSuccess) {
            _isLoggedIn.value = true
            _needsInviteCode.value = authRepository.needsInviteCode
            if (!_needsInviteCode.value) {
                runCatching { authRepository.initializeSessionRuntime() }
            }
        } else {
            // 网络失败没有明确的 gate 响应，按需求不弹邀请码窗；服务端仍会拒绝核心请求。
            _isLoggedIn.value = authRepository.isLoggedIn
            _needsInviteCode.value = false
        }
    }

    public fun updatePhone(phone: String) {
        val nextPhone = LoginPhoneNumber.editingValue(phone)
        if (nextPhone != _uiState.value.phone) verificationChallengeKey = null
        _uiState.value = _uiState.value.copy(
            phone = nextPhone,
            error = null,
        )
    }

    public fun updatePassword(password: String) {
        _uiState.value = _uiState.value.copy(password = password, error = null)
    }

    public fun openDebugEnvironment() {
        _uiState.value = _uiState.value.copy(showDebugEnvironment = true)
    }

    public fun dismissDebugEnvironment() {
        _uiState.value = _uiState.value.copy(showDebugEnvironment = false)
    }

    public fun updateCode(code: String) {
        _uiState.value = _uiState.value.copy(
            verificationCode = LoginVerificationCode.editingValue(code),
            error = null,
        )
    }

    public fun toggleMode() {
        _uiState.value = _uiState.value.copy(
            isCodeMode = !_uiState.value.isCodeMode,
            error = null,
        )
    }

    public fun sendCode() {
        val phone = LoginPhoneNumber.normalized(_uiState.value.phone) ?: run {
            _uiState.value = _uiState.value.copy(error = AppError.InvalidPhone.toUserMessage(context))
            return
        }
        viewModelScope.launch {
            val challengeKey = UUID.randomUUID().toString()
            _uiState.value = _uiState.value.copy(isSendingCode = true)
            authRepository.sendVerificationCode(phone, challengeKey)
                .onSuccess {
                    verificationChallengeKey = challengeKey
                    _uiState.value = _uiState.value.copy(
                        isSendingCode = false,
                        codeSent = true,
                        cooldownSeconds = 60,
                    )
                    startCooldown()
                }
                .onFailure { e ->
                    _uiState.value = _uiState.value.copy(
                        isSendingCode = false,
                        error = errorMessage(e, LoginErrorContext.SEND_CODE),
                    )
                }
        }
    }

    public fun login(onSuccess: (requiresInviteCode: Boolean) -> Unit) {
        val state = _uiState.value
        val phone = LoginPhoneNumber.normalized(state.phone) ?: run {
            _uiState.value = state.copy(error = AppError.InvalidPhone.toUserMessage(context))
            return
        }

        viewModelScope.launch {
            _uiState.value = state.copy(isLoggingIn = true, error = null)
            val result = if (state.isCodeMode) {
                val challengeKey = verificationChallengeKey
                if (challengeKey == null) {
                    _uiState.value = state.copy(
                        isLoggingIn = false,
                        error = context.getString(com.tabtin.mobile.R.string.auth_error_send_code),
                    )
                    return@launch
                }
                authRepository.loginWithCode(phone, state.verificationCode.trim(), challengeKey)
            } else {
                authRepository.loginWithPassword(phone, state.password)
            }
            result
                .onSuccess {
                    _uiState.value = _uiState.value.copy(isLoggingIn = false)
                    _isLoggedIn.value = true
                    _needsInviteCode.value = authRepository.needsInviteCode
                    onSuccess(_needsInviteCode.value)
                }
                .onFailure { e ->
                    _uiState.value = _uiState.value.copy(
                        isLoggingIn = false,
                        error = errorMessage(
                            e,
                            if (state.isCodeMode) {
                                LoginErrorContext.VERIFICATION_CODE
                            } else {
                                LoginErrorContext.PASSWORD
                            },
                        ),
                    )
                }
        }
    }

    public fun logout() {
        _isLoggedIn.value = false
        _needsInviteCode.value = false
        viewModelScope.launch { authRepository.logout() }
    }

    public fun redeemInviteCode(inviteCode: String, onSuccess: () -> Unit) {
        val normalizedCode = inviteCode.trim()
        if (normalizedCode.isEmpty()) {
            _uiState.value = _uiState.value.copy(
                inviteCodeError = context.getString(com.tabtin.mobile.R.string.auth_invite_code_required),
            )
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(
                isRedeemingInviteCode = true,
                inviteCodeError = null,
            )
            authRepository.redeemInviteCode(normalizedCode)
                .onSuccess {
                    _needsInviteCode.value = authRepository.needsInviteCode
                    _uiState.value = _uiState.value.copy(isRedeemingInviteCode = false)
                    if (!_needsInviteCode.value) onSuccess()
                }
                .onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isRedeemingInviteCode = false,
                        inviteCodeError = if (error is AppError) {
                            error.toUserMessage(context)
                        } else {
                            context.getString(com.tabtin.mobile.R.string.error_request_failed)
                        },
                    )
                }
        }
    }

    private fun errorMessage(e: Throwable, loginContext: LoginErrorContext): String =
        context.getString(LoginErrorPresentation.messageRes(e, loginContext))

    private fun startCooldown() {
        viewModelScope.launch {
            while (_uiState.value.cooldownSeconds > 0) {
                kotlinx.coroutines.delay(1000)
                _uiState.value = _uiState.value.copy(
                    cooldownSeconds = _uiState.value.cooldownSeconds - 1,
                )
            }
        }
    }
}
