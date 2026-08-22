package com.tabtin.mobile.features.doc

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 回归：退后台与退出编辑面都必须主动收口原生文档保存。 */
class DocEditorSaveLifecycleSourceTest {

    @Test
    fun editorFlushesOnPauseAndBeforeLeavingDirtyContent() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/doc/DocEditorScreen.kt",
        ).readText()
        val compactSource = source.replace(Regex("\\s+"), "")

        assertTrue(
            "backgrounding the editor must persist and flush pending changes",
            compactSource.contains("onPauseOrDispose{viewModel.flushForLifecycle()}"),
        )
        assertTrue(
            "back navigation must wait for a dirty save before leaving the ViewModel scope",
            source.contains("val saved = viewModel.flush()") &&
                compactSource.contains("if(saved)onBack()elseshowDiscardDialog=true"),
        )
    }
}
