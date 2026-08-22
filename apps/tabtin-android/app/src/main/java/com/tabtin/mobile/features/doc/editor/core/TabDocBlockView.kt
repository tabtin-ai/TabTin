package com.tabtin.mobile.features.doc.editor.core

import com.tabtin.mobile.features.doc.model.DocTextAlignment
import com.tabtin.mobile.features.doc.model.TableData

/**
 * Derived from anytype-kotlin presentation/editor BlockView sealed class.
 * UI model for RecyclerView ViewHolders — distinct from DocBlock (ProseMirror data model).
 *
 * Design: each subtype holds all data needed for binding by its ViewHolder.
 * Interfaces provide cross-cutting capabilities (focus, selection, indent, markup).
 */
public sealed class TabDocBlockView {

    public abstract val id: String

    // --- Interfaces ---

    public interface TextSupport {
        public val body: String
        public val marks: List<TabDocMarkup.Mark>
    }

    public interface Focusable {
        public val isFocused: Boolean
        public val cursor: Int?
    }

    public interface Indentable {
        public val indent: Int
    }

    public interface Selectable {
        public val isSelected: Boolean
    }

    public interface Decoratable {
        public val background: String?
    }

    // --- View Types (constants for BlockAdapter) ---

    public object Types {
        public const val PARAGRAPH: Int = 0
        public const val HEADER_ONE: Int = 1
        public const val HEADER_TWO: Int = 2
        public const val HEADER_THREE: Int = 3
        public const val BULLETED: Int = 4
        public const val NUMBERED: Int = 5
        public const val CHECKBOX: Int = 6
        public const val QUOTE: Int = 7
        public const val CODE: Int = 8
        public const val DIVIDER_LINE: Int = 9
        public const val IMAGE: Int = 10
        public const val TABLE: Int = 11
        public const val UNSUPPORTED: Int = 12
        public const val TITLE: Int = 13
        public const val HEADER_FOUR: Int = 14
        public const val HEADER_FIVE: Int = 15
        public const val HEADER_SIX: Int = 16
        public const val COMMENTS: Int = 17
        public const val FORMULA: Int = 18
    }

    public abstract fun getViewType(): Int

    // --- Text Blocks ---

    public sealed class Text : TabDocBlockView(), TextSupport, Focusable, Indentable, Selectable {

        public abstract val alignment: DocTextAlignment?

        public data class Paragraph(
            override val id: String,
            override val body: String,
            override val marks: List<TabDocMarkup.Mark> = emptyList(),
            override val isFocused: Boolean = false,
            override val cursor: Int? = null,
            override val indent: Int = 0,
            override val isSelected: Boolean = false,
            override val alignment: DocTextAlignment? = null,
        ) : Text() {
            override fun getViewType(): Int = Types.PARAGRAPH
        }

        public data class HeaderOne(
            override val id: String,
            override val body: String,
            override val marks: List<TabDocMarkup.Mark> = emptyList(),
            override val isFocused: Boolean = false,
            override val cursor: Int? = null,
            override val indent: Int = 0,
            override val isSelected: Boolean = false,
            override val alignment: DocTextAlignment? = null,
        ) : Text() {
            override fun getViewType(): Int = Types.HEADER_ONE
        }

        public data class HeaderTwo(
            override val id: String,
            override val body: String,
            override val marks: List<TabDocMarkup.Mark> = emptyList(),
            override val isFocused: Boolean = false,
            override val cursor: Int? = null,
            override val indent: Int = 0,
            override val isSelected: Boolean = false,
            override val alignment: DocTextAlignment? = null,
        ) : Text() {
            override fun getViewType(): Int = Types.HEADER_TWO
        }

        public data class HeaderThree(
            override val id: String,
            override val body: String,
            override val marks: List<TabDocMarkup.Mark> = emptyList(),
            override val isFocused: Boolean = false,
            override val cursor: Int? = null,
            override val indent: Int = 0,
            override val isSelected: Boolean = false,
            override val alignment: DocTextAlignment? = null,
        ) : Text() {
            override fun getViewType(): Int = Types.HEADER_THREE
        }

        public data class HeaderFour(
            override val id: String,
            override val body: String,
            override val marks: List<TabDocMarkup.Mark> = emptyList(),
            override val isFocused: Boolean = false,
            override val cursor: Int? = null,
            override val indent: Int = 0,
            override val isSelected: Boolean = false,
            override val alignment: DocTextAlignment? = null,
        ) : Text() {
            override fun getViewType(): Int = Types.HEADER_FOUR
        }

        public data class HeaderFive(
            override val id: String,
            override val body: String,
            override val marks: List<TabDocMarkup.Mark> = emptyList(),
            override val isFocused: Boolean = false,
            override val cursor: Int? = null,
            override val indent: Int = 0,
            override val isSelected: Boolean = false,
            override val alignment: DocTextAlignment? = null,
        ) : Text() {
            override fun getViewType(): Int = Types.HEADER_FIVE
        }

