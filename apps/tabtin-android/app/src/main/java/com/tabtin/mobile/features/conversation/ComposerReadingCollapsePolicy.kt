package com.tabtin.mobile.features.conversation

/** 消息列表滚动态快照：驱动「阅读时 Composer 收敛」。与 iOS `MessageListScrollState` 对齐。 */
internal data class MessageListScrollState(
    /** 手指正在拖动，或松手后的惯性滚动还没停。 */
    val isUserScrolling: Boolean = false,
    /** 视口停在（或已回到）最新消息处。 */
    val isAtBottom: Boolean = true,
) {
    companion object {
        /** 初始态：没在滚，停在最新消息处。 */
        val SETTLED_AT_BOTTOM = MessageListScrollState()
    }
}

/**
 * Composer 的「阅读态收敛」决策。与 iOS `ComposerReadingCollapsePolicy` 同构。
 *
 * 产品意图：开始翻消息 = 用户在读、不在写。此时输入区让出屏幕高度，收成一行悬浮
 * 胶囊；回到最新消息处再自然展开。收敛只折叠输入井的视觉体积，不改变任何可发送
 * 状态——运行控制（停止 / 继续）在收敛态照样在位。
 */
internal object ComposerReadingCollapsePolicy {
    /**
     * 滚动层判据：滚动中一律收敛；停下后只有「停在底部」才展开——停在历史中间说明
     * 用户还在读。
     *
     * 滚动过程中刻意不看 [MessageListScrollState.isAtBottom]，是为了避开这条自激回路：
     * 收敛让输入区变矮 → 列表可视高度变大 → 判成贴底 → 展开 → 变矮 → 又不贴底 →
     * 再收敛。判据只在滚动停下后取一次，回路就断了。
     */
    fun scrollWantsCollapse(state: MessageListScrollState): Boolean {
        if (state.isUserScrolling) return true
        return !state.isAtBottom
    }

    /**
     * 内容层判据：输入区里只要有用户自己的东西（草稿 / 附件 / 引用 / 正在输入），或有
     * 必须让他看见的东西（硬门闩禁发原因），就一律不收——收敛绝不能藏掉写了一半的
     * 内容或发不出去的原因。
     */
    fun shouldCollapse(
        scrollWantsCollapse: Boolean,
        isFocused: Boolean,
        hasDraftText: Boolean,
        hasAttachments: Boolean,
        hasContextRefs: Boolean,
        hasBlockingReason: Boolean,
    ): Boolean {
        if (!scrollWantsCollapse) return false
        if (isFocused || hasDraftText || hasAttachments || hasContextRefs) return false
        if (hasBlockingReason) return false
        return true
    }
}
