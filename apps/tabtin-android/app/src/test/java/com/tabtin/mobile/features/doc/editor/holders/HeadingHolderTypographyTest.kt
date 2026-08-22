package com.tabtin.mobile.features.doc.editor.holders

import android.app.Application
import android.text.Layout
import android.util.TypedValue
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import com.tabtin.mobile.R
import com.tabtin.mobile.databinding.DocBlockHeaderFiveBinding
import com.tabtin.mobile.databinding.DocBlockHeaderFourBinding
import com.tabtin.mobile.databinding.DocBlockHeaderOneBinding
import com.tabtin.mobile.databinding.DocBlockHeaderSixBinding
import com.tabtin.mobile.databinding.DocBlockHeaderThreeBinding
import com.tabtin.mobile.databinding.DocBlockHeaderTwoBinding
import com.tabtin.mobile.databinding.DocBlockParagraphBinding
import com.tabtin.mobile.databinding.DocBlockNumberedBinding
import com.tabtin.mobile.databinding.DocBlockQuoteBinding
import com.tabtin.mobile.databinding.DocBlockTitleBinding
import com.tabtin.mobile.features.doc.editor.core.DocTextInputWidget
import com.tabtin.mobile.features.doc.editor.core.BlockViewConverter
import com.tabtin.mobile.features.doc.editor.core.SlashTextWatcherState
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.InlineSpan
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class HeadingHolderTypographyTest {

    private val context = ContextThemeWrapper(
        RuntimeEnvironment.getApplication(),
        R.style.Theme_TabTin,
    )
    private val inflater = LayoutInflater.from(context)

    @Test
    fun `paragraph and six heading holders apply the shared semantic type scale`() {
        val expectedSizes = listOf(14f, 24f, 20f, 16f, 14f, 13f, 12f)
        val widgets = listOf(paragraphWidget()) + (1..6).map(::headingWidget)

        assertEquals(expectedSizes.size, widgets.size)
        widgets.zip(expectedSizes).forEachIndexed { index, (widget, expectedSize) ->
            val expectedPixels = TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_SP,
                expectedSize,
                widget.resources.displayMetrics,
            )
            assertEquals("semantic text size at index $index", expectedPixels, widget.textSize, 0.01f)
        }
    }

    @Test
    fun `sixth-level heading uses secondary text color instead of looking like body text`() {
        val widget = headingWidget(6)

        assertEquals(context.getColor(R.color.doc_editor_text_secondary), widget.currentTextColor)
    }

    @Test
    fun `quote uses secondary text and a neutral highlight bar instead of brand accent`() {
        val binding = DocBlockQuoteBinding.inflate(inflater)
        QuoteHolder(
            binding = binding,
            onTextChanged = onTextChanged,
            onEnterPressed = onEnterPressed,
            onEmptyBackspace = onEmptyBackspace,
            onFocusChanged = onFocusChanged,
            onSlashEvent = onSlashEvent,
            onSelectionChanged = onSelectionChanged,
        )

        assertEquals(
            context.getColor(R.color.doc_editor_text_secondary),
            binding.textContent.currentTextColor,
        )
        assertEquals(
            context.getColor(R.color.doc_editor_highlight_bar),
            (binding.quoteBar.background as android.graphics.drawable.ColorDrawable).color,
        )
    }

    @Test
    fun `document title uses the display token above the body heading hierarchy`() {
        val binding = DocBlockTitleBinding.inflate(inflater)
        TitleHolder(
            binding = binding,
            onTitleChanged = {},
            onFocusChanged = {},
        )
        val expectedPixels = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_SP,
            32f,
            binding.titleInput.resources.displayMetrics,
        )

        assertEquals(expectedPixels, binding.titleInput.textSize, 0.01f)
    }

    @Test
    fun `ordered list marker uses the same body token as its content`() {
        val binding = DocBlockNumberedBinding.inflate(inflater)
        NumberedHolder(
            binding = binding,
            onTextChanged = onTextChanged,
            onEnterPressed = onEnterPressed,
            onEmptyBackspace = onEmptyBackspace,
            onFocusChanged = onFocusChanged,
            onSlashEvent = onSlashEvent,
            onSelectionChanged = onSelectionChanged,
        )

        assertEquals(binding.textContent.textSize, binding.number.textSize, 0.01f)
    }

    @Test
    fun `document editor XML bridge stays aligned with shared tokens`() {
        assertDp(R.dimen.tt_spacing_xxs, TTSpacing.xxs.value)
        assertDp(R.dimen.tt_spacing_xs, TTSpacing.xs.value)
        assertDp(R.dimen.tt_spacing_sm, TTSpacing.sm.value)
        assertDp(R.dimen.tt_spacing_md, TTSpacing.md.value)
        assertDp(R.dimen.tt_spacing_lg, TTSpacing.lg.value)
        assertDp(R.dimen.tt_spacing_xxl, TTSpacing.xxl.value)
        assertDp(R.dimen.tt_spacing_xxxl, TTSpacing.xxxl.value)
        assertDp(R.dimen.tt_spacing_huge, TTSpacing.huge.value)
        assertDp(R.dimen.tt_radius_xs, TTRadius.xs.value)
        assertDp(R.dimen.tt_radius_sm, TTRadius.sm.value)
        assertSp(R.dimen.tt_font_caption, TTFonts.Role.CAPTION.size)
        assertSp(R.dimen.tt_font_meta, TTFonts.Role.META.size)
        assertSp(R.dimen.tt_font_body, TTFonts.Role.BODY.size)
    }

    @Test
    fun `paragraph holder maps null to logical start and canonical values to physical alignment`() {
        val fixture = paragraphFixture()
        fixture.widget.layoutDirection = View.LAYOUT_DIRECTION_RTL

        fixture.holder.bind(alignedParagraph(null))
        assertHorizontalGravity(Gravity.START, fixture.widget)

        fixture.holder.bind(alignedParagraph("left"))
        assertHorizontalGravity(Gravity.LEFT, fixture.widget)

        fixture.holder.bind(alignedParagraph("center"))
        assertHorizontalGravity(Gravity.CENTER_HORIZONTAL, fixture.widget)

        fixture.holder.bind(alignedParagraph("right"))
        assertHorizontalGravity(Gravity.RIGHT, fixture.widget)
    }

    @Test
    fun `paragraph holder applies inter word justification and resets it when recycled`() {
        val fixture = paragraphFixture()

        fixture.holder.bind(alignedParagraph("justify"))
        assertEquals(Layout.JUSTIFICATION_MODE_INTER_WORD, fixture.widget.justificationMode)

        fixture.holder.bind(alignedParagraph("center"))
        assertEquals(Layout.JUSTIFICATION_MODE_NONE, fixture.widget.justificationMode)
        assertHorizontalGravity(Gravity.CENTER_HORIZONTAL, fixture.widget)
    }

    @Test
    fun `alignment payload updates the widget without requiring a full text bind`() {
        val fixture = paragraphFixture()
        fixture.holder.bind(alignedParagraph("left"))

        fixture.holder.processPayload(
            alignedParagraph("justify"),
            setOf(DocBlockDiffUtil.Payload.ALIGNMENT_CHANGED),
        )
        assertEquals(Layout.JUSTIFICATION_MODE_INTER_WORD, fixture.widget.justificationMode)
        assertHorizontalGravity(Gravity.START, fixture.widget)

        fixture.holder.processPayload(
            alignedParagraph("right"),
            setOf(DocBlockDiffUtil.Payload.ALIGNMENT_CHANGED),
        )
        assertEquals(Layout.JUSTIFICATION_MODE_NONE, fixture.widget.justificationMode)
        assertHorizontalGravity(Gravity.RIGHT, fixture.widget)
    }

    private fun paragraphWidget(): DocTextInputWidget {
        return paragraphFixture().widget
    }

    private data class ParagraphFixture(
        val holder: ParagraphHolder,
        val widget: DocTextInputWidget,
    )

    private fun paragraphFixture(): ParagraphFixture {
        val binding = DocBlockParagraphBinding.inflate(inflater)
        val holder = ParagraphHolder(
            binding = binding,
            onTextChanged = onTextChanged,
            onEnterPressed = onEnterPressed,
            onEmptyBackspace = onEmptyBackspace,
            onFocusChanged = onFocusChanged,
            onSlashEvent = onSlashEvent,
            onSelectionChanged = onSelectionChanged,
        )
        return ParagraphFixture(holder, binding.textContent)
    }

    private fun alignedParagraph(alignment: String?): TabDocBlockView.Text =
        BlockViewConverter.toBlockViews(
            listOf(
                DocBlock(
                    id = "paragraph",
                    kind = BlockKind.PARAGRAPH,
                    spans = listOf(InlineSpan("正文")),
                    sourceAttributes = alignment?.let { value ->
                        buildJsonObject { put("textAlign", value) }
                    },
                ),
            ),
        ).single() as TabDocBlockView.Text

    private fun assertHorizontalGravity(expected: Int, widget: DocTextInputWidget) {
        assertEquals(
            expected,
            widget.gravity and Gravity.RELATIVE_HORIZONTAL_GRAVITY_MASK,
        )
    }

    private fun headingWidget(level: Int): DocTextInputWidget = when (level) {
        1 -> DocBlockHeaderOneBinding.inflate(inflater).also {
            HeaderOneHolder(
                binding = it,
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
            )
        }.textContent
        2 -> DocBlockHeaderTwoBinding.inflate(inflater).also {
            HeaderTwoHolder(
                binding = it,
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
            )
        }.textContent
        3 -> DocBlockHeaderThreeBinding.inflate(inflater).also {
            HeaderThreeHolder(
                binding = it,
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
            )
        }.textContent
        4 -> DocBlockHeaderFourBinding.inflate(inflater).also {
            HeaderFourHolder(
                binding = it,
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
            )
        }.textContent
        5 -> DocBlockHeaderFiveBinding.inflate(inflater).also {
            HeaderFiveHolder(
                binding = it,
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
            )
        }.textContent
        6 -> DocBlockHeaderSixBinding.inflate(inflater).also {
            HeaderSixHolder(
                binding = it,
                onTextChanged = onTextChanged,
                onEnterPressed = onEnterPressed,
                onEmptyBackspace = onEmptyBackspace,
                onFocusChanged = onFocusChanged,
                onSlashEvent = onSlashEvent,
                onSelectionChanged = onSelectionChanged,
            )
        }.textContent
        else -> error("unsupported heading level: $level")
    }

    private val onTextChanged: (String, String, List<TabDocMarkup.Mark>) -> Unit = { _, _, _ -> }
    private val onEnterPressed: (String, IntRange) -> Unit = { _, _ -> }
    private val onEmptyBackspace: (String) -> Unit = {}
    private val onFocusChanged: (String) -> Unit = {}
    private val onSlashEvent: (String, SlashTextWatcherState) -> Unit = { _, _ -> }
    private val onSelectionChanged: (String, IntRange) -> Unit = { _, _ -> }

    private fun assertDp(resourceId: Int, expected: Float) {
        val actual = context.resources.getDimension(resourceId) / context.resources.displayMetrics.density
        assertEquals(expected, actual, 0.01f)
    }

    private fun assertSp(resourceId: Int, expected: Float) {
        val metrics = context.resources.displayMetrics
        val scaledDensity = metrics.density * context.resources.configuration.fontScale
        val actual = context.resources.getDimension(resourceId) /
            scaledDensity
        assertEquals(expected, actual, 0.01f)
    }
}
