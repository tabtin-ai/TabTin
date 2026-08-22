package com.tabtin.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.features.auth.LoginViewModel
import com.tabtin.mobile.navigation.AppNavigation
import com.tabtin.mobile.navigation.DeepLinkHandler
import com.tabtin.mobile.push.PushService
import com.tabtin.mobile.ui.device.MainActivityOrientationPolicy
import com.tabtin.mobile.ui.device.resolveMainActivityOrientationPolicy
import com.tabtin.mobile.ui.device.stableDeviceMetrics
import com.tabtin.mobile.ui.splash.LaunchSplashOverlay
import com.tabtin.mobile.ui.theme.TabTinTheme
import com.tabtin.mobile.ui.theme.ThemeManager
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.delay
import javax.inject.Inject

@AndroidEntryPoint
public class MainActivity : AppCompatActivity() {

    private companion object {
        /** 推送点击透传 ext（后端 OfflinePushInfo.Ext JSON）的 intent extra key。 */
        const val EXTRA_PUSH_EXT = "tabtin_push_ext"

        /** 冷进程只播放一次；Activity 配置重建不重复，进程重启后自然复位。 */
        var hasShownLaunchSplash: Boolean = false
    }

    @Inject public lateinit var themeManager: ThemeManager
    @Inject public lateinit var deepLinkHandler: DeepLinkHandler
    @Inject public lateinit var pushService: PushService
    @Inject public lateinit var tokenManager: TokenManager

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* 用户拒绝也不阻塞 */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        val systemSplash = installSplashScreen()
        systemSplash.setOnExitAnimationListener { provider ->
            val splashView = provider.view
            splashView.animate()
                .alpha(0f)
                .translationY(-splashView.height * 0.06f)
                .setDuration(160L)
                .withEndAction { provider.remove() }
                .start()
        }
        super.onCreate(savedInstanceState)
        applyDeviceOrientationPolicy()
        enableEdgeToEdge()

        val shouldShowLaunchSplash = !hasShownLaunchSplash
        hasShownLaunchSplash = true

        handleIntent(intent)
        maybeRequestNotificationPermission()

