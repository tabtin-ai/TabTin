package com.tabtin.mobile.features.conversation

import android.content.Context
import kotlin.math.max
import kotlin.math.min

internal enum class CapsuleDockSide {
    LEFT,
    RIGHT,
}

internal data class CapsulePlacement(
    val side: CapsuleDockSide = CapsuleDockSide.RIGHT,
    /** 0 = 可拖区域顶部，1 = 底部。 */
    val yRatio: Float = 1f,
) {
    internal companion object {
        val DEFAULT: CapsulePlacement = CapsulePlacement()
    }
}

internal data class CapsulePlacementBounds(
    val minX: Float,
    val maxX: Float,
    val minY: Float,
    val maxY: Float,
)

internal object CapsulePlacementMetrics {
    const val SAFE_MARGIN_PX: Float = 14f
    const val HARD_TOP_INSET_PX: Float = 0f
}

internal object CapsulePlacementGeometry {
    fun clamp(value: Float, minValue: Float, maxValue: Float): Float =
        max(minValue, min(maxValue, value))

    fun resolveBounds(
        viewportWidth: Float,
        viewportHeight: Float,
        capsuleWidth: Float,
        capsuleHeight: Float,
        safeMargin: Float = CapsulePlacementMetrics.SAFE_MARGIN_PX,
        hardTopInset: Float = CapsulePlacementMetrics.HARD_TOP_INSET_PX,
    ): CapsulePlacementBounds {
        val margin = max(0f, safeMargin)
        val hardMaxX = max(0f, viewportWidth - capsuleWidth)
        val hardMaxY = max(0f, viewportHeight - capsuleHeight)

        val preferredMinX = margin
        val preferredMaxX = viewportWidth - margin - capsuleWidth
        val (minX, maxX) = if (preferredMinX <= preferredMaxX) {
            clamp(preferredMinX, 0f, hardMaxX) to clamp(preferredMaxX, 0f, hardMaxX)
        } else {
            0f to hardMaxX
        }

        val preferredMinY = hardTopInset + margin
        val preferredMaxY = viewportHeight - margin - capsuleHeight
        val (minY, maxY) = if (preferredMinY <= preferredMaxY) {
            clamp(preferredMinY, 0f, hardMaxY) to clamp(preferredMaxY, 0f, hardMaxY)
        } else {
            val hardMin = if (hardMaxY >= hardTopInset) hardTopInset else 0f
            clamp(hardMin, 0f, hardMaxY) to hardMaxY
        }

        return CapsulePlacementBounds(minX, maxX, minY, maxY)
    }

    fun position(
        placement: CapsulePlacement,
        viewportWidth: Float,
        viewportHeight: Float,
        capsuleWidth: Float,
        capsuleHeight: Float,
        safeMargin: Float = CapsulePlacementMetrics.SAFE_MARGIN_PX,
        hardTopInset: Float = CapsulePlacementMetrics.HARD_TOP_INSET_PX,
    ): Pair<Float, Float> {
        val bounds = resolveBounds(
            viewportWidth,
            viewportHeight,
            capsuleWidth,
            capsuleHeight,
            safeMargin,
            hardTopInset,
        )
        val ratio = clamp(placement.yRatio, 0f, 1f)
        val x = if (placement.side == CapsuleDockSide.LEFT) bounds.minX else bounds.maxX
        val y = bounds.minY + (bounds.maxY - bounds.minY) * ratio
        return x to y
    }

    fun placement(
        x: Float,
        y: Float,
        viewportWidth: Float,
        viewportHeight: Float,
        capsuleWidth: Float,
        capsuleHeight: Float,
        safeMargin: Float = CapsulePlacementMetrics.SAFE_MARGIN_PX,
        hardTopInset: Float = CapsulePlacementMetrics.HARD_TOP_INSET_PX,
    ): CapsulePlacement {
        val bounds = resolveBounds(
            viewportWidth,
            viewportHeight,
            capsuleWidth,
            capsuleHeight,
            safeMargin,
            hardTopInset,
        )
        val clampedX = clamp(x, bounds.minX, bounds.maxX)
        val clampedY = clamp(y, bounds.minY, bounds.maxY)
        val midX = (bounds.minX + bounds.maxX) / 2f
        val rangeY = bounds.maxY - bounds.minY
        return CapsulePlacement(
            side = if (clampedX < midX) CapsuleDockSide.LEFT else CapsuleDockSide.RIGHT,
            yRatio = if (rangeY > 0f) (clampedY - bounds.minY) / rangeY else 1f,
        )
    }

