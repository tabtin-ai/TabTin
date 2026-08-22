package com.tabtin.mobile.features.conversation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CompareArrows
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.BatteryStd
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.CropFree
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.HourglassBottom
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.PanTool
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Timeline
import androidx.compose.material.icons.filled.TouchApp
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.features.conversation.cards.ToolCardContent
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 连续执行步骤在时间线上的**唯一**呈现：一行组头 +（仅当末步在跑时）露出的活跃尾步。
 *
 * 点组头打开 [ExecutionDetailSheet] 读全部步骤详情。组头本身不做内联展开——移动端竖屏里
 * 内联展开工具详情会把命令、diff、SQL 结果整段塞进阅读流，正文和 Composer 被顶走，
 * 这正是本次抽屉化要消除的问题。与 iOS `ExecutionGroupRow` 逐条对齐。
 */
@Composable
internal fun ExecutionGroupRow(
    items: List<AssistantTimelineItem>,
    isStreaming: Boolean,
    isLastGroupInTimeline: Boolean,
) {
    val summary = remember(items, isStreaming, isLastGroupInTimeline) {
        ExecutionGroupSummary.of(items, isStreaming, isLastGroupInTimeline)
    }
    var showSheet by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(TTRadius.Shapes.sm)
                .clickable { showSheet = true }
                // 视觉行高收紧；整行可点保证触控面积。
                .heightIn(min = 28.dp)
                .padding(vertical = TTSpacing.xxs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StepIconSlot(Icons.Default.Layers)
            Spacer(Modifier.width(TTSpacing.xs))
            Text(
                text = stringResource(
                    R.string.chat_execution_detail_headline,
                    summary.stepCount,
                ),
                style = ConversationTypography.step,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (summary.failedCount > 0) {
                Spacer(Modifier.width(TTSpacing.xs))
                Text(
                    text = stringResource(
                        R.string.chat_execution_failed_count,
                        summary.failedCount,
                    ),
                    style = ConversationTypography.meta,
                    color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                    maxLines = 1,
                )
            }
            Spacer(Modifier.width(TTSpacing.xs))
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = stringResource(R.string.chat_execution_detail),
                modifier = Modifier.size(16.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }

        // 运行中露出末尾那一步：用户始终知道 Agent 此刻在做什么；跑完自动收进组。
        val activeTail = summary.activeTailId?.let { tailId ->
            items.withIndex().lastOrNull { (index, item) ->
                ExecutionStepPresentation.stepId(item, index) == tailId
            }
        }
        if (activeTail != null) {
            Row(modifier = Modifier.fillMaxWidth().padding(start = TTSpacing.xs)) {
                Box(
                    Modifier
                        .width(1.dp)
                        .heightIn(min = 24.dp)
                        .background(ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)),
                )
                Spacer(Modifier.width(TTSpacing.sm))
                ExecutionStepRow(
                    item = activeTail.value,
                    isStreaming = isStreaming,
                    isLastStep = true,
                )
            }
        }
    }

    if (showSheet) {
        ExecutionDetailSheet(
            items = items,
            isStreaming = isStreaming,
            onDismiss = { showSheet = false },
        )
    }
}

/**
 * 时间线上的单个执行步骤行（未成组，或成组后露出的活跃尾步）。
 * 点开走执行详情抽屉——与组行同一个容器，只是范围不同。
 */
