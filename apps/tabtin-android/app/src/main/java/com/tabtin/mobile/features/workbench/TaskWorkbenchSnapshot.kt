package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.features.files.CloudDriveFileCategory
import com.tabtin.mobile.features.files.CloudDriveFilePresentation
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

/**
 * 任务工作台「本任务产出」条目。对齐 iOS `TaskWorkbenchOutput`。
 */
public data class TaskWorkbenchOutput(
    val id: String,
    val resourceType: String,
    val resourceId: String,
    val title: String,
    val preview: String?,
    val timestampMs: Long,
    val resource: SpaceResource?,
    val openRequest: WorkbenchResourceOpenRequest,
    val mimeType: String? = null,
) {
    val typeLabel: String
        get() = resource?.typeLabel
            ?: when (SpaceResource.normalizedType(resourceType)) {
                "tabdoc" -> "TabDoc"
                "tabdata" -> "TabData"
                "tabsite" -> "TabSite"
                "tabslide" -> "TabSlide"
                "tabmemo" -> "TabMemo"
                "tabfiles" -> "TabFiles"
                "widget" -> "图示"
                else -> resourceType
            }

    val canOpen: Boolean
        get() = when (SpaceResource.normalizedType(resourceType)) {
            "tabsite" -> resource != null
            "tabfiles" ->
                resource != null ||
                    TaskWorkbenchConversationArtifactPolicy.isOpenableFileRecord(resourceId)
            "widget" -> false
            else -> openRequest.resourceId.isNotBlank()
        }
}

/** 「本任务产出」列表：满宽条 + 默认只露出前 5 条。对齐 iOS `TaskWorkbenchOutputListPolicy`。 */
internal object TaskWorkbenchOutputListPolicy {
    const val COLLAPSED_VISIBLE_COUNT: Int = 5

    fun <T> visible(outputs: List<T>, expanded: Boolean): List<T> {
        if (expanded || outputs.size <= COLLAPSED_VISIBLE_COUNT) return outputs
        return outputs.take(COLLAPSED_VISIBLE_COUNT)
    }

    fun hiddenCount(total: Int, expanded: Boolean): Int {
        if (expanded || total <= COLLAPSED_VISIBLE_COUNT) return 0
        return total - COLLAPSED_VISIBLE_COUNT
    }
}

/** 工作台「继续工作」复用文档 / 多维表「继续处理」卡的投影。 */
public object TaskWorkbenchContinueWindowPolicy {
    public fun homeKind(resourceType: String): WorkbenchAppHomeKind? {
        val kind = WorkbenchAppHomeKind.fromAppId(SpaceResource.normalizedType(resourceType))
        return kind.takeIf { it == WorkbenchAppHomeKind.TABDOC || it == WorkbenchAppHomeKind.TABDATA }
    }

    public fun usesContinueProcessingCard(resourceType: String): Boolean =
        homeKind(resourceType) != null

    public fun resource(output: TaskWorkbenchOutput): SpaceResource =
        output.resource ?: SpaceResource(
            id = output.id,
            itemType = SpaceResource.normalizedType(output.resourceType),
            title = output.title,
            preview = output.preview,
            resourceId = output.resourceId,
        )
}

/** 云文件产物卡复用云盘文件分类，不走统一的云盘 App 图标。 */
internal object TaskWorkbenchFilePresentation {
    fun category(output: TaskWorkbenchOutput): CloudDriveFileCategory? {
        if (SpaceResource.normalizedType(output.resourceType) != "tabfiles") return null
        return CloudDriveFilePresentation.classify(
            itemType = "tabfiles",
            fileName = output.resource?.fileName?.takeIf { it.isNotBlank() } ?: output.title,
            mimeType = output.mimeType ?: output.resource?.mimeType,
        )
    }

