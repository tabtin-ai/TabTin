package com.tabtin.mobile.features.conversation

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.view.HapticFeedbackConstants
import android.widget.Toast
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.outlined.FormatQuote
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.ModeSwitchProposal
import com.tabtin.mobile.data.model.PlanProposal
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.features.space.AgentIdentityAvatar
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import com.tabtin.mobile.ui.theme.TTBubbleShape
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.rememberReduceMotion
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter

internal const val TRUNCATE_LENGTH = 500

@Composable
internal fun ChatBubble(
    message: ChatMessage,
    assistantFace: AgentFace? = null,
    isHighlighted: Boolean = false,
    currentSpaceId: String? = null,
    currentOrganizationId: String? = null,
    onOpenInWorkbench: ((WorkbenchResourceOpenRequest) -> Unit)? = null,
    formalMediaArtifactToolUseIds: Set<String> = emptySet(),
    /** 兼容调用方；等待壳已只认 [AgentAwaitingThoughtPhase]，不再消费本参数。 */
    @Suppress("UNUSED_PARAMETER")
    currentPhase: AgentPhase = AgentPhase.IDLE,
    /** 兼容调用方；工具名不再旁路进等待壳文案。 */
    @Suppress("UNUSED_PARAMETER")
    currentToolName: String? = null,
    canRewind: Boolean = false,
    onRewindToHere: (() -> Unit)? = null,
    onRollbackAgentRun: ((String) -> Unit)? = null,
    checkpointHealth: com.tabtin.mobile.features.conversation.checkpoint.CheckpointHealth =
        com.tabtin.mobile.features.conversation.checkpoint.CheckpointHealth.HEALTHY,
    onNavigateToWallet: (() -> Unit)? = null,
    onNoticeAction: ((String) -> Unit)? = null,
    // Wave 5 S4: error_class suggested_action='shorten_context' 的动作按钮 handler。
    // null 时按钮不渲染（避免死按钮），与 Electron shorten_context → useChatStore.createSession 对齐。
    onStartNewSession: (() -> Unit)? = null,
    // Wave 5 用户视角 Review：error_class suggested_action='relogin' 的动作按钮 handler。
    // 点击按钮后 ChatErrorClassCard 会先弹 AlertDialog 二次确认，确认后才触发本 handler。
    // null 时按钮不渲染（与 onStartNewSession 同保护策略）。
    onRelogin: (() -> Unit)? = null,
    // Wave 6 A3：从此消息 Fork（对齐 iOS `ConversationScreen.contextMenu` forkSession）。
    // 传入时 ChatBubble 的助手消息长按菜单里会出现"从此分叉"项；null 时隐藏。
    // 用户消息由外层 MessageContextMenuHost 负责渲染 Fork 菜单项，不经本参数。
    onForkFromMessage: (() -> Unit)? = null,
    onQuoteMessage: (() -> Unit)? = null,
    onExecutePlan: (PlanProposal) -> Unit = {},
    onApproveModeSwitch: (ModeSwitchProposal) -> Unit = {},
    onIgnoreProposal: (String) -> Unit = {},
) {
    val isUser = message.isUser
    val context = LocalContext.current
    // ：空壳中断整行不占时间线（投影层已滤；此处再挡一层防漏）。
    if (!isUser && isEmptyInterruptedAssistantShell(message)) {
        return
    }
    val rawText = if (isUser) message.displayContent
               else ErrorContentLocalizer.localize(message.displayContent, context)
    // ：过滤 runtime 英文兜底诊断，不直接展示给用户（对齐 iOS）。
    val text = if (!isUser && isRuntimeAbortDiagnostic(rawText)) "" else rawText
    val sentQuote = if (isUser) remember(text) { MessageQuote.parseComposerDraft(text) } else null
    val truncatableText = sentQuote?.reply ?: text
    var expanded by remember(message.id) { mutableStateOf(false) }
    val shouldTruncate = !message.isStreaming && truncatableText.length > TRUNCATE_LENGTH
    val displayText = if (shouldTruncate && !expanded) {
        truncatableText.take(TRUNCATE_LENGTH)
    } else {
        truncatableText
    }

    val imageAttachments = message.imageAttachments
    val fileAttachments = message.fileAttachments
    val contextRefs = remember(message.blocksJson) {
        ContextRefBlockPolicy.extract(message.blocksJson)
    }
    val askUserResult = remember(message.messageKind, message.metadata) {
        AskUserResultPresentation.from(message)
    }

    val highlightShape = RoundedCornerShape(12.dp)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (isHighlighted) {
                    Modifier
                        .background(
                            ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.12f),
                            highlightShape,
                        )
                        .border(
                            1.5.dp,
                            ttColor(TTColors.BorderFocused, TTColors.Dark.BorderFocused).copy(alpha = 0.7f),
                            highlightShape,
                        )
                } else {
                    Modifier
                },
            ),
    ) {
        if (askUserResult != null) {
            AskUserResultCard(askUserResult)
        } else if (isUser) {
            UserBubble(
                displayText = displayText,
                sentQuote = sentQuote,
                shouldTruncate = shouldTruncate,
                expanded = expanded,
                onToggleExpand = { expanded = !expanded },
                imageAttachments = imageAttachments,
                fileAttachments = fileAttachments,
                contextRefs = contextRefs,
                onOpenInWorkbench = onOpenInWorkbench,
                createdAt = message.createdAt,
            )
        } else {
            AssistantBlock(
                message = message,
                assistantFace = assistantFace,
                displayText = displayText,
                shouldTruncate = shouldTruncate,
                expanded = expanded,
                onToggleExpand = { expanded = !expanded },
                imageAttachments = imageAttachments,
                fileAttachments = fileAttachments,
                canRewind = canRewind,
                onRewindToHere = onRewindToHere,
                onRollbackAgentRun = onRollbackAgentRun,
                checkpointHealth = checkpointHealth,
                onNavigateToWallet = onNavigateToWallet,
                onNoticeAction = onNoticeAction,
                onStartNewSession = onStartNewSession,
                onRelogin = onRelogin,
                onForkFromMessage = onForkFromMessage,
                onQuoteMessage = onQuoteMessage,
                onExecutePlan = onExecutePlan,
                onApproveModeSwitch = onApproveModeSwitch,
                onIgnoreProposal = onIgnoreProposal,
                currentSpaceId = currentSpaceId,
                currentOrganizationId = currentOrganizationId,
                onOpenInWorkbench = onOpenInWorkbench,
                formalMediaArtifactToolUseIds = formalMediaArtifactToolUseIds,
            )
        }
    }
}

