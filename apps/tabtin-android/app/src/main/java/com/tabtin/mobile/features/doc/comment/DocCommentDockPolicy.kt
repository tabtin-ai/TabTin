package com.tabtin.mobile.features.doc.comment

/**
 * 文档很短时，评论区沉到当前可见区下沿，空白留在正文和评论之间。
 * 正文已经超过一屏时不再垫高，评论仍跟在文末后面。
 */
public object DocCommentDockPolicy {
    public fun extraTopPx(
        viewportHeightPx: Int,
        precedingHeightPx: Int,
        footerContentHeightPx: Int,
    ): Int {
        if (viewportHeightPx <= 0 || footerContentHeightPx < 0) return 0
        return maxOf(0, viewportHeightPx - precedingHeightPx - footerContentHeightPx)
    }

    public fun sumKnownHeightsOrNull(heights: List<Int?>): Int? {
        var sum = 0
        for (height in heights) {
            if (height == null || height < 0) return null
            sum += height
        }
        return sum
    }
}
