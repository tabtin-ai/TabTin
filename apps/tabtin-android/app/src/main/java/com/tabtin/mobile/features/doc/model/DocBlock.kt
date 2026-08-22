package com.tabtin.mobile.features.doc.model

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

/**
 * ProseMirror 文本块与原生 TextView 共用的对齐语义。
 *
 * `null` 不属于枚举：它表示未显式指定、跟随书写方向的自然起点；[LEFT] 则始终是
 * 物理左侧。两者在 RTL 环境不能合并。
 */
public enum class DocTextAlignment(public val serializedValue: String) {
    LEFT("left"),
    CENTER("center"),
    RIGHT("right"),
    JUSTIFY("justify");

    public companion object {
        public fun fromSerializedValue(value: String?): DocTextAlignment? =
            entries.firstOrNull { it.serializedValue == value }

        public fun fromSourceAttributes(attributes: JsonElement?): DocTextAlignment? {
            val value = (attributes as? JsonObject)?.get("textAlign") as? JsonPrimitive
                ?: return null
            if (!value.isString) return null
            return fromSerializedValue(value.content)
        }
    }
}

public enum class BlockKind {
    PARAGRAPH,
    HEADING1,
    HEADING2,
    HEADING3,
    HEADING4,
    HEADING5,
    HEADING6,
    BULLET_ITEM,
    ORDERED_ITEM,
    TODO_ITEM,
    CODE_BLOCK,
    BLOCKQUOTE,
    DIVIDER,
    IMAGE,
    TABLE,
    UNSUPPORTED;

    public val isEditable: Boolean
        get() = this != UNSUPPORTED && this != DIVIDER && this != TABLE && this != IMAGE

    public val isListLike: Boolean
        get() = this == BULLET_ITEM || this == ORDERED_ITEM || this == TODO_ITEM

    public val isHeading: Boolean
        get() = this == HEADING1 || this == HEADING2 || this == HEADING3 ||
                this == HEADING4 || this == HEADING5 || this == HEADING6

    public val canIndent: Boolean
        get() = isListLike

    public companion object {
        public val insertable: List<BlockKind> = listOf(
            PARAGRAPH, HEADING1, HEADING2, HEADING3,
            BULLET_ITEM, ORDERED_ITEM, TODO_ITEM,
            CODE_BLOCK, BLOCKQUOTE, DIVIDER, IMAGE, TABLE,
        )
    }
}

public enum class InlineMarkKind {
    BOLD, ITALIC, STRIKE, UNDERLINE, CODE, LINK, TEXT_COLOR, HIGHLIGHT, MATHEMATICS,
    INLINE_IMAGE, SUBSCRIPT, SUPERSCRIPT, UNKNOWN;
}

public sealed class InlineMark {
    public data object Bold : InlineMark()
    public data object Italic : InlineMark()
    public data object Code : InlineMark()
    public data object Strike : InlineMark()
    public data object Underline : InlineMark()
    public data object Subscript : InlineMark()
    public data object Superscript : InlineMark()
    public data class Link(
        val href: String,
        val target: String? = null,
    ) : InlineMark()
    public data class TextColor(
        val color: String = "",
        val backgroundColor: String = "",
        val fontSize: String = "",
        val fontFamily: String = "",
    ) : InlineMark()
    public data class Highlight(val color: String) : InlineMark()
    /**
     * 行内公式原子。节点类型与除正文外的属性属于公式自身的语义，必须随 mark 一起经过
     * 编辑、拆分、合并、复制和撤销链路，不能靠它在块内的出现顺序回填。
     */
    public data class Mathematics(
        val nodeType: String = "mathematics",
        val valueAttribute: String = "latex",
        val attrs: Map<String, Any?> = emptyMap(),
        /** 仅在本次编辑会话内区分公式原子；序列化时不得写回 ProseMirror JSON。 */
        val atomId: String = UUID.randomUUID().toString(),
    ) : InlineMark()

