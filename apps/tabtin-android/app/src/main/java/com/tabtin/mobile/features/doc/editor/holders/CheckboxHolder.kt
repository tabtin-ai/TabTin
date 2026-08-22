package com.tabtin.mobile.features.doc.editor.holders

import com.tabtin.mobile.databinding.DocBlockCheckboxBinding
import com.tabtin.mobile.features.doc.expandListMarkerHitTarget
import com.tabtin.mobile.features.doc.editor.core.SlashTextWatcherState
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * 待办事项块 ViewHolder。
 * checkbox 为 ImageView + state_activated selector，通过 isActivated 控制勾选状态。
 */
public class CheckboxHolder(
    private val binding: DocBlockCheckboxBinding,
    onTextChanged: (String, String, List<TabDocMarkup.Mark>) -> Unit,
    onEnterPressed: (String, IntRange) -> Unit,
    onEmptyBackspace: (String) -> Unit,
    onFocusChanged: (String) -> Unit,
    onSlashEvent: (String, SlashTextWatcherState) -> Unit,
    onSelectionChanged: (String, IntRange) -> Unit,
    private val onCheckChanged: (id: String, isChecked: Boolean) -> Unit,
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

    private var currentId: String = ""

    init {
        binding.checkbox.setOnClickListener {
            val newState = !binding.checkbox.isActivated
            binding.checkbox.isActivated = newState
            onCheckChanged(currentId, newState)
        }
    }

    override fun bind(item: TabDocBlockView.Text) {
        super.bind(item)
        if (item is TabDocBlockView.Text.Checkbox) {
            currentId = item.id
            binding.checkbox.isActivated = item.isChecked
        }
        binding.checkbox.expandListMarkerHitTarget()
    }

    override fun setReadOnly(readOnly: Boolean) {
        super.setReadOnly(readOnly)
        binding.checkbox.isEnabled = !readOnly
    }

    override fun processPayload(item: TabDocBlockView, payloads: Set<Int>) {
        super.processPayload(item, payloads)
        if (item is TabDocBlockView.Text.Checkbox
            && DocBlockDiffUtil.Payload.CHECKED_CHANGED in payloads
        ) {
            currentId = item.id
            binding.checkbox.isActivated = item.isChecked
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
