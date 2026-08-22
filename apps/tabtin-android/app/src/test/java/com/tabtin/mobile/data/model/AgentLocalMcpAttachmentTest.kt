package com.tabtin.mobile.data.model

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Agent 本机 MCP 摘要：兼容 camel / snake 字段。 */
public class AgentLocalMcpAttachmentTest {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        isLenient = true
    }

    @Test
    public fun decode_snakeCaseTransportKind() {
        val raw = """
            {
              "connections": [
                {
                  "id": "c1",
                  "name": "GitHub",
                  "description": "",
                  "transport_kind": "stdio",
                  "command": "npx",
                  "enabled": true,
                  "source": { "kind": "manual", "label": "Manual" }
                }
              ]
            }
        """.trimIndent()
        val parsed = json.decodeFromString(AgentLocalMcpAttachmentListResponse.serializer(), raw)
        assertEquals(1, parsed.connections.size)
        assertEquals("stdio", parsed.connections[0].transportKind)
        assertEquals(OrgMcpSourceKind.LOCAL, parsed.connections[0].sourceKind)
    }

    @Test
    public fun decode_camelCaseTransportKind() {
        val raw = """
            {
              "connections": [
                {
                  "id": "c2",
                  "name": "Notion",
                  "transportKind": "http",
                  "url": "https://mcp.notion.com",
                  "enabled": true,
                  "source": { "kind": "organization", "label": "Org" }
                }
              ]
            }
        """.trimIndent()
        val parsed = json.decodeFromString(AgentLocalMcpAttachmentListResponse.serializer(), raw)
        assertEquals("http", parsed.connections[0].transportKind)
        assertEquals("https://mcp.notion.com", parsed.connections[0].endpointForBrand)
        assertTrue(parsed.connections[0].source!!.isOrganization)
        assertEquals(OrgMcpSourceKind.ORGANIZATION, parsed.connections[0].sourceKind)
    }
}
