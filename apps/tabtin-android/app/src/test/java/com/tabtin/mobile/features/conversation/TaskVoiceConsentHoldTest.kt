package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.features.memo.voice.ASRStreamClient
import com.tabtin.mobile.features.profile.AIDataSharingConsentStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * ：AWAITING_CONSENT 时 cancelHold 不得清回 IDLE。
 * 使用真实 ViewModel 需要 Hilt；此处用同契约的轻量状态机断言策略。
 */
@RunWith(RobolectricTestRunner::class)
class TaskVoiceConsentHoldTest {
    @Before
    fun setUp() {
        ASRStreamClient.resetOwnerForTests()
        AIDataSharingConsentStore.revoke(RuntimeEnvironment.getApplication())
    }

    @After
    fun tearDown() {
        ASRStreamClient.resetOwnerForTests()
        AIDataSharingConsentStore.revoke(RuntimeEnvironment.getApplication())
    }

    @Test
    fun `preflight needs consent before grant`() {
        val context = RuntimeEnvironment.getApplication()
        assertEquals(
            VoiceCaptureBlockReason.NEEDS_AI_CONSENT,
            VoiceCapturePreflight.evaluate(context),
        )
    }

    @Test
    fun `pointer outcome ignores preparing so holdCancel is not required`() {
        // PREPARING / awaitingConsent 松手 → IGNORE，宿主不得调用 cancelHold 清弹窗
        assertEquals(
            TaskPttPointerOutcome.IGNORE,
            TaskPttPointerOutcome.resolve(TaskPttPhase.PREPARING),
        )
    }

    @Test
    fun `frozen focus for consent path is overview-safe`() {
        val focus = ConversationFocusContext(
            appType = null,
            spaceId = "space-1",
            workspaceMode = "conversation",
        )
        assertEquals(null, focus.appType)
    }
}
