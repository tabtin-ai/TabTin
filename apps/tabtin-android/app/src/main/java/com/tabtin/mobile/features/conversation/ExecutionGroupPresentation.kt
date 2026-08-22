package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 执行组呈现口径（纯逻辑，无 Compose 依赖，供单测直接断言）。
 *
 * 「执行步骤」= 一次思考或一次（非子 Agent）工具调用。时间线只呈现**执行组**这一行锚点，
 * 步骤本身的输入 / 输出 / 思考全文一律进底部抽屉（`ExecutionDetailSheet`）。
 *
 * 与 Electron `CollapsibleToolCardGroup` 分组口径同源、与 iOS `ExecutionStepPresentation`
 * 逐条对齐；差异只在展开容器：桌面端就地内联展开，移动端小屏改为抽屉，避免长执行把
 * 正文和 Composer 顶出屏幕。
 */
internal object ExecutionStepPresentation {

    /** 子 Agent 派发另有聚合形态（SubagentProgressCard），不进执行组。 */
    private val SUBAGENT_TOOL_NAMES = setOf("agent", "task", "Task", "dispatch_agent", "subagent")

    fun isExecutionStep(item: AssistantTimelineItem): Boolean = when (item) {
        is AssistantTimelineItem.Thinking -> true
        is AssistantTimelineItem.Tool ->
            item.step.type != StepType.SUBAGENT &&
                !item.step.isMediaImageGeneration &&
                item.step.name !in SUBAGENT_TOOL_NAMES
        else -> false
    }

    /**
     * 步骤稳定身份。工具用 tool_use id；思考块没有 wire id，用它在时间线里的位置派生
     * ——同一条消息内 blocks 顺序稳定，位置即身份。
     */
    fun stepId(item: AssistantTimelineItem, index: Int): String = when (item) {
        is AssistantTimelineItem.Tool -> "tool-${item.step.id}"
        is AssistantTimelineItem.Thinking -> "think-$index"
        else -> "item-$index"
    }

    /**
     * 是否仍在执行。
     *
     * 工具自带 runtime 状态；思考块在 wire 上没有终止标记，所以按「本轮仍在流式产出，
     * 且它就是最后一个步骤」判定——与 activeTail 同一口径，不会把中间那些早已结束的
     * 思考误标成运行中。
     */
    fun isRunning(item: AssistantTimelineItem, isStreaming: Boolean, isLastStep: Boolean): Boolean =
        when (item) {
            is AssistantTimelineItem.Tool -> item.step.status == StepStatus.RUNNING
            is AssistantTimelineItem.Thinking -> isStreaming && isLastStep
            else -> false
        }

    fun isFailed(item: AssistantTimelineItem): Boolean =
        item is AssistantTimelineItem.Tool && item.step.status == StepStatus.FAILED

    /**
     * 模型给的 description/summary/title。有值则整行标题用它，不再追加 ` · 对象`。
     * 完整时间线文案见 [timelineLabel]。
     */
    fun toolDescription(inputJson: String?): String? {
        val raw = inputJson?.trim()?.takeIf { it.startsWith("{") } ?: return null
        val root = runCatching { parser.parseToJsonElement(raw) as? JsonObject }
            .getOrNull() ?: return null
        val candidates = buildList {
            add(root)
            for (nested in listOf("kwargs", "args", "input")) {
                (root[nested] as? JsonObject)?.let { add(it) }
            }
        }
        for (source in candidates) {
            for (key in listOf("description", "summary", "title")) {
                val primitive = source[key] as? JsonPrimitive ?: continue
                if (!primitive.isString) continue
                val value = primitive.content.trim()
                if (value.isNotEmpty() && value != "null") return value
            }
        }
        return null
    }

    /** 时间线行：`动词 · 对象`，永不回落 raw 工具名。 */
    fun timelineLabel(name: String, inputJson: String?, verb: String): String =
        ToolRowPresentation.timelineLabel(name, inputJson, verb)

