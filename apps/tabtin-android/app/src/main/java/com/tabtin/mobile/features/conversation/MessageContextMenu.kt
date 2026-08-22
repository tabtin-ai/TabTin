package com.tabtin.mobile.features.conversation

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.view.HapticFeedbackConstants
import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.ttColor

/**
 * Wave 4 A1 / S2-A2 — 消息长按上下文菜单 wrapper。
 *
 * 为什么还需要 wrapper：
 *   ChatBubble 自身现在负责助手消息的「复制 + 回滚」菜单；用户消息没有内建菜单，
 *   这里作为 ConversationView → ChatBubble 的外层操作层，只处理 user message 的
 *   「复制 / 编辑后重发」。
 *
 * **行为**：
 *   - 用户消息：长按 → 弹「复制 / 编辑后重发」菜单；
 *   - 助手消息：由 ChatBubble 自身菜单处理复制 + 回滚，避免嵌套长按抢手势；
 *   - 系统消息走另一个分支（[SystemMessageBubble]），不通过本 wrapper；
 *   - 复制走 ClipboardManager.setPrimaryClip + 触觉反馈 + Toast 提示，与
 *     [CodeBlockView] 的复制行为同语义。
 *
 * **TalkBack 可达性**：onLongClickLabel 在长按手势上注入语义标签，让屏幕阅读器
 *   能念出「长按：消息操作」。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun MessageContextMenuHost(
    message: ChatMessage,
    onEdit: (messageId: String) -> Unit,
    canEditMessage: Boolean = true,
    // Wave 6 A3：从此用户消息 Fork 出新会话。对齐 iOS `ConversationScreen.contextMenu` forkSession。
    // null 时菜单不渲染 Fork 项；非 null 则追加到菜单底部（复制之后，不抢 Edit 主操作位）。
    onForkFromMessage: (() -> Unit)? = null,
    onQuoteMessage: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    var showMenu by remember(message.id) { mutableStateOf(false) }
    val context = LocalContext.current
    val view = LocalView.current
    val interactionSource = remember(message.id) { MutableInteractionSource() }

    // 复制反馈对应字符串先在 Composable scope 解析，避免回调内 Context 取
    val copySuccessMsg = stringResource(R.string.chat_message_copied)
    val copyFailMsg = stringResource(R.string.chat_message_copy_failed)

    val canEdit = canEditMessage && message.isUser && !message.isStreaming
    val displayContent = message.displayContent
    // 仅允许对已持久化（有 createdAt）且非流式的消息 fork；与 editing 的同口径，避免对
    // 未落库的本地临时消息调后端 fork（会 404）。
    val canFork = onForkFromMessage != null && !message.isStreaming && message.createdAt != null

    fun copyMessage() {
        if (copyMessageToClipboard(context, displayContent)) {
            val haptic = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                HapticFeedbackConstants.CONFIRM
            } else {
                HapticFeedbackConstants.LONG_PRESS
            }
            view.performHapticFeedback(haptic)
            Toast.makeText(context, copySuccessMsg, Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(context, copyFailMsg, Toast.LENGTH_SHORT).show()
        }
    }

    val canQuote = onQuoteMessage != null && MessageQuote.payload(message) != null
    val longPressEnabled = displayContent.isNotEmpty() || canEdit || canFork || canQuote

    Box(
        modifier = modifier
            .fillMaxWidth()
            .combinedClickable(
                interactionSource = interactionSource,
                onClick = {},
                onLongClick = {
                    if (longPressEnabled) {
                        showMenu = true
                    }
                },
                onLongClickLabel = if (longPressEnabled) {
                    // 用泛化"消息操作"取代固定"复制消息"——菜单可能含编辑（user）+复制 + Fork，
                    // 让 TalkBack 念出来与实际菜单可用动作一致。
                    stringResource(R.string.chat_message_action_label)
                } else null,
            ),
    ) {
        content()

        Box(
            modifier = Modifier.align(
                if (message.isUser) Alignment.TopEnd else Alignment.TopStart,
            ),
        ) {
            DropdownMenu(
                expanded = showMenu,
                onDismissRequest = { showMenu = false },
            ) {
                // user 消息：Edit 在上（用户长按自己的消息更可能是要改）；复制在下做兜底。
                // assistant 消息：只显示复制（canEdit 为 false）。
                if (canEdit) {
                    DropdownMenuItem(
                        text = {
                            Row {
                                Icon(
                                    Icons.Default.Edit,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                    tint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    stringResource(R.string.chat_message_action_edit),
                                    style = TTFonts.body,
                                )
                            }
                        },
                        onClick = {
                            showMenu = false
                            onEdit(message.id)
                        },
                    )
                }
                if (displayContent.isNotEmpty()) {
                    DropdownMenuItem(
                        text = {
                            Row {
                                Icon(
                                    Icons.Default.ContentCopy,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                    tint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    stringResource(R.string.chat_message_action_copy),
                                    style = TTFonts.body,
                                )
                            }
                        },
                        onClick = {
                            showMenu = false
                            copyMessage()
                        },
                    )
                }
                if (canQuote) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.chat_message_action_quote), style = TTFonts.body) },
                        onClick = { showMenu = false; onQuoteMessage() },
                    )
                }
                // Wave 6 A3：用户消息的 Fork 菜单项（对齐 iOS）。放在最后——用户主流程是"继续
                // 对话"或"编辑"，fork 是偶发分叉动作，不该抢主位。
                if (canFork) {
                    DropdownMenuItem(
                        text = {
                            Row {
                                Icon(
                                    Icons.AutoMirrored.Filled.CallSplit,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                    tint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    stringResource(R.string.chat_message_action_fork),
                                    style = TTFonts.body,
                                )
                            }
                        },
                        onClick = {
                            showMenu = false
                            onForkFromMessage.invoke()
                        },
                    )
                }
            }
        }
    }
}

/**
 * 写入剪贴板；失败返回 false 让 UI 给出反馈，不要默默吞掉。
 * 与 [CodeBlockView.copyToClipboard] 同实现，保留独立函数避免跨模块依赖。
 */
private fun copyMessageToClipboard(context: Context, text: String): Boolean {
    if (text.isEmpty()) return false
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        ?: return false
    return runCatching {
        cm.setPrimaryClip(ClipData.newPlainText("chat-message", text))
        true
    }.getOrDefault(false)
}
