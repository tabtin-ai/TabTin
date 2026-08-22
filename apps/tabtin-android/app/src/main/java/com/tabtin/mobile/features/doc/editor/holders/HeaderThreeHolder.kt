package com.tabtin.mobile.features.doc.editor.holders

import com.tabtin.mobile.databinding.DocBlockHeaderThreeBinding
import com.tabtin.mobile.features.doc.editor.core.SlashTextWatcherState
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTViewFontWeight

/**
 * 三级标题块 ViewHolder。
 */
public class HeaderThreeHolder(
    binding: DocBlockHeaderThreeBinding,
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
    typographyRole = TTFonts.Role.SUBTITLE,
    fontWeight = TTViewFontWeight.SEMIBOLD,
    onTextChanged = onTextChanged,
    onEnterPressed = onEnterPressed,
    onEmptyBackspace = onEmptyBackspace,
    onFocusChanged = onFocusChanged,
    onSlashEvent = onSlashEvent,
    onSelectionChanged = onSelectionChanged,
    onBlockLongPress = onBlockLongPress,
)
