package com.tabtin.mobile.features.doc.editor.interaction

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.automirrored.filled.Comment
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.FileCopy
import androidx.compose.material.icons.filled.SwapVert
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun BlockActionMenuSheet(
    blockKind: BlockKind?,
    isFirst: Boolean,
    isLast: Boolean,
    isBlockEditable: Boolean = true,
    canDeleteWholeBlock: Boolean = isBlockEditable,
    onDelete: () -> Unit,
    onDuplicate: () -> Unit,
    onCopyText: () -> Unit,
    onTurnInto: (BlockKind) -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onSelect: () -> Unit = {},
    onAddComment: () -> Unit = {},
    canAddComment: Boolean = false,
    onDismiss: () -> Unit,
) {
    var showTurnInto by remember { mutableStateOf(false) }
    val sheetState = rememberTTSheetState()
    val visibility = blockActionMenuVisibility(
        blockKind = blockKind,
        isBlockEditable = isBlockEditable,
        canDeleteWholeBlock = canDeleteWholeBlock,
        canAddComment = canAddComment,
    )

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        if (showTurnInto) {
            TurnIntoContent(
                currentKind = blockKind,
                onBack = { showTurnInto = false },
                onSelect = { kind ->
                    showTurnInto = false
                    onTurnInto(kind)
                },
            )
        } else {
            ActionListContent(
                visibility = visibility,
                isFirst = isFirst,
                isLast = isLast,
                onDelete = onDelete,
                onDuplicate = onDuplicate,
                onCopyText = onCopyText,
                onTurnInto = { showTurnInto = true },
                onMoveUp = onMoveUp,
                onMoveDown = onMoveDown,
                onSelect = onSelect,
                onAddComment = onAddComment,
            )
        }
    }
}

internal data class BlockActionMenuVisibility(
    val showDelete: Boolean,
    val showDuplicate: Boolean,
    val showCopyText: Boolean,
    val showTurnInto: Boolean,
    val showSelect: Boolean,
    val showAddComment: Boolean,
)

/**
 * 块菜单只消费显式能力，不再用「内容可编辑」代替「整块可删除」。
 * 因此已有图片可显示删除/选择，但不会意外开放复制、文本复制或转换。
 */
internal fun blockActionMenuVisibility(
    blockKind: BlockKind?,
    isBlockEditable: Boolean,
    canDeleteWholeBlock: Boolean,
    canAddComment: Boolean = false,
): BlockActionMenuVisibility {
    val hasText = blockKind?.isEditable == true
    return BlockActionMenuVisibility(
        showDelete = canDeleteWholeBlock,
        showDuplicate = isBlockEditable,
        showCopyText = hasText,
        showTurnInto = isBlockEditable && hasText,
        showSelect = canDeleteWholeBlock,
        showAddComment = canAddComment,
    )
}

@Composable
private fun ActionListContent(
    visibility: BlockActionMenuVisibility,
    isFirst: Boolean,
    isLast: Boolean,
    onDelete: () -> Unit,
    onDuplicate: () -> Unit,
    onCopyText: () -> Unit,
    onTurnInto: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onSelect: () -> Unit = {},
    onAddComment: () -> Unit = {},
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 24.dp),
    ) {
        Text(
            text = stringResource(R.string.doc_block_action_title),
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
        )
        HorizontalDivider()
        if (visibility.showAddComment) {
            ActionRow(
                Icons.AutoMirrored.Filled.Comment,
                stringResource(R.string.doc_block_action_add_comment),
                onClick = onAddComment,
            )
        }
        if (visibility.showDelete) {
            ActionRow(Icons.Filled.Delete, stringResource(R.string.doc_block_action_delete), onClick = onDelete, tint = MaterialTheme.colorScheme.error)
        }
        if (visibility.showDuplicate) {
            ActionRow(Icons.Filled.FileCopy, stringResource(R.string.doc_block_action_duplicate), onClick = onDuplicate)
        }
        if (visibility.showCopyText) {
            ActionRow(Icons.Filled.ContentCopy, stringResource(R.string.doc_block_action_copy_text), onClick = onCopyText)
        }
        if (visibility.showTurnInto) {
            ActionRow(Icons.Filled.SwapVert, stringResource(R.string.doc_block_action_turn_into), onClick = onTurnInto)
        }
        HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
        ActionRow(Icons.Filled.ArrowUpward, stringResource(R.string.doc_block_action_move_up), onClick = onMoveUp, enabled = !isFirst)
        ActionRow(Icons.Filled.ArrowDownward, stringResource(R.string.doc_block_action_move_down), onClick = onMoveDown, enabled = !isLast)
        HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
        if (visibility.showSelect) {
            ActionRow(Icons.Filled.CheckBox, stringResource(R.string.doc_block_action_select), onClick = onSelect)
        }
    }
}

@Composable
private fun ActionRow(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    tint: Color = MaterialTheme.colorScheme.onSurface,
    enabled: Boolean = true,
) {
    val effectiveTint = if (enabled) tint else tint.copy(alpha = 0.38f)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = effectiveTint,
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.width(16.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = effectiveTint,
        )
    }
}

private data class TurnIntoOption(val kind: BlockKind, val labelRes: Int)

private val TURN_INTO_OPTIONS = listOf(
    TurnIntoOption(BlockKind.PARAGRAPH, R.string.doc_slash_text),
    TurnIntoOption(BlockKind.HEADING1, R.string.doc_slash_heading1),
    TurnIntoOption(BlockKind.HEADING2, R.string.doc_slash_heading2),
    TurnIntoOption(BlockKind.HEADING3, R.string.doc_slash_heading3),
    TurnIntoOption(BlockKind.BULLET_ITEM, R.string.doc_slash_bullet),
    TurnIntoOption(BlockKind.ORDERED_ITEM, R.string.doc_slash_ordered),
    TurnIntoOption(BlockKind.TODO_ITEM, R.string.doc_slash_todo),
    TurnIntoOption(BlockKind.BLOCKQUOTE, R.string.doc_slash_quote),
    TurnIntoOption(BlockKind.CODE_BLOCK, R.string.doc_slash_code),
)

@Composable
private fun TurnIntoContent(
    currentKind: BlockKind?,
    onBack: () -> Unit,
    onSelect: (BlockKind) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 24.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 4.dp, end = 20.dp, top = 4.dp, bottom = 4.dp),
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
            }
            Text(
                text = stringResource(R.string.doc_block_action_turn_into),
                style = MaterialTheme.typography.titleSmall,
            )
        }
        HorizontalDivider()
        Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
            TURN_INTO_OPTIONS.forEach { option ->
                val isCurrent = option.kind == currentKind
                val textColor = if (isCurrent) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurface
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .then(if (isCurrent) Modifier else Modifier.clickable { onSelect(option.kind) })
                        .padding(horizontal = 20.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = stringResource(option.labelRes),
                        style = MaterialTheme.typography.bodyLarge,
                        color = textColor,
                        modifier = Modifier.weight(1f),
                    )
                    if (isCurrent) {
                        Icon(
                            Icons.Filled.Check,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
        }
    }
}
