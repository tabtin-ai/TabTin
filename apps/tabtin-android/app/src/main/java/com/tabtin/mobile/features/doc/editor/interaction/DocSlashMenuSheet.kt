package com.tabtin.mobile.features.doc.editor.interaction

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import kotlinx.coroutines.launch

/**
 * Slash 命令菜单 — TTBottomSheet 实现。
 *
 * 由 [SlashTextWatcher] 触发显示，用户输入 '/' 后弹出可插入块类型列表。
 * [filter] 由外部 SlashTextWatcher 的 Filter 状态驱动，实时过滤菜单项。
 *
 * @param isVisible 是否显示菜单
 * @param filter    当前的过滤文本（含 '/' 前缀），由 SlashTextWatcherState.Filter 提供
 * @param onItemSelected 用户选中某块类型后的回调
 * @param onDismiss 菜单关闭回调
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun DocSlashMenuSheet(
    isVisible: Boolean,
    filter: String,
    onItemSelected: (BlockKind) -> Unit,
    onDismiss: () -> Unit,
) {
    if (!isVisible) return

    val sheetState = rememberTTSheetState()
    val scope = rememberCoroutineScope()
    val filteredItems = filterSlashMenuItems(filter)

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 32.dp),
        ) {
            Text(
                text = stringResource(R.string.doc_slash_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )

            if (filteredItems.isEmpty()) {
                Text(
                    text = stringResource(R.string.doc_slash_no_result),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 16.dp),
                )
            } else {
                LazyColumn(
                    modifier = Modifier.heightIn(max = 400.dp),
                ) {
                    items(filteredItems, key = { it.blockKind.name }) { item ->
                        SlashMenuRow(item = item) {
                            scope.launch {
                                sheetState.hide()
                                onItemSelected(item.blockKind)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SlashMenuRow(
    item: SlashMenuItem,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = item.icon,
            contentDescription = stringResource(item.titleRes),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(24.dp),
        )
        Spacer(Modifier.width(12.dp))
        Column {
            Text(
                text = stringResource(item.titleRes),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = stringResource(item.subtitleRes),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
