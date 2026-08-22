package com.tabtin.mobile.features.conversation

import android.content.ClipData
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ApprovalActionRequest
import com.tabtin.mobile.features.conversation.cards.ChatCardTokens
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 批量审批面板 —— 收起态 Dock + 展开态详情 Sheet。
 *
 * 协议源：`packages/agent-wire/src/approval.ts ApprovalRequestedPayloadSchema`。
 *
 * ## 为什么改成两层
 *
 * 旧版把整批操作、原始 `toolInputJson`、判决理由、scope 说明一次性摊在会话流里，
 * 全部用同一档小字。结果是「要执行什么」这条唯一需要判断的信息，和一堆读了也不改变
 * 决策的元数据抢同样的注意力；批量时面板还会把正文和输入框顶出屏幕。
 *
 * 现在收起态只回答两件事——**做什么**、**还剩多久**；其余进详情 Sheet。
 * 只有「单条 + 非高风险 + 工作区内」允许在收起态直接批准（[ApprovalPresentation.allowsDirectApproval]），
 * 其余一律要求展开确认：手机上单手误触的代价比多一次点击高。
 *
 * 提交契约不变：整批同 outcome，scope 作用于全部条目，allowedScopes / allowedOutcomes
 * 取交集，避免出现「按了但服务端拒」。与 iOS `ApprovalDock` / `ApprovalDetailSheet` 同口径。
 */
@Composable
internal fun ApprovalPanelView(
    pending: PendingApproval,
    isSubmitting: Boolean,
    onSubmit: (outcome: String, scope: String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val actions = pending.actionRequests
    val commonAllowedScopes = remember(pending.batchId) { commonScopes(actions) }
    val commonAllowedOutcomes = remember(pending.batchId) { commonOutcomes(actions) }
    val allowsAllow = "allow" in commonAllowedOutcomes && commonAllowedScopes.isNotEmpty()
    val allowsDeny = "deny" in commonAllowedOutcomes

    var selectedScope by remember(pending.batchId) {
        mutableStateOf(
            actions.firstOrNull()?.askHintSuggestedScope?.takeIf { it in commonAllowedScopes }
                ?: commonAllowedScopes.firstOrNull().orEmpty()
        )
    }
    var showSheet by remember(pending.batchId) { mutableStateOf(false) }
    var lastClicked by remember(pending.batchId) { mutableStateOf<String?>(null) }

    var nowMs by remember(pending.batchId) { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(pending.batchId, pending.expiresAtMs) {
        if (pending.expiresAtMs != null) {
            while (true) {
                nowMs = System.currentTimeMillis()
                delay(1_000L)
            }
        }
    }
    val remainingSec = pending.expiresAtMs?.let { ((it - nowMs) / 1_000L).coerceAtLeast(0L) }
    val expired = remainingSec != null && remainingSec <= 0L

    val severity = remember(pending.batchId) { ApprovalPresentation.severity(actions) }
    val allowsDirect = remember(pending.batchId) {
        ApprovalPresentation.allowsDirectApproval(actions)
    }

    ApprovalDockSurface(modifier = modifier) {
        DockHeader(
            actions = actions,
            severity = severity,
            expired = expired,
            isSubmitting = isSubmitting,
            remainingSec = remainingSec,
        )
        DockSubline(actions = actions, expired = expired)
        DockActions(
            expired = expired,
            isSubmitting = isSubmitting,
            lastClicked = lastClicked,
            allowsDirect = allowsDirect && allowsAllow,
            allowsDeny = allowsDeny,
            onDismiss = {
                lastClicked = "cancelled"
                onSubmit("cancelled", null)
            },
            onApprove = {
                lastClicked = "allow"
                onSubmit("allow", selectedScope)
            },
            onOpenSheet = { showSheet = true },
        )
    }

    if (showSheet) {
        ApprovalDetailSheet(
            actions = actions,
            allowedScopes = commonAllowedScopes,
            selectedScope = selectedScope,
            onScopeChange = { selectedScope = it },
            allowsAllow = allowsAllow,
            allowsDeny = allowsDeny,
            expired = expired,
            isSubmitting = isSubmitting,
            remainingSec = remainingSec,
            onDismissRequest = { showSheet = false },
            onDecide = { outcome ->
                lastClicked = outcome
                showSheet = false
                onSubmit(outcome, if (outcome == "allow") selectedScope else null)
            },
        )
    }
}

// MARK: - 收起态

@Composable
private fun ApprovalDockSurface(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val shape = TTRadius.Shapes.md
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(ttColor(TTColors.Background, TTColors.Dark.Background))
            .border(0.5.dp, ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight), shape)
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        content()
    }
}