    fun timelineDetail(name: String, inputJson: String?): String? =
        ToolRowPresentation.timelineDetail(name, inputJson)

    // 刻意不用 org.json：它在 Android 的 JVM 单测里只是 stub（调用即抛
    // "not mocked" RuntimeException），会让本口径无法被单测覆盖。
    private val parser = Json { ignoreUnknownKeys = true; isLenient = true }
}

/**
 * 执行组的聚合状态。组行只呈现这一层摘要——步数 + 失败，
 * 让用户不点开也能判断「这一段有没有出事」。
 */
internal data class ExecutionGroupSummary(
    val stepCount: Int,
    val runningCount: Int,
    val failedCount: Int,
    /**
     * **末尾**步骤仍在执行时 = 该步 id；否则 null。
     *
     * 只认末尾这一步（对齐 Electron `activeTailId`）：中间步骤结果滞后不该把整组打散，
     * 而正在跑的尾步必须留在时间线上实时可见，否则运行中界面看起来像卡死。
     */
    val activeTailId: String?,
) {
    val isRunning: Boolean get() = runningCount > 0

    companion object {
        fun of(
            items: List<AssistantTimelineItem>,
            isStreaming: Boolean,
            isLastGroupInTimeline: Boolean,
        ): ExecutionGroupSummary {
            val steps = items.filter(ExecutionStepPresentation::isExecutionStep)
            var running = 0
            var failed = 0
            steps.forEachIndexed { index, item ->
                val isTail = isLastGroupInTimeline && index == steps.lastIndex
                if (ExecutionStepPresentation.isRunning(item, isStreaming, isTail)) running++
                if (ExecutionStepPresentation.isFailed(item)) failed++
            }
            val tailIndex = steps.lastIndex
            val tail = steps.getOrNull(tailIndex)
            val tailRunning = tail != null &&
                ExecutionStepPresentation.isRunning(tail, isStreaming, isLastGroupInTimeline)
            // 空 streaming thinking 不算可见尾步（对齐 iOS / Electron ThinkingBlockView return null），
            // 否则会在组头下再画一行「思考中…」，并把等待壳挤掉。
            val emptyStreamingThinking = tail is AssistantTimelineItem.Thinking &&
                !AgentAwaitingThoughtPresentation.hasVisibleThinkingBody(tail.content)
            val activeTailId =
                if (tail != null && tailRunning && !emptyStreamingThinking) {
                    ExecutionStepPresentation.stepId(tail, tailIndex)
                } else {
                    null
                }
            return ExecutionGroupSummary(
                stepCount = steps.size,
                runningCount = running,
                failedCount = failed,
                activeTailId = activeTailId,
            )
        }
    }
}

/**
 * 抽屉里步骤是否默认展开。
 *
 * 口径：**用户点进来最想先看到的先展开**——只有一步时直接铺开（点单步行进来就是要看它），
 * 多步时只展开正在跑的和失败的，其余保持折叠，避免十几步全文一次倾泻。
 */
internal object ExecutionStepDetailExpansion {
    fun initialExpanded(
        item: AssistantTimelineItem,
        isSoleStep: Boolean,
        isStreaming: Boolean = false,
        isLastStep: Boolean = false,
    ): Boolean {
        if (isSoleStep) return true
        return ExecutionStepPresentation.isRunning(item, isStreaming, isLastStep) ||
            ExecutionStepPresentation.isFailed(item)
    }

    /** 打开抽屉时滚动定位的目标下标：优先失败步，其次运行中步；都没有则从头读。 */
    fun focusTargetIndex(items: List<AssistantTimelineItem>, isStreaming: Boolean = false): Int? {
        val failed = items.indexOfFirst(ExecutionStepPresentation::isFailed)
        if (failed >= 0) return failed
        val running = items.indexOfFirst {
            ExecutionStepPresentation.isRunning(it, isStreaming, it === items.lastOrNull())
        }
        return running.takeIf { it >= 0 }
    }
}