    /**
     * 行内图片原子。图片身份只由 [attrs] 承载并原样写回，占位文字仅供编辑界面定位光标，
     * 不参与序列化——用户在占位串内打字不会改写图片，删掉整段占位才等于删除这张图片。
     *
     * `src` 是渲染期签名地址，随 attrs 一起原样带回但绝不由原生端重新生成；持久身份是 `fileId`。
     */
    public data class InlineImage(
        val nodeType: String = "image",
        val attrs: Map<String, Any?> = emptyMap(),
        /** 仅在本次编辑会话内区分图片原子；序列化时不得写回 ProseMirror JSON。 */
        val atomId: String = UUID.randomUUID().toString(),
    ) : InlineMark() {
        public companion object {
            /**
             * 图片排不出来时的诚实降级文案，也是行内图片在正文里占的底层文本：
             * 真图渲染时由图片 span 盖在这段之上，所以加载失败自然露出可读的 alt。
             */
            public fun placeholderText(attrs: Map<String, Any?>): String {
                val label = listOf("alt", "title", "name")
                    .firstNotNullOfOrNull { key ->
                        (attrs[key] as? String)?.trim()?.takeIf(String::isNotEmpty)
                    }
                return if (label != null) "🖼 $label" else "🖼"
            }
        }
    }

    /**
     * 未识别的 mark：解析层原样保留 type + attrs，序列化层原样写回。
     * 顶层段落里它是不可拆的范围身份——前后普通字可改，这段覆盖文字作为整体走，
     * 不画特殊样式。表格格与无法完整重建的形态仍保持只读。
     */
    public data class Unknown(val type: String, val attrs: Map<String, Any?> = emptyMap()) : InlineMark()

    public val kind: InlineMarkKind
        get() = when (this) {
            is Bold -> InlineMarkKind.BOLD
            is Italic -> InlineMarkKind.ITALIC
            is Strike -> InlineMarkKind.STRIKE
            is Underline -> InlineMarkKind.UNDERLINE
            is Code -> InlineMarkKind.CODE
            is Link -> InlineMarkKind.LINK
            is TextColor -> InlineMarkKind.TEXT_COLOR
            is Highlight -> InlineMarkKind.HIGHLIGHT
            is Subscript -> InlineMarkKind.SUBSCRIPT
            is Superscript -> InlineMarkKind.SUPERSCRIPT
            is Mathematics -> InlineMarkKind.MATHEMATICS
            is InlineImage -> InlineMarkKind.INLINE_IMAGE
            is Unknown -> InlineMarkKind.UNKNOWN
        }

    public companion object {
        public fun fromKind(kind: InlineMarkKind): InlineMark = when (kind) {
            InlineMarkKind.BOLD -> Bold
            InlineMarkKind.ITALIC -> Italic
            InlineMarkKind.STRIKE -> Strike
            InlineMarkKind.UNDERLINE -> Underline
            InlineMarkKind.CODE -> Code
            InlineMarkKind.LINK -> Link("")
            InlineMarkKind.TEXT_COLOR -> TextColor()
            InlineMarkKind.HIGHLIGHT -> Highlight("")
            InlineMarkKind.MATHEMATICS -> Mathematics()
            // 行内图片不能凭空构造身份；工具条不提供该分支。
            InlineMarkKind.INLINE_IMAGE -> InlineImage()
            InlineMarkKind.SUBSCRIPT -> Subscript
            InlineMarkKind.SUPERSCRIPT -> Superscript
            // UNKNOWN 无法凭空构造有意义实例；工具条不会触发该分支。
            InlineMarkKind.UNKNOWN -> Unknown("unknown")
        }
    }
}

public data class InlineSpan(
    val text: String,
    val marks: List<InlineMark> = emptyList(),
) {
    val isPlain: Boolean get() = marks.isEmpty()
}

public fun List<InlineSpan>.plainText(): String = joinToString("") { it.text }

public enum class TableContentSummaryKind {
    WHITEBOARD,
    EMBEDDED_TABLE,
    EMBEDDED_HTML,
    VIDEO,
    COMPLEX_CONTENT,
}

public sealed interface TableCellProjectionPart {
    public data class Literal(val value: String) : TableCellProjectionPart

    public data class Summary(
        val kind: TableContentSummaryKind,
        val title: String? = null,
    ) : TableCellProjectionPart
}

/**
 * 复杂单元格的语义投影。模型层只保存结构和原始标题；产品语言由 UI/复制边界注入，
 * 避免当前语言被写进草稿、持久化快照或另一语言环境的剪贴板。
 */
