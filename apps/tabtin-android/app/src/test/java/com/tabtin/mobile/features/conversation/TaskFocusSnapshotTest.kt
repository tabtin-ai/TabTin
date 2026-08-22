package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.features.workbench.WorkbenchFocusTarget
import com.tabtin.mobile.features.workbench.WorkbenchNavigationPane
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskFocusSnapshotTest {
    @Test
    fun `tabdoc appMeta uses field names not bare id title`() {
        val target = WorkbenchFocusTarget(
            appType = "tabdoc",
            resourceId = "doc-1",
            title = "周报",
            pane = WorkbenchNavigationPane.Detail(
                kind = null,
                request = WorkbenchResourceOpenRequest(
                    resourceType = "tabdoc",
                    resourceId = "doc-1",
                    title = "周报",
                ),
            ),
        )
        val focus = TaskFocusSnapshot.from(spaceId = "space-1", target = target)
        val meta = focus.appMeta!!
        assertEquals("current_doc_id", (meta["idField"] as JsonPrimitive).contentOrNull)
        assertEquals("current_doc_title", (meta["titleField"] as JsonPrimitive).contentOrNull)
        assertEquals("doc-1", (meta["current_doc_id"] as JsonPrimitive).contentOrNull)
        assertEquals("周报", (meta["current_doc_title"] as JsonPrimitive).contentOrNull)
        assertNull(meta["id"])
        assertNull(meta["title"])
        assertEquals("doc-1", focus.openTabs!!.single().id)
    }

    @Test
    fun `overview focus has no appMeta resource`() {
        val focus = TaskFocusSnapshot.from(
            spaceId = "space-1",
            target = WorkbenchFocusTarget.fromPane(WorkbenchNavigationPane.Overview),
        )
        assertNull(focus.appType)
        assertNull(focus.appMeta)
        assertTrue(focus.openTabs.isNullOrEmpty())
        assertEquals("conversation", focus.workspaceMode)
    }

    @Test
    fun `detail focus uses desktop workspaceMode and real resource id`() {
        val target = WorkbenchFocusTarget.fromPane(
            WorkbenchNavigationPane.Detail(
                kind = null,
                request = WorkbenchResourceOpenRequest(
                    resourceType = "tabdoc",
                    resourceId = "doc-real",
                    title = "真文档",
                ),
            ),
        )
        val focus = TaskFocusSnapshot.from(spaceId = "space-1", target = target)
        assertEquals("desktop", focus.workspaceMode)
        assertEquals("doc-real", focus.appMeta!!["current_doc_id"]!!.let { (it as JsonPrimitive).contentOrNull })
        assertEquals("doc-real", focus.openTabs!!.single().id)
    }

    @Test
    fun `app home does not write appId as document id`() {
        val target = WorkbenchFocusTarget.fromPane(
            WorkbenchNavigationPane.AppHome(
                kind = com.tabtin.mobile.features.workbench.WorkbenchAppHomeKind.TABDOC,
            ),
        )
        val focus = TaskFocusSnapshot.from(spaceId = "space-1", target = target)
        assertEquals("tabdoc", focus.appType)
        assertEquals("desktop", focus.workspaceMode)
        assertEquals(true, focus.openTabs!!.single().is_home)
        assertNull(focus.openTabs!!.single().id)
        assertEquals("tabdoc", (focus.appMeta!!["current_app_home"] as JsonPrimitive).contentOrNull)
        assertNull(focus.appMeta!!["current_doc_id"])
        assertNull(focus.appMeta!!["idField"])
    }

    @Test
    fun `appMetaFieldsFor covers common apps`() {
        assertEquals(
            "current_table_id",
            TaskFocusSnapshot.appMetaFieldsFor("tabdata")!!.idField,
        )
        assertEquals(
            "current_slide_title",
            TaskFocusSnapshot.appMetaFieldsFor("tabslide")!!.titleField,
        )
    }

    @Test
    fun `tabdata appMeta includes current_view_id when viewId present`() {
        val target = WorkbenchFocusTarget(
            appType = "tabdata",
            resourceId = "table-1",
            title = "销售表",
            viewId = "view-abc",
            pane = WorkbenchNavigationPane.Detail(
                kind = null,
                request = WorkbenchResourceOpenRequest(
                    resourceType = "tabdata",
                    resourceId = "table-1",
                    title = "销售表",
                ),
            ),
        )
        val focus = TaskFocusSnapshot.from(spaceId = "space-1", target = target)
        val meta = focus.appMeta!!
        assertEquals("current_table_id", (meta["idField"] as JsonPrimitive).contentOrNull)
        assertEquals("table-1", (meta["current_table_id"] as JsonPrimitive).contentOrNull)
        assertEquals("view-abc", (meta["current_view_id"] as JsonPrimitive).contentOrNull)
        assertEquals("desktop", focus.workspaceMode)
    }

    @Test
    fun `tabdata appMeta omits current_view_id when viewId null`() {
        val target = WorkbenchFocusTarget(
            appType = "tabdata",
            resourceId = "table-1",
            title = "销售表",
            viewId = null,
            pane = WorkbenchNavigationPane.Detail(
                kind = null,
                request = WorkbenchResourceOpenRequest(
                    resourceType = "tabdata",
                    resourceId = "table-1",
                    title = "销售表",
                ),
            ),
        )
        val focus = TaskFocusSnapshot.from(spaceId = "space-1", target = target)
        assertEquals("table-1", (focus.appMeta!!["current_table_id"] as JsonPrimitive).contentOrNull)
        assertNull(focus.appMeta!!["current_view_id"])
    }

    @Test
    fun `tabdata blank viewId does not write current_view_id`() {
        val target = WorkbenchFocusTarget(
            appType = "tabdata",
            resourceId = "table-1",
            viewId = "   ",
            pane = WorkbenchNavigationPane.Detail(
                kind = null,
                request = WorkbenchResourceOpenRequest(
                    resourceType = "tabdata",
                    resourceId = "table-1",
                ),
            ),
        )
        val focus = TaskFocusSnapshot.from(spaceId = "space-1", target = target)
        assertNull(focus.appMeta!!["current_view_id"])
    }
}
