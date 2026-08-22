package com.tabtin.mobile.features.conversation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Compress
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.SubdirectoryArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.features.conversation.cards.ToolCardContent
import com.tabtin.mobile.ui.theme.ttColor

@Composable
internal fun AgentStepCard(step: AgentStep, onNoticeAction: ((String) -> Unit)? = null) {
    if (step.type == StepType.SYSTEM_NOTICE && step.noticeType != null) {
        SystemNoticeCard(step = step, noticeType = step.noticeType, onAction = onNoticeAction)
        return
    }
    // Wave 6 S7：子 Agent 进度卡。对齐 iOS `AgentStepCard` 检测 subagent 字段的分发逻辑。
    // SubagentProgressCard 自己管展开/收起、工具历史等；不走 AgentStepCard 的通用"步骤"布局。
    if (step.type == StepType.SUBAGENT && step.subagent != null) {
        SubagentProgressCard(snapshot = step.subagent)
        return
    }

    var expanded by remember(step.id) { mutableStateOf(false) }
    val shape = TTRadius.Shapes.sm

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .border(0.5.dp, ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight), shape),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (step.status) {
                StepStatus.RUNNING -> CircularProgressIndicator(
                    modifier = Modifier.size(14.dp),
                    strokeWidth = 1.5.dp,
                    color = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                )
                StepStatus.COMPLETED -> Icon(
                    Icons.Default.CheckCircle,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess),
                )
                StepStatus.FAILED -> Icon(
                    Icons.Default.Error,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
            }

            Spacer(Modifier.width(TTSpacing.sm))

            val iconTint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary)
            when (step.type) {
                StepType.TOOL_CALL -> Icon(Icons.Default.Build, contentDescription = null, modifier = Modifier.size(14.dp), tint = iconTint)
                StepType.STEP -> Icon(Icons.Default.SubdirectoryArrowRight, contentDescription = null, modifier = Modifier.size(14.dp), tint = iconTint)
                StepType.SUBAGENT -> Icon(Icons.Default.Person, contentDescription = null, modifier = Modifier.size(14.dp), tint = iconTint)
                StepType.REASONING -> Icon(Icons.Default.Psychology, contentDescription = null, modifier = Modifier.size(14.dp), tint = iconTint)
                StepType.THINKING -> Icon(Icons.Default.Psychology, contentDescription = null, modifier = Modifier.size(14.dp), tint = iconTint)
                StepType.COMPACTION -> Icon(Icons.Default.Compress, contentDescription = null, modifier = Modifier.size(14.dp), tint = iconTint)
                StepType.LIFECYCLE -> Icon(Icons.Default.Info, contentDescription = null, modifier = Modifier.size(14.dp), tint = iconTint)
                StepType.SYSTEM_NOTICE -> Icon(Icons.Default.Notifications, contentDescription = null, modifier = Modifier.size(14.dp), tint = iconTint)
            }

            Spacer(Modifier.width(TTSpacing.sm))

            Column(modifier = Modifier.weight(1f)) {
                val displayName = step.name.ifEmpty {
                    when (step.type) {
                        StepType.THINKING -> stringResource(R.string.chat_step_thinking)
                        StepType.COMPACTION -> stringResource(R.string.chat_step_compaction)
                        StepType.LIFECYCLE -> stringResource(R.string.chat_step_lifecycle)
                        StepType.SYSTEM_NOTICE -> stringResource(R.string.chat_step_system_notice)
                        else -> step.name
                    }
                }
                Text(
                    displayName,
                    style = ConversationTypography.stepSemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                when {
                    step.status == StepStatus.RUNNING -> Text(
                        stringResource(R.string.chat_step_running),
                        style = ConversationTypography.meta,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                    step.durationMs != null -> {
                        val formatted = if (step.durationMs >= 1000) "${"%.1f".format(step.durationMs / 1000f)}s" else "${step.durationMs}ms"
                        Text(
                            formatted,
                            style = ConversationTypography.meta,
                            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        )
                    }
                }
            }

            Icon(
                if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }

        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(),
            exit = shrinkVertically(),
        ) {
            Column(modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm)) {
                HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider))
                Spacer(Modifier.height(TTSpacing.sm))

                if (step.type == StepType.TOOL_CALL && (step.output != null || step.input != null)) {
                    ToolCardContent(step)
                } else {
                    step.input?.takeIf { it.isNotEmpty() }?.let { input ->
                        DetailSection(stringResource(R.string.chat_step_input), truncateWithHint(input, 2000, stringResource(R.string.chat_view_more)))
                    }
                    step.output?.takeIf { it.isNotEmpty() }?.let { output ->
                        DetailSection(stringResource(R.string.chat_step_output), truncateWithHint(output, 2000, stringResource(R.string.chat_view_more)))
                    }
                    if (step.input.isNullOrEmpty() && step.output.isNullOrEmpty()) {
                        Text(
                            stringResource(R.string.chat_step_no_details),
                            style = ConversationTypography.meta,
                            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        )
                    }
                }
            }
        }
    }
}