@Composable
private fun DockHeader(
    actions: List<ApprovalActionRequest>,
    severity: ApprovalSeverity,
    expired: Boolean,
    isSubmitting: Boolean,
    remainingSec: Long?,
) {
    val title = when {
        expired -> stringResource(R.string.chat_approval_dock_title_expired)
        isSubmitting -> stringResource(R.string.chat_approval_dock_title_submitting)
        actions.size == 1 -> actionVerb(actions.first())
        else -> stringResource(R.string.chat_approval_dock_title_multi)
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            imageVector = if (severity == ApprovalSeverity.CRITICAL) Icons.Default.Warning else Icons.Default.Shield,
            contentDescription = null,
            modifier = Modifier.size(18.dp),
            tint = if (expired) {
                ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
            } else {
                severity.iconColor()
            },
        )
        Spacer(Modifier.width(TTSpacing.xs))
        Text(
            title,
            style = TTFonts.subtitleSemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Spacer(Modifier.weight(1f))
        if (!expired) {
            formatCountdown(remainingSec)?.let { countdown ->
                Text(
                    countdown,
                    style = TTFonts.meta,
                    color = if (remainingSec != null && remainingSec < 30L) {
                        ChatCardTokens.riskHigh()
                    } else {
                        ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                    },
                )
            }
        }
    }
}