@Composable
internal fun ExecutionStepRow(
    item: AssistantTimelineItem,
    isStreaming: Boolean,
    isLastStep: Boolean,
) {
    if (item is AssistantTimelineItem.Thinking) {
        ThinkingStepTimelineRow(
            content = item.content,
            running = ExecutionStepPresentation.isRunning(item, isStreaming, isLastStep),
        )
        return
    }

    var showSheet by remember { mutableStateOf(false) }
    val running = ExecutionStepPresentation.isRunning(item, isStreaming, isLastStep)
    val failed = ExecutionStepPresentation.isFailed(item)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .clickable { showSheet = true }
            .heightIn(min = 28.dp)
            .padding(vertical = TTSpacing.xxs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 内容左贴：图标 + 文案 + chevron。weight 不能直接挂在文案上，
        // 否则槽位仍占满剩余宽度，箭头会被顶到行尾（通栏宽条）。
        Row(
            modifier = Modifier.weight(1f, fill = false),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StepIconSlot(executionStepIcon(item))
            Spacer(Modifier.width(TTSpacing.xs))
            Text(
                text = executionStepLabel(item, running),
                style = ConversationTypography.step,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (failed) {
                Spacer(Modifier.width(TTSpacing.xs))
                Text(
                    text = stringResource(R.string.chat_execution_step_failed),
                    style = ConversationTypography.meta,
                    color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
            }
            Spacer(Modifier.width(TTSpacing.xs))
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = stringResource(R.string.chat_execution_detail_hint),
                modifier = Modifier.size(16.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }

    if (showSheet) {
        ExecutionDetailSheet(
            items = listOf(item),
            isStreaming = isStreaming,
            onDismiss = { showSheet = false },
        )
    }
}

/**
 * 执行详情抽屉。时间线只留组行锚点，命令、diff、SQL 结果和思考全文都在这里读。
 *
 * - 步骤按真实流序排列，思考与工具保持各自身份；
 * - 打开即定位到失败 / 运行中的那一步——用户点进来通常是为了找问题；
 * - 单步（从时间线单行点进来）直接铺开，不再让用户多点一次。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ExecutionDetailSheet(
    items: List<AssistantTimelineItem>,
    isStreaming: Boolean,
    onDismiss: () -> Unit,
) {
    val steps = remember(items) { items.filter(ExecutionStepPresentation::isExecutionStep) }
    val sheetState = rememberTTSheetState(skipPartiallyExpanded = steps.size > 1)
    val listState = rememberLazyListState()
    val soleStep = steps.size == 1
    val expandedByIndex = remember(steps) {
        mutableStateMapOf<Int, Boolean>().apply {
            steps.forEachIndexed { index, step ->
                put(
                    index,
                    ExecutionStepDetailExpansion.initialExpanded(
                        item = step,
                        isSoleStep = soleStep,
                        isStreaming = isStreaming,
                        isLastStep = index == steps.lastIndex,
                    ),
                )
            }
        }
    }

    LaunchedEffect(steps) {
        ExecutionStepDetailExpansion.focusTargetIndex(steps, isStreaming)
            ?.let { listState.scrollToItem(it) }
    }

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ttColor(TTColors.Surface, TTColors.Dark.Surface),
    ) {
        Text(
            text = if (soleStep) {
                executionStepLabel(steps[0], running = false)
            } else {
                stringResource(R.string.chat_execution_detail)
            },
            style = ConversationTypography.bodySemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.sm),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )

        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            itemsIndexed(steps) { index, step ->
                ExecutionStepDetailRow(
                    item = step,
                    isSoleStep = soleStep,
                    isStreaming = isStreaming,
                    isLastStep = index == steps.lastIndex,
                    expanded = expandedByIndex[index] ?: false,
                    onToggle = { expandedByIndex[index] = !(expandedByIndex[index] ?: false) },
                )
            }
            item { Spacer(Modifier.height(TTSpacing.xxl)) }
        }
    }
}

/** 抽屉里的一步：标题行 + 可展开的详情体。 */
@Composable
private fun ExecutionStepDetailRow(
    item: AssistantTimelineItem,
    isSoleStep: Boolean,
    isStreaming: Boolean,
    isLastStep: Boolean,
    expanded: Boolean,
    onToggle: () -> Unit,
) {
    val running = ExecutionStepPresentation.isRunning(item, isStreaming, isLastStep)
    val failed = ExecutionStepPresentation.isFailed(item)

    Column(modifier = Modifier.fillMaxWidth()) {
        // 只有一步时抽屉本身就是这一步，不再给一个能把内容收起来的空标题行。
        if (!isSoleStep) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(TTRadius.Shapes.sm)
                    .clickable(onClick = onToggle)
                    .heightIn(min = 44.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (item is AssistantTimelineItem.Thinking) {
                    ThinkingBrainIcon()
                } else {
                    StepIconSlot(executionStepIcon(item))
                }
                Spacer(Modifier.width(TTSpacing.xs))
                Text(
                    text = executionStepLabel(item, running),
                    style = ConversationTypography.step,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (failed) {
                    Spacer(Modifier.width(TTSpacing.xs))
                    Text(
                        text = stringResource(R.string.chat_execution_step_failed),
                        style = ConversationTypography.meta,
                        color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                    )
                }
                Spacer(Modifier.weight(1f))
                Icon(
                    if (expanded) Icons.Default.ExpandMore else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }
        }

        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(),
            exit = shrinkVertically(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = if (isSoleStep) 0.dp else TTSpacing.lg),
            ) {
                when (item) {
                    is AssistantTimelineItem.Thinking -> SelectionContainer {
                        Text(
                            text = item.content,
                            style = ConversationTypography.step,
                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        )
                    }
                    is AssistantTimelineItem.Tool -> Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(TTRadius.Shapes.sm)
                            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                            .padding(TTSpacing.sm),
                    ) {
                        ToolCardContent(item.step)
                    }
                    else -> Unit
                }
            }
        }
    }
}

/** 所有步骤图标共用同一 16dp 槽，让思考与各类工具的文字共享同一条起始线。 */
@Composable
private fun StepIconSlot(icon: ImageVector) {
    Box(modifier = Modifier.size(16.dp), contentAlignment = Alignment.Center) {
        Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(14.dp),
            tint = ttColor(TTColors.IconSecondary, TTColors.Dark.IconSecondary),
        )
    }
}

/** 与 Electron `toolCardRegistry` / iOS Lucide 名对齐（Material 侧最接近的等价物）。思考用 Lucide Brain，见 [ThinkingBrainIcon]。 */
private fun executionStepIcon(item: AssistantTimelineItem): ImageVector = when (item) {
    is AssistantTimelineItem.Thinking -> Icons.Default.Psychology // 抽屉内 fallback；时间线走 ThinkingBrainIcon
    is AssistantTimelineItem.Tool -> lucideToMaterial(ToolRowPresentation.of(item.step.name).lucideIcon)
    else -> Icons.Default.Build
}

private fun lucideToMaterial(icon: String): ImageVector = when (icon) {
    "Terminal" -> Icons.Default.Terminal
    "Server" -> Icons.Default.Computer
    "FileText" -> Icons.Default.Description
    "FilePenLine" -> Icons.Default.Edit
    "FileX2" -> Icons.Default.Delete
    "Database" -> Icons.Default.Storage
    "Search" -> Icons.Default.Search
    "Globe" -> Icons.Default.Language
    "GitBranch" -> Icons.Default.AccountTree
    "GitCompare" -> Icons.AutoMirrored.Filled.CompareArrows
    "CheckCircle2" -> Icons.Default.CheckCircle
    "Bot" -> Icons.Default.SmartToy
    "HelpCircle" -> Icons.AutoMirrored.Filled.HelpOutline
    "NotebookPen" -> Icons.Default.EditNote
    "Trash2" -> Icons.Default.Delete
    "LayoutTemplate" -> Icons.Default.Dashboard
    "Sparkles" -> Icons.Default.AutoAwesome
    "Smartphone" -> Icons.Default.Smartphone
    "Battery" -> Icons.Default.BatteryStd
    "Wifi" -> Icons.Default.Wifi
    "ContactRound" -> Icons.Default.Contacts
    "MessageSquare" -> Icons.Default.Sms
    "Send" -> Icons.AutoMirrored.Filled.Send
    "Phone" -> Icons.Default.Phone
    "PhoneCall" -> Icons.Default.Call
    "Calendar" -> Icons.Default.DateRange
    "Bell" -> Icons.Default.Notifications
    "AppWindow" -> Icons.Default.Apps
    "Images" -> Icons.Default.Image
    "MapPin" -> Icons.Default.Place
    "ScanLine" -> Icons.Default.CropFree
    "MonitorSmartphone" -> Icons.Default.Smartphone
    "Network" -> Icons.Default.AccountTree
    "MousePointerClick" -> Icons.Default.TouchApp
    "MoveHorizontal" -> Icons.Default.SwapHoriz
    "Hand" -> Icons.Default.PanTool
    "Keyboard" -> Icons.Default.Keyboard
    "Lock" -> Icons.Default.Lock
    "Command" -> Icons.Default.Keyboard
    "Hourglass" -> Icons.Default.HourglassBottom
    "Square" -> Icons.Default.Stop
    "Settings" -> Icons.Default.Settings
    "EyeOff" -> Icons.Default.VisibilityOff
    "ExternalLink" -> Icons.AutoMirrored.Filled.OpenInNew
    "HardDriveDownload" -> Icons.Default.Download
    "Activity" -> Icons.Default.Timeline
    "PlusCircle" -> Icons.Default.AddCircle
    "RefreshCw" -> Icons.Default.Refresh
    else -> Icons.Default.Build
}

/**
 * 步骤行文案。思考按运行态区分「思考中…」/「已思考」；
 * 工具走 [ToolRowPresentation.timelineLabel]：模型 description 胜出，
 * 否则 `动词 · 对象`，永不回落 raw 工具名。
 *
 * 「已思考 N 秒」见 [R.string.chat_execution_thinking_done_seconds]；需 thinking 块
 * startedAt/stoppedAt（时间线尚未携带）后才能接线。
 */
@Composable
private fun executionStepLabel(item: AssistantTimelineItem, running: Boolean): String = when (item) {
    is AssistantTimelineItem.Thinking ->
        if (running) {
            stringResource(R.string.chat_step_thinking)
        } else {
            stringResource(R.string.chat_execution_thinking_done)
        }
    is AssistantTimelineItem.Tool ->
        ToolRowPresentation.timelineLabel(item.step.name, item.step.input, toolVerb(item.step.name))
    else -> ""
}

@Composable
private fun toolVerb(name: String): String = stringResource(ToolVerbs.resIdFor(name))