@Composable
private fun AskUserResultCard(result: AskUserResultPresentation) {
    val shape = TTRadius.Shapes.md
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle), shape)
            .border(1.dp, ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight), shape)
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = Icons.Default.RadioButtonChecked,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess),
            )
            Spacer(Modifier.width(TTSpacing.sm))
            Text(
                text = stringResource(R.string.chat_ask_result_completed),
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }
        result.questions.forEach { question ->
            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                Text(
                    text = question.prompt,
                    style = ConversationTypography.body,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                )
                question.answers.forEach { answer ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.08f),
                                TTRadius.Shapes.sm,
                            )
                            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            imageVector = Icons.Default.RadioButtonChecked,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                        )
                        Spacer(Modifier.width(TTSpacing.sm))
                        Text(
                            text = answer,
                            style = TTFonts.body,
                            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun UserBubble(
    displayText: String,
    sentQuote: ComposerMessageQuote?,
    shouldTruncate: Boolean,
    expanded: Boolean,
    onToggleExpand: () -> Unit,
    imageAttachments: List<BlockItem>,
    fileAttachments: List<BlockItem>,
    contextRefs: List<BlockItem>,
    onOpenInWorkbench: ((WorkbenchResourceOpenRequest) -> Unit)?,
    createdAt: String?,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
    ) {
        Spacer(Modifier.width(60.dp))
        Column(horizontalAlignment = Alignment.End) {
            if (imageAttachments.isNotEmpty() || fileAttachments.isNotEmpty()) {
                MessageAttachments(imageAttachments + fileAttachments)
                Spacer(Modifier.height(TTSpacing.xs))
            }

            if (displayText.isNotBlank() || sentQuote != null) {
                val bubbleBgColor = ttColor(TTColors.BgBubbleOutgoing, TTColors.Dark.BgBubbleOutgoing)
                val reduceMotion = rememberReduceMotion()
                Box(
                    modifier = Modifier
                        // spring 替代 tween：展开/收起中途反向不会急停；系统关动画时瞬时完成。
                        .animateContentSize(
                            animationSpec = if (reduceMotion) {
                                snap()
                            } else {
                                spring(stiffness = Spring.StiffnessMediumLow)
                            },
                        )
                        .background(color = bubbleBgColor, shape = TTBubbleShape.outgoing),
                ) {
                    Column(
                        modifier = Modifier.padding(
                            horizontal = TTSpacing.md,
                            vertical = TTSpacing.sm + 2.dp,
                        ),
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    ) {
                        sentQuote?.let { SentMessageQuote(it) }
                        if (displayText.isNotBlank()) {
                            Text(
                                text = displayText,
                                style = ConversationTypography.body,
                                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                            )
                        }
                    }

                    if (shouldTruncate && !expanded) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(48.dp)
                                .align(Alignment.BottomCenter)
                                .background(
                                    Brush.verticalGradient(
                                        colors = listOf(bubbleBgColor.copy(alpha = 0f), bubbleBgColor),
                                        startY = 0f,
                                        endY = Float.POSITIVE_INFINITY,
                                    )
                                )
                                .clickable(role = Role.Button, onClick = onToggleExpand),
                            contentAlignment = Alignment.BottomCenter,
                        ) {
                            Icon(
                                Icons.Default.KeyboardArrowDown,
                                contentDescription = stringResource(R.string.common_expand_all),
                                modifier = Modifier.size(16.dp).padding(bottom = 2.dp),
                                tint = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary).copy(alpha = 0.7f),
                            )
                        }
                    }
                }

                if (shouldTruncate && expanded) {
                    Text(
                        text = stringResource(R.string.common_collapse),
                        color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                        style = TTFonts.caption,
                        modifier = Modifier
                            .padding(top = TTSpacing.xxs)
                            .clickable(role = Role.Button, onClick = onToggleExpand),
                    )
                }
            }

            if (contextRefs.isNotEmpty()) {
                if (displayText.isNotBlank() || sentQuote != null) {
                    Spacer(Modifier.height(TTSpacing.xs))
                }
                Column(
                    horizontalAlignment = Alignment.End,
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    contextRefs.forEach { ref ->
                        ContextRefBlockCard(
                            block = ref,
                            onOpenInWorkbench = onOpenInWorkbench,
                            modifier = Modifier.widthIn(max = 280.dp),
                        )
                    }
                }
            }

            createdAt?.let { ts ->
                RelativeTimeFormatter.formatTime(ts)?.let { t ->
                    Text(
                        text = t,
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        modifier = Modifier.padding(top = TTSpacing.xxs),
                    )
                }
            }
        }
    }
}

