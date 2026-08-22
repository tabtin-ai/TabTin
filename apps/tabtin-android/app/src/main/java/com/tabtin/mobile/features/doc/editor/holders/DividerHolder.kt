package com.tabtin.mobile.features.doc.editor.holders

import com.tabtin.mobile.databinding.DocBlockDividerBinding
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView

/**
 * 分割线块 ViewHolder — 纯展示，长按可触发块操作菜单。
 */
public class DividerHolder(
    binding: DocBlockDividerBinding,
    private val onBlockLongPress: (id: String) -> Unit = {},
) : DocBlockViewHolder(binding.root) {

    private var blockId: String = ""

    init {
        binding.root.setOnLongClickListener {
            onBlockLongPress(blockId)
            true
        }
    }

    override fun bind(item: TabDocBlockView) {
        blockId = item.id
        val divider = item as? TabDocBlockView.DividerLine
        applySelectionState(divider?.isSelected == true)
    }

    override fun processPayload(item: TabDocBlockView, payloads: Set<Int>) {
        if (item !is TabDocBlockView.DividerLine) { bind(item); return }
        blockId = item.id
        if (DocBlockDiffUtil.Payload.SELECTION_CHANGED in payloads) {
            applySelectionState(item.isSelected)
        }
    }
}