    fun viewportRow(output: TaskWorkbenchOutput, organizationId: String): CloudDriveResourceRow {
        output.resource?.let { return CloudDriveResourceRow.fromSpaceResource(it) }
        val mime = output.mimeType?.trim()?.takeIf { it.isNotEmpty() }
        val metadata: JsonObject? = mime?.let {
            buildJsonObject { put("mime_type", JsonPrimitive(it)) }
        }
        return CloudDriveResourceRow(
            contextItemId = "",
            resourceId = output.resourceId,
            fileRecordId = output.resourceId,
            itemType = "tabfiles",
            title = output.title,
            preview = output.preview,
            collectionId = null,
            organizationId = organizationId,
            spaceId = null,
            spaceName = null,
            owner = null,
            metadata = metadata,
            isPinned = false,
            lastVisitedAt = null,
            updatedAt = null,
            canView = true,
            canEdit = null,
            canMove = null,
            canShare = null,
            canTrash = null,
            canDelete = null,
        )
    }
}

/**
 * 从对话 rich 块抽出可进产物区的指针。对齐 Electron
 * `isDeliverableRichBlock` / `richBlockToArtifact` 的可见产物口径
 *（oss_file / platform_resource / widget / local_file），不含 write_file 净算。
 */
public object TaskWorkbenchConversationArtifactPolicy {
    public data class Pointer(
        val rawType: String,
        val resourceId: String,
        val titleCandidates: List<String?>,
        val previewCandidates: List<String?>,
        val mimeType: String? = null,
    )

    private val presentationalKinds = setOf(
        "table_preview",
        "search_results",
        "memory_card",
        "document_excerpt",
    )
    private val deliverableArtifactKinds = setOf(
        "oss_file",
        "local_file",
        "platform_resource",
    )

    public fun acceptsType(resourceType: String): Boolean {
        val normalized = SpaceResource.normalizedType(resourceType).trim()
        return normalized.isNotEmpty() && normalized !in presentationalKinds
    }

    public fun isOpenableFileRecord(resourceId: String): Boolean {
        val id = resourceId.trim()
        if (id.isEmpty()) return false
        if (id.contains('/') || id.contains('\\')) return false
        if (id.contains('\u2026') || id.contains("...")) return false
        return true
    }

    public fun pointer(from: BlockItem): Pointer? {
        val block = from
        val kind = block.kind.orEmpty()
        val artifactKind = block.artifactKind.orEmpty()
        if (kind in presentationalKinds && artifactKind !in deliverableArtifactKinds) {
            return null
        }
        if (kind == "widget") {
            val widgetId = block.widgetId?.trim().orEmpty()
            if (widgetId.isEmpty() || widgetId.startsWith("pending:")) return null
            if (!widgetHasDeliverableContent(block)) return null
            return Pointer(
                rawType = "widget",
                resourceId = widgetId,
                titleCandidates = listOf(block.title, block.summary, "图示"),
                previewCandidates = listOf(block.summary),
            )
        }
        if (artifactKind == "oss_file" || (kind in setOf("file", "image") && !block.fileId.isNullOrBlank())) {
            val fileId = block.fileId?.trim()?.takeIf { it.isNotEmpty() }
                ?: fileIdFromResourceUrl(block.url)
                ?: return null
            return Pointer(
                rawType = "tabfiles",
                resourceId = fileId,
                titleCandidates = listOf(block.filename, block.title, block.summary),
                previewCandidates = listOf(block.summary, block.filename),
                mimeType = inferredMimeType(block),
            )
        }
        if (artifactKind == "local_file") {
            val path = block.relativePath?.trim().orEmpty()
            if (path.isEmpty()) return null
            return Pointer(
                rawType = "tabfiles",
                resourceId = path,
                titleCandidates = listOf(block.filename, block.title, path),
                previewCandidates = listOf(block.summary, block.filename),
                mimeType = inferredMimeType(block),
            )
        }
        val rawType = block.resourceType?.trim().orEmpty()
        val resourceId = block.resourceId?.trim().orEmpty()
        if (rawType.isEmpty() || resourceId.isEmpty()) {
            return fileIdFromResourceUrl(block.url)?.let { fileId ->
                Pointer(
                    rawType = "tabfiles",
                    resourceId = fileId,
                    titleCandidates = listOf(block.filename, block.title, block.summary),
                    previewCandidates = listOf(block.summary, block.filename),
                    mimeType = inferredMimeType(block),
                )
            }
        }
        return Pointer(
            rawType = rawType,
            resourceId = resourceId,
            titleCandidates = listOf(
                block.resourceName,
                block.title,
                block.filename,
                block.summary,
            ),
            previewCandidates = listOf(
                block.summary,
                block.caption,
                block.filename,
            ),
            mimeType = inferredMimeType(block),
        )
    }

