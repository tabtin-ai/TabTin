package com.tabtin.mobile.features.files

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CloudDriveImageViewportSourceTest {
    private val previewSource = File(
        "src/main/java/com/tabtin/mobile/features/files/CloudDriveRecentPreviewSheet.kt",
    ).readText()
    private val heroSource = File(
        "src/main/java/com/tabtin/mobile/features/files/CloudDriveAppHomeSections.kt",
    ).readText()
    private val workbenchSource = File(
        "src/main/java/com/tabtin/mobile/features/workbench/WorkbenchSheet.kt",
    ).readText()

    @Test
    fun imageViewportLoadsSignedPreviewInsteadOfPlaceholderOnly() {
        assertTrue(previewSource.contains("rememberCloudFileSignedPreviewUrl("))
        assertTrue(previewSource.contains("AsyncImage("))
        assertTrue(previewSource.contains("CloudDriveImagePreview(row = row"))
    }

    @Test
    fun workbenchResumeReusesCloudDriveViewportCardForFiles() {
        val resume = workbenchSource
            .substringAfter("private fun ResumeOutputCard(")
            .substringBefore("private fun OutputBarsList(")
        assertTrue(resume.contains("CloudDriveFileViewportCard("))
        assertTrue(heroSource.contains("fun CloudDriveFileViewportCard("))
        assertTrue(heroSource.contains("CloudDriveAdaptivePreview("))
    }
}
