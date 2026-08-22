package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.data.model.SubagentRunSnapshot
import com.tabtin.mobile.data.model.SubagentTranscriptItem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Instant

/**
 * 从 HTTP 历史 chat_message 重建子 Agent 卡（[StepType.SUBAGENT] + [SubagentRunSnapshot]）。
 *
 * 对齐 iOS `SubagentHistoryRehydration` + Electron `deriveSubagentRunsFromMessages`：
 * 冷启动 WS 内存态已丢；父消息 tool_use/tool_result 可恢复 metadata，
 * 同页 `subagent_run_id` 子消息可恢复 transcript。纯函数，便于单测。
 */
internal object SubagentHistoryRehydration {
    private val SUBAGENT_ID_REGEX = Regex("""\[子 Agent ID:\s*([^\]\s]+)\s*]""")
    private val DISPATCH_TOOL_NAMES = setOf("agent", "task", "Task")
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    data class HistorySubagentRun(
        val runId: String,
        val parentToolCallId: String?,
        val parentMessageId: String?,
        val snapshot: SubagentRunSnapshot,
    )

    fun extractSubagentRunId(resultText: String?): String? {
        if (resultText.isNullOrBlank()) return null
        val match = SUBAGENT_ID_REGEX.find(resultText) ?: return null
        val id = match.groupValues.getOrNull(1)?.trim().orEmpty()
        return id.takeIf { it.isNotEmpty() }
    }

    fun stripSubagentIdMarker(resultText: String?): String? {
        if (resultText.isNullOrBlank()) return null
        val stripped = resultText.replace(SUBAGENT_ID_REGEX, "").trim()
        return stripped.takeIf { it.isNotEmpty() }
    }

    /**
     * 合并历史派生 runs 到现有内存态。
     * - live 已有非空 transcript 时保留（不覆盖实时流）；
     * - archive 终态可覆盖 stale 的 pending/queued/running；
     * - 其余字段仅在 prev 缺值时回填。
     */
    fun reconcile(
        existing: List<HistorySubagentRun>,
        messages: List<ChatMessage>,
        childMessages: List<ChatMessage>,
    ): List<HistorySubagentRun> {
        val snapshots = deriveRuns(messages) + deriveRuns(childMessages)
        val transcripts = transcriptsByRunId(childMessages)
        if (snapshots.isEmpty() && transcripts.isEmpty()) return existing

        val byId = linkedMapOf<String, HistorySubagentRun>()
        val orderedIds = mutableListOf<String>()
        for (run in existing) {
            byId[run.runId] = run
            orderedIds.add(run.runId)
        }

        for (snapshot in snapshots) {
            val prev = byId[snapshot.runId]
            if (prev != null) {
                byId[snapshot.runId] = merge(previous = prev, archive = snapshot)
            } else {
                byId[snapshot.runId] = snapshot
                orderedIds.add(snapshot.runId)
            }
        }

        for ((runId, items) in transcripts) {
            if (items.isEmpty()) continue
            val prev = byId[runId]
            if (prev != null) {
                if (prev.snapshot.transcript.isEmpty()) {
                    byId[runId] = prev.copy(
                        snapshot = prev.snapshot.copy(transcript = items),
                    )
                }
            } else {
                byId[runId] = HistorySubagentRun(
                    runId = runId,
                    parentToolCallId = null,
                    parentMessageId = null,
                    snapshot = SubagentRunSnapshot(
                        runId = runId,
                        status = SubagentRunSnapshot.Status.COMPLETED,
                        transcript = items,
                    ),
                )
                orderedIds.add(runId)
            }
        }

        return orderedIds.mapNotNull { byId[it] }
    }

    fun deriveRuns(messages: List<ChatMessage>): List<HistorySubagentRun> {
        val runs = mutableListOf<HistorySubagentRun>()
        val seen = mutableSetOf<String>()
        for (message in messages) {
            for (run in runsFromMessage(message)) {
                if (!seen.add(run.runId)) continue
                runs.add(run)
            }
        }
        return runs
    }