    private fun widgetHasDeliverableContent(block: BlockItem): Boolean =
        listOf(
            block.code,
            block.sourceCode,
            block.mermaidSource,
            block.renderedCode,
            block.imageUrl,
            block.url,
        ).any { !it.isNullOrBlank() }

    private fun inferredMimeType(block: BlockItem): String? =
        block.mimeType?.trim()?.takeIf { it.isNotEmpty() }
            ?: if (block.kind == "image") "image/*" else null

    private fun fileIdFromResourceUrl(url: String?): String? {
        val href = url?.trim().orEmpty()
        if (!href.startsWith("tabtin://resource/file/")) return null
        val rest = href.removePrefix("tabtin://resource/file/")
        val id = rest.substringBefore('?').let { encoded ->
            runCatching { URLDecoder.decode(encoded, StandardCharsets.UTF_8) }.getOrDefault(encoded)
        }
        return id.takeIf { it.isNotBlank() }
    }
}

/**
 * 任务工作台总览快照。对齐 iOS `TaskWorkbenchSnapshot`（检查点字段本期可空）。
 */
public data class TaskWorkbenchSnapshot(
    val resumeItem: TaskWorkbenchOutput?,
    val outputs: List<TaskWorkbenchOutput>,
    val agentName: String = "Agent",
) {
    public companion object {
        public fun empty(agentName: String = "Agent"): TaskWorkbenchSnapshot =
            TaskWorkbenchSnapshot(resumeItem = null, outputs = emptyList(), agentName = agentName)
    }
}

/** 从 assistant 正文提取 `tabtin://resource/<type>/<id>`。对齐 iOS `TaskWorkbenchResourceLinkExtractor`。 */
public object TaskWorkbenchResourceLinkExtractor {
    public data class Link(
        val resourceType: String,
        val resourceId: String,
        val title: String?,
    )

    private val mdLinkRegex =
        Regex("""\[([^\]]+)\]\((tabtin://resource/[^)\s"'`]+)\)""")
    private val bareUriRegex =
        Regex("""tabtin://resource/[^\s)\]"'`]+""")
    private val fencedCodeRegex = Regex("""```[\s\S]*?(?:```|$)""")
    private val inlineCodeRegex = Regex("""`[^`\n]*`""")

    public fun extract(rawText: String): List<Link> {
        if (!rawText.contains("tabtin://resource/")) return emptyList()
        val text = stripCodeSegments(rawText)
        if (!text.contains("tabtin://resource/")) return emptyList()

        val labelByUrl = linkedMapOf<String, String>()
        mdLinkRegex.findAll(text).forEach { match ->
            val label = stripMarkdownInline(match.groupValues[1])
            val url = sanitizeUri(match.groupValues[2])
            if (url.isNotEmpty() && label.isNotEmpty()) {
                labelByUrl.putIfAbsent(url, label)
            }
        }

        val links = mutableListOf<Link>()
        val seen = linkedSetOf<String>()
        bareUriRegex.findAll(text).forEach { match ->
            val href = sanitizeUri(match.value)
            val parsed = parseResourceUri(href) ?: return@forEach
            if (isTruncatedResourceId(parsed.first, parsed.second)) return@forEach
            val key = "${parsed.first}:${parsed.second}"
            if (!seen.add(key)) return@forEach
            links += Link(
                resourceType = parsed.first,
                resourceId = parsed.second,
                title = labelByUrl[href],
            )
        }
        return links
    }

