package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentTodoItem
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.TodoStatus
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** 从持久化的 todo tool_use 重放当前待办；语义与 runtime todo 状态机一致。 */
internal object TodoHistoryRehydration {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun deriveLatestTodos(messages: List<ChatMessage>): List<AgentTodoItem> {
        val failedIds = collectFailedTodoIds(messages)
        var open: List<AgentTodoItem>? = null

        messages.asSequence()
            .filter { it.isAssistant && !it.isSubagentTranscript }
            .flatMap { it.blocksJson.orEmpty().asSequence() }
            .filter { it.type == "tool_use" && it.name == "todo" }
            .filterNot { block -> toolCallId(block)?.let(failedIds::contains) == true }
            .mapNotNull(::todoAction)
            .forEach { action -> open = applyAction(open, action) }

        return open.orEmpty()
    }

    /** 新一轮发送只清掉已结清快照，未完成列表继续留在 composer 上方。 */
    fun retainForNextTurn(todos: List<AgentTodoItem>): List<AgentTodoItem> =
        todos.takeIf { items -> items.any { !it.status.isTerminal } }.orEmpty()

    private fun collectFailedTodoIds(messages: List<ChatMessage>): Set<String> {
        val todoIds = messages.asSequence()
            .filterNot(ChatMessage::isSubagentTranscript)
            .flatMap { it.blocksJson.orEmpty().asSequence() }
            .filter { it.type == "tool_use" && it.name == "todo" }
            .mapNotNull(::toolCallId)
            .toSet()
        return messages.asSequence()
            .filterNot(ChatMessage::isSubagentTranscript)
            .flatMap { it.blocksJson.orEmpty().asSequence() }
            .filter { it.type == "tool_result" && it.isError == true }
            .mapNotNull(::toolCallId)
            .filter(todoIds::contains)
            .toSet()
    }

    private fun todoAction(block: BlockItem): JsonObject? {
        val raw = block.input ?: block.inputJson?.let { inputJson ->
            runCatching { json.parseToJsonElement(inputJson) }.getOrNull()
        }
        val obj = raw as? JsonObject ?: return null
        val kwargs = obj["kwargs"] as? JsonObject
        return if (kwargs == null) obj else JsonObject(kwargs + obj)
    }

    private fun applyAction(
        current: List<AgentTodoItem>?,
        action: JsonObject,
    ): List<AgentTodoItem>? {
        return when (action.string("action")) {
            "open" -> if (current == null) parseItems(action["items"]) else current
            "add" -> {
                val open = current ?: return current
                val item = parseItem(action["item"]) ?: return current
                if (open.any { it.id == item.id }) current else settleIfNeeded(open + item)
            }
            "update" -> {
                val open = current ?: return current
                val id = action.string("id") ?: return current
                val index = open.indexOfFirst { it.id == id }
                if (index < 0 || open[index].status == TodoStatus.COMPLETED) return current
                val content = action.string("content") ?: open[index].content
                if (content.isBlank()) return current
                val status = action.string("status")?.let(TodoStatus::fromString) ?: open[index].status
                open.toMutableList().apply {
                    this[index] = open[index].copy(content = content, status = status)
                }.let(::settleIfNeeded)
            }
            "remove" -> {
                val open = current ?: return current
                val id = action.string("id") ?: return current
                val item = open.firstOrNull { it.id == id } ?: return current
                if (item.status == TodoStatus.COMPLETED) current
                else settleIfNeeded(open.filterNot { it.id == id })
            }
            "close" -> null
            else -> current
        }
    }

    private fun parseItems(element: JsonElement?): List<AgentTodoItem>? {
        val array = element as? JsonArray ?: return null
        val items = array.mapNotNull(::parseItem)
        return items.takeIf { it.size == array.size && it.isNotEmpty() }
            ?.let(::settleIfNeeded)
    }

    private fun parseItem(element: JsonElement?): AgentTodoItem? {
        val obj = element as? JsonObject ?: return null
        val id = obj.string("id") ?: return null
        val content = obj.string("content") ?: return null
        val status = obj.string("status")?.let(TodoStatus::fromString) ?: TodoStatus.PENDING
        if (id.isBlank() || content.isBlank()) return null
        return AgentTodoItem(id = id, content = content, status = status)
    }

    private fun settleIfNeeded(items: List<AgentTodoItem>): List<AgentTodoItem>? =
        items.takeIf { list -> list.isNotEmpty() && list.any { !it.status.isTerminal } }

    private fun toolCallId(block: BlockItem): String? =
        (if (block.type == "tool_result") block.toolUseId ?: block.id else block.id ?: block.toolUseId)
            ?.takeIf { it.isNotBlank() }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }

    private val TodoStatus.isTerminal: Boolean
        get() = this == TodoStatus.COMPLETED || this == TodoStatus.CANCELLED
}