@Composable
private fun SentMessageQuote(quote: ComposerMessageQuote) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
                RoundedCornerShape(TTRadius.interactive),
            )
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Box(
            modifier = Modifier
                .size(24.dp)
                .background(
                    ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent).copy(alpha = 0.10f),
                    CircleShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Outlined.FormatQuote,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(
                    if (quote.author == "我") {
                        R.string.chat_composer_quote_self
                    } else {
                        R.string.chat_composer_quote_agent
                    },
                ),
                style = TTFonts.metaMedium,
                color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                maxLines = 1,
            )
            Text(
                text = quote.content.replace('\n', ' '),
                style = ConversationTypography.meta,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                maxLines = 1,
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AssistantBlock(
    message: ChatMessage,
    assistantFace: AgentFace?,
    currentSpaceId: String? = null,
    currentOrganizationId: String? = null,
    onOpenInWorkbench: ((WorkbenchResourceOpenRequest) -> Unit)? = null,
    formalMediaArtifactToolUseIds: Set<String> = emptySet(),
    displayText: String,
    shouldTruncate: Boolean,
    expanded: Boolean,
    onToggleExpand: () -> Unit,
    imageAttachments: List<BlockItem>,
    fileAttachments: List<BlockItem>,
    canRewind: Boolean = false,
    onRewindToHere: (() -> Unit)? = null,
    onRollbackAgentRun: ((String) -> Unit)? = null,
    checkpointHealth: com.tabtin.mobile.features.conversation.checkpoint.CheckpointHealth =
        com.tabtin.mobile.features.conversation.checkpoint.CheckpointHealth.HEALTHY,
    onNavigateToWallet: (() -> Unit)? = null,
    onNoticeAction: ((String) -> Unit)? = null,
    onStartNewSession: (() -> Unit)? = null,
    onRelogin: (() -> Unit)? = null,
    onForkFromMessage: (() -> Unit)? = null,
    onQuoteMessage: (() -> Unit)? = null,
    onExecutePlan: (PlanProposal) -> Unit = {},
    onApproveModeSwitch: (ModeSwitchProposal) -> Unit = {},
    onIgnoreProposal: (String) -> Unit = {},
) {
    var showContextMenu by remember { mutableStateOf(false) }
    var showAgentRunRollbackConfirm by remember { mutableStateOf(false) }
    val isBillingError = message.errorCategory != null
        && message.errorCategory in com.tabtin.mobile.data.model.AppError.BillingBlocked.CATEGORIES
    val context = LocalContext.current
    val view = LocalView.current
    val copyableText = message.displayContent.takeUnless { isRuntimeAbortDiagnostic(it) }.orEmpty()
    val canCopy = copyableText.isNotBlank()
    val resolvedErrorClassInfo = if (!isBillingError) message.resolveErrorClassInfo(context) else null
    //  / Electron ：ABORT 是中性中断——抑制错误卡，改挂灰色「已中断」徽标。
    val isNeutralInterrupt = isNeutralInterruption(message) ||
        resolvedErrorClassInfo?.errorClass == "ABORT" ||
        resolvedErrorClassInfo?.severity == ChatErrorSeverity.NEUTRAL
    val errorClassInfo = resolvedErrorClassInfo?.takeUnless {
        it.errorClass == "ABORT" || it.severity == ChatErrorSeverity.NEUTRAL
    }
    val showInterruptedBadge = isNeutralInterrupt && errorClassInfo == null
    // Wave 6 §7 + 协议对照 Review P1-3：与 Electron MessageBubble.tsx:703-712 /
    // iOS MarkdownBubble.swift:141-148 对齐。
    //
    // 之前只比对 title/suggestion（Wave 5 Android 初版），导致正文 + 错误卡会叠一层。
    // 本轮补齐 5 条判定，覆盖 `displayText` 与 `rawContent` 两路（ErrorContentLocalizer 会把
    // "[CODE] 原文" 转成本地化长文本，两者不一定相等）：
    //   1) displayText / rawContent == errorMessage（iOS `effectiveErrorMessage`，Electron 并列）
    //   2) displayText / rawContent == info.suggestedAction（iOS `info.suggestedAction`，Electron 并列）
    //   3) rawContent 以 `^\[\w+\]\s` 前缀开头（iOS / Electron 同正则；老 agent 路径用
    //      "[CODE] msg" 作错误文本的兜底判定）
    val errorMessageText = message.metadataString("errorMessage") ?: message.metadataString("error_message")
    val rawContent = message.content
    val rawContentTrimmed = rawContent.trim()
    val displayTrim = displayText.trim()
    val errorMessageTrim = errorMessageText?.trim()
    val suggestedActionTrim = errorClassInfo?.suggestedAction?.trim()
    val errorClassSkipContent = errorClassInfo != null && (
        displayText.isBlank() ||
            displayTrim == errorClassInfo.title.trim() ||
            displayTrim == errorClassInfo.suggestion.trim() ||
            (errorMessageTrim != null && displayTrim == errorMessageTrim) ||
            (errorMessageTrim != null && rawContentTrimmed == errorMessageTrim) ||
            (suggestedActionTrim != null && displayTrim == suggestedActionTrim) ||
            (suggestedActionTrim != null && rawContentTrimmed == suggestedActionTrim) ||
            rawContent.matches(Regex("^\\[\\w+\\]\\s.*", RegexOption.DOT_MATCHES_ALL))
        )

    // 菜单触发条件：复制 / 回滚 / Fork 任一可用即长按可用。
    val canFork = onForkFromMessage != null && !message.isStreaming
    val canQuote = onQuoteMessage != null && MessageQuote.payload(message) != null
    val canShowMenu = canCopy || canQuote || (canRewind && onRewindToHere != null) || canFork
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (canShowMenu) {
                    Modifier.combinedClickable(
                        onClick = {},
                        onLongClick = { showContextMenu = true },
                        onLongClickLabel = stringResource(R.string.chat_message_action_label),
                    )
                } else Modifier
            ),
        horizontalAlignment = Alignment.Start,
    ) {
        message.planProposal?.let { proposal ->
            PlanProposalCard(
                message = message,
                proposal = proposal,
                onExecute = onExecutePlan,
                onIgnore = onIgnoreProposal,
            )
            return@Column
        }
        message.modeSwitchProposal?.let { proposal ->
            ModeSwitchProposalCard(
                message = message,
                proposal = proposal,
                onApprove = onApproveModeSwitch,
                onIgnore = onIgnoreProposal,
            )
            return@Column
        }

        assistantFace?.takeIf { it.name.isNotBlank() }?.let { face ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(bottom = TTSpacing.xs),
            ) {
                AgentIdentityAvatar(
                    name = face.name,
                    avatarKey = face.avatarKey,
                    avatarUrl = face.avatarUrl,
                    size = 20.dp,
                )
                Text(
                    text = face.name,
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    modifier = Modifier.padding(start = TTSpacing.xs),
                )
            }
        }

        val timelineItems = remember(
            message.blocksJson,
            message.reasoning,
            message.agentSteps,
            displayText,
            isNeutralInterrupt,
        ) {
            val items = assistantTimelineItems(message, displayText)
            // ：中性中断时滤掉 runtime 英文兜底诊断文本块（对齐 iOS MessageBubbleView）。
            if (!isNeutralInterrupt) {
                items
            } else {
                items.filterNot { item ->
                    item is AssistantTimelineItem.Text && isRuntimeAbortDiagnostic(item.content)
                }
            }
        }

        if (message.isStreaming && displayText.isEmpty() && timelineItems.isEmpty() && !showInterruptedBadge) {
            StreamingStatusIndicator(
                awaitingPhase = AgentAwaitingThoughtPhase.PENDING,
            )
        } else if (isBillingError && onNavigateToWallet != null) {
            BillingErrorCard(
                errorCategory = message.errorCategory,
                message = displayText,
                onNavigateToWallet = onNavigateToWallet,
            )
        } else if (errorClassInfo != null && errorClassSkipContent) {
            ChatErrorClassCard(
                info = errorClassInfo,
                onNavigateToWallet = onNavigateToWallet,
                onStartNewSession = onStartNewSession,
                onRelogin = onRelogin,
            )
        } else {
            if (timelineItems.isNotEmpty()) {
                AssistantTimeline(
                    items = timelineItems,
                    isStreaming = message.isStreaming,
                    currentSpaceId = currentSpaceId,
                    currentOrganizationId = currentOrganizationId,
                    onOpenInWorkbench = onOpenInWorkbench,
                    formalMediaArtifactToolUseIds = formalMediaArtifactToolUseIds,
                )
            } else if (
                displayText.isNotBlank() ||
                imageAttachments.isNotEmpty() ||
                fileAttachments.isNotEmpty()
            ) {
                LegacyAssistantContent(
                    message = message,
                    displayText = displayText,
                    shouldTruncate = shouldTruncate,
                    expanded = expanded,
                    onToggleExpand = onToggleExpand,
                    imageAttachments = imageAttachments,
                    fileAttachments = fileAttachments,
                    onNoticeAction = onNoticeAction,
                    currentSpaceId = currentSpaceId,
                    currentOrganizationId = currentOrganizationId,
                    onOpenInWorkbench = onOpenInWorkbench,
                )
            }
            if (errorClassInfo != null && !errorClassSkipContent) {
                Spacer(Modifier.height(TTSpacing.xs))
                ChatErrorClassCard(
                    info = errorClassInfo,
                    onNavigateToWallet = onNavigateToWallet,
                    onStartNewSession = onStartNewSession,
                    onRelogin = onRelogin,
                )
            }
            if (showInterruptedBadge) {
                if (timelineItems.isNotEmpty() || displayText.isNotBlank()) {
                    Spacer(Modifier.height(TTSpacing.xs))
                }
                InterruptedBadge()
            }
        }

        if (shouldTruncate && expanded) {
            Text(
                text = stringResource(R.string.common_collapse),
                color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                style = TTFonts.caption,
                modifier = Modifier
                    .padding(start = TTSpacing.xs, top = TTSpacing.xxs)
                    .clickable(role = Role.Button, onClick = onToggleExpand),
            )
        }

        // Agent 消息不展示时间戳（对齐 Electron / iOS 气泡）。

        if (canShowMenu) {
            DropdownMenu(
                expanded = showContextMenu,
                onDismissRequest = { showContextMenu = false },
            ) {
                if (canCopy) {
                    DropdownMenuItem(
                        text = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
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
                            showContextMenu = false
                            copyAssistantMessage(context, view, copyableText)
                        },
                    )
                }

                if (canQuote) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.chat_message_action_quote), style = TTFonts.body) },
                        onClick = {
                            showContextMenu = false
                            onQuoteMessage()
                        },
                    )
                }

                // Wave 6 A3：Fork 菜单项（对齐 iOS `ConversationScreen.contextMenu` forkSession）。
                // 放在复制和回滚之间——fork 属于"继续协作"动作，优先级高于终止性的 rewind/rollback。
                if (canFork) {
                    DropdownMenuItem(
                        text = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
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
                            showContextMenu = false
                            onForkFromMessage.invoke()
                        },
                    )
                }

                if (canRewind && onRewindToHere != null) {
                    DropdownMenuItem(
                        text = {
                            Text(
                                stringResource(R.string.checkpoint_rewind_to_here),
                                style = TTFonts.body,
                            )
                        },
                        onClick = {
                            showContextMenu = false
                            onRewindToHere()
                        },
                    )
                }

                if (!message.agentRunId.isNullOrEmpty() && onRollbackAgentRun != null) {
                    DropdownMenuItem(
                        text = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    stringResource(R.string.checkpoint_rollback_agent_run),
                                    style = TTFonts.body,
                                )
                                if (checkpointHealth != com.tabtin.mobile.features.conversation.checkpoint.CheckpointHealth.HEALTHY) {
                                    Spacer(Modifier.width(4.dp))
                                    Box(
                                        modifier = Modifier
                                            .size(8.dp)
                                            .clip(CircleShape)
                                            .background(
                                                if (checkpointHealth == com.tabtin.mobile.features.conversation.checkpoint.CheckpointHealth.WARNING)
                                                    ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
                                                else
                                                    ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)
                                            ),
                                    )
                                }
                            }
                        },
                        onClick = {
                            showContextMenu = false
                            showAgentRunRollbackConfirm = true
                        },
                    )
                }
            }
        }

        if (showAgentRunRollbackConfirm && !message.agentRunId.isNullOrEmpty()) {
            androidx.compose.material3.AlertDialog(
                onDismissRequest = { showAgentRunRollbackConfirm = false },
                title = { Text(stringResource(R.string.checkpoint_rollback_agent_run_confirm_title)) },
                text = { Text(stringResource(R.string.checkpoint_rollback_agent_run_confirm_message)) },
                confirmButton = {
                    androidx.compose.material3.TextButton(
                        onClick = {
                            showAgentRunRollbackConfirm = false
                            onRollbackAgentRun?.invoke(message.agentRunId)
                        },
                    ) {
                        Text(stringResource(R.string.checkpoint_confirm_rewind))
                    }
                },
                dismissButton = {
                    androidx.compose.material3.TextButton(
                        onClick = { showAgentRunRollbackConfirm = false },
                    ) {
                        Text(stringResource(R.string.common_cancel))
                    }
                },
            )
        }

    }
}

