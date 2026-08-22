package com.tabtin.mobile.features.doc

import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.ui.theme.TTSpacing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DocBlockGapPolicyTest {

    @Test
    fun `block gaps match the iOS canonical reading rhythm`() {
        assertEquals(
            TTSpacing.xxl.value,
            DocBlockGapPolicy.gapDp(previous = null, current = DocBlockGapKind.PARAGRAPH),
        )
        assertEquals(
            0f,
            DocBlockGapPolicy.gapDp(
                previous = DocBlockGapKind.PARAGRAPH,
                current = DocBlockGapKind.PARAGRAPH,
            ),
        )
        assertEquals(
            TTSpacing.xxl.value,
            DocBlockGapPolicy.gapDp(
                previous = DocBlockGapKind.PARAGRAPH,
                current = DocBlockGapKind.HEADING_1,
            ),
        )
        assertEquals(
            TTSpacing.xs.value,
            DocBlockGapPolicy.gapDp(
                previous = DocBlockGapKind.HEADING_1,
                current = DocBlockGapKind.PARAGRAPH,
            ),
        )
        assertEquals(
            TTSpacing.xxxl.value,
            DocBlockGapPolicy.gapDp(
                previous = DocBlockGapKind.PARAGRAPH,
                current = DocBlockGapKind.DIVIDER,
            ),
        )
        assertEquals(
            TTSpacing.xxxl.value,
            DocBlockGapPolicy.gapDp(
                previous = DocBlockGapKind.DIVIDER,
                current = DocBlockGapKind.PARAGRAPH,
            ),
        )
        assertEquals(
            TTSpacing.lg.value,
            DocBlockGapPolicy.gapDp(
                previous = DocBlockGapKind.PARAGRAPH,
                current = DocBlockGapKind.HEADING_3_PLUS,
            ),
        )
        assertEquals(
            TTSpacing.md.value,
            DocBlockGapPolicy.gapDp(
                previous = DocBlockGapKind.PARAGRAPH,
                current = DocBlockGapKind.QUOTE,
            ),
        )
    }

    @Test
    fun `document title is not a body block and does not consume the first-block gap`() {
        assertNull(
            DocBlockGapPolicy.kindOf(
                TabDocBlockView.Title(id = "title", body = "资源标题"),
            ),
        )
        assertEquals(
            DocBlockGapKind.HEADING_1,
            DocBlockGapPolicy.kindOf(
                TabDocBlockView.Text.HeaderOne(id = "h1", body = "正文标题"),
            ),
        )
        assertEquals(
            DocBlockGapKind.PARAGRAPH,
            DocBlockGapPolicy.kindOf(
                TabDocBlockView.Text.Paragraph(id = "p", body = "正文"),
            ),
        )
    }
}
