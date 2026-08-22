package com.tabtin.mobile.features.doc.editor.core

import com.tabtin.mobile.features.doc.editor.UnsupportedContentLocalization
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.DocTextAlignment
import com.tabtin.mobile.features.doc.model.InlineMark
import com.tabtin.mobile.features.doc.model.InlineSpan
import com.tabtin.mobile.features.doc.model.plainText

/**
 * Bridges DocBlock (ProseMirror data model) ↔ TabDocBlockView (UI model).
 * This is the single source of truth for the data ↔ UI mapping.
 */
public object BlockViewConverter {

    // --- DocBlock → TabDocBlockView ---

    public fun toBlockViews(
        blocks: List<DocBlock>,
        focusedBlockId: String? = null,
        cursorPosition: Int? = null,
        selectedBlockIds: Set<String> = emptySet(),
    ): List<TabDocBlockView> {
        val result = mutableListOf<TabDocBlockView>()
        val numberCounters = mutableMapOf<Pair<String?, Int>, Int>()

        for (block in blocks) {
            val isFocused = block.id == focusedBlockId
            val cursor = if (isFocused) cursorPosition else null
            val isSelected = block.id in selectedBlockIds
            val body = block.spans.plainText()
            val marks = spansToMarks(body, block.spans)
            val alignment = DocTextAlignment.fromSourceAttributes(block.sourceAttributes)

            val activeOrderedKey = if (block.kind == BlockKind.ORDERED_ITEM) {
                block.listContainerId to block.indentLevel
            } else {
                null
            }
            if (block.kind.isListLike) {
                // 当前层出现另一份列表时，旧 ordered run 已经结束；清掉当前层及更深层
                // 的计数。嵌套列表只保留更浅外层计数，回到外层后才能正确续号。
                numberCounters.keys
                    .filter { key ->
                        key.second >= block.indentLevel && key != activeOrderedKey
                    }
                    .forEach(numberCounters::remove)
            } else {
                numberCounters.clear()
            }
            val numberedCounter = if (activeOrderedKey != null) {
                val next = numberCounters[activeOrderedKey] ?: block.listStart
                numberCounters[activeOrderedKey] = next + 1
                next
            } else {
                0
            }

            val view = when (block.kind) {
                BlockKind.PARAGRAPH -> TabDocBlockView.Text.Paragraph(
                    id = block.id, body = body, marks = marks,
                    isFocused = isFocused, cursor = cursor,
                    indent = block.indentLevel, isSelected = isSelected, alignment = alignment,
                )
                BlockKind.HEADING1 -> TabDocBlockView.Text.HeaderOne(
                    id = block.id, body = body, marks = marks,
                    isFocused = isFocused, cursor = cursor,
                    indent = block.indentLevel, isSelected = isSelected, alignment = alignment,
                )
                BlockKind.HEADING2 -> TabDocBlockView.Text.HeaderTwo(
                    id = block.id, body = body, marks = marks,
                    isFocused = isFocused, cursor = cursor,
                    indent = block.indentLevel, isSelected = isSelected, alignment = alignment,
                )
                BlockKind.HEADING3 -> TabDocBlockView.Text.HeaderThree(
                    id = block.id, body = body, marks = marks,
                    isFocused = isFocused, cursor = cursor,
                    indent = block.indentLevel, isSelected = isSelected, alignment = alignment,
                )
                BlockKind.HEADING4 -> TabDocBlockView.Text.HeaderFour(
                    id = block.id, body = body, marks = marks,
                    isFocused = isFocused, cursor = cursor,
                    indent = block.indentLevel, isSelected = isSelected, alignment = alignment,
                )
                BlockKind.HEADING5 -> TabDocBlockView.Text.HeaderFive(
                    id = block.id, body = body, marks = marks,
                    isFocused = isFocused, cursor = cursor,
                    indent = block.indentLevel, isSelected = isSelected, alignment = alignment,
                )
                BlockKind.HEADING6 -> TabDocBlockView.Text.HeaderSix(
                    id = block.id, body = body, marks = marks,
                    isFocused = isFocused, cursor = cursor,
                    indent = block.indentLevel, isSelected = isSelected, alignment = alignment,
                )
                BlockKind.BULLET_ITEM -> TabDocBlockView.Text.Bulleted(
                    id = block.id, body = body, marks = marks,
                    isFocused = isFocused, cursor = cursor,
                    indent = block.indentLevel, isSelected = isSelected, alignment = alignment,
                )
                BlockKind.ORDERED_ITEM -> TabDocBlockView.Text.Numbered(
                    id = block.id, body = body, marks = marks,
                    isFocused = isFocused, cursor = cursor,
                    indent = block.indentLevel, isSelected = isSelected, alignment = alignment,
                    number = numberedCounter,
                )
                BlockKind.TODO_ITEM -> TabDocBlockView.Text.Checkbox(
                    id = block.id, body = body, marks = marks,
                    isFocused = isFocused, cursor = cursor,
                    indent = block.indentLevel, isSelected = isSelected, alignment = alignment,
                    isChecked = block.checked,
                )
                BlockKind.BLOCKQUOTE -> TabDocBlockView.Text.Quote(
                    id = block.id, body = body, marks = marks,
                    isFocused = isFocused, cursor = cursor,
                    indent = block.indentLevel, isSelected = isSelected, alignment = alignment,
                )
                BlockKind.CODE_BLOCK -> TabDocBlockView.Code(
                    id = block.id, body = body,
                    language = block.codeLanguage,
                    isFocused = isFocused, cursor = cursor,
                    isSelected = isSelected,
                )
                BlockKind.DIVIDER -> TabDocBlockView.DividerLine(
                    id = block.id, isSelected = isSelected,
                )
                BlockKind.IMAGE -> TabDocBlockView.Image(
                    id = block.id, url = block.imageURL,
                    alt = block.imageAlt,
                    fileId = block.imageFileId,
                    isReadOnly = !block.editable,
                    isSelected = isSelected,
                )
                BlockKind.TABLE -> TabDocBlockView.Table(
                    id = block.id,
                    tableData = block.tableData ?: com.tabtin.mobile.features.doc.model.TableData(),
                    isSelected = isSelected,
                    // 底层仍保留可无损解析的单元格模型，供展示与原样写回；移动端
                    // 原生云文档不开放表格编辑，避免同表出现半可编辑状态。
                    isReadonly = true,
                )
                BlockKind.UNSUPPORTED -> {
                    val formulaLatex = KatexFormulaHtml.blockLatex(block.rawNode)
                    if (block.unsupportedType == "mathematicsBlock") {
                        TabDocBlockView.Formula(
                            id = block.id,
                            latex = formulaLatex,
                            isSelected = isSelected,
                        )
                    } else {
                        TabDocBlockView.Unsupported(
                            id = block.id,
                            typeName = block.unsupportedType,
                            title = UnsupportedContentLocalization.title(
                                block.unsupportedType,
                                block.rawNode,
                            ),
                            isSelected = isSelected,
                        )
                    }
                }
            }
            result.add(view)
        }

        return result
    }

