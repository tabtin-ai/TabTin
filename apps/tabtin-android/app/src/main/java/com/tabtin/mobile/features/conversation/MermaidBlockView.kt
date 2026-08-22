package com.tabtin.mobile.features.conversation

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.tabtin.mobile.ui.web.WebViewRenderProcessGuard
import com.tabtin.mobile.ui.web.releaseSafely
import kotlinx.coroutines.delay
import org.json.JSONObject

/**
 * Mermaid 离线渲染（对齐 Electron [MermaidBlock] 与 iOS [MermaidBlockView]）。
 *
 * - 成功：SVG 图，按内容自适应高度，宽度超出时等比缩放
 * - 渲染中 / 失败：显示 [fallback]（通常是原代码块），隐藏探针在后台继续渲染
 * - 流式期间 350ms 防抖，避免语法不完整时反复失败闪烁
 * - securityLevel: strict；WebView 禁滚动、禁外链跳转
 */
internal sealed interface MermaidRenderState {
    data object Rendering : MermaidRenderState
    data class Success(val height: Dp) : MermaidRenderState
    data object Failure : MermaidRenderState
}

@Composable
internal fun MermaidBlockView(
    code: String,
    modifier: Modifier = Modifier,
    fallback: @Composable () -> Unit,
) {
    var state by remember { mutableStateOf<MermaidRenderState>(MermaidRenderState.Rendering) }
    var settledCode by remember { mutableStateOf<String?>(null) }
    // 渲染进程被系统回收后 WebView 实例永久报废，复用会抛 IllegalStateException，只能整个换新的。
    // 聊天流里的内嵌图没地方放「重试」按钮，所以降级换成两级：先静默重建一次（多数是一次性的
    // 内存尖峰，重建就能好）；再次终止就落到 fallback——用户看到原始 mermaid 源码，内容仍然
    // 可读，不是白块。与 iOS MermaidRenderView 同款口径。
    var reloadToken by remember { mutableIntStateOf(0) }
    var autoRecoveryUsed by remember { mutableStateOf(false) }
    val theme = if (isSystemInDarkTheme()) "dark" else "default"

    LaunchedEffect(code) {
        delay(MERMAID_DEBOUNCE_MS)
        if (settledCode != code) {
            state = MermaidRenderState.Rendering
            settledCode = code
        }
    }

    Box(modifier = modifier.fillMaxWidth()) {
        val showDiagram = state is MermaidRenderState.Success
        if (!showDiagram) {
            fallback()
        }
        settledCode?.let { settled ->
            key(reloadToken) {
                MermaidWebView(
                    code = settled,
                    theme = theme,
                    visible = showDiagram,
                    height = (state as? MermaidRenderState.Success)?.height ?: 1.dp,
                    onStateChange = { state = it },
                    onRenderGone = {
                        if (autoRecoveryUsed) {
                            state = MermaidRenderState.Failure
                        } else {
                            autoRecoveryUsed = true
                            state = MermaidRenderState.Rendering
                            reloadToken += 1
                        }
                    },
                )
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun MermaidWebView(
    code: String,
    theme: String,
    visible: Boolean,
    height: Dp,
    onStateChange: (MermaidRenderState) -> Unit,
    onRenderGone: () -> Unit,
) {
    val density = LocalDensity.current
    var pageReady by remember { mutableStateOf(false) }
    var lastRendered by remember(code, theme) { mutableStateOf<Pair<String, String>?>(null) }

    val webModifier = if (visible) {
        Modifier
            .fillMaxWidth()
            .height(height)
    } else {
        Modifier
            .size(1.dp)
            .alpha(0.01f)
            .semantics { hideFromAccessibility() }
    }

    AndroidView(
        modifier = webModifier,
        factory = { ctx ->
            WebView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                )
                setBackgroundColor(Color.TRANSPARENT)
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.setSupportZoom(false)
                settings.builtInZoomControls = false
                settings.displayZoomControls = false
                addJavascriptInterface(
                    MermaidBridge { ok, heightPx ->
                        Handler(Looper.getMainLooper()).post {
                            onStateChange(
                                if (ok && heightPx > 0) {
                                    MermaidRenderState.Success((heightPx / density.density).dp)
                                } else {
                                    MermaidRenderState.Failure
                                },
                            )
                        }
                    },
                    MermaidBridge.INTERFACE_NAME,
                )
                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView?, url: String?) {
                        val webView = view ?: return
                        if (!MermaidAssets.ensureReady(webView)) {
                            onStateChange(MermaidRenderState.Failure)
                            return
                        }
                        pageReady = true
                    }

                    override fun shouldOverrideUrlLoading(
                        view: WebView?,
                        request: WebResourceRequest?,
                    ): Boolean = true

                    override fun onRenderProcessGone(
                        view: WebView?,
                        detail: RenderProcessGoneDetail?,
                    ): Boolean = WebViewRenderProcessGuard.handle(
                        host = "mermaid_block",
                        view = view,
                        detail = detail,
                        beforeDestroy = { it.removeJavascriptInterface(MermaidBridge.INTERFACE_NAME) },
                        onGone = { onRenderGone() },
                    )
                }
                loadDataWithBaseURL(null, MermaidAssets.pageHtml, "text/html", "UTF-8", null)
            }
        },
        update = { webView ->
            if (!pageReady) return@AndroidView
            val renderKey = code to theme
            if (lastRendered == renderKey) return@AndroidView
            lastRendered = renderKey
            MermaidAssets.render(webView, code, theme)
        },
        // 渲染进程终止的实例已在 onRenderProcessGone 里拆完并 destroy 过，releaseSafely
        // 认标记直接跳过——再碰一次会抛 IllegalStateException。
        onRelease = { webView ->
            webView.releaseSafely { it.removeJavascriptInterface(MermaidBridge.INTERFACE_NAME) }
        },
    )
}

