package com.tabtin.mobile.features.conversation

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.view.HapticFeedbackConstants
import android.widget.Toast
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.delay

/**
 * 代码块组件，对齐 Electron `MarkdownRenderer.tsx` 与 iOS `CodeBlockView.swift`：
 *
 * 1. **语法高亮**：通过 [CodeSyntaxHighlighter] 渲染 30+ 主流语言（atom-one 配色，与 iOS 同源）；
 *    未识别语言降级为纯等宽。
 * 2. **复制按钮**：右上角点击 → ClipboardManager + 触觉反馈 + "已复制" 状态 1.6s 自动复位
 *    （与 iOS 行为对齐）。
 * 3. **长代码折叠**：行数 > 50 时折叠，仅显示前 20 行 + "展开剩余 N 行" 按钮，可再次收起。
 *    阈值 50 与预览 20 行均与 iOS `CodeBlockView` 一致。
 *
 * 设计取舍：
 * - 流式期间每次新 chunk 都会重建 AnnotatedString，有性能成本。
 *   [rememberHighlightedCode] 用 (code, language, isDark) 做 remember key 避免在 recomposition
 *   时重复跑。如果发现长代码块流式期间掉帧（>80 行 TS/Kotlin），属 §7 长期治理项：
 *   后续可改为后台线程跑高亮、流式期间走纯等宽，目前对齐 iOS 行为流式也走完整高亮。
 * - 折叠时 hidden 行数用 prefix(20) 与总行数对差；与 iOS 一致。
 */
@Composable
internal fun CodeBlockView(
    code: String,
    language: String?,
    modifier: Modifier = Modifier,
    animateContentSize: Boolean = true,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val isDark = isSystemInDarkTheme()

    val trimmedCode = remember(code) {
        var s = code
        while (s.endsWith("\n")) s = s.dropLast(1)
        s
    }
    // 空代码块不渲染（避免出现一个只有 header + 0 行内容的"空盒子"）
    if (trimmedCode.isEmpty()) return

    val totalLines = remember(trimmedCode) { trimmedCode.count { it == '\n' } + 1 }
    val canCollapse = totalLines > COLLAPSE_THRESHOLD

    // 关键：不要用 `remember(code)` —— 流式期间 code 每个 delta 都会变，
    // 那样会把用户的"展开"操作和"已复制"提示在每一帧都打回默认。
    // LazyColumn 用 message.id 作为 item key 已经保证了不同消息的状态隔离，
    // 这里只需要在同一消息内跨 recomposition 持久化即可。对齐 iOS @State 行为。
    var isExpanded by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }

    val displayCode = remember(trimmedCode, isExpanded, canCollapse) {
        if (!canCollapse || isExpanded) {
            trimmedCode
        } else {
            trimmedCode.lineSequence().take(COLLAPSED_PREVIEW_LINES).joinToString("\n")
        }
    }
    val hiddenLineCount = (totalLines - COLLAPSED_PREVIEW_LINES).coerceAtLeast(0)

    val highlighted = rememberHighlightedCode(displayCode, language, isDark)
    val displayName = remember(language) { CodeSyntaxHighlighter.displayName(language) }

    // 1.6s 后自动重置 copied 状态，与 iOS performCopy 一致
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_600)
            copied = false
        }
    }

    val containerBg = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    val borderColor = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(containerBg)
            .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(8.dp))
            .then(
                if (animateContentSize) {
                    Modifier.animateContentSize(animationSpec = tween(180))
                } else {
                    Modifier
                },
            ),
    ) {
        CodeBlockHeader(
            languageLabel = displayName,
            copied = copied,
            onCopy = {
                // 仅在剪贴板写入成功时才把 copied 状态切换到 true，避免拿不到
                // ClipboardManager 时（极罕见，但 Robolectric / 受限设备会出现）
                // UI 谎报「已复制」（产品 Review P1）。
                if (copyToClipboard(context, trimmedCode)) {
                    // HapticFeedbackConstants.CONFIRM 是 API 30 (R) 才引入；
                    // 老版本（含 26-29）退回 LONG_PRESS，否则 silent fallback
                    // 用户感受不到触觉。
                    val haptic = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        HapticFeedbackConstants.CONFIRM
                    } else {
                        HapticFeedbackConstants.LONG_PRESS
                    }
                    view.performHapticFeedback(haptic)
                    copied = true
                } else {
                    // 写入失败（极罕见，例如 Robolectric / 政企 MDM 限制）必须给
                    // 用户反馈，否则按钮看起来"没反应"。Toast 与本模块其他失败提示
                    // 一致（参考 ConversationView 内多处 widget.Toast）。
                    Toast.makeText(
                        context,
                        context.getString(R.string.chat_code_block_copy_failed),
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            },
            isDark = isDark,
        )

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(0.5.dp)
                .background(borderColor.copy(alpha = 0.4f)),
        )

        SelectionContainer {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(TTSpacing.sm),
            ) {
                Text(
                    text = highlighted,
                    style = TTFonts.codeSM.copy(
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    ),
                    softWrap = false,
                )
            }
        }

        if (canCollapse) {
            CodeBlockExpandToggle(
                isExpanded = isExpanded,
                hiddenLineCount = hiddenLineCount,
                onClick = { isExpanded = !isExpanded },
                isDark = isDark,
            )
        }
    }
}