    // --- TabDocBlockView text update → DocBlock ---

    public fun updateBlockText(
        block: DocBlock,
        newBody: String,
        newMarks: List<TabDocMarkup.Mark>
    ): DocBlock {
        return block.copy(spans = marksToSpans(newBody, newMarks))
    }

    public fun updateBlockChecked(block: DocBlock, isChecked: Boolean): DocBlock {
        return block.copy(checked = isChecked)
    }

    // --- InlineSpan ↔ TabDocMarkup.Mark conversion ---

    public fun spansToMarks(fullText: String, spans: List<InlineSpan>): List<TabDocMarkup.Mark> {
        val marks = mutableListOf<TabDocMarkup.Mark>()
        var offset = 0
        for (span in spans) {
            val from = offset
            val to = offset + span.text.length
            for (mark in span.marks) {
                val m: TabDocMarkup.Mark? = when (mark) {
                    is InlineMark.Bold -> TabDocMarkup.Mark.Bold(from, to)
                    is InlineMark.Italic -> TabDocMarkup.Mark.Italic(from, to)
                    is InlineMark.Strike -> TabDocMarkup.Mark.Strikethrough(from, to)
                    is InlineMark.Underline -> TabDocMarkup.Mark.Underline(from, to)
                    is InlineMark.Code -> TabDocMarkup.Mark.Code(from, to)
                    is InlineMark.Subscript -> TabDocMarkup.Mark.Subscript(from, to)
                    is InlineMark.Superscript -> TabDocMarkup.Mark.Superscript(from, to)
                    is InlineMark.Mathematics -> TabDocMarkup.Mark.Mathematics(
                        from,
                        to,
                        mark.nodeType,
                        mark.valueAttribute,
                        mark.attrs,
                        mark.atomId,
                    )
                    is InlineMark.InlineImage -> TabDocMarkup.Mark.InlineImage(
                        from,
                        to,
                        mark.nodeType,
                        mark.attrs,
                        mark.atomId,
                    )
                    is InlineMark.Unknown -> TabDocMarkup.Mark.Unknown(from, to, mark.type, mark.attrs)
                    is InlineMark.Link -> TabDocMarkup.Mark.Link(from, to, mark.href, mark.target)
                    is InlineMark.TextColor -> TabDocMarkup.Mark.TextColor(from, to, mark.color, mark.backgroundColor, mark.fontSize, mark.fontFamily)
                    is InlineMark.Highlight -> TabDocMarkup.Mark.Highlight(from, to, mark.color)
                }
                if (m != null) marks.add(m)
            }
            offset = to
        }
        return mergeContiguousMarks(marks)
    }