    fun transcriptsByRunId(childMessages: List<ChatMessage>): Map<String, List<SubagentTranscriptItem>> {
        data class Chunk(val createdAt: String?, val items: List<SubagentTranscriptItem>)

        val grouped = linkedMapOf<String, MutableList<Chunk>>()
        for (message in childMessages) {
            val runId = message.subagentRunId?.trim()?.takeIf { it.isNotEmpty() } ?: continue
            val items = transcriptItems(message)
            if (items.isEmpty()) continue
            grouped.getOrPut(runId) { mutableListOf() }.add(Chunk(message.createdAt, items))
        }

        val result = linkedMapOf<String, List<SubagentTranscriptItem>>()
        for ((runId, chunks) in grouped) {
            val sorted = chunks.sortedWith(compareBy(nullsLast()) { it.createdAt })
            val flat = mutableListOf<SubagentTranscriptItem>()
            val seenIds = mutableSetOf<String>()
            for (chunk in sorted) {
                for (item in chunk.items) {
                    if (!seenIds.add(item.id)) continue
                    flat.add(item)
                }
            }
            result[runId] = flat
        }
        return result
    }

    fun transcriptItems(message: ChatMessage): List<SubagentTranscriptItem> {
        val blocks = message.blocksJson.orEmpty()
        if (blocks.isEmpty()) {
            val body = message.displayContent.trim()
            if (body.isEmpty()) return emptyList()
            return listOf(
                SubagentTranscriptItem(
                    id = "${message.id}-0-text",
                    messageId = message.id,
                    index = 0,
                    kind = SubagentTranscriptItem.Kind.ASSISTANT,
                    text = body,
                    isFinal = true,
                ),
            )
        }

        val resultsByToolId = linkedMapOf<String, BlockItem>()
        for (block in blocks) {
            if (block.type != "tool_result") continue
            val toolId = block.toolUseId ?: block.id ?: continue
            resultsByToolId[toolId] = block
        }

        return blocks.mapIndexedNotNull { position, block ->
            when (block.type) {
                "text" -> {
                    val body = (block.text ?: block.content).orEmpty().trim()
                    if (body.isEmpty()) null
                    else SubagentTranscriptItem(
                        id = "${message.id}-${block.index ?: position}-text",
                        messageId = message.id,
                        index = block.index ?: position,
                        kind = SubagentTranscriptItem.Kind.ASSISTANT,
                        text = body,
                        isFinal = true,
                    )
                }
                "thinking" -> {
                    val body = (block.thinking ?: block.text ?: block.content).orEmpty().trim()
                    if (body.isEmpty()) null
                    else SubagentTranscriptItem(
                        id = "${message.id}-${block.index ?: position}-thinking",
                        messageId = message.id,
                        index = block.index ?: position,
                        kind = SubagentTranscriptItem.Kind.THINKING,
                        title = "思考",
                        text = body,
                        isFinal = true,
                    )
                }
                "tool_use", "server_tool_use" -> {
                    val toolId = block.id ?: block.toolUseId ?: "tool-$position"
                    val result = resultsByToolId[toolId]
                    val output = result?.let { resultTextOf(it) }
                        ?: block.resultText
                        ?: block.output
                    SubagentTranscriptItem(
                        id = "tool-$toolId",
                        messageId = message.id,
                        index = block.index ?: position,
                        kind = SubagentTranscriptItem.Kind.TOOL,
                        title = block.name,
                        inputText = block.inputJson ?: block.input?.toString(),
                        outputText = output,
                        isFinal = true,
                        isError = result?.isError == true,
                        toolCallId = toolId,
                    )
                }
                "rich_content", "tabtin_rich_content" -> SubagentTranscriptItem(
                    id = "${message.id}-${block.index ?: position}-rich",
                    messageId = message.id,
                    index = block.index ?: position,
                    kind = SubagentTranscriptItem.Kind.RICH_CONTENT,
                    title = block.title,
                    text = block.summary,
                    richContent = block.normalizedRichContent(),
                    isFinal = true,
                )
                else -> null
            }
        }
    }

