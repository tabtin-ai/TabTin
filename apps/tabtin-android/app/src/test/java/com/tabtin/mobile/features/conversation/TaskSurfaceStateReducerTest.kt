package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.features.workbench.WorkbenchFocusTarget
import com.tabtin.mobile.features.workbench.WorkbenchNavigationPane
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskSurfaceStateReducerTest {

    private val docFocus = WorkbenchFocusTarget(
        appType = "tabdoc",
        resourceId = "doc-1",
        title = "移动端任务连续性升级 · PRD",
    )

    private fun openedOnDoc() = TaskSurfaceStateSnapshot(
        workbenchOpen = true,
        preferAppFocus = true,
        everOpened = true,
        pendingOpenRequest = WorkbenchResourceOpenRequest(
            resourceType = "tabdoc",
            resourceId = "doc-1",
            title = "移动端任务连续性升级 · PRD",
        ),
        focus = docFocus,
    )

    @Test
    fun `chat focus keeps current workbench focus`() {
        val next = TaskSurfaceStateReducer.apply(
            state = openedOnDoc(),
            mode = TaskSurfaceMode.CHAT_FOCUS,
            switcherEnabled = true,
        )
        assertEquals(docFocus, next.focus)
    }

    @Test
    fun `chat focus still clears one-shot deep link request`() {
        val next = TaskSurfaceStateReducer.apply(
            state = openedOnDoc(),
            mode = TaskSurfaceMode.CHAT_FOCUS,
            switcherEnabled = true,
        )
        assertNull(next.pendingOpenRequest)
        assertFalse(next.workbenchOpen)
        assertFalse(next.preferAppFocus)
    }

    @Test
    fun `chat focus preserves ever opened so workbench stays mounted`() {
        val next = TaskSurfaceStateReducer.apply(
            state = openedOnDoc(),
            mode = TaskSurfaceMode.CHAT_FOCUS,
            switcherEnabled = true,
        )
        assertTrue(next.everOpened)
    }

    @Test
    fun `split opens workbench without app focus and marks ever opened`() {
        val next = TaskSurfaceStateReducer.apply(
            state = TaskSurfaceStateSnapshot(focus = docFocus),
            mode = TaskSurfaceMode.SPLIT,
            switcherEnabled = true,
        )
        assertTrue(next.workbenchOpen)
        assertFalse(next.preferAppFocus)
        assertTrue(next.everOpened)
        assertEquals(docFocus, next.focus)
    }

    @Test
    fun `app focus opens workbench with app focus`() {
        val next = TaskSurfaceStateReducer.apply(
            state = TaskSurfaceStateSnapshot(focus = docFocus),
            mode = TaskSurfaceMode.APP_FOCUS,
            switcherEnabled = true,
        )
        assertTrue(next.workbenchOpen)
        assertTrue(next.preferAppFocus)
        assertTrue(next.everOpened)
    }

    @Test
    fun `resource request enters workbench app focus atomically`() {
        val request = WorkbenchResourceOpenRequest(
            resourceType = "tabdata",
            resourceId = "table-1",
            title = "发布清单",
        )

        val next = TaskSurfaceStateReducer.openResource(
            state = TaskSurfaceStateSnapshot(focus = docFocus),
            request = request,
            switcherEnabled = true,
        )

        assertTrue(next.workbenchOpen)
        assertTrue(next.preferAppFocus)
        assertTrue(next.everOpened)
        assertEquals(request, next.pendingOpenRequest)
        assertEquals(docFocus, next.focus)
    }

    @Test
    fun `switcher disabled ignores everything except chat focus`() {
        val opened = openedOnDoc()
        assertEquals(
            opened,
            TaskSurfaceStateReducer.apply(opened, TaskSurfaceMode.SPLIT, switcherEnabled = false),
        )
        assertEquals(
            opened,
            TaskSurfaceStateReducer.apply(opened, TaskSurfaceMode.APP_FOCUS, switcherEnabled = false),
        )
        val collapsed =
            TaskSurfaceStateReducer.apply(opened, TaskSurfaceMode.CHAT_FOCUS, switcherEnabled = false)
        assertFalse(collapsed.workbenchOpen)
    }

    @Test
    fun `overview focus stays overview when collapsing`() {
        val overview = WorkbenchFocusTarget.fromPane(WorkbenchNavigationPane.Overview)
        val next = TaskSurfaceStateReducer.apply(
            state = TaskSurfaceStateSnapshot(workbenchOpen = true, focus = overview),
            mode = TaskSurfaceMode.CHAT_FOCUS,
            switcherEnabled = true,
        )
        assertEquals(overview, next.focus)
    }
}
