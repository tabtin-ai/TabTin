package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.BlockPresentation
import com.tabtin.mobile.data.model.BlockPresentationData
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StreamEvent
import kotlinx.serialization.json.JsonElement

internal data class TextProjection(
    val content: String,
    val blocksJson: List<BlockItem>?,
)

internal data class ReasoningProjection(
    val reasoning: String,
    val blocksJson: List<BlockItem>?,
)

internal data class ToolProjection(
    val assistantId: String,
    val index: Int?,
    /**
     * 命中块在时间轴里的原始 key messageId（可能为 null；agentSteps 兜底时恒 null）。
     * 回写必须复用它——tool_result 信封的 messageId 可能与工具块所属消息不同
     * （W4.5 跨消息回灌、 后台命令终态 mini-message）。
     */
    val blockMessageId: String?,
    val existingStep: AgentStep?,
)

/**
 * Android twin of iOS `ConversationProjector` block timeline rules.
 *
 * The important invariant is the same as iOS:
 * updates only merge into a block with the same message id, block kind, and
 * index. A thinking/tool block at index 0 must never collide with a text block
 * at index 0, and repeated replay/snapshot text must not be appended twice.
 */
internal class ConversationBlockProjector {
    private data class BlockKey(
        val messageId: String?,
        val kind: String,
        val index: Int,
    )

    private data class TimelineBlock(
        val key: BlockKey,
        val order: Int,
        val block: BlockItem,
    )

    private val blocksByAssistantId = mutableMapOf<String, MutableMap<BlockKey, TimelineBlock>>()
    private var nextOrder = 0

    fun reset() {
        blocksByAssistantId.clear()
        nextOrder = 0
    }

    fun appendText(
        assistantId: String,
        messageId: String?,
        index: Int,
        text: String,
        existing: List<BlockItem>?,
    ): TextProjection {
        val key = BlockKey(messageId, "text", index)
        upsert(assistantId, key) { previous ->
            val current = previous?.text ?: previous?.content ?: ""
            val merged = mergeTextDelta(current, text)
            (previous ?: BlockItem(type = "text", index = index)).copy(
                type = "text",
                index = index,
                content = merged,
                text = merged,
            )
        }
        val content = timeline(assistantId)
            .filter { it.type == "text" }
            .mapNotNull { it.text ?: it.content }
            .joinToString("\n\n")
            .trimEnd()
        return TextProjection(content, mergeProjectedBlocks(assistantId, existing))
    }

    fun appendCitation(
        assistantId: String,
        messageId: String?,
        index: Int,
        citation: JsonElement,
        existing: List<BlockItem>?,
    ): List<BlockItem>? {
        val key = BlockKey(messageId, "text", index)
        upsert(assistantId, key) { previous ->
            val current = previous ?: BlockItem(type = "text", index = index, content = "", text = "")
            val citations = current.citations.orEmpty()
            current.copy(
                type = "text",
                index = index,
                citations = if (citation in citations) citations else citations + citation,
            )
        }
        return mergeProjectedBlocks(assistantId, existing)
    }

    fun appendThinking(
        assistantId: String,
        messageId: String?,
        index: Int,
        text: String,
        existing: List<BlockItem>?,
    ): ReasoningProjection {
        val key = BlockKey(messageId, "thinking", index)
        upsert(assistantId, key) { previous ->
            val current = previous?.thinking ?: previous?.text ?: previous?.content ?: ""
            val merged = if (text.isEmpty()) current else mergeTextDelta(current, text)
            (previous ?: BlockItem(type = "thinking", index = index)).copy(
                type = "thinking",
                index = index,
                thinking = merged,
                text = merged,
            )
        }
        val reasoning = timeline(assistantId)
            .filter { it.type == "thinking" }
            .mapNotNull { it.thinking ?: it.text ?: it.content }
            .joinToString("\n\n")
            .trimEnd()
        return ReasoningProjection(reasoning, mergeProjectedBlocks(assistantId, existing))
    }

