package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TaskSurfaceMorphTest {
    private lateinit var morph: TaskSurfaceMorphCoordinator

    @Before
    fun setUp() {
        morph = TaskSurfaceMorphCoordinator()
    }

    @Test
    fun `timing matches Electron chatCapsuleMorph`() {
        assertEquals(420, TaskSurfaceMorphTiming.DURATION_MS)
        assertEquals(140, TaskSurfaceMorphTiming.GHOST_FADE_MS)
        assertEquals(1000, TaskSurfaceMorphTiming.PENDING_TTL_MS)
        assertEquals(260, TaskSurfaceMorphTiming.PHONE_CAPSULE_MORPH_MS)
        assertEquals(0.77f, TaskSurfaceMorphTiming.EASING_X1, 0.001f)
        assertEquals(0f, TaskSurfaceMorphTiming.EASING_Y1, 0.001f)
        assertEquals(0.175f, TaskSurfaceMorphTiming.EASING_X2, 0.001f)
        assertEquals(1f, TaskSurfaceMorphTiming.EASING_Y2, 0.001f)
    }

    @Test
    fun `split to app focus captures rail and hides capsule`() {
        val now = 1_000L
        val rail = MorphRect(0f, 0f, 400f, 800f)
        val direction = morph.beginTransition(
            previous = TaskSurfaceMode.SPLIT,
            next = TaskSurfaceMode.APP_FOCUS,
            railRect = rail,
            capsuleRect = null,
            reduceMotion = false,
            nowMs = now,
        )
        assertEquals(TaskSurfaceMorphDirection.TO_CAPSULE, direction)
        assertTrue(morph.shouldHideCapsule(now))
        assertTrue(morph.hasPending(TaskSurfaceMorphDirection.TO_CAPSULE, now))
        assertEquals(rail, morph.pendingFromRect)
    }

    @Test
    fun `app focus to split captures capsule and hides rail`() {
        val now = 1_000L
        val capsule = MorphRect(700f, 700f, 48f, 48f)
        val direction = morph.beginTransition(
            previous = TaskSurfaceMode.APP_FOCUS,
            next = TaskSurfaceMode.SPLIT,
            railRect = null,
            capsuleRect = capsule,
            reduceMotion = false,
            nowMs = now,
        )
        assertEquals(TaskSurfaceMorphDirection.TO_RAIL, direction)
        assertTrue(morph.shouldHideRail(now))
    }

    @Test
    fun `wrong direction consume keeps pending`() {
        val now = 1_000L
        morph.beginTransition(
            previous = TaskSurfaceMode.SPLIT,
            next = TaskSurfaceMode.APP_FOCUS,
            railRect = MorphRect(0f, 0f, 400f, 800f),
            capsuleRect = null,
            reduceMotion = false,
            nowMs = now,
        )
        assertFalse(
            morph.consume(
                direction = TaskSurfaceMorphDirection.TO_RAIL,
                targetRect = MorphRect(700f, 700f, 48f, 48f),
                nowMs = now,
            ),
        )
        assertTrue(morph.hasPending(TaskSurfaceMorphDirection.TO_CAPSULE, now))
        assertTrue(
            morph.consume(
                direction = TaskSurfaceMorphDirection.TO_CAPSULE,
                targetRect = MorphRect(700f, 700f, 48f, 48f),
                nowMs = now,
            ),
        )
        assertTrue(morph.hasActiveGhost)
    }

    @Test
    fun `pending expires by TTL`() {
        val now = 1_000L
        morph.beginTransition(
            previous = TaskSurfaceMode.SPLIT,
            next = TaskSurfaceMode.APP_FOCUS,
            railRect = MorphRect(0f, 0f, 400f, 800f),
            capsuleRect = null,
            reduceMotion = false,
            nowMs = now,
        )
        val expired = now + TaskSurfaceMorphTiming.PENDING_TTL_MS + 50
        assertFalse(morph.hasPending(TaskSurfaceMorphDirection.TO_CAPSULE, expired))
        assertFalse(
            morph.consume(
                direction = TaskSurfaceMorphDirection.TO_CAPSULE,
                targetRect = MorphRect(700f, 700f, 48f, 48f),
                nowMs = expired,
            ),
        )
    }

    /**
     * Reduce Motion 验收：跳过 ghost、清 hide；宿主应立即切几何且焦点跟 mode
     *（真机：Settings → 动画时长缩放 = 关）。
     */
    @Test
    fun `reduce motion clears active and skips capture`() {
        val now = 1_000L
        morph.beginTransition(
            previous = TaskSurfaceMode.SPLIT,
            next = TaskSurfaceMode.APP_FOCUS,
            railRect = MorphRect(0f, 0f, 400f, 800f),
            capsuleRect = null,
            reduceMotion = false,
            nowMs = now,
        )
        morph.consume(
            direction = TaskSurfaceMorphDirection.TO_CAPSULE,
            targetRect = MorphRect(700f, 700f, 48f, 48f),
            nowMs = now,
        )
        assertTrue(morph.hasActiveGhost)

        val direction = morph.beginTransition(
            previous = TaskSurfaceMode.APP_FOCUS,
            next = TaskSurfaceMode.SPLIT,
            railRect = MorphRect(0f, 0f, 400f, 800f),
            capsuleRect = MorphRect(700f, 700f, 48f, 48f),
            reduceMotion = true,
            nowMs = now + 100,
        )
        assertNull(direction)
        assertFalse(morph.hasActiveGhost)
        assertFalse(morph.shouldHideCapsule(now + 100))
        assertFalse(morph.shouldHideRail(now + 100))
    }

    /** 冷启动即 Reduce Motion：不捕获、不 pending。 */
    @Test
    fun `reduce motion on first transition skips morph entirely`() {
        val direction = morph.beginTransition(
            previous = TaskSurfaceMode.SPLIT,
            next = TaskSurfaceMode.APP_FOCUS,
            railRect = MorphRect(0f, 0f, 400f, 800f),
            capsuleRect = MorphRect(700f, 700f, 48f, 48f),
            reduceMotion = true,
            nowMs = 500L,
        )
        assertNull(direction)
        assertNull(morph.pendingFromRect)
        assertFalse(morph.hasActiveGhost)
        assertFalse(morph.shouldHideCapsule(500L))
        assertFalse(morph.shouldHideRail(500L))
    }

    @Test
    fun `third state clears active pending and hide`() {
        val t0 = 3_000L
        morph.beginTransition(
            previous = TaskSurfaceMode.SPLIT,
            next = TaskSurfaceMode.APP_FOCUS,
            railRect = MorphRect(0f, 0f, 400f, 800f),
            capsuleRect = null,
            reduceMotion = false,
            nowMs = t0,
        )
        morph.consume(
            direction = TaskSurfaceMorphDirection.TO_CAPSULE,
            targetRect = MorphRect(700f, 700f, 120f, 48f),
            nowMs = t0,
        )
        assertTrue(morph.hasActiveGhost)
        val genBefore = morph.currentGeneration

        // 快速切到 chat-focus（第三态）：清场且推进 generation
        val direction = morph.beginTransition(
            previous = TaskSurfaceMode.APP_FOCUS,
            next = TaskSurfaceMode.CHAT_FOCUS,
            railRect = MorphRect(0f, 0f, 400f, 800f),
            capsuleRect = MorphRect(700f, 700f, 120f, 48f),
            reduceMotion = false,
            nowMs = t0 + 50,
        )
        assertNull(direction)
        assertTrue(morph.currentGeneration > genBefore)
        assertFalse(morph.hasActiveGhost)
        assertFalse(morph.shouldHideCapsule(t0 + 50))
        assertFalse(morph.shouldHideRail(t0 + 50))
        assertNull(morph.pendingFromRect)
    }

    @Test
    fun `completeGhost ignores stale generation`() {
        val t0 = 4_000L
        morph.beginTransition(
            previous = TaskSurfaceMode.SPLIT,
            next = TaskSurfaceMode.APP_FOCUS,
            railRect = MorphRect(0f, 0f, 400f, 800f),
            capsuleRect = null,
            reduceMotion = false,
            nowMs = t0,
        )
        val gen = morph.currentGeneration
        morph.consume(
            direction = TaskSurfaceMorphDirection.TO_CAPSULE,
            targetRect = MorphRect(700f, 700f, 48f, 48f),
            nowMs = t0,
        )
        morph.beginTransition(
            previous = TaskSurfaceMode.APP_FOCUS,
            next = TaskSurfaceMode.SPLIT,
            railRect = MorphRect(0f, 0f, 400f, 800f),
            capsuleRect = MorphRect(700f, 700f, 48f, 48f),
            reduceMotion = false,
            nowMs = t0 + 10,
        )
        // 旧 generation 的 complete 不得清掉新 transition 的 pending
        morph.completeGhost(t0 + 20, generation = gen)
        assertTrue(morph.hasPending(TaskSurfaceMorphDirection.TO_RAIL, t0 + 20))
    }

    @Test
    fun `mid flight reverse leaves no residue`() {
        val t0 = 2_000L
        morph.beginTransition(
            previous = TaskSurfaceMode.SPLIT,
            next = TaskSurfaceMode.APP_FOCUS,
            railRect = MorphRect(0f, 0f, 400f, 800f),
            capsuleRect = null,
            reduceMotion = false,
            nowMs = t0,
        )
        morph.consume(
            direction = TaskSurfaceMorphDirection.TO_CAPSULE,
            targetRect = MorphRect(700f, 700f, 48f, 48f),
            nowMs = t0,
        )
        val mid = t0 + TaskSurfaceMorphTiming.DURATION_MS / 2
        val interrupted = morph.cancelActiveMorph(mid)
        assertNotNull(interrupted)
        assertFalse(morph.hasActiveGhost)
        assertTrue(interrupted!!.left > 0f)
        assertTrue(interrupted.left < 700f)

        val direction = morph.beginTransition(
            previous = TaskSurfaceMode.APP_FOCUS,
            next = TaskSurfaceMode.SPLIT,
            railRect = MorphRect(0f, 0f, 400f, 800f),
            capsuleRect = interrupted,
            reduceMotion = false,
            nowMs = mid,
        )
        assertEquals(TaskSurfaceMorphDirection.TO_RAIL, direction)
        morph.consume(
            direction = TaskSurfaceMorphDirection.TO_RAIL,
            targetRect = MorphRect(0f, 0f, 400f, 800f),
            nowMs = mid,
        )
        val finished = mid + TaskSurfaceMorphTiming.DURATION_MS + TaskSurfaceMorphTiming.GHOST_FADE_MS + 10
        morph.completeGhost(finished)
        assertFalse(morph.hasActiveGhost)
        assertFalse(morph.shouldHideRail(finished))
        assertFalse(morph.shouldHideCapsule(finished))
    }

    @Test
    fun `stable geometry pins workbench to trailing edge`() {
        val chat = TaskSurfaceStableLayout.geometry(
            mode = TaskSurfaceMode.CHAT_FOCUS,
            availableWidthDp = 1000f,
            workbenchFraction = 0.4f,
        )
        assertEquals(1000f, chat.conversationWidthDp, 0.1f)
        assertEquals(0f, chat.workbenchWidthDp, 0.1f)
        assertEquals(0f, chat.workbenchTrailingInsetDp, 0.1f)

        val split = TaskSurfaceStableLayout.geometry(
            mode = TaskSurfaceMode.SPLIT,
            availableWidthDp = 1000f,
            workbenchFraction = 0.4f,
        )
        assertEquals(400f, split.workbenchWidthDp, 0.1f)
        assertTrue(split.conversationWidthDp > 0f)
        assertEquals(0f, split.workbenchTrailingInsetDp, 0.1f)

        val app = TaskSurfaceStableLayout.geometry(
            mode = TaskSurfaceMode.APP_FOCUS,
            availableWidthDp = 1000f,
            workbenchFraction = 0.4f,
        )
        assertEquals(1000f, app.workbenchWidthDp, 0.1f)
        assertEquals(0f, app.conversationWidthDp, 0.1f)
    }

    @Test
    fun `keep alive composition tree stays mounted in chat focus on tablet`() {
        assertTrue(
            TaskSurfaceCoordinator.shouldComposeWorkbench(
                mode = TaskSurfaceMode.CHAT_FOCUS,
                everOpened = true,
                workbenchOpen = false,
                widthDp = 760,
            ),
        )
        assertTrue(
            TaskSurfaceCoordinator.shouldComposeConversation(
                mode = TaskSurfaceMode.APP_FOCUS,
                everOpened = true,
            ),
        )
        assertFalse(
            TaskSurfaceCoordinator.shouldComposeWorkbench(
                mode = TaskSurfaceMode.CHAT_FOCUS,
                everOpened = false,
                workbenchOpen = false,
                widthDp = 760,
            ),
        )
        // 窄屏不在 TaskSurfaceHost 内组合（走 ChatSessionScreen TASK_PANE 切面）
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
                everOpened = true,
                workbenchOpen = false,
            ),
        )
    }
}
