package com.tabtin.mobile.features.conversation

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 覆盖跟手拖拽、手势吸档入口与返回键降档。动画本身依赖 `MonotonicFrameClock`；
 * 手势测试只推进到 [ConversationLayerState.animateTo] 同步落下目标档位后便取消测试 scope，
 * 因而既走真实 state，又不把弹簧逐帧视觉伪装成 JVM 能验证的东西。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ConversationLayerStateTest {

    private fun state(
        initial: ConversationLayerDetent = ConversationLayerDetent.COLLAPSED,
        viewportHeightPx: Int = 1000,
    ): ConversationLayerState = ConversationLayerState(initial).apply {
        this.viewportHeightPx = viewportHeightPx
    }

    private fun settleAfterGesture(
        layer: ConversationLayerState,
        velocityDpPerMs: Float,
    ): ConversationLayerDetent {
        val scope = TestScope(StandardTestDispatcher())
        scope.launch { layer.settle(velocityDpPerMs) }
        scope.testScheduler.runCurrent()
        val settled = layer.detent
        scope.cancel()
        return settled
    }

    @Test
    fun `initial top ratio follows detent`() {
        assertEquals(
            ConversationLayerGeometry.COLLAPSED_TOP_RATIO,
            state(ConversationLayerDetent.COLLAPSED).topRatio,
            0.0001f,
        )
        assertEquals(
            ConversationLayerGeometry.SHEET_TOP_RATIO,
            state(ConversationLayerDetent.SHEET).topRatio,
            0.0001f,
        )
    }

    @Test
    fun `drag up decreases top ratio by pixel fraction of viewport`() {
        val layer = state(ConversationLayerDetent.SHEET, viewportHeightPx = 1000)
        layer.dragByPx(-200f)
        assertEquals(ConversationLayerGeometry.SHEET_TOP_RATIO - 0.2f, layer.topRatio, 0.0001f)
    }

    @Test
    fun `successive drags accumulate without losing deltas`() {
        val layer = state(ConversationLayerDetent.COLLAPSED, viewportHeightPx = 1000)
        repeat(10) { layer.dragByPx(-30f) }
        assertEquals(1f - 0.3f, layer.topRatio, 0.0001f)
    }

    @Test
    fun `drag clamps at both detent ends`() {
        val layer = state(ConversationLayerDetent.COLLAPSED, viewportHeightPx = 1000)
        layer.dragByPx(-5000f)
        assertEquals(ConversationLayerGeometry.EXPANDED_TOP_RATIO, layer.topRatio, 0.0001f)
        layer.dragByPx(5000f)
        assertEquals(ConversationLayerGeometry.COLLAPSED_TOP_RATIO, layer.topRatio, 0.0001f)
    }

    @Test
    fun `drag is a no-op before viewport is measured`() {
        val layer = ConversationLayerState(ConversationLayerDetent.SHEET)
        layer.dragByPx(-400f)
        assertEquals(ConversationLayerGeometry.SHEET_TOP_RATIO, layer.topRatio, 0.0001f)
    }

    @Test
    fun `drag does not change detent until settled`() {
        val layer = state(ConversationLayerDetent.COLLAPSED, viewportHeightPx = 1000)
        layer.dragByPx(-900f)
        assertEquals(ConversationLayerDetent.COLLAPSED, layer.detent)
    }

    @Test
    fun `collapsed upward gesture can settle only to sheet even after dragging to top`() {
        listOf(
            -300f to 0f, // 慢拖超过 COLLAPSED / SHEET 中点
            -1f to -0.9f, // 短距离快速上甩
            -5000f to 0f, // 远距离拖到视口顶
        ).forEach { (dragPx, velocity) ->
            val layer = state(ConversationLayerDetent.COLLAPSED)
            layer.dragByPx(dragPx)

            assertEquals(
                "胶囊上滑不能绕过顶部“对话”直接进入完整对话页",
                ConversationLayerDetent.SHEET,
                settleAfterGesture(layer, velocity),
            )
            assertTrue(
                TaskSurfaceCoordinator.compactConversationRenderPlan(
                    CompactConversationPresentation.WORKBENCH_OVERLAY,
                    layer.detent,
                ).pickerWorkbenchSelected,
            )
        }
    }

    @Test
    fun `sheet can continue upward to expanded overlay while picker stays workbench`() {
        val smallDrag = state(ConversationLayerDetent.SHEET)
        smallDrag.dragByPx(-80f)
        assertEquals(
            ConversationLayerDetent.SHEET,
            settleAfterGesture(smallDrag, velocityDpPerMs = 0f),
        )

        listOf(-1f to -0.9f, -5000f to 0f).forEach { (dragPx, velocity) ->
            val layer = state(ConversationLayerDetent.SHEET)
            layer.dragByPx(dragPx)

            assertEquals(
                "半屏抓手可继续拉成长卡片，但不能冒充 direct 对话页",
                ConversationLayerDetent.EXPANDED,
                settleAfterGesture(layer, velocity),
            )
            val plan = TaskSurfaceCoordinator.compactConversationRenderPlan(
                CompactConversationPresentation.WORKBENCH_OVERLAY,
                layer.detent,
            )
            assertTrue(plan.composeOverlayHost)
            assertTrue(plan.pickerWorkbenchSelected)
        }
    }

    @Test
    fun `expanded overlay downward gesture can stay expanded or step only to sheet`() {
        val smallDrag = state(ConversationLayerDetent.EXPANDED)
        smallDrag.dragByPx(40f)
        assertEquals(
            ConversationLayerDetent.EXPANDED,
            settleAfterGesture(smallDrag, velocityDpPerMs = 0f),
        )

        listOf(0f, 0.9f).forEach { velocity ->
            val farDrag = state(ConversationLayerDetent.EXPANDED)
            farDrag.dragByPx(5000f)
            assertEquals(
                "扩展卡片下拖最多退到半屏，不能一把跳过两档",
                ConversationLayerDetent.SHEET,
                settleAfterGesture(farDrag, velocity),
            )
            assertTrue(
                TaskSurfaceCoordinator.compactConversationRenderPlan(
                    CompactConversationPresentation.WORKBENCH_OVERLAY,
                    farDrag.detent,
                ).pickerWorkbenchSelected,
            )
        }
    }

    @Test
    fun `back steps down one detent at a time`() {
        assertEquals(
            ConversationLayerDetent.SHEET,
            state(ConversationLayerDetent.EXPANDED).collapseTargetOnBack(),
        )
        assertEquals(
            ConversationLayerDetent.COLLAPSED,
            state(ConversationLayerDetent.SHEET).collapseTargetOnBack(),
        )
        assertNull(state(ConversationLayerDetent.COLLAPSED).collapseTargetOnBack())
    }
}
