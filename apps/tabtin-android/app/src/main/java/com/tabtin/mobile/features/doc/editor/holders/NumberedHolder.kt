package com.tabtin.mobile.features.doc.editor.holders

import com.tabtin.mobile.databinding.DocBlockNumberedBinding
import com.tabtin.mobile.features.doc.editor.core.SlashTextWatcherState
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.applyTTTypography

/**
 * 有序列表块 ViewHolder。
 * 在 bind 时设置序号文本（如 "1."）。
 */
public class NumberedHolder(
    private val binding: DocBlockNumberedBinding,
    onTextChanged: (String, String, List<TabDocMarkup.Mark>) -> Unit,
    onEnterPressed: (String, IntRange) -> Unit,
    onEmptyBackspace: (String) -> Unit,
    onFocusChanged: (String) -> Unit,
    onSlashEvent: (String, SlashTextWatcherState) -> Unit,
    onSelectionChanged: (String, IntRange) -> Unit,
    onBlockLongPress: (String) -> Unit = {},
) : TextHolder(
    view = binding.root,
    widget = binding.textContent,
    paddingStart = TTSpacing.xs,
    onTextChanged = onTextChanged,
    onEnterPressed = onEnterPressed,
    onEmptyBackspace = onEmptyBackspace,
    onFocusChanged = onFocusChanged,
    onSlashEvent = onSlashEvent,
    onSelectionChanged = onSelectionChanged,
    onBlockLongPress = onBlockLongPress,
) {

    init {
        binding.number.applyTTTypography(TTFonts.Role.BODY)
    }

    override fun bind(item: TabDocBlockView.Text) {
        super.bind(item)
        if (item is TabDocBlockView.Text.Numbered) {
            binding.number.text = "${item.number}."
        }
    }

    override fun processPayload(item: TabDocBlockView, payloads: Set<Int>) {
        super.processPayload(item, payloads)
        if (item is TabDocBlockView.Text.Numbered
            && DocBlockDiffUtil.Payload.NUMBER_CHANGED in payloads
        ) {
            binding.number.text = "${item.number}."
        }
    }

    override fun applyIndent(indent: Int) {
        val density = binding.root.resources.displayMetrics.density
        val start = ((TTSpacing.lg.value + indent * TTSpacing.xxl.value) * density).toInt()
        binding.root.setPaddingRelative(
            start,
            binding.root.paddingTop,
            binding.root.paddingEnd,
            binding.root.paddingBottom,
        )
    }
}