    /**
     * 将 reconcile 后的 runs 写回主时间线消息的 [ChatMessage.agentSteps]。
     *
     * @param existingMessages replace 前的消息，用于保留 live 非空 transcript。
     */
    fun applyToMessages(
        messages: List<ChatMessage>,
        childMessages: List<ChatMessage>,
        existingMessages: List<ChatMessage> = emptyList(),
    ): List<ChatMessage> {
        val existing = existingSubagentRuns(existingMessages.ifEmpty { messages })
        val reconciled = reconcile(
            existing = existing,
            messages = messages,
            childMessages = childMessages,
        )
        if (reconciled.isEmpty()) return messages

        val runsByMessageKey = linkedMapOf<String, MutableList<HistorySubagentRun>>()
        for (run in reconciled) {
            val parent = findParentMessage(messages, run) ?: continue
            runsByMessageKey.getOrPut(parent.effectiveId) { mutableListOf() }.add(run)
        }

        if (runsByMessageKey.isEmpty()) return messages

        return messages.map { message ->
            val runs = runsByMessageKey[message.effectiveId]
                ?: runsByMessageKey.entries.firstOrNull { (key, _) ->
                    key in message.identityKeys || message.id == key
                }?.value
            if (runs.isNullOrEmpty()) return@map message
            val nextSteps = upsertSubagentSteps(message.agentSteps.orEmpty(), runs)
            if (nextSteps == message.agentSteps) message
            else message.copy(agentSteps = nextSteps)
        }
    }

    private fun existingSubagentRuns(messages: List<ChatMessage>): List<HistorySubagentRun> {
        val ordered = mutableListOf<HistorySubagentRun>()
        val seen = mutableSetOf<String>()
        for (message in messages) {
            for (step in message.agentSteps.orEmpty()) {
                if (step.type != StepType.SUBAGENT) continue
                val snap = step.subagent ?: continue
                val runId = snap.runId.trim().takeIf { it.isNotEmpty() } ?: continue
                if (!seen.add(runId)) continue
                ordered.add(
                    HistorySubagentRun(
                        runId = runId,
                        parentToolCallId = snap.parentToolCallId,
                        parentMessageId = message.serverId ?: message.persistedId ?: message.id,
                        snapshot = snap,
                    ),
                )
            }
        }
        return ordered
    }

    private fun runsFromMessage(message: ChatMessage): List<HistorySubagentRun> {
        val blocks = message.blocksJson.orEmpty()
        if (blocks.isEmpty()) return emptyList()

        val resultsByToolId = linkedMapOf<String, BlockItem>()
        for (block in blocks) {
            if (block.type != "tool_result") continue
            val toolId = block.toolUseId ?: block.id ?: continue
            resultsByToolId[toolId] = block
        }

        val runs = mutableListOf<HistorySubagentRun>()
        blocks.forEachIndexed { position, block ->
            if (block.type != "tool_use" && block.type != "server_tool_use") return@forEachIndexed
            val name = block.name ?: return@forEachIndexed
            if (name !in DISPATCH_TOOL_NAMES) return@forEachIndexed
            val toolCallId = block.id ?: block.toolUseId ?: "tool-$position"
            val inputRaw = block.inputJson ?: block.input?.toString()
            val input = parseToolInput(inputRaw)
            if (!isHistoryDispatchInput(input)) return@forEachIndexed
            val result = resultsByToolId[toolCallId]
            val resultText = result?.let { resultTextOf(it) }
                ?: block.resultText
                ?: block.output
            val runId = extractSubagentRunId(resultText) ?: return@forEachIndexed
            val summary = stripSubagentIdMarker(resultText)
            val failed = result?.isError == true
            val status = if (failed) {
                SubagentRunSnapshot.Status.FAILED
            } else {
                SubagentRunSnapshot.Status.COMPLETED
            }
            val parentMessageId = message.serverId ?: message.persistedId ?: message.id
            val label = firstReadableField(input, "label", "title", "description", "name")
            val task = firstReadableField(input, "task", "prompt")
            val snapshot = SubagentRunSnapshot(
                runId = runId,
                label = label,
                task = task,
                status = status,
                startedAt = parseEpochSeconds(message.createdAt),
                summary = summary,
                error = summary.takeIf { failed },
                parentToolCallId = toolCallId,
                isOptimistic = false,
            )
            runs.add(
                HistorySubagentRun(
                    runId = runId,
                    parentToolCallId = toolCallId,
                    parentMessageId = parentMessageId,
                    snapshot = snapshot,
                ),
            )
        }
        return runs
    }

