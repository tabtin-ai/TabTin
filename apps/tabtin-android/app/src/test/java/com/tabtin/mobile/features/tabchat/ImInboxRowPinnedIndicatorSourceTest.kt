package com.tabtin.mobile.features.tabchat

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** 回归：Android IM 收件箱必须显式标出置顶会话，对齐 iOS `IMInboxRow`。 */
class ImInboxRowPinnedIndicatorSourceTest {

    @Test
    fun pinnedConversationRendersAccessiblePinIndicatorBeforeTitle() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/tabchat/RecentMessagesSection.kt",
        ).readText()
        val inboxRow = source.substringAfter("private fun ImInboxRow(")
            .substringBefore("public fun CreateGroupDialog(")
        val titleRow = inboxRow.substringAfter("Row(verticalAlignment = Alignment.CenterVertically) {")
            .substringBefore("conversation.lastMessageAt?.let")

        assertTrue(titleRow.contains("if (conversation.pinned)"))
        assertTrue(titleRow.contains("Icons.Filled.PushPin"))
        assertTrue(titleRow.contains("R.string.im_messages_pinned"))
    }
}
