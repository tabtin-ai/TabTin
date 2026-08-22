package com.tabtin.mobile.features.workbench

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 回归：工作台“开始新的”必须预填 Composer，并保持独立于全部应用的紧凑样式。 */
class WorkbenchQuickStartSourceTest {
    private val source = File(
        "src/main/java/com/tabtin/mobile/features/workbench/WorkbenchSheet.kt",
    ).readText()

    @Test
    fun quickStartRoutesToComposerInsteadOfOpeningAppHome() {
        val section = source.substringAfter("item(key = \"start_new\")")
            .substringBefore("item(key = \"all_apps\")")

        assertTrue(section.contains("onRequest = requestAppToComposer"))
        assertFalse(section.contains("onActivate = activateApp"))
    }

    @Test
    fun quickStartUsesDedicatedCompactAgentCard() {
        val grid = source.substringAfter("private fun QuickStartAppsGrid(")
            .substringBefore("private fun TaskOutputsEmptyState()")

        assertTrue(grid.contains("QuickStartAppTile("))
        assertTrue(grid.contains("variant = TabTinAppIconVariant.GLYPH"))
        assertTrue(grid.contains("workbench_quick_start_agent"))
        assertTrue(grid.contains("Icons.Default.Add"))
        assertFalse(grid.contains("CompactAppTile("))
    }
}
