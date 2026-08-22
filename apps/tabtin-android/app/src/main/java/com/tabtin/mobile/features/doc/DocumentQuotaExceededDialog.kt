package com.tabtin.mobile.features.doc

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AppError

/** 三个原生新建入口共用，避免把额度已用完误报成普通的创建失败。 */
@Composable
public fun DocumentQuotaExceededDialog(
    error: AppError.DocumentQuotaExceeded,
    onDismiss: () -> Unit,
) {
    val usage = error.used?.let { used ->
        error.limit?.let { limit -> stringResource(R.string.doc_quota_exceeded_usage, used, limit) }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.doc_quota_exceeded_title)) },
        text = {
            Text(
                listOfNotNull(
                    stringResource(R.string.doc_quota_exceeded_message),
                    usage,
                ).joinToString("\n\n"),
            )
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.doc_quota_exceeded_confirm))
            }
        },
    )
}
