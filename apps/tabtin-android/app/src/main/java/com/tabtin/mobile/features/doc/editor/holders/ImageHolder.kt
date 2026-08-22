package com.tabtin.mobile.features.doc.editor.holders

import android.view.View
import coil.load
import coil.size.Scale
import com.tabtin.mobile.R
import com.tabtin.mobile.databinding.DocBlockImageBinding
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView

public class ImageHolder(
    private val binding: DocBlockImageBinding,
    private val onBlockLongPress: (id: String) -> Unit = {},
    private val onImagePlaceholderClick: (id: String) -> Unit = {},
    private val isSelectionModeProvider: () -> Boolean = { false },
) : DocBlockViewHolder(binding.root) {

    private var blockId: String = ""
    private var isReadOnly: Boolean = false

    init {
        binding.root.setOnLongClickListener {
            onBlockLongPress(blockId)
            true
        }
        binding.placeholder.setOnClickListener {
            if (!isReadOnly && !isSelectionModeProvider()) {
                onImagePlaceholderClick(blockId)
            }
        }
    }

    override fun bind(item: TabDocBlockView) {
        val img = item as? TabDocBlockView.Image ?: return
        blockId = img.id
        binding.image.contentDescription = img.alt
        applySelectionState(img.isSelected)

        if (img.url.isNotBlank()) {
            binding.placeholder.visibility = View.GONE
            binding.image.visibility = View.VISIBLE
            binding.image.load(img.url) {
                crossfade(true)
                scale(Scale.FIT)
                size(1080, 1920)
                error(R.drawable.ic_image_broken)
            }
        } else {
            binding.image.visibility = View.GONE
            binding.placeholder.visibility = View.VISIBLE
        }
    }

    override fun setReadOnly(readOnly: Boolean) {
        isReadOnly = readOnly
        binding.placeholder.isEnabled = !readOnly
        binding.placeholder.isClickable = !readOnly
        binding.placeholder.isFocusable = !readOnly
    }

    override fun processPayload(item: TabDocBlockView, payloads: Set<Int>) {
        if (item !is TabDocBlockView.Image) { bind(item); return }
        blockId = item.id
        if (DocBlockDiffUtil.Payload.SELECTION_CHANGED in payloads) {
            applySelectionState(item.isSelected)
        }
    }
}
