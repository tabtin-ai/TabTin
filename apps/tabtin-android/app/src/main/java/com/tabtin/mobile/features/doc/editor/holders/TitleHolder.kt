package com.tabtin.mobile.features.doc.editor.holders

import android.text.Editable
import android.text.TextWatcher
import com.tabtin.mobile.databinding.DocBlockTitleBinding
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.TTViewFontWeight
import com.tabtin.mobile.ui.theme.applyTTPadding
import com.tabtin.mobile.ui.theme.applyTTTypography

/**
 * 文档标题块 ViewHolder。
 * titleInput 是普通 EditText（非 DocTextInputWidget），不走 marks 渲染。
 */
public class TitleHolder(
    private val binding: DocBlockTitleBinding,
    private val onTitleChanged: (title: String) -> Unit,
    private val onFocusChanged: (id: String) -> Unit,
) : DocBlockViewHolder(binding.root) {

    private var blockId: String = ""
    private var suppressWatcher = false

    init {
        binding.titleInput.applyTTTypography(TTFonts.Role.DISPLAY, TTViewFontWeight.SEMIBOLD)
        binding.titleInput.applyTTPadding(
            TTSpacing.lg,
            TTSpacing.lg,
            TTSpacing.lg,
            0.dp,
        )
        binding.titleInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (suppressWatcher) return
                onTitleChanged(s?.toString() ?: "")
            }
        })

        binding.titleInput.setOnFocusChangeListener { _, hasFocus ->
            if (hasFocus) onFocusChanged(blockId)
        }
    }

    override fun bind(item: TabDocBlockView) {
        val title = item as? TabDocBlockView.Title ?: return
        blockId = title.id

        suppressWatcher = true
        binding.titleInput.setText(title.body)
        suppressWatcher = false

        if (title.isFocused) {
            binding.titleInput.post {
                if (!binding.titleInput.hasFocus()) binding.titleInput.requestFocus()
                val cursor = title.cursor
                    ?.coerceIn(0, binding.titleInput.text?.length ?: 0)
                    ?: (binding.titleInput.text?.length ?: 0)
                binding.titleInput.setSelection(cursor)
            }
        }
    }

    override fun setReadOnly(readOnly: Boolean) {
        binding.titleInput.isFocusable = !readOnly
        binding.titleInput.isFocusableInTouchMode = !readOnly
        if (readOnly) binding.titleInput.clearFocus()
    }

    override fun processPayload(item: TabDocBlockView, payloads: Set<Int>) {
        if (item !is TabDocBlockView.Title) { bind(item); return }
        blockId = item.id

        if (DocBlockDiffUtil.Payload.TEXT_CHANGED in payloads) {
            suppressWatcher = true
            val current = binding.titleInput.text?.toString() ?: ""
            if (current != item.body) {
                binding.titleInput.setText(item.body)
            }
            suppressWatcher = false
        }
        if (DocBlockDiffUtil.Payload.FOCUS_CHANGED in payloads && item.isFocused) {
            binding.titleInput.post {
                if (!binding.titleInput.hasFocus()) binding.titleInput.requestFocus()
            }
        }
        if (DocBlockDiffUtil.Payload.CURSOR_CHANGED in payloads && item.isFocused && item.cursor != null) {
            binding.titleInput.post {
                val cursor = item.cursor.coerceIn(0, binding.titleInput.text?.length ?: 0)
                binding.titleInput.setSelection(cursor)
            }
        }
    }
}
