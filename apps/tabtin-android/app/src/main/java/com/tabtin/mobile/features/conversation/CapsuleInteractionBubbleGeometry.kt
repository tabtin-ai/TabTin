package com.tabtin.mobile.features.conversation

internal data class CapsuleInteractionBubblePosition(
    val x: Float,
    val y: Float,
    val aboveCapsule: Boolean,
)

/** Places the interaction bubble next to the persisted capsule anchor without crossing safe edges. */
internal object CapsuleInteractionBubbleGeometry {
    fun place(
        side: CapsuleDockSide,
        capsuleX: Float,
        capsuleY: Float,
        capsuleWidth: Float,
        capsuleHeight: Float,
        bubbleWidth: Float,
        bubbleHeight: Float,
        viewportWidth: Float,
        viewportHeight: Float,
        safeMargin: Float,
        gap: Float,
    ): CapsuleInteractionBubblePosition {
        val minX = safeMargin.coerceAtLeast(0f)
        val maxX = (viewportWidth - safeMargin - bubbleWidth).coerceAtLeast(minX)
        val alignedX = when (side) {
            CapsuleDockSide.LEFT -> capsuleX
            CapsuleDockSide.RIGHT -> capsuleX + capsuleWidth - bubbleWidth
        }

        val aboveY = capsuleY - gap - bubbleHeight
        val belowY = capsuleY + capsuleHeight + gap
        val canFitAbove = aboveY >= safeMargin
        val canFitBelow = belowY + bubbleHeight <= viewportHeight - safeMargin
        val aboveSpace = (capsuleY - gap - safeMargin).coerceAtLeast(0f)
        val belowSpace = (viewportHeight - safeMargin - belowY).coerceAtLeast(0f)
        val aboveCapsule = canFitAbove || (!canFitBelow && aboveSpace >= belowSpace)
        val rawY = if (aboveCapsule) aboveY else belowY
        val minY = safeMargin.coerceAtLeast(0f)
        val maxY = (viewportHeight - safeMargin - bubbleHeight).coerceAtLeast(minY)

        return CapsuleInteractionBubblePosition(
            x = alignedX.coerceIn(minX, maxX),
            y = rawY.coerceIn(minY, maxY),
            aboveCapsule = aboveCapsule,
        )
    }
}
