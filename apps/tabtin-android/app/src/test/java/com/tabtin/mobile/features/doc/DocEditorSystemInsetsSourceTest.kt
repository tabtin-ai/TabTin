package com.tabtin.mobile.features.doc

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 回归：格式栏的底部对齐必须落在 Box 的直接子节点上，并避让可见键盘。 */
class DocEditorSystemInsetsSourceTest {

    @Test
    fun productionBottomToolbarsHandleNavigationBarsInsideImeAwareOverlay() {
        val formatToolbarSource = File(
            "src/main/java/com/tabtin/mobile/features/doc/editor/interaction/DocFormatToolbar.kt",
        ).readText().replace(Regex("\\s+"), "")
        assertTrue(
            "the edge-to-edge editor must consume the full IME inset so the toolbar ends at the keyboard's top edge",
            formatToolbarSource.contains("windowInsetsPadding(WindowInsets.ime)"),
        )
        assertFalse(
            "subtracting the navigation bar leaves the toolbar one navigation-bar height behind the keyboard",
            formatToolbarSource.contains("WindowInsets.ime.exclude(WindowInsets.navigationBars)"),
        )

        val selectionToolbarSource = File(
            "src/main/java/com/tabtin/mobile/features/doc/editor/interaction/SelectionToolbar.kt",
        ).readText()
        assertTrue(
            "the selection toolbar must avoid system navigation bars",
            selectionToolbarSource.contains(".navigationBarsPadding()"),
        )
        assertTrue(
            "the selection toolbar must not stack navigation-bar padding below a visible IME",
            selectionToolbarSource.contains("if (imeVisible) Modifier else Modifier.navigationBarsPadding()"),
        )

        val reviewSource = File(
            "src/main/java/com/tabtin/mobile/features/doc/DocEditorScreen.kt",
        ).readText()
        assertTrue(
            "the review save bar follows the same keyboard/navigation-bar rule",
            reviewSource.contains("if (imeVisible) Modifier else Modifier.navigationBarsPadding()"),
        )
    }

    @Test
    fun editorFormatToolbarAlignsItsDirectAnimatedChildAboveIme() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/doc/DocEditorScreen.kt",
        ).readText()
        val toolbarSource = File(
            "src/main/java/com/tabtin/mobile/features/doc/editor/interaction/DocFormatToolbar.kt",
        ).readText()
        val compactToolbarSource = toolbarSource.replace(Regex("\\s+"), "")

        assertFalse(source.contains(".padding(padding).imePadding()"))
        assertFalse(source.contains(".padding(padding)\n                .imePadding()"))
        assertTrue(
            "Box alignment must be applied to AnimatedVisibility itself; applying it to its nested Surface leaves the toolbar at the top",
            compactToolbarSource.contains("AnimatedVisibility(modifier=modifier.windowInsetsPadding("),
        )
        assertFalse(
            "the caller's BoxScope align modifier must not be swallowed by the nested Surface",
            compactToolbarSource.contains("Surface(modifier=modifier"),
        )
        assertTrue(
            "the full-height edge-to-edge window requires one IME inset on the aligned toolbar",
            compactToolbarSource.contains("windowInsetsPadding(WindowInsets.ime"),
        )
        assertTrue(
            "the format toolbar must disappear when the keyboard is hidden instead of covering document chrome",
            source.contains("state.showFormatToolbar && imeVisible"),
        )
        assertTrue(
            "the editor background must dismiss Android and Compose focus without intercepting block taps",
            source.contains("installBlankAreaTapHandler") &&
                source.contains("focusManager.clearFocus(force = true)"),
        )
        assertTrue(source.contains("modifier = Modifier.align(Alignment.BottomCenter)"))
        val manifest = File("src/debug/AndroidManifest.xml").readText()
        assertTrue(
            "the review Activity must use the same adjustResize keyboard policy as MainActivity",
            manifest.contains("android:name=\"com.tabtin.mobile.debug.NativeCloudDocsReviewActivity\"") &&
                manifest.contains("android:windowSoftInputMode=\"adjustResize\""),
        )
        assertTrue(
            "the review Activity must match the phone product's portrait-only contract",
            manifest.contains("android:screenOrientation=\"portrait\""),
        )
        val reviewActivity = File(
            "src/debug/java/com/tabtin/mobile/debug/NativeCloudDocsReviewActivity.kt",
        ).readText()
        assertTrue(
            "the debug-only review tabs must not keep reserving height behind the keyboard",
            reviewActivity.contains("if (!imeVisible) NavigationBar"),
        )
    }
}
