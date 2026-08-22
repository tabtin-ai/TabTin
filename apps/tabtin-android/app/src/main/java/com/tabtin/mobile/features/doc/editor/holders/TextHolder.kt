package com.tabtin.mobile.features.doc.editor.holders

import android.graphics.Typeface
import android.text.Annotation
import android.text.Editable
import android.text.Layout
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.SubscriptSpan
import android.text.style.SuperscriptSpan
import android.text.style.URLSpan
import android.text.style.UnderlineSpan
import android.view.View
import android.view.Gravity
import androidx.annotation.ColorRes
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.tabtin.mobile.features.doc.editor.core.DocFormulaLoader
import com.tabtin.mobile.features.doc.editor.core.DocInlineImageLoader
import com.tabtin.mobile.features.doc.editor.core.DocInlineImagePresentation
import com.tabtin.mobile.features.doc.editor.core.DocSpan
import com.tabtin.mobile.features.doc.editor.core.DocTextInputWidget
import com.tabtin.mobile.features.doc.editor.core.FormulaProvider
import com.tabtin.mobile.features.doc.editor.core.InlineImageProvider
import com.tabtin.mobile.features.doc.editor.core.SlashTextWatcher
import com.tabtin.mobile.features.doc.editor.core.SlashTextWatcherState
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.features.doc.editor.core.TextInputTextWatcher
import com.tabtin.mobile.features.doc.editor.core.UnknownMarkRangeInputFilter
import com.tabtin.mobile.features.doc.editor.core.setMarkup
import com.tabtin.mobile.features.doc.editor.core.toSpannable
import com.tabtin.mobile.features.doc.model.DocTextAlignment
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.TTViewFontWeight
import com.tabtin.mobile.ui.theme.applyTTPadding
import com.tabtin.mobile.ui.theme.applyTTTypography

/**
 * 所有文本类型 ViewHolder 的抽象基类。
 *
 * 核心职责：
 * - 管理 DocTextInputWidget 上的 TextWatcher（含 pauseTextWatchers 锁定机制）
 * - 将 TabDocMarkup marks 渲染为 Spannable
 * - 处理焦点、光标、缩进、Enter 键、Backspace 空删、斜杠命令等回调
 *
 * 子类只需传入对应的 ViewBinding.root 和 binding.textContent 即可。
 */
