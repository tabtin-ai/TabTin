package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.data.model.SubagentRunSnapshot
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** 一条文件改动（从写/改/删类工具调用提取）。对齐 iOS CanvasFileItem。 */
internal data class CanvasFileItem(
    val toolCallId: String,
    val action: String,
    val path: String,
    val finalized: Boolean,
)

/** 一条命令执行（从终端/shell 类工具调用提取）。对齐 iOS CanvasCommandItem。 */
internal data class CanvasCommandItem(
    val toolCallId: String,
    val toolName: String,
    val command: String,
    val finalized: Boolean,
)

/** 其他工具调用（既非文件也非命令）——保证「全部工具」不丢条。 */
internal data class CanvasToolItem(
    val toolCallId: String,
    val name: String,
    val inputPreview: String?,
    val finalized: Boolean,
)

/** 「Agent 干了什么」聚合结果（纯值，从会话消息派生）。 */
internal data class CanvasSummary(
    val turnCount: Int = 0,
    val toolCount: Int = 0,
    val files: List<CanvasFileItem> = emptyList(),
    val commands: List<CanvasCommandItem> = emptyList(),
    val otherTools: List<CanvasToolItem> = emptyList(),
) {
    val isEmpty: Boolean
        get() = toolCount == 0 && files.isEmpty() && commands.isEmpty() && otherTools.isEmpty()
}

/**
 * 从会话消息聚合「Agent 干了什么」——纯函数，对齐 iOS CanvasAggregator。
 *
 * 工具调用来源与 ChatBubble 时间线同口径：有 blocksJson（历史/落库路径）时用其中的
 * `tool_use` 块，否则用流式期的 agentSteps（TOOL_CALL）——避免双源重复计数。
 */
internal object CanvasAggregator {
    private val fileKeywords = listOf(
        "write", "edit", "delete", "create_file", "str_replace",
        "apply_patch", "mkdir", "touch", "move", "copy", "rename",
    )
    private val filePathKeys = listOf("path", "file_path", "target_path", "target_file", "filename", "file")

    private val commandKeywords = listOf("terminal", "shell", "bash", "command", "exec", "run_")
    private val commandKeys = listOf("command", "cmd", "script", "input")

    private val lenientJson = Json { ignoreUnknownKeys = true; isLenient = true }

    fun aggregate(messages: List<ChatMessage>): CanvasSummary {
        var turnCount = 0
        var toolCount = 0
        val files = mutableListOf<CanvasFileItem>()
        val commands = mutableListOf<CanvasCommandItem>()
        val otherTools = mutableListOf<CanvasToolItem>()

        fun addToolCall(id: String, name: String, inputRaw: String?, finalized: Boolean) {
            toolCount++
            val input = parseObject(inputRaw)
            val lowered = name.lowercase()
            val filePath = if (fileKeywords.any { lowered.contains(it) }) input?.let { stringField(it, filePathKeys) } else null
            val command = if (filePath == null && commandKeywords.any { lowered.contains(it) }) {
                input?.let { stringField(it, commandKeys) }
            } else {
                null
            }
            when {
                filePath != null -> files.add(CanvasFileItem(id, name, filePath, finalized))
                command != null -> commands.add(CanvasCommandItem(id, name, command, finalized))
                else -> otherTools.add(CanvasToolItem(id, name, preview(input, inputRaw), finalized))
            }
        }

        messages.forEach { message ->
            if (message.isUser) turnCount++
            val blocks = message.blocksJson.orEmpty()
            if (blocks.isNotEmpty()) {
                blocks.forEachIndexed { position, block ->
                    if (block.type != "tool_use") return@forEachIndexed
                    val id = block.id ?: block.toolUseId ?: "tool-${message.effectiveId}-$position"
                    addToolCall(
                        id = id,
                        name = block.name ?: id,
                        inputRaw = block.inputJson ?: block.input?.toString(),
                        finalized = block.status?.let(StepStatus::fromString) != StepStatus.RUNNING,
                    )
                }
            } else {
                message.agentSteps.orEmpty()
                    .filter { it.type == StepType.TOOL_CALL }
                    .forEach { step ->
                        addToolCall(
                            id = step.id,
                            name = step.name,
                            inputRaw = step.input,
                            finalized = step.status != StepStatus.RUNNING,
                        )
                    }
            }
        }
        return CanvasSummary(turnCount, toolCount, files, commands, otherTools)
    }

    /** session 级子 Agent 运行列表：跨消息按 runId 去重，后出现的快照覆盖先出现的。 */
    fun subagentRuns(messages: List<ChatMessage>): List<SubagentRunSnapshot> {
        val byRunId = LinkedHashMap<String, SubagentRunSnapshot>()
        messages.forEach { message ->
            message.agentSteps.orEmpty().forEach { step ->
                step.subagent?.let { byRunId[it.runId] = it }
            }
        }
        return byRunId.values.toList()
    }

    private fun parseObject(raw: String?): JsonObject? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        return try {
            lenientJson.parseToJsonElement(trimmed).jsonObject
        } catch (_: Exception) {
            null
        }
    }

    private fun stringField(obj: JsonObject, keys: List<String>): String? {
        keys.forEach { key ->
            val value = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (!value.isNullOrEmpty()) return value
        }
        return null
    }

    private fun preview(obj: JsonObject?, raw: String?): String? {
        if (obj != null) {
            val preferred = listOf("path", "file_path", "query", "command", "name", "title", "url")
            stringField(obj, preferred)?.let { return it }
            obj.values.firstNotNullOfOrNull { v ->
                (v as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
            }?.let { return it }
        }
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        return if (trimmed.length > 120) trimmed.take(120) + "…" else trimmed
    }
}

