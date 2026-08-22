package com.tabtin.mobile.features.version

import android.content.Intent
import android.net.Uri
import android.util.Log
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.window.DialogProperties
import com.tabtin.mobile.data.model.VersionGateDecision

private fun openUpdateUrl(context: android.content.Context, url: String) {
    if (url.isBlank()) return
    try {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    } catch (e: Exception) {
        Log.w("VersionGate", "open update url failed: ${e.message}")
        Toast.makeText(context, "无法打开更新页面", Toast.LENGTH_SHORT).show()
    }
}

/**
 * 强制更新拦截弹窗：不可关闭。
 * - AlertDialog 关闭手势与点击外部全部禁用；
 * - BackHandler 吞掉返回键，防止穿透到下层页面；
 * - 只有「立即更新」一个按钮跳转商店/落地页。
 */
@Composable
public fun ForceUpdateDialog(decision: VersionGateDecision) {
    val context = LocalContext.current

    // 拦截系统返回键：强更期间返回不生效。
    BackHandler(enabled = true) { /* no-op：不可退出 */ }

    AlertDialog(
        onDismissRequest = { /* no-op：不可关闭 */ },
        properties = DialogProperties(
            dismissOnBackPress = false,
            dismissOnClickOutside = false,
        ),
        title = { Text(decision.title.ifBlank { "需要更新" }) },
        text = {
            Text(
                decision.message.ifBlank { "当前版本过旧，请更新后继续使用。" } +
                    if (decision.latestVersion.isNotBlank()) "\n\n最新版本 ${decision.latestVersion}" else "",
            )
        },
        confirmButton = {
            TextButton(
                onClick = { openUpdateUrl(context, decision.resolvedStoreUrl) },
            ) {
                Text("立即更新")
            }
        },
    )
}

/** 推荐更新提示：可关闭，用户可选择「稍后」。 */
@Composable
public fun SoftUpdateDialog(
    decision: VersionGateDecision,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(decision.title.ifBlank { "发现新版本" }) },
        text = { Text(decision.message.ifBlank { "有新版本可用，建议更新以获得更好的体验。" }) },
        confirmButton = {
            TextButton(onClick = {
                openUpdateUrl(context, decision.resolvedStoreUrl)
                onDismiss()
            }) {
                Text("去更新")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("稍后")
            }
        },
    )
}
