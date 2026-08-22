package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Description
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.PlanApprovalSnapshot
import com.tabtin.mobile.features.conversation.cards.ChatCardTokens
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * Wave 4 I8 — plan.exit 审批面板（legacy `plan_approval_required` 事件通道）。
 *
 * 视觉对照 Electron `PlanApprovalNotice.tsx` + `PlanApprovalDialog`，
 * 在移动端简化为竖排卡片（标题 + 简介 + Plan 名称 + Todo 摘要 + 操作按钮）。
 *
 * 决策（产品视角）：
 *  - **Approve / Reject / Cancel 三态**：Cancel 走 `ChatRepository.submitPlanApproval(outcome='cancelled')`
 *    上行（Wave 4 已就位），对齐 Daemon `PlanApprovalIpcResponsePayloadSchema` 的 cancelled 枚举。
 *    `ConversationViewModel.dismissPlanApproval()` 也走这条路径——下面 `onCancel` 按钮按键等价于
 *    用户主动关面板时的"撤回决策"。
 *  - **不在面板里嵌 Plan 文档编辑器**——移动端窄屏体验差，引导跳到 TabDoc 全屏查看；
 *  - **edited markdown 字段不暴露**——首版简化，编辑要在 TabDoc 完成后再回审批面板。
 *
 *  ⚠️ 与新版 `approval_requested` 通道区分：新版走 [ApprovalPanelView] + `localrt.user_response`
 *  （outcome ∈ allow/deny/cancelled），两条通道的 outcome 值域不同，不要互换 handler。
 */
@Composable
internal fun PlanApprovalPanelView(
    pending: PendingPlanApproval,
    isSubmitting: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    onCancel: () -> Unit,
    onOpenPlan: (planDocumentId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = TTRadius.Shapes.md
    // 真实用户视角 Review：spinner 不能两个按钮一起转，否则用户分不清自己点的是哪个；
    // 用 lastClicked 记忆 → 仅在被点击的按钮上显示进度，未点击的按钮置 disabled。
    var lastClicked by remember(pending.requestId) { mutableStateOf<String?>(null) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .border(1.dp, ChatCardTokens.borderWarning(), shape)
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Default.Description,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = ChatCardTokens.riskMedium(),
            )
            Spacer(Modifier.width(TTSpacing.xs))
            Text(
                stringResource(R.string.chat_plan_approval_title),
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
        }

        // 主描述：snapshot 有 overview 时优先 overview，否则用通用兜底文案
        val description = pending.planSnapshot?.overview?.takeIf { it.isNotBlank() }
            ?: stringResource(R.string.chat_plan_approval_description)
        Text(
            description,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
        )

        // Plan 名称
        pending.planSnapshot?.name?.takeIf { it.isNotBlank() }?.let { planName ->
            Text(
                planName,
                style = TTFonts.bodySemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
        }

        // Todo 摘要（最多 3 条）
        pending.planSnapshot?.let { snapshot ->
            if (snapshot.todos.isNotEmpty()) {
                PlanTodoSummary(snapshot)
            }
        }

        // 没有 snapshot 时给出引导文案
        if (pending.planSnapshot == null) {
            Text(
                stringResource(R.string.chat_plan_approval_no_snapshot),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }

        // 打开 Plan 文档（如果有 planDocumentId）
        if (pending.planDocumentId.isNotBlank()) {
            TextButton(
                onClick = { onOpenPlan(pending.planDocumentId) },
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    horizontal = TTSpacing.xs,
                    vertical = 0.dp,
                ),
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.OpenInNew,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                )
                Spacer(Modifier.width(TTSpacing.xxs))
                Text(
                    stringResource(R.string.chat_plan_approval_open_doc),
                    style = TTFonts.captionSemibold,
                    color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                )
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            val cancelInProgress = isSubmitting && lastClicked == "cancel"
            val rejectInProgress = isSubmitting && lastClicked == "reject"
            val approveInProgress = isSubmitting && lastClicked == "approve"
            OutlinedButton(
                onClick = {
                    if (!isSubmitting) {
                        lastClicked = "cancel"
                        onCancel()
                    }
                },
                modifier = Modifier.weight(1f),
                enabled = !isSubmitting,
            ) {
                if (cancelInProgress) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text(
                        stringResource(R.string.common_cancel),
                        style = TTFonts.captionSemibold,
                    )
                }
            }
            OutlinedButton(
                onClick = {
                    if (!isSubmitting) {
                        lastClicked = "reject"
                        onReject()
                    }
                },
                modifier = Modifier.weight(1f),
                enabled = !isSubmitting,
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = ChatCardTokens.riskHigh(),
                ),
            ) {
                if (rejectInProgress) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text(
                        stringResource(R.string.chat_plan_approval_reject),
                        style = TTFonts.captionSemibold,
                    )
                }
            }
            Button(
                onClick = {
                    if (!isSubmitting) {
                        lastClicked = "approve"
                        onApprove()
                    }
                },
                modifier = Modifier.weight(1f),
                enabled = !isSubmitting,
                colors = ButtonDefaults.buttonColors(
                    containerColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    contentColor = Color.White,
                ),
            ) {
                if (approveInProgress) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = Color.White,
                    )
                } else {
                    Text(
                        stringResource(R.string.chat_plan_approval_approve),
                        style = TTFonts.captionSemibold,
                    )
                }
            }
        }
    }
}

@Composable
private fun PlanTodoSummary(snapshot: PlanApprovalSnapshot) {
    val visibleTodos = snapshot.todos.take(MAX_TODO_PREVIEW)
    val remaining = (snapshot.todos.size - visibleTodos.size).coerceAtLeast(0)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.Background, TTColors.Dark.Background))
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            stringResource(R.string.chat_plan_approval_todos_label),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        )
        visibleTodos.forEach { todo ->
            Text(
                "• ${todo.content}",
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (remaining > 0) {
            Text(
                "+$remaining",
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

private const val MAX_TODO_PREVIEW = 3