    private fun stripCodeSegments(text: String): String =
        text.replace(fencedCodeRegex, " ").replace(inlineCodeRegex, " ")

    private fun stripMarkdownInline(value: String): String =
        value.replace(Regex("""[*`_~]"""), "").trim()

    private fun sanitizeUri(href: String): String =
        href.replace(Regex("""[.,;:!?。，、；：！？…]+$"""), "")

    private fun isTruncatedResourceId(type: String, id: String): Boolean {
        if (id.contains('\u2026')) return true
        return type != "file" && id.contains("...")
    }

    private fun parseResourceUri(href: String): Pair<String, String>? {
        if (!href.startsWith("tabtin://resource/")) return null
        val rest = href.removePrefix("tabtin://resource/")
        val path = rest.substringBefore('?')
        val slash = path.indexOf('/')
        if (slash <= 0 || slash >= path.lastIndex) return null
        val type = path.substring(0, slash).trim()
        val rawId = path.substring(slash + 1).trim()
        val id = runCatching {
            URLDecoder.decode(rawId, StandardCharsets.UTF_8.name())
        }.getOrDefault(rawId).trim()
        if (type.isEmpty() || id.isEmpty()) return null
        val aliases = mapOf("doc" to "document")
        return (aliases[type] ?: type) to id
    }
}

/** 从 `run_terminal_command` / CLI JSON 结果提取新建的 TabDoc、TabData。 */
internal object TaskWorkbenchCLIResourceExtractor {
    internal data class Resource(
        val resourceType: String,
        val resourceId: String,
        val title: String?,
    )

