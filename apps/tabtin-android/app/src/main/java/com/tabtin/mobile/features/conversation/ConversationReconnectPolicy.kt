package com.tabtin.mobile.features.conversation

/**
 * 详情页抖动后的恢复闸门。停在同一 VM 上时 generation 不变，卡死来自
 * lastSeq / 未等 subscribe.ok 就 resume / 流式期整段 abort HTTP。
 */
internal object ConversationReconnectPolicy {
    enum class ReconcileTick { Apply, SkipWait, Abort }

    enum class SeqDecision { Apply, Drop, Reset }

    const val ACCEPT_LOWER_SEQ_WINDOW_MS = 8_000L

    fun shouldResetSeqCursor(connectedAfterDrop: Boolean): Boolean = connectedAfterDrop

    /**
     * 重连回放的 `_seq` 与断线前同一套（host 不重置）。授权事件没有 `_seq`，
     * 所以 HITL 还能弹；流式 delta 若仍按 `seq <= last` 丢，气泡就会停住。
     */
    fun decideSeq(
        previous: Int?,
        incoming: Int,
        acceptLowerSeq: Boolean,
    ): SeqDecision {
        if (incoming == 1 && !acceptLowerSeq) return SeqDecision.Reset
        if (previous != null && incoming <= previous && !acceptLowerSeq) return SeqDecision.Drop
        return SeqDecision.Apply
    }

    fun shouldReplaceStreamingHistory(streamingActive: Boolean): Boolean = !streamingActive

    fun shouldWaitForSubscribeBeforeResume(
        wasReconnect: Boolean,
        hasDesiredTopics: Boolean,
    ): Boolean = wasReconnect && hasDesiredTopics

    fun reconcileTick(
        sessionMatches: Boolean,
        generationMatches: Boolean,
        streamingActive: Boolean,
        allowWhileStreaming: Boolean,
    ): ReconcileTick {
        if (!sessionMatches || !generationMatches) return ReconcileTick.Abort
        if (streamingActive && !allowWhileStreaming) return ReconcileTick.SkipWait
        return ReconcileTick.Apply
    }
}
