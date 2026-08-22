package com.tabtin.mobile.features.doc.editor.holders

import androidx.core.view.isVisible
import com.tabtin.mobile.databinding.DocBlockUnsupportedBinding
import com.tabtin.mobile.features.doc.editor.UnsupportedContentLocalization
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView

/**
 * 不支持的块类型占位 ViewHolder。
 * 显示类型名称或默认提示文本。
 */
public class UnsupportedHolder(
    private val binding: DocBlockUnsupportedBinding,
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
        val block = item as? TabDocBlockView.Unsupported ?: return
        blockId = block.id
        applySelectionState(block.isSelected)
        // 产品化命名：已知嵌入块显示产品名，未知内容显示通用占位；
        // 实现名（tabwhiteboard / futureChart 等）按契约永不上屏。
        binding.label.text = UnsupportedContentLocalization.label(
            binding.root.context,
            block.typeName,
        )
        binding.title.text = block.title.orEmpty()
        binding.title.isVisible = block.title != null
    }
}