private class MermaidBridge(
    private val onResult: (ok: Boolean, heightPx: Double) -> Unit,
) {
    @JavascriptInterface
    fun postMessage(json: String) {
        runCatching {
            val payload = JSONObject(json)
            onResult(payload.optBoolean("ok", false), payload.optDouble("height", 0.0))
        }.onFailure { error ->
            Log.w("MermaidBlockView", "bridge parse failed", error)
            onResult(false, 0.0)
        }
    }

    companion object {
        const val INTERFACE_NAME = "MermaidBridge"
    }
}

private object MermaidAssets {
    private var cachedLibrary: String? = null

    private const val LIBRARY_INJECTED_TAG = "mermaid_library_injected"

    val pageHtml = """
        <!doctype html>
        <html>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
        <style>
          html, body { margin: 0; padding: 0; background: transparent; }
          #container { display: flex; justify-content: center; padding: 4px 0; box-sizing: border-box; }
          #container svg { max-width: 100%; height: auto; }
        </style>
        </head>
        <body><div id="container"></div></body>
        </html>
    """.trimIndent()

    private val runnerScript = """
        window.renderMermaid = async function(code, theme) {
          const post = (payload) => {
            window.${MermaidBridge.INTERFACE_NAME}.postMessage(JSON.stringify(payload));
          };
          try {
            if (typeof mermaid === 'undefined') {
              post({ ok: false, error: 'mermaid library missing' });
              return;
            }
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme });
            const { svg } = await mermaid.render('m' + Math.floor(Math.random() * 1e9), code);
            const el = document.getElementById('container');
            el.innerHTML = svg;
            requestAnimationFrame(() => {
              post({ ok: true, height: Math.ceil(el.getBoundingClientRect().height) });
            });
          } catch (e) {
            post({ ok: false, error: String(e) });
          }
        };
    """.trimIndent()

    fun ensureReady(webView: WebView): Boolean {
        if (webView.getTag(LIBRARY_INJECTED_TAG.hashCode()) == true) {
            return true
        }
        val library = cachedLibrary ?: runCatching {
            webView.context.assets.open("mermaid/mermaid.min.js").bufferedReader().use { it.readText() }
        }.getOrNull()?.also { cachedLibrary = it }

        if (library.isNullOrEmpty()) {
            Log.w("MermaidBlockView", "mermaid.min.js missing from assets")
            return false
        }

        webView.evaluateJavascript(library, null)
        webView.evaluateJavascript(runnerScript, null)
        webView.setTag(LIBRARY_INJECTED_TAG.hashCode(), true)
        return true
    }

    fun render(webView: WebView, code: String, theme: String) {
        val codeJson = JSONObject.quote(code)
        val themeJson = JSONObject.quote(theme)
        webView.evaluateJavascript("window.renderMermaid($codeJson, $themeJson)", null)
    }
}

private const val MERMAID_DEBOUNCE_MS = 350L
