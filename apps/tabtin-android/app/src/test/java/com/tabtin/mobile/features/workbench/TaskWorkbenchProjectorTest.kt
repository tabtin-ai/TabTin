package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType
import com.tabtin.mobile.data.model.SubagentRunSnapshot
import com.tabtin.mobile.data.model.SubagentTranscriptItem
import com.tabtin.mobile.features.conversation.SubagentHistoryRehydration
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskWorkbenchProjectorTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `extracts markdown resource links from assistant text`() {
        val docId = "doc-abc-123"
        val messages = listOf(
            ChatMessage(
                id = "m1",
                role = "assistant",
                content = "已创建 [问候文档](tabtin://resource/document/$docId)",
                createdAt = "2026-08-06T04:00:00Z",
            ),
        )
        val snapshot = TaskWorkbenchProjector.project(
            messages = messages,
            resources = emptyList(),
        )
        assertEquals(1, snapshot.outputs.size)
        assertEquals("tabdoc", snapshot.outputs[0].resourceType)
        assertEquals(docId, snapshot.outputs[0].resourceId)
        assertEquals("问候文档", snapshot.outputs[0].title)
        assertEquals(snapshot.outputs[0], snapshot.resumeItem)
    }

    @Test
    fun `merges rich content with space resource title`() {
        val messages = listOf(
            ChatMessage(
                id = "m2",
                role = "assistant",
                blocksJson = listOf(
                    BlockItem(
                        type = "rich_content",
                        kind = "resource_ref",
                        resourceType = "tabdata",
                        resourceId = "table-1",
                        resourceName = "旧名",
                    ),
                ),
                createdAt = "2026-08-06T05:00:00Z",
            ),
        )
        val resources = listOf(
            SpaceResource(
                id = "ctx-1",
                itemType = "tabdata",
                title = "发布清单表",
                resourceId = "table-1",
                updatedAt = "2026-08-06T06:00:00Z",
            ),
        )
        val snapshot = TaskWorkbenchProjector.project(
            messages = messages,
            resources = resources,
            currentResourceType = "tabdata",
            currentResourceId = "table-1",
        )
        assertEquals(1, snapshot.outputs.size)
        assertEquals("发布清单表", snapshot.outputs[0].title)
        assertEquals("table-1", snapshot.resumeItem?.resourceId)
        assertTrue(snapshot.outputs[0].canOpen)
    }

    @Test
    fun `extracts cli document and table json from tool results`() {
        val documentId = "a7adaa70-825c-4d04-9155-0f83acc850db"
        val tableId = "b8bba80b-936d-5e15-a126-1a334db961cd"
        val messages = listOf(
            ChatMessage(
                id = "assistant-cli-artifacts",
                role = "assistant",
                blocksJson = listOf(
                    BlockItem(
                        type = "tool_use",
                        id = "terminal-doc",
                        name = "run_terminal_command",
                        inputJson =
                            """{"command":"tabtin doc create --title 随手记 --format json"}""",
                    ),
                    BlockItem(
                        type = "tool_result",
                        toolUseId = "terminal-doc",
                        content = "{\"status\":\"completed\",\"exit_code\":0,\"stdout\":" +
                            "\"{\\\"ok\\\":true,\\\"data\\\":{\\\"document\\\":{" +
                            "\\\"id\\\":\\\"$documentId\\\",\\\"title\\\":\\\"随手记\\\"}}}\"}",
                        isError = false,
                    ),
                    BlockItem(
                        type = "tool_use",
                        id = "terminal-table",
                        name = "Bash",
                        inputJson =
                            """{"command":"cd /tmp && tabtin table create --name 发布清单 --format json"}""",
                    ),
                    BlockItem(
                        type = "tool_result",
                        toolUseId = "terminal-table",
                        resultText =
                            """{"ok":true,"data":{"table":{"id":"$tableId","name":"发布清单"}}}""",
                        isError = false,
                    ),
                ),
                createdAt = "2026-08-06T07:00:00Z",
            ),
        )

        val snapshot = TaskWorkbenchProjector.project(
            messages = messages,
            resources = emptyList(),
        )

        assertEquals(2, snapshot.outputs.size)
        assertEquals(
            setOf("tabdoc:$documentId", "tabdata:$tableId"),
            snapshot.outputs.map { it.id }.toSet(),
        )
        assertEquals("随手记", snapshot.outputs.first { it.resourceId == documentId }.title)
        assertEquals("发布清单", snapshot.outputs.first { it.resourceId == tableId }.title)
    }

    @Test
    fun `extracts cli artifacts from tool json even when command is a read`() {
        val messages = listOf(
            ChatMessage(
                id = "assistant-cli-read",
                role = "assistant",
                blocksJson = listOf(
                    BlockItem(
                        type = "tool_use",
                        id = "terminal-read",
                        name = "run_terminal_command",
                        inputJson = """{"command":"tabtin doc read doc-existing --format json"}""",
                    ),
                    BlockItem(
                        type = "tool_result",
                        toolUseId = "terminal-read",
                        content =
                            """{"ok":true,"data":{"document":{"id":"doc-existing","title":"已有文档"}}}""",
                        isError = false,
                    ),
                ),
            ),
        )

        val snapshot = TaskWorkbenchProjector.project(messages = messages, resources = emptyList())

        assertEquals("doc-existing", snapshot.outputs.single().resourceId)
        assertEquals("已有文档", snapshot.outputs.single().title)
    }

    @Test
    fun `extracts cli json from agentSteps when blocks are empty`() {
        val messages = listOf(
            ChatMessage(
                id = "assistant-steps-only",
                role = "assistant",
                agentSteps = listOf(
                    AgentStep(
                        id = "create-doc",
                        type = StepType.TOOL_CALL,
                        name = "create_document",
                        status = StepStatus.COMPLETED,
                        output = """{"ok":true,"data":{"document":{"id":"doc-from-step","title":"步骤文档"}}}""",
                    ),
                ),
            ),
        )

        val snapshot = TaskWorkbenchProjector.project(messages = messages, resources = emptyList())

        assertEquals("doc-from-step", snapshot.outputs.single().resourceId)
        assertEquals("步骤文档", snapshot.outputs.single().title)
    }

    @Test
    fun `extracts markdown links from content even when tool blocks exist`() {
        val messages = listOf(
            ChatMessage(
                id = "assistant-content-and-tools",
                role = "assistant",
                content = "已创建 [问候文档](tabtin://resource/document/doc-from-content)",
                blocksJson = listOf(
                    BlockItem(
                        type = "tool_use",
                        id = "tu-1",
                        name = "run_terminal_command",
                    ),
                ),
            ),
        )

        val snapshot = TaskWorkbenchProjector.project(messages = messages, resources = emptyList())

        assertEquals("doc-from-content", snapshot.outputs.single().resourceId)
        assertEquals("问候文档", snapshot.outputs.single().title)
    }

    @Test
    fun `extracts cli artifact from live merged tool block`() {
        val message = ChatMessage(
            id = "assistant-cli-live",
            role = "assistant",
            blocksJson = listOf(
                BlockItem(
                    type = "tool_use",
                    id = "terminal-live",
                    name = "run_terminal_command",
                    inputJson =
                        """{"command":"tabtin table create --name 实时清单 --format json"}""",
                    resultText =
                        """{"ok":true,"data":{"table":{"id":"table-live","name":"实时清单"}}}""",
                    status = "completed",
                    isError = false,
                ),
            ),
        )

        val snapshot = TaskWorkbenchProjector.project(
            messages = listOf(message),
            resources = emptyList(),
        )

        assertEquals("table-live", snapshot.outputs.single().resourceId)
    }

    @Test
    fun `projects canonical nested resource artifact from history`() {
        val message = json.decodeFromString<ChatMessage>(
            """
                {
                  "id": "artifact-resource-001",
                  "role": "assistant",
                  "message_kind": "tool_artifact",
                  "content": "",
                  "content_blocks_json": [
                    {
                      "type": "tabtin_rich_content",
                      "kind": "resource_ref",
                      "summary": "项目周报",
                      "payload": {
                        "artifact_kind": "platform_resource",
                        "resource_type": "document",
                        "resource_id": "doc-001",
                        "resource_name": "项目周报",
                        "space_id": "space-001",
                        "url": "tabtin://resource/document/doc-001"
                      }
                    }
                  ]
                }
            """.trimIndent(),
        )

        val snapshot = TaskWorkbenchProjector.project(
            messages = listOf(message),
            resources = emptyList(),
        )

        assertEquals(1, snapshot.outputs.size)
        assertEquals("tabdoc", snapshot.outputs.single().resourceType)
        assertEquals("doc-001", snapshot.outputs.single().resourceId)
        assertEquals("项目周报", snapshot.outputs.single().title)
    }

    @Test
    fun `includes artifacts produced by a subagent transcript`() {
        val parent = ChatMessage(
            id = "parent-assistant",
            role = "assistant",
            agentSteps = listOf(
                AgentStep(
                    id = "subagent-run-child",
                    type = StepType.SUBAGENT,
                    name = "子 Agent",
                    status = StepStatus.COMPLETED,
                    subagent = SubagentRunSnapshot(
                        runId = "run-child",
                        status = SubagentRunSnapshot.Status.COMPLETED,
                    ),
                ),
            ),
            createdAt = "2026-08-06T08:00:00Z",
        )
        val child = json.decodeFromString<ChatMessage>(
            """
                {
                  "id": "child-artifact",
                  "role": "assistant",
                  "subagent_run_id": "run-child",
                  "content_blocks_json": [{
                    "type": "tabtin_rich_content",
                    "kind": "resource_ref",
                    "summary": "子 Agent 清单",
                    "payload": {
                      "artifact_kind": "platform_resource",
                      "resource_type": "table",
                      "resource_id": "table-from-child",
                      "resource_name": "子 Agent 清单"
                    }
                  }]
                }
            """.trimIndent(),
        )
        val rehydrated = SubagentHistoryRehydration.applyToMessages(
            messages = listOf(parent),
            childMessages = listOf(child),
        )

        val retainedRichContent = rehydrated.single()
            .agentSteps?.single()?.subagent?.transcript?.single()?.richContent
        assertEquals("table", retainedRichContent?.resourceType)
        assertEquals("table-from-child", retainedRichContent?.resourceId)

        val snapshot = TaskWorkbenchProjector.project(
            messages = rehydrated,
            resources = emptyList(),
        )

        assertEquals(1, snapshot.outputs.size)
        assertEquals("tabdata", snapshot.outputs.single().resourceType)
        assertEquals("table-from-child", snapshot.outputs.single().resourceId)
    }

    @Test
    fun `extracts cli json from subagent transcript without terminal tool name`() {
        val parent = ChatMessage(
            id = "parent-cli",
            role = "assistant",
            agentSteps = listOf(
                AgentStep(
                    id = "subagent-run-cli",
                    type = StepType.SUBAGENT,
                    name = "子 Agent",
                    status = StepStatus.COMPLETED,
                    subagent = SubagentRunSnapshot(
                        runId = "run-cli",
                        status = SubagentRunSnapshot.Status.COMPLETED,
                        transcript = listOf(
                            SubagentTranscriptItem(
                                id = "cli-item",
                                kind = SubagentTranscriptItem.Kind.TOOL,
                                title = "写文档",
                                outputText =
                                    """{"ok":true,"data":{"document":{"id":"doc-from-child-cli","title":"子文档"}}}""",
                                isFinal = true,
                                isError = false,
                            ),
                        ),
                    ),
                ),
            ),
        )

        val snapshot = TaskWorkbenchProjector.project(
            messages = listOf(parent),
            resources = emptyList(),
        )

        assertEquals("doc-from-child-cli", snapshot.outputs.single().resourceId)
        assertEquals("子文档", snapshot.outputs.single().title)
    }

    @Test
    fun `link extractor ignores fenced code blocks`() {
        val text = """
            |```
            |tabtin://resource/tabdoc/should-ignore
            |```
            |见 [真文档](tabtin://resource/tabdoc/real-doc)
        """.trimMargin()
        val links = TaskWorkbenchResourceLinkExtractor.extract(text)
        assertEquals(1, links.size)
        assertEquals("real-doc", links[0].resourceId)
    }

    @Test
    fun `continue window reuses app-home kind and resource fields`() {
        val output = TaskWorkbenchOutput(
            id = "tabdata:table-1",
            resourceType = "table",
            resourceId = "table-1",
            title = "需求表",
            preview = "3 条记录",
            timestampMs = 1_700_000_000_000L,
            resource = null,
            openRequest = WorkbenchResourceOpenRequest(
                resourceType = "table",
                resourceId = "table-1",
                title = "需求表",
            ),
        )
        assertEquals(WorkbenchAppHomeKind.TABDATA, TaskWorkbenchContinueWindowPolicy.homeKind(output.resourceType))
        assertTrue(TaskWorkbenchContinueWindowPolicy.usesContinueProcessingCard(output.resourceType))
        val resource = TaskWorkbenchContinueWindowPolicy.resource(output)
        assertEquals("需求表", resource.displayTitle)
        assertEquals("3 条记录", resource.preview)
        assertEquals("table-1", resource.resourceId)
        assertEquals("tabdata", resource.normalizedType)
    }

    @Test
    fun `collects oss file widget slide and file link like electron artifacts`() {
        val messages = listOf(
            ChatMessage(
                id = "m-artifacts",
                role = "assistant",
                blocksJson = listOf(
                    BlockItem(
                        type = "rich_content",
                        kind = "file",
                        filename = "周报.pdf",
                        fileId = "file-oss-1",
                        artifactKind = "oss_file",
                    ),
                    BlockItem(
                        type = "rich_content",
                        kind = "widget",
                        widgetId = "widget-1",
                        title = "流程示意",
                        sourceCode = "graph TD; A-->B",
                    ),
                    BlockItem(
                        type = "rich_content",
                        kind = "resource_ref",
                        resourceType = "slide",
                        resourceId = "slide-1",
                        resourceName = "路演稿",
                    ),
                    BlockItem(
                        type = "text",
                        text = "附件见 [采集表](tabtin://resource/file/file-from-link)",
                    ),
                ),
                createdAt = "2026-08-20T03:00:00Z",
            ),
        )

        val snapshot = TaskWorkbenchProjector.project(
            messages = messages,
            resources = emptyList(),
        )

        assertEquals(
            setOf(
                "tabfiles:file-oss-1",
                "widget:widget-1",
                "tabslide:slide-1",
                "tabfiles:file-from-link",
            ),
            snapshot.outputs.map { it.id }.toSet(),
        )
        assertTrue(snapshot.outputs.first { it.resourceId == "file-oss-1" }.canOpen)
        assertTrue(!snapshot.outputs.first { it.resourceType == "widget" }.canOpen)
        assertTrue(!TaskWorkbenchContinueWindowPolicy.usesContinueProcessingCard("file"))
    }

    @Test
    fun `local file path is listed but not openable on mobile`() {
        val snapshot = TaskWorkbenchProjector.project(
            messages = listOf(
                ChatMessage(
                    id = "m-local",
                    role = "assistant",
                    blocksJson = listOf(
                        BlockItem(
                            type = "rich_content",
                            kind = "file",
                            filename = "draft.md",
                            artifactKind = "local_file",
                            relativePath = "outputs/draft.md",
                        ),
                    ),
                ),
            ),
            resources = emptyList(),
        )
        assertEquals("outputs/draft.md", snapshot.outputs.single().resourceId)
        assertTrue(!snapshot.outputs.single().canOpen)
    }

    @Test
    fun `collects cli json from user-role tool_result carrier`() {
        val documentId = "c1adaa70-825c-4d04-9155-0f83acc850db"
        val snapshot = TaskWorkbenchProjector.project(
            messages = listOf(
                ChatMessage(
                    id = "assistant-tool-use",
                    role = "assistant",
                    blocksJson = listOf(
                        BlockItem(
                            type = "tool_use",
                            id = "terminal-doc",
                            name = "Bash",
                            inputJson = """{"command":"tabtin doc create --title 跨消息 --format json"}""",
                        ),
                    ),
                    createdAt = "2026-08-21T03:00:00Z",
                ),
                ChatMessage(
                    id = "user-tool-result-carrier",
                    role = "user",
                    blocksJson = listOf(
                        BlockItem(
                            type = "tool_result",
                            toolUseId = "terminal-doc",
                            content =
                                """{"ok":true,"data":{"document":{"id":"$documentId","title":"跨消息"}}}""",
                            isError = false,
                        ),
                    ),
                    createdAt = "2026-08-21T03:00:01Z",
                ),
            ),
            resources = emptyList(),
        )
        assertEquals(listOf("tabdoc:$documentId"), snapshot.outputs.map { it.id })
        assertEquals("跨消息", snapshot.outputs.single().title)
    }

    @Test
    fun `collects mcp tool result json on assistant message`() {
        val tableId = "d8bba80b-936d-5e15-a126-1a334db961cd"
        val snapshot = TaskWorkbenchProjector.project(
            messages = listOf(
                ChatMessage(
                    id = "assistant-mcp",
                    role = "assistant",
                    blocksJson = listOf(
                        BlockItem(
                            type = "mcp_tool_result",
                            toolUseId = "mcp-table",
                            content =
                                """{"ok":true,"data":{"table":{"id":"$tableId","name":"MCP 表"}}}""",
                            isError = false,
                        ),
                    ),
                    createdAt = "2026-08-21T04:00:00Z",
                ),
            ),
            resources = emptyList(),
        )
        assertEquals(listOf("tabdata:$tableId"), snapshot.outputs.map { it.id })
        assertEquals("MCP 表", snapshot.outputs.single().title)
    }

    @Test
    fun `collects child subagent transcript message not attached to parent`() {
        val documentId = "e7adaa70-825c-4d04-9155-0f83acc850eb"
        val snapshot = TaskWorkbenchProjector.project(
            messages = listOf(
                ChatMessage(
                    id = "parent-assistant",
                    role = "assistant",
                    content = "已派子任务",
                    createdAt = "2026-08-21T05:00:00Z",
                ),
                ChatMessage(
                    id = "child-subagent",
                    role = "assistant",
                    subagentRunId = "run-child-1",
                    blocksJson = listOf(
                        BlockItem(
                            type = "tool_result",
                            toolUseId = "child-doc",
                            content =
                                """{"ok":true,"data":{"document":{"id":"$documentId","title":"子 Agent 稿"}}}""",
                        ),
                    ),
                    createdAt = "2026-08-21T05:00:02Z",
                ),
            ),
            resources = emptyList(),
        )
        assertEquals(listOf("tabdoc:$documentId"), snapshot.outputs.map { it.id })
        assertEquals("子 Agent 稿", snapshot.outputs.single().title)
    }
}
