package com.tabtin.mobile.features.tabchat

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Test

class ImMessagePresentationContractTest {
    @Test
    fun `message actions do not expose retired multi select state`() {
        val source = File("src/main/java/com/tabtin/mobile/features/tabchat/ImConversationScreen.kt")
            .readText()

        assertFalse(source.contains("selectingMessages"))
        assertFalse(source.contains("selectedMessageIds"))
        assertFalse(source.contains("im_action_multi_select"))
        assertFalse(source.contains("onBeginSelection"))
    }
}
