package com.tabtin.mobile.push

import android.util.Log

/** 推送 SDK 抽象层。开源构建默认 [NoopPushSdkClient]。 */
public interface PushSdkClient {
    public val isAvailable: Boolean

    public fun register(
        sdkAppId: Long,
        appKey: String,
        onSuccess: () -> Unit,
        onError: (code: Int, message: String?) -> Unit,
    )

    public fun getRegistrationId(callback: (String) -> Unit)

    public fun unregister()

    public fun setNotificationClickHandler(handler: (String) -> Unit)
}

public class NoopPushSdkClient : PushSdkClient {
    private companion object {
        const val TAG = "PushSdkClient"
    }

    override val isAvailable: Boolean = false

    override fun register(
        sdkAppId: Long,
        appKey: String,
        onSuccess: () -> Unit,
        onError: (code: Int, message: String?) -> Unit,
    ) {
        Log.i(TAG, "Noop push SDK: register skipped")
    }

    override fun getRegistrationId(callback: (String) -> Unit) {
        // No SDK: leave the caller waiting; PushService already skips when unavailable.
    }

    override fun unregister() {
        Log.i(TAG, "Noop push SDK: unregister skipped")
    }

    override fun setNotificationClickHandler(handler: (String) -> Unit): Unit = Unit
}
