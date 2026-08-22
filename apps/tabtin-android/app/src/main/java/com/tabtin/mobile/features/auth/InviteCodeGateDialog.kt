package com.tabtin.mobile.features.auth

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.window.DialogProperties
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.components.TTFormDialog
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * 登录后邀请码强制准入层。
 *
 * DialogProperties 和空的 onDismissRequest 共同保证返回键、点击遮罩都不能跳过；
 * 只有兑换成功或主动换账号才会改变根层认证状态。
 */
@Composable
public fun InviteCodeGateDialog(
    isRedeeming: Boolean,
    errorMessage: String?,
    onRedeem: (String) -> Unit,
    onChangeAccount: () -> Unit,
) {
    var inviteCode by rememberSaveable { mutableStateOf("") }

    TTFormDialog(
        onDismissRequest = {},
        properties = DialogProperties(
            dismissOnBackPress = false,
            dismissOnClickOutside = false,
        ),
        title = { Text(stringResource(R.string.auth_invite_code_title)) },
        text = {
            Column {
                Text(
                    text = stringResource(R.string.auth_invite_code_description),
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedTextField(
                    value = inviteCode,
                    onValueChange = { inviteCode = it.uppercase() },
                    label = { Text(stringResource(R.string.auth_invite_code_label)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
                    enabled = !isRedeeming,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = TTSpacing.lg),
                )
                if (errorMessage != null) {
                    Text(
                        text = errorMessage,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = TTSpacing.sm),
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onRedeem(inviteCode) },
                enabled = inviteCode.isNotBlank() && !isRedeeming,
            ) {
                if (isRedeeming) {
                    CircularProgressIndicator(
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Text(stringResource(R.string.auth_invite_code_continue))
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onChangeAccount, enabled = !isRedeeming) {
                Text(stringResource(R.string.auth_invite_code_change_account))
            }
        },
    )
}
