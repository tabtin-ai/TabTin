package com.tabtin.mobile.features.doc

import android.graphics.Rect
import android.view.View
import androidx.recyclerview.widget.RecyclerView
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.ui.theme.TTSpacing

internal enum class DocBlockGapKind {
    PARAGRAPH,
    HEADING_1,
    HEADING_2,
    HEADING_3_PLUS,
    LIST,
    QUOTE,
    CODE,
    DIVIDER,
        IMAGE,
        TABLE,
        FORMULA,
        UNSUPPORTED,
    ;

    val isDivider: Boolean get() = this == DIVIDER

    val isHeading: Boolean
        get() = this == HEADING_1 || this == HEADING_2 || this == HEADING_3_PLUS

    val usesSectionGap: Boolean
        get() = this == QUOTE || this == CODE || this == IMAGE || this == TABLE ||
            this == FORMULA || this == UNSUPPORTED
}

/** Matches iOS `NativeTabDocBlockGapPolicy` so both clients share one reading rhythm. */
internal object DocBlockGapPolicy {
    fun kindOf(item: TabDocBlockView): DocBlockGapKind? = when (item) {
        is TabDocBlockView.Title -> null
        is TabDocBlockView.CommentsFooter -> null
        is TabDocBlockView.Text.Paragraph -> DocBlockGapKind.PARAGRAPH
        is TabDocBlockView.Text.HeaderOne -> DocBlockGapKind.HEADING_1
        is TabDocBlockView.Text.HeaderTwo -> DocBlockGapKind.HEADING_2
        is TabDocBlockView.Text.HeaderThree,
        is TabDocBlockView.Text.HeaderFour,
        is TabDocBlockView.Text.HeaderFive,
        is TabDocBlockView.Text.HeaderSix,
        -> DocBlockGapKind.HEADING_3_PLUS
        is TabDocBlockView.Text.Bulleted,
        is TabDocBlockView.Text.Numbered,
        is TabDocBlockView.Text.Checkbox,
        -> DocBlockGapKind.LIST
        is TabDocBlockView.Text.Quote -> DocBlockGapKind.QUOTE
        is TabDocBlockView.Code -> DocBlockGapKind.CODE
        is TabDocBlockView.DividerLine -> DocBlockGapKind.DIVIDER
        is TabDocBlockView.Image -> DocBlockGapKind.IMAGE
        is TabDocBlockView.Table -> DocBlockGapKind.TABLE
        is TabDocBlockView.Formula -> DocBlockGapKind.FORMULA
        is TabDocBlockView.Unsupported -> DocBlockGapKind.UNSUPPORTED
    }

    fun gapDp(previous: DocBlockGapKind?, current: DocBlockGapKind): Float {
        if (previous == null) return TTSpacing.xxl.value
        if (previous.isDivider || current.isDivider) return TTSpacing.xxxl.value
        if (current == DocBlockGapKind.HEADING_1 || current == DocBlockGapKind.HEADING_2) {
            return TTSpacing.xxl.value
        }
        if (current == DocBlockGapKind.HEADING_3_PLUS) return TTSpacing.lg.value
        if (previous.isHeading) return TTSpacing.xs.value
        if (previous.usesSectionGap || current.usesSectionGap) return TTSpacing.md.value
        return 0f
    }
}

internal class DocBlockGapDecoration(
    private val itemAt: (Int) -> TabDocBlockView?,
) : RecyclerView.ItemDecoration() {
    override fun getItemOffsets(
        outRect: Rect,
        view: View,
        parent: RecyclerView,
        state: RecyclerView.State,
    ) {
        val position = parent.getChildAdapterPosition(view)
        if (position == RecyclerView.NO_POSITION) return
        val current = itemAt(position) ?: return
        val currentKind = DocBlockGapPolicy.kindOf(current) ?: return
        val previousKind = if (position == 0) {
            null
        } else {
            itemAt(position - 1)?.let(DocBlockGapPolicy::kindOf)
        }
        val gapDp = DocBlockGapPolicy.gapDp(previousKind, currentKind)
        outRect.top = (gapDp * view.resources.displayMetrics.density).toInt()
    }
}
