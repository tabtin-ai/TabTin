package com.tabtin.mobile.features.doc.editor.interaction

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.FormatBold
import androidx.compose.material.icons.filled.FormatColorText
import androidx.compose.material.icons.filled.Highlight
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.automirrored.filled.FormatIndentDecrease
import androidx.compose.material.icons.automirrored.filled.FormatIndentIncrease
import androidx.compose.material.icons.automirrored.filled.Redo
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.FormatItalic
import androidx.compose.material.icons.filled.FormatStrikethrough
import androidx.compose.material.icons.filled.FormatUnderlined
import androidx.compose.material.icons.filled.Link
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.tabtin.mobile.features.doc.model.InlineMarkKind
import com.tabtin.mobile.ui.components.TTFormDialog

/**
 * 格式按钮定义：图标 + 对应的 InlineMarkKind。
 */
private data class FormatAction(
    val kind: InlineMarkKind,
    val icon: ImageVector,
    val labelRes: Int,
)

private val FORMAT_ACTIONS = listOf(
    FormatAction(InlineMarkKind.BOLD, Icons.Filled.FormatBold, R.string.doc_format_bold),
    FormatAction(InlineMarkKind.ITALIC, Icons.Filled.FormatItalic, R.string.doc_format_italic),
    FormatAction(InlineMarkKind.STRIKE, Icons.Filled.FormatStrikethrough, R.string.doc_format_strikethrough),
    FormatAction(InlineMarkKind.UNDERLINE, Icons.Filled.FormatUnderlined, R.string.doc_format_underline),
    FormatAction(InlineMarkKind.CODE, Icons.Filled.Code, R.string.doc_format_code),
)

/**
 * 格式工具栏 — 显示在编辑器底部（键盘上方）。
 *
 * 提供行内样式切换按钮：粗体(B)、斜体(I)、删除线(S)、下划线(U)、行内代码(</>)、链接(🔗)。
 * 使用 [AnimatedVisibility] 控制显隐动画，从底部滑入/滑出。
 *
 * @param isVisible   是否显示工具栏（通常在文本块获得焦点时为 true）
 * @param activeMarks 当前光标位置已激活的 InlineMark 集合
 * @param onToggleMark 切换某种行内样式
 * @param onInsertLink 插入链接（传入用户输入的 URL）
 * @param modifier    外部 Modifier
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
public fun DocFormatToolbar(
    isVisible: Boolean,
    activeMarks: Set<InlineMarkKind>,
    onToggleMark: (InlineMarkKind) -> Unit,
    onInsertLink: (url: String) -> Unit,
    canUndo: Boolean = false,
    canRedo: Boolean = false,
    onUndo: () -> Unit = {},
    onRedo: () -> Unit = {},
    onIndent: () -> Unit = {},
    onUnindent: () -> Unit = {},
    onMoreActions: () -> Unit = {},
    activeTextColor: String = "",
    activeHighlight: String = "",
    onTextColorClick: () -> Unit = {},
    onHighlightClick: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var showLinkDialog by remember { mutableStateOf(false) }

    if (showLinkDialog) {
        LinkInputDialog(
            onConfirm = { url ->
                showLinkDialog = false
                if (url.isNotBlank()) onInsertLink(url)
            },
            onDismiss = { showLinkDialog = false },
        )
    }

    AnimatedVisibility(
        modifier = modifier.windowInsetsPadding(WindowInsets.ime),
        visible = isVisible,
        enter = slideInVertically(initialOffsetY = { it }),
        exit = slideOutVertically(targetOffsetY = { it }),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            color = MaterialTheme.colorScheme.surface,
            shadowElevation = 2.dp,
        ) {
            Row(
                modifier = Modifier
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                // Undo / Redo
                IconButton(onClick = onUndo, enabled = canUndo) {
                    Icon(
                        Icons.AutoMirrored.Filled.Undo,
                        contentDescription = stringResource(R.string.doc_undo),
                        tint = if (canUndo) MaterialTheme.colorScheme.onSurfaceVariant
                        else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.3f),
                    )
                }
                IconButton(onClick = onRedo, enabled = canRedo) {
                    Icon(
                        Icons.AutoMirrored.Filled.Redo,
                        contentDescription = stringResource(R.string.doc_redo),
                        tint = if (canRedo) MaterialTheme.colorScheme.onSurfaceVariant
                        else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.3f),
                    )
                }

                // Format actions
                FORMAT_ACTIONS.forEach { action ->
                    val isActive = action.kind in activeMarks
                    IconToggleButton(
                        checked = isActive,
                        onCheckedChange = { onToggleMark(action.kind) },
                    ) {
                        Icon(
                            imageVector = action.icon,
                            contentDescription = stringResource(action.labelRes),
                            tint = if (isActive) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                val hasLink = InlineMarkKind.LINK in activeMarks
                IconToggleButton(
                    checked = hasLink,
                    onCheckedChange = { showLinkDialog = true },
                ) {
                    Icon(
                        imageVector = Icons.Filled.Link,
                        contentDescription = stringResource(R.string.doc_format_link),
                        tint = if (hasLink) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                // Text Color
                IconButton(onClick = onTextColorClick) {
                    Box {
                        Icon(
                            Icons.Filled.FormatColorText,
                            contentDescription = stringResource(R.string.doc_text_color_title),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (activeTextColor.isNotBlank()) {
                            val c = try { Color(android.graphics.Color.parseColor(activeTextColor)) } catch (_: Exception) { Color.Transparent }
                            Box(
                                modifier = Modifier
                                    .align(Alignment.BottomCenter)
                                    .offset(y = 2.dp)
                                    .width(16.dp)
                                    .height(3.dp)
                                    .background(c, RoundedCornerShape(1.dp)),
                            )
                        }
                    }
                }

                // Highlight
                IconButton(onClick = onHighlightClick) {
                    Box {
                        Icon(
                            Icons.Filled.Highlight,
                            contentDescription = stringResource(R.string.doc_highlight_title),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (activeHighlight.isNotBlank()) {
                            val c = try { Color(android.graphics.Color.parseColor(activeHighlight)) } catch (_: Exception) { Color.Transparent }
                            Box(
                                modifier = Modifier
                                    .align(Alignment.BottomCenter)
                                    .offset(y = 2.dp)
                                    .width(16.dp)
                                    .height(3.dp)
                                    .background(c, RoundedCornerShape(1.dp)),
                            )
                        }
                    }
                }

                // Indent / Unindent
                IconButton(onClick = onUnindent) {
                    Icon(
                        Icons.AutoMirrored.Filled.FormatIndentDecrease,
                        contentDescription = stringResource(R.string.doc_indent_decrease),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(onClick = onIndent) {
                    Icon(
                        Icons.AutoMirrored.Filled.FormatIndentIncrease,
                        contentDescription = stringResource(R.string.doc_indent_increase),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                // More block actions
                IconButton(onClick = onMoreActions) {
                    Icon(
                        Icons.Filled.MoreVert,
                        contentDescription = stringResource(R.string.common_more),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/**
 * 链接输入对话框 — 供用户输入 URL。
 */
@Composable
private fun LinkInputDialog(
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var url by remember { mutableStateOf("") }

    TTFormDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.doc_link_dialog_title)) },
        text = {
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                placeholder = { Text(stringResource(R.string.doc_link_dialog_url_hint)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(url) },
                enabled = url.isNotBlank(),
            ) {
                Text(stringResource(R.string.doc_link_dialog_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.common_cancel))
            }
        },
    )
}
