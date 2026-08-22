package com.tabtin.mobile.data.automation.handlers.l1

import android.content.ComponentName
import android.content.Context
import android.provider.Settings

/**
 * 通知监听服务相关共享工具，消除 NotificationStore 和 DeviceRuntimeDescriptor
 * 中重复的 isListenerEnabled 检查逻辑（NT-009）。
 */
internal object NotificationListenerUtils {

    public fun isListenerEnabled(context: Context): Boolean {
        val flat = Settings.Secure.getString(
            context.contentResolver,
            "enabled_notification_listeners",
        ) ?: return false
        val component = ComponentName(context, TabTinNotificationListener::class.java).flattenToString()
        return flat.contains(component)
    }
}
