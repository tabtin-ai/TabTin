package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SubagentRunSnapshot
import com.tabtin.mobile.data.model.SubagentRunStats
import com.tabtin.mobile.data.model.SubagentTranscriptItem
import com.tabtin.mobile.features.conversation.cards.ChatCardTokens
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 取消子 Agent 的动作入口。避免逐层 prop drilling 到深处的 [SubagentProgressCard]——
 * 会话屏 / Canvas 用 [CompositionLocalProvider] 注入 `{ runId -> vm.cancelSubagent(runId) }`，
 * 未注入（如预览 / 历史只读）时为 null，卡片自然不显示 stop 按钮。
 */
internal val LocalSubagentCancelHandler = staticCompositionLocalOf<((String) -> Unit)?> { null }

/**
 * Wave 6 S7 — 子 Agent 进度卡。
 *
 * 对标 Electron 行内锚点卡 + iOS `SubagentDispatchInlineRow` / `SubagentInlineProgressCard`：
 *  - Header：状态图标 + Bot 图标 + label + running 时 "步骤 N · tool_name" + 耗时 + 状态标签 + 进入详情。
 *  - Running 时底部 Linear 进度条（indeterminate 视觉，30% 宽 pulse）。
 *  - **详情从底部 sheet 出现**（对齐 iOS `SubagentDetailSheet`），不再原地展开；
 *    三块结构见 [SubagentDetailSectioning]。
 *
 * 取消能力（对齐 Electron / iOS）：
 *  - 活跃态（PENDING/QUEUED/RUNNING）header 显示 stop 按钮，点击即发即忘上行
 *    `subagent.cancel`（经 [LocalSubagentCancelHandler] 注入的动作）；点后转「取消中」，
 *    终态经 `subagent_failed(status=cancelled)` 回流后活跃态消失、按钮自然隐藏。
 *
 * 与 iOS 暂时差异：
 *  - SpeakerBadge / sourceLine 移动端先略——PRD 06 §5.1.2 身份系统移动端尚未落地。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SubagentProgressCard(
    snapshot: SubagentRunSnapshot,
    modifier: Modifier = Modifier,
) {
    var showDetailSheet by remember(snapshot.runId) { mutableStateOf(false) }
    // 本地「取消中」态：点 stop 即置位，显示转圈；终态回流后活跃态消失、按钮自然隐藏。
    var isCancelling by remember(snapshot.runId) { mutableStateOf(false) }
    val status = snapshot.status
    val displayLabel = SubagentDisplayTitle.resolve(snapshot.label, snapshot.task)
        ?: stringResource(R.string.chat_subagent_card_default_label)

    val statusColor = statusColor(status)
    val (bgColor, borderColor) = statusBackgroundAndBorder(status)

    // 活跃态（未达终态）+ 已注入取消入口 + 有真实 runId 才可取消。
    val cancelHandler = LocalSubagentCancelHandler.current
    val canCancel = cancelHandler != null &&
        snapshot.runId.isNotBlank() &&
        (status == SubagentRunSnapshot.Status.PENDING ||
            status == SubagentRunSnapshot.Status.QUEUED ||
            status == SubagentRunSnapshot.Status.RUNNING)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(bgColor)
            .border(0.5.dp, borderColor, TTRadius.Shapes.sm),
    ) {
        // Header 行：点开底部详情页（对齐 iOS sheet，非原地展开）
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button) { showDetailSheet = true }
                .padding(horizontal = ChatCardTokens.cardPaddingH, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusIcon(status = status, tint = statusColor)
            Spacer(modifier.width(TTSpacing.sm))

            Icon(
                Icons.Default.Person,
                contentDescription = null,
                modifier = Modifier.size(ChatCardTokens.iconSize),
                tint = ChatCardTokens.textMuted(),
            )
            Spacer(modifier.width(TTSpacing.xxs))

            Text(
                displayLabel,
                style = ConversationTypography.stepSemibold,
                color = ChatCardTokens.textPrimary(),
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )

            // Running 时显示 "步骤 N · tool_name"（不超过 header 宽度的 40%）
            if (status == SubagentRunSnapshot.Status.RUNNING) {
                val stepInfo = buildStepInfo(snapshot)
                if (stepInfo != null) {
                    Spacer(modifier.width(TTSpacing.xs))
                    Text(
                        stepInfo,
                        style = ConversationTypography.meta,
                        color = statusColor,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.widthIn(max = 140.dp),
                    )
                }
            }

            snapshot.durationMs?.takeIf { it > 0 }?.let { ms ->
                Spacer(modifier.width(TTSpacing.xs))
                Text(
                    formatDuration(ms),
                    style = ConversationTypography.meta,
                    color = ChatCardTokens.textMuted(),
                )
            }

            Spacer(modifier.width(TTSpacing.xs))
            Text(
                statusLabel(status),
                style = ConversationTypography.stepSemibold,
                color = statusColor,
            )

            Spacer(modifier.width(TTSpacing.xxs))
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = stringResource(R.string.chat_subagent_card_expand),
                modifier = Modifier.size(ChatCardTokens.iconSize),
                tint = ChatCardTokens.textMuted(),
            )

            if (canCancel) {
                Spacer(modifier.width(TTSpacing.xxs))
                IconButton(
                    onClick = {
                        if (!isCancelling) {
                            isCancelling = true
                            cancelHandler?.invoke(snapshot.runId)
                        }
                    },
                    enabled = !isCancelling,
                    modifier = Modifier.size(ChatCardTokens.iconSize + TTSpacing.sm),
                ) {
                    if (isCancelling) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(ChatCardTokens.iconSize),
                            strokeWidth = 1.5.dp,
                            color = ChatCardTokens.textMuted(),
                        )
                    } else {
                        Icon(
                            Icons.Default.StopCircle,
                            contentDescription = stringResource(R.string.chat_subagent_card_cancel),
                            modifier = Modifier.size(ChatCardTokens.iconSize),
                            tint = ChatCardTokens.textMuted(),
                        )
                    }
                }
            }
        }

        // 不在卡上再画进度条：状态图标 +「执行中」文案已够；进度条与 Electron/iOS 现行卡冗余。
    }

    if (showDetailSheet) {
        SubagentDetailSheet(
            snapshot = snapshot,
            onDismiss = { showDetailSheet = false },
        )
    }
}

/**
 * 子代理完整记录页：从底部出现（对齐 iOS `SubagentDetailSheet` + 三块 [SubagentDetailSectioning]）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SubagentDetailSheet(
    snapshot: SubagentRunSnapshot,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberTTSheetState(skipPartiallyExpanded = true)
    val status = snapshot.status
    val title = SubagentDisplayTitle.resolve(snapshot.label, snapshot.task)
        ?: stringResource(R.string.chat_subagent_card_default_label)
    val sections = SubagentDetailSectioning.sections(
        snapshot = snapshot,
        completedFallback = stringResource(R.string.chat_subagent_detail_completed_fallback),
        failedFallback = stringResource(R.string.chat_subagent_detail_failed_fallback),
        cancelledFallback = stringResource(R.string.chat_subagent_detail_cancelled_fallback),
        failureGuidanceText = stringResource(R.string.chat_subagent_detail_failure_guidance),
    )

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ttColor(TTColors.Surface, TTColors.Dark.Surface),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 640.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xxl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = title,
                    style = ConversationTypography.bodySemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    modifier = Modifier.weight(1f),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.width(TTSpacing.sm))
                Text(
                    text = statusLabel(status),
                    style = ConversationTypography.stepSemibold,
                    color = statusColor(status),
                )
            }

            SubagentDetailBlock(
                title = stringResource(R.string.chat_subagent_detail_instruction),
                meta = stringResource(R.string.chat_subagent_detail_instruction_meta),
            ) {
                val instruction = sections.instruction
                if (instruction != null) {
                    Text(
                        instruction,
                        style = ConversationTypography.meta,
                        color = ChatCardTokens.textPrimary(),
                        maxLines = 12,
                        overflow = TextOverflow.Ellipsis,
                    )
                } else {
                    SubagentDetailEmptyPlaceholder(
                        stringResource(R.string.chat_subagent_detail_instruction_empty),
                    )
                }
            }

            SubagentDetailBlock(
                title = stringResource(R.string.chat_subagent_detail_steps),
                meta = sections.steps.size.toString(),
            ) {
                if (sections.steps.isEmpty()) {
                    SubagentDetailEmptyPlaceholder(
                        stringResource(R.string.chat_subagent_detail_steps_empty),
                    )
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                        sections.steps.forEach { item ->
                            SubagentTranscriptItemRow(item = item)
                        }
                    }
                }
            }

            SubagentDetailBlock(
                title = stringResource(R.string.chat_subagent_detail_result),
                meta = null,
            ) {
                SubagentDetailResultContent(
                    result = sections.result,
                    status = status,
                )
            }

            snapshot.stats?.takeIf { !it.isEmpty }?.let { stats ->
                StatsLine(stats = stats)
            }
        }
    }
}

@Composable
private fun SubagentDetailBlock(
    title: String,
    meta: String?,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .border(0.5.dp, ChatCardTokens.borderDefault(), TTRadius.Shapes.sm),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                title,
                style = ConversationTypography.stepSemibold,
                color = ChatCardTokens.textSecondary(),
                modifier = Modifier.weight(1f),
            )
            if (!meta.isNullOrEmpty()) {
                Text(
                    meta,
                    style = ConversationTypography.meta,
                    color = ChatCardTokens.textMuted(),
                )
            }
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(ttColor(TTColors.Background, TTColors.Dark.Background))
                .padding(TTSpacing.sm),
        ) {
            content()
        }
    }
}

@Composable
private fun SubagentDetailEmptyPlaceholder(text: String) {
    Text(
        text,
        style = ConversationTypography.meta,
        color = ChatCardTokens.textMuted(),
    )
}

@Composable
private fun SubagentDetailResultContent(
    result: SubagentDetailResultSection,
    status: SubagentRunSnapshot.Status,
) {
    if (result.isPendingResult) {
        SubagentDetailEmptyPlaceholder(
            stringResource(R.string.chat_subagent_detail_result_pending),
        )
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
        result.assistantTexts.forEach { text ->
            Text(
                text,
                style = ConversationTypography.meta,
                color = ChatCardTokens.textPrimary(),
                maxLines = 12,
                overflow = TextOverflow.Ellipsis,
            )
        }
        result.terminalConclusion?.let { conclusion ->
            SubagentDetailConclusionBar(
                text = conclusion,
                isFailure = status == SubagentRunSnapshot.Status.FAILED,
            )
        }
        result.failureGuidance?.let { guidance ->
            Text(
                guidance,
                style = ConversationTypography.meta,
                color = ChatCardTokens.textSecondary(),
            )
        }
        if (result.assistantTexts.isEmpty()
            && result.terminalConclusion == null
            && result.failureGuidance == null
        ) {
            SubagentDetailEmptyPlaceholder(
                stringResource(R.string.chat_subagent_detail_result_empty),
            )
        }
    }
}

@Composable
private fun SubagentDetailConclusionBar(text: String, isFailure: Boolean) {
    // 无 assistant 正文时结论即结果本体，不再套一层「结果摘要」标题框。
    // 失败仍保留「失败结论」标签，方便扫错误原因。
    if (isFailure) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(6.dp))
                .background(ChatCardTokens.bgError())
                .border(0.5.dp, ChatCardTokens.borderError(), RoundedCornerShape(6.dp))
                .padding(TTSpacing.sm),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                stringResource(R.string.chat_subagent_detail_failure_conclusion),
                style = ConversationTypography.stepSemibold,
                color = ChatCardTokens.textError(),
            )
            Text(
                text,
                style = ConversationTypography.meta,
                color = ChatCardTokens.textError(),
                maxLines = 8,
                overflow = TextOverflow.Ellipsis,
            )
        }
    } else {
        Text(
            text,
            style = ConversationTypography.meta,
            color = ChatCardTokens.textPrimary(),
            maxLines = 8,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun SubagentTranscriptItemRow(item: SubagentTranscriptItem) {
    when (item.kind) {
        // assistant 正文归入结果块，中间步骤轨不渲染。
        SubagentTranscriptItem.Kind.ASSISTANT -> Unit
        SubagentTranscriptItem.Kind.TOOL -> SubagentTranscriptToolCard(item)
        SubagentTranscriptItem.Kind.THINKING -> SubagentTranscriptNotice(
            title = item.title ?: stringResource(R.string.chat_subagent_transcript_thinking),
            text = item.text,
            color = ChatCardTokens.textSecondary(),
        )
        SubagentTranscriptItem.Kind.RICH_CONTENT -> SubagentTranscriptNotice(
            title = item.title ?: stringResource(R.string.chat_subagent_transcript_rich),
            text = item.text,
            color = ChatCardTokens.textSecondary(),
        )
        SubagentTranscriptItem.Kind.CONTEXT_REF -> SubagentTranscriptNotice(
            title = item.title ?: stringResource(R.string.chat_subagent_transcript_context),
            text = item.text,
            color = ChatCardTokens.textSecondary(),
        )
        SubagentTranscriptItem.Kind.SYSTEM -> SubagentTranscriptNotice(
            title = item.title ?: stringResource(R.string.chat_subagent_transcript_event),
            text = item.text,
            color = ChatCardTokens.textSecondary(),
        )
        SubagentTranscriptItem.Kind.ERROR -> SubagentTranscriptNotice(
            title = item.title ?: stringResource(R.string.chat_subagent_transcript_error),
            text = item.text,
            color = ChatCardTokens.textError(),
        )
    }
}

@Composable
private fun SubagentTranscriptNotice(
    title: String,
    text: String?,
    color: Color,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(ttColor(TTColors.Background, TTColors.Dark.Background))
            .border(0.5.dp, ChatCardTokens.borderDefault(), RoundedCornerShape(6.dp))
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(title, style = ConversationTypography.stepSemibold, color = color)
        text?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                style = ConversationTypography.meta,
                color = color,
                maxLines = 8,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun SubagentTranscriptToolCard(item: SubagentTranscriptItem) {
    var expanded by remember(item.id) { mutableStateOf(false) }
    val title = item.title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.chat_subagent_transcript_tool)
    val hasDetail = !item.inputText.isNullOrBlank() || !item.outputText.isNullOrBlank() || !item.text.isNullOrBlank()
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(ttColor(TTColors.Background, TTColors.Dark.Background))
            .border(0.5.dp, ChatCardTokens.borderDefault(), RoundedCornerShape(6.dp)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .then(if (hasDetail) Modifier.clickable(role = Role.Button) { expanded = !expanded } else Modifier)
                .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!item.isFinal) {
                CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 1.5.dp,
                    color = ChatCardTokens.textAccent(),
                )
            } else {
                Icon(
                    if (item.isError) Icons.Default.Error else Icons.Default.CheckCircle,
                    contentDescription = null,
                    modifier = Modifier.size(12.dp),
                    tint = if (item.isError) ChatCardTokens.textError() else ChatCardTokens.textSuccess(),
                )
            }
            Spacer(Modifier.width(TTSpacing.xs))
            Text(
                title,
                style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                color = if (item.isError) ChatCardTokens.textError() else ChatCardTokens.textSecondary(),
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (hasDetail) {
                Icon(
                    if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = null,
                    modifier = Modifier.size(12.dp),
                    tint = ChatCardTokens.textMuted(),
                )
            }
        }
        if (expanded) {
            Column(
                modifier = Modifier.padding(start = TTSpacing.lg, end = TTSpacing.sm, bottom = TTSpacing.xs),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                item.text?.takeIf { it.isNotBlank() }?.let { SubagentTranscriptCodeText(it, item.isError) }
                item.inputText?.takeIf { it.isNotBlank() }?.let {
                    Text(stringResource(R.string.chat_step_input), style = ConversationTypography.stepSemibold, color = ChatCardTokens.textMuted())
                    SubagentTranscriptCodeText(it, isError = false)
                }
                item.outputText?.takeIf { it.isNotBlank() }?.let {
                    Text(stringResource(R.string.chat_step_output), style = ConversationTypography.stepSemibold, color = ChatCardTokens.textMuted())
                    SubagentTranscriptCodeText(it, isError = item.isError)
                }
            }
        }
    }
}

@Composable
private fun SubagentTranscriptCodeText(text: String, isError: Boolean) {
    Text(
        text,
        style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
        color = if (isError) ChatCardTokens.textError() else ChatCardTokens.textSecondary(),
        maxLines = 10,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun StatsLine(stats: SubagentRunStats) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        modifier = Modifier.fillMaxWidth(),
    ) {
        stats.totalTokens?.let { total ->
            Text(
                stringResource(R.string.chat_subagent_card_tokens_total, total),
                style = ConversationTypography.meta,
                color = ChatCardTokens.textMuted(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        stats.inputTokens?.let { input ->
            Text(
                stringResource(R.string.chat_subagent_card_tokens_input, input),
                style = ConversationTypography.meta,
                color = ChatCardTokens.textMuted(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        stats.outputTokens?.let { output ->
            Text(
                stringResource(R.string.chat_subagent_card_tokens_output, output),
                style = ConversationTypography.meta,
                color = ChatCardTokens.textMuted(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        stats.creditsConsumed?.takeIf { it > 0.0 }?.let { credits ->
            Text(
                stringResource(R.string.chat_subagent_card_credits, formatCredits(credits)),
                style = ConversationTypography.meta,
                color = ChatCardTokens.textMuted(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * 格式化积分显示。与 iOS `formatCredits` + Electron `formatCreditsAuto` 同口径：
 *  - 整数（且 < 10000）→ 整数文本（"5"）
 *  - 0 < value < 1 → 3 位小数（"0.123"）
 *  - 其它 → 1 位小数（"5.4"）
 */
