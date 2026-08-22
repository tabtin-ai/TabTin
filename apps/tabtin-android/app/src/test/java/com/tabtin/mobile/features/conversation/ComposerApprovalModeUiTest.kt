package com.tabtin.mobile.features.conversation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.GppBad
import androidx.compose.material.icons.filled.GppGood
import androidx.compose.material.icons.filled.Shield
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ConversationApprovalMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ComposerApprovalModeUiTest {

    @Test
    fun approvalIconsMatchElectronShieldFamily() {
        assertSame(Icons.Default.GppGood, composerApprovalIcon(ConversationApprovalMode.ALWAYS_ASK))
        assertSame(Icons.Default.Shield, composerApprovalIcon(ConversationApprovalMode.AUTO))
        assertSame(Icons.Default.GppBad, composerApprovalIcon(ConversationApprovalMode.FULL_ACCESS))
    }

    @Test
    fun approvalSummariesAlignWithElectronPermissionModeCopy() {
        assertEquals(
            R.string.chat_approval_mode_always_ask_summary,
            composerApprovalSummaryRes(ConversationApprovalMode.ALWAYS_ASK),
        )
        assertEquals(
            R.string.chat_approval_mode_auto_summary,
            composerApprovalSummaryRes(ConversationApprovalMode.AUTO),
        )
        assertEquals(
            R.string.chat_approval_mode_full_access_summary,
            composerApprovalSummaryRes(ConversationApprovalMode.FULL_ACCESS),
        )
    }

    @Test
    fun approvalTitlesUseShortLabels() {
        assertEquals(
            R.string.chat_approval_mode_always_ask_short,
            composerApprovalTitleRes(ConversationApprovalMode.ALWAYS_ASK),
        )
        assertEquals(
            R.string.chat_approval_mode_auto_short,
            composerApprovalTitleRes(ConversationApprovalMode.AUTO),
        )
        assertEquals(
            R.string.chat_approval_mode_full_access_short,
            composerApprovalTitleRes(ConversationApprovalMode.FULL_ACCESS),
        )
    }
}