@Composable
private fun PlanProposalCard(
    message: ChatMessage,
    proposal: PlanProposal,
    onExecute: (PlanProposal) -> Unit,
    onIgnore: (String) -> Unit,
) {
    var expanded by remember(message.id) { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                color = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
                shape = TTRadius.Shapes.md,
            )
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Text(
            text = proposal.planName.ifBlank { "执行计划" },
            style = ConversationTypography.bodySemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
        proposal.overview.takeIf { it.isNotBlank() }?.let {
            Text(
                text = it,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }
        proposal.todos.takeIf { it.isNotEmpty() }?.let { todos ->
            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                todos.take(5).forEach { todo ->
                    Text(
                        text = "• ${todo.content}",
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    )
                }
            }
        }
        if (proposal.descriptionMarkdown.isNotBlank()) {
            Text(
                text = if (expanded) proposal.descriptionMarkdown else "查看详情",
                style = TTFonts.caption,
                color = if (expanded) {
                    ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
                } else {
                    ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
                },
                modifier = Modifier.clickable { expanded = !expanded },
            )
        }
        ProposalActions(
            resolved = message.proposalResolved,
            primary = "执行",
            onPrimary = { onExecute(proposal) },
            onIgnore = { onIgnore(message.id) },
        )
    }
}

@Composable
private fun ModeSwitchProposalCard(
    message: ChatMessage,
    proposal: ModeSwitchProposal,
    onApprove: (ModeSwitchProposal) -> Unit,
    onIgnore: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                color = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
                shape = TTRadius.Shapes.md,
            )
            .padding(TTSpacing.md),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Text(
            text = "切换到 Agent 模式",
            style = ConversationTypography.bodySemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
        proposal.reason.takeIf { it.isNotBlank() }?.let {
            Text(
                text = it,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }
        ProposalActions(
            resolved = message.proposalResolved,
            primary = "切到 Agent 模式",
            onPrimary = { onApprove(proposal) },
            onIgnore = { onIgnore(message.id) },
        )
    }
}

