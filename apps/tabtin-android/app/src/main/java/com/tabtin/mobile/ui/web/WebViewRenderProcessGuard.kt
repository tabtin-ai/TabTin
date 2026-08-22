package com.tabtin.mobile.ui.web

import android.util.Log
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import com.tabtin.mobile.R
import io.sentry.Sentry
import com.tabtin.mobile.sentry.DiagnosticRuntime

/**
 * WebView 渲染进程终止（`WebViewClient.onRenderProcessGone`）的统一兜底。
 *
 * **为什么每个 WebView 宿主都必须接**：Android 8.0+ 的 WebView 把渲染跑在独立进程里，系统内存
 * 紧张时会直接杀掉这个渲染进程。宿主如果没覆写 `onRenderProcessGone` 并返回 `true`，系统就认为
 * 宿主处理不了，会**连带杀掉 App 进程**——用户侧表现是没有堆栈的"闪退"，Sentry 也抓不到
 * 现场。移动端内存压力下这是必现路径，不是边缘 case。
 *
 * **处理口径（四步，缺一不可）**：
 *  1. 返回 `true`：告诉系统"宿主自己处理了"，保住 App 进程；
 *  2. 从父容器摘掉 + [WebView.destroy]：渲染进程没了之后这个实例永久不可用，继续复用
 *     （`loadUrl` / `reload`）会抛 `IllegalStateException`；
 *  3. 回调宿主 `onGone`，让宿主切到"加载失败 + 重试"的降级 UI，不留白屏；重试必须**新建**
 *     WebView 实例（宿主侧用 `key(...)` 或让承载 WebView 的 composable 整体离开组合树）；
 *  4. 区分 [RenderProcessGoneDetail.didCrash]：`true` 是渲染器真崩了（我们的页面有问题），
 *     上报 Sentry；`false` 是系统主动回收（内存紧张下的正常行为），只留 breadcrumb，
 *     不制造噪音事件。
 *
 * **Sentry 字段口径**遵循 `docs/agent/error-context-schema.md` 的白名单：只用已登记的
 * `handled_by`（本文件即契约里说的"兜底层 handler"），宿主名走 fingerprint 分组而不新造 tag 键；
 * 领域字段（user / organization_id / space_id）由 `SentryContextProvider` 统一写 scope。
 */
internal object WebViewRenderProcessGuard {

    private const val LOG_TAG = "WebViewRenderGuard"

    /** Sentry 分组根：同一根 + 宿主名，保证不同宿主分开聚合、同一宿主不炸开。 */
    private const val FINGERPRINT_ROOT = "android-webview-render-gone"

    /**
     * 覆写 `onRenderProcessGone` 时直接 `return WebViewRenderProcessGuard.handle(...)`。
     *
     * @param host 宿主标识（如 `tabsite_preview`），只进日志 / Sentry fingerprint，不含用户内容。
     * @param beforeDestroy destroy 之前需要拆的宿主自有资源（JS bridge、document-start 脚本等）；
     *                      渲染进程已死，这里抛异常不影响兜底流程，会被吞掉并记日志。
     * @param onGone 宿主切降级 UI 的回调，参数为"是否真崩溃"（`false` = 系统主动回收）。
     */
    internal fun handle(
        host: String,
        view: WebView?,
        detail: RenderProcessGoneDetail?,
        beforeDestroy: (WebView) -> Unit = {},
        onGone: (crashed: Boolean) -> Unit,
    ): Boolean {
        val crashed = detail?.didCrash() == true
        Log.w(LOG_TAG, "render process gone: host=$host crashed=$crashed")
        report(host, crashed)

        view?.let { webView ->
            // 先打标再拆：宿主 onRelease 走 [releaseSafely] 时据此跳过二次 destroy。
            webView.markRenderProcessGone()
            runCatching { beforeDestroy(webView) }.onFailure { error ->
                Log.w(LOG_TAG, "beforeDestroy failed: host=$host", error)
            }
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }

        onGone(crashed)
        return true
    }

    private fun report(host: String, crashed: Boolean) {
        if (!crashed) {
            // 系统主动回收是内存紧张下的正常行为，报成 error 事件只会淹没真问题；
            // 留 breadcrumb，后续真崩时能看到"崩之前系统已经在回收渲染进程了"。
            Sentry.addBreadcrumb("webview render process reclaimed by system (host=$host)", "webview")
            return
        }
        val bundleId = DiagnosticRuntime.capture(
            category = "WEBVIEW_CRASH",
            code = "ANDROID_WEBVIEW_RENDER_PROCESS_CRASH",
            handledBy = "android_webview_render_gone",
        )
        val sentryId = Sentry.captureException(WebViewRenderProcessCrash(host)) { scope ->
            scope.setTag("handled_by", "android_webview_render_gone")
            scope.setTag("error_category", "WEBVIEW_CRASH")
            scope.setTag("error_code", "ANDROID_WEBVIEW_RENDER_PROCESS_CRASH")
            scope.setTag("severity", "crash")
            scope.setTag("recoverability", "degraded")
            scope.setContexts("tabtin", DiagnosticRuntime.sentryContext(bundleId))
            scope.fingerprint = listOf(FINGERPRINT_ROOT, host)
        }
        DiagnosticRuntime.linkSentryAndEnqueue(bundleId, sentryId.toString())
    }
}

/**
 * 合成异常：渲染进程崩在另一个进程里，Java 侧没有真堆栈可抓，用一个稳定的异常类型
 * 给 Sentry 一个可读的事件标题（真正的分组靠 fingerprint）。
 */
private class WebViewRenderProcessCrash(host: String) :
    RuntimeException("WebView render process crashed (host=$host)")

/** 打上"渲染进程已终止"标记，见 [WebViewRenderProcessGuard]。 */
internal fun WebView.markRenderProcessGone() {
    setTag(R.id.tabtin_webview_render_process_gone, true)
}

/** 这个 WebView 实例是否已因渲染进程终止被销毁（销毁后任何调用都可能抛 `IllegalStateException`）。 */
internal fun WebView.isRenderProcessGone(): Boolean =
    getTag(R.id.tabtin_webview_render_process_gone) == true

/**
 * `AndroidView(onRelease = ...)` 里用它替代裸 `stopLoading() + destroy()`：
 * 渲染进程终止的实例已经在 [WebViewRenderProcessGuard.handle] 里销毁过，再碰会抛异常。
 */
internal fun WebView.releaseSafely(beforeDestroy: (WebView) -> Unit = {}) {
    if (isRenderProcessGone()) return
    beforeDestroy(this)
    stopLoading()
    destroy()
}