private fun formatCredits(value: Double): String {
    if (value == kotlin.math.floor(value) && value < 10_000.0) {
        return "%.0f".format(value)
    }
    if (value < 1.0) {
        return "%.3f".format(value)
    }
    return "%.1f".format(value)
}

@Composable
private fun StatusIcon(status: SubagentRunSnapshot.Status, tint: Color) {
    when (status) {
        SubagentRunSnapshot.Status.PENDING,
        SubagentRunSnapshot.Status.RUNNING -> CircularProgressIndicator(
            modifier = Modifier.size(ChatCardTokens.iconSize),
            strokeWidth = 1.5.dp,
            color = tint,
        )
        SubagentRunSnapshot.Status.QUEUED -> Icon(
            Icons.Default.Schedule,
            contentDescription = null,
            modifier = Modifier.size(ChatCardTokens.iconSize),
            tint = tint,
        )
        SubagentRunSnapshot.Status.COMPLETED -> Icon(
            Icons.Default.CheckCircle,
            contentDescription = null,
            modifier = Modifier.size(ChatCardTokens.iconSize),
            tint = tint,
        )
        SubagentRunSnapshot.Status.FAILED -> Icon(
            Icons.Default.Error,
            contentDescription = null,
            modifier = Modifier.size(ChatCardTokens.iconSize),
            tint = tint,
        )
        SubagentRunSnapshot.Status.CANCELLED -> Icon(
            Icons.Default.Block,
            contentDescription = null,
            modifier = Modifier.size(ChatCardTokens.iconSize),
            tint = tint,
        )
    }
}