@Composable
private fun ProposalActions(
    resolved: Boolean,
    primary: String,
    onPrimary: () -> Unit,
    onIgnore: () -> Unit,
) {
    if (resolved) {
        Text(
            text = "已处理",
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess),
        )
    } else {
        Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
            Button(onClick = onPrimary, modifier = Modifier.weight(1f)) {
                Text(primary)
            }
            OutlinedButton(onClick = onIgnore, modifier = Modifier.weight(1f)) {
                Text("忽略")
            }
        }
    }
}

/**
 * 助手消息内的有序时间线项。思考与工具保持各自身份——执行组只改变视觉分组，
 * 不把思考伪装成工具（分组与呈现口径见 [ExecutionStepPresentation]）。
 */
internal sealed class AssistantTimelineItem {
    data class Text(val content: String, val citationCount: Int = 0) : AssistantTimelineItem()
    data class Thinking(val content: String) : AssistantTimelineItem()
    data class Tool(val step: AgentStep) : AssistantTimelineItem()
    data class Rich(val block: BlockItem) : AssistantTimelineItem()
    data class Attachment(val block: BlockItem) : AssistantTimelineItem()
}

internal fun assistantTimelineItems(
    message: ChatMessage,
    displayText: String,
): List<AssistantTimelineItem> {
    val blocks = message.blocksJson.orEmpty()
    val items = mutableListOf<AssistantTimelineItem>()
    val toolItemIndexById = mutableMapOf<String, Int>()
    var hasTextBlock = false

    fun matchSubagentStep(toolId: String): AgentStep? =
        message.agentSteps?.firstOrNull { step ->
            if (step.type != StepType.SUBAGENT) return@firstOrNull false
            val snap = step.subagent ?: return@firstOrNull false
            snap.parentToolCallId == toolId ||
                step.id == "subagent-$toolId" ||
                snap.runId == toolId
        }

    fun upsertToolResult(
        toolUseId: String,
        output: String?,
        isError: Boolean,
        presentationKind: String? = null,
        presentationPrompt: String? = null,
    ) {
        val itemIndex = toolItemIndexById[toolUseId]
        if (itemIndex != null) {
            val item = items[itemIndex]
            if (item is AssistantTimelineItem.Tool) {
                // SUBAGENT 卡由 rehydrate / live reducer 维护；tool_result 不降级成 TOOL_CALL
                if (item.step.type == StepType.SUBAGENT) return
                items[itemIndex] = item.copy(
                    step = item.step.copy(
                        output = output ?: item.step.output,
                        status = if (isError) StepStatus.FAILED else StepStatus.COMPLETED,
                        presentationKind = presentationKind ?: item.step.presentationKind,
                        presentationPrompt = presentationPrompt ?: item.step.presentationPrompt,
                    )
                )
            }
        } else {
            val matched = matchSubagentStep(toolUseId)
            if (matched != null) {
                toolItemIndexById[toolUseId] = items.size
                items.add(AssistantTimelineItem.Tool(matched))
                return
            }
            val step = AgentStep(
                id = toolUseId,
                type = StepType.TOOL_CALL,
                name = toolUseId,
                status = if (isError) StepStatus.FAILED else StepStatus.COMPLETED,
                output = output,
                presentationKind = presentationKind,
                presentationPrompt = presentationPrompt,
            )
            toolItemIndexById[toolUseId] = items.size
            items.add(AssistantTimelineItem.Tool(step))
        }
    }

    blocks.forEachIndexed { position, block ->
        when (block.type) {
            "text" -> {
                val text = block.text ?: block.content
                val citationCount = block.citations.orEmpty().size
                if (!text.isNullOrBlank() || citationCount > 0) {
                    hasTextBlock = true
                    val previous = items.lastOrNull()
                    if (previous !is AssistantTimelineItem.Text ||
                        previous.content != text.orEmpty() ||
                        previous.citationCount != citationCount
                    ) {
                        items.add(AssistantTimelineItem.Text(text.orEmpty(), citationCount))
                    }
                }
            }
            "thinking" -> {
                val text = block.thinking ?: block.text ?: block.content
                if (!text.isNullOrBlank()) items.add(AssistantTimelineItem.Thinking(text))
            }
            "tool_use" -> {
                val toolId = block.id ?: block.toolUseId ?: "tool-$position"
                val matched = matchSubagentStep(toolId)
                val step = matched ?: AgentStep(
                    id = toolId,
                    type = StepType.TOOL_CALL,
                    name = block.name ?: toolId,
                    status = block.status?.let(StepStatus::fromString) ?: StepStatus.COMPLETED,
                    input = block.inputJson ?: block.input?.toString(),
                    output = block.resultText ?: block.output,
                    presentationKind = block.presentation?.kind,
                    presentationPrompt = block.presentation?.data?.prompt,
                )
                toolItemIndexById[toolId] = items.size
                items.add(AssistantTimelineItem.Tool(step))
            }
            "server_tool_use" -> {
                // 服务端 Web Search 与普通工具调用共享一个可折叠入口。
                val toolId = block.id ?: block.toolUseId ?: "server-tool-$position"
                val step = AgentStep(
                    id = toolId,
                    type = StepType.TOOL_CALL,
                    name = block.name ?: "web_search",
                    status = block.status?.let(StepStatus::fromString) ?: StepStatus.COMPLETED,
                    input = block.inputJson ?: block.input?.toString(),
                )
                toolItemIndexById[toolId] = items.size
                items.add(AssistantTimelineItem.Tool(step))
            }
            "tool_result" -> {
                val toolId = block.toolUseId ?: block.id ?: return@forEachIndexed
                val output = block.resultText ?: block.output ?: block.content ?: block.text
                upsertToolResult(
                    toolUseId = toolId,
                    output = output,
                    isError = block.isError == true,
                    presentationKind = block.presentation?.kind,
                    presentationPrompt = block.presentation?.data?.prompt,
                )
            }
            "web_search_tool_result" -> {
                // 结果附着于 server_tool_use 的展开区，不再添加独立时间线项。
                val toolId = block.toolUseId ?: block.id ?: return@forEachIndexed
                upsertToolResult(toolId, block.content ?: block.resultText ?: block.output, false)
            }
            "image" -> items.add(AssistantTimelineItem.Attachment(block))
            "file", "document" -> items.add(AssistantTimelineItem.Attachment(block.copy(type = "file")))
            "rich_content", "tabtin_rich_content" -> {
                val richBlock = block.normalizedRichContent()
                // 老数据中的 search_results 已被工具调用结果取代，不能再次占一行。
                if (richBlock.kind != "search_results") items.add(AssistantTimelineItem.Rich(richBlock))
            }
            "tabtin_source_ref", "doc_selection", "table_selection", "code_file", "memo", "web" -> {
                items.add(AssistantTimelineItem.Rich(
                    block.copy(
                        type = "rich_content",
                        kind = block.kind ?: "resource_ref",
                        title = block.title ?: block.resourceName ?: block.filename,
                    )
                ))
            }
        }
    }

    // ：源 A 乐观建卡只写 agentSteps、不往 blocksJson 落 tool_use。
    // AssistantTimeline 只扫 blocks 时 live 卡会「有内存态却看不见」——把未锚定的
    // SUBAGENT 步骤挂到气泡末尾（对齐 iOS runsWithoutToolAnchor）。
    appendOrphanSubagentSteps(
        items = items,
        message = message,
        anchoredToolIds = toolItemIndexById.keys,
    )

    if (!hasTextBlock && items.isEmpty() && displayText.isNotBlank()) {
        items.add(AssistantTimelineItem.Text(displayText))
    }
    return items
}