private fun truncateWithHint(text: String, maxLength: Int, hint: String): String {
    if (text.length <= maxLength) return text
    return text.take(maxLength) + "\n\n" + hint
}

@Composable
private fun DetailSection(title: String, content: String) {
    Text(
        title,
        style = ConversationTypography.stepSemibold,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
    )
    Spacer(Modifier.height(TTSpacing.xxs))
    SelectionContainer {
        Text(
            content,
            style = ConversationTypography.step.copy(fontFamily = FontFamily.Monospace),
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            maxLines = 20,
            overflow = TextOverflow.Ellipsis,
        )
    }
    Spacer(Modifier.height(TTSpacing.sm))
}

@Composable
internal fun ToolGroupCard(steps: List<AgentStep>) {
    var expanded by remember(steps.firstOrNull()?.id) { mutableStateOf(false) }
    val shape = TTRadius.Shapes.sm

    val reads = steps.count { it.name in setOf("file_read", "read_file") }
    val searches = steps.count { it.name in setOf("grep", "glob", "code_search", "semantic_search", "code_grep") }
    val other = steps.size - reads - searches

    val summaryParts = buildList {
        if (reads > 0) add(stringResource(R.string.chat_tool_group_read_files, reads))
        if (searches > 0) add(stringResource(R.string.chat_tool_group_searched, searches))
        if (other > 0) add(stringResource(R.string.chat_tool_group_other, other))
    }
    val summary = summaryParts.ifEmpty {
        listOf(stringResource(R.string.chat_tool_group_steps, steps.size))
    }.joinToString(", ")

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .border(0.5.dp, ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight), shape),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Default.Inventory2,
                contentDescription = null,
                modifier = Modifier.size(12.dp),
                tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
            )
            Spacer(Modifier.width(TTSpacing.sm))
            Text(
                summary,
                style = ConversationTypography.meta,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                modifier = Modifier.weight(1f),
            )
            Text(
                stringResource(R.string.chat_tool_group_steps, steps.size),
                style = ConversationTypography.meta,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
            Spacer(Modifier.width(TTSpacing.xs))
            Icon(
                if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }

        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(),
            exit = shrinkVertically(),
        ) {
            Column(
                modifier = Modifier.padding(horizontal = TTSpacing.sm, vertical = TTSpacing.sm),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
            ) {
                steps.forEach { step -> AgentStepCard(step) }
            }
        }
    }
}

private sealed class StepGroup(val id: String) {
    class Single(val step: AgentStep) : StepGroup(step.id)
    class Collapsed(val steps: List<AgentStep>) : StepGroup("group-${steps.firstOrNull()?.id}")
}

