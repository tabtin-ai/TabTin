package com.tabtin.mobile.features.doc.editor.core

import android.text.Annotation
import android.text.InputFilter
import android.text.Spanned

/**
 * 未知 mark 是不可拆范围身份。编辑只能发生在范围外，或整段删掉这段覆盖文字。
 * 部分重叠、范围内插入、只改半段都会拆坏 type / attrs，必须拒绝。
 */
public object UnknownMarkRangeEditPolicy {
    public fun allowsEdit(rangeFrom: Int, rangeTo: Int, editStart: Int, editEnd: Int): Boolean {
        if (editEnd <= rangeFrom || editStart >= rangeTo) return true
        return editStart <= rangeFrom && editEnd >= rangeTo
    }

    public fun allowsEdit(ranges: List<IntRange>, editStart: Int, editEnd: Int): Boolean =
        ranges.all { allowsEdit(it.first, it.last + 1, editStart, editEnd) }

    public fun rangesIn(text: CharSequence): List<IntRange> {
        val spanned = text as? Spanned ?: return emptyList()
        return spanned.getSpans(0, spanned.length, Annotation::class.java)
            .filter { it.key == DocSpan.UnknownMark.KEY }
            .map { annotation ->
                spanned.getSpanStart(annotation) until spanned.getSpanEnd(annotation)
            }
    }
}

/**
 * 挡掉会拆开未知 mark 范围的输入。整段删除这段覆盖文字仍然允许。
 */
public class UnknownMarkRangeInputFilter : InputFilter {
    override fun filter(
        source: CharSequence?,
        start: Int,
        end: Int,
        dest: Spanned?,
        dstart: Int,
        dend: Int,
    ): CharSequence? {
        val current = dest ?: return null
        val ranges = UnknownMarkRangeEditPolicy.rangesIn(current)
        if (ranges.isEmpty()) return null
        return if (UnknownMarkRangeEditPolicy.allowsEdit(ranges, dstart, dend)) {
            null
        } else {
            dest.subSequence(dstart, dend)
        }
    }
}