    public fun marksToSpans(fullText: String, marks: List<TabDocMarkup.Mark>): List<InlineSpan> {
        if (fullText.isEmpty()) return listOf(InlineSpan(""))
        if (marks.isEmpty()) return listOf(InlineSpan(fullText))

        data class Boundary(val pos: Int, val isStart: Boolean, val mark: TabDocMarkup.Mark)

        val boundaries = mutableListOf<Boundary>()
        for (m in marks) {
            boundaries.add(Boundary(m.from, true, m))
            boundaries.add(Boundary(m.to, false, m))
        }
        val positions = (boundaries.map { it.pos } + listOf(0, fullText.length))
            .distinct().sorted().filter { it in 0..fullText.length }

        val result = mutableListOf<InlineSpan>()
        for (i in 0 until positions.size - 1) {
            val start = positions[i]
            val end = positions[i + 1]
            if (start == end) continue
            val text = fullText.substring(start, end)
            val activeMarks = marks.filter { it.from <= start && it.to >= end }
            val inlineMarks = activeMarks.map { markToInlineMark(it) }
            result.add(InlineSpan(text, inlineMarks))
        }

        return if (result.isEmpty()) listOf(InlineSpan(fullText)) else result
    }

    private fun markToInlineMark(mark: TabDocMarkup.Mark): InlineMark = when (mark) {
        is TabDocMarkup.Mark.Bold -> InlineMark.Bold
        is TabDocMarkup.Mark.Italic -> InlineMark.Italic
        is TabDocMarkup.Mark.Strikethrough -> InlineMark.Strike
        is TabDocMarkup.Mark.Underline -> InlineMark.Underline
        is TabDocMarkup.Mark.Code -> InlineMark.Code
        is TabDocMarkup.Mark.Link -> InlineMark.Link(mark.url, mark.target)
        is TabDocMarkup.Mark.TextColor -> InlineMark.TextColor(mark.color, mark.backgroundColor, mark.fontSize, mark.fontFamily)
        is TabDocMarkup.Mark.Highlight -> InlineMark.Highlight(mark.color)
        is TabDocMarkup.Mark.Subscript -> InlineMark.Subscript
        is TabDocMarkup.Mark.Superscript -> InlineMark.Superscript
        is TabDocMarkup.Mark.Mathematics -> InlineMark.Mathematics(
            mark.nodeType,
            mark.valueAttribute,
            mark.attrs,
            mark.atomId,
        )
        is TabDocMarkup.Mark.InlineImage -> InlineMark.InlineImage(
            mark.nodeType,
            mark.attrs,
            mark.atomId,
        )
        is TabDocMarkup.Mark.Unknown -> InlineMark.Unknown(mark.type, mark.attrs)
    }

