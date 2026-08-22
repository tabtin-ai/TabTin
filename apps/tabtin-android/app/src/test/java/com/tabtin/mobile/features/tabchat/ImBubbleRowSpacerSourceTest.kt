package com.tabtin.mobile.features.tabchat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 回归：ImBubbleRow 侧边 Spacer 不得复用带 fillMaxWidth 的参数 modifier。
 * `#9330` 曾把 `Modifier.size(40.dp)` 误写成 `modifier.size(40.dp)`，
 * 在 `ImBubbleRow(modifier = Modifier.fillMaxWidth())` 下把气泡宽度挤成 0。
 */
class ImBubbleRowSpacerSourceTest {

    @Test
    fun bubbleRowSpacersUseFreshModifierSizeNotRowFillMaxWidthParameter() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/tabchat/ImMessageInteractions.kt",
        ).readText()
        val rowBlock = source.substringAfter("internal fun ImBubbleRow(")
            .substringBefore("internal fun imBubbleShape")
        assertTrue(rowBlock.contains("Spacer(modifier = Modifier.size(40.dp))"))
        assertFalse(
            "ImBubbleRow must not use Spacer(modifier.size(...)) — shadows fillMaxWidth param",
            Regex("""Spacer\(\s*modifier\.size\(40\.dp\)\s*\)""").containsMatchIn(rowBlock),
        )
    }
}