/**
 * 时间线渲染单元。连续执行步骤收成一个组，其余项保持原位——分组**绝不**改变非执行项
 * 的相对位置（`[文本, 工具, 工具, 文本]` → `[单项, 组, 单项]`）。
 */
internal sealed class ExecutionTimelineUnit {
    data class Single(val item: AssistantTimelineItem, val index: Int) : ExecutionTimelineUnit()
    data class Group(val items: List<AssistantTimelineItem>, val startIndex: Int) : ExecutionTimelineUnit()
}

/**
 * 两步起就收成执行组：移动端竖屏放不下连续步骤，一行组头 + 抽屉详情才是常态。
 *
 * 单步不成组——「读取 Package.swift」比「执行详情 · 1 步」信息量更高，
 * 且它自己点开就是同一个抽屉，不需要多套一层。
 */
internal const val EXECUTION_GROUP_THRESHOLD: Int = 2

internal fun groupExecutionSteps(items: List<AssistantTimelineItem>): List<ExecutionTimelineUnit> {
    val units = mutableListOf<ExecutionTimelineUnit>()
    var index = 0
    while (index < items.size) {
        if (!ExecutionStepPresentation.isExecutionStep(items[index])) {
            units.add(ExecutionTimelineUnit.Single(items[index], index))
            index++
            continue
        }
        var end = index + 1
        while (end < items.size && ExecutionStepPresentation.isExecutionStep(items[end])) end++
        val run = items.subList(index, end)
        if (run.size >= EXECUTION_GROUP_THRESHOLD) {
            units.add(ExecutionTimelineUnit.Group(run.toList(), index))
        } else {
            run.forEachIndexed { offset, item ->
                units.add(ExecutionTimelineUnit.Single(item, index + offset))
            }
        }
        index = end
    }
    return units
}

/**
 * 跨消息执行组。历史里每个 tool_use 常是一条独立 assistant 消息，且都带
 * `checkpoint_record`；若不在列表层合并，时间线就会铺成一串工具行。
 */
internal sealed class ConversationRenderUnit {
    abstract val key: String

    data class Single(val message: ChatMessage, val index: Int) : ConversationRenderUnit() {
        override val key: String get() = message.id
    }

    data class StepGroup(
        val messages: List<ChatMessage>,
        val startIndex: Int,
    ) : ConversationRenderUnit() {
        override val key: String get() = "step-group-${messages.first().id}"
    }
}

internal fun ChatMessage.isCrossMessageStepOnly(): Boolean {
    if (!isAssistant) return false
    if (planProposal != null || modeSwitchProposal != null) return false
    if (!errorMessage.isNullOrBlank() || !errorCategory.isNullOrBlank()) return false
    val items = assistantTimelineItems(this, displayContent)
    val stepCount = items.count(ExecutionStepPresentation::isExecutionStep)
    if (stepCount == 0) return false
    return items.all { item ->
        ExecutionStepPresentation.isExecutionStep(item) || isInertTimelineItem(item)
    }
}

private fun isInertTimelineItem(item: AssistantTimelineItem): Boolean =
    item is AssistantTimelineItem.Text && item.content.isBlank() && item.citationCount == 0

internal fun groupConversationRenderUnits(
    messages: List<ChatMessage>,
): List<ConversationRenderUnit> {
    val units = mutableListOf<ConversationRenderUnit>()
    var index = 0
    while (index < messages.size) {
        val message = messages[index]
        if (!message.isCrossMessageStepOnly()) {
            units.add(ConversationRenderUnit.Single(message, index))
            index++
            continue
        }
        var end = index + 1
        while (end < messages.size && messages[end].isCrossMessageStepOnly()) end++
        val run = messages.subList(index, end)
        if (run.size > 1) {
            units.add(ConversationRenderUnit.StepGroup(run.toList(), index))
        } else {
            units.add(ConversationRenderUnit.Single(run.first(), index))
        }
        index = end
    }
    return units
}
