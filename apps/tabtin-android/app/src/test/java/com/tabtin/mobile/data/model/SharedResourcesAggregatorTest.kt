package com.tabtin.mobile.data.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SharedResourcesAggregatorTest {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        isLenient = true
    }

    private fun item(
        type: SharedResourceType,
        resourceId: String,
        title: String,
        updatedAt: String? = null,
    ): SharedResourceItem = SharedResourceItem(
        resourceType = type,
        resourceId = resourceId,
        title = title,
        organizationId = "org-1",
        spaceId = null,
        permission = "viewer",
        updatedAt = updatedAt,
        sharedBy = null,
    )

    @Test
    fun mergeSortsByUpdatedAtDescending() {
        val older = item(SharedResourceType.DOC, "a", "A", "2026-07-01T00:00:00+00:00")
        val newer = item(SharedResourceType.TABLE, "b", "B", "2026-07-20T00:00:00+00:00")
        val undated = item(SharedResourceType.DOC, "c", "C", null)
        val merged = SharedResourcesAggregator.merged(docs = listOf(older, undated), tables = listOf(newer))
        assertEquals(listOf("b", "a", "c"), merged.map { it.resourceId })
    }

    @Test
    fun mergeOfTwoEmptyArraysYieldsEmpty() {
        assertTrue(SharedResourcesAggregator.merged(docs = emptyList(), tables = emptyList()).isEmpty())
    }

    @Test
    fun mergeKeepsAllItemsWhenOneArrayIsEmpty() {
        val doc = item(SharedResourceType.DOC, "a", "A", "2026-07-01T00:00:00+00:00")
        assertEquals(listOf("a"), SharedResourcesAggregator.merged(listOf(doc), emptyList()).map { it.resourceId })
        assertEquals(listOf("a"), SharedResourcesAggregator.merged(emptyList(), listOf(doc)).map { it.resourceId })
    }

    @Test
    fun mergeBreaksTiesByTitle() {
        val sameTime = "2026-07-20T00:00:00+00:00"
        val bravo = item(SharedResourceType.DOC, "b", "Bravo", sameTime)
        val alpha = item(SharedResourceType.TABLE, "a", "Alpha", sameTime)
        assertEquals(
            listOf("a", "b"),
            SharedResourcesAggregator.merged(docs = listOf(bravo), tables = listOf(alpha)).map { it.resourceId },
        )
    }

    @Test
    fun mergeParsesFractionalSecondTimestamps() {
        val fractional = item(SharedResourceType.DOC, "frac", "A", "2026-07-20T00:00:00.123Z")
        val plain = item(SharedResourceType.DOC, "plain", "B", "2026-07-01T00:00:00Z")
        assertNotNull(Iso8601DateParser.epochMillis("2026-07-20T00:00:00.123Z"))
        assertEquals(
            listOf("frac", "plain"),
            SharedResourcesAggregator.merged(docs = listOf(plain, fractional), tables = emptyList())
                .map { it.resourceId },
        )
    }

    @Test
    fun emptyTitleFallsBackToDisplayTitle() {
        val item = item(SharedResourceType.DOC, "doc-1", title = "")
        assertFalse(item.displayTitle.isEmpty())
    }

    @Test
    fun whitespaceOnlySpaceIdNormalizesToNil() {
        assertNull(SharedResourceNormalizer.normalizedId("   "))
        assertNull(SharedResourceNormalizer.normalizedId(null))
        assertEquals("ws-2", SharedResourceNormalizer.normalizedId(" ws-2 "))
    }

    @Test
    fun resolveThrowsWhenBothSourcesFailed() {
        try {
            SharedResourcesAggregator.resolve(docs = null, tables = null)
            fail("expected SharedResourcesLoadException")
        } catch (_: SharedResourcesLoadException) {
            // expected
        }
    }

    @Test
    fun resolveKeepsTablesWhenDocsFailed() {
        val tables = decodeTables(listOf("t-1"))
        val items = SharedResourcesAggregator.resolve(docs = null, tables = tables)
        assertEquals(listOf("t-1"), items.map { it.resourceId })
    }

    @Test
    fun resolveKeepsDocsWhenTablesFailed() {
        val docs = decodeDocs(listOf("d-1"))
        val items = SharedResourcesAggregator.resolve(docs = docs, tables = null)
        assertEquals(listOf("d-1"), items.map { it.resourceId })
    }

    @Test
    fun resolveMergesBothSourcesAndAllowsEmptyResult() {
        val items = SharedResourcesAggregator.resolve(
            docs = decodeDocs(listOf("d-1")),
            tables = decodeTables(listOf("t-1")),
        )
        assertEquals(setOf("d-1", "t-1"), items.map { it.resourceId }.toSet())

        assertTrue(
            SharedResourcesAggregator.resolve(
                docs = decodeDocs(emptyList()),
                tables = SharedTablesResponse(tables = null),
            ).isEmpty(),
        )
    }

    private fun decodeDocs(ids: List<String>): SharedDocsResponse {
        val rows = ids.joinToString(",") {
            """{ "document_id": "$it", "title": "$it", "organization_id": "org-1", "permission": "viewer" }"""
        }
        return json.decodeFromString("""{ "documents": [$rows] }""")
    }

    private fun decodeTables(ids: List<String>): SharedTablesResponse {
        val rows = ids.joinToString(",") {
            """{ "table_id": "$it", "title": "$it", "organization_id": "org-1", "permission": "viewer" }"""
        }
        return json.decodeFromString("""{ "tables": [$rows] }""")
    }
}
