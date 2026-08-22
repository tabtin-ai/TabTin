package com.tabtin.mobile.data.automation

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.util.Log
import androidx.appcompat.app.AlertDialog
import com.tabtin.mobile.R
import com.tabtin.mobile.data.websocket.SecurityConfirmCallback
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.suspendCancellableCoroutine
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

/**
 * Default device-action confirm UI: Material [AlertDialog] on the foreground
 * [Activity], with Allow once / Allow for this session / Deny.
 *
 * Self-registers into [DeviceSecurityConfirm] so [com.tabtin.mobile.data.websocket.DeviceActionDispatcher]
 * can resolve a callback without WebSocketService constructor changes.
 */
@Singleton
public class AndroidSecurityConfirmCallback @Inject constructor(
    @ApplicationContext context: Context,
) : SecurityConfirmCallback {

    private val app = context.applicationContext as Application
    private var activityRef: WeakReference<Activity>? = null

    init {
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                activityRef = WeakReference(activity)
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) {
                if (activityRef?.get() === activity) {
                    activityRef = null
                }
            }
        })
        DeviceSecurityConfirm.install(this)
        Log.i(TAG, "Installed as DeviceSecurityConfirm fallback")
    }

    override suspend fun confirm(action: String, reason: String): SecurityConfirmDecision {
        val activity = activityRef?.get()
        if (activity == null || activity.isFinishing || activity.isDestroyed) {
            Log.w(TAG, "No foreground activity for confirm action='$action'")
            return SecurityConfirmDecision.UNAVAILABLE
        }

        return suspendCancellableCoroutine { cont ->
            val settled = AtomicBoolean(false)
            fun settle(decision: SecurityConfirmDecision) {
                if (settled.compareAndSet(false, true) && cont.isActive) {
                    cont.resume(decision)
                }
            }

            val dialog = AlertDialog.Builder(activity)
                .setTitle(R.string.capabilities_security_confirm_title)
                .setMessage(reason)
                .setCancelable(false)
                .setPositiveButton(R.string.capabilities_security_confirm_allow_once) { _, _ ->
                    settle(SecurityConfirmDecision.ALLOW_ONCE)
                }
                .setNeutralButton(R.string.capabilities_security_confirm_allow_session) { _, _ ->
                    settle(SecurityConfirmDecision.ALLOW_SESSION)
                }
                .setNegativeButton(R.string.capabilities_security_confirm_deny) { _, _ ->
                    settle(SecurityConfirmDecision.DENY)
                }
                .create()

            dialog.setOnDismissListener {
                settle(SecurityConfirmDecision.DENY)
            }

            cont.invokeOnCancellation {
                if (dialog.isShowing) {
                    dialog.dismiss()
                }
            }

            try {
                dialog.show()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to show security confirm dialog", e)
                settle(SecurityConfirmDecision.UNAVAILABLE)
            }
        }
    }

    private companion object {
        private const val TAG = "AndroidSecurityConfirm"
    }
}
