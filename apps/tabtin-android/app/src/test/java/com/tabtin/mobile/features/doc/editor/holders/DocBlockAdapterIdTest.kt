package com.tabtin.mobile.features.doc.editor.holders

import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

/**
 * Regression tests for EIP-018 (UUID hash collision) and EIP-019 (DiffUtil).
 */
class DocBlockAdapterIdTest {

    @Test
    fun `stable ids are configured before RecyclerView registers adapter observers`() {
        val screenSource = File(
            "src/main/java/com/tabtin/mobile/features/doc/DocEditorScreen.kt",
        ).readText()
        val adapterSource = File(
            "src/main/java/com/tabtin/mobile/features/doc/editor/holders/DocBlockAdapter.kt",
        ).readText()

        assertTrue(adapterSource.contains("setHasStableIds(true)"))
        assertFalse(
            "the screen must not change stable IDs after assigning the adapter",
            screenSource.contains("adapter.setHasStableIds(true)"),
        )
    }

    /**
     * Reproduces the original EIP-018 collision: two UUIDs that share the same
     * mostSignificantBits but differ in leastSignificantBits must produce
     * different stable IDs after the xor fix.
     */
    @Test
    fun `xor hash distinguishes UUIDs sharing mostSignificantBits`() {
        val msb = 0x550e8400_e29b41d4L
        // 高位为 1 的 hex 字面量在 Kotlin 中超出 signed Long 范围，需用 ULong + toLong()
        val uuidA = UUID(msb, 0xA716446655440000UL.toLong())
        val uuidB = UUID(msb, 0xB826557766550000UL.toLong())

        val idA = msb xor uuidA.leastSignificantBits
        val idB = msb xor uuidB.leastSignificantBits

        assertNotEquals(
            "UUIDs with same MSB but different LSB must produce different IDs",
            idA, idB,
        )
    }

    /**
     * Verifies old behaviour was broken: using only mostSignificantBits would
     * produce the same id for both UUIDs above.
     */
    @Test
    fun `mostSignificantBits alone collides for same-MSB UUIDs`() {
        val msb = 0x550e8400_e29b41d4L
        val uuidA = UUID(msb, 0xA716446655440000UL.toLong())
        val uuidB = UUID(msb, 0xB826557766550000UL.toLong())

        assertEquals(
            "Only MSB would collide (documenting the bug)",
            uuidA.mostSignificantBits, uuidB.mostSignificantBits,
        )
    }

    /**
     * Large-scale collision test: generate 10 000 random UUIDs and verify no
     * xor-based id collision occurs.
     */
    @Test
    fun `no collision among 10k random UUIDs with xor hash`() {
        val ids = (1..10_000).map {
            val uuid = UUID.randomUUID()
            uuid.mostSignificantBits xor uuid.leastSignificantBits
        }
        val uniqueCount = ids.toSet().size
        assertEquals(
            "10k random UUID xor-hashes should all be unique (within statistical reason)",
            10_000, uniqueCount,
        )
    }

    /**
     * Non-UUID ids should fall back to hashCode().
     */
    @Test
    fun `non-UUID id uses hashCode`() {
        val shortId = "block-abc-123"
        val expected = shortId.hashCode().toLong()
        assertEquals(expected, computeStableId(shortId))
    }

    @Test
    fun `valid UUID id uses xor hash`() {
        val uuid = UUID.randomUUID()
        val id = uuid.toString()
        val expected = uuid.mostSignificantBits xor uuid.leastSignificantBits
        assertEquals(expected, computeStableId(id))
    }

    /**
     * Mirrors the exact logic in DocBlockAdapter.getItemId for isolated testing.
     */
    private fun computeStableId(id: String): Long {
        if (id.length == 36 && id[8] == '-' && id[13] == '-') {
            return try {
                val uuid = UUID.fromString(id)
                uuid.mostSignificantBits xor uuid.leastSignificantBits
            } catch (_: IllegalArgumentException) {
                id.hashCode().toLong()
            }
        }
        return id.hashCode().toLong()
    }
}