public data class TableCellProjection(
    val parts: List<TableCellProjectionPart> = emptyList(),
) {
    public val hasVisibleContent: Boolean
        get() = parts.any { part ->
            part is TableCellProjectionPart.Summary ||
                (part is TableCellProjectionPart.Literal && part.value.isNotBlank())
        }

    public val unlocalizedText: String
        get() = render { "" }

    public fun render(labelFor: (TableContentSummaryKind) -> String): String =
        buildString {
            parts.forEach { part ->
                when (part) {
                    is TableCellProjectionPart.Literal -> append(part.value)
                    is TableCellProjectionPart.Summary -> {
                        val label = labelFor(part.kind).trim()
                        val title = part.title?.trim().orEmpty()
                        append(listOf(label, title).filter(String::isNotEmpty).joinToString(" "))
                    }
                }
            }
        }

    public fun appending(other: TableCellProjection): TableCellProjection =
        TableCellProjection(parts + other.parts)

    public fun indentContinuation(prefix: String): TableCellProjection =
        TableCellProjection(parts.map { part ->
            if (part is TableCellProjectionPart.Literal) {
                part.copy(value = part.value.replace("\n", "\n$prefix"))
            } else {
                part
            }
        })

    public companion object {
        public fun literal(value: String): TableCellProjection =
            if (value.isEmpty()) TableCellProjection()
            else TableCellProjection(listOf(TableCellProjectionPart.Literal(value)))

        public fun summary(
            kind: TableContentSummaryKind,
            title: String? = null,
        ): TableCellProjection = TableCellProjection(
            listOf(TableCellProjectionPart.Summary(kind, title)),
        )

        public fun join(
            projections: List<TableCellProjection>,
            separator: String,
        ): TableCellProjection {
            val visible = projections.filter(TableCellProjection::hasVisibleContent)
            return visible.foldIndexed(TableCellProjection()) { index, result, projection ->
                val prefix = if (index == 0) TableCellProjection() else literal(separator)
                result.appending(prefix).appending(projection)
            }
        }
    }
}

public data class TableCell(
    val text: String = "",
    val spans: List<InlineSpan> = emptyList(),
    val alignment: DocTextAlignment? = null,
    val isHeader: Boolean = false,
    val colspan: Int = 1,
    val rowspan: Int = 1,
    val rawNode: Map<String, Any?>? = null,
    val rawParagraph: Map<String, Any?>? = null,
    val isReadOnlyProjection: Boolean = false,
    val projection: TableCellProjection? = null,
)

public data class TableRow(
    val cells: List<TableCell>,
    val rawNode: Map<String, Any?>? = null,
)

public data class TableData(
    val rows: List<TableRow> = emptyList(),
) {
    val columnCount: Int
        get() = rows.maxOfOrNull { row -> row.cells.sumOf { it.colspan } } ?: 0

    val rowCount: Int get() = rows.size

    val isEmpty: Boolean get() = rows.isEmpty()

    val projectedCellCount: Int
        get() = rows.sumOf { row -> row.cells.count(TableCell::isReadOnlyProjection) }

    val hasProjectedCells: Boolean get() = projectedCellCount > 0

    /**
     * 新增行列只适用于未合并的矩形表格。合并单元格需要同步调整 colspan / rowspan，
     * 移动端当前不做这种结构变换，避免生成宽度不一致的 ProseMirror 表格。
     */
    val hasUniformUnmergedStructure: Boolean
        get() = rows.isNotEmpty() && rows.all { row ->
            row.cells.size == columnCount && row.cells.all { cell ->
                cell.colspan == 1 && cell.rowspan == 1
            }
        }

    val canAddRow: Boolean
        get() = hasUniformUnmergedStructure && rowCount < MAX_ROW_COUNT

    val canAddColumn: Boolean
        get() = hasUniformUnmergedStructure && columnCount < MAX_COLUMN_COUNT

    public fun copyText(renderCell: (TableCell) -> String = TableCell::text): String =
        rows.joinToString("\n") { row ->
            row.cells.joinToString("\t", transform = renderCell)
        }

    public companion object {
        public const val MAX_ROW_COUNT: Int = 100
        public const val MAX_COLUMN_COUNT: Int = 20

        public fun defaultEmpty(rowCount: Int = 3, colCount: Int = 3): TableData {
            val headerCells = (0 until colCount).map { TableCell(isHeader = true) }
            val rows = mutableListOf(TableRow(headerCells))
            repeat(rowCount - 1) {
                rows.add(TableRow((0 until colCount).map { TableCell() }))
            }
            return TableData(rows)
        }
    }
}

