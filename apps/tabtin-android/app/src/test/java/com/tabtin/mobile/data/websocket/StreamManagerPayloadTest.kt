package com.tabtin.mobile.data.websocket

import com.tabtin.mobile.data.model.ConversationAgentMode
import com.tabtin.mobile.data.model.ConversationApprovalMode
import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import com.tabtin.mobile.data.model.FocusTabSnapshot
import com.tabtin.mobile.data.model.TodoStatus
import com.tabtin.mobile.data.model.WSEnvelope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StreamManagerPayloadTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    @Test
    fun `send payload explicitly carries the frozen runtime configuration`() {
        val payload = buildChatSendMessagePayload(
            sessionId = "session-1",
            message = "ship it",
            blocks = null,
            modelId = "model-1",
            runtimeConfiguration = ConversationRuntimeConfiguration(
                agentMode = ConversationAgentMode.GROUP,
                approvalMode = ConversationApprovalMode.AUTO,
            ),
            clientEventId = "client-1",
            userTimeZone = "Asia/Shanghai",
        )

        assertEquals("group", payload["agent_mode"]?.jsonPrimitive?.content)
        assertEquals("auto", payload["approval_mode"]?.jsonPrimitive?.content)
        assertEquals("model-1", payload["model_id"]?.jsonPrimitive?.content)
    }

    @Test
    fun `send payload carries frozen focus and ignores missing focus with timezone only`() {
        val withFocus = buildChatSendMessagePayload(
            sessionId = "session-1",
            message = "from doc A",
            blocks = null,
            modelId = "model-1",
            runtimeConfiguration = ConversationRuntimeConfiguration(),
            clientEventId = "client-1",
            userTimeZone = "UTC",
            focus = ConversationFocusContext(
                appType = "tabdoc",
                spaceId = "space-1",
                userTimeZone = "Asia/Shanghai",
                openTabs = listOf(
                    FocusTabSnapshot(type = "tabdoc", id = "doc-a", title = "A", active = true),
                ),
            ),
        )
        val appContext = withFocus["app_context"]!!.jsonObject
        assertEquals("tabdoc", appContext["appType"]?.jsonPrimitive?.content)
        assertEquals("space-1", appContext["spaceId"]?.jsonPrimitive?.content)
        assertEquals("Asia/Shanghai", appContext["userTimeZone"]?.jsonPrimitive?.content)
        assertEquals("doc-a", appContext["openTabs"]!!.jsonArray[0].jsonObject["id"]?.jsonPrimitive?.content)

        val legacy = buildChatSendMessagePayload(
            sessionId = "session-1",
            message = "legacy",
            blocks = null,
            modelId = "model-1",
            runtimeConfiguration = ConversationRuntimeConfiguration(),
            clientEventId = "client-2",
            userTimeZone = "UTC",
            focus = null,
        )
        val legacyCtx = legacy["app_context"]!!.jsonObject
        assertEquals("UTC", legacyCtx["user_time_zone"]?.jsonPrimitive?.content)
        assertNull(legacyCtx["appType"])
    }

    @Test
    fun `todo live payload replaces the active snapshot and honors closed`() {
        val active = decodeTodoUpdatePayload(
            json.parseToJsonElement(
                """{
                  "todos":[
                    {"id":"one","content":"第一步","status":"completed"},
                    {"id":"two","content":"第二步","status":"paused"}
                  ],
                  "closed":false
                }""",
            ).jsonObject,
        )

        assertEquals(listOf("one", "two"), active?.todos?.map { it.id })
        assertEquals(
            listOf(TodoStatus.COMPLETED, TodoStatus.PAUSED),
            active?.todos?.map { it.status },
        )

        val closed = decodeTodoUpdatePayload(
            json.parseToJsonElement(
                """{
                  "todos":[{"id":"one","content":"第一步","status":"completed"}],
                  "closed":true
                }""",
            ).jsonObject,
        )

        assertEquals(emptyList<Any>(), closed?.todos)
    }

    @Test
    fun `single hitl resolved payload decodes request id and skipped outcome`() {
        val event = decodeSingleHitlResolvedEvent(
            WSEnvelope(
                type = "agent.stream.single_hitl_resolved",
                payload = buildJsonObject {
                    put("request_id", "request-1")
                    put("outcome", "skipped")
                },
            ),
        )

        assertEquals("request-1", event?.requestId)
        assertEquals("skipped", event?.outcome)
    }

    @Test
    fun `live formal oss image keeps file identity and http fallback`() {
        val block = decodeRichContentBlock(
            json.parseToJsonElement(
                """{
                  "type":"tabtin_rich_content",
                  "kind":"image",
                  "summary":"永久图片",
                  "payload":{
                    "artifact_kind":"oss_file",
                    "file_id":"file-live-001",
                    "file_name":"live.png",
                    "mime_type":"image/png",
                    "file_size":4096,
                    "access_url":"https://oss.example.com/live.png",
                    "url":"tabtin://resource/file/file-live-001?hint=tabfiles"
                  }
                }""",
            ).jsonObject,
        )

        assertEquals("file-live-001", block.fileId)
        assertEquals("https://oss.example.com/live.png", block.url)
        assertEquals("live.png", block.filename)
        assertEquals("image/png", block.mimeType)
        assertEquals(4096L, block.fileSize)
    }

    @Test
    fun `live formal oss image never forwards resource uri without http fallback`() {
        val block = decodeRichContentBlock(
            json.parseToJsonElement(
                """{
                  "type":"tabtin_rich_content",
                  "kind":"image",
                  "payload":{
                    "artifact_kind":"oss_file",
                    "file_id":"file-live-private",
                    "url":"tabtin://resource/file/file-live-private?hint=tabfiles"
                  }
                }""",
            ).jsonObject,
        )

        assertEquals("file-live-private", block.fileId)
        assertNull(block.url)
    }

    @Test
    fun `live OSS file keeps file identity and access URL for mobile preview`() {
        val block = decodeRichContentBlock(
            json.parseToJsonElement(
                """{
                  "type":"tabtin_rich_content",
                  "kind":"file",
                  "payload":{
                    "artifact_kind":"oss_file",
                    "file_id":"file-report-001",
                    "filename":"report.xlsx",
                    "mime_type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "file_size":4096,
                    "access_url":"https://oss.example.com/report.xlsx"
                  }
                }""",
            ).jsonObject,
        )

        assertEquals("file-report-001", block.fileId)
        assertEquals("https://oss.example.com/report.xlsx", block.url)
        assertEquals("report.xlsx", block.filename)
        assertEquals(4096L, block.fileSize)
    }
}