@Composable
private fun CodeBlockHeader(
    languageLabel: String?,
    copied: Boolean,
    onCopy: () -> Unit,
    isDark: Boolean,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.sm, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!languageLabel.isNullOrEmpty()) {
            Text(
                text = languageLabel,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(0.dp).weight(1f))
        CopyChip(copied = copied, onClick = onCopy, isDark = isDark)
    }
}

@Composable
private fun CopyChip(
    copied: Boolean,
    onClick: () -> Unit,
    isDark: Boolean,
) {
    val accent = ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess)
    val secondary = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    val bg = ttColor(TTColors.Background, TTColors.Dark.Background).copy(alpha = 0.6f)
    val labelCopy = stringResource(R.string.chat_code_block_copy)
    val labelCopied = stringResource(R.string.chat_code_block_copied)

    val a11yLabel = if (copied) labelCopied else labelCopy
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(bg)
            .clickable(
                role = Role.Button,
                onClickLabel = labelCopy,
                onClick = onClick,
            )
            // 用 mergeDescendants 把 icon + text 合成一个语义节点，避免 TalkBack
            // 把「复制」连读两遍（用户视角 Review P2）；同时用 liveRegion.Polite
            // 在 copied 切换时把「已复制」朗读出来（用户视角 Review P1）。
            .semantics(mergeDescendants = true) {
                contentDescription = a11yLabel
                liveRegion = LiveRegionMode.Polite
            }
            // 保证最小可点击高度 ≥ 36dp（用户视角 Review P1：单手 5.5"）。
            // 不直接走 48dp，因为这是 chip 嵌入 header 行内，48dp 会撑大头部布局；
            // 36dp 是 Material chip 与 iOS minimum tap target 的折中。
            .heightIn(min = 36.dp)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            imageVector = if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy,
            contentDescription = null,
            tint = if (copied) accent else secondary,
            modifier = Modifier.size(11.dp),
        )
        Text(
            text = a11yLabel,
            style = TTFonts.caption,
            color = if (copied) accent else secondary,
        )
    }
}

@Composable
private fun CodeBlockExpandToggle(
    isExpanded: Boolean,
    hiddenLineCount: Int,
    onClick: () -> Unit,
    isDark: Boolean,
) {
    val tintColor = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    val toggleBg = ttColor(TTColors.Background, TTColors.Dark.Background).copy(alpha = 0.5f)
    val labelCollapse = stringResource(R.string.chat_code_block_collapse)
    val labelExpand = stringResource(R.string.chat_code_block_expand_remaining, hiddenLineCount)

    val expandLabel = if (isExpanded) labelCollapse else labelExpand
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(toggleBg)
            .clickable(role = Role.Button, onClick = onClick)
            // 触点 ≥ 44dp，与 Material 推荐 + iOS minimum tap target 对齐。
            .heightIn(min = 44.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = expandLabel
            }
            .padding(vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(
                imageVector = if (isExpanded) Icons.Filled.KeyboardArrowUp
                              else Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = tintColor,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = if (isExpanded) labelCollapse else labelExpand,
                style = TTFonts.caption,
                color = tintColor,
            )
        }
    }
}

/** 写入剪贴板；成功返回 true，拿不到 ClipboardManager 或写入抛异常返回 false。 */
private fun copyToClipboard(context: Context, text: String): Boolean {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        ?: return false
    return runCatching {
        cm.setPrimaryClip(ClipData.newPlainText("code", text))
        true
    }.getOrDefault(false)
}

/** 折叠阈值，与 iOS [CodeBlockView] / Electron MarkdownRenderer 一致 */
private const val COLLAPSE_THRESHOLD = 50
/** 折叠时显示的预览行数，与 iOS 一致 */
private const val COLLAPSED_PREVIEW_LINES = 20
