package com.tabtin.mobile.ui.theme

import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/**
 * 系统「移除动画」（开发者选项把动画时长缩放设为 0，即
 * `Settings.Global.ANIMATOR_DURATION_SCALE == 0`）时返回 true。
 *
 * 返回 true 处应当跳过动画或瞬时完成（`snap()` / 直接置终值），与系统承诺一致。
 * 读取只在 remember 时做一次，不监听设置变更——与既有各处口径相同。
 */
@Composable
public fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) == 0f
    }
}
