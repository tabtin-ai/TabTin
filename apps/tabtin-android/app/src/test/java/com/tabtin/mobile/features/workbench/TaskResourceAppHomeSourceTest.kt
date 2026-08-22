package com.tabtin.mobile.features.workbench

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 回归：文档 / 多维表 App 首页应对齐 iOS 的继续卡片与资源范围筛选。 */
class TaskResourceAppHomeSourceTest {
    private val screenSource = File(
        "src/main/java/com/tabtin/mobile/features/workbench/TaskResourceAppHomeScreen.kt",
    ).readText()
    @Test
    fun continueCardContainsStatusAndContentPreview() {
        val card = screenSource.substringAfter("private fun ContinueResourceCard(")
            .substringBefore("private fun CreateActionCard(")

        assertTrue(card.contains("ContinueResourcePreview("))
        assertTrue(card.contains("TaskResourceCollaborationMeta("))
        assertTrue(card.contains("originText"))
        assertTrue(card.contains("item.preview"))
        assertTrue(screenSource.contains("!continueItem.lastVisitedAt.isNullOrBlank()"))
        assertTrue(screenSource.contains("workbench_apphome_resume_recent"))
    }

    @Test
    fun miniPreviewUsesTheSameInformationHierarchyAsImResourceCards() {
        assertTrue(screenSource.contains("private fun TaskResourcePreviewTypePill("))
        assertTrue(screenSource.contains("private fun TaskResourceTablePreviewGrid("))
        assertTrue(screenSource.contains("workbench_apphome_table_type"))
        assertTrue(screenSource.contains("workbench_apphome_doc_type"))
    }

    @Test
    fun continueCardOpensNativePreviewBeforeOpeningTheResource() {
        val previewSheet = screenSource
            .substringAfter("private fun TaskResourceNativePreviewSheet(")
            .substringBefore("private fun ContinueResourceCard(")

        assertTrue(screenSource.contains("var previewItem by remember(kind)"))
        assertTrue(screenSource.contains("onClick = { previewItem = continueItem }"))
        assertTrue(previewSheet.contains("TTBottomSheet("))
        assertTrue(previewSheet.contains("skipPartiallyExpanded = false"))
        assertTrue(previewSheet.contains("target != SheetValue.Expanded"))
        assertTrue(previewSheet.contains(".height(210.dp)"))
        assertTrue(screenSource.contains("onOpenResource(item)"))
    }

    @Test
    fun resourceLibraryUsesThreeRealScopesAndDedicatedEmptyState() {
        assertTrue(screenSource.contains("private fun TaskResourceLibrarySection("))
        assertTrue(screenSource.contains("private fun TaskResourceLibraryEmptyState("))
        assertTrue(screenSource.contains("TaskResourceLibraryScope.RECENT"))
        assertTrue(screenSource.contains("TaskResourceLibraryScope.ALL"))
        assertTrue(screenSource.contains("TaskResourceLibraryScope.SHARED"))
        assertTrue(screenSource.contains("sharedResourceIds"))
    }
}
