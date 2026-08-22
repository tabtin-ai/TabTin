package com.tabtin.mobile.features.workbench

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 回归：Android 原生工作台资源首页必须消费应用主题，不能退回固定浅色色板。 */
class WorkbenchDarkThemeSourceTest {

    @Test
    fun nativeAppHomeFollowsTheApplicationTheme() {
        val appHomeSource = File(
            "src/main/java/com/tabtin/mobile/features/workbench/TaskResourceAppHomeScreen.kt",
        ).readText()

        assertTrue(appHomeSource.contains("LocalTTDarkTheme.current"))
        assertTrue(appHomeSource.contains("MaterialTheme.colorScheme"))
        assertFalse(appHomeSource.contains("canvas = Color(0xFFF4F4F5)"))
        assertFalse(appHomeSource.contains("surface = Color.White"))
    }
}
