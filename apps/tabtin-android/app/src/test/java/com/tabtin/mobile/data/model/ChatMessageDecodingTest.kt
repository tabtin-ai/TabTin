package com.tabtin.mobile.data.model

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `ChatMessage` JSON 反序列化行为单元测试。
 *
 * W4.5 第二波 P0-2 升级（2026-05-12，三视角 Review 暴露）回归守卫：
 *
 * Django 自 W4c 起后端 schema 把 `ChatMessageOut.blocks_json` 重命名为
 * `content_blocks_json`（对齐 ChatMessage Model 真字段名），见
 * `apps/tabtin_django/apps/chat/conversation/schemas.py:83-84`。但 Android
 * 仍只解码 `blocks_json`——拉历史 API 时 `blocksJson` 一直是 null，**isRichContent
 * 修双字面量识别也救不了**（blocks 整段拿不到）。
 *
 * @JsonNames 同时接受新旧字段名后，Android 历史回放与 Electron 直播路径行为对齐：
 *   - W4c+ 后端 `content_blocks_json` → blocksJson 正常解码
 *   - 旧字段名 `blocks_json`（本地 cache / 老 daemon emit）→ 仍兼容
 *   - 两键并存 → 以新字段名为准（防御性兜底，避免老数据污染）
 */
class ChatMessageDecodingTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `decodes message level agent identity and keeps agent switch audits off the timeline`() {
        val assistant = json.decodeFromString<ChatMessage>(
            """
                {
                  "id": "assistant-identity",
                  "role": "assistant",
                  "agent_id": "agent-executor"
                }
            """.trimIndent(),
        )
        val audit = json.decodeFromString<ChatMessage>(
            """
                {
                  "id": "agent-switch-audit",
                  "role": "system",
                  "content": "切换当前 Agent",
                  "metadata": { "system_fact": "agent_switched" }
                }
            """.trimIndent(),
        )