@Composable
private fun DockSubline(actions: List<ApprovalActionRequest>, expired: Boolean) {
    if (expired) {
        Text(
            stringResource(R.string.chat_approval_dock_expired_hint),
            style = TTFonts.body,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
        return
    }
    if (actions.size > 1) {
        Text(
            stringResource(R.string.chat_approval_dock_pending_count, actions.size),
            style = TTFonts.body,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
        return
    }
    val action = actions.firstOrNull() ?: return
    val layout = ApprovalPresentation.layout(action.toolInputJson, rememberValueLabels())
    val command = layout.command?.value
    when {
        // 有命令就让命令自己说话，不再叠一行摘要——它们说的是同一件事。
        command != null -> InlineCommand(command)
        layout.primaryRows.isNotEmpty() -> Text(
            layout.primaryRows.first().value,
            style = TTFonts.body,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        !action.askHintSummary.isNullOrBlank() -> Text(
            action.askHintSummary.orEmpty(),
            style = TTFonts.body,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun DockActions(
    expired: Boolean,
    isSubmitting: Boolean,
    lastClicked: String?,
    allowsDirect: Boolean,
    allowsDeny: Boolean,
    onDismiss: () -> Unit,
    onApprove: () -> Unit,
    onOpenSheet: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        when {
            expired -> DecisionButton(
                text = stringResource(R.string.common_close),
                kind = DecisionKind.SECONDARY,
                fillsWidth = true,
                enabled = !isSubmitting,
                onClick = onDismiss,
            )

            allowsDirect -> {
                DecisionButton(
                    text = stringResource(R.string.chat_approval_view_detail),
                    kind = DecisionKind.SECONDARY,
                    enabled = !isSubmitting,
                    onClick = onOpenSheet,
                )
                DecisionButton(
                    text = stringResource(R.string.chat_approval_allow),
                    kind = DecisionKind.PRIMARY,
                    fillsWidth = true,
                    enabled = !isSubmitting,
                    loading = isSubmitting && lastClicked == "allow",
                    onClick = onApprove,
                )
            }

            else -> {
                if (allowsDeny) {
                    DecisionButton(
                        text = stringResource(R.string.chat_approval_deny),
                        kind = DecisionKind.DESTRUCTIVE,
                        enabled = !isSubmitting,
                        loading = isSubmitting && lastClicked == "deny",
                        onClick = onOpenSheet,
                    )
                }
                DecisionButton(
                    text = stringResource(R.string.chat_approval_view_and_confirm),
                    kind = DecisionKind.PRIMARY,
                    fillsWidth = true,
                    enabled = !isSubmitting,
                    loading = isSubmitting && lastClicked == "allow",
                    onClick = onOpenSheet,
                )
            }
        }
    }
}

// MARK: - 展开态

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ApprovalDetailSheet(
    actions: List<ApprovalActionRequest>,
    allowedScopes: List<String>,
    selectedScope: String,
    onScopeChange: (String) -> Unit,
    allowsAllow: Boolean,
    allowsDeny: Boolean,
    expired: Boolean,
    isSubmitting: Boolean,
    remainingSec: Long?,
    onDismissRequest: () -> Unit,
    onDecide: (String) -> Unit,
) {
    val context = LocalContext.current
    // 列表限高、按钮常驻：批量审批时不该为了够到「批准」先滚三屏。
    val maxListHeight = (LocalConfiguration.current.screenHeightDp * 0.5f).dp

    TTBottomSheet(
        onDismissRequest = onDismissRequest,
        containerColor = ttColor(TTColors.Background, TTColors.Dark.Background),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    stringResource(
                        if (expired) R.string.chat_approval_dock_title_expired
                        else R.string.chat_approval_sheet_title
                    ),
                    style = TTFonts.subtitleSemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                )
                Text(
                    stringResource(R.string.chat_approval_sheet_action_count, actions.size),
                    style = TTFonts.meta,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }
            if (!expired) {
                formatCountdown(remainingSec)?.let { countdown ->
                    Text(
                        countdown,
                        style = TTFonts.meta,
                        color = if (remainingSec != null && remainingSec < 30L) {
                            ChatCardTokens.riskHigh()
                        } else {
                            ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                        },
                    )
                }
            }
        }
        HorizontalDivider(color = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = maxListHeight)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            formatExpiresHint(remainingSec ?: Long.MAX_VALUE, context)?.let { hint ->
                Text(
                    hint,
                    style = TTFonts.meta,
                    color = if (expired) {
                        ChatCardTokens.riskHigh()
                    } else {
                        ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
                    },
                )
            }
            actions.forEachIndexed { index, action ->
                ApprovalActionCard(action = action, index = index, total = actions.size)
            }
        }

        HorizontalDivider(color = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight))
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            if (!expired && allowsAllow && allowedScopes.size > 1) {
                allowedScopes.forEach { scope ->
                    ScopeOption(
                        scope = scope,
                        selected = scope == selectedScope,
                        onSelect = { onScopeChange(scope) },
                    )
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                if (expired) {
                    DecisionButton(
                        text = stringResource(R.string.common_close),
                        kind = DecisionKind.SECONDARY,
                        fillsWidth = true,
                        enabled = true,
                        onClick = { onDecide("cancelled") },
                    )
                } else {
                    if (allowsDeny) {
                        DecisionButton(
                            text = stringResource(R.string.chat_approval_deny),
                            kind = DecisionKind.DESTRUCTIVE,
                            enabled = !isSubmitting,
                            onClick = { onDecide("deny") },
                        )
                    }
                    if (allowsAllow) {
                        DecisionButton(
                            text = stringResource(R.string.chat_approval_allow),
                            kind = DecisionKind.PRIMARY,
                            fillsWidth = true,
                            enabled = !isSubmitting,
                            loading = isSubmitting,
                            onClick = { onDecide("allow") },
                        )
                    }
                }
            }
        }
    }
}

/** 单条操作卡：动作 + 命令块 + 最多两条关键字段 + 最多一行风险提示，其余进折叠。 */
@Composable
private fun ApprovalActionCard(
    action: ApprovalActionRequest,
    index: Int,
    total: Int,
) {
    val context = LocalContext.current
    var expanded by remember(action.requestId) { mutableStateOf(false) }
    val layout = ApprovalPresentation.layout(action.toolInputJson, rememberValueLabels())
    val riskHint = ApprovalPresentation.riskHint(
        action.riskLevel,
        ApprovalPresentation.workspaceZone(action),
    )
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .animateContentSize()
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    actionVerb(action),
                    style = TTFonts.subtitleSemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                )
                // 摘要只留一句：ask_hint 优先，缺失才退回 explanation，避免两段重复小字。
                val summary = action.askHintSummary?.takeIf { it.isNotBlank() }
                    ?: ApprovalPresentation.explanation(action.toolInputJson)
                summary?.let {
                    Text(
                        it,
                        style = TTFonts.body,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    )
                }
            }
            if (total > 1) {
                Text(
                    "${index + 1}/$total",
                    style = TTFonts.meta,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }
        }

        layout.command?.let { CommandBlock(it.value) }
        layout.primaryRows.forEach { FieldRow(it) }
        riskHint?.let { RiskRow(it) }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.clickable { expanded = !expanded },
        ) {
            Text(
                stringResource(
                    if (expanded) R.string.chat_approval_collapse
                    else R.string.chat_approval_full_params
                ),
                style = TTFonts.meta,
                color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            )
            Icon(
                imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            )
        }
        if (expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                // 判决理由解释「为什么问你」，不参与「要不要批」的判断，所以只在这里出现。
                decisionReasonText(action, context)?.let { reason ->
                    FieldRow(
                        ApprovalParameterRow(
                            key = "__reason",
                            label = ApprovalFieldLabel.Res(R.string.chat_approval_field_reason),
                            value = reason,
                            style = ApprovalValueStyle.TEXT,
                        )
                    )
                }
                FieldRow(
                    ApprovalParameterRow(
                        key = "__tool",
                        label = ApprovalFieldLabel.Res(R.string.chat_approval_field_tool),
                        value = toolDisplayName(action),
                        style = ApprovalValueStyle.CODE,
                    )
                )
                layout.collapsedRows.forEach { FieldRow(it) }
            }
        }
    }
}