/**
 * 把尚未被 blocksJson `tool_use`/`tool_result` 锚定的 [StepType.SUBAGENT] 追加进时间线。
 * live 乐观卡、以及仅有 agentSteps 的边界态依赖此兜底。
 */
internal fun appendOrphanSubagentSteps(
    items: MutableList<AssistantTimelineItem>,
    message: ChatMessage,
    anchoredToolIds: Set<String>,
) {
    val renderedStepIds = items.mapNotNull { item ->
        (item as? AssistantTimelineItem.Tool)?.step?.id
    }.toHashSet()
    message.agentSteps.orEmpty().forEach { step ->
        if (step.type != StepType.SUBAGENT) return@forEach
        val snap = step.subagent ?: return@forEach
        if (step.id in renderedStepIds) return@forEach
        val anchors = buildList {
            snap.parentToolCallId?.takeIf { it.isNotBlank() }?.let(::add)
            snap.runId.takeIf { it.isNotBlank() }?.let(::add)
            if (step.id.startsWith("subagent-")) {
                add(step.id.removePrefix("subagent-"))
            }
        }
        if (anchors.any { it in anchoredToolIds }) return@forEach
        items.add(AssistantTimelineItem.Tool(step))
        renderedStepIds.add(step.id)
    }
}

@Composable
private fun AssistantTimeline(
    items: List<AssistantTimelineItem>,
    isStreaming: Boolean,
    currentSpaceId: String? = null,
    currentOrganizationId: String? = null,
    onOpenInWorkbench: ((WorkbenchResourceOpenRequest) -> Unit)? = null,
    formalMediaArtifactToolUseIds: Set<String> = emptySet(),
) {
    // 连续执行步骤（思考 + 工具）收敛成一行执行组，详情走底部抽屉——时间线保持可读。
    val units = remember(items) { groupExecutionSteps(items) }
    val lastUnitIndex = units.lastIndex

    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        units.forEachIndexed { unitIndex, unit ->
            when (unit) {
                is ExecutionTimelineUnit.Group -> ExecutionGroupRow(
                    items = unit.items,
                    isStreaming = isStreaming,
                    isLastGroupInTimeline = unitIndex == lastUnitIndex,
                )
                is ExecutionTimelineUnit.Single -> when (val item = unit.item) {
                    is AssistantTimelineItem.Text -> TextTimelineBlock(item, isStreaming)
                    is AssistantTimelineItem.Thinking -> ThinkingStepTimelineRow(
                        content = item.content,
                        running = ExecutionStepPresentation.isRunning(
                            item,
                            isStreaming,
                            isLastStep = unitIndex == lastUnitIndex,
                        ),
                    )
                    is AssistantTimelineItem.Tool -> {
                        when {
                            item.step.type == StepType.SUBAGENT && item.step.subagent != null -> {
                                SubagentProgressCard(snapshot = item.step.subagent)
                            }
                            item.step.isMediaImageGeneration -> {
                                if (!shouldSuppressMediaImagePreview(item.step, formalMediaArtifactToolUseIds)) {
                                    MediaImageInlineCard(item.step)
                                }
                            }
                            else -> ExecutionStepRow(
                                item = item,
                                isStreaming = isStreaming,
                                isLastStep = unitIndex == lastUnitIndex,
                            )
                        }
                    }
                    is AssistantTimelineItem.Rich -> RichContentSection(
                        blocks = listOf(item.block),
                        currentSpaceId = currentSpaceId,
                        currentOrganizationId = currentOrganizationId,
                        onOpenInWorkbench = onOpenInWorkbench,
                    )
                    is AssistantTimelineItem.Attachment -> MessageAttachments(listOf(item.block))
                }
            }
        }
        val hasVisibleThinkingBlock = items.any { item ->
            item is AssistantTimelineItem.Thinking &&
                AgentAwaitingThoughtPresentation.hasVisibleThinkingBody(item.content)
        }
        val awaitingPhase = AgentAwaitingThoughtPresentation.resolvePhase(
            sessionPulseVisible = isStreaming,
            isLastAssistantMessage = true,
            timelineItems = items,
        )
        if (isStreaming && !hasVisibleThinkingBlock && awaitingPhase != AgentAwaitingThoughtPhase.HIDDEN) {
            StreamingStatusIndicator(awaitingPhase = awaitingPhase)
        }
    }
}

