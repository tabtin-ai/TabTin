/**
 * Kotlin round-trip 测试（W0-L1 / L2 / L3 / L5 / L6 实测）。
 *
 * 验证点：
 *   1. 所有 generated kt 文件能 compile（kotlinx-serialization sealed class）
 *   2. 22 case ContentBlock parse + re-encode → re-parse → 数据一致
 *   3. **W0-L6 type-safe 关键证据**：when (block) is sealed class 时
 *      Kotlin 编译器在 exhaustive when 模式下要求穷尽 22 case
 *   4. 6 envelope round-trip
 *   5. **W0-L3**：_seq 是 Long 类型，kotlinx-serialization 直接接受 JSON number
 *      （不像 Klaxon 默认把 number 都当 Double 需要 normalize wrapper）
 *   6. 未知 type 字面量被 sealed class JsonClassDiscriminator 拒绝
 */
package com.tabtin.wire.test

import com.tabtin.mobile.data.wire.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.SerializationException
import java.io.File

private val json = Json {
    ignoreUnknownKeys = true   // forward-compat（vs zod strict 模式 strip）
    encodeDefaults = false     // null 字段不输出（跟 Pydantic exclude_none / Swift JSONEncoder 对齐）
    explicitNulls = false      // null 当 absent
    classDiscriminator = "type" // 默认值是 "type"，显式标注用作文档
}

private val failures = mutableListOf<String>()
private fun fail(msg: String) {
    failures.add(msg)
    println("  ✘ $msg")
}
private fun pass(msg: String) {
    println("  ✔ $msg")
}

/**
 * 取 sealed class subclass 对应的 SerialName 字符串（即 type discriminator）。
 * 不依赖 sealed class 本身暴露 `val type: String`——那会跟 JsonClassDiscriminator 冲突。
 *
 * 用 KClass 反射去取 subclass 上的 @SerialName。
 */
private fun blockTag(block: ContentBlock): String {
    val cls = block::class.java
    return cls.getAnnotation(kotlinx.serialization.SerialName::class.java)?.value
        ?: cls.simpleName
}

