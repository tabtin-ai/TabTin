package com.tabtin.mobile.features.doc.editor.holders

import com.tabtin.mobile.databinding.DocBlockBulletedBinding
import com.tabtin.mobile.features.doc.editor.core.SlashTextWatcherState
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * 无序列表块 ViewHolder。
 * 缩进通过调整 bulletIndent 视图宽度实现，保持圆点标记位置正确。
 */
public class BulletedHolder(
    private val binding: DocBlockBulletedBinding,
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

    override fun bind(item: TabDocBlockView.Text) {
        super.bind(item)
        // 缩进通过 bulletIndent 占位 View 宽度控制
        val indentPx = (
            item.indent * TTSpacing.xxl.value * binding.root.resources.displayMetrics.density
        ).toInt()
        binding.bulletIndent.layoutParams = binding.bulletIndent.layoutParams.apply {
            width = indentPx
        }
    }

    override fun applyIndent(indent: Int) {
        // 不在 widget 上设置 padding，缩进由 bulletIndent View 控制
    }
}
