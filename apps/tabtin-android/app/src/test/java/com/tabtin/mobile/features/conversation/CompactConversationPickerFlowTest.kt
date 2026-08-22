package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.features.workbench.WorkbenchFocusTarget
import com.tabtin.mobile.features.workbench.WorkbenchNavigationPane
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 覆盖顶部 picker 与 overlay 的真实 intent handler，再用 [CompactConversationRenderPlan]
 * 断言 [ChatSessionScreen] 实际消费的渲染分支，防止只把 detent 改名却仍组合 layer chrome。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CompactConversationPickerFlowTest {

    @Test
    fun `conversation picker exits overlay and activates direct full surface`() {
        val layer = ConversationLayerState(ConversationLayerDetent.SHEET)
        val scope = TestScope(StandardTestDispatcher())
        var presentation = CompactConversationPresentation.WORKBENCH_OVERLAY
        var surface = TaskSurfaceStateSnapshot(
            workbenchOpen = true,
            preferAppFocus = true,
            everOpened = true,
            focus = WorkbenchFocusTarget.fromPane(WorkbenchNavigationPane.Overview),
        )

        val before = TaskSurfaceCoordinator.compactConversationRenderPlan(
            presentation,
            layer.detent,
        )
        assertTrue(before.composeOverlayHost)
        assertTrue(before.pickerWorkbenchSelected)
        assertEquals(
            TaskSurfaceMode.APP_FOCUS,
            TaskSurfaceCoordinator.resolveMode(
                TaskSurfaceLayout(widthDp = 412, workbenchOpen = surface.workbenchOpen),
            ),
        )

        selectCompactConversationSurface(
            currentPresentation = presentation,
            layerState = layer,
            layerScope = scope,
            onPresentationChanged = { presentation = it },
            onTaskSurfaceModeChanged = { mode ->
                surface = TaskSurfaceStateReducer.apply(surface, mode)
            },
        )
        scope.testScheduler.runCurrent()
        scope.cancel()

        val after = TaskSurfaceCoordinator.compactConversationRenderPlan(
            presentation,
            layer.detent,
        )
        assertEquals(
            "顶部“对话”必须退出 overlay；完整对话不能继续复用 layer 的最高档",
            ConversationLayerDetent.COLLAPSED,
            layer.detent,
        )
        assertEquals(CompactConversationPresentation.DIRECT_CONVERSATION, presentation)
        assertFalse(surface.workbenchOpen)
        assertFalse(surface.preferAppFocus)
        assertEquals(
            TaskSurfaceMode.CHAT_FOCUS,
            TaskSurfaceCoordinator.resolveMode(
                TaskSurfaceLayout(widthDp = 412, workbenchOpen = surface.workbenchOpen),
            ),
        )
        assertTrue(after.composeDirectConversation)
        assertFalse(after.composeOverlayHost)
        assertFalse(after.pickerWorkbenchSelected)
        assertTrue(after.conversationContentVisible)
    }

    @Test
    fun `sheet and expanded intents remain workbench overlay with grabber host`() {
        listOf(ConversationLayerDetent.SHEET, ConversationLayerDetent.EXPANDED).forEach { target ->
            val layer = ConversationLayerState(ConversationLayerDetent.COLLAPSED)
            val scope = TestScope(StandardTestDispatcher())
            var presentation = CompactConversationPresentation.DIRECT_CONVERSATION
            var surface = TaskSurfaceStateSnapshot()

            showCompactConversationOverlay(
                target = target,
                layerState = layer,
                layerScope = scope,
                onPresentationChanged = { presentation = it },
                onTaskSurfaceModeChanged = { mode ->
                    surface = TaskSurfaceStateReducer.apply(surface, mode)
                },
            )
            scope.testScheduler.runCurrent()
            scope.cancel()

            val plan = TaskSurfaceCoordinator.compactConversationRenderPlan(
                presentation,
                layer.detent,
            )
            assertEquals(target, layer.detent)
            assertTrue(surface.workbenchOpen)
            assertEquals(
                TaskSurfaceMode.APP_FOCUS,
                TaskSurfaceCoordinator.resolveMode(
                    TaskSurfaceLayout(widthDp = 412, workbenchOpen = surface.workbenchOpen),
                ),
            )
            assertEquals(CompactConversationPresentation.WORKBENCH_OVERLAY, presentation)
            assertFalse(plan.composeDirectConversation)
            assertTrue(plan.composeOverlayHost)
            assertTrue(plan.pickerWorkbenchSelected)
        }
    }
}
