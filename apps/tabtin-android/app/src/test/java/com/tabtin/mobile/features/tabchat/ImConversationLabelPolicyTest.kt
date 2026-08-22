package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ImConversation
import com.tabtin.mobile.data.im.ImConversationLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class ImConversationLabelPolicyTest {
    @Test
    public fun `label catalog always exposes mention system filter first`() {
        val custom = ImConversationLabel(id = "label-1", name = "客户")

        val catalog = imConversationLabelCatalog(listOf(custom))

        assertEquals(IM_SYSTEM_MENTION_LABEL_ID, catalog.first().id)
        assertTrue(catalog.first().isSystem)
        assertEquals(custom, catalog.last())
    }

    @Test
    public fun `conversation label filters use AND semantics`() {
        val conversation = ImConversation(
            id = "conversation-1",
            labels = listOf(
                ImConversationLabel(id = "label-a", name = "A"),
                ImConversationLabel(id = "label-b", name = "B"),
            ),
        )

        assertTrue(imConversationMatchesLabelFilters(conversation, emptySet()))
        assertTrue(imConversationMatchesLabelFilters(conversation, setOf("label-a")))
        assertTrue(imConversationMatchesLabelFilters(conversation, setOf("label-a", "label-b")))
        assertFalse(imConversationMatchesLabelFilters(conversation, setOf("label-a", "label-c")))
    }
}
