package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.features.workbench.WorkbenchPresentation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskSurfaceCoordinatorTest {
    @Test
    fun `REGULAR_WIDTH_DP is 760`() {
        assertEquals(760, TaskSurfaceCoordinator.REGULAR_WIDTH_DP)
    }

    /**
     * 契约：759 双态（CHAT_FOCUS / APP_FOCUS，无 SPLIT）；
     * 760 三态（CHAT_FOCUS / SPLIT / APP_FOCUS，preferAppFocus 生效）。
     */
    @Test
    fun `759 dual state vs 760 triple state boundary`() {
        // 759：关闭 → 对话；打开 → 应用聚焦（prefer 忽略，永不 SPLIT）
        assertEquals(
            TaskSurfaceMode.CHAT_FOCUS,
            TaskSurfaceCoordinator.resolveMode(
                TaskSurfaceLayout(widthDp = 759, workbenchOpen = false),
            ),
        )
        assertEquals(
            TaskSurfaceMode.APP_FOCUS,
            TaskSurfaceCoordinator.resolveMode(
                TaskSurfaceLayout(widthDp = 759, workbenchOpen = true, preferAppFocus = false),
            ),
        )
        assertEquals(
            TaskSurfaceMode.APP_FOCUS,
            TaskSurfaceCoordinator.resolveMode(
                TaskSurfaceLayout(widthDp = 759, workbenchOpen = true, preferAppFocus = true),
            ),
        )

        // 760：关闭 → 对话；打开默认分屏；preferAppFocus → 应用聚焦
        assertEquals(
            TaskSurfaceMode.CHAT_FOCUS,
            TaskSurfaceCoordinator.resolveMode(
                TaskSurfaceLayout(widthDp = 760, workbenchOpen = false),
            ),
        )
        assertEquals(
            TaskSurfaceMode.SPLIT,
            TaskSurfaceCoordinator.resolveMode(
                TaskSurfaceLayout(widthDp = 760, workbenchOpen = true, preferAppFocus = false),
            ),
        )
        assertEquals(
            TaskSurfaceMode.APP_FOCUS,
            TaskSurfaceCoordinator.resolveMode(
                TaskSurfaceLayout(widthDp = 760, workbenchOpen = true, preferAppFocus = true),
            ),
        )
    }

    @Test
    fun `759dp workbench open maps to app focus pane`() {
        val mode = TaskSurfaceCoordinator.resolveMode(
            TaskSurfaceLayout(widthDp = 759, workbenchOpen = true),
        )
        assertEquals(TaskSurfaceMode.APP_FOCUS, mode)
    }

    @Test
    fun `760dp with workbench opens split by default`() {
        val mode = TaskSurfaceCoordinator.resolveMode(
            TaskSurfaceLayout(widthDp = 760, workbenchOpen = true),
        )
        assertEquals(TaskSurfaceMode.SPLIT, mode)
    }

    @Test
    fun `760dp preferAppFocus uses app focus`() {
        val mode = TaskSurfaceCoordinator.resolveMode(
            TaskSurfaceLayout(widthDp = 760, workbenchOpen = true, preferAppFocus = true),
        )
        assertEquals(TaskSurfaceMode.APP_FOCUS, mode)
    }

    @Test
    fun `keep alive after first open`() {
        assertFalse(TaskSurfaceCoordinator.keepsWorkbenchAlive(everOpened = false))
        assertTrue(TaskSurfaceCoordinator.keepsWorkbenchAlive(everOpened = true))
    }

    @Test
    fun `conversation visibility by mode`() {
        assertTrue(TaskSurfaceCoordinator.conversationVisible(TaskSurfaceMode.CHAT_FOCUS))
        assertTrue(TaskSurfaceCoordinator.conversationVisible(TaskSurfaceMode.SPLIT))
        assertFalse(TaskSurfaceCoordinator.conversationVisible(TaskSurfaceMode.APP_FOCUS))
    }

    @Test
    fun `phone conversation content hidden when workbench open`() {
        assertFalse(
            TaskSurfaceCoordinator.conversationContentVisible(
                mode = TaskSurfaceMode.CHAT_FOCUS,
                widthDp = 412,
                workbenchOpen = true,
            ),
        )
        assertTrue(
            TaskSurfaceCoordinator.conversationContentVisible(
                mode = TaskSurfaceMode.CHAT_FOCUS,
                widthDp = 412,
                workbenchOpen = false,
            ),
        )
    }

    @Test
    fun `tablet conversation content hidden only in app focus`() {
        assertTrue(
            TaskSurfaceCoordinator.conversationContentVisible(
                mode = TaskSurfaceMode.SPLIT,
                widthDp = 800,
                workbenchOpen = true,
            ),
        )
        assertFalse(
            TaskSurfaceCoordinator.conversationContentVisible(
                mode = TaskSurfaceMode.APP_FOCUS,
                widthDp = 800,
                workbenchOpen = true,
            ),
        )
        assertTrue(
            TaskSurfaceCoordinator.conversationContentVisible(
                mode = TaskSurfaceMode.CHAT_FOCUS,
                widthDp = 800,
                workbenchOpen = false,
            ),
        )
    }

    @Test
    fun `tablet capsule only in app focus`() {
        assertFalse(
            TaskSurfaceCoordinator.capsuleLayoutAllows(
                mode = TaskSurfaceMode.SPLIT,
                widthDp = 800,
                workbenchOpen = true,
            ),
        )
        assertTrue(
            TaskSurfaceCoordinator.capsuleLayoutAllows(
                mode = TaskSurfaceMode.APP_FOCUS,
                widthDp = 800,
                workbenchOpen = true,
            ),
        )
        assertTrue(
            TaskSurfaceCoordinator.capsuleLayoutAllows(
                mode = TaskSurfaceMode.APP_FOCUS,
                widthDp = 412,
                workbenchOpen = true,
            ),
        )
        assertFalse(
            TaskSurfaceCoordinator.capsuleLayoutAllows(
                mode = TaskSurfaceMode.CHAT_FOCUS,
                widthDp = 412,
                workbenchOpen = false,
            ),
        )
    }

    @Test
    fun `shouldComposeWorkbench keeps tree after first open in chat focus`() {
        assertFalse(
            TaskSurfaceCoordinator.shouldComposeWorkbench(
                mode = TaskSurfaceMode.CHAT_FOCUS,
                everOpened = false,
                workbenchOpen = false,
                widthDp = 760,
            ),
        )
        assertTrue(
            TaskSurfaceCoordinator.shouldComposeWorkbench(
                mode = TaskSurfaceMode.CHAT_FOCUS,
                everOpened = true,
                workbenchOpen = false,
                widthDp = 760,
            ),
        )
        assertTrue(
            TaskSurfaceCoordinator.shouldComposeWorkbench(
                mode = TaskSurfaceMode.SPLIT,
                everOpened = false,
                workbenchOpen = true,
                widthDp = 760,
            ),
        )
        assertFalse(
            TaskSurfaceCoordinator.shouldComposeWorkbench(
                mode = TaskSurfaceMode.APP_FOCUS,
                everOpened = true,
                workbenchOpen = true,
                widthDp = 759,
            ),
        )
        assertTrue(
            TaskSurfaceCoordinator.shouldComposeWorkbenchCompact(
                everOpened = false,
                workbenchOpen = true,
            ),
        )
        assertFalse(
            TaskSurfaceCoordinator.shouldComposeWorkbenchCompact(
                everOpened = false,
                workbenchOpen = false,
            ),
        )
    }

    @Test
    fun `session host presentation is EMBEDDED at 760 and TASK_PANE below`() {
        assertEquals(
            WorkbenchPresentation.EMBEDDED,
            TaskSurfaceCoordinator.sessionWorkbenchPresentation(760),
        )
        assertEquals(
            WorkbenchPresentation.EMBEDDED,
            TaskSurfaceCoordinator.sessionWorkbenchPresentation(1024),
        )
        assertEquals(
            WorkbenchPresentation.TASK_PANE,
            TaskSurfaceCoordinator.sessionWorkbenchPresentation(759),
        )
        assertEquals(
            WorkbenchPresentation.TASK_PANE,
            TaskSurfaceCoordinator.sessionWorkbenchPresentation(412),
        )
        // 会话路径永不落 MODAL（sheet 仅给深链 WorkbenchSheet 入口）
        assertTrue(
            TaskSurfaceCoordinator.sessionWorkbenchPresentation(760) !=
                WorkbenchPresentation.MODAL,
        )
        assertTrue(
            TaskSurfaceCoordinator.sessionWorkbenchPresentation(412) !=
                WorkbenchPresentation.MODAL,
        )
    }

    @Test
    fun `regular width host composes workbench with EMBEDDED policy`() {
        assertTrue(
            TaskSurfaceCoordinator.shouldComposeWorkbench(
                mode = TaskSurfaceMode.SPLIT,
                everOpened = false,
                workbenchOpen = true,
                widthDp = TaskSurfaceCoordinator.REGULAR_WIDTH_DP,
            ),
        )
        assertEquals(
            WorkbenchPresentation.EMBEDDED,
            TaskSurfaceCoordinator.sessionWorkbenchPresentation(
                TaskSurfaceCoordinator.REGULAR_WIDTH_DP,
            ),
        )
        // 窄屏 Host 不组合工作台（由 ChatSessionScreen TASK_PANE 切面挂）
        assertFalse(
            TaskSurfaceCoordinator.shouldComposeWorkbench(
                mode = TaskSurfaceMode.APP_FOCUS,
                everOpened = true,
                workbenchOpen = true,
                widthDp = TaskSurfaceCoordinator.REGULAR_WIDTH_DP - 1,
            ),
        )
    }

    @Test
    fun `direct compact conversation composes no overlay host or grabber chrome`() {
        val plan = TaskSurfaceCoordinator.compactConversationRenderPlan(
            presentation = CompactConversationPresentation.DIRECT_CONVERSATION,
            overlayDetent = ConversationLayerDetent.EXPANDED,
        )

        assertTrue(plan.composeDirectConversation)
        assertFalse(plan.composeOverlayHost)
        assertTrue(plan.conversationContentVisible)
        assertFalse(plan.capsuleVisible)
        assertFalse(plan.pickerWorkbenchSelected)
    }

    @Test
    fun `compact overlay remains workbench presentation at every card detent`() {
        ConversationLayerDetent.entries.forEach { detent ->
            val plan = TaskSurfaceCoordinator.compactConversationRenderPlan(
                presentation = CompactConversationPresentation.WORKBENCH_OVERLAY,
                overlayDetent = detent,
            )

            assertFalse(plan.composeDirectConversation)
            assertTrue(plan.composeOverlayHost)
            assertEquals(
                detent != ConversationLayerDetent.COLLAPSED,
                plan.conversationContentVisible,
            )
            assertEquals(detent == ConversationLayerDetent.COLLAPSED, plan.capsuleVisible)
            assertTrue(plan.pickerWorkbenchSelected)
        }
    }

    @Test
    fun `compact conversation picker switches presentation instead of layer detent`() {
        assertEquals(
            CompactConversationPresentation.DIRECT_CONVERSATION,
            TaskSurfaceCoordinator.conversationPickerTargetCompact(
                CompactConversationPresentation.WORKBENCH_OVERLAY,
            ),
        )
        assertEquals(
            null,
            TaskSurfaceCoordinator.conversationPickerTargetCompact(
                CompactConversationPresentation.DIRECT_CONVERSATION,
            ),
        )
    }

    @Test
    fun `compact presentation hides picker over workbench app or detail`() {
        assertFalse(
            TaskSurfaceCoordinator.compactSurfaceSwitcherVisible(
                regularWidth = false,
                showsWorkbenchChrome = true,
                compactPresentationAvailable = true,
                showWorkbench = true,
                detailRequestsSwitcherHidden = true,
            ),
        )
        assertTrue(
            TaskSurfaceCoordinator.compactSurfaceSwitcherVisible(
                regularWidth = false,
                showsWorkbenchChrome = true,
                compactPresentationAvailable = true,
                showWorkbench = true,
                detailRequestsSwitcherHidden = false,
            ),
        )
        assertFalse(
            TaskSurfaceCoordinator.compactSurfaceSwitcherVisible(
                regularWidth = true,
                showsWorkbenchChrome = true,
                compactPresentationAvailable = true,
                showWorkbench = true,
                detailRequestsSwitcherHidden = true,
            ),
        )
    }

    @Test
    fun `compact capsule tap opens sheet without sharing picker semantics`() {
        assertEquals(
            ConversationLayerDetent.SHEET,
            TaskSurfaceCoordinator.capsuleTapTargetCompact(ConversationLayerDetent.COLLAPSED),
        )
        assertEquals(
            null,
            TaskSurfaceCoordinator.capsuleTapTargetCompact(ConversationLayerDetent.SHEET),
        )
        assertEquals(
            null,
            TaskSurfaceCoordinator.capsuleTapTargetCompact(ConversationLayerDetent.EXPANDED),
        )
    }

    @Test
    fun `hidden keep alive workbench never handles system back`() {
        assertFalse(
            TaskSurfaceCoordinator.workbenchBackHandlingEnabled(
                mode = TaskSurfaceMode.CHAT_FOCUS,
                workbenchOpen = false,
            ),
        )
        assertTrue(
            TaskSurfaceCoordinator.workbenchBackHandlingEnabled(
                mode = TaskSurfaceMode.SPLIT,
                workbenchOpen = true,
            ),
        )
        assertTrue(
            TaskSurfaceCoordinator.workbenchBackHandlingEnabled(
                mode = TaskSurfaceMode.APP_FOCUS,
                workbenchOpen = true,
            ),
        )
    }

    @Test
    fun `compact workbench handles back only behind collapsed capsule`() {
        assertTrue(
            TaskSurfaceCoordinator.compactWorkbenchBackHandlingEnabled(
                workbenchOpen = true,
                presentation = CompactConversationPresentation.WORKBENCH_OVERLAY,
                detent = ConversationLayerDetent.COLLAPSED,
            ),
        )
        assertFalse(
            TaskSurfaceCoordinator.compactWorkbenchBackHandlingEnabled(
                workbenchOpen = true,
                presentation = CompactConversationPresentation.WORKBENCH_OVERLAY,
                detent = ConversationLayerDetent.SHEET,
            ),
        )
        assertFalse(
            TaskSurfaceCoordinator.compactWorkbenchBackHandlingEnabled(
                workbenchOpen = false,
                presentation = CompactConversationPresentation.DIRECT_CONVERSATION,
                detent = ConversationLayerDetent.COLLAPSED,
            ),
        )
    }

    @Test
    fun `compact backdrop steps layer down and passes through when collapsed`() {
        assertEquals(
            null,
            TaskSurfaceCoordinator.conversationBackdropTargetCompact(
                ConversationLayerDetent.COLLAPSED,
            ),
        )
        assertEquals(
            ConversationLayerDetent.COLLAPSED,
            TaskSurfaceCoordinator.conversationBackdropTargetCompact(ConversationLayerDetent.SHEET),
        )
        assertEquals(
            ConversationLayerDetent.SHEET,
            TaskSurfaceCoordinator.conversationBackdropTargetCompact(
                ConversationLayerDetent.EXPANDED,
            ),
        )
    }
}