    private val json = Json { ignoreUnknownKeys = true }
    private val deliverableTypes = setOf("tabdoc", "tabdata")
    private val objectTypes = mapOf(
        "document" to "tabdoc",
        "table" to "tabdata",
        "doc" to "tabdoc",
    )
    private val fallbackPatterns = objectTypes.mapNotNull { (key, type) ->
        if (key == "doc") return@mapNotNull null
        type to Regex(""""$key"\s*:\s*\{[^{}]*?"id"\s*:\s*"([^"]+)"""")
    }
    private val titlePattern = Regex(""""(?:title|name)"\s*:\s*"([^"]+)"""")

    /**
     * 对齐 iOS `TaskWorkbenchCLIResourceExtractor.extract(from:)`：
     * 只看工具输出 JSON，不要求工具名是 terminal，也不要求命令字面量是 create。
     * Android 以前用这两道门把子 Agent / 非 Bash 工具结果丢掉，iOS 能看见的文档/表就会缺。
     */
    internal fun extract(rawText: String): List<Resource> {
        val text = rawText.trim()
        if (text.isEmpty()) return emptyList()

        val resources = mutableListOf<Resource>()
        val seen = linkedSetOf<String>()
        runCatching { json.parseToJsonElement(text) }
            .getOrNull()
            ?.let { collect(it, deliverableTypes, resources, seen) }

        if (resources.isEmpty()) collectByRegex(text, deliverableTypes, resources, seen)
        return resources
    }

    private fun collect(
        value: JsonElement,
        allowedTypes: Set<String>,
        resources: MutableList<Resource>,
        seen: MutableSet<String>,
    ) {
        when (value) {
            is JsonArray -> value.forEach { collect(it, allowedTypes, resources, seen) }
            is JsonObject -> {
                value.string("stdout")
                    ?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() }
                    ?.let { collect(it, allowedTypes, resources, seen) }

                (value["data"] as? JsonObject)?.let { data ->
                    collectResourceObjects(data, allowedTypes, resources, seen)
                    val type = data.string("item_type")
                        ?: data.string("resource_type")
                        ?: data.string("type")
                    val normalizedType = type?.let(SpaceResource::normalizedType)
                    val id = data.string("id")
                    if (normalizedType in allowedTypes && id != null) {
                        append(
                            type = normalizedType.orEmpty(),
                            id = id,
                            title = data.string("title") ?: data.string("name"),
                            resources = resources,
                            seen = seen,
                        )
                    }
                }

                collectResourceObjects(value, allowedTypes, resources, seen)
                value.values.forEach { collect(it, allowedTypes, resources, seen) }
            }
            else -> Unit
        }
    }

    private fun collectResourceObjects(
        value: JsonObject,
        allowedTypes: Set<String>,
        resources: MutableList<Resource>,
        seen: MutableSet<String>,
    ) {
        objectTypes.forEach { (key, type) ->
            if (type !in allowedTypes) return@forEach
            val resource = value[key] as? JsonObject ?: return@forEach
            val id = resource.string("id") ?: return@forEach
            append(
                type = type,
                id = id,
                title = resource.string("title") ?: resource.string("name"),
                resources = resources,
                seen = seen,
            )
        }
    }

    private fun collectByRegex(
        text: String,
        allowedTypes: Set<String>,
        resources: MutableList<Resource>,
        seen: MutableSet<String>,
    ) {
        fallbackPatterns.forEach { (type, pattern) ->
            if (type !in allowedTypes) return@forEach
            pattern.findAll(text).forEach { match ->
                append(
                    type = type,
                    id = match.groupValues[1],
                    title = titlePattern.find(match.value)?.groupValues?.get(1),
                    resources = resources,
                    seen = seen,
                )
            }
        }
    }

    private fun append(
        type: String,
        id: String,
        title: String?,
        resources: MutableList<Resource>,
        seen: MutableSet<String>,
    ) {
        val resourceId = id.trim()
        if (resourceId.isEmpty() || resourceId.contains('\u2026') || resourceId.contains("...")) return
        if (!seen.add("$type:$resourceId")) return
        resources += Resource(
            resourceType = type,
            resourceId = resourceId,
            title = title?.trim()?.takeIf { it.isNotEmpty() },
        )
    }

    private fun JsonObject.string(key: String): String? =
        (get(key) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
}

/**
 * 从会话消息 + Space 资源投影「本任务产出」。对齐 iOS `TaskWorkbenchProjector` 主路径
 *（rich_content + tabtin:// 链接 + CLI JSON + 跨消息 tool_result + 子 Agent 原文）。
 */
public object TaskWorkbenchProjector {
    public fun project(
        messages: List<ChatMessage>,
        resources: List<SpaceResource>,
        currentResourceType: String? = null,
        currentResourceId: String? = null,
        agentName: String = "Agent",
    ): TaskWorkbenchSnapshot {
        val resourcesByIdentity = resources
            .groupBy { resourceIdentity(it.normalizedType, it.resourceId) }
            .mapValues { (_, list) ->
                list.maxByOrNull { parseTimestampMs(it.updatedAt ?: it.lastVisitedAt ?: it.createdAt) }!!
            }

        val outputsByIdentity = linkedMapOf<String, TaskWorkbenchOutput>()

        fun recordPointer(
            rawType: String,
            resourceIdRaw: String,
            titleCandidates: List<String?>,
            previewCandidates: List<String?>,
            locationHint: String?,
            sourceTimestampMs: Long,
            mimeType: String? = null,
        ) {
            val resourceId = resourceIdRaw.trim().takeIf { it.isNotEmpty() } ?: return
            val resourceType = SpaceResource.normalizedType(rawType)
            if (!TaskWorkbenchConversationArtifactPolicy.acceptsType(resourceType)) return

            val identity = resourceIdentity(resourceType, resourceId)
            val resource = resourcesByIdentity[identity]
            val title = firstNonEmpty(
                listOf(resource?.displayTitle) + titleCandidates,
            ) ?: typeFallbackTitle(resourceType)
            val preview = firstNonEmpty(listOf(resource?.preview) + previewCandidates)
            val timestampMs = maxOf(
                sourceTimestampMs,
                parseTimestampMs(resource?.updatedAt ?: resource?.lastVisitedAt ?: resource?.createdAt),
            )
            val request = WorkbenchResourceOpenRequest(
                resourceType = resourceType,
                resourceId = resourceId,
                title = title,
                locationHint = locationHint,
            )
            val output = TaskWorkbenchOutput(
                id = identity,
                resourceType = resourceType,
                resourceId = resourceId,
                title = title,
                preview = preview,
                timestampMs = timestampMs,
                resource = resource,
                openRequest = request,
                mimeType = firstNonEmpty(listOf(mimeType, resource?.mimeType)),
            )
            val existing = outputsByIdentity[identity]
            if (existing != null && existing.timestampMs > output.timestampMs) return
            outputsByIdentity[identity] = output
        }

        fun recordRichContent(rawBlock: BlockItem, sourceTimestampMs: Long) {
            val block = rawBlock.normalizedRichContent()
            val pointer = TaskWorkbenchConversationArtifactPolicy.pointer(from = block) ?: return
            recordPointer(
                rawType = pointer.rawType,
                resourceIdRaw = pointer.resourceId,
                titleCandidates = pointer.titleCandidates,
                previewCandidates = pointer.previewCandidates,
                locationHint = block.spaceName,
                sourceTimestampMs = sourceTimestampMs,
                mimeType = pointer.mimeType,
            )
        }

        fun recordOutputText(
            rawText: String,
            titleCandidates: List<String?>,
            sourceTimestampMs: Long,
        ) {
            if (rawText.isBlank()) return
            for (link in TaskWorkbenchResourceLinkExtractor.extract(rawText)) {
                recordPointer(
                    rawType = link.resourceType,
                    resourceIdRaw = link.resourceId,
                    titleCandidates = listOf(link.title) + titleCandidates,
                    previewCandidates = emptyList(),
                    locationHint = null,
                    sourceTimestampMs = sourceTimestampMs,
                )
            }
            for (resource in TaskWorkbenchCLIResourceExtractor.extract(rawText)) {
                recordPointer(
                    rawType = resource.resourceType,
                    resourceIdRaw = resource.resourceId,
                    titleCandidates = listOf(resource.title) + titleCandidates,
                    previewCandidates = emptyList(),
                    locationHint = null,
                    sourceTimestampMs = sourceTimestampMs,
                )
            }
        }

        for (message in messages) {
            val ts = parseTimestampMs(message.createdAt)
            val scanConversationBody = message.isAssistant || message.isSubagentTranscript
            val blocks = message.blocksJson.orEmpty()
            for (rawBlock in blocks) {
                val block = if (rawBlock.isRichContent) rawBlock.normalizedRichContent() else rawBlock
                val toolOutputText = toolOutputText(block)
                val isResult = isToolResultBlock(block.type)
                when {
                    scanConversationBody && block.isRichContent -> recordRichContent(block, ts)
                    toolOutputText != null &&
                        block.isError != true &&
                        (scanConversationBody || isResult) -> {
                        recordOutputText(toolOutputText, emptyList(), ts)
                    }
                    scanConversationBody &&
                        (
                            block.type == "text" ||
                                !block.text.isNullOrBlank() ||
                                !block.content.isNullOrBlank()
                            ) -> {
                        val text = block.text ?: block.content ?: continue
                        if (isToolBlock(block.type)) continue
                        recordOutputText(text, emptyList(), ts)
                    }
                }
            }

            if (!scanConversationBody) continue

            // blocksJson 未投影时，工具结果仍可能只挂在 agentSteps.output。
            for (step in message.agentSteps.orEmpty()) {
                if (step.type != StepType.TOOL_CALL) continue
                if (step.status == StepStatus.FAILED) continue
                recordOutputText(step.output.orEmpty(), listOf(step.name), ts)
            }

            // 子 Agent 原始消息不进主时间线；历史/直播会把它们聚合进主消息的
            // AgentStep.subagent.transcript。保留 rich block 后在这里统一投影。
            for (run in message.agentSteps.orEmpty().mapNotNull { it.subagent }) {
                val runTimestampMs = subagentTimestampMs(run.endedAt ?: run.startedAt)
                    .takeIf { it > 0L }
                    ?: ts
                for (item in run.transcript) {
                    item.richContent?.let { recordRichContent(it, runTimestampMs) }

                    item.text?.let { text ->
                        recordOutputText(text, listOf(item.title), runTimestampMs)
                    }
                    if (!item.isError) {
                        item.outputText?.let { outputText ->
                            recordOutputText(
                                outputText,
                                listOf(item.title),
                                runTimestampMs,
                            )
                        }
                    }
                }
            }

            // content 里的 markdown 链接不一定再复制进 blocks，blocks 非空也要扫。
            if (message.content.isNotBlank()) {
                recordOutputText(message.content, emptyList(), ts)
            }
        }

        val outputs = outputsByIdentity.values.sortedWith(
            compareByDescending<TaskWorkbenchOutput> { it.timestampMs }
                .thenBy { it.id },
        )

        val currentType = currentResourceType?.let(SpaceResource::normalizedType)
        val currentId = currentResourceId?.trim()?.takeIf { it.isNotEmpty() }
        val resumeItem = if (currentType != null && currentId != null) {
            outputs.firstOrNull {
                it.resourceType == currentType && it.resourceId == currentId
            }
        } else {
            null
        } ?: outputs.firstOrNull()

        return TaskWorkbenchSnapshot(
            resumeItem = resumeItem,
            outputs = outputs,
            agentName = agentName.trim().ifEmpty { "Agent" },
        )
    }

    private fun resourceIdentity(type: String, id: String): String = "$type:$id"

    private fun isToolResultBlock(type: String?): Boolean {
        val normalized = type.orEmpty()
        return normalized == "tool_result" || normalized.endsWith("_tool_result")
    }

    private fun isToolBlock(type: String?): Boolean {
        val normalized = type.orEmpty()
        return normalized == "tool_use" ||
            normalized == "server_tool_use" ||
            isToolResultBlock(normalized)
    }

    private fun toolOutputText(block: BlockItem): String? {
        if (!isToolBlock(block.type)) return null
        return listOfNotNull(block.output, block.resultText, block.content)
            .firstOrNull { it.isNotBlank() }
    }

    private fun typeFallbackTitle(type: String): String = when (type) {
        "tabdoc" -> "文档"
        "tabdata" -> "多维表"
        "tabsite" -> "站点"
        "tabslide" -> "演示"
        "tabmemo" -> "笔记"
        "tabfiles" -> "文件"
        "widget" -> "图示"
        else -> type
    }

    private fun firstNonEmpty(values: List<String?>): String? =
        values.firstOrNull { !it.isNullOrBlank() }?.trim()

    internal fun parseTimestampMs(raw: String?): Long {
        if (raw.isNullOrBlank()) return 0L
        return runCatching { Instant.parse(raw).toEpochMilli() }.getOrElse {
            raw.toLongOrNull() ?: 0L
        }
    }

    private fun subagentTimestampMs(raw: Double?): Long {
        if (raw == null || !raw.isFinite() || raw <= 0.0) return 0L
        return if (raw > 1e12) raw.toLong() else (raw * 1000.0).toLong()
    }
}
