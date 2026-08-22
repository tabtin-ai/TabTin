package com.tabtin.mobile.features.workbench

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkbenchAppHomeTest {

    @Test
    fun `navigation back chain is detail then app home then overview`() {
        val state = WorkbenchAppHomeNavigationState()
        state.showAppHome(WorkbenchAppHomeKind.TABMEMO)
        state.showDetail(
            WorkbenchResourceOpenRequest("tabmemo", "memo-1", title = "Note"),
            kind = WorkbenchAppHomeKind.TABMEMO,
        )
        assertTrue(state.pane is WorkbenchNavigationPane.Detail)
        assertTrue(state.goBack())
        assertEquals(WorkbenchAppHomeKind.TABMEMO, (state.pane as WorkbenchNavigationPane.AppHome).kind)
        assertTrue(state.goBack())
        assertEquals(WorkbenchNavigationPane.Overview, state.pane)
        assertFalse(state.goBack())
    }

    @Test
    fun `organization scope change clears app home`() {
        val state = WorkbenchAppHomeNavigationState()
        state.showAppHome(WorkbenchAppHomeKind.TABFILES)
        state.resetForScopeChange()
        assertEquals(WorkbenchNavigationPane.Overview, state.pane)
    }

    @Test
    fun `direct task output detail returns to overview`() {
        val state = WorkbenchAppHomeNavigationState()
        state.showDirectDetail(
            WorkbenchResourceOpenRequest("tabdoc", "doc-1", title = "周报"),
        )

        assertTrue(state.goBack())
        assertEquals(WorkbenchNavigationPane.Overview, state.pane)
    }

    @Test
    fun `files card stays enterable with zero resources`() {
        // tabmemo 已从 overview 投影隐藏；零资源可进只覆盖仍露出的 App 首页（云盘）。
        val catalog = listOf(
            TaskWorkbenchCatalogApp(
                id = "tabfiles",
                name = "Files",
                surface = "collaborative",
                installed = true,
                order = 2,
                mobileMode = "full",
            ),
        )
        val workspace = listOf(
            TaskWorkbenchWorkspaceApp(id = "tabfiles", name = "Files", canCreate = false, enabled = true, order = 2, surface = "collaborative"),
        )
        val apps = TaskWorkbenchAppProjector.project(catalog, workspace, resources = emptyList())
        assertEquals(1, apps.size)
        val files = apps.single()
        assertEquals("tabfiles", files.id)
        assertEquals(TaskWorkbenchAppActivation.OPEN_APP_HOME, files.activation)
        assertEquals(0, files.resourceCount)
        assertEquals("进入", files.actionLabel)
    }

    @Test
    fun `mobile_mode unsupported blocks app home`() {
        val catalog = listOf(
            TaskWorkbenchCatalogApp(
                id = "tabtin-demo-app",
                name = "Demo",
                surface = "collaborative",
                installed = true,
                order = 1,
                mobileMode = "unsupported",
            ),
            TaskWorkbenchCatalogApp(
                id = "tabdoc",
                name = "Docs",
                surface = "collaborative",
                installed = true,
                order = 2,
                mobileMode = null,
            ),
        )
        val workspace = catalog.map {
            TaskWorkbenchWorkspaceApp(
                id = it.id,
                name = it.name,
                canCreate = true,
                enabled = true,
                order = it.order,
                surface = "collaborative",
            )
        }
        val apps = TaskWorkbenchAppProjector.project(catalog, workspace, emptyList())
        val byId = apps.associateBy { it.id }
        assertFalse(byId.containsKey("tabtin-demo-app"))
        assertEquals(TaskWorkbenchAppActivation.OPEN_APP_HOME, byId["tabdoc"]?.activation)
        assertTrue(TaskWorkbenchMobileRuntime.isBlocked("unsupported"))
        assertTrue(TaskWorkbenchMobileRuntime.allowsAppHome("full", "tabmemo"))
        assertTrue(TaskWorkbenchMobileRuntime.allowsAppHome(null, "tabdoc"))
    }

    @Test
    fun `tabdata app home activation matches full and undeclared shim`() {
        assertTrue(TaskWorkbenchMobileRuntime.allowsAppHome(null, "tabdata"))
        assertTrue(TaskWorkbenchMobileRuntime.allowsAppHome("full", "tabdata"))
        assertEquals(WorkbenchAppHomeKind.TABDATA, WorkbenchAppHomeKind.fromAppId("tabdata"))

        listOf(null, "full").forEach { mode ->
            val catalog = listOf(
                TaskWorkbenchCatalogApp(
                    id = "tabdata",
                    name = "Tables",
                    surface = "collaborative",
                    installed = true,
                    order = 1,
                    mobileMode = mode,
                ),
            )
            val workspace = listOf(
                TaskWorkbenchWorkspaceApp(
                    id = "tabdata",
                    name = "Tables",
                    canCreate = true,
                    enabled = true,
                    order = 1,
                    surface = "collaborative",
                ),
            )
            val apps = TaskWorkbenchAppProjector.project(catalog, workspace, emptyList())
            val tabdata = apps.single()
            assertEquals("tabdata", tabdata.id)
            assertEquals(TaskWorkbenchAppActivation.OPEN_APP_HOME, tabdata.activation)
            assertEquals("进入", tabdata.actionLabel)
        }
    }

    @Test
    fun `route resolver does not dump unknown types into generic workbench detail`() {
        val unsupported = WorkbenchRouteResolver.resolve(
            resourceType = "tabwhiteboard",
            resourceId = "wb-1",
            title = "Board",
        )
        assertTrue(unsupported is WorkbenchOpenDestination.Unsupported)

        val memoHome = WorkbenchRouteResolver.resolve(
            resourceType = "tabmemo",
            resourceId = "",
            preferAppHomeWhenEmptyResource = true,
        )
        assertEquals(WorkbenchAppHomeKind.TABMEMO, (memoHome as WorkbenchOpenDestination.AppHome).kind)

        val filesDetail = WorkbenchRouteResolver.resolve(
            resourceType = "tabfiles",
            resourceId = "file-1",
        )
        assertTrue(filesDetail is WorkbenchOpenDestination.WorkbenchDetail)

        // Detail.kind 非空 → goBack 落回 App 首页（deep link / Cloud 打开同口径）。
        val state = WorkbenchAppHomeNavigationState()
        state.showDetail(
            (filesDetail as WorkbenchOpenDestination.WorkbenchDetail).request,
            WorkbenchAppHomeKind.TABFILES,
        )
        assertTrue(state.goBack())
        assertEquals(WorkbenchAppHomeKind.TABFILES, (state.pane as WorkbenchNavigationPane.AppHome).kind)
    }

}
