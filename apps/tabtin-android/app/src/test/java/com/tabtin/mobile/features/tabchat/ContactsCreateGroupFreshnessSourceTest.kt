package com.tabtin.mobile.features.tabchat

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** 回归：通讯录与消息首页使用不同 ViewModel 时，新群入口仍必须重新拉取联系人目录。 */
class ContactsCreateGroupFreshnessSourceTest {

    @Test
    fun openingCreateGroupReloadsTheDirectoryBeforeRenderingCandidates() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/tabchat/RecentMessagesSection.kt",
        ).readText()
        val dialog = source.substringAfter("public fun CreateGroupDialog(")
            .substringBefore("private fun ExternalGroupMemberChoice(")

        assertTrue(
            "新群弹窗出现时必须刷新独立 ContactsViewModel，避免刚接受的外部联系人要冷启动后才可选",
            dialog.contains("LaunchedEffect(viewModel) { viewModel.reload() }"),
        )
    }
}
