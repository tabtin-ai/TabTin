package com.tabtin.mobile.features.conversation

import kotlin.math.exp
import kotlin.math.min

/**
 * 对话生图假进度：ease-out 指数逼近，封顶 92%；工具终态再冲到 100%。
 * 对齐 Electron `imageGeneratingProgress.ts`——连续浮点，供 scaleX 每帧平滑推进。
 */
public object ImageGeneratingProgress {
    public const val DEFAULT_TAU_MS: Long = 18_000L

    @JvmStatic
    public fun compute(
        elapsedMs: Long,
        tauMs: Long = DEFAULT_TAU_MS,
        done: Boolean,
    ): Float {
        if (done) return 100f
        if (tauMs <= 0L || elapsedMs < 0L) return 0f
        val raw = 100.0 * (1.0 - exp(-elapsedMs.toDouble() / tauMs.toDouble()))
        return min(92.0, raw).toFloat()
    }
}
