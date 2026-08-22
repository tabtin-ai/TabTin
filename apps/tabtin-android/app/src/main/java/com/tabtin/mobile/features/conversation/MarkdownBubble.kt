package com.tabtin.mobile.features.conversation

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.MarkdownTypography
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.rememberReduceMotion
import com.tabtin.mobile.ui.theme.ttColor

@Composable
internal fun MarkdownBubble(
    content: String,
    isStreaming: Boolean = false,
    modifier: Modifier = Modifier,
) {
    SelectionContainer {
        Column(
            modifier = modifier
                .padding(vertical = TTSpacing.xs)
                .padding(end = TTSpacing.sm),
        ) {
            if (content.isNotEmpty() || isStreaming) {
                ContinuityMarkdownText(
                    content = content,
                    isStreaming = isStreaming,
                )
            }
        }
    }
}

@Composable
internal fun StreamingMarkdownBubble(
    content: String,
    modifier: Modifier = Modifier,
) {
    MarkdownBubble(content = content, isStreaming = true, modifier = modifier)
}

/**
 * 流式才切：稳定区冻住 Markdown，尾巴用 Text。
 * 收束沿用上一帧稳定区身份，只把尾巴转正；对不上再整段 Markdown。
 */
@Composable
private fun ContinuityMarkdownText(
    content: String,
    isStreaming: Boolean,
    modifier: Modifier = Modifier,
) {
    val lastStreamingStable = remember { mutableStateOf("") }
    val layout = StreamingMarkdownContinuityPolicy.layout(
        content = content,
        isStreaming = isStreaming,
        lastStreamingStable = lastStreamingStable.value,
    )
    SideEffect {
        if (isStreaming) {
            lastStreamingStable.value = layout.stable
        }
    }

    Column(modifier = modifier) {
        if (layout.hasStable) {
            key(layout.stableIdentity) {
                Markdown(
                    content = layout.stable,
                    colors = TabTinMarkdownTheme.colors(),
                    typography = TabTinMarkdownTheme.typography(),
                    padding = TabTinMarkdownTheme.padding(),
                    dimens = TabTinMarkdownTheme.dimens(),
                    components = TabTinMarkdownTheme.components(animateCodeBlockSize = false),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        if (layout.tail.isNotEmpty() || isStreaming) {
            if (layout.tailRenderer == StreamingMarkdownContinuityPolicy.TailRenderer.PlainText ||
                layout.tail.isEmpty()
            ) {
                StreamingPlainTail(tail = layout.tail, isStreaming = isStreaming)
            } else {
                Markdown(
                    content = layout.tail,
                    colors = TabTinMarkdownTheme.colors(),
                    typography = TabTinMarkdownTheme.typography(),
                    padding = TabTinMarkdownTheme.padding(),
                    dimens = TabTinMarkdownTheme.dimens(),
                    components = TabTinMarkdownTheme.components(animateCodeBlockSize = false),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

private const val STREAMING_CARET_ID = "streaming-caret"

@Composable
private fun StreamingPlainTail(
    tail: String,
    isStreaming: Boolean,
) {
    val reduceMotion = rememberReduceMotion()
    var previousTail by remember { mutableStateOf("") }
    val reveal = remember(tail) {
        StreamingTailRevealPolicy.reveal(previousTail, tail)
    }
    SideEffect {
        previousTail = tail
    }

    val incomingAlpha = remember { Animatable(1f) }
    LaunchedEffect(reveal.incoming, reveal.shouldAnimateIncoming, reduceMotion) {
        if (reveal.shouldAnimateIncoming && !reduceMotion) {
            incomingAlpha.snapTo(StreamingTailRevealPolicy.INCOMING_START_ALPHA)
            incomingAlpha.animateTo(
                targetValue = 1f,
                animationSpec = tween(StreamingTailRevealPolicy.INCOMING_FADE_MS),
            )
        } else {
            incomingAlpha.snapTo(1f)
        }
    }

    val infiniteTransition = rememberInfiniteTransition(label = "streamingCaret")
    val blinkingCaret by infiniteTransition.animateFloat(
        initialValue = 1f,
        targetValue = 0f,
        animationSpec = infiniteRepeatable(
            animation = tween(StreamingTailRevealPolicy.CARET_BLINK_MS),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "caretAlpha",
    )
    val caretAlpha = when {
        !isStreaming -> 0f
        reduceMotion -> 1f
        else -> blinkingCaret
    }

    val textColor = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    val caretColor = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent)
    val annotated = buildAnnotatedString {
        append(reveal.prefix)
        if (reveal.incoming.isNotEmpty()) {
            withStyle(SpanStyle(color = textColor.copy(alpha = incomingAlpha.value))) {
                append(reveal.incoming)
            }
        }
        if (isStreaming) {
            appendInlineContent(STREAMING_CARET_ID)
        }
    }
    val inlineContent = if (isStreaming) {
        mapOf(
            STREAMING_CARET_ID to InlineTextContent(
                Placeholder(
                    width = 2.sp,
                    height = ConversationTypography.BODY_SIZE_SP.sp,
                    placeholderVerticalAlign = PlaceholderVerticalAlign.TextCenter,
                ),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(RoundedCornerShape(1.dp))
                        .background(caretColor.copy(alpha = caretAlpha)),
                )
            },
        )
    } else {
        emptyMap()
    }

    Text(
        text = annotated,
        inlineContent = inlineContent,
        style = ConversationTypography.body,
        color = textColor,
    )
}

/**
 * 系统消息（[ChatMessage.isSystem]）的居中胶囊样式，对齐 iOS [MarkdownBubble].systemBubble
 * 与 Electron MessageBubble 系统通知分支：
 *
 * - 圆角矩形（不用 Capsule，避免多行被切到字 —— 对应 iOS 遗留项 V3）
 * - 信息图标 + Markdown 文本（采用与正文区分的偏小字号 + 次要色）
 * - 两侧 24dp 留白与 iOS `Spacer(minLength: 24)` 对齐，与左对齐的助手消息明显区分
 * - SelectionContainer 包裹保留可选中文本能力，与 iOS textSelection 一致
 *
 * 调用方应在父级（如 ConversationView）按 `message.isSystem` 单独分支调用本组件，
 * 不要走 ChatBubble.kt（后者目前存在 pre-existing 编译错误，不在本 Wave 范围）。
 */
@Composable
internal fun SystemMessageBubble(
    message: ChatMessage,
    modifier: Modifier = Modifier,
) {
    val noticeLabel = stringResource(R.string.chat_system_notice)
    val bgColor = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    val borderColor = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    val iconTint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.xxl, vertical = TTSpacing.xs)
            // 用 mergeDescendants = true 把 icon + 通知正文合并，让 TalkBack 念出
            // 「系统通知，<具体内容>」而不是只念外层 contentDescription 后吞掉子节点。
            // 这是用户视角 Review P0 的修正。
            .semantics(mergeDescendants = true) {
                contentDescription = "$noticeLabel: ${message.displayContent}"
            },
        horizontalArrangement = Arrangement.Center,
    ) {
        Row(
            modifier = Modifier
                .widthIn(max = 360.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(bgColor)
                .border(0.5.dp, borderColor, RoundedCornerShape(16.dp))
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        ) {
            Icon(
                imageVector = Icons.Filled.Info,
                contentDescription = null,
                tint = iconTint,
                modifier = Modifier
                    .padding(top = 2.dp)
                    .height(14.dp)
                    .width(14.dp),
            )
            // 系统通知用紧凑主题（去掉 heading / blockquote 大块结构），文字略小且偏次要色。
            // 套 SelectionContainer 保持与 iOS systemBubble 一致的"可选中文本"行为。
            SelectionContainer {
                Markdown(
                    content = message.displayContent.ifEmpty { " " },
                    colors = TabTinMarkdownTheme.colors(),
                    typography = SystemNoticeTheme.typography(),
                    padding = SystemNoticeTheme.padding(),
                    dimens = TabTinMarkdownTheme.dimens(),
                    components = TabTinMarkdownTheme.components(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/**
 * 后台任务完成通知：对齐 Electron PushNotificationBubble / iOS pushNotificationNotice。
 * 展示一句话摘要，绝不裸显 `<task-notification>` XML。
 */
@Composable
internal fun PushNotificationBubble(
    message: ChatMessage,
    modifier: Modifier = Modifier,
) {
    val noticeLabel = stringResource(R.string.chat_system_notice)
    val summary = message.pushNotificationSummary
    val bgColor = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    val borderColor = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    val iconTint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    val labelColor = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    val bodyColor = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.xxl, vertical = TTSpacing.xs)
            .semantics(mergeDescendants = true) {
                contentDescription = "$noticeLabel: $summary"
            },
        horizontalArrangement = Arrangement.Center,
    ) {
        Row(
            modifier = Modifier
                .widthIn(max = 360.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(bgColor)
                .border(0.5.dp, borderColor, RoundedCornerShape(16.dp))
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        ) {
            Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = null,
                tint = iconTint,
                modifier = Modifier
                    .padding(top = 2.dp)
                    .height(14.dp)
                    .width(14.dp),
            )
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = noticeLabel,
                    style = TTFonts.caption,
                    color = labelColor,
                )
                Text(
                    text = summary,
                    style = TTFonts.caption,
                    color = bodyColor,
                )
            }
        }
    }
}

/**
 * 系统通知专用主题：基于 [TabTinMarkdownTheme] 但缩小字号、统一为次要色，
 * 对齐 iOS [MarkdownBubble.tabtinSystemNotice]。
 *
 * 内嵌为 private object 是为了不污染 [TabTinMarkdownTheme] 主面板的 IDE 自动补全；
 * 如果未来其他地方也需要 system notice 主题，再抽到 TabTinMarkdownTheme.systemNoticeXxx()。
 */
private object SystemNoticeTheme {
    @Composable
    fun typography(): MarkdownTypography {
        val secondary = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
        val baseStyle = TTFonts.meta.copy(color = secondary)
        val codeStyle = TTFonts.codeSM.copy(color = secondary)
        return markdownTypography(
            text = baseStyle,
            paragraph = baseStyle,
            ordered = baseStyle,
            bullet = baseStyle,
            list = baseStyle,
            textLink = TextLinkStyles(
                style = baseStyle.copy(textDecoration = TextDecoration.Underline).toSpanStyle(),
            ),
            code = codeStyle,
            inlineCode = codeStyle,
            quote = baseStyle,
            table = baseStyle,
            h1 = baseStyle,
            h2 = baseStyle,
            h3 = baseStyle,
            h4 = baseStyle,
            h5 = baseStyle,
            h6 = baseStyle,
        )
    }

    @Composable
    fun padding(): com.mikepenz.markdown.model.MarkdownPadding =
        com.mikepenz.markdown.model.markdownPadding(
            block = 2.dp,
            list = 0.dp,
            listItemTop = 0.dp,
            listItemBottom = 0.dp,
            listIndent = 8.dp,
            codeBlock = PaddingValues(8.dp),
        )
}

