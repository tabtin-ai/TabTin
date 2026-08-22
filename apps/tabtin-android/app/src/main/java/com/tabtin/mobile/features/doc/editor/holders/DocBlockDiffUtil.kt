package com.tabtin.mobile.features.doc.editor.holders

import androidx.recyclerview.widget.DiffUtil
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView

/**
 * Derived from anytype-kotlin core-ui BlockViewDiffUtil.
 * Provides item identity and content comparison for RecyclerView adapter updates.
 */
public class DocBlockDiffUtil(
    private val old: List<TabDocBlockView>,
    private val new: List<TabDocBlockView>
) : DiffUtil.Callback() {

    override fun getOldListSize(): Int = old.size
    override fun getNewListSize(): Int = new.size

    override fun areItemsTheSame(oldPos: Int, newPos: Int): Boolean {
        return old[oldPos].id == new[newPos].id
    }

    override fun areContentsTheSame(oldPos: Int, newPos: Int): Boolean {
        return old[oldPos] == new[newPos]
    }

    override fun getChangePayload(oldPos: Int, newPos: Int): Any? {
        val oldItem = old[oldPos]
        val newItem = new[newPos]
        if (oldItem::class != newItem::class) return null

        val changes = mutableSetOf<Int>()

        if (oldItem is TabDocBlockView.Text && newItem is TabDocBlockView.Text) {
            if (oldItem.body != newItem.body || oldItem.marks != newItem.marks) {
                changes.add(Payload.TEXT_CHANGED)
            }
            if (oldItem.isFocused != newItem.isFocused) {
                changes.add(Payload.FOCUS_CHANGED)
            }
            if (oldItem.cursor != newItem.cursor) {
                changes.add(Payload.CURSOR_CHANGED)
            }
            if (oldItem.indent != newItem.indent) {
                changes.add(Payload.INDENT_CHANGED)
            }
            if (oldItem.alignment != newItem.alignment) {
                changes.add(Payload.ALIGNMENT_CHANGED)
            }
            if (oldItem.isSelected != newItem.isSelected) {
                changes.add(Payload.SELECTION_CHANGED)
            }
            if (oldItem is TabDocBlockView.Text.Checkbox && newItem is TabDocBlockView.Text.Checkbox) {
                if (oldItem.isChecked != newItem.isChecked) {
                    changes.add(Payload.CHECKED_CHANGED)
                }
            }
            if (oldItem is TabDocBlockView.Text.Numbered && newItem is TabDocBlockView.Text.Numbered) {
                if (oldItem.number != newItem.number) {
                    changes.add(Payload.NUMBER_CHANGED)
                }
            }
        }

        if (oldItem is TabDocBlockView.Code && newItem is TabDocBlockView.Code) {
            if (oldItem.body != newItem.body) changes.add(Payload.TEXT_CHANGED)
            if (oldItem.isFocused != newItem.isFocused) changes.add(Payload.FOCUS_CHANGED)
            if (oldItem.language != newItem.language) changes.add(Payload.LANGUAGE_CHANGED)
            if (oldItem.isSelected != newItem.isSelected) changes.add(Payload.SELECTION_CHANGED)
        }

        if (oldItem is TabDocBlockView.Title && newItem is TabDocBlockView.Title) {
            if (oldItem.body != newItem.body) changes.add(Payload.TEXT_CHANGED)
            if (oldItem.isFocused != newItem.isFocused) changes.add(Payload.FOCUS_CHANGED)
            if (oldItem.cursor != newItem.cursor) changes.add(Payload.CURSOR_CHANGED)
        }

        if (oldItem is TabDocBlockView.Image && newItem is TabDocBlockView.Image) {
            if (oldItem.isSelected != newItem.isSelected) changes.add(Payload.SELECTION_CHANGED)
        }
        if (oldItem is TabDocBlockView.DividerLine && newItem is TabDocBlockView.DividerLine) {
            if (oldItem.isSelected != newItem.isSelected) changes.add(Payload.SELECTION_CHANGED)
        }
        if (oldItem is TabDocBlockView.Table && newItem is TabDocBlockView.Table) {
            if (oldItem.isSelected != newItem.isSelected) changes.add(Payload.SELECTION_CHANGED)
            if (oldItem.tableData != newItem.tableData) changes.add(Payload.TEXT_CHANGED)
        }
        if (oldItem is TabDocBlockView.Formula && newItem is TabDocBlockView.Formula) {
            if (oldItem.isSelected != newItem.isSelected) changes.add(Payload.SELECTION_CHANGED)
            if (oldItem.latex != newItem.latex) changes.add(Payload.TEXT_CHANGED)
        }

        return if (changes.isNotEmpty()) changes else null
    }

    public object Payload {
        public const val TEXT_CHANGED: Int = 1
        public const val FOCUS_CHANGED: Int = 2
        public const val CURSOR_CHANGED: Int = 3
        public const val INDENT_CHANGED: Int = 4
        public const val SELECTION_CHANGED: Int = 5
        public const val CHECKED_CHANGED: Int = 6
        public const val NUMBER_CHANGED: Int = 7
        public const val LANGUAGE_CHANGED: Int = 8
        public const val ALIGNMENT_CHANGED: Int = 9
    }
}