// MARK: - 零件

/** Dock 的单行命令：不换行、可横滑。 */
@Composable
private fun InlineCommand(command: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .horizontalScroll(rememberScrollState())
            .padding(TTSpacing.sm),
    ) {
        Text(
            command,
            style = TTFonts.codeSM,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            maxLines = 1,
        )
    }
}

/** Sheet 里的命令块：独立底色 + 右上角拷贝，超高时内部滚动。 */
@Composable
private fun CommandBlock(command: String) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember(command) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_500L)
            copied = false
        }
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.Background, TTColors.Dark.Background)),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 120.dp)
                .verticalScroll(rememberScrollState())
                .padding(TTSpacing.sm)
                .padding(end = 28.dp),
        ) {
            Text(
                command,
                style = TTFonts.codeSM,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
        }
        Icon(
            imageVector = if (copied) Icons.Default.Check else Icons.Default.ContentCopy,
            contentDescription = stringResource(R.string.chat_approval_copy_command),
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(TTSpacing.xs)
                .size(28.dp)
                .clip(TTRadius.Shapes.sm)
                .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                .clickable {
                    // Compose 1.7+ 的 Clipboard API 是 suspend；勾号是本地状态，不等写入回来。
                    scope.launch {
                        clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("command", command)))
                    }
                    copied = true
                }
                .padding(6.dp),
            tint = if (copied) {
                ChatCardTokens.riskLow()
            } else {
                ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
            },
        )
    }
}