    /** 历史路径：必须明确是 spawn/resume；check/wait 不建卡。input 缺失时不猜测。 */
    private fun isHistoryDispatchInput(input: JsonObject?): Boolean {
        if (input == null) return true
        val waits = input["wait_agent_ids"] as? JsonArray
        if (waits != null && waits.isNotEmpty()) return false
        val checkId = (input["check_agent_id"] as? JsonPrimitive)?.contentOrNull
        if (!checkId.isNullOrBlank()) return false
        val resume = (input["resume_agent_id"] as? JsonPrimitive)?.contentOrNull
        if (!resume.isNullOrBlank()) return true
        val prompt = (input["prompt"] as? JsonPrimitive)?.contentOrNull
        if (!prompt.isNullOrBlank()) return true
        // 老归档可能缺 prompt 字段但仍有 marker——放行，由 marker 决定是否成 run。
        return true
    }

    private fun merge(previous: HistorySubagentRun, archive: HistorySubagentRun): HistorySubagentRun {
        val prev = previous.snapshot
        val arch = archive.snapshot
        var filled = prev
        if (arch.status.isTerminal && !prev.status.isTerminal) {
            filled = filled.copy(status = arch.status)
        }
        if (filled.task.isNullOrBlank()) filled = filled.copy(task = arch.task)
        if (filled.label.isNullOrBlank()) filled = filled.copy(label = arch.label)
        if (filled.parentToolCallId.isNullOrBlank()) {
            filled = filled.copy(parentToolCallId = arch.parentToolCallId)
        }
        if (filled.startedAt == null) filled = filled.copy(startedAt = arch.startedAt)
        if (filled.endedAt == null) filled = filled.copy(endedAt = arch.endedAt)
        if (filled.summary.isNullOrBlank()) filled = filled.copy(summary = arch.summary)
        if (filled.error.isNullOrBlank()) filled = filled.copy(error = arch.error)
        if (filled.transcript.isEmpty() && arch.transcript.isNotEmpty()) {
            filled = filled.copy(transcript = arch.transcript)
        }
        return HistorySubagentRun(
            runId = previous.runId,
            parentToolCallId = previous.parentToolCallId?.takeIf { it.isNotBlank() }
                ?: archive.parentToolCallId,
            parentMessageId = previous.parentMessageId?.takeIf { it.isNotBlank() }
                ?: archive.parentMessageId,
            snapshot = filled,
        )
    }

    private val SubagentRunSnapshot.Status.isTerminal: Boolean
        get() = this == SubagentRunSnapshot.Status.COMPLETED ||
            this == SubagentRunSnapshot.Status.FAILED ||
            this == SubagentRunSnapshot.Status.CANCELLED

    private fun findParentMessage(
        messages: List<ChatMessage>,
        run: HistorySubagentRun,
    ): ChatMessage? {
        val parentMessageId = run.parentMessageId?.takeIf { it.isNotBlank() }
        if (parentMessageId != null) {
            messages.firstOrNull { parentMessageId in it.identityKeys }?.let { return it }
        }
        val toolCallId = run.parentToolCallId?.takeIf { it.isNotBlank() }
        if (toolCallId != null) {
            messages.firstOrNull { msg ->
                msg.blocksJson.orEmpty().any { block ->
                    (block.type == "tool_use" || block.type == "server_tool_use") &&
                        (block.id == toolCallId || block.toolUseId == toolCallId)
                }
            }?.let { return it }
        }
        // 仅有 transcript 壳、父 tool_result 尚未进当前页时无法挂卡
        return null
    }

