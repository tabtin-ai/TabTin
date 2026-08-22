package com.tabtin.mobile.sentry

import android.content.Context
import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.diagnostics.DiagnosticRecorder
import io.sentry.Sentry
import io.sentry.SentryOptions
import io.sentry.android.core.SentryAndroid
import io.sentry.android.core.SentryAndroidOptions

/**
 * Android 端 Sentry 错误监控接入（，errors-only）。
 * DSN 由 Debug 页填写并本地保存；未填写时不上报。
 * 字段契约（tags 白名单 / 脱敏红线）：`docs/agent/error-context-schema.md`。
 */
public object SentryReporter {
    private const val PREFS = "tabtin-sentry"
    private const val KEY_DSN = "dsn"

    private var appContext: Context? = null
    private var diagnosticRecorder: DiagnosticRecorder? = null

    public fun storedDsn(context: Context = requireContext()): String =
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_DSN, "")
            .orEmpty()

    public fun init(context: Context, diagnosticRecorder: DiagnosticRecorder) {
        appContext = context.applicationContext
        this.diagnosticRecorder = diagnosticRecorder
        configure(storedDsn(context.applicationContext))
    }

    public fun applyDsn(raw: String): Boolean {
        if (!SentryDsn.isValid(raw)) return false
        val context = requireContext()
        val dsn = SentryDsn.normalize(raw)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_DSN, dsn)
            .apply()
        configure(dsn)
        return true
    }

    private fun configure(dsn: String) {
        val context = requireContext()
        val recorder = diagnosticRecorder ?: return
        Sentry.close()
        if (dsn.isEmpty()) return
        SentryAndroid.init(context) { options: SentryAndroidOptions ->
            options.dsn = dsn
            options.environment = BuildConfig.OBSERVABILITY_ENVIRONMENT
            options.release = "tabtin-android@${BuildConfig.VERSION_NAME}"
            options.tracesSampleRate = 0.0
            options.isSendDefaultPii = false
            options.isAttachScreenshot = false
            options.isAttachViewHierarchy = false
            options.isDebug = BuildConfig.DEBUG
            options.beforeSend = SentryOptions.BeforeSendCallback { event, _ ->
                val scrubbed = SentryScrub.scrub(event)
                recorder.recordAppEvent(
                    name = "sentry_error",
                    result = scrubbed.level?.name,
                    error = scrubbed.throwable,
                )
                scrubbed
            }
        }
    }

    private fun requireContext(): Context =
        checkNotNull(appContext) { "SentryReporter.init must run before applyDsn" }
}
