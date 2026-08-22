package com.tabtin.mobile.features.workbench

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 工作台 overview 投影可见性：catalog → tiles 的唯一闸门是
 * [TaskWorkbenchAppVisibility]，与 iOS TaskWorkbenchAppVisibility 同构。
 */
class WorkbenchAppVisibilityTest {

    @Test
    fun `overview projection excludes tabmemo`() {
        assertTrue(TaskWorkbenchAppVisibility.isHidden("tabmemo"))
        assertTrue(TaskWorkbenchAppVisibility.isHidden("  TabMemo "))

        val catalog = listOf(
            TaskWorkbenchCatalogApp(
                id = "tabmemo",
                name = "Memo",
                surface = "collaborative",
                installed = true,
                order = 1,
                mobileMode = "full",
            ),
            TaskWorkbenchCatalogApp(
                id = "tabfiles",
                name = "Files",
                surface = "collaborative",
                installed = true,
                order = 2,
                mobileMode = "full",
            ),
            TaskWorkbenchCatalogApp(
                id = "tabdoc",
                name = "Docs",
                surface = "collaborative",
                installed = true,
                order = 3,
                mobileMode = "full",
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
        val apps = TaskWorkbenchAppProjector.project(catalog, workspace, resources = emptyList())
        val ids = apps.map { it.id }

        assertFalse(ids.contains("tabmemo"))
        assertTrue(ids.contains("tabfiles"))
        assertTrue(ids.contains("tabdoc"))
    }

    @Test
    fun `overview hides Agent TabInbox and Desktop`() {
        listOf("orchestration", "tabinbox", "tabdesktop", "  TabInbox ").forEach { id ->
            assertTrue("expected hidden: $id", TaskWorkbenchAppVisibility.isHidden(id))
        }

        val catalog = listOf(
            TaskWorkbenchCatalogApp(
                id = "orchestration",
                name = "Agent",
                surface = "collaborative",
                installed = true,
                order = 1,
            ),
            TaskWorkbenchCatalogApp(
                id = "tabinbox",
                name = "TabInbox",
                surface = "collaborative",
                installed = true,
                order = 2,
            ),
            TaskWorkbenchCatalogApp(
                id = "tabdesktop",
                name = "Desktop",
                surface = "builtin",
                installed = true,
                order = 3,
            ),
            TaskWorkbenchCatalogApp(
                id = "tabdata",
                name = "Tables",
                surface = "collaborative",
                installed = true,
                order = 4,
                mobileMode = "full",
            ),
        )
        val workspace = catalog.map {
            TaskWorkbenchWorkspaceApp(
                id = it.id,
                name = it.name,
                canCreate = true,
                enabled = true,
                order = it.order,
                surface = it.surface,
            )
        }
        val ids = TaskWorkbenchAppProjector.project(catalog, workspace, emptyList()).map { it.id }
        assertFalse(ids.contains("orchestration"))
        assertFalse(ids.contains("tabinbox"))
        assertFalse(ids.contains("tabdesktop"))
        assertTrue(ids.contains("tabdata"))
    }

    @Test
    fun `display names prefer Chinese product titles`() {
        assertEquals("多维表", TaskWorkbenchAppDisplayName.resolve("tabdata", "Tables"))
        assertEquals("文档", TaskWorkbenchAppDisplayName.resolve("tabdoc", "Docs"))
        assertEquals("定时任务", TaskWorkbenchAppDisplayName.resolve("tabtracker", "Scheduled Tasks"))
        assertEquals("云盘", TaskWorkbenchAppDisplayName.resolve("tabfiles", "Files"))
        assertEquals("代码", TaskWorkbenchAppDisplayName.resolve("tabcode", "Code"))
        assertEquals("本地目录", TaskWorkbenchAppDisplayName.resolve("tabfolder", "Folder"))
        assertEquals("浏览器", TaskWorkbenchAppDisplayName.resolve("tabweb", "Browser"))
        assertEquals("笔记", WorkbenchAppHomeKind.TABMEMO.displayName)
        assertEquals("tabmemo", WorkbenchAppHomeKind.TABMEMO.appId)
    }

    @Test
    fun `projector emits Chinese titles and surface sections`() {
        val catalog = listOf(
            TaskWorkbenchCatalogApp(
                id = "tabdata",
                name = "Tables",
                surface = "collaborative",
                installed = true,
                order = 1,
                mobileMode = "full",
            ),
            TaskWorkbenchCatalogApp(
                id = "tabtracker",
                name = "Scheduled Tasks",
                surface = "collaborative",
                installed = true,
                order = 2,
            ),
            TaskWorkbenchCatalogApp(
                id = "tabcode",
                name = "Code",
                surface = "builtin",
                installed = true,
                order = 3,
            ),
        )
        val workspace = catalog.map {
            TaskWorkbenchWorkspaceApp(
                id = it.id,
                name = it.name,
                canCreate = it.id != "tabcode",
                enabled = true,
                order = it.order,
                surface = it.surface,
            )
        }
        val apps = TaskWorkbenchAppProjector.project(catalog, workspace, emptyList())
        val byId = apps.associateBy { it.id }
        assertEquals("多维表", byId["tabdata"]?.name)
        assertEquals("定时任务", byId["tabtracker"]?.name)
        assertEquals("代码", byId["tabcode"]?.name)
        assertEquals(TaskWorkbenchAppActivation.OPEN_APP_HOME, byId["tabdata"]?.activation)
        assertEquals(TaskWorkbenchAppActivation.REQUEST_AGENT, byId["tabtracker"]?.activation)
        assertEquals(TaskWorkbenchAppSurface.COLLABORATIVE, byId["tabdata"]?.surface)
        assertEquals(TaskWorkbenchAppSurface.BUILTIN, byId["tabtracker"]?.surface)

        val sections = TaskWorkbenchAppProjector.sections(apps)
        assertEquals(
            listOf("协作应用", "内置能力"),
            sections.map { it.title },
        )
        assertEquals(listOf("tabdata"), sections[0].apps.map { it.id })
        assertEquals(listOf("tabtracker", "tabcode"), sections[1].apps.map { it.id })
        assertTrue(
            sections.single { it.surface == TaskWorkbenchAppSurface.COLLABORATIVE }
                .apps.all { it.activation == TaskWorkbenchAppActivation.OPEN_APP_HOME },
        )
    }

    @Test
    fun `deep link host for tabmemo remains available`() {
        val home = WorkbenchRouteResolver.resolve(
            resourceType = "tabmemo",
            resourceId = "",
            preferAppHomeWhenEmptyResource = true,
        )
        assertEquals(WorkbenchAppHomeKind.TABMEMO, (home as WorkbenchOpenDestination.AppHome).kind)

        val detail = WorkbenchRouteResolver.resolve(
            resourceType = "tabmemo",
            resourceId = "memo-1",
            title = "Note",
        )
        assertTrue(detail is WorkbenchOpenDestination.WorkbenchDetail)
    }
}
