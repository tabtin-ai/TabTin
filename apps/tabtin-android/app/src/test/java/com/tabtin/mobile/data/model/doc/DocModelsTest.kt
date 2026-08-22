package com.tabtin.mobile.data.model.doc

import com.tabtin.mobile.data.api.json
import com.tabtin.mobile.data.model.ApiEnvelope
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DocModelsTest {

    @Test
    fun `organization-owned document response accepts null space id`() {
        val response = json.decodeFromString<DocDetailResponse>(
            """{"document":{"id":"doc-1","organization_id":"org-1","space_id":null,"title":"Untitled"}}""",
        )

        assertNull(response.document.spaceId)
    }

    @Test
    fun `create document request does not send deprecated space id`() {
        val payload = json.encodeToString(CreateDocRequest(organizationId = "org-1", title = "Untitled"))

        assertFalse(payload.contains("space_id"))
    }

    @Test
    fun `whole document save declares replace write intent`() {
        val payload = json.encodeToString(
            SaveContentRequest(
                contentPmJson = buildJsonObject {},
                contentMarkdown = "正文",
            ),
        )

        assertTrue(payload.contains("\"write_intent\":\"replace\""))
    }

    @Test
    fun `save response accepts document only backend contract`() {
        val envelope = json.decodeFromString<ApiEnvelope<SaveContentResponse>>(
            """{"success":true,"data":{"document":{"id":"doc-1","organization_id":"org-1","title":"Updated","latest_version":2}}}""",
        )

        assertEquals("Updated", envelope.unwrap().document.title)
        assertNull(envelope.unwrap().content)
    }
}