        public data class HeaderSix(
            override val id: String,
            override val body: String,
            override val marks: List<TabDocMarkup.Mark> = emptyList(),
            override val isFocused: Boolean = false,
            override val cursor: Int? = null,
            override val indent: Int = 0,
            override val isSelected: Boolean = false,
            override val alignment: DocTextAlignment? = null,
        ) : Text() {
            override fun getViewType(): Int = Types.HEADER_SIX
        }

        public data class Bulleted(
            override val id: String,
            override val body: String,
            override val marks: List<TabDocMarkup.Mark> = emptyList(),
            override val isFocused: Boolean = false,
            override val cursor: Int? = null,
            override val indent: Int = 0,
            override val isSelected: Boolean = false,
            override val alignment: DocTextAlignment? = null,
        ) : Text() {
            override fun getViewType(): Int = Types.BULLETED
        }

        public data class Numbered(
            override val id: String,
            override val body: String,
            override val marks: List<TabDocMarkup.Mark> = emptyList(),
            override val isFocused: Boolean = false,
            override val cursor: Int? = null,
            override val indent: Int = 0,
            override val isSelected: Boolean = false,
            override val alignment: DocTextAlignment? = null,
            val number: Int = 1,
        ) : Text() {
            override fun getViewType(): Int = Types.NUMBERED
        }

        public data class Checkbox(
            override val id: String,
            override val body: String,
            override val marks: List<TabDocMarkup.Mark> = emptyList(),
            override val isFocused: Boolean = false,
            override val cursor: Int? = null,
            override val indent: Int = 0,
            override val isSelected: Boolean = false,
            override val alignment: DocTextAlignment? = null,
            val isChecked: Boolean = false,
        ) : Text() {
            override fun getViewType(): Int = Types.CHECKBOX
        }

        public data class Quote(
            override val id: String,
            override val body: String,
            override val marks: List<TabDocMarkup.Mark> = emptyList(),
            override val isFocused: Boolean = false,
            override val cursor: Int? = null,
            override val indent: Int = 0,
            override val isSelected: Boolean = false,
            override val alignment: DocTextAlignment? = null,
        ) : Text() {
            override fun getViewType(): Int = Types.QUOTE
        }
    }

    // --- Non-Text Blocks ---

    public data class Code(
        override val id: String,
        val body: String,
        val language: String = "",
        val isFocused: Boolean = false,
        val cursor: Int? = null,
        val isSelected: Boolean = false,
    ) : TabDocBlockView() {
        override fun getViewType(): Int = Types.CODE
    }

    public data class DividerLine(
        override val id: String,
        val isSelected: Boolean = false,
    ) : TabDocBlockView() {
        override fun getViewType(): Int = Types.DIVIDER_LINE
    }

    public data class Image(
        override val id: String,
        val url: String,
        val alt: String = "",
        /** 仅供运行期解析展示地址；不得作为 ProseMirror 写回真源。 */
        val fileId: String = "",
        /** 既有图片保留原始子树，只展示而不允许重新上传替换。 */
        val isReadOnly: Boolean = false,
        val isSelected: Boolean = false,
    ) : TabDocBlockView() {
        override fun getViewType(): Int = Types.IMAGE
    }

    public data class Table(
        override val id: String,
        val tableData: TableData,
        val isSelected: Boolean = false,
        /** 复杂表格（合并单元格、富文本单元格等）局部只读；不牵连整篇文档。 */
        val isReadonly: Boolean = false,
    ) : TabDocBlockView() {
        override fun getViewType(): Int = Types.TABLE
    }

    public data class Unsupported(
        override val id: String,
        val typeName: String? = null,
        val title: String? = null,
        val isSelected: Boolean = false,
    ) : TabDocBlockView() {
        override fun getViewType(): Int = Types.UNSUPPORTED
    }

    /** 块级公式只读真渲染；定义/编辑仍交完整编辑器。 */
    public data class Formula(
        override val id: String,
        val latex: String,
        val isSelected: Boolean = false,
    ) : TabDocBlockView() {
        override fun getViewType(): Int = Types.FORMULA
    }

    public data class Title(
        override val id: String,
        val body: String,
        val isFocused: Boolean = false,
        val cursor: Int? = null,
    ) : TabDocBlockView() {
        override fun getViewType(): Int = Types.TITLE
    }

    /** 文末评论区占位；具体内容由 adapter 持有，避免核心块模型依赖评论包。 */
    public data class CommentsFooter(
        override val id: String = DOCUMENT_COMMENTS_ID,
    ) : TabDocBlockView() {
        override fun getViewType(): Int = Types.COMMENTS
    }

    public companion object {
        public const val DOCUMENT_COMMENTS_ID: String = "__tabtin_document_comments__"
    }
}