    private fun upsertSubagentSteps(
        steps: List<AgentStep>,
        runs: List<HistorySubagentRun>,
    ): List<AgentStep> {
        var next = steps
        for (run in runs) {
            next = upsertHistoryRun(next, run)
        }
        return next
    }

    private fun upsertHistoryRun(
        steps: List<AgentStep>,
        run: HistorySubagentRun,
    ): List<AgentStep> {
        val toolCallId = run.parentToolCallId
        val primaryStepId = if (!toolCallId.isNullOrBlank()) {
            "subagent-$toolCallId"
        } else {
            "subagent-${run.runId}"
        }
        val result = steps.toMutableList()
        val idx = result.indexOfFirst { step ->
            if (step.type != StepType.SUBAGENT) return@indexOfFirst false
            val snap = step.subagent ?: return@indexOfFirst false
            (snap.runId.isNotBlank() && snap.runId == run.runId) ||
                (!toolCallId.isNullOrBlank() && snap.parentToolCallId == toolCallId) ||
                step.id == primaryStepId
        }
        val existingSnap = if (idx >= 0) result[idx].subagent else null
        val snap = if (existingSnap == null) {
            run.snapshot
        } else {
            val transcript = if (existingSnap.transcript.isNotEmpty()) {
                existingSnap.transcript
            } else {
                run.snapshot.transcript
            }
            existingSnap.copy(
                runId = run.runId,
                label = existingSnap.label?.takeIf { it.isNotBlank() } ?: run.snapshot.label,
                task = existingSnap.task?.takeIf { it.isNotBlank() } ?: run.snapshot.task,
                status = if (run.snapshot.status.isTerminal && !existingSnap.status.isTerminal) {
                    run.snapshot.status
                } else {
                    existingSnap.status
                },
                startedAt = existingSnap.startedAt ?: run.snapshot.startedAt,
                endedAt = existingSnap.endedAt ?: run.snapshot.endedAt,
                summary = existingSnap.summary?.takeIf { it.isNotBlank() } ?: run.snapshot.summary,
                error = existingSnap.error?.takeIf { it.isNotBlank() } ?: run.snapshot.error,
                parentToolCallId = existingSnap.parentToolCallId?.takeIf { it.isNotBlank() }
                    ?: run.snapshot.parentToolCallId,
                transcript = transcript,
                isOptimistic = false,
            )
        }
        val stepId = if (idx >= 0) result[idx].id else primaryStepId
        val displayName = SubagentDisplayTitle.resolve(snap.label, snap.task).orEmpty()
        val step = AgentStep(
            id = stepId,
            type = StepType.SUBAGENT,
            name = displayName,
            status = SubagentCardReducer.mapSubagentStatus(snap.status),
            durationMs = snap.durationMs,
            subagent = snap,
        )
        if (idx >= 0) result[idx] = step else result.add(step)
        return result
    }

    private fun parseToolInput(raw: String?): JsonObject? {
        if (raw.isNullOrBlank()) return null
        val element = runCatching { json.parseToJsonElement(raw) }.getOrNull() ?: return null
        val obj = element as? JsonObject ?: return null
        val kwargs = obj["kwargs"] as? JsonObject ?: return obj
        return JsonObject(kwargs + obj) // top-level wins over kwargs
    }

    private fun stringField(key: String, input: JsonObject?): String? {
        val raw = (input?.get(key) as? JsonPrimitive)?.contentOrNull ?: return null
        return raw.trim().takeIf { it.isNotEmpty() }
    }

    private fun firstReadableField(input: JsonObject?, vararg keys: String): String? =
        keys.firstNotNullOfOrNull { key ->
            SubagentDisplayTitle.sanitize(stringField(key, input))
        }

    private fun resultTextOf(block: BlockItem): String? =
        block.resultText ?: block.output ?: block.content ?: block.text

    private fun parseEpochSeconds(createdAt: String?): Double? {
        if (createdAt.isNullOrBlank()) return null
        return try {
            Instant.parse(createdAt).epochSecond.toDouble()
        } catch (_: Exception) {
            createdAt.toDoubleOrNull()
        }
    }
}
