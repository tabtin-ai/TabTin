package com.tabtin.mobile.ui.web

import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.widget.FrameLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

/**
 * WebView 渲染进程终止兜底的契约测试。
 *
 * 覆盖 [WebViewRenderProcessGuard] 的四条硬约束：返回 true 保住 App 进程、把失效实例摘出容器
 * 并销毁、回调宿主切降级 UI、区分真崩溃与系统回收。真机上的"渲染进程被杀"没法在 JVM 里造，
 * 但宿主侧要做的动作全在这一层，可以完整断言。
 */
@RunWith(RobolectricTestRunner::class)
class WebViewRenderProcessGuardTest {

    // RenderProcessGoneDetail 的构造器标了 deprecated（框架不希望业务自己造实例），
    // 但测试里必须造一个来喂 onRenderProcessGone，没有别的路。
    @Suppress("DEPRECATION")
    private class FakeDetail(private val crashed: Boolean) : RenderProcessGoneDetail() {
        override fun didCrash(): Boolean = crashed
        override fun rendererPriorityAtExit(): Int = 0
    }

    private fun attachedWebView(): Pair<FrameLayout, WebView> {
        val context = RuntimeEnvironment.getApplication()
        val parent = FrameLayout(context)
        val webView = WebView(context)
        parent.addView(webView)
        return parent to webView
    }

    @Test
    fun `returns true so the system does not kill the host app process`() {
        val (_, webView) = attachedWebView()

        val handled = WebViewRenderProcessGuard.handle(
            host = "test_host",
            view = webView,
            detail = FakeDetail(crashed = true),
            onGone = {},
        )

        assertTrue("必须返回 true，否则系统会连带杀掉 App 进程", handled)
    }

    @Test
    fun `detaches and destroys the dead WebView so it can never be reused`() {
        val (parent, webView) = attachedWebView()

        WebViewRenderProcessGuard.handle(
            host = "test_host",
            view = webView,
            detail = FakeDetail(crashed = false),
            onGone = {},
        )

        assertEquals("失效实例必须从父容器摘掉", 0, parent.childCount)
        assertNull(webView.parent)
        assertTrue("失效实例必须 destroy", shadowOf(webView).wasDestroyCalled())
        assertTrue("必须打上标记，供 releaseSafely 识别", webView.isRenderProcessGone())
    }

    @Test
    fun `reports whether the renderer really crashed so hosts can tell the two apart`() {
        val crashedFlags = mutableListOf<Boolean>()

        val (_, crashedView) = attachedWebView()
        WebViewRenderProcessGuard.handle(
            host = "test_host",
            view = crashedView,
            detail = FakeDetail(crashed = true),
            onGone = { crashedFlags += it },
        )

        val (_, reclaimedView) = attachedWebView()
        WebViewRenderProcessGuard.handle(
            host = "test_host",
            view = reclaimedView,
            detail = FakeDetail(crashed = false),
            onGone = { crashedFlags += it },
        )

        // detail 为 null（理论上不该发生）按"系统回收"处理，宁可少报也不误报崩溃。
        val (_, nullDetailView) = attachedWebView()
        WebViewRenderProcessGuard.handle(
            host = "test_host",
            view = nullDetailView,
            detail = null,
            onGone = { crashedFlags += it },
        )

        assertEquals(listOf(true, false, false), crashedFlags)
    }

    @Test
    fun `runs host teardown before destroy and survives a failing teardown`() {
        val (_, webView) = attachedWebView()
        var tornDown = false
        var wentGone = false

        val handled = WebViewRenderProcessGuard.handle(
            host = "test_host",
            view = webView,
            detail = FakeDetail(crashed = true),
            beforeDestroy = {
                tornDown = true
                error("拆 JS bridge 时炸了")
            },
            onGone = { wentGone = true },
        )

        assertTrue("宿主自有资源要先拆", tornDown)
        assertTrue("拆资源失败不能影响兜底：仍要返回 true", handled)
        assertTrue("拆资源失败不能影响兜底：仍要通知宿主降级", wentGone)
        assertTrue("拆资源失败不能影响兜底：仍要销毁实例", shadowOf(webView).wasDestroyCalled())
    }

    @Test
    fun `releaseSafely skips a WebView that was already destroyed by the guard`() {
        val (_, webView) = attachedWebView()
        WebViewRenderProcessGuard.handle(
            host = "test_host",
            view = webView,
            detail = FakeDetail(crashed = true),
            onGone = {},
        )

        var teardownRan = false
        webView.releaseSafely { teardownRan = true }

        assertFalse("已销毁的实例不能再碰，否则抛 IllegalStateException", teardownRan)
    }

    @Test
    fun `releaseSafely tears down and destroys a healthy WebView`() {
        val (_, webView) = attachedWebView()
        var teardownRan = false

        webView.releaseSafely { teardownRan = true }

        assertTrue(teardownRan)
        assertTrue(shadowOf(webView).wasDestroyCalled())
    }
}
