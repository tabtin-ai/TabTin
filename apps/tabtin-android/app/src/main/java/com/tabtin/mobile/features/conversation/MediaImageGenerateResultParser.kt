package com.tabtin.mobile.features.conversation

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 从 `tabtin media image generate` 的 tool_result / stdout 信封中抽取成品图 URL。
 *
 * 行为对齐 Electron `parseMediaImageGenerateResult.ts`：
 * - 剥 `<approval_note>...</approval_note>` 前缀
 * - 递归 unwrap stdout / content / data（深度 ≤ 6）
 * - URL 优先级：stored_urls → result_urls → result_url → imageUrls/image_urls → url
 * - 截断文本正则兜底，并把 `\u0026` 解成 `&`
 *
 * 刻意不用 org.json：它在 Android 的 JVM 单测里只是 stub（调用即抛
 * "not mocked" RuntimeException），会让本口径无法被单测覆盖。
 */
public object MediaImageGenerateResultParser {

    private val UNICODE_ESCAPE = Regex("""\\u([0-9a-fA-F]{4})""")
    private val APPROVAL_NOTE_CLOSED = Regex("""(?is)</approval_note>\s*([\s\S]*)$""")
    private val RESULT_URLS_BLOCK = Regex(
        """(?i)"result_urls"\s*:\s*\[\s*"((?:\\.|[^"\\])*)""""
    )
    private val RESULT_URL_SINGLE = Regex(
        """(?i)"result_url"\s*:\s*"((?:\\.|[^"\\])*)""""
    )
    private val LOOSE_HTTPS = Regex(
        """(?i)https://[^\s"'\\]+(?:\\u0026[^\s"'\\]*)*"""
    )

    private val parser = Json { ignoreUnknownKeys = true; isLenient = true }

    public fun parse(raw: String?): String? {
        if (raw == null) return null
        return parseUnknown(raw)
    }

    private fun parseUnknown(output: Any?): String? {
        val layers = unwrapLayers(output)
        for (layer in layers) {
            val rec = asRecord(layer) ?: continue
            pickUrlFromTaskPayload(rec)?.let { return it }
        }
        for (layer in layers) {
            when (layer) {
                is String -> extractUrlFromTruncatedMediaStdout(layer)?.let { return it }
                is JsonObject -> {
                    val stdout = layer.stringField("stdout")
                    if (stdout != null) {
                        extractUrlFromTruncatedMediaStdout(stdout)?.let { return it }
                    }
                }
            }
        }
        return null
    }

    internal fun normalizeMediaImageUrl(raw: String?): String? {
        if (raw == null) return null
        var url = raw.trim()
        if (url.isEmpty()) return null
        url = UNICODE_ESCAPE.replace(url) { match ->
            val hex = match.groupValues[1]
            Char(hex.toInt(16)).toString()
        }
        if (!(url.startsWith("https://") || url.startsWith("http://"))) return null
        return url
    }

    internal fun extractUrlFromTruncatedMediaStdout(text: String): String? {
        if (text.isEmpty()) return null

        RESULT_URLS_BLOCK.find(text)?.groupValues?.getOrNull(1)?.let { captured ->
            normalizeMediaImageUrl(captured)?.let { return it }
        }
        RESULT_URL_SINGLE.find(text)?.groupValues?.getOrNull(1)?.let { captured ->
            normalizeMediaImageUrl(captured)?.let { return it }
        }
        LOOSE_HTTPS.find(text)?.value?.let { captured ->
            return normalizeMediaImageUrl(captured)
        }
        return null
    }

    private fun stripApprovalNote(text: String): String {
        val match = APPROVAL_NOTE_CLOSED.find(text)
        val after = match?.groupValues?.getOrNull(1)
        if (!after.isNullOrBlank()) return after.trim()
        return text.trim()
    }

    private fun tryParseJson(text: String): JsonElement? {
        val trimmed = text.trim()
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null
        return runCatching { parser.parseToJsonElement(trimmed) }.getOrNull()
    }

    /** 从混合文本里抽出第一段顶层 `{...}`（括号平衡）。 */
    private fun extractBalancedJsonObject(text: String): String? {
        val start = text.indexOf('{')
        if (start < 0) return null
        var depth = 0
        var inString = false
        var escape = false
        for (i in start until text.length) {
            val ch = text[i]
            if (inString) {
                if (escape) {
                    escape = false
                    continue
                }
                when (ch) {
                    '\\' -> escape = true
                    '"' -> inString = false
                }
                continue
            }
            when (ch) {
                '"' -> inString = true
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) return text.substring(start, i + 1)
                }
            }
        }
        return null
    }

    private fun asRecord(value: Any?): JsonObject? = when (value) {
        is JsonObject -> value
        is JsonElement -> value as? JsonObject
        else -> null
    }

    private fun urlFromUnknownCandidate(candidate: JsonElement?): String? {
        if (candidate == null) return null
        when (candidate) {
            is JsonPrimitive -> {
                if (candidate.isString) {
                    return normalizeMediaImageUrl(candidate.content)
                }
            }
            is JsonArray -> {
                for (item in candidate) {
                    val primitive = item as? JsonPrimitive ?: continue
                    if (!primitive.isString) continue
                    normalizeMediaImageUrl(primitive.content)?.let { return it }
                }
            }
            else -> Unit
        }
        return null
    }

    private fun firstHttpsUrl(vararg candidates: JsonElement?): String? {
        for (candidate in candidates) {
            urlFromUnknownCandidate(candidate)?.let { return it }
        }
        return null
    }

    private fun pickUrlFromTaskPayload(payload: JsonObject): String? {
        return firstHttpsUrl(
            payload["stored_urls"],
            payload["result_urls"],
            payload["result_url"],
            payload["imageUrls"],
            payload["image_urls"],
            payload["url"],
        )
    }

    private fun JsonObject.stringField(key: String): String? {
        val primitive = this[key] as? JsonPrimitive ?: return null
        if (!primitive.isString) return null
        return primitive.content.trim().takeIf { it.isNotEmpty() }
    }

    private fun unwrapLayers(raw: Any?, depth: Int = 0): List<Any?> {
        if (depth > 6) return emptyList()
        val out = mutableListOf<Any?>(raw)
        when (raw) {
            is String -> {
                val stripped = stripApprovalNote(raw)
                if (stripped != raw) out.add(stripped)
                val balanced = extractBalancedJsonObject(stripped)
                if (balanced != null) {
                    val parsed = tryParseJson(balanced)
                    if (parsed != null) out.addAll(unwrapLayers(parsed, depth + 1))
                } else {
                    val parsed = tryParseJson(stripped)
                    if (parsed != null) out.addAll(unwrapLayers(parsed, depth + 1))
                }
            }
            is JsonObject -> {
                raw.stringField("stdout")?.let { out.addAll(unwrapLayers(it, depth + 1)) }
                raw.stringField("content")?.let { out.addAll(unwrapLayers(it, depth + 1)) }
                raw["data"]?.let { data ->
                    out.addAll(unwrapLayers(data, depth + 1))
                    (data as? JsonObject)?.get("data")?.let { nested ->
                        out.addAll(unwrapLayers(nested, depth + 1))
                    }
                }
            }
        }
        return out
    }
}
