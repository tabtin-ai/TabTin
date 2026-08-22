package com.tabtin.mobile.data.automation.handlers.l1

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.tabtin.mobile.data.adb.PairingCodeExtractor
import com.tabtin.mobile.data.websocket.WebSocketService
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
public class TabTinNotificationListener : NotificationListenerService() {

    @Inject public lateinit var store: NotificationStore
    @Inject public lateinit var pairingCodeExtractor: PairingCodeExtractor
    @Inject public lateinit var webSocketService: WebSocketService

    // NT-004: 实现 onListenerConnected —— NLS 服务绑定成功时触发
    override fun onListenerConnected() {
        super.onListenerConnected()
        // NT-012: 服务连接时为当前账号加载历史通知（也处理了账号切换场景）
        store.reloadForCurrentUser()
        // 能力状态已变更（NLS 从不可用变为可用），通知服务端更新能力列表
        webSocketService.reportCapabilitiesChanged()
    }

    // NT-004: 实现 onListenerDisconnected —— NLS 服务解绑时触发（用户撤销权限等）
    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        // 通知状态从可用变为不可用，触发能力变更上报
        webSocketService.reportCapabilitiesChanged()
    }

    // NT-008: onDestroy 时取消待执行的延迟保存，立即落盘，防 Handler 悬挂
    override fun onDestroy() {
        store.shutdown()
        super.onDestroy()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return
        val notification = sbn.notification
        val extras = notification.extras
        val title = extras.getCharSequence("android.title")?.toString()
        val text = extras.getCharSequence("android.text")?.toString()
        val bigText = extras.getCharSequence("android.bigText")?.toString()
        val subText = extras.getCharSequence("android.subText")?.toString()
        val infoText = extras.getCharSequence("android.infoText")?.toString()
        val category = notification.category

        val actions = notification.actions?.mapNotNull { action ->
            val actionTitle = action.title?.toString() ?: return@mapNotNull null
            NotificationStore.NotificationAction(
                title = actionTitle,
                hasRemoteInput = !action.remoteInputs.isNullOrEmpty(),
            )
        }

        pairingCodeExtractor.tryExtract(sbn.packageName, title, text, bigText)

        store.onNotificationPosted(
            key = sbn.key,
            packageName = sbn.packageName,
            title = title,
            text = text,
            bigText = bigText,
            postTime = sbn.postTime,
            actions = actions,
            subText = subText,
            infoText = infoText,
            category = category,
        )
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        sbn ?: return
        store.onNotificationRemoved(sbn.key)
    }
}
