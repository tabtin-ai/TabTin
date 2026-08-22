package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 红信号：菜单语音必须 one-shot；粘性 tick 在「等价于胶囊重挂载」后不得再开火。
 */
class CapsuleMenuVoiceHandoffTest {
    @Test
    fun `first menu voice request fires once`() {
        assertTrue(CapsuleMenuVoiceHandoff.shouldBegin(requestGeneration = 1, consumedGeneration = 0))
    }

    @Test
    fun `same sticky tick after remount does not re-fire`() {
        // 用户点过菜单 → tick=1，已消费 → consumed=1；切会话卸载再回工作台 tick 仍为 1
        assertFalse(CapsuleMenuVoiceHandoff.shouldBegin(requestGeneration = 1, consumedGeneration = 1))
    }

    @Test
    fun `next menu selection advances and fires again`() {
        assertTrue(CapsuleMenuVoiceHandoff.shouldBegin(requestGeneration = 2, consumedGeneration = 1))
    }

    @Test
    fun `idle zero tick never fires`() {
        assertFalse(CapsuleMenuVoiceHandoff.shouldBegin(requestGeneration = 0, consumedGeneration = 0))
    }
}
