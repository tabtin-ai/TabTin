package com.tabtin.mobile.features.conversation

import kotlin.math.abs

/**
 * 对话层档位。窄屏下对话不是另一个场所，而是盖在工作台之上、可连续伸缩的一层。
 * [COLLAPSED] 时工作台在前台、胶囊可见；另两档对话可见、胶囊隐藏。
 */
internal enum class ConversationLayerDetent {
    /** 层收到视口下方，只剩胶囊。 */
    COLLAPSED,

    /** 半屏：下层工作台仍可见，点层外背景直接收起。 */
    SHEET,

    /** 扩展卡片：仍是工作台上的 overlay，保留圆角、抓手和下层露头。 */
    EXPANDED,
}

/**
 * 键盘只提升已经打开的对话层，不能因为用户在底层工作台编辑文档就凭空唤起对话。
 * 键盘消失时，仅恢复由本策略自动提升的半屏层；用户主动拉到扩展档不受影响。
 */
internal object ConversationLayerImePolicy {
    fun target(
        imeVisible: Boolean,
        detent: ConversationLayerDetent,
        expandedForIme: Boolean,
    ): ConversationLayerDetent? = when {
        imeVisible && detent == ConversationLayerDetent.SHEET ->
            ConversationLayerDetent.EXPANDED
        !imeVisible && expandedForIme && detent == ConversationLayerDetent.EXPANDED ->
            ConversationLayerDetent.SHEET
        else -> null
    }
}

/**
 * 层位置与松手吸附。[topRatio] 是层顶部在视口高度中的位置比例，
 * **越小越展开**（1 = 收到底部，0.09 = 扩展卡片）。速度向下为正，单位 dp/ms。
 *
 * 阈值与 `docs/agent/mobile-agent-capsule-layer-demo.html` 的 SNAPS / 0.55 对齐。
 */
internal object ConversationLayerGeometry {
    /** 抓手可见条很细，但触摸与读屏焦点区域不得小于 48dp。 */
    const val MIN_GRABBER_TOUCH_TARGET_DP: Int = 48

    const val COLLAPSED_TOP_RATIO: Float = 1f
    const val SHEET_TOP_RATIO: Float = 0.52f

    const val EXPANDED_TOP_RATIO: Float = 0.09f

    /** 超过此速度按甩动处理，只跨一档，避免一甩到底。 */
    const val FLING_DP_PER_MS: Float = 0.55f

    fun topRatio(detent: ConversationLayerDetent): Float = when (detent) {
        ConversationLayerDetent.COLLAPSED -> COLLAPSED_TOP_RATIO
        ConversationLayerDetent.SHEET -> SHEET_TOP_RATIO
        ConversationLayerDetent.EXPANDED -> EXPANDED_TOP_RATIO
    }

    fun clampTopRatio(topRatio: Float): Float =
        topRatio.coerceIn(EXPANDED_TOP_RATIO, COLLAPSED_TOP_RATIO)

    fun settle(topRatio: Float, velocityDpPerMs: Float): ConversationLayerDetent {
        val clamped = clampTopRatio(topRatio)
        if (abs(velocityDpPerMs) > FLING_DP_PER_MS) {
            return if (velocityDpPerMs < 0f) {
                // 向上甩：已在半屏或之上则到扩展卡片，否则先到半屏（含恰好停在半屏）
                if (clamped <= SHEET_TOP_RATIO) {
                    ConversationLayerDetent.EXPANDED
                } else {
                    ConversationLayerDetent.SHEET
                }
            } else {
                // 向下甩：已在半屏或之下则收起，否则先回半屏（含恰好停在半屏）
                if (clamped >= SHEET_TOP_RATIO) {
                    ConversationLayerDetent.COLLAPSED
                } else {
                    ConversationLayerDetent.SHEET
                }
            }
        }
        return ConversationLayerDetent.entries.minBy { abs(topRatio(it) - clamped) }
    }
}
