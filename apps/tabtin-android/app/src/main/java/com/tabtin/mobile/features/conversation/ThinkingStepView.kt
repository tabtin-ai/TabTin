package com.tabtin.mobile.features.conversation

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/** 对齐 Electron / iOS 流式思考预览窗高度（66px ≈ 3 行 step 文案）。 */
internal val ThinkingStreamingPreviewHeight = 66.dp

/**
 * 流式预览尾部字符预算（ / iOS ThinkingStreamReveal）。
 * 固定高窗口只 layout 尾部，避免每帧对整段 thinking 测高。
 */
internal object ThinkingStreamReveal {
    const val PREVIEW_CHARACTER_BUDGET = 720

    fun previewTail(text: String, maxCharacters: Int = PREVIEW_CHARACTER_BUDGET): String {
        if (maxCharacters <= 0 || text.length <= maxCharacters) return text
        return text.takeLast(maxCharacters)
    }
}

/**
 * 时间线思考行：与 iOS `ThinkingStepView` / Electron `ThinkingBlockView` 同构——
 * Brain + 步骤字号文案（运行态扫光）+ 流式 66dp 尾部预览；全文进抽屉。
 * 假思考壳 [StreamingStatusIndicator] 复用同一 Brain / 字号 / 扫光，避免两套视觉。
 */
@Composable
internal fun ThinkingStepTimelineRow(
    content: String,
    running: Boolean,
    modifier: Modifier = Modifier,
) {
    var showSheet by remember { mutableStateOf(false) }
    val label = if (running) {
        stringResource(R.string.chat_step_thinking)
    } else {
        stringResource(R.string.chat_execution_thinking_done)
    }
    val showPreview = running && AgentAwaitingThoughtPresentation.hasVisibleThinkingBody(content)

    // 空 streaming thinking 不渲染本体，交给等待壳（对齐 iOS shouldRender）。
    if (!running && !AgentAwaitingThoughtPresentation.hasVisibleThinkingBody(content)) {
        return
    }
    if (running && !showPreview && content.trim().isEmpty()) {
        return
    }

    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(TTRadius.Shapes.sm)
                .clickable { showSheet = true }
                .heightIn(min = 28.dp)
                .padding(vertical = TTSpacing.xxs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // 与 ExecutionStepRow 同一布局：内容左贴，不要把 chevron 顶到行尾。
            Row(
                modifier = Modifier.weight(1f, fill = false),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ThinkingBrainIcon()
                Spacer(modifier = Modifier.width(TTSpacing.xs))
                ConversationStepLabel(
                    text = label,
                    running = running,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(modifier = Modifier.width(TTSpacing.xs))
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = stringResource(R.string.chat_execution_detail_hint),
                    modifier = Modifier.size(16.dp),
                    tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }
        }

        if (showPreview) {
            ThinkingStreamingPreviewWithRail(text = content)
        }
    }

    if (showSheet) {
        ExecutionDetailSheet(
            items = listOf(AssistantTimelineItem.Thinking(content)),
            isStreaming = running,
            onDismiss = { showSheet = false },
        )
    }
}

/**
 * 回合尾假思考 / planningNext 等待壳。
 * 与真思考标题行共用 Brain + ConversationTypography.step + 扫光，不再用圆底 Psychology。
 */
@Composable
internal fun StreamingStatusIndicator(
    awaitingPhase: AgentAwaitingThoughtPhase = AgentAwaitingThoughtPhase.PENDING,
) {
    val label = when (awaitingPhase) {
        AgentAwaitingThoughtPhase.PLANNING_NEXT ->
            stringResource(R.string.chat_awaiting_planning_next)
        AgentAwaitingThoughtPhase.PENDING,
        AgentAwaitingThoughtPhase.HIDDEN,
        -> stringResource(R.string.chat_step_thinking)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = TTSpacing.xxs)
            .heightIn(min = 28.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ThinkingBrainIcon()
        Spacer(modifier = Modifier.width(TTSpacing.xs))
        ConversationStepLabel(text = label, running = true)
    }
}

@Composable
internal fun ThinkingBrainIcon() {
    Box(modifier = Modifier.size(16.dp), contentAlignment = Alignment.Center) {
        Icon(
            painter = painterResource(R.drawable.ic_lucide_brain),
            contentDescription = null,
            modifier = Modifier.size(14.dp),
            tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
        )
    }
}

@Composable
internal fun ConversationStepLabel(
    text: String,
    running: Boolean,
    modifier: Modifier = Modifier,
) {
    if (running) {
        ConversationStepShinyText(text = text, modifier = modifier)
    } else {
        Text(
            text = text,
            style = ConversationTypography.step,
            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary).copy(alpha = 0.9f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = modifier,
        )
    }
}

/**
 * 对齐 Electron / iOS ShinyText：固定色停 + 平移 2× 宽渐变（background-size:200%）。
 * 旧实现把 colorStop 位置当相位推，短中文（如「思考中…」）上高光几乎只蹭到末字。
 */
@Composable
internal fun ConversationStepShinyText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = ConversationTypography.step,
) {
    val infinite = rememberInfiniteTransition(label = "conversationStepShiny")
    val phase by infinite.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1600, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "conversationStepShinyPhase",
    )
    var textWidthPx by remember { mutableFloatStateOf(0f) }
    val base = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    val highlight = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    val muted = base.copy(alpha = 0.80f)
    val band = highlight.copy(alpha = 0.92f)
    // 与 iOS ShinyTextMotion：phase 0→1 时 2w 渐变从 -w 滑到 0，高光左→右扫过正文。
    val brush = if (textWidthPx > 0f) {
        val w = textWidthPx
        val startX = -w * (1f - phase)
        Brush.linearGradient(
            colorStops = arrayOf(
                0.0f to muted,
                0.4f to muted,
                0.5f to band,
                0.6f to muted,
                1.0f to muted,
            ),
            start = Offset(startX, 0f),
            end = Offset(startX + w * 2f, 0f),
        )
    } else {
        Brush.linearGradient(listOf(muted, muted))
    }
    Text(
        text = text,
        style = style.merge(TextStyle(brush = brush)),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier,
        onTextLayout = { layout ->
            val next = layout.size.width.toFloat()
            if (next > 0f && next != textWidthPx) textWidthPx = next
        },
    )
}

@Composable
private fun ThinkingStreamingPreviewWithRail(text: String) {
    val preview = remember(text) { ThinkingStreamReveal.previewTail(text) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = TTSpacing.xs)
            .padding(bottom = TTSpacing.xxs),
    ) {
        Box(
            Modifier
                .width(1.dp)
                .height(ThinkingStreamingPreviewHeight)
                .background(ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)),
        )
        Spacer(modifier = Modifier.width(TTSpacing.sm))
        val fadeTop = Color.Transparent
        val fadeSolid = Color.Black
        Box(
            modifier = Modifier
                .weight(1f)
                .height(ThinkingStreamingPreviewHeight)
                .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                .drawWithContent {
                    drawContent()
                    drawRect(
                        brush = Brush.verticalGradient(
                            colorStops = arrayOf(
                                0f to fadeTop,
                                0.22f to fadeSolid,
                                1f to fadeSolid,
                            ),
                        ),
                        blendMode = BlendMode.DstIn,
                    )
                },
            contentAlignment = Alignment.BottomStart,
        ) {
            Text(
                text = preview,
                style = ConversationTypography.step,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
                    .copy(alpha = 0.68f),
            )
        }
    }
}
