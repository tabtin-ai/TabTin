package com.tabtin.mobile.features.doc.editor.holders

import android.text.Editable
import com.tabtin.mobile.databinding.DocBlockCodeBinding
import com.tabtin.mobile.features.doc.editor.core.CodeSyntaxHighlighter
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.editor.core.TextInputTextWatcher
import com.tabtin.mobile.features.doc.editor.interaction.CODE_LANGUAGES
import com.tabtin.mobile.features.doc.editor.interaction.normalizeLanguageKey

/**
 * 代码块 ViewHolder。
 * textContent 同样是 DocTextInputWidget，bind 时需锁定 watcher。
 */
public class CodeHolder(
    private val binding: DocBlockCodeBinding,
    private val onTextChanged: (id: String, text: String) -> Unit,
    private val onEmptyBackspace: (id: String) -> Unit,
    private val onFocusChanged: (id: String) -> Unit,
    private val onBlockLongPress: (id: String) -> Unit = {},
    private val onLanguageMenuClick: (id: String) -> Unit = {},
) : DocBlockViewHolder(binding.root) {

    private var blockId: String = ""
    private var currentLanguage: String = ""
    private val highlightRunnable = Runnable {
        binding.textContent.text?.let { editable ->
            binding.textContent.pauseTextWatchers {
                CodeSyntaxHighlighter.highlight(editable, currentLanguage)
            }
        }
    }

    init {
        binding.textContent.addTextChangedListener(object : TextInputTextWatcher {
            private var locked = false
            override fun lock() { locked = true }
            override fun unlock() { locked = false }
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (locked) return
                val text = s?.toString() ?: return
                onTextChanged(blockId, text)
                scheduleHighlight()
            }
        })

        binding.textContent.onBackspaceAtStart = { onEmptyBackspace(blockId) }

        binding.textContent.setOnFocusChangeListener { _, hasFocus ->
            if (hasFocus) {
                onFocusChanged(blockId)
                binding.textContent.isCursorVisible = true
            }
        }

        binding.textContent.editorTouchProcessor.onLongClick = {
            onBlockLongPress(blockId)
        }

        binding.languageMenu.setOnClickListener {
            onLanguageMenuClick(blockId)
        }
    }

    private fun applyCodeFocusability(isSelected: Boolean) {
        if (isSelected) {
            binding.textContent.isFocusable = false
            binding.textContent.isFocusableInTouchMode = false
            if (binding.textContent.hasFocus()) binding.textContent.clearFocus()
        } else {
            binding.textContent.isFocusable = true
            binding.textContent.isFocusableInTouchMode = true
        }
    }

    override fun setReadOnly(readOnly: Boolean) {
        if (readOnly) {
            binding.textContent.clearFocus()
            binding.textContent.enableReadMode()
        } else {
            binding.textContent.enableEditMode()
        }
        binding.languageMenu.isEnabled = !readOnly
    }

    override fun onRecycled() {
        binding.textContent.removeCallbacks(highlightRunnable)
    }

    override fun setupDrag(startDrag: () -> Unit) {
        binding.textContent.editorTouchProcessor.onDragAndDropTrigger = { _ -> startDrag() }
    }

    private fun resolveLanguageLabel(raw: String): String {
        if (raw.isBlank()) {
            return binding.root.context.getString(com.tabtin.mobile.R.string.doc_code_language_plain)
        }
        val normalized = normalizeLanguageKey(raw)
        val match = CODE_LANGUAGES.find { it.key == normalized }
        return if (match != null) binding.root.context.getString(match.labelRes) else raw
    }

    private fun scheduleHighlight() {
        binding.textContent.removeCallbacks(highlightRunnable)
        binding.textContent.postDelayed(highlightRunnable, 150)
    }

    override fun bind(item: TabDocBlockView) {
        val code = item as? TabDocBlockView.Code ?: return
        blockId = code.id
        currentLanguage = code.language

        binding.textContent.pauseTextWatchers {
            binding.textContent.setText(code.body)
            binding.textContent.text?.let { CodeSyntaxHighlighter.highlight(it, currentLanguage) }
        }
        binding.languageMenu.text = resolveLanguageLabel(code.language)
        applySelectionState(code.isSelected)
        applyCodeFocusability(code.isSelected)

        if (code.isFocused) {
            binding.textContent.post {
                if (!binding.textContent.hasFocus()) binding.textContent.requestFocus()
                val cursor = code.cursor
                    ?.coerceIn(0, binding.textContent.text?.length ?: 0)
                    ?: (binding.textContent.text?.length ?: 0)
                binding.textContent.setSelection(cursor)
            }
        }
    }

    override fun processPayload(item: TabDocBlockView, payloads: Set<Int>) {
        if (item !is TabDocBlockView.Code) { bind(item); return }
        blockId = item.id
        currentLanguage = item.language

        if (DocBlockDiffUtil.Payload.TEXT_CHANGED in payloads) {
            binding.textContent.pauseTextWatchers {
                val current = binding.textContent.text?.toString() ?: ""
                if (current != item.body) {
                    binding.textContent.setText(item.body)
                }
                binding.textContent.text?.let { CodeSyntaxHighlighter.highlight(it, currentLanguage) }
            }
        }
        if (DocBlockDiffUtil.Payload.LANGUAGE_CHANGED in payloads) {
            binding.languageMenu.text = resolveLanguageLabel(item.language)
            binding.textContent.pauseTextWatchers {
                binding.textContent.text?.let { CodeSyntaxHighlighter.highlight(it, currentLanguage) }
            }
        }
        if (DocBlockDiffUtil.Payload.SELECTION_CHANGED in payloads) {
            applySelectionState(item.isSelected)
            applyCodeFocusability(item.isSelected)
        }
        if (DocBlockDiffUtil.Payload.FOCUS_CHANGED in payloads && item.isFocused) {
            binding.textContent.post {
                if (!binding.textContent.hasFocus()) binding.textContent.requestFocus()
                binding.textContent.isCursorVisible = true
            }
        }
    }
}