internal fun shouldSuppressMediaImagePreview(
    step: AgentStep,
    formalMediaArtifactToolUseIds: Set<String>,
): Boolean = step.isMediaImageGeneration && step.id in formalMediaArtifactToolUseIds

@Composable
private fun TextTimelineBlock(item: AssistantTimelineItem.Text, isStreaming: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs)) {
        if (item.content.isNotBlank()) {
            MarkdownBubble(content = item.content, isStreaming = isStreaming)
        }
        if (item.citationCount > 0) {
            Text(
                text = stringResource(R.string.chat_citations_count, item.citationCount),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                modifier = Modifier.padding(start = TTSpacing.xs),
            )
        }
    }
}

@Composable
private fun LegacyAssistantContent(
    message: ChatMessage,
    displayText: String,
    shouldTruncate: Boolean,
    expanded: Boolean,
    onToggleExpand: () -> Unit,
    imageAttachments: List<BlockItem>,
    fileAttachments: List<BlockItem>,
    onNoticeAction: ((String) -> Unit)?,
    currentSpaceId: String? = null,
    currentOrganizationId: String? = null,
    onOpenInWorkbench: ((WorkbenchResourceOpenRequest) -> Unit)? = null,
) {
    message.reasoning?.takeIf { it.isNotEmpty() }?.let { reasoning ->
        ReasoningView(content = reasoning)
        Spacer(Modifier.height(TTSpacing.xs))
    }
    message.agentSteps?.takeIf { it.isNotEmpty() }?.let { steps ->
        AgentStepsView(steps = steps, onNoticeAction = onNoticeAction)
        Spacer(Modifier.height(TTSpacing.xs))
    }

    val richContentBlocks = message.richContentBlocks
    if (richContentBlocks.isNotEmpty()) {
        RichContentSection(
            blocks = richContentBlocks,
            currentSpaceId = currentSpaceId,
            currentOrganizationId = currentOrganizationId,
            onOpenInWorkbench = onOpenInWorkbench,
        )
        Spacer(Modifier.height(TTSpacing.xs))
    }

    if (imageAttachments.isNotEmpty() || fileAttachments.isNotEmpty()) {
        MessageAttachments(imageAttachments + fileAttachments)
        Spacer(Modifier.height(TTSpacing.xs))
    }

    if (displayText.isBlank() && !message.isStreaming) return

    val bgColor = ttColor(TTColors.Background, TTColors.Dark.Background)
    val reduceMotion = rememberReduceMotion()
    Box(
        modifier = if (message.isStreaming) {
            Modifier
        } else {
            // spring 替代 tween：流式结束后尺寸回落不再每帧重定向；系统关动画时瞬时完成。
            Modifier.animateContentSize(
                animationSpec = if (reduceMotion) {
                    snap()
                } else {
                    spring(stiffness = Spring.StiffnessMediumLow)
                },
            )
        },
    ) {
        MarkdownBubble(content = displayText, isStreaming = message.isStreaming)

        if (shouldTruncate && !expanded) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp)
                    .align(Alignment.BottomCenter)
                    .background(
                        Brush.verticalGradient(
                            colors = listOf(bgColor.copy(alpha = 0f), bgColor),
                            startY = 0f,
                            endY = Float.POSITIVE_INFINITY,
                        )
                    )
                    .clickable(role = Role.Button, onClick = onToggleExpand),
                contentAlignment = Alignment.BottomCenter,
            ) {
                Icon(
                    Icons.Default.KeyboardArrowDown,
                    contentDescription = stringResource(R.string.common_expand_all),
                    modifier = Modifier.size(16.dp).padding(bottom = 2.dp),
                    tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }
        }
    }
}

