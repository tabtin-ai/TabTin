package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CapsulePointerReducerTest {

    @Test
    fun `still hold 420ms opens menu`() {
        val reducer = CapsulePointerReducer()
        reducer.handle(CapsulePointerEvent.TouchBegan)
        assertEquals(CapsulePointerPhase.PRESSING, reducer.phase)

        reducer.handle(CapsulePointerEvent.HoldElapsed(419))
        assertEquals(CapsulePointerPhase.PRESSING, reducer.phase)
        assertNull(reducer.pendingOutcome)

        reducer.handle(CapsulePointerEvent.HoldElapsed(420))
        assertEquals(CapsulePointerPhase.MENU_OPEN, reducer.phase)
        assertEquals(CapsulePointerOutcome.MenuOpened, reducer.pendingOutcome)
    }

    @Test
    fun `move beyond threshold before hold enters dragging and blocks menu`() {
        val reducer = CapsulePointerReducer()
        reducer.handle(CapsulePointerEvent.TouchBegan)
        reducer.handle(CapsulePointerEvent.TouchMoved(dx = 13f, dy = 0f))
        assertEquals(CapsulePointerPhase.DRAGGING, reducer.phase)

        reducer.handle(CapsulePointerEvent.HoldElapsed(420))
        assertEquals(CapsulePointerPhase.DRAGGING, reducer.phase)
        assertNull(reducer.pendingOutcome)
    }

    @Test
    fun `short release while pressing emits tap`() {
        val reducer = CapsulePointerReducer()
        reducer.handle(CapsulePointerEvent.TouchBegan)
        reducer.handle(CapsulePointerEvent.TouchEnded)
        assertEquals(CapsulePointerPhase.IDLE, reducer.phase)
        assertEquals(CapsulePointerOutcome.Tap, reducer.pendingOutcome)
    }

    @Test
    fun `touch cancelled returns to idle`() {
        val reducer = CapsulePointerReducer()
        reducer.handle(CapsulePointerEvent.TouchBegan)
        reducer.handle(CapsulePointerEvent.TouchCancelled)
        assertEquals(CapsulePointerPhase.IDLE, reducer.phase)
        assertNull(reducer.pendingOutcome)
    }

    @Test
    fun `drag end on release while dragging`() {
        val reducer = CapsulePointerReducer()
        reducer.handle(CapsulePointerEvent.TouchBegan)
        reducer.handle(CapsulePointerEvent.TouchMoved(dx = 20f, dy = 0f))
        reducer.handle(CapsulePointerEvent.TouchEnded)
        assertEquals(CapsulePointerPhase.IDLE, reducer.phase)
        assertEquals(CapsulePointerOutcome.DragEnd, reducer.pendingOutcome)
    }

    @Test
    fun `menu selection and dismiss return to idle`() {
        val reducer = CapsulePointerReducer()
        reducer.handle(CapsulePointerEvent.TouchBegan)
        reducer.handle(CapsulePointerEvent.HoldElapsed(420))
        assertEquals(CapsulePointerPhase.MENU_OPEN, reducer.phase)

        reducer.handle(CapsulePointerEvent.SelectMenu(CapsuleMenuSelection.TEXT))
        assertEquals(CapsulePointerPhase.IDLE, reducer.phase)
        assertEquals(
            CapsulePointerOutcome.MenuSelection(CapsuleMenuSelection.TEXT),
            reducer.pendingOutcome,
        )

        reducer.handle(CapsulePointerEvent.TouchBegan)
        reducer.handle(CapsulePointerEvent.HoldElapsed(420))
        reducer.handle(CapsulePointerEvent.DismissMenu)
        assertEquals(CapsulePointerPhase.IDLE, reducer.phase)
        assertEquals(CapsulePointerOutcome.MenuDismissed, reducer.pendingOutcome)
    }

    @Test
    fun `moving while menu open keeps menu for input selection`() {
        val reducer = CapsulePointerReducer()
        reducer.handle(CapsulePointerEvent.TouchBegan)
        reducer.handle(CapsulePointerEvent.HoldElapsed(420))
        assertEquals(CapsulePointerPhase.MENU_OPEN, reducer.phase)

        reducer.handle(CapsulePointerEvent.TouchMoved(dx = 0f, dy = -80f))
        assertEquals(CapsulePointerPhase.MENU_OPEN, reducer.phase)
        assertNull(reducer.pendingOutcome)

        reducer.handle(CapsulePointerEvent.TouchEnded)
        assertEquals(CapsulePointerPhase.MENU_OPEN, reducer.phase)
        assertNull(reducer.pendingOutcome)
    }

    @Test
    fun `onboarding prompts tap first and drag on the next appearance`() {
        var progress = CapsuleOnboardingProgress().recordAppearance()

        assertEquals(CapsuleOnboardingAction.TAP, progress.nextPrompt(replySuggested = false))
        progress = progress.markPromptShown().markLearned(CapsuleOnboardingAction.TAP)
        assertNull(progress.nextPrompt(replySuggested = false))

        progress = progress.recordAppearance()
        assertEquals(CapsuleOnboardingAction.DRAG, progress.nextPrompt(replySuggested = false))
    }

    @Test
    fun `onboarding prioritizes contextual hold after tap`() {
        val progress = CapsuleOnboardingProgress(
            appearanceCount = 2,
            tapLearned = true,
        )

        assertEquals(CapsuleOnboardingAction.HOLD, progress.nextPrompt(replySuggested = true))
        assertEquals(CapsuleOnboardingAction.DRAG, progress.nextPrompt(replySuggested = false))
    }

    @Test
    fun `onboarding discovery and skip suppress future prompts`() {
        val learned = CapsuleOnboardingProgress(appearanceCount = 3)
            .markLearned(CapsuleOnboardingAction.TAP)
            .markLearned(CapsuleOnboardingAction.DRAG)
            .markLearned(CapsuleOnboardingAction.HOLD)
        assertNull(learned.nextPrompt(replySuggested = true))

        assertNull(
            CapsuleOnboardingProgress(appearanceCount = 1)
                .skipAll()
                .nextPrompt(replySuggested = true),
        )
    }
}