        assertEquals("agent-executor", assistant.agentId)
        assertTrue(audit.isAgentSwitchAudit)
        assertFalse(assistant.isAgentSwitchAudit)
    }

    @Test
    fun `recognizes persisted and legacy internal context messages without hiding referenced context`() {
        val persistedProfile = ChatMessage(
            id = "profile-kind",
            role = "system",
            messageKind = "agent_profile_context",
            content = "Agent profile",
        )
        val legacyProfile = ChatMessage(
            id = "profile-legacy",
            role = "user",
            content = "<context type=\"agent-profile\">\nname\n</context>",
        )
        val referencedContext = ChatMessage(
            id = "referenced",
            role = "user",
            content = "<context type=\"referenced\">\ndoc\n</context>",
        )
        val legacyIdentity = ChatMessage(
            id = "identity",
            role = "user",
            content = "<identity>internal identity</identity>",
        )
        val shareContract = json.decodeFromString<ChatMessage>(
            """{"id":"contract","role":"assistant","content":"internal","metadata":{"share_contract":true}}""",
        )

        assertTrue(persistedProfile.isInternalContext)
        assertTrue(legacyProfile.isInternalContext)
        assertTrue(legacyIdentity.isInternalContext)
        assertTrue(shareContract.isInternalContext)
        assertTrue(
            ChatMessage(
                id = "environment",
                role = "system",
                messageKind = "environment_context",
            ).isInternalContext,
        )
        assertTrue(
            ChatMessage(
                id = "system-prompt",
                role = "system",
                messageKind = "system_prompt_context",
                content = "<system-prompt>internal</system-prompt>",
            ).isInternalContext,
        )
        assertTrue(
            ChatMessage(
                id = "external-archive",
                role = "assistant",
                messageKind = "external_archive_context",
            ).isInternalContext,
        )
        org.junit.Assert.assertFalse(referencedContext.isInternalContext)
    }

    @Test
    fun `compaction_summary kind and markers are presentation not internal hide`() {
        val byKind = ChatMessage(
            id = "compact-kind",
            role = "user",
            messageKind = "compaction_summary",
            content = "should not appear as user bubble",
        )
        val byMarkers = ChatMessage(
            id = "compact-markers",
            role = "user",
            content = "[对话摘要]\n先前讨论了发布计划\n[摘要结束]\n[最近对话如下]",
        )
        val normalUser = ChatMessage(
            id = "normal",
            role = "user",
            content = "请继续上次的发布计划",
        )

        org.junit.Assert.assertFalse(byKind.isInternalContext)
        org.junit.Assert.assertFalse(byMarkers.isInternalContext)
        assertTrue(byKind.isCompactionSummary)
        assertTrue(byMarkers.isCompactionSummary)
        org.junit.Assert.assertFalse(normalUser.isCompactionSummary)
        org.junit.Assert.assertFalse(normalUser.isInternalContext)
    }

    @Test
    fun `decodes new content_blocks_json field name from W4c+ backend`() {
        val payload = """
            {
              "id": "msg-001",
              "role": "assistant",
              "content": "Q3 销售卡片",
              "content_blocks_json": [
                {
                  "type": "tabtin_rich_content",
                  "kind": "image",
                  "url": "https://oss.example.com/q3.png",
                  "summary": "Q3 销售图"
                }
              ]
            }
        """.trimIndent()

        val msg = json.decodeFromString<ChatMessage>(payload)
        assertNotNull(
            "Django W4c+ 返回 `content_blocks_json`，必须解码到 blocksJson —— " +
                "否则 isRichContent 修双字面量识别也救不了（blocks 整段拿不到）",
            msg.blocksJson,
        )
        assertEquals(1, msg.blocksJson?.size)
        assertEquals("tabtin_rich_content", msg.blocksJson?.first()?.type)
        assertTrue(msg.blocksJson?.first()?.isRichContent ?: false)
        assertEquals(1, msg.richContentBlocks.size)
    }

    @Test
    fun `normalizes canonical nested resource artifact for history rendering`() {
        val payload = """
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
        """.trimIndent()

        val msg = json.decodeFromString<ChatMessage>(payload)
        val block = msg.richContentBlocks.single()

        assertEquals("tool_artifact", msg.messageKind)
        assertEquals("resource_ref", block.kind)
        assertEquals("document", block.resourceType)
        assertEquals("doc-001", block.resourceId)
        assertEquals("项目周报", block.resourceName)
        assertEquals("space-001", block.spaceId)
        assertEquals("tabtin://resource/document/doc-001", block.url)
    }

    @Test
    fun `normalizes canonical nested image artifact without changing flat legacy fields`() {
        val nestedPayload = """
            {
              "id": "artifact-image-001",
              "role": "assistant",
              "content_blocks_json": [
                {
                  "type": "tabtin_rich_content",
                  "kind": "image",
                  "summary": "生成图片",
                  "payload": {
                    "url": "https://oss.example.com/generated.png",
                    "alt_text": "蓝色气球"
                  }
                }
              ]
            }
        """.trimIndent()
        val nested = json.decodeFromString<ChatMessage>(nestedPayload).richContentBlocks.single()
        assertEquals("https://oss.example.com/generated.png", nested.url)
        assertEquals("蓝色气球", nested.altText)

        val legacy = BlockItem(
            type = "rich_content",
            kind = "image",
            url = "https://oss.example.com/legacy.png",
        ).normalizedRichContent()
        assertEquals("https://oss.example.com/legacy.png", legacy.url)
    }

    @Test
    fun `normalizes formal oss image identity and ignores resource uri in history`() {
        val payload = """
            {
              "id": "artifact-image-oss-001",
              "role": "assistant",
              "message_kind": "tool_artifact",
              "content_blocks_json": [
                {
                  "type": "tabtin_rich_content",
                  "kind": "image",
                  "summary": "永久图片",
                  "payload": {
                    "artifact_kind": "oss_file",
                    "file_id": "file-001",
                    "file_name": "mountain.png",
                    "mime_type": "image/png",
                    "file_size": 8090,
                    "access_url": "https://oss.example.com/mountain.png",
                    "source_tool_use_id": "tool-use-android-1",
                    "url": "tabtin://resource/file/file-001?hint=tabfiles"
                  }
                }
              ]
            }
        """.trimIndent()

        val block = json.decodeFromString<ChatMessage>(payload).richContentBlocks.single()

        assertEquals("file-001", block.fileId)
        assertEquals("mountain.png", block.filename)
        assertEquals("image/png", block.mimeType)
        assertEquals(8090L, block.fileSize)
        assertEquals("https://oss.example.com/mountain.png", block.url)
        assertEquals("tool-use-android-1", block.sourceToolUseId)
    }

    @Test
    fun `formal oss image without fallback never exposes resource uri as image url`() {
        val payload = """
            {
              "id": "artifact-image-private-001",
              "role": "assistant",
              "content_blocks_json": [{
                "type": "tabtin_rich_content",
                "kind": "image",
                "payload": {
                  "artifact_kind": "oss_file",
                  "file_id": "file-private-001",
                  "url": "tabtin://resource/file/file-private-001?hint=tabfiles"
                }
              }]
            }
        """.trimIndent()

        val block = json.decodeFromString<ChatMessage>(payload).richContentBlocks.single()

        assertEquals("file-private-001", block.fileId)
        assertNull(block.url)
    }

    @Test
    fun `decodes legacy blocks_json field name for backward compatibility`() {
        // W4c 之前后端 / 本地 cache / 旧 daemon emit 仍可能携带 `blocks_json` 老字段名
        val payload = """
            {
              "id": "msg-old-001",
              "role": "assistant",
              "content": "旧数据 / 本地 cache",
              "blocks_json": [
                {
                  "type": "rich_content",
                  "kind": "image",
                  "url": "https://oss.example.com/old.png",
                  "summary": "老字段名兼容"
                }
              ]
            }
        """.trimIndent()

        val msg = json.decodeFromString<ChatMessage>(payload)
        assertNotNull(
            "向后兼容：旧字段名 `blocks_json` 仍需能解码，让本地 cache / 老后端混部正常",
            msg.blocksJson,
        )
        assertEquals(1, msg.blocksJson?.size)
        assertEquals("image", msg.blocksJson?.first()?.kind)
    }

    @Test
    fun `richContentBlocks filter accepts both legacy and reassembler block types`() {
        // 端到端：Django W4c+ 字段名 + Django reassembler 落库形态 `tabtin_rich_content`
        // 必须经 `richContentBlocks` filter 出现 1 张富内容卡片
        val payload = """
            {
              "id": "msg-e2e",
              "role": "assistant",
              "content": "混排消息",
              "content_blocks_json": [
                {"type": "text", "content": "前置说明"},
                {"type": "rich_content", "kind": "image", "summary": "前端 inline"},
                {"type": "tabtin_rich_content", "kind": "table_preview", "summary": "Django 落库"},
                {"type": "tool_use"}
              ]
            }
        """.trimIndent()

        val msg = json.decodeFromString<ChatMessage>(payload)
        assertEquals(
            "filter 需同时接住 rich_content + tabtin_rich_content——历史会话富内容卡片可见性回归",
            2,
            msg.richContentBlocks.size,
        )
        assertEquals("rich_content", msg.richContentBlocks[0].type)
        assertEquals("tabtin_rich_content", msg.richContentBlocks[1].type)
    }

    @Test
    fun `attachment-only history never renders the text summary placeholder as a message body`() {
        val payload = """
            {
              "id": "image-only-user-message",
              "role": "user",
              "content": "[富内容]",
              "content_blocks_json": [
                {
                  "type": "image",
                  "filename": "reference.png",
                  "url": "https://oss.example.com/reference.png"
                }
              ]
            }
        """.trimIndent()

        val msg = json.decodeFromString<ChatMessage>(payload)

        assertEquals(1, msg.imageAttachments.size)
        assertEquals(
            "[富内容] 只用于会话摘要；图片附件下不应再渲染一条文本消息",
            "",
            msg.displayContent,
        )

        val fileOnly = ChatMessage(
            id = "file-only-user-message",
            role = "user",
            blocksJson = listOf(
                BlockItem(
                    type = "file",
                    filename = "notes.pdf",
                    url = "https://oss.example.com/notes.pdf",
                ),
            ),
        )
        assertEquals(1, fileOnly.fileAttachments.size)
        assertEquals("纯文件没有正文时应保持为空", "", fileOnly.displayContent)
    }

    @Test
    fun `attachment history preserves a real text body when no text block is present`() {
        // 防御性兼容：上传链路在历史数据中只留下附件块时，仍不能因为本次过滤摘要占位
        // 而吞掉 API 已返回的用户正文。
        val message = ChatMessage(
            id = "file-with-caption",
            role = "user",
            content = "请查看这个文件",
            blocksJson = listOf(
                BlockItem(
                    type = "file",
                    filename = "notes.pdf",
                    url = "https://oss.example.com/notes.pdf",
                ),
            ),
        )

        assertEquals("请查看这个文件", message.displayContent)
        assertEquals(1, message.fileAttachments.size)
    }

    @Test
    fun `decodes subagent_run_id for main timeline filtering`() {
        val payload = """
            {
              "id": "child-msg-001",
              "role": "assistant",
              "content": "子 Agent transcript",
              "subagent_run_id": "run-child"
            }
        """.trimIndent()

        val msg = json.decodeFromString<ChatMessage>(payload)

        assertEquals("run-child", msg.subagentRunId)
        assertTrue(msg.isSubagentTranscript)
    }

    @Test
    fun `decodes web search result arrays without dropping the history message`() {
        val payload = """
            {
              "id": "search-history-1",
              "role": "assistant",
              "content": "[工具调用]",
              "content_blocks_json": [
                {"type":"server_tool_use","id":"srv-1","name":"web_search","input":{"query":"TabTin"}},
                {"type":"web_search_tool_result","tool_use_id":"srv-1","content":[{"type":"web_search_result","title":"TabTin","url":"https://tabtin.ai"}]},
                {"type":"tabtin_rich_content","kind":"search_results","summary":"legacy artifact"}
              ]
            }
        """.trimIndent()

        val message = json.decodeFromString<ChatMessage>(payload)

        assertEquals(3, message.blocksJson?.size)
        assertEquals("server_tool_use", message.blocksJson?.get(0)?.type)
        assertTrue(message.blocksJson?.get(1)?.content?.contains("https://tabtin.ai") == true)
    }
}