private fun copyAssistantMessage(
    context: Context,
    view: android.view.View,
    text: String,
) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    val copied = if (cm == null || text.isBlank()) {
        false
    } else {
        runCatching {
            cm.setPrimaryClip(ClipData.newPlainText("chat-message", text))
            true
        }.getOrDefault(false)
    }
    if (copied) {
        val haptic = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            HapticFeedbackConstants.CONFIRM
        } else {
            HapticFeedbackConstants.LONG_PRESS
        }
        view.performHapticFeedback(haptic)
        Toast.makeText(context, context.getString(R.string.chat_message_copied), Toast.LENGTH_SHORT).show()
    } else {
        Toast.makeText(context, context.getString(R.string.chat_message_copy_failed), Toast.LENGTH_SHORT).show()
    }
}

@Composable
internal fun EmptyConversation(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            Icons.AutoMirrored.Filled.Send,
            contentDescription = null,
            modifier = Modifier.size(40.dp),
            tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        )
        Spacer(Modifier.height(TTSpacing.lg))
        Text(
            stringResource(R.string.chat_start_conversation),
            style = ConversationTypography.bodySemibold,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
        Spacer(Modifier.height(TTSpacing.xs))
        Text(
            stringResource(R.string.chat_start_conversation_hint),
            style = TTFonts.body,
            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        )
    }
}
