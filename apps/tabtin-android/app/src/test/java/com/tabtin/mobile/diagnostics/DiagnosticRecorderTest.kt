package com.tabtin.mobile.diagnostics

import java.nio.file.Files
import kotlin.io.path.readText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class DiagnosticRecorderTest {
    @Test
    public fun `target strips query and templates identifiers`() {
        val target = DiagnosticTarget.from(
            "https://api.example.com/api/docs/550e8400-e29b-41d4-a716-446655440000?token=secret&prompt=hello",
        )

        assertEquals("tabtin-api", target.hostClass)
        assertEquals("/api/docs/:id", target.pathTemplate)
        assertFalse(target.pathTemplate.contains("secret"))
        assertFalse(target.pathTemplate.contains("prompt"))

        val objectStorage = DiagnosticTarget.from(
            "https://bucket.oss-cn-shanghai.aliyuncs.com/private/customer-contract.pdf?signature=secret",
        )
        assertEquals("object-storage", objectStorage.hostClass)
        assertEquals("/:object", objectStorage.pathTemplate)
    }

    @Test
    public fun `store rotates bounded jsonl files`() {
        val directory = Files.createTempDirectory("diagnostic-store-test").toFile()
        try {
            val store = DiagnosticFileStore(directory, maxFileBytes = 24, retainedGenerations = 2)
            repeat(8) { index -> store.append(Stream.HTTP, "{\"i\":$index}") }

            val files = store.snapshotFiles().filter { it.name.startsWith("http-events") }
            assertTrue(files.size in 2..3)
            assertTrue(files.all { it.length() <= 24 })
            assertTrue(files.any { it.name == "http-events.1.jsonl" })
            assertTrue(files.joinToString("\n") { it.toPath().readText() }.contains("\"i\":"))
        } finally {
            directory.deleteRecursively()
        }
    }
}