public abstract class TextHolder(
    view: View,
    protected val widget: DocTextInputWidget,
    private val typographyRole: TTFonts.Role = TTFonts.Role.BODY,
    private val fontWeight: TTViewFontWeight = TTViewFontWeight.REGULAR,
    @ColorRes private val textColorRes: Int? = null,
    private val paddingStart: Dp = TTSpacing.lg,
    private val paddingTop: Dp = 0.dp,
    private val paddingEnd: Dp = TTSpacing.lg,
    private val paddingBottom: Dp = 0.dp,
    private val onTextChanged: (id: String, text: String, marks: List<TabDocMarkup.Mark>) -> Unit,
    private val onEnterPressed: (id: String, range: IntRange) -> Unit,
    private val onEmptyBackspace: (id: String) -> Unit,
    private val onFocusChanged: (id: String) -> Unit,
    private val onSlashEvent: (id: String, SlashTextWatcherState) -> Unit,
    private val onSelectionChanged: (id: String, IntRange) -> Unit,
    private val onBlockLongPress: (id: String) -> Unit = {},
) : DocBlockViewHolder(view) {

    private var blockId: String = ""
    private var boundBody: String = ""
    private var basePaddingLeft: Int = 0

    /**
     * 行内图片加载器由 [DocBlockAdapter] 注入。为 null 时行内图片保持诚实 alt 占位，
     * 不会出现空框——这也是加载中与加载失败的统一降级态。
     */
    public var inlineImageLoader: DocInlineImageLoader? = null
    public var formulaLoader: DocFormulaLoader? = null

    /** 只有已经就绪的图片才盖住占位串；未就绪返回 null，占位文字继续可读。 */
    private val inlineImageProvider: InlineImageProvider = { mark ->
        inlineImageLoader?.drawable(
            mark = mark,
            lineHeight = widget.lineHeight,
            availableWidth = inlineImageAvailableWidth(),
        )
    }

    private val formulaProvider: FormulaProvider = { mark ->
        formulaLoader?.drawable(
            mark = mark,
            fontSizePx = widget.textSize,
            textColor = widget.currentTextColor,
            sourceText = boundBody,
        )
    }

    // region TextWatcher —— 文本变化 → 提取 marks → 回调上层
    private val defaultTextWatcher = object : TextInputTextWatcher {
        private var locked = false
        override fun lock() { locked = true }
        override fun unlock() { locked = false }
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: Editable?) {
            if (locked) return
            val editable = s ?: return
            val text = editable.toString()
            val marks = extractMarksFromSpannable(editable)
            onTextChanged(blockId, text, marks)
        }
    }
    // endregion

    // region SlashWatcher —— 斜杠命令触发
    private val slashWatcher = SlashTextWatcher { state ->
        onSlashEvent(blockId, state)
    }
    // endregion

    init {
        widget.applyTTTypography(typographyRole, fontWeight)
        textColorRes?.let { widget.setTextColor(ContextCompat.getColor(widget.context, it)) }
        widget.applyTTPadding(paddingStart, paddingTop, paddingEnd, paddingBottom)
        basePaddingLeft = widget.paddingStart

        widget.addTextChangedListener(defaultTextWatcher)
        widget.addTextChangedListener(slashWatcher)
        widget.filters = widget.filters + UnknownMarkRangeInputFilter()

        widget.onBackspaceAtStart = { onEmptyBackspace(blockId) }

        widget.enableEnterKeyDetector { range ->
            onEnterPressed(blockId, range)
        }

        // 选区变化
        widget.selectionWatcher = { range ->
            onSelectionChanged(blockId, range)
        }

        // 焦点变化
        widget.setOnFocusChangeListener { _, hasFocus ->
            if (hasFocus) {
                onFocusChanged(blockId)
                widget.isCursorVisible = true
            }
        }

        // 非聚焦状态下的长按 → 块操作菜单
        widget.editorTouchProcessor.onLongClick = {
            onBlockLongPress(blockId)
        }
    }

    /**
     * 绑定文本块数据。子类可 override 追加自身逻辑（如设置序号、checkbox 状态等）。
     */
    public open fun bind(item: TabDocBlockView.Text) {
        blockId = item.id
        boundBody = item.body

        // 锁定 watcher 防止 setText 触发回调循环
        widget.pauseTextWatchers {
            val markup = object : TabDocMarkup {
                override val body = item.body
                override val marks = item.marks
            }
            val spannable = markup.toSpannable(
                textColor = widget.currentTextColor,
                inlineImageProvider = inlineImageProvider,
                formulaProvider = formulaProvider,
            )
            widget.setText(spannable)
        }
        requestInlineImages(item)
        requestFormulas(item)

        // 缩进：每级使用统一 xxl 间距。
        applyIndent(item.indent)
        applyAlignment(item.alignment)

        // 焦点和光标
        if (item.isFocused) {
            widget.post {
                if (!widget.hasFocus()) widget.requestFocus()
                val cursor = item.cursor
                    ?.coerceIn(0, widget.text?.length ?: 0)
                    ?: (widget.text?.length ?: 0)
                widget.setSelection(cursor)
            }
        }

        applySelectionState(item.isSelected)
        applyFocusability(item.isSelected)
    }

    override fun setReadOnly(readOnly: Boolean) {
        if (readOnly) {
            widget.clearFocus()
            widget.enableReadMode()
        } else {
            widget.enableEditMode()
        }
    }

    override fun bind(item: TabDocBlockView) {
        if (item is TabDocBlockView.Text) bind(item)
    }

    override fun processPayload(item: TabDocBlockView, payloads: Set<Int>) {
        if (item !is TabDocBlockView.Text) { bind(item); return }
        blockId = item.id
        boundBody = item.body

        if (DocBlockDiffUtil.Payload.TEXT_CHANGED in payloads) {
            widget.pauseTextWatchers {
                val markup = object : TabDocMarkup {
                    override val body = item.body
                    override val marks = item.marks
                }
                widget.text?.setMarkup(
                    markup,
                    textColor = widget.currentTextColor,
                    inlineImageProvider = inlineImageProvider,
                    formulaProvider = formulaProvider,
                )
            }
            requestInlineImages(item)
            requestFormulas(item)
        }
        if (DocBlockDiffUtil.Payload.FOCUS_CHANGED in payloads) {
            if (item.isFocused) {
                widget.post {
                    if (!widget.hasFocus()) widget.requestFocus()
                    widget.isCursorVisible = true
                }
            } else {
                widget.clearFocus()
                widget.isCursorVisible = false
            }
        }
        if (DocBlockDiffUtil.Payload.CURSOR_CHANGED in payloads && item.isFocused && item.cursor != null) {
            widget.post {
                val cursor = item.cursor!!.coerceIn(0, widget.text?.length ?: 0)
                widget.setSelection(cursor)
            }
        }
        if (DocBlockDiffUtil.Payload.INDENT_CHANGED in payloads) {
            applyIndent(item.indent)
        }
        if (DocBlockDiffUtil.Payload.ALIGNMENT_CHANGED in payloads) {
            applyAlignment(item.alignment)
        }
        if (DocBlockDiffUtil.Payload.SELECTION_CHANGED in payloads) {
            applySelectionState(item.isSelected)
            applyFocusability(item.isSelected)
        }
    }

    /**
     * 应用缩进。基于 indent 层级设置 paddingStart，子类可覆写定制缩进目标。
     */
    private fun applyFocusability(isSelected: Boolean) {
        if (isSelected) {
            widget.isFocusable = false
            widget.isFocusableInTouchMode = false
            if (widget.hasFocus()) widget.clearFocus()
        } else {
            widget.isFocusable = true
            widget.isFocusableInTouchMode = true
        }
    }

    /**
     * 每次 bind 都完整覆盖水平对齐与 justification，避免 RecyclerView 复用时把上一块
     * 的 right/justify 泄漏到下一块。自然起点使用 START；显式 left/right 使用物理方向。
     */
    private fun applyAlignment(alignment: DocTextAlignment?) {
        widget.textAlignment = View.TEXT_ALIGNMENT_GRAVITY
        widget.justificationMode = Layout.JUSTIFICATION_MODE_NONE
        val horizontalGravity = when (alignment) {
            null -> Gravity.START
            DocTextAlignment.LEFT -> Gravity.LEFT
            DocTextAlignment.CENTER -> Gravity.CENTER_HORIZONTAL
            DocTextAlignment.RIGHT -> Gravity.RIGHT
            DocTextAlignment.JUSTIFY -> {
                widget.justificationMode = Layout.JUSTIFICATION_MODE_INTER_WORD
                Gravity.START
            }
        }
        widget.gravity =
            (widget.gravity and Gravity.RELATIVE_HORIZONTAL_GRAVITY_MASK.inv()) or horizontalGravity
    }

    /**
     * 图片下载完成后只重刷本 holder 的 spannable：正文文本一个字都没变，
     * 变的只是"这段 alt 占位现在能盖成图了"。走 [setMarkup] 而不是 setText，
     * 避免打断输入法组合与选区。
     */
    private fun requestInlineImages(item: TabDocBlockView.Text) {
        val loader = inlineImageLoader ?: return
        val images = item.marks.filterIsInstance<TabDocMarkup.Mark.InlineImage>()
        if (images.isEmpty()) return
        val boundBlockId = item.id
        loader.requestMissing(images) {
            if (blockId != boundBlockId) return@requestMissing
            val currentBody = widget.text?.toString() ?: return@requestMissing
            if (!DocInlineImagePresentation.canRefreshRenderedImages(item.body, currentBody)) {
                return@requestMissing
            }
            widget.pauseTextWatchers {
                val markup = object : TabDocMarkup {
                    override val body = item.body
                    override val marks = item.marks
                }
                widget.text?.setMarkup(
                    markup,
                    textColor = widget.currentTextColor,
                    inlineImageProvider = inlineImageProvider,
                    formulaProvider = formulaProvider,
                )
            }
        }
    }

    private fun requestFormulas(item: TabDocBlockView.Text) {
        val loader = formulaLoader ?: return
        val formulas = item.marks.filterIsInstance<TabDocMarkup.Mark.Mathematics>()
        if (formulas.isEmpty()) return
        val boundBlockId = item.id
        loader.requestMissing(
            context = widget.context,
            marks = formulas,
            fontSizePx = widget.textSize,
            textColor = widget.currentTextColor,
            body = item.body,
        ) {
            if (blockId != boundBlockId) return@requestMissing
            val currentBody = widget.text?.toString() ?: return@requestMissing
            if (currentBody != item.body) return@requestMissing
            widget.pauseTextWatchers {
                val markup = object : TabDocMarkup {
                    override val body = item.body
                    override val marks = item.marks
                }
                widget.text?.setMarkup(
                    markup,
                    textColor = widget.currentTextColor,
                    inlineImageProvider = inlineImageProvider,
                    formulaProvider = formulaProvider,
                )
            }
        }
    }

    /** 正文可用宽度；测量完成前退回屏幕宽度，只影响首帧估算。 */
    private fun inlineImageAvailableWidth(): Int {
        val measured = widget.width - widget.paddingStart - widget.paddingEnd
        if (measured > 0) return measured
        return widget.resources.displayMetrics.widthPixels
    }

    protected open fun applyIndent(indent: Int) {
        val indentPx = (
            indent * TTSpacing.xxl.value * widget.resources.displayMetrics.density
        ).toInt()
        widget.setPadding(
            basePaddingLeft + indentPx,
            widget.paddingTop,
            widget.paddingRight,
            widget.paddingBottom
        )
    }

    override fun setupDrag(startDrag: () -> Unit) {
        widget.editorTouchProcessor.onDragAndDropTrigger = { _ -> startDrag() }
    }
}