@Composable
private fun FieldRow(row: ApprovalParameterRow) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(
            when (val label = row.label) {
                is ApprovalFieldLabel.Res -> stringResource(label.id)
                is ApprovalFieldLabel.Raw -> label.text
            },
            style = TTFonts.caption,
            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            modifier = Modifier.width(64.dp),
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Text(
            row.value,
            style = if (row.style == ApprovalValueStyle.TEXT) TTFonts.body else TTFonts.codeSM,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun RiskRow(hint: ApprovalRiskHint) {
    val color = if (hint.emphasis == ApprovalRiskEmphasis.CRITICAL) {
        ChatCardTokens.riskHigh()
    } else {
        ChatCardTokens.riskMedium()
    }
    val text = buildString {
        append(stringResource(hint.riskResId))
        hint.zoneResId?.let {
            append(' ')
            append(stringResource(it))
        }
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(color.copy(alpha = 0.08f))
            .padding(TTSpacing.sm),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = color,
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Text(text, style = TTFonts.body, color = color)
    }
}

/** 授权范围：整行可点，只有选中项展开一句后果说明。 */
@Composable
private fun ScopeOption(scope: String, selected: Boolean, onSelect: () -> Unit) {
    val labelRes = when (scope) {
        "thread" -> R.string.chat_approval_scope_thread
        "always" -> R.string.chat_approval_scope_always
        else -> R.string.chat_approval_scope_once
    }
    val descriptionRes = when (scope) {
        "thread" -> R.string.chat_approval_scope_description_thread
        "always" -> R.string.chat_approval_scope_description_always
        else -> R.string.chat_approval_scope_description_once
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(
                if (selected) {
                    ttColor(TTColors.BgReasoning, TTColors.Dark.BgReasoning)
                } else {
                    Color.Transparent
                }
            )
            .border(
                1.dp,
                if (selected) {
                    ttColor(TTColors.BorderFocused, TTColors.Dark.BorderFocused)
                } else {
                    ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
                },
                TTRadius.Shapes.sm,
            )
            .clickable { onSelect() }
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs)
            .animateContentSize(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onSelect, modifier = Modifier.size(24.dp))
        Spacer(Modifier.width(TTSpacing.sm))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                stringResource(labelRes),
                style = TTFonts.bodySemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
            // 三条说明同时展开就是三行小字，只讲选中的那条。
            if (selected) {
                Text(
                    stringResource(descriptionRes),
                    style = TTFonts.meta,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
            }
        }
    }
}

private enum class DecisionKind { PRIMARY, SECONDARY, DESTRUCTIVE }

/** 决策按钮：48dp 触达高度，正文同档字号。`fillsWidth` 需要 RowScope，故声明为其扩展。 */
@Composable
private fun RowScope.DecisionButton(
    text: String,
    kind: DecisionKind,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    fillsWidth: Boolean = false,
    loading: Boolean = false,
    onClick: () -> Unit,
) {
    val shared = modifier
        .height(48.dp)
        .then(if (fillsWidth) Modifier.weight(1f) else Modifier)
    val contentPadding = PaddingValues(horizontal = TTSpacing.lg)

    when (kind) {
        DecisionKind.PRIMARY -> Button(
            onClick = onClick,
            enabled = enabled && !loading,
            modifier = shared,
            shape = TTRadius.Shapes.md,
            contentPadding = contentPadding,
            colors = ButtonDefaults.buttonColors(
                containerColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                contentColor = Color.White,
            ),
        ) {
            if (loading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = Color.White,
                )
                Spacer(Modifier.width(TTSpacing.xs))
            }
            Text(text, style = TTFonts.bodySemibold, maxLines = 1)
        }

        DecisionKind.SECONDARY, DecisionKind.DESTRUCTIVE -> OutlinedButton(
            onClick = onClick,
            enabled = enabled && !loading,
            modifier = shared,
            shape = TTRadius.Shapes.md,
            contentPadding = contentPadding,
            colors = ButtonDefaults.outlinedButtonColors(
                contentColor = if (kind == DecisionKind.DESTRUCTIVE) {
                    ChatCardTokens.riskHigh()
                } else {
                    ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
                },
            ),
        ) {
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(TTSpacing.xs))
            }
            Text(text, style = TTFonts.bodySemibold, maxLines = 1)
        }
    }
}

// MARK: - 小工具

@Composable
private fun ApprovalSeverity.iconColor(): Color = when (this) {
    ApprovalSeverity.CRITICAL -> ChatCardTokens.riskHigh()
    ApprovalSeverity.WARNING -> ChatCardTokens.riskMedium()
    ApprovalSeverity.NEUTRAL -> ttColor(TTColors.Primary, TTColors.Dark.Primary)
}

@Composable
private fun rememberValueLabels(): ApprovalValueLabels {
    val yes = stringResource(R.string.common_yes)
    val no = stringResource(R.string.common_no)
    return remember(yes, no) { ApprovalValueLabels(yes = yes, no = no) }
}

@Composable
private fun actionVerb(action: ApprovalActionRequest): String =
    stringResource(ToolVerbs.resIdFor(action.toolName))

private fun commonScopes(actions: List<ApprovalActionRequest>): List<String> {
    if (actions.isEmpty()) return emptyList()
    val common = actions.map { it.allowedScopes.toSet() }.reduce { acc, set -> acc.intersect(set) }
    return listOf("once", "thread", "always").filter { it in common }
}