private fun groupSteps(steps: List<AgentStep>): List<StepGroup> {
    val result = mutableListOf<StepGroup>()
    val batch = mutableListOf<AgentStep>()

    fun flush() {
        if (batch.isEmpty()) return
        if (batch.size >= 3) {
            result.add(StepGroup.Collapsed(batch.toList()))
        } else {
            batch.forEach { result.add(StepGroup.Single(it)) }
        }
        batch.clear()
    }

    for (step in steps) {
        val isLow = step.type == StepType.TOOL_CALL
            && ToolRiskClassifier.isLowRisk(step.name)
            && step.status == StepStatus.COMPLETED

        if (isLow) {
            batch.add(step)
        } else {
            flush()
            result.add(StepGroup.Single(step))
        }
    }
    flush()
    return result
}

@Composable
internal fun AgentStepsView(steps: List<AgentStep>, onNoticeAction: ((String) -> Unit)? = null) {
    val groups = remember(steps) { groupSteps(steps) }
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        groups.forEach { group ->
            when (group) {
                is StepGroup.Single -> AgentStepCard(group.step, onNoticeAction)
                is StepGroup.Collapsed -> ToolGroupCard(group.steps)
            }
        }
    }
}

@Composable
internal fun ReasoningView(content: String) {
    var expanded by remember { mutableStateOf(false) }
    val shape = TTRadius.Shapes.sm

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(ttColor(TTColors.BgReasoning, TTColors.Dark.BgReasoning))
            .border(0.5.dp, ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight), shape),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Default.Psychology,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
            )
            Spacer(Modifier.width(TTSpacing.sm))
            Text(
                stringResource(R.string.chat_reasoning),
                style = ConversationTypography.stepSemibold,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                modifier = Modifier.weight(1f),
            )
            Icon(
                if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }

        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(),
            exit = shrinkVertically(),
        ) {
            Column(modifier = Modifier.padding(horizontal = TTSpacing.md).padding(bottom = TTSpacing.sm)) {
                HorizontalDivider(color = ttColor(TTColors.Divider, TTColors.Dark.Divider))
                Spacer(Modifier.height(TTSpacing.sm))
                SelectionContainer {
                    Text(
                        content,
                        style = ConversationTypography.meta,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    )
                }
            }
        }
    }
}

@Composable
private fun SystemNoticeCard(step: AgentStep, noticeType: String, onAction: ((String) -> Unit)? = null) {
    val isApprovalExpired = noticeType == "approval_expired"
    val accentColor = if (isApprovalExpired)
        androidx.compose.ui.graphics.Color(0xFFDC2626)
    else
        androidx.compose.ui.graphics.Color(0xFFF59E0B)
    val bgColor = accentColor.copy(alpha = 0.08f)
    val shape = TTRadius.Shapes.sm

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(bgColor)
            .border(1.dp, accentColor.copy(alpha = 0.3f), shape)
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
            Icon(
                if (isApprovalExpired) Icons.Default.Error else Icons.Default.Info,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
                tint = accentColor,
            )
            Text(
                if (isApprovalExpired) stringResource(R.string.chat_notice_approval_expired_title)
                else stringResource(R.string.chat_notice_max_iterations_title),
                style = ConversationTypography.stepSemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
        }

        Text(
            step.name,
            style = ConversationTypography.meta,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )

        if (onAction != null) {
            var clicked by remember { mutableStateOf(false) }
            androidx.compose.material3.Button(
                onClick = {
                    if (!clicked) {
                        clicked = true
                        onAction(noticeType)
                    }
                },
                enabled = !clicked,
                colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                    containerColor = accentColor,
                    contentColor = androidx.compose.ui.graphics.Color.White,
                    disabledContainerColor = accentColor.copy(alpha = 0.4f),
                    disabledContentColor = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.6f),
                ),
                shape = TTRadius.Shapes.sm,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    horizontal = TTSpacing.lg,
                    vertical = TTSpacing.xs,
                ),
            ) {
                if (clicked) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                        color = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.6f),
                    )
                    Spacer(Modifier.width(TTSpacing.xs))
                }
                Text(
                    if (isApprovalExpired) stringResource(R.string.chat_notice_approval_expired_retry)
                    else stringResource(R.string.chat_notice_max_iterations_continue),
                    style = ConversationTypography.stepSemibold,
                )
            }
        }
    }
}
