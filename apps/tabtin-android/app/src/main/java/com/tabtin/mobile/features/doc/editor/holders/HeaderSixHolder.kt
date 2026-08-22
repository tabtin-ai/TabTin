package com.tabtin.mobile.features.doc.editor.holders

import com.tabtin.mobile.R
import com.tabtin.mobile.databinding.DocBlockHeaderSixBinding
import com.tabtin.mobile.features.doc.editor.core.SlashTextWatcherState
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTViewFontWeight

/** 六级标题块 ViewHolder。 */
public class HeaderSixHolder(
    binding: DocBlockHeaderSixBinding,
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
    typographyRole = TTFonts.Role.CAPTION,
    fontWeight = TTViewFontWeight.SEMIBOLD,
    textColorRes = R.color.doc_editor_text_secondary,
    onTextChanged = onTextChanged,
    onEnterPressed = onEnterPressed,
    onEmptyBackspace = onEmptyBackspace,
    onFocusChanged = onFocusChanged,
    onSlashEvent = onSlashEvent,
    onSelectionChanged = onSelectionChanged,
    onBlockLongPress = onBlockLongPress,
)
