package com.tabtin.mobile.features.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTSpacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun ChangePasswordScreen(
    onBack: () -> Unit,
    onPasswordChanged: () -> Unit,
    viewModel: ChangePasswordViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    LaunchedEffect(state.succeeded) {
        if (state.succeeded) onPasswordChanged()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.change_password_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
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
                .padding(horizontal = TTSpacing.xl, vertical = TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Text(
                text = if (state.mode == ChangePasswordMode.CHANGE) {
                    stringResource(R.string.change_password_desc_change)
                } else if (viewModel.resetContact != null) {
                    stringResource(R.string.change_password_desc_reset, viewModel.resetContact!!)
                } else {
                    stringResource(R.string.change_password_desc_reset_no_contact)
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            if (state.mode == ChangePasswordMode.CHANGE) {
                PasswordInput(
                    value = state.oldPassword,
                    onValueChange = viewModel::updateOldPassword,
                    label = stringResource(R.string.change_password_current),
                    placeholder = stringResource(R.string.change_password_placeholder_old),
                )
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    OutlinedTextField(
                        value = state.verificationCode,
                        onValueChange = viewModel::updateVerificationCode,
                        modifier = Modifier.weight(1f),
                        label = { Text(stringResource(R.string.change_password_verification_code)) },
                        placeholder = { Text(stringResource(R.string.change_password_placeholder_code)) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    )
                    OutlinedButton(
                        onClick = viewModel::sendResetCode,
                        enabled = viewModel.resetContact != null && !state.isSendingCode && state.cooldownSeconds == 0,
                        modifier = Modifier.padding(top = 8.dp),
                    ) {
                        if (state.isSendingCode) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.padding(horizontal = 8.dp))
                        } else if (state.cooldownSeconds > 0) {
                            Text("${state.cooldownSeconds}s")
                        } else {
                            Text(stringResource(R.string.change_password_send_code))
                        }
                    }
                }
            }

            PasswordInput(
                value = state.newPassword,
                onValueChange = viewModel::updateNewPassword,
                label = stringResource(R.string.change_password_new),
                placeholder = stringResource(R.string.change_password_placeholder_new),
            )
            PasswordInput(
                value = state.confirmPassword,
                onValueChange = viewModel::updateConfirmPassword,
                label = stringResource(R.string.change_password_confirm),
                placeholder = stringResource(R.string.change_password_placeholder_confirm),
            )
            Text(
                text = stringResource(R.string.change_password_rules),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            state.error?.let { message ->
                Text(message, color = MaterialTheme.colorScheme.error)
            }

            Button(
                onClick = viewModel::submit,
                enabled = !state.isSubmitting,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (state.isSubmitting) {
                    CircularProgressIndicator(strokeWidth = 2.dp)
                } else {
                    Text(stringResource(R.string.change_password_submit))
                }
            }

            androidx.compose.material3.TextButton(
                onClick = {
                    viewModel.switchMode(
                        if (state.mode == ChangePasswordMode.CHANGE) ChangePasswordMode.RESET else ChangePasswordMode.CHANGE,
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    stringResource(
                        if (state.mode == ChangePasswordMode.CHANGE) {
                            R.string.change_password_forgot_old
                        } else {
                            R.string.change_password_use_old
                        },
                    ),
                )
            }
            Spacer(Modifier.height(TTSpacing.lg))
        }
    }
}

@Composable
private fun PasswordInput(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        placeholder = { Text(placeholder) },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
    )
}
