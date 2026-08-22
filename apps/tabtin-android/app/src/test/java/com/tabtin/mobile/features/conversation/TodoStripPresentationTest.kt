package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentTodoItem
import com.tabtin.mobile.data.model.TodoStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TodoStripPresentationTest {
    @Test
    fun `collapsed strip shows current task and done over total without percent`() {
        val strip = TodoStripPresentation.make(
            todos = listOf(
                item("t1", "整理需求", TodoStatus.COMPLETED),
                item("t2", "实现 UI", TodoStatus.IN_PROGRESS),
                item("t3", "补测试", TodoStatus.PENDING),
                item("t4", "废弃步骤", TodoStatus.CANCELLED),
            ),
            paused = false,
            awaitingSubagents = false,
        )

        requireNotNull(strip)
        assertEquals(TodoStripPresentation.LabelKind.CURRENT, strip.labelKind)
        assertEquals("实现 UI", strip.currentContent)
        assertEquals("1/3", strip.progressText)
        assertFalse(strip.progressText.contains("%"))
        assertEquals(TodoStripPresentation.IconKind.IN_PROGRESS, strip.iconKind)
        assertTrue(strip.isRunning)
    }

    @Test
    fun `paused streaming shows paused current without spinner`() {
        val strip = TodoStripPresentation.make(
            todos = listOf(
                item("t1", "整理需求", TodoStatus.COMPLETED),
                item("t2", "实现 UI", TodoStatus.IN_PROGRESS),
                item("t3", "补测试", TodoStatus.PENDING),
            ),
            paused = true,
            awaitingSubagents = false,
        )

        requireNotNull(strip)
        assertEquals(TodoStripPresentation.LabelKind.PAUSED_CURRENT, strip.labelKind)
        assertEquals("实现 UI", strip.currentContent)
        assertEquals("1/3", strip.progressText)
        assertEquals(TodoStripPresentation.IconKind.PAUSED, strip.iconKind)
        assertFalse(strip.isRunning)
    }

    @Test
    fun `awaiting subagents beats paused label`() {
        val strip = TodoStripPresentation.make(
            todos = listOf(
                item("t1", "整理需求", TodoStatus.COMPLETED),
                item("t2", "等待研究员汇总", TodoStatus.IN_PROGRESS),
                item("t3", "补测试", TodoStatus.PENDING),
            ),
            paused = true,
            awaitingSubagents = true,
        )

        requireNotNull(strip)
        assertEquals(TodoStripPresentation.LabelKind.AWAITING_SUBAGENTS, strip.labelKind)
        assertEquals("等待研究员汇总", strip.currentContent)
        assertFalse(strip.isRunning)
    }

    @Test
    fun `all done keeps the strip visible`() {
        val strip = TodoStripPresentation.make(
            todos = listOf(
                item("t1", "整理需求", TodoStatus.COMPLETED),
                item("t2", "实现 UI", TodoStatus.COMPLETED),
            ),
            paused = true,
            awaitingSubagents = false,
        )

        requireNotNull(strip)
        assertEquals(TodoStripPresentation.LabelKind.ALL_DONE, strip.labelKind)
        assertEquals("2/2", strip.progressText)
        assertEquals(TodoStripPresentation.IconKind.COMPLETE, strip.iconKind)
    }

    @Test
    fun `empty todos hide the strip`() {
        assertNull(
            TodoStripPresentation.make(
                todos = emptyList(),
                paused = false,
                awaitingSubagents = false,
            ),
        )
    }

    private fun item(id: String, content: String, status: TodoStatus) =
        AgentTodoItem(id = id, content = content, status = status)
}
