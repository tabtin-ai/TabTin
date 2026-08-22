package com.tabtin.mobile.features.profile

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.repository.AuthRepository
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

public enum class ChangePasswordMode {
    CHANGE,
    RESET,

    ;

    public companion object {
        /** 旧服务端缺少能力字段时维持原行为，只有明确无密码才走验证码。 */
        public fun initial(hasUsablePassword: Boolean?): ChangePasswordMode =
            if (hasUsablePassword == false) RESET else CHANGE
    }
}

public data class ChangePasswordUiState(
    val mode: ChangePasswordMode = ChangePasswordMode.CHANGE,
    val oldPassword: String = "",
    val newPassword: String = "",
    val confirmPassword: String = "",
    val verificationCode: String = "",
    val isSendingCode: Boolean = false,
    val isSubmitting: Boolean = false,
    val cooldownSeconds: Int = 0,
    val error: String? = null,
    val succeeded: Boolean = false,
)

@HiltViewModel
public class ChangePasswordViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val tokenManager: TokenManager,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    private val _uiState = MutableStateFlow(
        ChangePasswordUiState(
            mode = ChangePasswordMode.initial(tokenManager.userHasUsablePassword),
        ),
    )
    public val uiState: StateFlow<ChangePasswordUiState> = _uiState.asStateFlow()
    private var cooldownJob: Job? = null

    public val resetContact: String?
        get() = tokenManager.userPhone?.takeIf { it.isNotBlank() }?.let(::maskContact)
            ?: tokenManager.userEmail?.takeIf { it.isNotBlank() }?.let(::maskContact)

    public fun updateOldPassword(value: String) {
        update { copy(oldPassword = value, error = null) }
    }

    public fun updateVerificationCode(value: String) {
        update {
            copy(
                verificationCode = value.filter(Char::isDigit).take(6),
                error = null,
            )
        }
    }

    public fun updateNewPassword(raw: String) {
        val sanitized = PasswordPolicy.sanitize(raw)
        val nextError = when {
            sanitized.hadCjk -> message(R.string.change_password_error_new_no_cjk)
            sanitized.hadWhitespace -> message(R.string.change_password_error_new_no_whitespace)
            sanitized.value.length >= PasswordPolicy.minimumLength &&
                PasswordPolicy.validate(sanitized.value, sanitized.value) == PasswordPolicy.ValidationError.NOT_COMPLEX ->
                message(R.string.change_password_error_new_not_complex)
            else -> null
        }
        update { copy(newPassword = sanitized.value, error = nextError) }
    }

    public fun updateConfirmPassword(raw: String) {
        val sanitized = PasswordPolicy.sanitize(raw)
        val nextError = when {
            sanitized.hadCjk -> message(R.string.change_password_error_new_no_cjk)
            sanitized.hadWhitespace -> message(R.string.change_password_error_new_no_whitespace)
            sanitized.value.isNotEmpty() && sanitized.value != _uiState.value.newPassword ->
                message(R.string.change_password_error_password_mismatch)
            else -> null
        }
        update { copy(confirmPassword = sanitized.value, error = nextError) }
    }

    public fun switchMode(mode: ChangePasswordMode) {
        update {
            copy(
                mode = mode,
                oldPassword = "",
                verificationCode = "",
                error = null,
                succeeded = false,
            )
        }
    }

    public fun sendResetCode() {
        val state = _uiState.value
        if (state.mode != ChangePasswordMode.RESET || state.isSendingCode || state.cooldownSeconds > 0) return
        viewModelScope.launch {
            update { copy(isSendingCode = true, error = null) }
            authRepository.sendCurrentPasswordResetCode()
                .onSuccess {
                    update {
                        copy(
                            isSendingCode = false,
                            cooldownSeconds = 60,
                        )
                    }
                    startCooldown()
                }
                .onFailure { error ->
                    update {
                        copy(
                            isSendingCode = false,
                            error = userMessage(error, R.string.change_password_error_send_code_failed),
                        )
                    }
                }
        }
    }

    public fun submit() {
        val state = _uiState.value
        if (state.isSubmitting || state.succeeded) return

        val validationError = PasswordPolicy.validate(state.newPassword, state.confirmPassword)
        if (validationError != null) {
            update { copy(error = validationErrorMessage(validationError)) }
            return
        }
        if (state.mode == ChangePasswordMode.CHANGE && state.oldPassword.isBlank()) {
            update { copy(error = message(R.string.change_password_error_old_required)) }
            return
        }
        if (state.mode == ChangePasswordMode.RESET && !Regex("^\\d{6}$").matches(state.verificationCode)) {
            update { copy(error = message(R.string.change_password_error_code_invalid)) }
            return
        }

        viewModelScope.launch {
            update { copy(isSubmitting = true, error = null) }
            val result = if (state.mode == ChangePasswordMode.CHANGE) {
                authRepository.changePassword(state.oldPassword, state.newPassword)
            } else {
                authRepository.resetCurrentPassword(state.verificationCode, state.newPassword)
            }
            result
                .onSuccess { update { copy(isSubmitting = false, succeeded = true) } }
                .onFailure { error ->
                    update {
                        copy(
                            isSubmitting = false,
                            error = userMessage(error, R.string.change_password_error_failed),
                        )
                    }
                }
        }
    }

    private fun startCooldown() {
        cooldownJob?.cancel()
        cooldownJob = viewModelScope.launch {
            while (_uiState.value.cooldownSeconds > 0) {
                delay(1000)
                update { copy(cooldownSeconds = (cooldownSeconds - 1).coerceAtLeast(0)) }
            }
        }
    }

    private fun validationErrorMessage(error: PasswordPolicy.ValidationError): String = when (error) {
        PasswordPolicy.ValidationError.REQUIRED -> message(R.string.change_password_error_new_too_short)
        PasswordPolicy.ValidationError.CONTAINS_CJK -> message(R.string.change_password_error_new_no_cjk)
        PasswordPolicy.ValidationError.CONTAINS_WHITESPACE -> message(R.string.change_password_error_new_no_whitespace)
        PasswordPolicy.ValidationError.TOO_SHORT -> message(R.string.change_password_error_new_too_short)
        PasswordPolicy.ValidationError.NOT_COMPLEX -> message(R.string.change_password_error_new_not_complex)
        PasswordPolicy.ValidationError.MISMATCH -> message(R.string.change_password_error_password_mismatch)
    }

    private fun message(id: Int): String = context.getString(id)

    private fun userMessage(error: Throwable, fallbackId: Int): String = when (error) {
        is AppError -> error.toUserMessage(context)
        else -> error.message ?: message(fallbackId)
    }

    private fun maskContact(contact: String): String {
        if (contact.contains("@")) {
            val parts = contact.split("@", limit = 2)
            val local = parts.firstOrNull().orEmpty()
            val domain = parts.getOrNull(1).orEmpty()
            if (local.length > 2 && domain.isNotEmpty()) return "${local.take(2)}***@$domain"
            return contact
        }
        if (contact.length <= 4) return contact
        return contact.take(3) + "****" + contact.takeLast(2)
    }

    private inline fun update(transform: ChangePasswordUiState.() -> ChangePasswordUiState) {
        _uiState.value = _uiState.value.transform()
    }
}
