package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.doc.DocHistoryEntry
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

public class CollabDocHistoryWireContractTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    public fun `version list decodes the collab status envelope and array data`() {
        val response = json.decodeFromString<CollabApiEnvelope<List<DocHistoryEntry>>>(
            """{
                "status": "ok",
                "data": [{
                    "id": "version-1",
                    "module": "doc",
                    "is_snapshot": true,
                    "editor_type": "user",
                    "created_at": "2026-08-13T08:00:00Z"
                }],
                "total": 1
            }""".trimIndent(),
        )

        assertEquals("ok", response.status)
        assertEquals("version-1", response.unwrap().single().id)
    }

    @Test
    public fun `restore decodes the collab status envelope and object data`() {
        val response = json.decodeFromString<CollabApiEnvelope<Map<String, String>>>(
            """{
                "status": "ok",
                "data": {
                    "version_id": "version-restored",
                    "sync_mode": "incremental"
                }
            }""".trimIndent(),
        )

        assertEquals("version-restored", response.unwrap()["version_id"])
        assertEquals("incremental", response.unwrap()["sync_mode"])
    }
}