/**
 * 「Agent 干了什么」画板（bottom sheet）。对齐 iOS CanvasView：
 * 统计头 + 子 Agent（复用 SubagentProgressCard，可展开详情）+ 文件/命令/其他工具分类高亮。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CanvasSheet(
    messages: List<ChatMessage>,
    onDismiss: () -> Unit,
) {
    val summary = CanvasAggregator.aggregate(messages)
    val subagentRuns = CanvasAggregator.subagentRuns(messages)

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(),
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = TTSpacing.lg, end = TTSpacing.lg, bottom = TTSpacing.xxl,
            ),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        ) {
            item {
                Text(
                    text = stringResource(R.string.canvas_title),
                    style = TTFonts.subtitleSemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    modifier = Modifier.padding(bottom = TTSpacing.md),
                )
            }

            item {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = TTSpacing.md),
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    CanvasStatChip(
                        value = summary.turnCount,
                        label = stringResource(R.string.canvas_stat_turns),
                        icon = Icons.AutoMirrored.Filled.Chat,
                        modifier = Modifier.weight(1f),
                    )
                    CanvasStatChip(
                        value = summary.toolCount,
                        label = stringResource(R.string.canvas_stat_tools),
                        icon = Icons.Default.Build,
                        modifier = Modifier.weight(1f),
                    )
                    CanvasStatChip(
                        value = subagentRuns.size,
                        label = stringResource(R.string.canvas_stat_subagents),
                        icon = Icons.Default.Group,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            if (summary.isEmpty && subagentRuns.isEmpty()) {
                item {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = TTSpacing.xxl),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            Icons.Default.AutoAwesome,
                            contentDescription = null,
                            modifier = Modifier.size(32.dp),
                            tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent).copy(alpha = 0.6f),
                        )
                        Spacer(Modifier.height(TTSpacing.sm))
                        Text(
                            text = stringResource(R.string.canvas_empty),
                            style = TTFonts.body,
                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        )
                    }
                }
            } else {
                if (subagentRuns.isNotEmpty()) {
                    item {
                        CanvasSectionHeader(
                            title = stringResource(R.string.canvas_section_subagents),
                            icon = Icons.Default.Group,
                        )
                    }
                    items(subagentRuns, key = { "subagent-${it.runId}" }) { run ->
                        SubagentProgressCard(snapshot = run)
                    }
                }

                if (summary.files.isNotEmpty()) {
                    item {
                        CanvasSectionHeader(
                            title = stringResource(R.string.canvas_section_files, summary.files.size),
                            icon = Icons.Default.Description,
                        )
                    }
                    items(summary.files, key = { "file-${it.toolCallId}" }) { file ->
                        CanvasItemRow(
                            icon = Icons.Default.Description,
                            title = file.path,
                            subtitle = file.action,
                            monospaceTitle = true,
                            pending = !file.finalized,
                        )
                    }
                }

                if (summary.commands.isNotEmpty()) {
                    item {
                        CanvasSectionHeader(
                            title = stringResource(R.string.canvas_section_commands, summary.commands.size),
                            icon = Icons.Default.Terminal,
                        )
                    }
                    items(summary.commands, key = { "cmd-${it.toolCallId}" }) { cmd ->
                        CanvasItemRow(
                            icon = Icons.Default.Terminal,
                            title = cmd.command,
                            subtitle = cmd.toolName,
                            monospaceTitle = true,
                            pending = !cmd.finalized,
                        )
                    }
                }

                if (summary.otherTools.isNotEmpty()) {
                    item {
                        CanvasSectionHeader(
                            title = stringResource(R.string.canvas_section_other_tools, summary.otherTools.size),
                            icon = Icons.Default.Build,
                        )
                    }
                    items(summary.otherTools, key = { "tool-${it.toolCallId}" }) { tool ->
                        CanvasItemRow(
                            icon = Icons.Default.Build,
                            title = tool.name,
                            subtitle = tool.inputPreview,
                            monospaceTitle = false,
                            pending = !tool.finalized,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CanvasStatChip(
    value: Int,
    label: String,
    icon: ImageVector,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .clip(TTRadius.Shapes.md)
            .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
            .padding(vertical = TTSpacing.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(18.dp),
            tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
        )
        Text(
            text = "$value",
            style = ConversationTypography.bodySemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
        Text(
            text = label,
            style = TTFonts.caption,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
    }
}

@Composable
private fun CanvasSectionHeader(title: String, icon: ImageVector) {
    Row(
        modifier = Modifier.padding(top = TTSpacing.md, bottom = TTSpacing.xxs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
        Spacer(Modifier.size(TTSpacing.xs))
        Text(
            text = title,
            style = TTFonts.bodySemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
    }
}

@Composable
private fun CanvasItemRow(
    icon: ImageVector,
    title: String,
    subtitle: String?,
    monospaceTitle: Boolean,
    pending: Boolean,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(ttColor(TTColors.SurfaceVariant, TTColors.Dark.SurfaceVariant))
            .padding(TTSpacing.sm),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
        )
        Spacer(Modifier.size(TTSpacing.sm))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = if (monospaceTitle) TTFonts.caption.copy(fontFamily = FontFamily.Monospace) else TTFonts.caption,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 2,
            )
            if (!subtitle.isNullOrEmpty()) {
                Text(
                    text = subtitle,
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    maxLines = 1,
                )
            }
        }
        if (pending) {
            CircularProgressIndicator(
                modifier = Modifier.size(14.dp),
                strokeWidth = 1.5.dp,
            )
        }
    }
}
