package com.tabtin.mobile.daemon

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Process
import android.util.Log

/**
 * 接收桌面端通过 ADB 注入的激活指令。
 *
 * 用法：
 * adb shell am broadcast -a com.tabtin.daemon.ACTIVATE \
 *   --es install_token "itk_xxx" \
 *   --es api_url "http://10.0.2.2:6060/api" \
 *   --es ws_url "ws://10.0.2.2:6060/ws"
 */
public class DaemonReceiver : BroadcastReceiver() {

    public companion object {
        private const val TAG = "DaemonReceiver"
        public const val ACTION_ACTIVATE: String = "com.tabtin.daemon.ACTIVATE"
        public const val EXTRA_INSTALL_TOKEN: String = "install_token"
        public const val EXTRA_API_URL: String = "api_url"
        public const val EXTRA_WS_URL: String = "ws_url"
        public const val EXTRA_ACTIVATION_NONCE: String = "activation_nonce"

        private const val SHELL_UID = 2000
        private const val ROOT_UID = 0

        /**
         * DD-010: 判断调用方 UID 是否为受信来源。
         * 允许：ADB shell (uid=2000)、root (uid=0)、同应用进程 (myUid)。
         */
        internal fun isTrustedCaller(callingUid: Int, myUid: Int): Boolean {
            return callingUid == SHELL_UID || callingUid == ROOT_UID || callingUid == myUid
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_ACTIVATE) return

        val callingUid = android.os.Binder.getCallingUid()
        val isAdb = callingUid == SHELL_UID || callingUid == ROOT_UID
        val senderPkg = intent.`package` ?: if (isAdb) "adb-shell" else "unknown"
        Log.i(TAG, "ACTIVATE broadcast from uid=$callingUid pkg=$senderPkg adb=$isAdb")

        if (!isTrustedCaller(callingUid, Process.myUid())) {
            Log.w(TAG, "DD-010: ACTIVATE broadcast from untrusted uid=$callingUid (pkg=$senderPkg), blocked")
            return
        }

        val installToken = intent.getStringExtra(EXTRA_INSTALL_TOKEN)
        if (installToken.isNullOrBlank()) {
            Log.w(TAG, "Received ACTIVATE broadcast without install_token, ignoring")
            return
        }

        val apiUrl = intent.getStringExtra(EXTRA_API_URL)
        val wsUrl = intent.getStringExtra(EXTRA_WS_URL)
        val activationNonce = intent.getStringExtra(EXTRA_ACTIVATION_NONCE)

        Log.i(TAG, "Received ACTIVATE broadcast, starting DaemonService (apiUrl=$apiUrl)")

        DaemonService.start(context, installToken, apiUrl, wsUrl, activationNonce)
    }
}