private fun commonOutcomes(actions: List<ApprovalActionRequest>): List<String> {
    if (ApprovalPresentation.detailsAreRedacted(actions)) return emptyList()
    if (actions.isEmpty()) return emptyList()
    val common = actions.map { it.allowedOutcomes.toSet() }.reduce { acc, set -> acc.intersect(set) }
    return listOf("allow", "deny").filter { it in common }
}

/** 行首倒计时（mm:ss）。超过一小时不显示——那种时间尺度上秒级倒数只会制造无谓的紧迫感。 */
private fun formatCountdown(remainingSec: Long?): String? {
    if (remainingSec == null || remainingSec <= 0L || remainingSec >= 3600L) return null
    return "%d:%02d".format(remainingSec / 60L, remainingSec % 60L)
}

private fun toolDisplayName(action: ApprovalActionRequest): String {
    val ns = action.toolNamespace
    return if (!ns.isNullOrBlank()) "$ns.${action.toolName}" else action.toolName
}

/**
 * slug 转 Android resource name：全小写 + 非字母数字替换为下划线 + 去首尾下划线。
 *
 * 例："private-key" → "private_key"，"fork bomb" → "fork_bomb"。
 */
private fun slugToResName(slug: String): String =
    slug.lowercase()
        .replace(Regex("[^a-z0-9]+"), "_")
        .trim('_')

/**
 * 从 strings.xml 按 category slug 查找本地化业务名（L-W6-22）。
 * 例："ssh" → "chat_approval_sensitive_category_ssh" → "SSH 凭据"。
 * 找不到时回退到原始 slug。
 */
private fun localizedCategoryLabel(slug: String, context: android.content.Context): String {
    if (slug.isEmpty()) return slug
    val resName = "chat_approval_sensitive_category_${slugToResName(slug)}"
    val resId = context.resources.getIdentifier(resName, "string", context.packageName)
    return if (resId != 0) context.getString(resId) else slug
}

/**
 * 从 strings.xml 按 hardline pattern slug 查找本地化业务名（L-W6-23）。
 * 例："fork bomb" → "chat_approval_hardline_pattern_fork_bomb" → "Fork 炸弹（无限创建进程）"。
 * 找不到时回退到原始 slug。
 */
private fun localizedPatternLabel(slug: String, context: android.content.Context): String {
    if (slug.isEmpty()) return slug
    val resName = "chat_approval_hardline_pattern_${slugToResName(slug)}"
    val resId = context.resources.getIdentifier(resName, "string", context.packageName)
    return if (resId != 0) context.getString(resId) else slug
}

/**
 * L-W6-16（W6 M4） + M4.1 L-W6-22/23/24：
 *   - category / pattern 经过 slug→业务名 mapping（不再直接显示原始 slug）。
 *   - memo_allow / memo_deny 优先用 scope_description（"总是允许推送代码"），
 *     缺失时回退到 pattern_key。
 *
 * Legacy 19 种 reason 保留原映射做 trace replay 兼容。
 */
