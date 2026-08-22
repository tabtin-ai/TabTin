package com.tabtin.mobile.features.conversation

/**
 * 流式尾巴只淡「上一帧之后的后缀」。
 * 重写 / 回退整段当 prefix，不动画；token 快于淡入时只跟最新后缀。
 */
internal object StreamingTailRevealPolicy {
    const val INCOMING_FADE_MS: Int = 100
    const val CARET_BLINK_MS: Int = 530
    const val INCOMING_START_ALPHA: Float = 0.4f

    data class Reveal(
        val prefix: String,
        val incoming: String,
        val shouldAnimateIncoming: Boolean,
    )

    fun reveal(previousTail: String, nextTail: String): Reveal {
        if (nextTail.startsWith(previousTail)) {
            val incoming = nextTail.substring(previousTail.length)
            return Reveal(
                prefix = previousTail,
                incoming = incoming,
                shouldAnimateIncoming = incoming.isNotEmpty(),
            )
        }
        return Reveal(
            prefix = nextTail,
            incoming = "",
            shouldAnimateIncoming = false,
        )
    }
}
