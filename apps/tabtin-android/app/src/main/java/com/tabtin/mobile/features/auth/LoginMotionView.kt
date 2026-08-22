package com.tabtin.mobile.features.auth

import android.annotation.SuppressLint
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color as ComposeColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.AppLanguage
import com.tabtin.mobile.ui.web.WebViewRenderProcessGuard
import com.tabtin.mobile.ui.web.releaseSafely
import java.util.Locale

/**
 * 登录页 hero 品牌动画（对齐 iOS [LoginMotionView]）。
 *
 * 三幕品牌动画随包在 `assets/login_motion/login-motion.html`，WebView 离线内嵌播放：
 * - 纯装饰：禁交互、禁滚动、对无障碍隐藏
 * - 所有图形和时间轴自包含，不依赖网络；文案走 `?lang=` 透传应用内语言
 * - 页面隐藏时暂停，重新可见后原位继续；减少动态效果时展示静态执行幕
 * - 内容进程终止走 [WebViewRenderProcessGuard]；自愈一次失败后落回无底色品牌字样，不留白屏
 */
@Composable
internal fun LoginMotionView(
    language: AppLanguage,
    isActive: Boolean,
    modifier: Modifier = Modifier,
) {
    val lang = remember(language) { language.toMotionLang() }
    var showsStaticFallback by remember { mutableStateOf(false) }
    // 渲染进程被系统回收后实例永久报废；先静默重建一次，再次终止才落静态图（与 iOS / Mermaid 同口径）。
    var reloadToken by remember { mutableIntStateOf(0) }
    var autoRecoveryUsed by remember { mutableStateOf(false) }

    Box(
        modifier = modifier
            .semantics { hideFromAccessibility() },
        contentAlignment = Alignment.Center,
    ) {
        if (showsStaticFallback) {
            Text(
                text = stringResource(R.string.app_name),
                style = MaterialTheme.typography.displaySmall,
                fontWeight = FontWeight.Black,
                color = ComposeColor(0xFF20201C),
            )
        } else {
            // lang / reloadToken 变化时整棵重建，才能刷新 slogan 与失效实例。
            key(lang, reloadToken) {
                LoginMotionWebView(
                    lang = lang,
                    isActive = isActive,
                    onRenderGone = {
                        if (autoRecoveryUsed) {
                            showsStaticFallback = true
                        } else {
                            autoRecoveryUsed = true
                            reloadToken += 1
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
@Composable
private fun LoginMotionWebView(
    lang: String,
    isActive: Boolean,
    onRenderGone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val lifecycleBridge = remember { LoginMotionLifecycleBridge() }
    val assetUrl = remember(lang) {
        "file:///android_asset/login_motion/login-motion.html?lang=$lang"
    }

    // IME 只改变页面对动画的播放请求；WebView 实例始终留在组合树中。
    SideEffect {
        lifecycleBridge.setRequestedActive(isActive)
    }

    DisposableEffect(lifecycleOwner, lifecycleBridge) {
        lifecycleBridge.setLifecycleActive(
            lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED),
        )
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> lifecycleBridge.setLifecycleActive(true)
                Lifecycle.Event.ON_PAUSE,
                Lifecycle.Event.ON_STOP,
                -> lifecycleBridge.setLifecycleActive(false)

                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)

        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            lifecycleBridge.setLifecycleActive(false)
        }
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                setBackgroundColor(Color.TRANSPARENT)
                // 透明底合成：部分机型默认软件层会把透明画成黑底，硬件层按需开启。
                setLayerType(View.LAYER_TYPE_HARDWARE, null)
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                isClickable = false
                isLongClickable = false
                isFocusable = false
                isFocusableInTouchMode = false
                // 纯装饰：吞掉全部触摸，避免抢登录页焦点 / 滚动。
                setOnTouchListener { _, _ -> true }

                settings.javaScriptEnabled = true
                settings.domStorageEnabled = false
                settings.allowFileAccess = true
                settings.allowContentAccess = false
                settings.blockNetworkLoads = true
                settings.setSupportZoom(false)
                settings.builtInZoomControls = false
                settings.displayZoomControls = false

                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView?,
                        request: WebResourceRequest?,
                    ): Boolean = true

                    override fun onPageFinished(view: WebView?, url: String?) {
                        view?.let(lifecycleBridge::applyTo)
                    }

                    override fun onRenderProcessGone(
                        view: WebView?,
                        detail: RenderProcessGoneDetail?,
                    ): Boolean {
                        view?.let(lifecycleBridge::detach)
                        return WebViewRenderProcessGuard.handle(
                            host = "login_motion",
                            view = view,
                            detail = detail,
                            onGone = { onRenderGone() },
                        )
                    }
                }

                lifecycleBridge.attach(this)
                loadUrl(assetUrl)
            }
        },
        onRelease = { webView ->
            lifecycleBridge.detach(webView)
            webView.releaseSafely()
        },
    )
}

/**
 * 将 Activity 生命周期与 WebView、页面内时间轴绑在一起。
 *
 * 不调用 pauseTimers：它是进程级开关，会误伤应用内其他 WebView。
 */
private class LoginMotionLifecycleBridge {
    private var webView: WebView? = null
    private var lifecycleActive: Boolean = false
    private var requestedActive: Boolean = true

    fun attach(view: WebView) {
        webView = view
        applyTo(view)
    }

    fun detach(view: WebView) {
        if (webView === view) {
            webView = null
        }
    }

    fun setLifecycleActive(active: Boolean) {
        lifecycleActive = active
        webView?.let(::applyTo)
    }

    fun setRequestedActive(active: Boolean) {
        requestedActive = active
        webView?.let(::applyTo)
    }

    fun applyTo(view: WebView) {
        if (lifecycleActive && requestedActive) {
            view.onResume()
            view.evaluateJavascript("window.tabtinMotion?.setActive(true)", null)
        } else {
            view.evaluateJavascript("window.tabtinMotion?.setActive(false)", null)
            view.onPause()
        }
    }
}

private fun AppLanguage.toMotionLang(): String {
    return when (this) {
        AppLanguage.ZH_CN -> "zh"
        AppLanguage.EN -> "en"
        AppLanguage.SYSTEM -> {
            if (Locale.getDefault().language.lowercase(Locale.ROOT).startsWith("zh")) "zh" else "en"
        }
    }
}