fun main(args: Array<String>) {
    if (args.isEmpty()) {
        System.err.println("Usage: RoundTrip <fixture-samples-dir>")
        kotlin.system.exitProcess(2)
    }
    val fixtures = File(args[0])

    // ──────────────────────────────────────────────────────────────────
    // Suite 1: 22 case ContentBlock parse + byte-level
    // ──────────────────────────────────────────────────────────────────
    println("\n[Suite 1] 22 case ContentBlock parse + byte-level round-trip + 原始 fixture 字段保真")
    val rawText = File(fixtures, "content_block_22cases.json").readText(Charsets.UTF_8)
    // **W1-Review P0-2 修复**：先把原始 JSON 解析为 List<JsonObject>，留作真值对照
    val rawArr = json.parseToJsonElement(rawText) as kotlinx.serialization.json.JsonArray
    val cases = json.decodeFromString<List<ContentBlock>>(rawText)
    if (cases.size != 22) fail("expected 22 cases, got ${cases.size}")
    if (rawArr.size != cases.size) fail("raw count(${rawArr.size}) ≠ decoded count(${cases.size})")
    val recordKeys = listOf("input", "payload", "params", "field_values", "block_id_overrides")
    cases.forEachIndexed { idx, block ->
        val tag = blockTag(block)
        val s1 = json.encodeToString(block)
        val block2 = json.decodeFromString<ContentBlock>(s1)
        val s2 = json.encodeToString(block2)
        if (s1 != s2) {
            fail("#${idx + 1} $tag: re-encode 字节不等\n     s1=${s1.take(200)}\n     s2=${s2.take(200)}")
            return@forEachIndexed
        }
        // **关键闸**：record 字段必须保留所有 key
        val rawObj = rawArr[idx] as kotlinx.serialization.json.JsonObject
        val s1Obj = json.parseToJsonElement(s1) as kotlinx.serialization.json.JsonObject
        var fieldDropDetected = false
        for (key in recordKeys) {
            val rawVal = rawObj[key]
            if (rawVal is kotlinx.serialization.json.JsonObject) {
                val s1Val = (s1Obj[key] as? kotlinx.serialization.json.JsonObject) ?: kotlinx.serialization.json.buildJsonObject {}
                if (rawVal.keys != s1Val.keys) {
                    fail("#${idx + 1} $tag.$key: 字段丢失（raw=${rawVal.keys.sorted()}, got=${s1Val.keys.sorted()}）")
                    fieldDropDetected = true
                }
            }
        }
        if (!fieldDropDetected) pass("#${idx + 1} $tag")
    }

    // ──────────────────────────────────────────────────────────────────
    // Suite 2: W0-L6 sealed class exhaustive when
    // ──────────────────────────────────────────────────────────────────
    println("\n[Suite 2] W0-L6 编译期 type-safe 穷尽（when block 上漏 case 编译期失败）")
    val typeCounts = mutableMapOf<String, Int>()
    for (block in cases) {
        // ⚠️ 关键证据：Kotlin 编译器对 sealed class 的 when 强制穷尽
        // 如果未来加 ContentBlock subclass 漏更新此处 → 编译失败 → CI 拦截
        val tag: String = when (block) {
            is ContentBlockText -> "text"
            is ContentBlockToolUse -> "tool_use"
            is ContentBlockToolResult -> "tool_result"
            is ContentBlockThinking -> "thinking"
            is ContentBlockRedactedThinking -> "redacted_thinking"
            is ContentBlockImage -> "image"
            is ContentBlockDocument -> "document"
            is ContentBlockServerToolUse -> "server_tool_use"
            is ContentBlockWebSearchToolResult -> "web_search_tool_result"
            is ContentBlockCodeExecutionToolResult -> "code_execution_tool_result"
            is ContentBlockBashCodeExecutionToolResult -> "bash_code_execution_tool_result"
            is ContentBlockTextEditorCodeExecutionToolResult -> "text_editor_code_execution_tool_result"
            is ContentBlockMcpToolUse -> "mcp_tool_use"
            is ContentBlockMcpToolResult -> "mcp_tool_result"
            is ContentBlockContainerUpload -> "container_upload"
            is ContentBlockSearchResult -> "search_result"
            is ContentBlockTabtinRichContent -> "tabtin_rich_content"
            is ContentBlockTabtinComposerPreset -> "tabtin_composer_preset"
            is ContentBlockTabtinAskUserFields -> "tabtin_ask_user_fields"
            is ContentBlockTabtinSkillInvocation -> "tabtin_skill_invocation"
            is ContentBlockTabtinSourceRef -> "tabtin_source_ref"
            is ContentBlockTabtinApprovalRequest -> "tabtin_approval_request"
        }
        typeCounts[tag] = (typeCounts[tag] ?: 0) + 1
    }
    if (typeCounts.size == 22) pass("22 case 全部命中") else fail("expected 22 distinct types, got ${typeCounts.size}: ${typeCounts.keys.sorted()}")

    // ──────────────────────────────────────────────────────────────────
    // Suite 3: 边界 case
    // ──────────────────────────────────────────────────────────────────
    println("\n[Suite 3] 6 边界 case (W0-L2 严格 byte-level)")
    val edges = json.decodeFromString<List<ContentBlock>>(
        File(fixtures, "content_block_edge_cases.json").readText(Charsets.UTF_8)
    )
    edges.forEachIndexed { idx, block ->
        val s1 = json.encodeToString(block)
        val block2 = json.decodeFromString<ContentBlock>(s1)
        val s2 = json.encodeToString(block2)
        if (s1 != s2) fail("edge #${idx + 1}: re-encode 不等\n     s1=${s1.take(200)}") else pass("edge #${idx + 1} ${blockTag(block)}")
    }

    // 浮点 bbox 不丢精度（doc snapshot）
    val docFix = edges.firstOrNull { it is ContentBlockTabtinSourceRef && (it.snapshot is ContentBlockTabtinSourceRefSnapshotDoc) }
    if (docFix != null) {
        val sr = docFix as ContentBlockTabtinSourceRef
        val docSnap = sr.snapshot as? ContentBlockTabtinSourceRefSnapshotDoc
        if (docSnap != null) {
            val bbox = docSnap.bbox
            if (bbox != listOf(0.123, 0.4567, 0.89012, 0.999)) {
                fail("浮点 bbox 失真: $bbox")
            } else {
                pass("浮点 bbox 不丢精度: $bbox")
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Suite 4: forward-compat (kotlinx-serialization ignoreUnknownKeys)
    // ──────────────────────────────────────────────────────────────────
    println("\n[Suite 4] forward-compat (ignoreUnknownKeys)")
    val fwd = File(fixtures, "content_block_forward_compat.json").readText(Charsets.UTF_8)
    try {
        val items = json.decodeFromString<List<ContentBlock>>(fwd)
        items.forEachIndexed { idx, b ->
            pass("forward-compat #${idx + 1} ${blockTag(b)} parse OK (未知字段被 ignore)")
        }
    } catch (e: Exception) {
        fail("forward-compat: ${e.message}")
    }

    // ──────────────────────────────────────────────────────────────────
    // Suite 5: 未知 type 必须被拒绝
    // ──────────────────────────────────────────────────────────────────
    println("\n[Suite 5] 未知 type 字面量必须 fail-fast")
    try {
        json.decodeFromString<ContentBlock>("""{"type":"fictional_v3_block"}""")
        fail("未知 type 应被拒绝但 decode 成功了")
    } catch (e: SerializationException) {
        pass("未知 type 被 sealed class JsonClassDiscriminator 拒绝（expected）")
    } catch (e: Exception) {
        pass("未知 type 被拒（${e.javaClass.simpleName}）")
    }

    // ──────────────────────────────────────────────────────────────────
    // Suite 6: 6 envelope round-trip + W0-L3 _seq Long 实测
    // ──────────────────────────────────────────────────────────────────
    println("\n[Suite 6] 6 envelope round-trip (含 W0-L3 _seq Long 实测)")

    fun <T : Any> rtOne(name: String, fixture: String, decode: (String) -> T, encode: (T) -> String) {
        try {
            val text = File(fixtures, fixture).readText(Charsets.UTF_8)
            val item = decode(text)
            val s1 = encode(item)
            val item2 = decode(s1)
            val s2 = encode(item2)
            if (s1 != s2) fail("$name: re-encode 不等") else pass("$name")
        } catch (e: Exception) {
            fail("$name: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    rtOne("MessageStart", "envelope_message_start.json",
        { json.decodeFromString<MessageStart>(it) },
        { json.encodeToString(it) })
    rtOne("MessageDelta", "envelope_message_delta.json",
        { json.decodeFromString<MessageDelta>(it) },
        { json.encodeToString(it) })
    rtOne("MessageStop", "envelope_message_stop.json",
        { json.decodeFromString<MessageStop>(it) },
        { json.encodeToString(it) })

    // W4c-L5 · W4.5 第二波 B1：error_info.partial_reason 三档 round-trip
    try {
        val text = File(fixtures, "envelope_message_stop_partial_reasons.json").readText(Charsets.UTF_8)
        val stops = json.decodeFromString<List<MessageStop>>(text)
        if (stops.size != 3) fail("partial_reason fixture 期望 3 条，实际 ${stops.size}")
        stops.forEachIndexed { i, s ->
            val s1 = json.encodeToString(s)
            val s2 = json.encodeToString(json.decodeFromString<MessageStop>(s1))
            if (s1 != s2) fail("MessageStop[partial_reason $i]: re-encode 不等")
        }
        val got = stops.mapNotNull { it.error_info?.partial_reason }.toSet()
        val want = setOf("aborted", "stream_interrupted", "message_stop_fallback")
        if (got == want) {
            pass("MessageStop partial_reason × 3 三档 round-trip 一致：${got.sorted()}")
        } else {
            fail("partial_reason 三档不符：want=${want.sorted()}, got=${got.sorted()}")
        }
    } catch (e: Exception) {
        fail("MessageStop partial_reason: ${e.javaClass.simpleName}: ${e.message}")
    }

    rtOne("ContentBlockStart", "envelope_content_block_start.json",
        { json.decodeFromString<ContentBlockStart>(it) },
        { json.encodeToString(it) })

    // ContentBlockDelta 是 list of 6 deltas
    try {
        val text = File(fixtures, "envelope_content_block_delta_6types.json").readText(Charsets.UTF_8)
        val items = json.decodeFromString<List<ContentBlockDelta>>(text)
        items.forEachIndexed { i, d ->
            val s1 = json.encodeToString(d)
            val d2 = json.decodeFromString<ContentBlockDelta>(s1)
            val s2 = json.encodeToString(d2)
            if (s1 != s2) fail("ContentBlockDelta[$i]: re-encode 不等")
        }
        pass("ContentBlockDelta (${items.size} 个 fixture, 6 种 delta type)")
    } catch (e: Exception) {
        fail("ContentBlockDelta: ${e.message}")
    }

    rtOne("ContentBlockStop", "envelope_content_block_stop.json",
        { json.decodeFromString<ContentBlockStop>(it) },
        { json.encodeToString(it) })

    // W0-L3: _seq Long 直接 encode 不需要 normalize wrapper
    try {
        val msgStart = json.decodeFromString<MessageStart>(
            File(fixtures, "envelope_message_start.json").readText(Charsets.UTF_8)
        )
        // _seq 是 Long，应该可以直接当 Long 用
        val seq: Long = msgStart._seq
        if (seq == 1L) {
            pass("W0-L3 实证：_seq 是 Long ($seq)，kotlinx-serialization 不需要 normalize wrapper")
        } else {
            fail("_seq 期望 1L，实际 $seq")
        }
    } catch (e: Exception) {
        fail("W0-L3 _seq Long 检查失败: ${e.message}")
    }

    // ──────────────────────────────────────────────────────────────────
    // Suite 7: AnyContentBlockStreamEvent 顶层 union 6 case 编译期穷尽
    // ──────────────────────────────────────────────────────────────────
    println("\n[Suite 7] AnyContentBlockStreamEvent 6 case 编译期穷尽")
    try {
        val stream = json.decodeFromString<List<AnyContentBlockStreamEvent>>(
            File(fixtures, "envelope_any_event_stream.json").readText(Charsets.UTF_8)
        )
        val counts = mutableMapOf<String, Int>()
        for (ev in stream) {
            // ⚠️ Kotlin 编译期穷尽 6 case
            val tag: String = when (ev) {
                is AnyContentBlockStreamEventAgentStreamMessageStart -> "message_start"
                is AnyContentBlockStreamEventAgentStreamMessageDelta -> "message_delta"
                is AnyContentBlockStreamEventAgentStreamMessageStop -> "message_stop"
                is AnyContentBlockStreamEventAgentStreamContentBlockStart -> "content_block_start"
                is AnyContentBlockStreamEventAgentStreamContentBlockDelta -> "content_block_delta"
                is AnyContentBlockStreamEventAgentStreamContentBlockStop -> "content_block_stop"
            }
            counts[tag] = (counts[tag] ?: 0) + 1
        }
        if (counts.size == 6) pass("6 envelope case 全部命中") else fail("expected 6, got ${counts.size}")
    } catch (e: Exception) {
        fail("Suite 7: ${e.javaClass.simpleName}: ${e.message}")
    }

    // ──────────────────────────────────────────────────────────────────
    // Suite 8: W4.5 B3 · StreamEventIdValidator 跨语言契约 fixture replay
    // ──────────────────────────────────────────────────────────────────
    // 与 TS / Python / Swift 端跑同一份 fixture（cp 自
    // packages/agent-wire/src/cross-lang-fixtures/wave45-isStreamEventId.json）。
    // 4 端必须 byte-by-byte 一致。
    println("\n[Suite 8] W4.5 B3 · StreamEventIdValidator 跨语言契约 replay (case 数随 fixture)")
    try {
        val text = File(fixtures, "wave45-isStreamEventId.json").readText(Charsets.UTF_8)
        val obj = json.parseToJsonElement(text) as kotlinx.serialization.json.JsonObject
        val specVersion = obj["spec_version"]?.toString()?.trim('"')
        if (specVersion != "v1") {
            fail("Suite 8: spec_version 期望 v1，实际 $specVersion")
        }
        val casesArr = obj["cases"] as kotlinx.serialization.json.JsonArray
        var pass = 0
        var failCount = 0
        for (caseEl in casesArr) {
            val caseObj = caseEl as kotlinx.serialization.json.JsonObject
            val name = (caseObj["name"] as kotlinx.serialization.json.JsonPrimitive).content
            val input = (caseObj["input"] as kotlinx.serialization.json.JsonPrimitive).content
            val expected = (caseObj["expected"] as kotlinx.serialization.json.JsonPrimitive).content.toBoolean()
            val actual = com.tabtin.mobile.data.wire.StreamEventIdValidator.isStreamEventId(input)
            if (actual == expected) {
                pass++
            } else {
                failCount++
                fail("Suite 8 case '$name': input='$input' expected=$expected actual=$actual")
            }
        }
        if (failCount == 0) {
            pass("$pass/${casesArr.size} case 全 PASS（4 端契约 Kotlin 落地）")
        }
    } catch (e: Exception) {
        fail("Suite 8: ${e.javaClass.simpleName}: ${e.message}")
    }

    // ──────────────────────────────────────────────────────────────────
    // 总结
    // ──────────────────────────────────────────────────────────────────
    println()
    println("═══════════════════════════════════════════════════════════════")
    if (failures.isEmpty()) {
        println("  ✔ Kotlin round-trip 全部通过")
        println("═══════════════════════════════════════════════════════════════")
        kotlin.system.exitProcess(0)
    } else {
        println("  ✘ ${failures.size} 个失败：")
        failures.forEach { println("     - $it") }
        println("═══════════════════════════════════════════════════════════════")
        kotlin.system.exitProcess(1)
    }
}
