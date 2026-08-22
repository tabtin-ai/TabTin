package com.tabtin.mobile.features.doc.editor.holders

import com.tabtin.mobile.databinding.DocBlockParagraphBinding
import com.tabtin.mobile.features.doc.editor.core.SlashTextWatcherState
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup

/**
 * 段落块 ViewHolder — 最基础的文本块，无额外装饰。
 */
public class ParagraphHolder(
    binding: DocBlockParagraphBinding,
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
    onTextChanged = onTextChanged,
    onEnterPressed = onEnterPressed,
    onEmptyBackspace = onEmptyBackspace,
    onFocusChanged = onFocusChanged,
    onSlashEvent = onSlashEvent,
    onSelectionChanged = onSelectionChanged,
    onBlockLongPress = onBlockLongPress,
)
