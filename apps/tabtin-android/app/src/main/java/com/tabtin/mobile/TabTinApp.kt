package com.tabtin.mobile

import android.app.Application
import androidx.lifecycle.ProcessLifecycleOwner
import coil.ImageLoader
import coil.ImageLoaderFactory
import com.tabtin.mobile.sentry.SentryContextProvider
import com.tabtin.mobile.diagnostics.DiagnosticRecorder
import com.tabtin.mobile.diagnostics.DiagnosticHttpInterceptor
import com.tabtin.mobile.sentry.DiagnosticRuntime
import com.tabtin.mobile.sentry.SentryReporter
import com.tabtin.mobile.ui.theme.ThemeManager
import com.tabtin.mobile.util.AppLifecycleManager
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
public class TabTinApp : Application(), ImageLoaderFactory {

    @Inject public lateinit var appLifecycleManager: AppLifecycleManager

    @Inject public lateinit var sentryContextProvider: SentryContextProvider
    @Inject public lateinit var themeManager: ThemeManager
    @Inject public lateinit var tokenManager: TokenManager

    @Inject public lateinit var diagnosticRecorder: DiagnosticRecorder

    override fun onCreate() {
        super.onCreate()
        themeManager.syncPlatformNightMode()
        diagnosticRecorder.recordAppEvent("application_started")
        SentryReporter.init(this, diagnosticRecorder)
        DiagnosticRuntime.initialize(this, tokenManager)
        sentryContextProvider.start()
        ProcessLifecycleOwner.get().lifecycle.addObserver(appLifecycleManager)
        appLifecycleManager.initialize()
    }

    override fun newImageLoader(): ImageLoader = ImageLoader.Builder(this)
        .okHttpClient {
            okhttp3.OkHttpClient.Builder()
                .addInterceptor(DiagnosticHttpInterceptor(diagnosticRecorder))
                .build()
        }
        .build()

}
