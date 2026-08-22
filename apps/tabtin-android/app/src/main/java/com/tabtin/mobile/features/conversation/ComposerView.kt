package com.tabtin.mobile.features.conversation

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.FormatQuote
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AttachmentStatus
import com.tabtin.mobile.data.model.ChatAttachment
import com.tabtin.mobile.data.model.ConversationApprovalMode
import com.tabtin.mobile.data.model.LlmModel
import com.tabtin.mobile.data.model.hasRuntimeSettings
import com.tabtin.mobile.data.model.runtimeSettingsSummary
import com.tabtin.mobile.features.workbench.ResourceReference
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

private val ComposerToolbarControlSize = 44.dp
private val ComposerToolbarVisualSize = 28.dp
private val ComposerModelNameMaxWidth = 180.dp
private val ComposerModelTitleMaxWidth = 110.dp

/** 收敛态单行高度约 52dp，取其半作胶囊半径。与 iOS `collapsedCornerRadius` 对齐。 */
private val CollapsedComposerCornerRadius = 26.dp

/**
 * 输入区投影。
 *
 * Compose 的 `shadow` 走系统 elevation 阴影，默认投影色几乎是实心黑：在浅色画布上一提
 * 高度就在卡片四周晕出一圈脏灰边，读起来是「压了块黑影」而不是「浮起来一层」。这里把
 * ambient / spot 都调到低透明度，高度也压下来，靠大扩散的淡影表达高度；轮廓本身交给
 * 卡片底色与那道 0.5dp 描边。与 iOS Composer 的双层淡投影同一取向。
 */
private val ComposerShadowAmbient = Color.Black.copy(alpha = 0.10f)
private val ComposerShadowSpot = Color.Black.copy(alpha = 0.16f)
private val ComposerExpandedElevation = 3.dp
private val ComposerCollapsedElevation = 6.dp

/**
 * 输入区上沿渐隐带高度。与 iOS `ttComposerTopScrim` / `ComposerTopScrimMetrics.height` 同值。
 *
 * 短渐变解决不了问题：28dp 的两点线性渐变，起点处变化率一上来就是满的，人眼照样能
 * 指出「羽化从这里开始」。要让它读起来没有边，就得长、且前段几乎不变（见
 * [ComposerTopScrimStops] 的缓入停靠点）。
 *
 * 羽化画在 overlay / background，不进 footer 实测高度；可读重叠见
 * [ComposerTopScrimReadableOverlap]。
 */
internal val ComposerTopScrimHeight = 72.dp

/**
 * 羽化段中下部已不透明到可读受阻时，列表底部要多留的一截。
 *
 * 对齐 iOS `ComposerTopScrimMetrics.readableOverlap`：渐隐带不进 footer 实测高度，但下半段
 * 已明显遮挡消息，所以 `contentPadding.bottom` 要额外加上本值，让最后一条消息停在清晰区。
 */
internal val ComposerTopScrimReadableOverlap = 36.dp

/**
 * 渐隐带的停靠点（位置 to 不透明度），与 iOS 逐档对齐。
 *
 * 末档 0.94 必须与悬浮输入区自身的底色同值——两段对不上，交界处就会切出一条清清楚楚
 * 的亮边，那比没有渐隐带还难看。
 */
internal val ComposerTopScrimStops = arrayOf(
    0f to 0f,
    0.28f to 0.12f,
    0.52f to 0.42f,
    0.76f to 0.78f,
    1f to 0.94f,
)

/** 悬浮输入区自身那一段的底色不透明度：接住渐隐带末档。 */
internal const val ComposerSurfaceAlpha = 0.94f

