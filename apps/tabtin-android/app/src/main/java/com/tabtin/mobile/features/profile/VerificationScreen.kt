package com.tabtin.mobile.features.profile

import android.widget.Toast
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.repository.AuthRepository
import com.tabtin.mobile.ui.theme.TTSpacing
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

private enum class VerificationTargetKind { EMAIL, PHONE }

@HiltViewModel
public class VerificationViewModel @Inject constructor(
    private val authRepository: AuthRepository,
) : ViewModel() {

    public var isSendingCode: Boolean by mutableStateOf(false)
        private set
    public var isVerifying: Boolean by mutableStateOf(false)
        private set
    public var cooldown: Int by mutableIntStateOf(0)
        private set

    private val _toast = MutableSharedFlow<String>(extraBufferCapacity = 1)
    public val toast: SharedFlow<String> = _toast.asSharedFlow()

    public fun sendCode(target: String) {
        if (isSendingCode || cooldown > 0) return
        viewModelScope.launch {
            isSendingCode = true
            try {
                when (target.kind()) {
                    VerificationTargetKind.EMAIL -> authRepository.sendEmailVerification()
                    VerificationTargetKind.PHONE -> authRepository.sendPhoneVerification()
                }.getOrThrow()
                cooldown = 60
                startCooldownTimer()
                _toast.tryEmit("验证码已发送")
            } catch (e: Exception) {
                _toast.tryEmit(e.message ?: "发送失败")
            }
            isSendingCode = false
        }
    }

    public fun verify(target: String, code: String) {
        if (isVerifying) return
        viewModelScope.launch {
            isVerifying = true
            try {
                when (target.kind()) {
                    VerificationTargetKind.EMAIL -> authRepository.verifyEmail(code.trim())
                    VerificationTargetKind.PHONE -> authRepository.verifyPhone(code.trim())
                }.getOrThrow()
                _toast.tryEmit("验证成功")
            } catch (e: Exception) {
                _toast.tryEmit(e.message ?: "验证失败")
            }
            isVerifying = false
        }
    }

    private fun startCooldownTimer() {
        viewModelScope.launch {
            while (cooldown > 0) {
                delay(1000)
                cooldown--
            }
        }
    }

    private fun String.kind(): VerificationTargetKind =
        if (trim().contains("@")) VerificationTargetKind.EMAIL else VerificationTargetKind.PHONE
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun VerificationScreen(
    initialTarget: String = "",
    onBack: () -> Unit,
    viewModel: VerificationViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    var target by remember(initialTarget) { mutableStateOf(initialTarget) }
    var code by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        viewModel.toast.collect { msg ->
            Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.verify_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.xl),
        ) {
            Spacer(Modifier.height(TTSpacing.lg))

            Text(
                stringResource(R.string.verify_desc),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(TTSpacing.xl))

            OutlinedTextField(
                value = target,
                onValueChange = { target = it },
                label = { Text(stringResource(R.string.verify_email_or_phone)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            )

            Spacer(Modifier.height(TTSpacing.lg))

            Row(modifier = Modifier.fillMaxWidth()) {
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it },
                    label = { Text(stringResource(R.string.verify_code)) },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(12.dp),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )

                Spacer(Modifier.width(TTSpacing.md))

                OutlinedButton(
                    onClick = { viewModel.sendCode(target) },
                    enabled = target.isNotBlank() && !viewModel.isSendingCode && viewModel.cooldown == 0,
                    modifier = Modifier.padding(top = 8.dp),
                ) {
                    if (viewModel.isSendingCode) {
                        CircularProgressIndicator(modifier = Modifier.padding(4.dp), strokeWidth = 2.dp)
                    } else if (viewModel.cooldown > 0) {
                        Text("${viewModel.cooldown}s")
                    } else {
                        Text(stringResource(R.string.verify_send_code))
                    }
                }
            }

            Spacer(Modifier.height(TTSpacing.xxl))

            Button(
                onClick = { viewModel.verify(target, code) },
                enabled = target.isNotBlank() && code.length >= 4 && !viewModel.isVerifying,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (viewModel.isVerifying) {
                    CircularProgressIndicator(
                        modifier = Modifier.padding(4.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Text(stringResource(R.string.verify_confirm))
                }
            }
        }
    }
}
