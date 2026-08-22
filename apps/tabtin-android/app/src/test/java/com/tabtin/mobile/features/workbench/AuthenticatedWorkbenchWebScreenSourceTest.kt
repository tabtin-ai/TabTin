package com.tabtin.mobile.features.workbench

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 回归：工作台 WebView 必须把网页 file input 接到系统文件选择器。 */
class AuthenticatedWorkbenchWebScreenSourceTest {

    @Test
    fun workbenchWebViewHandlesFileChooserResults() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/workbench/AuthenticatedWorkbenchWebScreen.kt",
        ).readText()

        assertTrue(source.contains("override fun onShowFileChooser("))
        assertTrue(source.contains("fileChooserParams?.createIntent()"))
        assertTrue(source.contains("FileChooserParams.parseResult"))
    }

    @Test
    fun workbenchWebViewReplaysHostContextAcrossDocumentNavigation() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/workbench/AuthenticatedWorkbenchWebScreen.kt",
        ).readText()

        assertTrue(source.contains("replaceDocumentStartHostScript("))
        assertTrue(source.contains("mobileHostInjectionScript(expectedOrigin, mobileFormFactor)"))
        assertTrue(source.contains("hostDocumentStartScriptHandler.value?.remove()"))
    }

    @Test
    fun workbenchWebViewKeepsDocumentPinchZoomAvailable() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/workbench/AuthenticatedWorkbenchWebScreen.kt",
        ).readText()

        assertTrue(source.contains("settings.setSupportZoom(true)"))
        assertTrue(source.contains("settings.builtInZoomControls = true"))
        assertTrue(source.contains("settings.displayZoomControls = false"))
    }

    @Test
    fun workbenchWebViewCoversTheInitialNavigationFrameWithThemeLoadingState() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/workbench/AuthenticatedWorkbenchWebScreen.kt",
        ).readText()

        assertTrue(source.contains(".background(MaterialTheme.colorScheme.background)"))
        assertTrue(source.contains("setBackgroundColor(Color.TRANSPARENT)"))
        assertTrue(source.contains("WorkbenchLoadingCover("))
        assertTrue(source.contains("if (showWebLoadingCover)"))
    }

    @Test
    fun webLoadingCoverDoesNotHideUnavailableOrErrorStates() {
        assertTrue(
            shouldShowWorkbenchWebLoadingCover(
                hasTarget = true,
                hasAuthSnapshot = true,
                isLoading = true,
                hasError = false,
            ),
        )
        assertFalse(
            shouldShowWorkbenchWebLoadingCover(
                hasTarget = false,
                hasAuthSnapshot = true,
                isLoading = true,
                hasError = false,
            ),
        )
        assertFalse(
            shouldShowWorkbenchWebLoadingCover(
                hasTarget = true,
                hasAuthSnapshot = true,
                isLoading = true,
                hasError = true,
            ),
        )
    }
}
