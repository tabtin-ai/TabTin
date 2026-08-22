package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Wave 4 S2/A2 — 用户消息编辑模式（对齐 Electron `UserMessageEditMode.tsx`）。
 *
 * 行为：
 *  - 进入：原 user bubble 替换为 textarea + Cancel/Send 按钮；
 *  - 焦点：自动 request focus + 弹键盘 + 光标到末尾；
 *  - 提交：trimmed 非空才进入影响预览；用户确认且时间线重写成功后才清空编辑态并重发；
 *  - 媒体：原始非文本 blocks（image/file/doc_selection 等）展示数量提示，告诉用户它们会保留。
 *
 * 与 Electron 的差异（产品决策记入注释，不在 UI 暴露）：
 *  - 不做 Mac/Win 快捷键提示——移动端用户没有 ⌘+Enter 习惯；
 *  - 不展示原 attachment 的具体 filename 列表（屏幕窄）——只用计数。
 */
@Composable
internal fun UserMessageEditMode(
    initialContent: String,
    keptBlocks: List<BlockItem>,
    isSubmitting: Boolean,
    onCancel: () -> Unit,
    onSubmit: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    // 真实用户视角 Review：旋转屏幕 / 进程被回收时草稿不能丢——用 rememberSaveable +
    // String saver（TextFieldValue 自身不可序列化，但单 String 可以；光标位置丢失对编辑
    // 短消息影响小，对齐 Compose 1.6 推荐做法）。
    var draft by rememberSaveable(initialContent) { mutableStateOf(initialContent) }
    var textValue by remember(initialContent) {
        // 初次构建：把 saved draft 用作内容、光标置末。后续编辑里 textValue 是 source of truth，
        //   draft 仅作 saver 通道；onValueChange 同步两者。
        mutableStateOf(TextFieldValue(draft, TextRange(draft.length)))
    }
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        focusRequester.requestFocus()
        // 给 IME 留一点时间——本地测试发现立刻 show 偶发不弹（Compose 1.6 的已知行为）。
        delay(100)
        keyboardController?.show()
    }

    val nonTextBlocks = keptBlocks.filter { it.type != null && it.type != "text" }
    val borderColor = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    val bgColor = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    val textColor = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)

    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
    ) {
        Spacer(Modifier.width(40.dp))
        Column(
            modifier = Modifier
                .weight(1f)
                .clip(TTRadius.Shapes.md)
                .background(bgColor)
                .border(0.5.dp, borderColor, TTRadius.Shapes.md)
                .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.sm),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            horizontalAlignment = Alignment.End,
        ) {
            // 进入编辑后先说明会预览对话 / 文件 / 资源影响，避免用户把时间线重写
            // 理解成普通追加消息，也避免执行完成后才第一次得知文件会被恢复。
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Default.Edit,
                    contentDescription = null,
                    modifier = Modifier.size(12.dp),
                    tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
                Spacer(Modifier.width(TTSpacing.xxs))
                Text(
                    stringResource(R.string.chat_message_edit_hint),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }

            if (nonTextBlocks.isNotEmpty()) {
                Text(
                    stringResource(R.string.chat_message_edit_attachments_kept, nonTextBlocks.size),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 40.dp, max = 240.dp),
            ) {
                if (textValue.text.isEmpty()) {
                    Text(
                        stringResource(R.string.chat_message_edit_placeholder),
                        style = ConversationTypography.body,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                }
                BasicTextField(
                    value = textValue,
                    onValueChange = {
                        textValue = it
                        draft = it.text
                    },
                    textStyle = LocalTextStyle.current.merge(ConversationTypography.body.copy(color = textColor)),
                    cursorBrush = SolidColor(textColor),
                    enabled = !isSubmitting,
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequester),
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                TextButton(
                    onClick = { if (!isSubmitting) onCancel() },
                    enabled = !isSubmitting,
                ) {
                    Text(
                        stringResource(R.string.chat_message_edit_cancel),
                        style = TTFonts.captionSemibold,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    )
                }
                Spacer(Modifier.width(TTSpacing.xs))
                Button(
                    onClick = {
                        if (isSubmitting) return@Button
                        scope.launch { onSubmit(textValue.text.trim()) }
                    },
                    enabled = !isSubmitting && textValue.text.trim().isNotEmpty(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                        contentColor = Color.White,
                    ),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        horizontal = TTSpacing.md,
                        vertical = TTSpacing.xxs,
                    ),
                ) {
                    Text(
                        stringResource(R.string.chat_message_edit_send),
                        style = TTFonts.captionSemibold,
                        color = LocalContentColor.current,
                    )
                }
            }
        }
    }
}
