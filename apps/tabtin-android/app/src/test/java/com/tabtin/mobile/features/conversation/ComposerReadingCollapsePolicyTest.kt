package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerReadingCollapsePolicyTest {
    // region 滚动层

    @Test
    fun scrollingAlwaysWantsCollapse() {
        // 滚动中即便算出「贴底」也要收——收敛会让输入区变矮，滚动期间信任它就会触发
        // 收敛 → 判成贴底 → 展开 → 又不贴底 的自激抖动。
        assertTrue(
            ComposerReadingCollapsePolicy.scrollWantsCollapse(
                MessageListScrollState(isUserScrolling = true, isAtBottom = true),
            ),
        )
        assertTrue(
            ComposerReadingCollapsePolicy.scrollWantsCollapse(
                MessageListScrollState(isUserScrolling = true, isAtBottom = false),
            ),
        )
    }

    @Test
    fun settledAtBottomWantsExpand() {
        assertFalse(
            ComposerReadingCollapsePolicy.scrollWantsCollapse(
                MessageListScrollState.SETTLED_AT_BOTTOM,
            ),
        )
    }

    @Test
    fun settledInHistoryStaysCollapsed() {
        assertTrue(
            ComposerReadingCollapsePolicy.scrollWantsCollapse(
                MessageListScrollState(isUserScrolling = false, isAtBottom = false),
            ),
        )
    }

    // endregion

    // region 内容层

    @Test
    fun collapsesWhenNothingToProtect() {
        assertTrue(collapse(scrollWantsCollapse = true))
    }

    @Test
    fun neverCollapsesWhenScrollDoesNotAskForIt() {
        assertFalse(collapse(scrollWantsCollapse = false))
    }

    @Test
    fun keepsExpandedWhileTyping() {
        assertFalse(collapse(scrollWantsCollapse = true, isFocused = true))
    }

    @Test
    fun keepsExpandedWithHalfWrittenDraft() {
        assertFalse(collapse(scrollWantsCollapse = true, hasDraftText = true))
    }

    @Test
    fun keepsExpandedWithPendingMaterials() {
        assertFalse(collapse(scrollWantsCollapse = true, hasAttachments = true))
        assertFalse(collapse(scrollWantsCollapse = true, hasContextRefs = true))
    }

    @Test
    fun keepsExpandedSoBlockingReasonStaysVisible() {
        assertFalse(collapse(scrollWantsCollapse = true, hasBlockingReason = true))
    }

    // endregion

    private fun collapse(
        scrollWantsCollapse: Boolean,
        isFocused: Boolean = false,
        hasDraftText: Boolean = false,
        hasAttachments: Boolean = false,
        hasContextRefs: Boolean = false,
        hasBlockingReason: Boolean = false,
    ): Boolean = ComposerReadingCollapsePolicy.shouldCollapse(
        scrollWantsCollapse = scrollWantsCollapse,
        isFocused = isFocused,
        hasDraftText = hasDraftText,
        hasAttachments = hasAttachments,
        hasContextRefs = hasContextRefs,
        hasBlockingReason = hasBlockingReason,
    )
}