    private fun mergeContiguousMarks(marks: List<TabDocMarkup.Mark>): List<TabDocMarkup.Mark> {
        if (marks.size <= 1) return marks
        // 未知 mark 的语义边界未知，原样透传。公式只按运行期 atomId 合并：
        // 同一公式因局部编辑产生的片段可恢复；两个相邻同构公式因 atomId 不同绝不合块。
        val passthrough = marks.filterIsInstance<TabDocMarkup.Mark.Unknown>()
        val mathematics = marks.filterIsInstance<TabDocMarkup.Mark.Mathematics>()
        val inlineImages = marks.filterIsInstance<TabDocMarkup.Mark.InlineImage>()
        val mergeable = marks.filter {
            it !is TabDocMarkup.Mark.Unknown &&
                it !is TabDocMarkup.Mark.Mathematics &&
                it !is TabDocMarkup.Mark.InlineImage
        }
        val grouped = mergeable.groupBy { it::class to when (it) {
            is TabDocMarkup.Mark.Link -> it.url to it.target
            is TabDocMarkup.Mark.TextColor -> "${it.color}|${it.backgroundColor}|${it.fontSize}|${it.fontFamily}"
            is TabDocMarkup.Mark.Highlight -> it.color
            else -> null
        }}
        val merged = grouped.flatMap { (_, group) ->
            val sorted = group.sortedBy { it.from }
            val result = mutableListOf<TabDocMarkup.Mark>()
            var current = sorted.first()
            for (i in 1 until sorted.size) {
                val next = sorted[i]
                if (next.from <= current.to) {
                    current = extendMark(current, maxOf(current.to, next.to))
                } else {
                    result.add(current)
                    current = next
                }
            }
            result.add(current)
            result
        }
        val mergedMathematics = mathematics
            .groupBy { mathematicsMark ->
                listOf(
                    mathematicsMark.atomId,
                    mathematicsMark.nodeType,
                    mathematicsMark.valueAttribute,
                    mathematicsMark.attrs,
                )
            }
            .values
            .flatMap { group ->
                val sorted = group.sortedBy(TabDocMarkup.Mark.Mathematics::from)
                val result = mutableListOf<TabDocMarkup.Mark.Mathematics>()
                var current = sorted.first()
                for (i in 1 until sorted.size) {
                    val next = sorted[i]
                    if (next.from <= current.to) {
                        current = current.copy(to = maxOf(current.to, next.to))
                    } else {
                        result.add(current)
                        current = next
                    }
                }
                result.add(current)
                result
            }
        // 图片原子同样只按 atomId 合并：相邻的两张同构图片绝不能被并成一张。
        val mergedInlineImages = inlineImages
            .groupBy { image -> listOf(image.atomId, image.nodeType, image.attrs) }
            .values
            .flatMap { group ->
                val sorted = group.sortedBy(TabDocMarkup.Mark.InlineImage::from)
                val result = mutableListOf<TabDocMarkup.Mark.InlineImage>()
                var current = sorted.first()
                for (i in 1 until sorted.size) {
                    val next = sorted[i]
                    if (next.from <= current.to) {
                        current = current.copy(to = maxOf(current.to, next.to))
                    } else {
                        result.add(current)
                        current = next
                    }
                }
                result.add(current)
                result
            }
        return merged + mergedMathematics + mergedInlineImages + passthrough
    }

    private fun extendMark(mark: TabDocMarkup.Mark, newTo: Int): TabDocMarkup.Mark = when (mark) {
        is TabDocMarkup.Mark.Bold -> mark.copy(to = newTo)
        is TabDocMarkup.Mark.Italic -> mark.copy(to = newTo)
        is TabDocMarkup.Mark.Strikethrough -> mark.copy(to = newTo)
        is TabDocMarkup.Mark.Underline -> mark.copy(to = newTo)
        is TabDocMarkup.Mark.Code -> mark.copy(to = newTo)
        is TabDocMarkup.Mark.Link -> mark.copy(to = newTo)
        is TabDocMarkup.Mark.TextColor -> mark.copy(to = newTo)
        is TabDocMarkup.Mark.Highlight -> mark.copy(to = newTo)
        is TabDocMarkup.Mark.Subscript -> mark.copy(to = newTo)
        is TabDocMarkup.Mark.Superscript -> mark.copy(to = newTo)
        // Mathematics / InlineImage 在独立的 atomId 分组中合并；Unknown 不合并。
        is TabDocMarkup.Mark.Mathematics -> mark.copy(to = newTo)
        is TabDocMarkup.Mark.InlineImage -> mark.copy(to = newTo)
        is TabDocMarkup.Mark.Unknown -> mark.copy(to = newTo)
    }
}
