package com.tabtin.mobile.features.conversation

/**
 * 会话列表贴底策略：流式正文变长时禁止走「首屏 settleLayout」路径，
 * 避免 `LaunchedEffect(state.messages)` 每 50ms 触发三帧 `scrollToItem` 造成跳动。
 */
internal object ConversationStreamScrollPolicy {
    /**
     * 是否允许跑首屏 / 历史灌入的 settle 贴底。
     *
     * - 流式进行中且已贴过底 → 否（改由 [streamingAppend] 单通道微调）
     * - 首屏或权威历史尚未落定 → 是
     * - 两者都已落定 → 否（新消息走 messages.size → pendingScroll）
     */
    fun shouldRunInitialSettle(
        focusMessageIdBlank: Boolean,
        hasMessages: Boolean,
        isLoadingMore: Boolean,
        isStreaming: Boolean,
        hasSettledInitialPosition: Boolean,
        hasSettledInitialHistory: Boolean,
    ): Boolean {
        if (!focusMessageIdBlank || !hasMessages || isLoadingMore) return false
        if (isStreaming && hasSettledInitialPosition) return false
        return !hasSettledInitialPosition || !hasSettledInitialHistory
    }

    /** 消息 id 序列：历史整表替换时 size 不变也能触发首屏校正，正文 delta 不变。 */
    fun messageIdentityKey(messageIds: List<String>): String =
        messageIds.joinToString(separator = "\u0001")

    /**
     * 流式贴底 pin 只能由用户手势改。补偿用的程序滚动会把
     * [androidx.compose.foundation.lazy.LazyListState.isScrollInProgress] 置真，
     * 那时往往还没贴死底，若按 [nearBottom] 写 pin 会把跟底掐断。
     */
    fun nextPinnedToBottom(
        currentlyPinned: Boolean,
        nearBottom: Boolean,
        isStreaming: Boolean,
        isUserDragging: Boolean,
        userScrollSettled: Boolean,
    ): Boolean {
        if (isUserDragging || userScrollSettled || !isStreaming) return nearBottom
        return currentlyPinned
    }

    /**
     * 末条已在视野里，或流式只跟尾边时，禁止 [androidx.compose.foundation.lazy.LazyListState.scrollToItem]：
     * 它会先把末条顶对齐到视口顶，高气泡会整页上甩。
     */
    fun shouldJumpToLastItem(
        lastAlreadyVisible: Boolean,
        trailingOnly: Boolean,
    ): Boolean = !trailingOnly && !lastAlreadyVisible

    /** 流式跟尾：已 pin、未在翻历史、手指没按着。 */
    fun shouldFollowStreamingTail(
        pinned: Boolean,
        isLoadingMore: Boolean,
        isUserDragging: Boolean,
        isStreaming: Boolean,
    ): Boolean = pinned && isStreaming && !isLoadingMore && !isUserDragging

    /**
     * `canScrollForward == false` 是零容差。流式时长高会让它刚贴底又变 true，
     * 若用它改 pin，滑到底也会被判成「在历史里」而冻住视窗。
     */
    fun shouldUpdatePinFromStrictEnd(isStreaming: Boolean): Boolean = !isStreaming

    /**
     * 贴底判定：真正滚不动，或末条尾边只超出 [slackPx]。
     * 滑到上方（尾边超出容差）才冻视窗；滑到底要能重新 pin。
     */
    fun isAtBottomForPin(
        canScrollForward: Boolean,
        trailingOverflowPx: Int,
        slackPx: Int,
    ): Boolean {
        if (!canScrollForward) return true
        return trailingOverflowPx <= slackPx
    }
}