@Composable
internal fun ComposerView(
    text: String,
    onTextChange: (String) -> Unit,
    isSending: Boolean,
    isStreaming: Boolean,
    isPaused: Boolean = false,
    isPauseControlPending: Boolean = false,
    isCancelControlPending: Boolean = false,
    billingBlocked: Boolean = false,
    hitlBlocked: Boolean = false,
    disabledReason: String? = null,
    workspaceName: String? = null,
    attachments: List<ChatAttachment> = emptyList(),
    contextRefs: List<ResourceReference> = emptyList(),
    isUploading: Boolean = false,
    onPickImages: () -> Unit,
    onPickFiles: () -> Unit,
    onCamera: () -> Unit,
    onSend: () -> Unit,
    onCancel: () -> Unit,
    onPause: () -> Unit = {},
    onResume: () -> Unit = {},
    onVoiceInput: () -> Unit = {},
    onRemoveAttachment: (String) -> Unit = {},
    onRetryAttachment: (String) -> Unit = {},
    onRemoveContextRef: (String) -> Unit = {},
    currentModel: LlmModel? = null,
    availableModels: List<LlmModel> = emptyList(),
    isLoadingModels: Boolean = false,
    isSwitchingModel: Boolean = false,
    modelSwitchErrorMessage: String? = null,
    modelLoadFailed: Boolean = false,
    contextTierId: String? = null,
    thinkingMode: String? = null,
    currentMode: String,
    currentApprovalMode: String,
    permitsRelaxedApproval: Boolean = false,
    currentAgentName: String? = null,
    agentOptions: List<ComposerTaskAgentOption> = emptyList(),
    selectedAgentId: String? = null,
    agentIsMutable: Boolean = false,
    onAgentChange: (ComposerTaskAgentOption) -> Unit = {},
    onModelChange: (LlmModel) -> Unit = {},
    onDismissModelSwitchError: () -> Unit = {},
    onContextTierChange: (String) -> Unit = {},
    onThinkingModeChange: (String) -> Unit = {},
    onModeChange: (String) -> Unit = {},
    onApprovalModeChange: (String) -> Unit = {},
    onRetryLoadModels: () -> Unit = {},
    onAddContext: (() -> Unit)? = null,
    /**
     * 用户正在翻消息（滚动中，或停在历史里）：输入井收成一行悬浮胶囊，把屏幕高度让给
     * 阅读。是否真的收由 [ComposerReadingCollapsePolicy] 结合井内内容决定。
     */
    collapsedForReading: Boolean = false,
) {
    var showSettingsDrawer by remember { mutableStateOf(false) }
    val view = LocalView.current
    var showModelDrawer by remember { mutableStateOf(false) }
    var showRuntimeSettings by remember { mutableStateOf(false) }
    val thinkingLabels = composerThinkingModeLabels()
    val runtimeSummary = currentModel?.let { model ->
        runtimeSettingsSummary(
            model = model,
            contextTierId = contextTierId,
            thinkingMode = thinkingMode,
            thinkingLabels = thinkingLabels,
        )
    }
    var isInputFocused by remember { mutableStateOf(false) }
    /** 用户点了收敛胶囊：在拿到输入焦点之前先手动撑开，否则没有输入框可聚焦。 */
    var manuallyExpanded by remember { mutableStateOf(false) }
    var pendingFocusRequest by remember { mutableStateOf(false) }
    val focusRequester = remember { FocusRequester() }

    val isDisabled = billingBlocked || hitlBlocked || disabledReason != null || isSwitchingModel
    val canSelectModel = !isDisabled &&
        availableModels.isNotEmpty() &&
        ComposerModelSelectionPolicy.canSelect(
            isSending = isSending,
            isStreaming = isStreaming,
            isPaused = isPaused,
            isSwitchingModel = isSwitchingModel,
        )
    val isControlPending = isPauseControlPending || isCancelControlPending
    val composerQuote = remember(text) { MessageQuote.parseComposerDraft(text) }
    val editableReply = composerQuote?.reply ?: text
    val trimmed = text.trim()
    val showsRunControls = isCancelControlPending || isPaused || isPauseControlPending ||
        (trimmed.isEmpty() && isStreaming)
    val showsSendButton = ComposerSendControlPolicy.shouldShowSend(
        text = trimmed,
        attachmentStatuses = attachments.map { it.status },
    )
    val buttonEnabled = !isDisabled && !isPaused && !isControlPending && !isUploading

    val agentTitle = currentAgentName?.trim().orEmpty().ifBlank {
        stringResource(R.string.chat_composer_current_agent)
    }

    val placeholder = composerPlaceholder(
        disabledReason = disabledReason,
        isPaused = isPaused,
        isPauseControlPending = isPauseControlPending,
        isCancelControlPending = isCancelControlPending,
        hitlBlocked = hitlBlocked,
        workspaceName = workspaceName,
    )
    val collapsedPlaceholder = collapsedComposerPlaceholder(
        disabledReason = disabledReason,
        isPaused = isPaused,
        isPauseControlPending = isPauseControlPending,
        isCancelControlPending = isCancelControlPending,
        hitlBlocked = hitlBlocked,
    )

    val collapsed = !manuallyExpanded && ComposerReadingCollapsePolicy.shouldCollapse(
        scrollWantsCollapse = collapsedForReading,
        isFocused = isInputFocused,
        hasDraftText = trimmed.isNotEmpty(),
        hasAttachments = attachments.isNotEmpty(),
        hasContextRefs = contextRefs.isNotEmpty(),
        hasBlockingReason = disabledReason != null,
    )

    // 撑开后再请求焦点：收敛态里输入框根本不在组合树上，提前 requestFocus 会抛。
    LaunchedEffect(collapsed, pendingFocusRequest) {
        if (!collapsed && pendingFocusRequest) {
            pendingFocusRequest = false
            focusRequester.requestFocus()
        }
    }
    // 手动撑开只活到失去焦点为止：用户点开又没写就收回去，别在阅读态留一块空输入井。
    LaunchedEffect(isInputFocused, collapsedForReading) {
        if (!isInputFocused && collapsedForReading) manuallyExpanded = false
    }

    // 收敛态浮得更高一档、收成胶囊、两侧再内缩一点——阅读时它是压在内容之上的一层。
    val cornerRadius by animateDpAsState(
        targetValue = if (collapsed) CollapsedComposerCornerRadius else TTRadius.xl,
        label = "composerCorner",
    )
    val elevation by animateDpAsState(
        targetValue = if (collapsed) ComposerCollapsedElevation else ComposerExpandedElevation,
        label = "composerElevation",
    )
    val horizontalInset by animateDpAsState(
        targetValue = if (collapsed) TTSpacing.xl else TTSpacing.lg,
        label = "composerInset",
    )
    val composerShape = RoundedCornerShape(cornerRadius)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = horizontalInset)
            .padding(top = TTSpacing.xs, bottom = TTSpacing.sm),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .shadow(
                    elevation = elevation,
                    shape = composerShape,
                    clip = false,
                    ambientColor = ComposerShadowAmbient,
                    spotColor = ComposerShadowSpot,
                )
                .clip(composerShape)
                .background(ttColor(TTColors.Background, TTColors.Dark.Background))
                .border(
                    width = 0.5.dp,
                    color = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight).copy(alpha = 0.72f),
                    shape = composerShape,
                )
                .padding(TTSpacing.xs),
        ) {
            if (attachments.isNotEmpty() || contextRefs.isNotEmpty()) {
                ComposerMaterialSummary(
                    attachmentCount = attachments.size,
                    contextRefCount = contextRefs.size,
                    readyCount = attachments.count { it.status == AttachmentStatus.READY },
                    uploadingCount = attachments.count {
                        it.status == AttachmentStatus.UPLOADING || it.status == AttachmentStatus.PENDING
                    },
                    failedCount = attachments.count { it.status == AttachmentStatus.ERROR },
                    onCancelAllUploads = {
                        attachments
                            .filter {
                                it.status == AttachmentStatus.UPLOADING ||
                                    it.status == AttachmentStatus.PENDING
                            }
                            .forEach { onRemoveAttachment(it.id) }
                    },
                )
                ComposerPreviewBar(
                    attachments = attachments,
                    contextRefs = contextRefs,
                    onRemoveAttachment = onRemoveAttachment,
                    onRetryAttachment = onRetryAttachment,
                    onRemoveContextRef = onRemoveContextRef,
                )
            }

            if (disabledReason != null) {
                Text(
                    text = disabledReason,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.sm),
                    style = ConversationTypography.meta,
                    color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (!collapsed) {
                composerQuote?.let { quote ->
                    ComposerQuotePreview(
                        quote = quote,
                        onRemove = { onTextChange(quote.reply) },
                    )
                }
                BasicTextField(
                    value = editableReply,
                    onValueChange = { newValue ->
                        onTextChange(composerQuote?.let { it.payload + newValue } ?: newValue)
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = if (isDisabled) 36.dp else 56.dp)
                        .padding(horizontal = TTSpacing.sm)
                        .focusRequester(focusRequester)
                        .onFocusChanged { isInputFocused = it.isFocused },
                    textStyle = ConversationTypography.composer.copy(
                        color = if (isDisabled) {
                            ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                        } else {
                            ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
                        },
                    ),
                    cursorBrush = SolidColor(ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent)),
                    maxLines = 6,
                    enabled = !isDisabled && !isPaused && !isControlPending,
                    decorationBox = { innerTextField ->
                        Box(contentAlignment = Alignment.CenterStart) {
                            if (editableReply.isEmpty()) {
                                Text(
                                    text = placeholder,
                                    style = ConversationTypography.composer,
                                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            innerTextField()
                        }
                    },
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(ComposerToolbarControlSize)
                    .padding(horizontal = TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ComposerToolbarHitTarget(
                    onClick = { showSettingsDrawer = true },
                    enabled = !isDisabled,
                    contentDescription = stringResource(R.string.chat_composer_task_settings),
                ) {
                    Box(
                        modifier = Modifier
                            .size(ComposerToolbarVisualSize)
                            .clip(CircleShape)
                            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Default.Add,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = if (!isDisabled) {
                                ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
                            } else {
                                ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                            },
                        )
                    }
                }

                // 收敛态是阅读姿态：模型名是「发送前才需要确认」的信息，此时让位给占位
                // 文案，使这一行读起来就是一句「继续对话」，而不是半截被截断的工作区名。
                if (!collapsed) {
                    ComposerModelNameControl(
                        model = currentModel,
                        runtimeSummary = runtimeSummary,
                        isLoading = isLoadingModels,
                        loadFailed = modelLoadFailed,
                        enabled = canSelectModel,
                        onOpenSelector = {
                            if (availableModels.isEmpty()) {
                                onRetryLoadModels()
                            } else {
                                onDismissModelSwitchError()
                                showModelDrawer = true
                            }
                        },
                    )
                }

                if (collapsed) {
                    val canExpand = !isDisabled && !isPaused && !isControlPending
                    Text(
                        text = collapsedPlaceholder,
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .clickable(enabled = canExpand, role = Role.Button) {
                                manuallyExpanded = true
                                pendingFocusRequest = true
                            }
                            .wrapContentHeight(Alignment.CenterVertically)
                            .padding(horizontal = TTSpacing.sm),
                        style = ConversationTypography.composer,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                } else {
                    Spacer(Modifier.weight(1f))
                }

                ComposerToolbarHitTarget(
                    onClick = onVoiceInput,
                    enabled = !isDisabled && !isPaused,
                    contentDescription = stringResource(R.string.chat_voice_input),
                ) {
                    Icon(
                        Icons.Default.Mic,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                        tint = if (!isDisabled && !isPaused) {
                            ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
                        } else {
                            ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                        },
                    )
                }

                when {
                    showsRunControls -> {
                        RunControlButtons(
                            isPaused = isPaused,
                            isPausePending = isPauseControlPending,
                            isCancelPending = isCancelControlPending,
                            onPause = onPause,
                            onResume = onResume,
                            onCancel = onCancel,
                        )
                    }

                    showsSendButton -> {
                        ComposerToolbarHitTarget(
                            onClick = {
                                // 发送确认触觉；CONFIRM 需要 API 30，低版本退回 LONG_PRESS。
                                val haptic = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                                    HapticFeedbackConstants.CONFIRM
                                } else {
                                    HapticFeedbackConstants.LONG_PRESS
                                }
                                view.performHapticFeedback(haptic)
                                onSend()
                            },
                            enabled = buttonEnabled,
                            contentDescription = stringResource(R.string.common_send),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(ComposerToolbarVisualSize)
                                    .clip(CircleShape)
                                    .background(
                                        if (buttonEnabled) {
                                            ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent).copy(alpha = 0.14f)
                                        } else {
                                            ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
                                        },
                                    ),
                                contentAlignment = Alignment.Center,
                            ) {
                                if (isSending) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(18.dp),
                                        strokeWidth = 2.dp,
                                        color = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                                    )
                                } else {
                                    Icon(
                                        Icons.Default.ArrowUpward,
                                        contentDescription = null,
                                        modifier = Modifier.size(20.dp),
                                        tint = if (buttonEnabled) {
                                            ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent)
                                        } else {
                                            ttColor(TTColors.TextDisabled, TTColors.Dark.TextDisabled)
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (showSettingsDrawer) {
        ComposerSettingsDrawer(
            agentOptions = agentOptions,
            selectedAgentId = selectedAgentId,
            agentTitle = agentTitle,
            agentIsMutable = agentIsMutable,
            currentMode = currentMode,
            currentApprovalMode = currentApprovalMode,
            permitsRelaxedApproval = permitsRelaxedApproval,
            onSelectTool = { tool ->
                when (tool) {
                    ComposerTool.CONTEXT -> onAddContext?.invoke()
                    ComposerTool.PHOTO_LIBRARY -> onPickImages()
                    ComposerTool.CAMERA -> onCamera()
                    ComposerTool.FILE -> onPickFiles()
                }
            },
            onAgentChange = onAgentChange,
            onModeChange = onModeChange,
            onApprovalModeChange = onApprovalModeChange,
            onDismiss = { showSettingsDrawer = false },
        )
    }

    if (showModelDrawer && availableModels.isNotEmpty()) {
        ComposerModelSelectionDrawer(
            models = availableModels,
            selectedModelId = currentModel?.id,
            selectedModel = currentModel,
            contextTierId = contextTierId,
            thinkingMode = thinkingMode,
            isSwitchingModel = isSwitchingModel || isSending || isStreaming || isPaused,
            errorMessage = modelSwitchErrorMessage,
            onSelect = onModelChange,
            onOpenRuntimeSettings = {
                if (currentModel?.hasRuntimeSettings() == true) {
                    showRuntimeSettings = true
                }
            },
            onDismiss = {
                onDismissModelSwitchError()
                showRuntimeSettings = false
                showModelDrawer = false
            },
        )
    }

    val runtimeModelForSheet = currentModel?.takeIf { it.hasRuntimeSettings() }
    LaunchedEffect(showRuntimeSettings, runtimeModelForSheet?.id) {
        if (showRuntimeSettings && runtimeModelForSheet == null) {
            showRuntimeSettings = false
        }
    }
    if (showRuntimeSettings && runtimeModelForSheet != null) {
        ComposerRuntimeSettingsSheet(
            model = runtimeModelForSheet,
            contextTierId = contextTierId,
            thinkingMode = thinkingMode,
            onSelectContextTier = onContextTierChange,
            onSelectThinkingMode = onThinkingModeChange,
            onDismiss = { showRuntimeSettings = false },
        )
    }
}

@Composable
private fun ComposerQuotePreview(
    quote: ComposerMessageQuote,
    onRemove: () -> Unit,
) {
    val title = stringResource(
        if (quote.author == "我") R.string.chat_composer_quote_self
        else R.string.chat_composer_quote_agent,
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs)
            .clip(RoundedCornerShape(TTRadius.interactive))
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .padding(start = TTSpacing.sm, top = TTSpacing.xs, bottom = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(28.dp)
                .clip(CircleShape)
                .background(ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent).copy(alpha = 0.10f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Outlined.FormatQuote,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
            )
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = TTSpacing.sm),
        ) {
            Text(
                text = title,
                style = TTFonts.metaMedium,
                color = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                maxLines = 1,
            )
            Text(
                text = quote.content,
                style = ConversationTypography.meta,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        IconButton(
            onClick = onRemove,
            modifier = Modifier.minimumInteractiveComponentSize().size(44.dp),
        ) {
            Icon(
                Icons.Default.Close,
                contentDescription = stringResource(R.string.chat_composer_remove_quote),
                modifier = Modifier.size(14.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

@Composable
private fun ComposerToolbarHitTarget(
    onClick: (() -> Unit)?,
    enabled: Boolean = true,
    contentDescription: String? = null,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val clickableModifier = if (onClick != null) {
        Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick)
    } else {
        Modifier
    }
    Box(
        modifier = modifier
            .size(ComposerToolbarControlSize)
            .then(clickableModifier),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

@Composable
private fun ComposerModelNameControl(
    model: LlmModel?,
    runtimeSummary: String?,
    isLoading: Boolean,
    loadFailed: Boolean,
    enabled: Boolean,
    onOpenSelector: () -> Unit,
) {
    Box(
        modifier = Modifier
            .height(ComposerToolbarControlSize)
            .widthIn(max = ComposerModelNameMaxWidth)
            .clickable(enabled = enabled && !isLoading, onClick = onOpenSelector)
            .padding(horizontal = TTSpacing.xs),
        contentAlignment = Alignment.CenterStart,
    ) {
        when {
            isLoading -> {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }

            model != null -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = model.title,
                        style = ConversationTypography.meta,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.widthIn(max = ComposerModelTitleMaxWidth),
                    )
                    if (!runtimeSummary.isNullOrBlank()) {
                        Text(
                            text = " · $runtimeSummary",
                            style = ConversationTypography.meta,
                            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            else -> {
                Text(
                    text = stringResource(
                        if (loadFailed) R.string.chat_model_load_failed else R.string.chat_model_select,
                    ),
                    style = ConversationTypography.meta,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun ComposerMaterialSummary(
    attachmentCount: Int,
    contextRefCount: Int,
    readyCount: Int,
    uploadingCount: Int,
    failedCount: Int,
    onCancelAllUploads: () -> Unit,
) {
    val totalCount = attachmentCount + contextRefCount
    val detail = when {
        failedCount > 0 -> stringResource(R.string.chat_composer_material_failed, failedCount)
        uploadingCount > 0 -> stringResource(R.string.chat_composer_material_uploading, uploadingCount)
        contextRefCount > 0 && attachmentCount == 0 ->
            stringResource(R.string.chat_composer_material_context_only, contextRefCount)
        else -> stringResource(R.string.chat_composer_material_ready)
    }
    val statusColor = when {
        failedCount > 0 -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
        uploadingCount > 0 -> ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent)
        else -> ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs)
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (uploadingCount > 0) Icons.Default.Warning else Icons.Default.Add,
            contentDescription = null,
            modifier = Modifier.size(14.dp),
            tint = statusColor,
        )
        Spacer(Modifier.size(TTSpacing.xs))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(
                    R.string.chat_composer_material_title,
                    totalCount,
                    readyCount,
                ),
                style = ConversationTypography.meta,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
            Text(
                text = detail,
                style = ConversationTypography.meta,
                color = if (failedCount > 0) {
                    ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
                } else {
                    ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                },
            )
        }
        if (uploadingCount > 0) {
            Text(
                text = stringResource(R.string.chat_composer_cancel_uploads),
                style = ConversationTypography.meta,
                color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                modifier = Modifier.clickable(onClick = onCancelAllUploads),
            )
        }
    }
}

@Composable
private fun ComposerPreviewBar(
    attachments: List<ChatAttachment>,
    contextRefs: List<ResourceReference>,
    onRemoveAttachment: (String) -> Unit,
    onRetryAttachment: (String) -> Unit,
    onRemoveContextRef: (String) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        contextRefs.forEach { ref ->
            ComposerContextRefChip(
                title = ref.title,
                onRemove = { onRemoveContextRef(ref.id) },
            )
            Spacer(Modifier.size(TTSpacing.sm))
        }
        attachments.forEach { attachment ->
            ComposerAttachmentChip(
                attachment = attachment,
                onRemove = { onRemoveAttachment(attachment.id) },
                onRetry = { onRetryAttachment(attachment.id) },
            )
            Spacer(Modifier.size(TTSpacing.sm))
        }
    }
}

@Composable
private fun ComposerContextRefChip(
    title: String,
    onRemove: () -> Unit,
) {
    Row(
        modifier = Modifier
            .clip(TTRadius.Shapes.full)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .border(
                0.5.dp,
                ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight),
                TTRadius.Shapes.full,
            )
            .padding(start = TTSpacing.sm, top = 5.dp, bottom = 5.dp, end = TTSpacing.xxs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = ConversationTypography.meta,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 120.dp),
        )
        IconButton(onClick = onRemove, modifier = Modifier.minimumInteractiveComponentSize().size(28.dp)) {
            Icon(
                Icons.Default.Close,
                contentDescription = stringResource(R.string.common_remove),
                modifier = Modifier.size(12.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

@Composable
private fun ComposerAttachmentChip(
    attachment: ChatAttachment,
    onRemove: () -> Unit,
    onRetry: () -> Unit,
) {
    val statusColor = when (attachment.status) {
        AttachmentStatus.READY -> ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
        AttachmentStatus.ERROR -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
        AttachmentStatus.UPLOADING, AttachmentStatus.PENDING ->
            ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent)
    }
    Row(
        modifier = Modifier
            .clip(TTRadius.Shapes.full)
            .background(
                if (attachment.status == AttachmentStatus.ERROR) {
                    ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical).copy(alpha = 0.08f)
                } else {
                    ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
                },
            )
            .border(
                0.5.dp,
                if (attachment.status == AttachmentStatus.ERROR) {
                    ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical).copy(alpha = 0.25f)
                } else {
                    ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
                },
                TTRadius.Shapes.full,
            )
            .padding(start = TTSpacing.sm, top = 5.dp, bottom = 5.dp, end = TTSpacing.xxs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = attachment.filename,
            style = ConversationTypography.meta,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 120.dp),
        )
        when (attachment.status) {
            AttachmentStatus.PENDING, AttachmentStatus.UPLOADING -> {
                CircularProgressIndicator(
                    modifier = Modifier
                        .padding(horizontal = TTSpacing.xs)
                        .size(12.dp),
                    strokeWidth = 1.5.dp,
                    color = statusColor,
                )
            }

            AttachmentStatus.READY -> Unit

            AttachmentStatus.ERROR -> {
                IconButton(onClick = onRetry, modifier = Modifier.minimumInteractiveComponentSize().size(28.dp)) {
                    Icon(
                        Icons.Default.Refresh,
                        contentDescription = stringResource(R.string.common_retry),
                        modifier = Modifier.size(14.dp),
                        tint = statusColor,
                    )
                }
            }
        }
        IconButton(onClick = onRemove, modifier = Modifier.minimumInteractiveComponentSize().size(28.dp)) {
            Icon(
                Icons.Default.Close,
                contentDescription = stringResource(R.string.common_remove),
                modifier = Modifier.size(12.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

@Composable
private fun RunControlButtons(
    isPaused: Boolean,
    isPausePending: Boolean,
    isCancelPending: Boolean,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onCancel: () -> Unit,
) {
    val isControlPending = isPausePending || isCancelPending
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (isPaused) {
            ComposerToolbarHitTarget(
                onClick = onResume,
                enabled = !isControlPending,
                contentDescription = stringResource(R.string.chat_run_resume),
            ) {
                if (isPausePending) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Box(
                        modifier = Modifier
                            .size(ComposerToolbarVisualSize)
                            .clip(CircleShape)
                            .background(ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent).copy(alpha = 0.14f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Default.PlayArrow,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp),
                            tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                        )
                    }
                }
            }
        }
        ComposerToolbarHitTarget(
            onClick = onCancel,
            enabled = !isCancelPending,
            contentDescription = stringResource(R.string.common_stop),
        ) {
            if (isCancelPending) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            } else {
                Box(
                    modifier = Modifier
                        .size(ComposerToolbarVisualSize)
                        .clip(CircleShape)
                        .background(ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical).copy(alpha = 0.12f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Default.Stop,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                        tint = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                    )
                }
            }
        }
    }
}

@Composable
private fun collapsedComposerPlaceholder(
    disabledReason: String?,
    isPaused: Boolean,
    isPauseControlPending: Boolean,
    isCancelControlPending: Boolean,
    hitlBlocked: Boolean,
): String {
    // 收敛态只有一行：不重复 Workspace 名（发到哪在展开时才需要确认），只说下一步动作。
    if (disabledReason != null) return ""
    if (isCancelControlPending) return stringResource(R.string.chat_composer_stopping)
    if (isPauseControlPending) return stringResource(R.string.chat_composer_pausing)
    if (isPaused) return stringResource(R.string.chat_run_paused_hint)
    if (hitlBlocked) return stringResource(R.string.chat_hitl_blocked_hint)
    return stringResource(R.string.chat_composer_placeholder_collapsed)
}

@Composable
private fun composerPlaceholder(
    disabledReason: String?,
    isPaused: Boolean,
    isPauseControlPending: Boolean,
    isCancelControlPending: Boolean,
    hitlBlocked: Boolean,
    workspaceName: String?,
): String {
    if (disabledReason != null) return ""
    if (isCancelControlPending) return stringResource(R.string.chat_composer_stopping)
    if (isPauseControlPending) return stringResource(R.string.chat_composer_pausing)
    if (isPaused) return stringResource(R.string.chat_run_paused_hint)
    if (hitlBlocked) return stringResource(R.string.chat_hitl_blocked_hint)
    val workspace = workspaceName?.trim().orEmpty()
    return if (workspace.isBlank()) {
        stringResource(R.string.chat_composer_placeholder_default)
    } else {
        stringResource(R.string.chat_composer_placeholder_in_workspace, workspace)
    }
}