        setContent {
            val themeMode by themeManager.themeMode.collectAsState(initial = themeManager.initialThemeMode)
            val colorSchemeId by themeManager.colorSchemeId.collectAsState(initial = themeManager.initialColorSchemeId)
            val authVm: LoginViewModel = hiltViewModel()
            val isRestoringSession by authVm.isRestoringSession.collectAsState()
            var isLaunchSplashVisible by remember { mutableStateOf(shouldShowLaunchSplash) }
            var isAppContentComposed by remember { mutableStateOf(!shouldShowLaunchSplash) }
            var isLaunchMotionComplete by remember { mutableStateOf(!shouldShowLaunchSplash) }
            val launchSplashAlpha = remember { Animatable(1f) }

            LaunchedEffect(isLaunchSplashVisible) {
                if (!isLaunchSplashVisible) return@LaunchedEffect
                delay(3_720)
                isLaunchMotionComplete = true
                isAppContentComposed = true
            }

            LaunchedEffect(
                isLaunchSplashVisible,
                isLaunchMotionComplete,
                isAppContentComposed,
                isRestoringSession,
            ) {
                if (!isLaunchSplashVisible || !isLaunchMotionComplete ||
                    !isAppContentComposed || isRestoringSession
                ) {
                    return@LaunchedEffect
                }
                withFrameNanos { }
                withFrameNanos { }
                delay(80)
                launchSplashAlpha.animateTo(0f, animationSpec = tween(durationMillis = 240))
                isLaunchSplashVisible = false
            }

            TabTinTheme(themeMode = themeMode, colorSchemeId = colorSchemeId) {
                Box(Modifier.fillMaxSize()) {
                    if (isAppContentComposed) {
                        AppNavigation(deepLinkHandler = deepLinkHandler)
                    }
                    if (isLaunchSplashVisible) {
                        LaunchSplashOverlay(
                            modifier = Modifier
                                .fillMaxSize()
                                .graphicsLayer { alpha = launchSplashAlpha.value },
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** Keep the phone experience portrait-first while Android tablets respect user rotation. */
    private fun applyDeviceOrientationPolicy() {
        requestedOrientation = when (
            resolveMainActivityOrientationPolicy(stableDeviceMetrics())
        ) {
            MainActivityOrientationPolicy.PORTRAIT -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            MainActivityOrientationPolicy.FOLLOW_USER -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    /**
     * Android 13+ 运行时通知权限。仅在推送已配置
     * 且已登录时请求——key 留空的当前阶段整体静默，不打扰用户。
     */
    private fun maybeRequestNotificationPermission() {
        if (!pushService.isConfigured || !tokenManager.isLoggedIn) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun handleIntent(intent: Intent?) {
        // 推送点击：系统通知 extra 或 SDK 回调透传 ext。
        // 或直接调 pushService.handleNotificationExt），此处兜底解析 intent extra。
        intent?.getStringExtra(EXTRA_PUSH_EXT)?.takeIf { it.isNotBlank() }?.let { ext ->
            pushService.handleNotificationExt(ext)
        }

        val data = intent?.data ?: return
        when (data.host) {
            "invite" -> {
                if (!isSupportedInviteDeepLinkScheme(data.scheme)) return
                val token = data.pathSegments.firstOrNull()?.takeIf { it.isNotBlank() } ?: return
                deepLinkHandler.setPendingToken(token)
            }
            "resource" -> {
                if (!data.scheme.equals("tabtin", ignoreCase = true)) return
                // tabtin://resource/<type>/<id>（来自 RichResourceRef tap 或外部分享）
                // path segments: [<type>, <id>]
                val segments = data.pathSegments
                val type = segments.getOrNull(0)?.takeIf { it.isNotBlank() } ?: return
                val id = segments.getOrNull(1)?.takeIf { it.isNotBlank() } ?: return
                val hint = data.getQueryParameter("hint")
                deepLinkHandler.emitResourceNavigation(
                    resourceType = resourceDeepLinkType(type, hint),
                    resourceId = id,
                    title = data.getQueryParameter("title")
                        ?: data.getQueryParameter("resource_name")
                        ?: data.getQueryParameter("label"),
                    locationHint = data.getQueryParameter("location_hint")
                        ?: data.getQueryParameter("locationHint")
                        ?: buildResourceLocationHint(data),
                    spaceId = data.getQueryParameter("space_id")
                        ?: data.getQueryParameter("spaceId"),
                    organizationId = data.getQueryParameter("organization_id")
                        ?: data.getQueryParameter("organizationId")
                        ?: data.getQueryParameter("workspace_id")
                        ?: data.getQueryParameter("workspaceId"),
                )
            }
        }
    }

    private fun resourceDeepLinkType(type: String, hint: String?): String {
        val normalizedHint = hint?.takeIf { it.isNotBlank() }?.lowercase()
        if (normalizedHint in setOf("tabdoc", "tabdata", "tabslide", "tabsite")) {
            return normalizedHint!!
        }
        return when (type.lowercase()) {
            "doc_selection", "document_selection" -> "tabdoc"
            "table_selection", "field", "record" -> "tabdata"
            "slide_selection" -> "tabslide"
            else -> type
        }
    }

    private fun buildResourceLocationHint(data: android.net.Uri): String? {
        val anchor = data.getQueryParameter("anchor")?.takeIf { it.isNotBlank() }
        if (anchor != null) return "定位：$anchor"

        val rowId = data.getQueryParameter("row_id") ?: data.getQueryParameter("rowId")
        val colId = data.getQueryParameter("col_id") ?: data.getQueryParameter("colId")
        val tableParts = listOfNotNull(
            rowId?.takeIf { it.isNotBlank() }?.let { "行 $it" },
            colId?.takeIf { it.isNotBlank() }?.let { "列 $it" },
        )
        if (tableParts.isNotEmpty()) return tableParts.joinToString(" · ")

        val startLine = data.getQueryParameter("start_line") ?: data.getQueryParameter("startLine")
        val endLine = data.getQueryParameter("end_line") ?: data.getQueryParameter("endLine")
        return when {
            !startLine.isNullOrBlank() && !endLine.isNullOrBlank() && startLine != endLine -> "行 $startLine-$endLine"
            !startLine.isNullOrBlank() -> "行 $startLine"
            else -> null
        }
    }
}

internal fun isSupportedInviteDeepLinkScheme(scheme: String?): Boolean =
    scheme.equals("tabtin", ignoreCase = true) ||
        scheme.equals("tabtin-preprod", ignoreCase = true)