@Composable
private fun statusColor(status: SubagentRunSnapshot.Status): Color = when (status) {
    SubagentRunSnapshot.Status.PENDING -> ChatCardTokens.textMuted()
    SubagentRunSnapshot.Status.QUEUED -> ChatCardTokens.textMuted()
    SubagentRunSnapshot.Status.RUNNING -> ChatCardTokens.textAccent()
    SubagentRunSnapshot.Status.COMPLETED -> ChatCardTokens.textSuccess()
    SubagentRunSnapshot.Status.FAILED -> ChatCardTokens.textError()
    SubagentRunSnapshot.Status.CANCELLED -> ChatCardTokens.textMuted()
}

@Composable
private fun statusBackgroundAndBorder(
    status: SubagentRunSnapshot.Status,
): Pair<Color, Color> {
    val accent = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
    val success = ttColor(TTColors.BgSuccess, TTColors.Dark.BgSuccess)
    return when (status) {
        SubagentRunSnapshot.Status.PENDING,
        SubagentRunSnapshot.Status.QUEUED,
        SubagentRunSnapshot.Status.CANCELLED ->
            ChatCardTokens.bgCard() to ChatCardTokens.borderDefault()
        SubagentRunSnapshot.Status.RUNNING ->
            accent.copy(alpha = 0.06f) to accent.copy(alpha = 0.3f)
        SubagentRunSnapshot.Status.COMPLETED ->
            success.copy(alpha = 0.06f) to ChatCardTokens.borderSuccess()
        SubagentRunSnapshot.Status.FAILED ->
            ChatCardTokens.bgError() to ChatCardTokens.borderError()
    }
}

