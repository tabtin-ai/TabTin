package com.tabtin.mobile.navigation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 原生云文档的「完整编辑器」跳转由 ViewModel 的一次性事件在 LaunchedEffect 里驱动，不是
 * 直接的点击回调。navigateOnce 的 RESUMED 闸门会把这类跳转静默丢弃（见 NavControllerExt
 * 的用法约定），事件又是 tryEmit 发出、不会重投，用户点了没反应且没有任何日志。
 *
 * 只读记录字段唯一的编辑退路就是这个入口，所以它必须保证投递，同时靠 launchSingleTop 兜住
 * 连点重复压栈——那正是 navigateOnce 原本想解决的问题。
 */
class CloudResourceFullEditorNavigationSourceTest {

    private fun openFullEditorBlock(): String {
        val source = File(
            "src/main/java/com/tabtin/mobile/navigation/AppNavigation.kt",
        ).readText()
        val start = source.indexOf("val openFullEditor = {")
        assertTrue("AppNavigation 里找不到 openFullEditor 定义", start >= 0)
        val end = source.indexOf("when (route.resourceType)", start)
        assertTrue("openFullEditor 之后找不到资源类型分发", end > start)
        return source.substring(start, end)
    }

    @Test
    fun fullEditorNavigationBypassesUserClickGate() {
        assertFalse(
            "完整编辑器跳转不能过 navigateOnce 闸门，否则会被静默丢弃",
            openFullEditorBlock().contains("navigateOnce"),
        )
    }

    @Test
    fun fullEditorNavigationStaysSingleTop() {
        assertTrue(
            "绕过闸门后要用 launchSingleTop 防止连点重复压栈",
            openFullEditorBlock().contains("launchSingleTop = true"),
        )
    }
}
