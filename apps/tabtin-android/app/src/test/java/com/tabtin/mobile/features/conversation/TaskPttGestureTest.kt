package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskPttGestureTest {
    @Test
    fun `hold under 520ms cancels on release and is tap outcome`() {
        var state = TaskPttGesture.onPressStart()
        state = TaskPttGesture.onTick(state, 400, privacyGranted = true)
        assertEquals(TaskPttPhase.PRESSING, state.phase)
        assertFalse(TaskPttGesture.shouldStartAsr(state, privacyGranted = true))
        assertEquals(TaskPttPointerOutcome.TAP, TaskPttPointerOutcome.resolve(state.phase))
        state = TaskPttGesture.onRelease(state)
        assertEquals(TaskPttPhase.CANCELLED, state.phase)
    }

    @Test
    fun `hold over 520ms with privacy starts recording and finishes on release`() {
        var state = TaskPttGesture.onPressStart()
        state = TaskPttGesture.onTick(state, TaskPttGesture.HOLD_THRESHOLD_MS, privacyGranted = true)
        assertEquals(TaskPttPhase.RECORDING, state.phase)
        assertTrue(TaskPttGesture.shouldStartAsr(state, privacyGranted = true))
        assertEquals(
            TaskPttPointerOutcome.SUBMIT_RECORDING,
            TaskPttPointerOutcome.resolve(state.phase),
        )
        state = TaskPttGesture.onRelease(state)
        assertEquals(TaskPttPhase.FINISHED, state.phase)
    }

    @Test
    fun `without privacy enters preparing and does not start ASR`() {
        var state = TaskPttGesture.onPressStart()
        state = TaskPttGesture.onTick(state, TaskPttGesture.HOLD_THRESHOLD_MS, privacyGranted = false)
        assertEquals(TaskPttPhase.PREPARING, state.phase)
        assertFalse(TaskPttGesture.shouldStartAsr(state, privacyGranted = false))
        assertEquals(TaskPttPointerOutcome.IGNORE, TaskPttPointerOutcome.resolve(state.phase))
        state = TaskPttGesture.onRelease(state)
        assertEquals(TaskPttPhase.CANCELLED, state.phase)
    }

    @Test
    fun `slide up past 56dp cancels`() {
        var state = TaskPttGesture.onPressStart()
        state = TaskPttGesture.onTick(state, TaskPttGesture.HOLD_THRESHOLD_MS, privacyGranted = true)
        state = TaskPttGesture.onDrag(state, -TaskPttGesture.CANCEL_DISTANCE_DP)
        assertEquals(TaskPttPhase.CANCEL_ARMED, state.phase)
        assertEquals(TaskPttPointerOutcome.CANCEL, TaskPttPointerOutcome.resolve(state.phase))
        state = TaskPttGesture.onRelease(state)
        assertEquals(TaskPttPhase.CANCELLED, state.phase)
    }

    @Test
    fun `jitter tolerance accepts small movement`() {
        assertTrue(TaskPttGesture.isWithinJitter(10f, -8f))
        assertFalse(TaskPttGesture.isWithinJitter(20f, 0f))
    }

    @Test
    fun `cancel requires abs dx within 12dp and dy past 56dp`() {
        var state = TaskPttGesture.onPressStart()
        state = TaskPttGesture.onTick(state, TaskPttGesture.HOLD_THRESHOLD_MS, privacyGranted = true)
        // 上滑但水平超出抖动 → 不武装取消（对齐 iOS）
        state = TaskPttGesture.onDrag(state, dragXDp = 20f, dragYDp = -60f)
        assertEquals(TaskPttPhase.RECORDING, state.phase)
        // 水平在容差内 + 上滑够远 → 取消
        state = TaskPttGesture.onDrag(state, dragXDp = 8f, dragYDp = -56f)
        assertEquals(TaskPttPhase.CANCEL_ARMED, state.phase)
        assertTrue(TaskPttGesture.isCancelArmed(8f, -56f))
        assertFalse(TaskPttGesture.isCancelArmed(20f, -60f))
    }

    @Test
    fun `system cancel is not a hold-established outcome`() {
        var state = TaskPttGesture.onPressStart()
        state = TaskPttGesture.onSystemCancel(state)
        assertEquals(TaskPttPhase.CANCELLED, state.phase)
        assertEquals(TaskPttPointerOutcome.IGNORE, TaskPttPointerOutcome.resolve(TaskPttPhase.CANCELLED))
    }

    @Test
    fun `pressing phase never starts ASR before threshold`() {
        val state = TaskPttGesture.onPressStart()
        assertFalse(TaskPttGesture.shouldStartAsr(state, privacyGranted = true))
        assertFalse(
            TaskPttGesture.shouldStartAsr(
                TaskPttGesture.onTick(state, 519, privacyGranted = true),
                privacyGranted = true,
            ),
        )
    }
}