@Composable
private fun statusLabel(status: SubagentRunSnapshot.Status): String = stringResource(
    when (status) {
        SubagentRunSnapshot.Status.PENDING -> R.string.chat_subagent_card_status_pending
        SubagentRunSnapshot.Status.QUEUED -> R.string.chat_subagent_card_status_queued
        SubagentRunSnapshot.Status.RUNNING -> R.string.chat_subagent_card_status_running
        SubagentRunSnapshot.Status.COMPLETED -> R.string.chat_subagent_card_status_completed
        SubagentRunSnapshot.Status.FAILED -> R.string.chat_subagent_card_status_failed
        SubagentRunSnapshot.Status.CANCELLED -> R.string.chat_subagent_card_status_cancelled
    }
)

@Composable
private fun buildStepInfo(snap: SubagentRunSnapshot): String? {
    val count = snap.stepCount
    val latest = snap.latestTool
    val countText = count?.takeIf { it > 0 }?.let {
        stringResource(R.string.chat_subagent_card_step_count, it)
    }
    return when {
        countText != null && !latest.isNullOrBlank() -> "$countText · $latest"
        countText != null -> countText
        !latest.isNullOrBlank() -> latest
        else -> null
    }
}

private fun formatDuration(ms: Int): String =
    if (ms >= 1000) "%.1fs".format(ms / 1000f) else "${ms}ms"
