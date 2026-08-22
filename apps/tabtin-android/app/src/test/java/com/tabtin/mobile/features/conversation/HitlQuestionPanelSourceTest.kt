package com.tabtin.mobile.features.conversation

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class HitlQuestionPanelSourceTest {

    private val sourceRoot = File("src/main/java/com/tabtin/mobile/features/conversation")

    @Test
    fun `long hitl panels scroll their content while keeping actions outside the viewport`() {
        val container = File(sourceRoot, "HitlQuestionPanel.kt")
        assertTrue("HITL 面板应复用受视口约束的容器", container.isFile)

        val source = container.readText()
        assertTrue(source.contains("BoxWithConstraints"))
        assertTrue(source.contains(".heightIn(max = maxHeight)"))
        assertTrue(source.contains(".weight(1f, fill = false)"))
        assertTrue(source.contains(".verticalScroll(rememberScrollState())"))

        val scrollIndex = source.indexOf(".verticalScroll(rememberScrollState())")
        val actionsIndex = source.indexOf("actions()")
        assertTrue("底部操作区必须位于滚动内容之后", scrollIndex >= 0 && actionsIndex > scrollIndex)

        listOf("AskFormPanelView.kt", "AskUserPanelView.kt").forEach { filename ->
            val panelSource = File(sourceRoot, filename).readText()
            assertTrue("$filename 应复用 HitlQuestionPanel", panelSource.contains("HitlQuestionPanel("))
        }

        val hostSource = File(sourceRoot, "ConversationView.kt").readText()
        listOf("AskFormPanelView(", "AskUserPanelView(").forEach { call ->
            val callBody = hostSource.substringAfter(call).substringBefore("\n                )")
            assertTrue("$call 应只占用 Composer 剩余高度", callBody.contains(".weight(1f, fill = false)"))
        }
    }
}