/**
 * TextHolder 的真实 Editable 回收边界。保持为模块内函数，既供 watcher 调用，也让契约测试
 * 能从 renderer 驱动完整的 Spannable → Mark 路径，而不需要反射 ViewHolder 私有状态。
 */
internal fun extractMarksFromSpannable(editable: Editable): List<TabDocMarkup.Mark> {
    val marks = mutableListOf<TabDocMarkup.Mark>()

    // 使用同一次 span 遍历恢复 mark，避免 TextUtils parcel 将自定义 span 还原为框架
    // span 后，因分类型遍历顺序不同而改变 mark 顺序。
    for (span in editable.getSpans(0, editable.length, Any::class.java)) {
        val from = editable.getSpanStart(span)
        val to = editable.getSpanEnd(span)
        if (from >= to) continue
        when (span) {
            // 所有需要精确载荷的 mark 都以基础 Annotation 为身份真源；视觉 span
            // 在 parcel 后可降为框架类型或被丢弃，不参与二次回收。
            is Annotation -> when (span.key) {
                DocSpan.Keyboard.KEYBOARD_KEY -> marks.add(TabDocMarkup.Mark.Code(from, to))
                DocSpan.MarkIdentity.LINK_KEY, DocSpan.MarkIdentity.LINK_V2_KEY -> {
                    DocSpan.MarkIdentity.linkFrom(span)?.let { link ->
                        marks.add(TabDocMarkup.Mark.Link(from, to, link.url, link.target))
                    }
                }
                DocSpan.MarkIdentity.TEXT_STYLE_KEY -> {
                    DocSpan.MarkIdentity.textStyleFrom(span)?.let { style ->
                        marks.add(
                            TabDocMarkup.Mark.TextColor(
                                from = from,
                                to = to,
                                color = style.color,
                                backgroundColor = style.backgroundColor,
                                fontSize = style.fontSize,
                                fontFamily = style.fontFamily,
                            ),
                        )
                    }
                }
                DocSpan.Highlight.HIGHLIGHT_KEY -> marks.add(
                    TabDocMarkup.Mark.Highlight(from, to, span.value),
                )
                DocSpan.Mathematics.MATH_KEY -> {
                    DocSpan.Mathematics.fromAnnotation(span)?.let { mathematics ->
                        marks.add(
                            TabDocMarkup.Mark.Mathematics(
                                from = from,
                                to = to,
                                nodeType = mathematics.nodeType,
                                valueAttribute = mathematics.valueAttribute,
                                attrs = mathematics.attrs,
                                atomId = mathematics.atomId,
                            ),
                        )
                    }
                }
                DocSpan.InlineImage.IMAGE_KEY -> {
                    DocSpan.InlineImage.fromAnnotation(span)?.let { image ->
                        marks.add(
                            TabDocMarkup.Mark.InlineImage(
                                from = from,
                                to = to,
                                nodeType = image.nodeType,
                                attrs = image.attrs,
                                atomId = image.atomId,
                            ),
                        )
                    }
                }
                DocSpan.UnknownMark.KEY -> {
                    DocSpan.UnknownMark.fromAnnotation(span)?.let { unknown ->
                        marks.add(
                            TabDocMarkup.Mark.Unknown(
                                from = from,
                                to = to,
                                type = unknown.type,
                                attrs = unknown.attrs,
                            ),
                        )
                    }
                }
            }
            is DocSpan.Bold -> marks.add(TabDocMarkup.Mark.Bold(from, to))
            is DocSpan.Italic -> marks.add(TabDocMarkup.Mark.Italic(from, to))
            is DocSpan.Strikethrough -> marks.add(TabDocMarkup.Mark.Strikethrough(from, to))
            is DocSpan.Underline -> marks.add(TabDocMarkup.Mark.Underline(from, to))
            is DocSpan.Subscript -> marks.add(TabDocMarkup.Mark.Subscript(from, to))
            is DocSpan.Superscript -> marks.add(TabDocMarkup.Mark.Superscript(from, to))
            is StyleSpan -> when (span.style) {
                Typeface.BOLD -> marks.add(TabDocMarkup.Mark.Bold(from, to))
                Typeface.ITALIC -> marks.add(TabDocMarkup.Mark.Italic(from, to))
                Typeface.BOLD_ITALIC -> {
                    marks.add(TabDocMarkup.Mark.Bold(from, to))
                    marks.add(TabDocMarkup.Mark.Italic(from, to))
                }
            }
            is UnderlineSpan -> marks.add(TabDocMarkup.Mark.Underline(from, to))
            is StrikethroughSpan -> marks.add(TabDocMarkup.Mark.Strikethrough(from, to))
            is URLSpan -> marks.add(TabDocMarkup.Mark.Link(from, to, span.url ?: ""))
            is SubscriptSpan -> marks.add(TabDocMarkup.Mark.Subscript(from, to))
            is SuperscriptSpan -> marks.add(TabDocMarkup.Mark.Superscript(from, to))
            // RelativeSize、Font、颜色 span 都是视觉配套；未知 mark 只走 Annotation。
            else -> Unit
        }
    }

    return marks
}
