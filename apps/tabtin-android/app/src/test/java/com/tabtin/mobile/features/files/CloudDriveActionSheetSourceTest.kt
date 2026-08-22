package com.tabtin.mobile.features.files

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 回归：云盘写入面板标题必须与下方操作项形成视觉与语义层级。 */
class CloudDriveActionSheetSourceTest {

    @Test
    fun actionSheetTitleUsesSubtitleSemiboldAndHeadingSemantics() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/files/CloudDriveActionSheet.kt",
        ).readText()
        val titleBlock = source.substringAfter(
            "text = stringResource(R.string.cloud_drive_actions_title)",
        ).substringBefore("if (canWrite)")

        assertTrue(titleBlock.contains("style = TTFonts.subtitleSemibold"))
        assertTrue(titleBlock.contains("heading()"))
    }

    @Test
    fun actionSheetDoesNotRenderRedundantWriteFooter() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/files/CloudDriveActionSheet.kt",
        ).readText()

        assertTrue(!source.contains("cloud_drive_write_actions_footer"))
    }
}