private fun decisionReasonText(action: ApprovalActionRequest, context: android.content.Context): String? {
    val type = action.decisionReasonType ?: return null
    if (type.isEmpty()) return null
    val fields = action.decisionReasonFields.orEmpty()

    fun field(k: String): String = fields[k].orEmpty()

    return when (type) {
        // ── W6 v3 judge 16 种（L-W6-16 扩展）───────────────────────────
        "hardline_command" -> {
            val rawPattern = field("pattern")
            if (rawPattern.isEmpty()) context.getString(R.string.chat_approval_reason_hardline)
            else {
                val label = localizedPatternLabel(rawPattern, context)
                context.getString(R.string.chat_approval_reason_hardline_command, label)
            }
        }
        "hardline_path" -> {
            val rawPattern = field("pattern")
            if (rawPattern.isEmpty()) context.getString(R.string.chat_approval_reason_hardline)
            else {
                val label = localizedPatternLabel(rawPattern, context)
                context.getString(R.string.chat_approval_reason_hardline_path, label)
            }
        }
        "sensitive_in_ask" -> {
            val path = field("path")
            val rawCategory = field("category")
            if (path.isEmpty()) context.getString(R.string.chat_approval_reason_path)
            else {
                val categoryLabel = localizedCategoryLabel(rawCategory, context)
                context.getString(R.string.chat_approval_reason_sensitive_in_ask, path, categoryLabel)
            }
        }
        "sensitive_out_deny" -> {
            val path = field("path")
            val rawCategory = field("category")
            if (path.isEmpty()) context.getString(R.string.chat_approval_reason_path)
            else {
                val categoryLabel = localizedCategoryLabel(rawCategory, context)
                context.getString(R.string.chat_approval_reason_sensitive_out_deny, path, categoryLabel)
            }
        }
        "memo_allow" -> {
            // L-W6-24：优先用 scope_description，缺失时回退到 key
            val scopeDesc = field("scope_description")
            val key = field("key")
            val label = scopeDesc.ifEmpty { key }
            if (label.isEmpty()) null
            else context.getString(R.string.chat_approval_reason_memo_allow, label)
        }
        "memo_deny" -> {
            val scopeDesc = field("scope_description")
            val key = field("key")
            val label = scopeDesc.ifEmpty { key }
            if (label.isEmpty()) null
            else context.getString(R.string.chat_approval_reason_memo_deny, label)
        }
        "yolo_allow" -> context.getString(R.string.chat_approval_reason_yolo_allow)
        "workspace_in" -> {
            val path = field("path")
            if (path.isEmpty()) null
            else if (field("kind") == "cwd")
                context.getString(R.string.chat_approval_reason_workspace_in_cwd, path)
            else context.getString(R.string.chat_approval_reason_workspace_in, path)
        }
        "workspace_out" -> {
            val path = field("path")
            if (path.isEmpty()) null
            else if (field("kind") == "cwd")
                context.getString(R.string.chat_approval_reason_workspace_out_cwd, path)
            else context.getString(R.string.chat_approval_reason_workspace_out, path)
        }
        "object_default_allow" -> context.getString(R.string.chat_approval_reason_object_default_allow)
        "object_write_ask" -> context.getString(R.string.chat_approval_reason_object_write_ask)
        "mcp_default_ask" -> {
            val server = field("server")
            if (server.isEmpty()) context.getString(R.string.chat_approval_reason_mcp_default_ask_no_server)
            else context.getString(R.string.chat_approval_reason_mcp_default_ask, server)
        }
        "device_default_ask" -> {
            val deviceAction = field("device_action")
            if (deviceAction.isEmpty()) context.getString(R.string.chat_approval_reason_device_default_ask_no_action)
            else context.getString(R.string.chat_approval_reason_device_default_ask, deviceAction)
        }
        "device_observe_allow" -> context.getString(R.string.chat_approval_reason_device_observe_allow)
        "plan_blocked" -> context.getString(R.string.chat_approval_reason_plan_blocked)
        "fallback_ask" -> context.getString(R.string.chat_approval_reason_fallback_ask)
        // ── Legacy 19 种（W1A 轮 2，兼容 trace replay）──────────────────
        "plan_guard" -> context.getString(R.string.chat_approval_reason_plan_guard)
        "hardline_block", "hardline_confirm" ->
            context.getString(R.string.chat_approval_reason_hardline)
        "skill_trust_downgrade", "skill_not_approved" ->
            context.getString(R.string.chat_approval_reason_skill_trust)
        "rule_high_risk_allowlist_miss" ->
            context.getString(R.string.chat_approval_reason_high_risk)
        "deny_read_path", "deny_write_path", "sandbox_readonly" ->
            context.getString(R.string.chat_approval_reason_path)
        "bash_too_complex", "bash_parse_unavailable" ->
            context.getString(R.string.chat_approval_reason_bash_complex)
        "user_interactive", "fallback_preset" ->
            context.getString(R.string.chat_approval_reason_user_interactive)
        else -> null
    }
}

/**
 * remaining < 60s   → "X 秒后过期"（红色高亮交给调用方）
 * remaining < 30min → "约 X 分钟后过期"
 * remaining ≥ 30min → null（不打扰）
 */
private fun formatExpiresHint(remainingSec: Long, context: android.content.Context): String? {
    return when {
        remainingSec <= 0L -> context.getString(R.string.chat_approval_expires_passed)
        remainingSec < 60L -> context.getString(R.string.chat_approval_expires_seconds, remainingSec)
        remainingSec < 30L * 60L -> {
            val minutes = (remainingSec + 30L) / 60L
            context.getString(R.string.chat_approval_expires_minutes, minutes)
        }
        else -> null
    }
}
