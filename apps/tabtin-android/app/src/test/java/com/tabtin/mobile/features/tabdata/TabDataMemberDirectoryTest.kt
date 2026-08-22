package com.tabtin.mobile.features.tabdata

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TabDataMemberDirectoryTest {
    private val directory = TabDataMemberDirectory(
        members = listOf(
            TabDataDirectoryMember(
                userId = "member-1",
                displayName = "林小满",
                avatarUrl = "https://oss.example.com/a.png",
            ),
        ),
        identitySnapshots = listOf(
            TabDataIdentitySnapshot(userId = "departed-1", displayName = "周叙"),
        ),
    )

    @Test
    fun `multi select keeps original order and resolves independently`() {
        val value = JsonArray(
            listOf(
                JsonPrimitive("member-1"),
                JsonPrimitive("departed-1"),
                JsonObject(
                    mapOf(
                        "id" to JsonPrimitive("external-1"),
                        "name" to JsonPrimitive("外部-赵珂"),
                    ),
                ),
                JsonPrimitive("unknown-1"),
            ),
        )
        val resolved = directory.resolve(value)
        assertEquals(
            listOf(
                TabDataMemberKind.MEMBER,
                TabDataMemberKind.DEPARTED,
                TabDataMemberKind.EXTERNAL,
                TabDataMemberKind.UNKNOWN,
            ),
            resolved.map(TabDataMemberRef::kind),
        )
        assertEquals(
            listOf("林小满", "周叙（已离职）", "外部-赵珂", "未知"),
            resolved.map(TabDataMemberRef::displayName),
        )
    }

    @Test
    fun `empty values do not render unknown`() {
        assertTrue(directory.resolve(null).isEmpty())
        assertTrue(directory.resolve(JsonNull).isEmpty())
        assertTrue(directory.resolve(JsonPrimitive("")).isEmpty())
        assertTrue(directory.resolve(JsonArray(emptyList())).isEmpty())
        assertTrue(directory.resolve(JsonArray(listOf(JsonNull, JsonPrimitive("")))).isEmpty())
    }

    @Test
    fun `object with only id is not treated as external`() {
        val value = JsonObject(mapOf("id" to JsonPrimitive("unknown-only-id")))
        val resolved = directory.resolve(value)
        assertEquals(1, resolved.size)
        assertEquals(TabDataMemberKind.UNKNOWN, resolved.single().kind)
        assertEquals("未知", resolved.single().displayName)
    }

    @Test
    fun `directory current name wins over stale embedded name`() {
        val value = JsonObject(
            mapOf(
                "id" to JsonPrimitive("member-1"),
                "name" to JsonPrimitive("林小满-导入时旧名"),
            ),
        )
        val resolved = directory.resolve(value).single()
        assertEquals(TabDataMemberKind.MEMBER, resolved.kind)
        assertEquals("林小满", resolved.displayName)
        assertEquals("https://oss.example.com/a.png", resolved.avatarUrl)
    }

    @Test
    fun `identity snapshot wins over stale embedded name`() {
        val value = JsonObject(
            mapOf(
                "id" to JsonPrimitive("departed-1"),
                "name" to JsonPrimitive("周叙-导入时旧名"),
            ),
        )
        val resolved = directory.resolve(value).single()
        assertEquals(TabDataMemberKind.DEPARTED, resolved.kind)
        assertEquals("周叙（已离职）", resolved.displayName)
        assertEquals(null, resolved.avatarUrl)
    }

    @Test
    fun `chunkUserIds deduplicates and splits at two hundred`() {
        val ids = buildList {
            repeat(201) { index -> add("user-$index") }
            add("user-0")
            add("  ")
            add("user-3")
        }
        val chunks = TabDataMemberDirectory.chunkUserIds(ids)
        assertEquals(2, chunks.size)
        assertEquals(200, chunks[0].size)
        assertEquals(1, chunks[1].size)
        assertEquals(201, chunks.sumOf { it.size })
        assertEquals(ids.filter { it.trim().isNotEmpty() }.map { it.trim() }.distinct(), chunks.flatten())
    }

    @Test
    fun `chunkUserIds returns empty for blank input`() {
        assertTrue(TabDataMemberDirectory.chunkUserIds(emptyList()).isEmpty())
        assertTrue(TabDataMemberDirectory.chunkUserIds(listOf("", "  ")).isEmpty())
    }
}
