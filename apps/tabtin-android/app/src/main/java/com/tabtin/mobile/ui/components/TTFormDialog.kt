package com.tabtin.mobile.ui.components

import androidx.compose.material3.AlertDialog
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.window.DialogProperties

/**
 * 带输入的浮层表单。
 *
 * 系统键盘出现后，普通 [AlertDialog] 会沿用其窗口原有的软键盘策略；长表单则可能被
 * 平移或裁切。这里统一让 Dialog window 按可用高度 resize。复杂表单的正文滚动仍由
 * 调用方自身唯一的滚动容器承担，避免输入框的自动定位与外层滚动相互抢位置。
 *
 */
@Composable
public fun TTFormDialog(
    onDismissRequest: () -> Unit,
    title: @Composable (() -> Unit)?,
    text: @Composable () -> Unit,
    confirmButton: @Composable () -> Unit,
    dismissButton: @Composable (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    properties: DialogProperties = DialogProperties(),
) {
    AlertDialog(
        onDismissRequest = onDismissRequest,
        modifier = modifier.dismissKeyboardOnBackgroundTap(),
        title = title,
        text = {
            EnableDialogImeResize()
            text()
        },
        confirmButton = confirmButton,
        dismissButton = dismissButton,
        properties = properties,
    )
}