public data class DocBlock(
    val id: String = UUID.randomUUID().toString(),
    val blockId: String? = null,
    val kind: BlockKind = BlockKind.PARAGRAPH,
    val spans: List<InlineSpan> = listOf(InlineSpan("")),
    val checked: Boolean = false,
    val indentLevel: Int = 0,
    val codeLanguage: String = "",
    val imageURL: String = "",
    val imageAlt: String = "",
    val imageFileId: String = "",
    val imageWidth: Int? = null,
    val imageHeight: Int? = null,
    val imageTitle: String = "",
    val listStart: Int = 1,
    /**
     * 来源 orderedList 是否显式携带 schema 缺省值 `type=null`。该形态由 Electron
     * 生成，编辑正文后仍须原样写回；新建列表默认 false，不主动扩散该属性。
     */
    val orderedListHasExplicitNullType: Boolean = false,
    /**
     * 仅在本次编辑会话内标识一个 ProseMirror list 容器。相邻同类型列表即使紧挨，
     * 只要来自不同容器也不能在序列化时合并；该身份不写回 JSON。
     */
    val listContainerId: String? = null,
    /**
     * 所属 list 容器节点的持久 `blockId`（协作文档由 UniqueID 扩展写入）。与
     * [listContainerId] 同生共死：容器沿用则沿用，换容器则换成目标容器的身份，
     * 新建容器为 null。容器身份和 [blockId] 承载的 listItem 身份是两层锚点。
     */
    val listBlockId: String? = null,
    /**
     * 列表项内正文段落的持久 `blockId`。列表项与项内段落在 ProseMirror 里是两个
     * 节点，各自可被块级评论与分享锚点引用，不能互相顶替。
     */
    val listParagraphBlockId: String? = null,
    /**
     * 仅在本次编辑会话内标识一个 ProseMirror blockquote 容器。一个引用容器可包含
     * 多个段落；相邻但独立的引用必须持有不同身份，避免序列化时被误合并。
     */
    val quoteContainerId: String? = if (kind == BlockKind.BLOCKQUOTE) UUID.randomUUID().toString() else null,
    /**
     * ProseMirror `blockquote` 容器自身的持久 `blockId`，与 [blockId] 承载的子段落身份
     * 各自独立：协作编辑器会同时给引用容器和其中每个段落分配身份，任何一层被顶替或
     * 丢弃都会让块级评论、分享锚点在下一次保存后失效。新建引用没有持久身份，保持 null。
     */
    val quoteBlockId: String? = null,
    /**
     * 已去除 `blockId`/heading `level` 身份字段的文本节点 attrs 原始形态。目前只承载
     * `textAlign` 及 missing/null/{} 三态；身份与层级始终以结构化字段为唯一真源。
     * 编辑 spans 后仍会写入新正文，而显式对齐与 `textAlign=null` 等 schema 形态不丢失。
     */
    val sourceAttributes: JsonElement? = null,
    val rawNode: Map<String, Any?>? = null,
    /**
     * ProseMirror 根 content 中无法映射成标准节点的原始元素（包括 primitive、null
     * 或缺少 type 的对象）。这类元素只作为局部只读占位参与排序，并原样写回；
     * 原生编辑器永不解释或修改其内容。
     */
    val rawElement: JsonElement? = null,
    val unsupportedType: String? = null,
    val tableData: TableData? = null,
    /**
     * 逐块可编辑性（批次 1b）：false 的块按局部只读呈现并保留原始子树，
     * 不再让整篇文档降级只读。由 parser 依 [NativeDocumentSafetyPolicy] 判定；
     * 与 [BlockKind.isEditable] 取与后才是最终可编辑结论（见 [canEditInline]）。
     */
    val editable: Boolean = true,
    /**
     * 是否允许只移除该 ProseMirror 顶层块引用。它与 [editable] 分离：
     * 已有正典独立图片的内容仍不可替换，但整块删除是无损的。
     * 默认跟随 [editable]，使既有可编辑块保持原有删除能力。
     */
    val canDeleteWholeBlock: Boolean = editable,
) {
    val text: String get() = spans.plainText()

    /** 该块是否允许行内编辑与结构操作（删除、转换等）。 */
    val canEditInline: Boolean get() = editable && kind.isEditable

    public companion object {
        public const val MAX_INDENT_LEVEL: Int = 4

        public fun empty(kind: BlockKind): DocBlock {
            if (kind == BlockKind.TABLE) {
                return DocBlock(kind = kind, tableData = TableData.defaultEmpty())
            }
            return DocBlock(kind = kind)
        }
    }
}