    fun upsertTool(
        assistantId: String,
        messageId: String?,
        index: Int?,
        step: AgentStep,
        existing: List<BlockItem>?,
    ): List<BlockItem>? {
        if (index != null) {
            val key = BlockKey(messageId, "tool_use", index)
            upsert(assistantId, key) { previous ->
                val presentation = step.toBlockPresentation() ?: previous?.presentation
                (previous ?: BlockItem(type = "tool_use", index = index)).copy(
                    type = "tool_use",
                    index = index,
                    id = step.id,
                    toolUseId = step.id,
                    name = step.name,
                    inputJson = step.input,
                    output = step.output,
                    resultText = step.output,
                    isError = step.status == StepStatus.FAILED,
                    status = step.status.value,
                    presentation = presentation,
                )
            }
        }
        return mergeProjectedBlocks(assistantId, existing)
    }

    fun toolResultTarget(
        event: StreamEvent.ToolResultBlock,
        messages: List<ChatMessage>,
    ): ToolProjection? {
        val hit = blocksByAssistantId.entries.firstNotNullOfOrNull { (assistantId, blocks) ->
            blocks.values.firstOrNull {
                it.block.id == event.toolUseId || it.block.toolUseId == event.toolUseId
            }?.let { assistantId to it }
        }
        val assistantId: String
        val index: Int?
        val blockMessageId: String?
        if (hit != null) {
            assistantId = hit.first
            index = hit.second.key.index
            blockMessageId = hit.second.key.messageId
        } else {
            val msg = messages.firstOrNull { message ->
                message.agentSteps.orEmpty().any { it.id == event.toolUseId }
            } ?: return null
            assistantId = msg.id
            index = null
            blockMessageId = null
        }
        val existing = messages
            .firstOrNull { it.id == assistantId }
            ?.agentSteps
            ?.firstOrNull { it.id == event.toolUseId }
        return ToolProjection(assistantId, index, blockMessageId, existing)
    }

    fun upsertContentBlock(
        assistantId: String,
        messageId: String?,
        index: Int,
        block: BlockItem,
        existing: List<BlockItem>?,
    ): List<BlockItem>? {
        val key = BlockKey(messageId, block.type ?: "content", index)
        upsert(assistantId, key) { block.copy(index = index) }
        return mergeProjectedBlocks(assistantId, existing)
    }

    private fun upsert(
        assistantId: String,
        key: BlockKey,
        build: (BlockItem?) -> BlockItem,
    ) {
        val blocks = blocksByAssistantId.getOrPut(assistantId) { mutableMapOf() }
        val previous = blocks[key]
        val order = previous?.order ?: nextOrder++
        blocks[key] = TimelineBlock(key = key, order = order, block = build(previous?.block))
    }

    private fun mergeProjectedBlocks(
        assistantId: String,
        existing: List<BlockItem>?,
    ): List<BlockItem>? {
        val projected = timeline(assistantId)
        if (projected.isEmpty()) return existing
        return projected
    }

    private fun timeline(assistantId: String): List<BlockItem> =
        blocksByAssistantId[assistantId]
            .orEmpty()
            .values
            .sortedWith(compareBy<TimelineBlock> { it.key.index }.thenBy { it.order })
            .map { it.block }

    private fun AgentStep.toBlockPresentation(): BlockPresentation? {
        if (presentationKind == null && presentationPrompt == null) return null
        return BlockPresentation(
            kind = presentationKind,
            data = presentationPrompt?.let { BlockPresentationData(prompt = it) },
        )
    }

    private fun mergeTextDelta(current: String, incoming: String): String {
        if (incoming.isEmpty()) return current
        if (current.isEmpty()) return incoming
        if (incoming == current) return current
        if (incoming.startsWith(current)) return incoming
        if (current.endsWith(incoming) && incoming.length > 8) return current
        return current + incoming
    }
}
