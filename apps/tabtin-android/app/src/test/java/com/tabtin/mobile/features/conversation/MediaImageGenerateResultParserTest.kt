package com.tabtin.mobile.features.conversation

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MediaImageGenerateResultParserTest {
    private val url = "https://example.com/apple.png"

    @Test
    fun `extracts result_urls from task payload`() {
        assertEquals(
            url,
            MediaImageGenerateResultParser.parse(
                """{"success":true,"status":"succeeded","result_urls":["$url"]}"""
            ),
        )
    }

    @Test
    fun `prefers stored_urls`() {
        assertEquals(
            "https://cdn.example.com/stored.png",
            MediaImageGenerateResultParser.parse(
                """{"stored_urls":["https://cdn.example.com/stored.png"],"result_urls":["$url"]}"""
            ),
        )
    }

    @Test
    fun `unwraps shell stdout + cli ok data`() {
        val inner = """{"ok":true,"data":{"success":true,"status":"succeeded","result_urls":["$url"]}}"""
        // JVM 单测不能用 org.json.JSONObject.quote（Android stub）；用 kotlinx 编码 stdout 字符串。
        val quotedInner = Json.encodeToString(inner)
        val envelope = """{"stdout":$quotedInner,"exit_code":0}"""
        assertEquals(url, MediaImageGenerateResultParser.parse(envelope))
    }

    @Test
    fun `returns null when no url`() {
        assertNull(MediaImageGenerateResultParser.parse("""{"stdout":"ok","exit_code":0}"""))
        assertNull(MediaImageGenerateResultParser.parse(null))
    }

    @Test
    fun `normalizes unicode ampersand in truncated stdout`() {
        // 原始 triple-quote 里 `\u0026` 是字面反斜杠+u0026（对齐 Electron 截断 stdout）。
        // 若写成 `\\u0026` 会变成双反斜杠，normalize 后残留 `\&`。
        val truncated =
            """"result_urls": [ "https://ark.example.com/a.png?X-Tos-Algorithm=TOS4-HMAC-SHA256\u0026X-Tos-Signature=abc" ]"""
        val parsed = MediaImageGenerateResultParser.parse(truncated)
        assertEquals(
            "https://ark.example.com/a.png?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Signature=abc",
            parsed,
        )
    }
}