    fun dockedPosition(
        x: Float,
        y: Float,
        viewportWidth: Float,
        viewportHeight: Float,
        capsuleWidth: Float,
        capsuleHeight: Float,
        safeMargin: Float = CapsulePlacementMetrics.SAFE_MARGIN_PX,
        hardTopInset: Float = CapsulePlacementMetrics.HARD_TOP_INSET_PX,
    ): Pair<Float, Float> {
        val snapped = placement(
            x,
            y,
            viewportWidth,
            viewportHeight,
            capsuleWidth,
            capsuleHeight,
            safeMargin,
            hardTopInset,
        )
        return position(
            snapped,
            viewportWidth,
            viewportHeight,
            capsuleWidth,
            capsuleHeight,
            safeMargin,
            hardTopInset,
        )
    }
}

internal class CapsulePlacementStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(): CapsulePlacement {
        val side = when (prefs.getString(KEY_SIDE, CapsuleDockSide.RIGHT.name)) {
            CapsuleDockSide.LEFT.name -> CapsuleDockSide.LEFT
            else -> CapsuleDockSide.RIGHT
        }
        val ratio = CapsulePlacementGeometry.clamp(prefs.getFloat(KEY_Y_RATIO, 1f), 0f, 1f)
        return CapsulePlacement(side, ratio)
    }

    fun save(placement: CapsulePlacement) {
        prefs.edit()
            .putString(KEY_SIDE, placement.side.name)
            .putFloat(KEY_Y_RATIO, placement.yRatio)
            .apply()
    }

    private companion object {
        private const val PREFS = "tt_workbench_capsule_placement"
        private const val KEY_SIDE = "side"
        private const val KEY_Y_RATIO = "yRatio"
    }
}

internal enum class CapsuleOnboardingAction {
    TAP,
    DRAG,
    HOLD,
}

internal data class CapsuleOnboardingProgress(
    val appearanceCount: Int = 0,
    val lastPromptAppearance: Int = 0,
    val tapLearned: Boolean = false,
    val dragLearned: Boolean = false,
    val holdLearned: Boolean = false,
    val skipped: Boolean = false,
) {
    fun recordAppearance(): CapsuleOnboardingProgress =
        copy(appearanceCount = appearanceCount + 1)

    fun nextPrompt(replySuggested: Boolean): CapsuleOnboardingAction? {
        if (skipped || lastPromptAppearance >= appearanceCount) return null
        if (!tapLearned) return CapsuleOnboardingAction.TAP
        if (replySuggested && !holdLearned && appearanceCount >= 2) {
            return CapsuleOnboardingAction.HOLD
        }
        if (!dragLearned && appearanceCount >= 2) return CapsuleOnboardingAction.DRAG
        return null
    }

    fun markPromptShown(): CapsuleOnboardingProgress =
        copy(lastPromptAppearance = appearanceCount)

    fun markLearned(action: CapsuleOnboardingAction): CapsuleOnboardingProgress = when (action) {
        CapsuleOnboardingAction.TAP -> copy(tapLearned = true)
        CapsuleOnboardingAction.DRAG -> copy(dragLearned = true)
        CapsuleOnboardingAction.HOLD -> copy(holdLearned = true)
    }

    fun skipAll(): CapsuleOnboardingProgress = copy(skipped = true)
}

internal class CapsuleOnboardingStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(): CapsuleOnboardingProgress = CapsuleOnboardingProgress(
        appearanceCount = prefs.getInt(KEY_APPEARANCES, 0),
        lastPromptAppearance = prefs.getInt(KEY_LAST_PROMPT_APPEARANCE, 0),
        tapLearned = prefs.getBoolean(KEY_TAP_LEARNED, false),
        dragLearned = prefs.getBoolean(KEY_DRAG_LEARNED, false),
        holdLearned = prefs.getBoolean(KEY_HOLD_LEARNED, false),
        skipped = prefs.getBoolean(KEY_SKIPPED, false),
    )

    fun save(progress: CapsuleOnboardingProgress) {
        prefs.edit()
            .putInt(KEY_APPEARANCES, progress.appearanceCount)
            .putInt(KEY_LAST_PROMPT_APPEARANCE, progress.lastPromptAppearance)
            .putBoolean(KEY_TAP_LEARNED, progress.tapLearned)
            .putBoolean(KEY_DRAG_LEARNED, progress.dragLearned)
            .putBoolean(KEY_HOLD_LEARNED, progress.holdLearned)
            .putBoolean(KEY_SKIPPED, progress.skipped)
            .apply()
    }

    fun reset() {
        prefs.edit().clear().apply()
    }

    private companion object {
        private const val PREFS = "tt_workbench_capsule_onboarding_v1"
        private const val KEY_APPEARANCES = "appearanceCount"
        private const val KEY_LAST_PROMPT_APPEARANCE = "lastPromptAppearance"
        private const val KEY_TAP_LEARNED = "tapLearned"
        private const val KEY_DRAG_LEARNED = "dragLearned"
        private const val KEY_HOLD_LEARNED = "holdLearned"
        private const val KEY_SKIPPED = "skipped"
    }
}
