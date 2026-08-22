package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.data.model.SpaceResource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkbenchPresentationTest {

    @Test
    fun `task output list shows five bars then collapses the rest`() {
        val items = (1..7).map { "item-$it" }
        assertEquals(5, TaskWorkbenchOutputListPolicy.COLLAPSED_VISIBLE_COUNT)
        assertEquals(
            listOf("item-1", "item-2", "item-3", "item-4", "item-5"),
            TaskWorkbenchOutputListPolicy.visible(items, expanded = false),
        )
        assertEquals(2, TaskWorkbenchOutputListPolicy.hiddenCount(items.size, expanded = false))
        assertEquals(items, TaskWorkbenchOutputListPolicy.visible(items, expanded = true))
        assertEquals(0, TaskWorkbenchOutputListPolicy.hiddenCount(items.size, expanded = true))
        assertEquals(0, TaskWorkbenchOutputListPolicy.hiddenCount(4, expanded = false))
    }

    @Test
    fun `tabdoc and tabdata details stay inside the workbench`() {
        assertEquals(
            WorkbenchResourcePresentation.NATIVE_WORKBENCH,
            resolveWorkbenchResourcePresentation("document"),
        )
        assertEquals(
            WorkbenchResourcePresentation.NATIVE_WORKBENCH,
            resolveWorkbenchResourcePresentation("tabdata"),
        )
        assertEquals(
            WorkbenchResourcePresentation.HOST,
            resolveWorkbenchResourcePresentation("tabsite"),
        )
    }

    @Test
    fun `native task output without library resource synthesizes an openable resource`() {
        val output = TaskWorkbenchOutput(
            id = "tabdata:table-1",
            resourceType = "table",
            resourceId = "table-1",
            title = "发布清单",
            preview = "3 条待处理",
            timestampMs = 0L,
            resource = null,
            openRequest = WorkbenchResourceOpenRequest(
                resourceType = "table",
                resourceId = "table-1",
                title = "发布清单",
                locationHint = "产品空间",
            ),
        )

        assertEquals(
            SpaceResource(
                id = "workbench:tabdata:table-1",
                itemType = "tabdata",
                title = "发布清单",
                preview = "3 条待处理",
                resourceId = "table-1",
                spaceId = "space-1",
                organizationId = "org-1",
                spaceName = "产品空间",
            ),
            output.syntheticNativeResource(
                spaceId = "space-1",
                organizationId = "org-1",
            ),
        )
    }

    @Test
    fun `web task output never synthesizes a native resource`() {
        val output = TaskWorkbenchOutput(
            id = "tabslide:slide-1",
            resourceType = "tabslide",
            resourceId = "slide-1",
            title = "路演",
            preview = null,
            timestampMs = 0L,
            resource = null,
            openRequest = WorkbenchResourceOpenRequest(
                resourceType = "tabslide",
                resourceId = "slide-1",
                title = "路演",
            ),
        )

        assertNull(
            output.syntheticNativeResource(
                spaceId = null,
                organizationId = "org-1",
            ),
        )
    }

    @Test
    fun `only MODAL uses bottom sheet`() {
        assertTrue(WorkbenchPresentation.MODAL.wrapsInModalSheet())
        assertFalse(WorkbenchPresentation.EMBEDDED.wrapsInModalSheet())
        assertFalse(WorkbenchPresentation.TASK_PANE.wrapsInModalSheet())
    }

    @Test
    fun `TASK_PANE is fullscreen host content not sheet`() {
        assertTrue(WorkbenchPresentation.TASK_PANE.isFullscreenTaskPane())
        assertFalse(WorkbenchPresentation.EMBEDDED.isFullscreenTaskPane())
        assertFalse(WorkbenchPresentation.MODAL.isFullscreenTaskPane())
    }

    @Test
    fun `content layer prefers web over pane`() {
        assertEquals(
            WorkbenchContentLayer.WEB,
            resolveWorkbenchContentLayer(
                hasWebTarget = true,
                pane = WorkbenchNavigationPane.AppHome(WorkbenchAppHomeKind.TABDOC),
            ),
        )
        assertEquals(
            WorkbenchContentLayer.APP_HOME,
            resolveWorkbenchContentLayer(
                hasWebTarget = false,
                pane = WorkbenchNavigationPane.AppHome(WorkbenchAppHomeKind.TABMEMO),
            ),
        )
        assertEquals(
            WorkbenchContentLayer.DETAIL,
            resolveWorkbenchContentLayer(
                hasWebTarget = false,
                pane = WorkbenchNavigationPane.Detail(
                    kind = WorkbenchAppHomeKind.TABFILES,
                    request = WorkbenchResourceOpenRequest(
                        resourceType = "tabfiles",
                        resourceId = "f1",
                        title = "file",
                    ),
                ),
            ),
        )
        assertEquals(
            WorkbenchContentLayer.DETAIL,
            resolveWorkbenchContentLayer(
                hasWebTarget = false,
                pane = WorkbenchNavigationPane.Detail(
                    kind = null,
                    request = WorkbenchResourceOpenRequest(
                        resourceType = "tabdoc",
                        resourceId = "doc-1",
                        title = "周报",
                    ),
                ),
            ),
        )
        assertEquals(
            WorkbenchContentLayer.OVERVIEW,
            resolveWorkbenchContentLayer(
                hasWebTarget = false,
                pane = WorkbenchNavigationPane.Overview,
            ),
        )
        assertEquals(
            WorkbenchContentLayer.OVERVIEW,
            resolveWorkbenchContentLayer(
                hasWebTarget = false,
                pane = WorkbenchNavigationPane.Detail(
                    kind = null,
                    request = WorkbenchResourceOpenRequest(
                        resourceType = "unknown",
                        resourceId = "x",
                        title = "x",
                    ),
                ),
            ),
        )
    }

    @Test
    fun `non MODAL never wraps overview or leaf in sheet`() {
        for (presentation in listOf(
            WorkbenchPresentation.EMBEDDED,
            WorkbenchPresentation.TASK_PANE,
        )) {
            for (layerPane in listOf(
                false to WorkbenchNavigationPane.Overview,
                false to WorkbenchNavigationPane.AppHome(WorkbenchAppHomeKind.TABDOC),
                true to WorkbenchNavigationPane.Overview,
            )) {
                val composition = resolveWorkbenchHostComposition(
                    presentation = presentation,
                    hasWebTarget = layerPane.first,
                    pane = layerPane.second,
                )
                assertFalse(composition.wrapsOverviewInModalSheet)
                assertFalse(composition.leafWrapsInModalSheet)
                assertTrue(composition.sharedFeedbackLayerMountable)
            }
        }
    }

    @Test
    fun `MODAL overview wraps sheet while web does not block feedback`() {
        val overview = resolveWorkbenchHostComposition(
            presentation = WorkbenchPresentation.MODAL,
            hasWebTarget = false,
            pane = WorkbenchNavigationPane.Overview,
        )
        assertTrue(overview.wrapsOverviewInModalSheet)
        assertFalse(overview.leafWrapsInModalSheet)
        assertTrue(overview.sharedFeedbackLayerMountable)

        val web = resolveWorkbenchHostComposition(
            presentation = WorkbenchPresentation.MODAL,
            hasWebTarget = true,
            pane = WorkbenchNavigationPane.Overview,
        )
        assertEquals(WorkbenchContentLayer.WEB, web.contentLayer)
        assertFalse(web.wrapsOverviewInModalSheet)
        assertFalse(web.leafWrapsInModalSheet)
        assertTrue(web.sharedFeedbackLayerMountable)

        val appHome = resolveWorkbenchHostComposition(
            presentation = WorkbenchPresentation.MODAL,
            hasWebTarget = false,
            pane = WorkbenchNavigationPane.AppHome(WorkbenchAppHomeKind.TABMEMO),
        )
        assertFalse(appHome.wrapsOverviewInModalSheet)
        assertTrue(appHome.leafWrapsInModalSheet)
        assertTrue(appHome.sharedFeedbackLayerMountable)
    }

    @Test
    fun `all content layers keep shared feedback mountable`() {
        val panes = listOf(
            WorkbenchNavigationPane.Overview,
            WorkbenchNavigationPane.AppHome(WorkbenchAppHomeKind.TABDOC),
            WorkbenchNavigationPane.Detail(
                kind = WorkbenchAppHomeKind.TABDATA,
                request = WorkbenchResourceOpenRequest(
                    resourceType = "tabdata",
                    resourceId = "t1",
                    title = "table",
                ),
            ),
        )
        for (presentation in WorkbenchPresentation.entries) {
            for (hasWeb in listOf(false, true)) {
                for (pane in panes) {
                    val composition = resolveWorkbenchHostComposition(presentation, hasWeb, pane)
                    assertTrue(
                        "feedback blocked for $presentation web=$hasWeb pane=$pane",
                        composition.sharedFeedbackLayerMountable,
                    )
                }
            }
        }
    }
}
