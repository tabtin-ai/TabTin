package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.BlockItem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Wave 0 收尾修补 — Android `BlockItem` schema + RichTablePreview 渲染层回归。
 *
 * 服务端 `present_to_user.py` 真实推送的 schema 是：
 *   columns: [{key, label}]，rows: [{col_key: value}]
 *
 * Wave 0 子 Agent 之前漏掉这点：BlockItem 把 columns 写成 List<String>?，rows 写成
 * List<List<String>>?，导致 kotlinx.serialization 反序列化时抛 MissingFieldException，
 * 整条 BlockItem 被 catch 后丢弃 → Android 端 100% silent fail。
 *
 * 本测试守住三件事：
 *   1) 真实 schema（[{key, label}] + [{col_key: value}]）能反序列化，不抛异常
 *   2) 老式 schema（[String] + [[String]]）也能解析（向后兼容 iOS 旧测试 / 桌面旧 client）
 *   3) 桥接函数 columnLabel / columnKey / rowCellAt 在两种 schema 下都返回人类可读文本
 */
class RichTablePreviewSchemaTest {

    private val json = Json { ignoreUnknownKeys = true }

    // -------- BlockItem 反序列化：服务端真实 schema --------

    @Test
    fun `decodes real server schema with object columns and dict rows`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "table_preview",
              "summary": "Q3 销售数据",
              "columns": [
                {"key": "region", "label": "地区"},
                {"key": "sales", "label": "销量"}
              ],
              "rows": [
                {"region": "华东", "sales": "1234"},
                {"region": "华南", "sales": "987"}
              ]
            }
        """.trimIndent()

        val block = json.decodeFromString(BlockItem.serializer(), payload)
        assertEquals("rich_content", block.type)
        assertEquals("table_preview", block.kind)
        assertEquals(2, block.columns?.size)
        assertEquals(2, block.rows?.size)

        val firstCol = block.columns!![0]
        assertTrue("columns[0] should decode as JsonObject", firstCol is JsonObject)
        firstCol as JsonObject
        assertEquals("region", (firstCol["key"] as JsonPrimitive).content)
        assertEquals("地区", (firstCol["label"] as JsonPrimitive).content)

        val firstRow = block.rows!![0]
        assertTrue("rows[0] should decode as JsonObject", firstRow is JsonObject)
        firstRow as JsonObject
        assertEquals("华东", (firstRow["region"] as JsonPrimitive).content)
        assertEquals("1234", (firstRow["sales"] as JsonPrimitive).content)
    }

    // -------- BlockItem 反序列化：老式 schema 向后兼容 --------

    @Test
    fun `decodes legacy schema with string columns and array rows`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "table_preview",
              "summary": "legacy",
              "columns": ["地区", "销量"],
              "rows": [["华东", "1234"], ["华南", "987"]]
            }
        """.trimIndent()

        val block = json.decodeFromString(BlockItem.serializer(), payload)
        assertEquals(2, block.columns?.size)
        assertEquals(2, block.rows?.size)

        val firstCol = block.columns!![0] as JsonPrimitive
        assertEquals("地区", firstCol.content)

        val firstRow = block.rows!![0] as JsonArray
        assertEquals(2, firstRow.size)
        assertEquals("华东", (firstRow[0] as JsonPrimitive).content)
    }

    // -------- columnLabel：服务端真实 schema 表头取值 --------

    @Test
    fun `columnLabel reads label from JsonObject server schema`() {
        val col: JsonElement = buildJsonObject {
            put("key", "region")
            put("label", "地区")
        }
        assertEquals("地区", columnLabel(col))
    }

    @Test
    fun `columnLabel falls back to key when label missing`() {
        val col: JsonElement = buildJsonObject {
            put("key", "region")
        }
        assertEquals("region", columnLabel(col))
    }

    @Test
    fun `columnLabel reads primitive content for legacy schema`() {
        val col: JsonElement = JsonPrimitive("地区")
        assertEquals("地区", columnLabel(col))
    }

    // -------- columnKey --------

    @Test
    fun `columnKey reads key from JsonObject`() {
        val col: JsonElement = buildJsonObject {
            put("key", "region")
            put("label", "地区")
        }
        assertEquals("region", columnKey(col))
    }

    @Test
    fun `columnKey falls back to primitive content for legacy schema`() {
        val col: JsonElement = JsonPrimitive("地区")
        assertEquals("地区", columnKey(col))
    }

    @Test
    fun `columnKey returns null when JsonObject has no key field`() {
        val col: JsonElement = buildJsonObject {
            put("label", "无 key")
        }
        assertNull(columnKey(col))
    }

    // -------- rowCellAt：dict row 按 column key 取值 --------

    @Test
    fun `rowCellAt reads value from dict row by column key`() {
        val row: JsonElement = buildJsonObject {
            put("region", "华东")
            put("sales", "1234")
        }
        assertEquals("华东", rowCellAt(row, columnIndex = 0, columnKey = "region"))
        assertEquals("1234", rowCellAt(row, columnIndex = 1, columnKey = "sales"))
    }

    @Test
    fun `rowCellAt returns empty when key missing in dict row`() {
        val row: JsonElement = buildJsonObject {
            put("region", "华东")
        }
        assertEquals("", rowCellAt(row, columnIndex = 1, columnKey = "sales"))
    }

    @Test
    fun `rowCellAt reads value from array row by index for legacy schema`() {
        val row: JsonElement = buildJsonArray {
            add("华东")
            add("1234")
        }
        assertEquals("华东", rowCellAt(row, columnIndex = 0, columnKey = "region"))
        assertEquals("1234", rowCellAt(row, columnIndex = 1, columnKey = "sales"))
    }

    @Test
    fun `rowCellAt handles numeric primitives in dict row`() {
        // 服务端 rows 里 cell 完全可能是数字而不是字符串
        val row: JsonElement = buildJsonObject {
            put("sales", 1234)
        }
        assertEquals("1234", rowCellAt(row, columnIndex = 0, columnKey = "sales"))
    }

    // -------- markdownCellSafe：escape `|` 和换行避免破坏表格语法 --------

    @Test
    fun `markdownCellSafe escapes pipe to prevent table corruption`() {
        // 没 escape 的话 "A | B" 会被 markdown 解析成两列，整行错位
        assertEquals("A \\| B", "A | B".markdownCellSafe())
    }

    @Test
    fun `markdownCellSafe replaces newlines with spaces to prevent table break`() {
        // cell 里有换行 markdown 表格直接断开
        assertEquals("line1 line2", "line1\nline2".markdownCellSafe())
        assertEquals("line1 line2", "line1\rline2".markdownCellSafe())
    }

    @Test
    fun `markdownCellSafe preserves regular content`() {
        assertEquals("华东 1234 元", "华东 1234 元".markdownCellSafe())
    }

    // -------- bool cell：与 iOS 行为对齐显示 ✓ / ✗ --------

    @Test
    fun `cellString renders bool as check mark for cross-platform consistency with iOS`() {
        val rowTrue: JsonElement = buildJsonObject { put("done", true) }
        val rowFalse: JsonElement = buildJsonObject { put("done", false) }
        assertEquals("✓", rowCellAt(rowTrue, columnIndex = 0, columnKey = "done"))
        assertEquals("✗", rowCellAt(rowFalse, columnIndex = 0, columnKey = "done"))
    }

    // -------- 端到端：BlockItem → markdown 表头能读出真实 label --------

    @Test
    fun `decoded server schema yields readable headers via columnLabel`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "table_preview",
              "summary": "Q3 销售数据",
              "columns": [
                {"key": "region", "label": "地区"},
                {"key": "sales", "label": "销量"}
              ],
              "rows": [
                {"region": "华东", "sales": "1234"}
              ]
            }
        """.trimIndent()

        val block = json.decodeFromString(BlockItem.serializer(), payload)
        val labels = block.columns!!.map { columnLabel(it) }
        assertEquals(listOf("地区", "销量"), labels)

        val keys = block.columns!!.map { columnKey(it) }
        val firstRow = block.rows!![0]
        val cells = keys.mapIndexed { i, k -> rowCellAt(firstRow, i, k) }
        assertEquals(listOf("华东", "1234"), cells)
    }

    // -------- 端到端：buildTableMarkdown 拼出来的字符串守住整张表布局 --------
    //
    // 反思 5 同类型隐患：helper 17 个全 PASS 不代表"用户在 Android 看到的表格正确"。
    // RichTablePreview 真正交给 MarkdownBubble 的是这段拼接字符串，任何对 separator
    // 行格式 / joinToString 分隔符 / header-separator-rows 顺序的误改都会让用户看到
    // 错位的表格而 helper 测试照样全 PASS。

    @Test
    fun `buildTableMarkdown produces canonical markdown for real server payload`() {
        val columns = listOf<JsonElement>(
            buildJsonObject { put("key", "region"); put("label", "地区") },
            buildJsonObject { put("key", "sales"); put("label", "销量") },
        )
        val rows = listOf<JsonElement>(
            buildJsonObject { put("region", "华东"); put("sales", "1234") },
            buildJsonObject { put("region", "华南"); put("sales", "987") },
        )
        val expected = "| 地区 | 销量 |\n| --- | --- |\n| 华东 | 1234 |\n| 华南 | 987 |\n"
        assertEquals(expected, buildTableMarkdown(columns, rows))
    }

    @Test
    fun `buildTableMarkdown emits header and separator only when rows is null or empty`() {
        val columns = listOf<JsonElement>(
            buildJsonObject { put("key", "region"); put("label", "地区") },
        )
        val nullRows = "| 地区 |\n| --- |\n"
        assertEquals(nullRows, buildTableMarkdown(columns, null))
        assertEquals(nullRows, buildTableMarkdown(columns, emptyList()))
    }

    @Test
    fun `buildTableMarkdown escapes pipe and newline in cell content`() {
        // cell 里有 `|` 或换行 必须 escape，不然整张表错位（markdownCellSafe 责任）
        val columns = listOf<JsonElement>(
            buildJsonObject { put("key", "raw"); put("label", "原文") },
        )
        val rows = listOf<JsonElement>(
            buildJsonObject { put("raw", "A | B\nC") },
        )
        val expected = "| 原文 |\n| --- |\n| A \\| B C |\n"
        assertEquals(expected, buildTableMarkdown(columns, rows))
    }

    // -------- silent corruption 防护：字符串 "true"/"false" 不能被误判为 ✓/✗ --------
    //
    // primitiveCellContent 的 `!isString` 判断是关键防护。若未来误改成
    // `if (content == "true") return "✓"`（去掉 isString 判断），用户的状态码 cell
    // "true" 也会变 ✓，造成数据失真。这是种 silent corruption，code review 难发现。

    @Test
    fun `cellString preserves string-typed true and false unchanged`() {
        val rowStrTrue: JsonElement = buildJsonObject { put("status", "true") }
        val rowStrFalse: JsonElement = buildJsonObject { put("status", "false") }
        assertEquals("true", rowCellAt(rowStrTrue, columnIndex = 0, columnKey = "status"))
        assertEquals("false", rowCellAt(rowStrFalse, columnIndex = 0, columnKey = "status"))
    }

    // -------- cellString 嵌套 / null / 数组 cell 边界 --------

    @Test
    fun `cellString returns empty for JsonNull cell in dict row`() {
        val row: JsonElement = buildJsonObject { put("region", JsonNull) }
        assertEquals("", rowCellAt(row, columnIndex = 0, columnKey = "region"))
    }

    @Test
    fun `cellString reads label from nested dict cell`() {
        // 服务端可能把复合字段塞成 {label, value} 形态
        val row: JsonElement = buildJsonObject {
            put("region", buildJsonObject { put("label", "华东"); put("value", "east") })
        }
        assertEquals("华东", rowCellAt(row, columnIndex = 0, columnKey = "region"))
    }

    @Test
    fun `cellString joins JsonArray cell with comma separator`() {
        val row: JsonElement = buildJsonObject {
            put("tags", buildJsonArray { add("迁移"); add("性能") })
        }
        assertEquals("迁移, 性能", rowCellAt(row, columnIndex = 0, columnKey = "tags"))
    }

    // -------- columnLabel JsonObject 兜底（既无 label 也无 key） --------

    @Test
    fun `columnLabel falls back to truncated json when neither label nor key present`() {
        val col: JsonElement = buildJsonObject { put("foo", "bar") }
        val result = columnLabel(col)
        assertTrue("should not be empty", result.isNotEmpty())
        // JsonObject.toString 会包含字段名 → 至少能让用户看到一个非空标记，不是 "…" 也不是空白
        assertTrue("should contain field name", result.contains("foo"))
    }

    // -------- truncate 防巨型 cell 撑爆列宽 --------

    @Test
    fun `truncate preserves strings under 80 chars`() {
        assertEquals("华东", truncate("华东"))
        val exact80 = "a".repeat(80)
        assertEquals(exact80, truncate(exact80))
    }

    @Test
    fun `truncate adds ellipsis to strings over 80 chars`() {
        val long = "a".repeat(100)
        val result = truncate(long)
        assertEquals(81, result.length)
        assertTrue(result.endsWith("…"))
    }

    // -------- bool primitive 作为 row 时与 iOS 一致渲染 ✓/✗ --------
    //
    // 测试 16 验证了 row 是 dict 时 bool 取值正确（走 cellString → primitiveCellContent → ✓/✗）。
    // 但 row 直接是裸 bool primitive 时之前走 `row.content` 返回 "true"/"false"，
    // 与 iOS TableSchemaBridge 不一致——本测试守住 row 是裸 bool 的对齐。

    @Test
    fun `rowCellAt renders bool primitive row as check mark for iOS consistency`() {
        val rowTrue: JsonElement = JsonPrimitive(true)
        val rowFalse: JsonElement = JsonPrimitive(false)
        assertEquals("✓", rowCellAt(rowTrue, columnIndex = 0, columnKey = null))
        assertEquals("✗", rowCellAt(rowFalse, columnIndex = 0, columnKey = null))
    }

    // -------- Wave 0 收尾闭环：双端语义不一致 2 处对齐回归 --------
    //
    // 历史问题：
    // #1 服务端推 `{"label":"","key":"region"}` 时 iOS 显示 "region"（用 !isEmpty fallback），
    //    Android 此前只用 `?:` null check 显示空表头——双端体验不一致。
    //    本期改：Android `columnLabel` 加 `?.takeIf { it.isNotEmpty() }` 与 iOS 对齐。
    // #2 cell = `[{"label":"X"}]` 时 iOS 用 jsonLikeString 显示 `{"label":"X"}`，
    //    Android 递归 cellString 显示 "X"——双端体验不一致。
    //    本期改：iOS `nestedCellString` array 分支改递归与 Android 对齐。

    @Test
    fun `columnLabel falls back to key when label is empty string for cross-platform alignment`() {
        // 不一致 #1 修复回归：空 label 必须 fallback 到 key（与 iOS headerLabel `!isEmpty` 行为对齐）
        val col: JsonElement = buildJsonObject {
            put("label", "")
            put("key", "region")
        }
        assertEquals(
            "label 为空字符串时必须 fallback 到 key——双端必须一致",
            "region",
            columnLabel(col),
        )
    }

    @Test
    fun `columnLabel falls back to truncated json when label and key both empty`() {
        // 兜底：label / key 都是空字符串时不能让用户看到空表头
        val col: JsonElement = buildJsonObject {
            put("label", "")
            put("key", "")
        }
        val result = columnLabel(col)
        assertTrue("label/key 都空时 fallback 到 truncated json，绝不返回空字符串", result.isNotEmpty())
    }

    @Test
    fun `cellString recursively reads label from array of dict for iOS alignment`() {
        // 不一致 #2 修复回归：cell 是 [{label}] array 时 Android 递归取 label，
        // iOS 本期 `nestedCellString` array 分支改成递归——双端都应输出 "迁移, 性能"
        val row: JsonElement = buildJsonObject {
            put("tags", buildJsonArray {
                add(buildJsonObject { put("label", "迁移") })
                add(buildJsonObject { put("label", "性能") })
            })
        }
        assertEquals(
            "嵌套 array of dict 必须递归取 label，双端体验一致",
            "迁移, 性能",
            rowCellAt(row, columnIndex = 0, columnKey = "tags"),
        )
    }

    @Test
    fun `buildTableMarkdown handles alignment edge cases with empty label and array of dict`() {
        // 端到端守住"双端不一致 2 处对齐 + 拼接整体正确"——同时含两处历史不一致点
        // **必须与 iOS testBuildMarkdownTableHandlesAlignmentEdgeCases 期望字符串字面相等**
        val columns = listOf<JsonElement>(
            buildJsonObject { put("label", ""); put("key", "region") },
            buildJsonObject { put("key", "tags"); put("label", "标签") },
        )
        val rows = listOf<JsonElement>(
            buildJsonObject {
                put("region", "华东")
                put("tags", buildJsonArray {
                    add(buildJsonObject { put("label", "迁移") })
                    add(buildJsonObject { put("label", "性能") })
                })
            },
        )
        val expected = "| region | 标签 |\n| --- | --- |\n| 华东 | 迁移, 性能 |\n"
        assertEquals(expected, buildTableMarkdown(columns, rows))
    }

    @Test
    fun `buildTableMarkdown handles nested array of array recursively for iOS alignment`() {
        // 三视角 Review #O-3 提的边界——双端 cellString JsonArray 分支都递归调
        // cellString，对 [[a,b],[c,d]] 都输出 "a, b, c, d"。但之前没单测守住，
        // 未来误改一处双端就分裂。这里加端到端断言锁住递归 join 行为，必须与
        // **iOS testBuildMarkdownTableNestedArrayOfArrayMatchesAndroid 期望字符串字面相等**
        val columns = listOf<JsonElement>(
            buildJsonObject { put("key", "matrix"); put("label", "矩阵") },
        )
        val rows = listOf<JsonElement>(
            buildJsonObject {
                put("matrix", buildJsonArray {
                    add(buildJsonArray { add("a"); add("b") })
                    add(buildJsonArray { add("c"); add("d") })
                })
            },
        )
        val expected = "| 矩阵 |\n| --- |\n| a, b, c, d |\n"
        assertEquals(expected, buildTableMarkdown(columns, rows))
    }

    // -------- Wave 0.5 — table_preview 新增 title / total_rows 字段 --------
    //
    // 服务端 `present_to_user.py` 真实推送的 table_preview block 含 `title: Optional[str]`
    // 和 `total_rows: Optional[int]`（spec 明示 "Truncate and set total_rows for the full
    // count"），桌面端 `RichContentRenderer.tsx` 从 day 1 就在用，移动端 BlockItem 之前
    // 缺这两个字段——服务端真在推但 kotlinx.serialization 解码时被静默丢弃，
    // 用户看不到表格标题和"显示 X / Y 行"截断提示。
    //
    // 这组测试守住四件事：
    //   1) BlockItem 解码服务端真实 payload（含 title + total_rows + dict columns + dict rows）
    //      时 title / totalRows 字段被正确解析（不再 silent decode 丢失）
    //   2) title 缺失时 block.title == null（行为不变，渲染层走 takeIf 跳过）
    //   3) shouldShowTruncation 边界 case：null / 等于 / 大于 三档与桌面 `>` 字面一致
    //   4) 端到端：strings.xml format pattern 对真实 payload 输出"显示 50 / 1234 行"
    //      字面包含真实数字（用 zh format 字符串模拟 stringResource 行为）

    /// ① 服务端真实 payload 反序列化 → title / totalRows 不再 silent decode 丢失。
    /// **必须**用 JSON 字符串解码而不是直接 BlockItem(...) 构造，才能验证 schema 解码链路本身。
    @Test
    fun `decodes title and totalRows from real server payload`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "table_preview",
              "title": "销售看板",
              "summary": "Q3 销售数据",
              "total_rows": 1234,
              "columns": [
                {"key": "region", "label": "地区"},
                {"key": "sales", "label": "销量"}
              ],
              "rows": [
                {"region": "华东", "sales": "1234"},
                {"region": "华南", "sales": "987"}
              ]
            }
        """.trimIndent()

        val block = json.decodeFromString(BlockItem.serializer(), payload)
        assertEquals(
            "服务端推 title='销售看板' 时移动端必须能解码——之前 BlockItem 缺字段导致 silent decode 丢失",
            "销售看板",
            block.title,
        )
        assertEquals(
            "服务端推 total_rows=1234 时移动端必须能解码——之前 BlockItem 缺字段导致 silent decode 丢失",
            1234,
            block.totalRows,
        )
        assertEquals(2, block.columns?.size)
        assertEquals(2, block.rows?.size)
    }

    /// ② title / total_rows 缺失时（旧 payload 兼容）解码为 null，渲染层依此跳过。
    @Test
    fun `decodes title and totalRows as null when absent from legacy payload`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "table_preview",
              "summary": "无 title 的老 payload",
              "columns": [{"key": "region", "label": "地区"}],
              "rows": [{"region": "华东"}]
            }
        """.trimIndent()

        val block = json.decodeFromString(BlockItem.serializer(), payload)
        assertNull("title 缺失必须解码为 null，渲染层走 takeIf 跳过", block.title)
        assertNull("total_rows 缺失必须解码为 null，渲染层依此跳过 footer", block.totalRows)
    }

    /// ③ shouldShowTruncation 边界 case：与桌面 `totalRows > visibleRows.length` 字面一致。
    /// null / 相等 / 0 / 负数 都不显示；只有严格大于实际渲染行数才显示。
    @Test
    fun `shouldShowTruncation matches desktop strict greater-than semantics`() {
        // null total（旧服务端 / 旧 payload）→ false
        assertFalse(shouldShowTruncation(rendered = 50, total = null))
        // total == rendered（用户看到的就是全表）→ false（与桌面 `>` 字面一致）
        assertFalse(shouldShowTruncation(rendered = 50, total = 50))
        // total == 0 / total < rendered（异常 case，服务端推了但比实际少）→ false
        assertFalse(shouldShowTruncation(rendered = 50, total = 0))
        assertFalse(shouldShowTruncation(rendered = 50, total = 10))
        // total > rendered（服务端真在截断）→ true
        assertTrue(shouldShowTruncation(rendered = 50, total = 51))
        assertTrue(shouldShowTruncation(rendered = 2, total = 1234))
    }

    // -------- Wave 1 — table_preview 视觉与桌面对齐：summary 不渲染但保留为 a11y 兜底 --------
    //
    // 桌面 `apps/tabtin-electron/.../RichContentRenderer.tsx` 的 RichTablePreview 视觉
    // 只渲染 title + 表格 + 截断 footer，**不渲染 summary**——summary 在
    // `present_to_user.py` spec 里定位为「移动端 fallback + 无障碍」，本质是兜底文案
    // 不是主 UI 文案。Wave 0.5 加 title 后「summary + title」两段意义重复。用户拍板：
    // 移动端删冗余 summary 视觉，跟桌面字面对齐。
    //
    // 这组测试守住四件事：
    //   1) BlockItem.summary 字段仍能被解码（防过度删字段——Wave 4 widget 烤图失败时
    //      移动端 fallback 还要靠这个字段）
    //   2) 渲染 plan 的视觉字段（visibleTitle / markdownTable）字面**不包含** summary 文本
    //      （防 silent regression：未来有人把 summary Text 加回 Composable）
    //   3) 渲染 plan 的 a11y label 字面**包含** summary 文本（视障用户读屏体验不丢）
    //   4) summary 缺失但 title 在场时退化优雅（a11y label 只有 title，没有空白分隔符）

    /// ① 视觉字段不含 summary：plan.visibleTitle / plan.markdownTable 字面不包含 summary
    @Test
    fun `planTablePreviewRender visual fields do not contain summary text`() {
        val summary = "Q3 销售数据"
        val columns = listOf<JsonElement>(
            buildJsonObject { put("key", "region"); put("label", "地区") },
            buildJsonObject { put("key", "sales"); put("label", "销量") },
        )
        val rows = listOf<JsonElement>(
            buildJsonObject { put("region", "华东"); put("sales", "1234") },
        )
        val plan = planTablePreviewRender(
            title = "销售看板",
            summary = summary,
            columns = columns,
            rows = rows,
            totalRows = 1234,
        )
        assertNotNull("columns 非空时 plan 必须返回非 null", plan)
        plan!!
        assertEquals("销售看板", plan.visibleTitle)
        assertFalse(
            "视觉 title 不应包含 summary 文本——桌面端 RichTablePreview 不渲染 summary",
            plan.visibleTitle?.contains(summary) == true,
        )
        assertFalse(
            "视觉 markdown 表格不应包含 summary 文本——summary 只在 a11y label 里",
            plan.markdownTable.contains(summary),
        )
    }

    /// ② a11y label 包含 summary：视障用户读屏体验不丢
    @Test
    fun `planTablePreviewRender accessibility label contains summary for screen readers`() {
        val summary = "Q3 销售数据"
        val plan = planTablePreviewRender(
            title = "销售看板",
            summary = summary,
            columns = listOf(buildJsonObject { put("key", "region"); put("label", "地区") }),
            rows = null,
            totalRows = null,
        )
        assertNotNull(plan)
        plan!!
        val label = plan.accessibilityLabel
        assertNotNull("有 summary 时 a11y label 必须非空——视障用户兜底朗读不能丢", label)
        assertTrue(
            "a11y label 必须字面包含 summary 文本：实际=$label",
            label!!.contains(summary),
        )
        assertTrue(
            "a11y label 同时含视觉 title，让视障用户听到完整上下文：实际=$label",
            label.contains("销售看板"),
        )
    }

    /// ③ summary 缺失（旧 payload / 服务端不推）时 a11y label 退化优雅：只剩 title，没空白分隔符
    @Test
    fun `planTablePreviewRender accessibility label degrades gracefully when summary missing`() {
        val plan = planTablePreviewRender(
            title = "销售看板",
            summary = null,
            columns = listOf(buildJsonObject { put("key", "region"); put("label", "地区") }),
            rows = null,
            totalRows = null,
        )
        assertNotNull(plan)
        assertEquals(
            "summary 缺失时 a11y label 只剩视觉 title，没多余分隔符——视障用户听到的就是「销售看板」",
            "销售看板",
            plan!!.accessibilityLabel,
        )
    }

    /// ④ summary + title 都缺失时 a11y label 为 null（让 TalkBack 走 children 默认朗读）
    @Test
    fun `planTablePreviewRender accessibility label is null when summary and title both absent`() {
        val plan = planTablePreviewRender(
            title = null,
            summary = null,
            columns = listOf(buildJsonObject { put("key", "region"); put("label", "地区") }),
            rows = null,
            totalRows = null,
        )
        assertNotNull(plan)
        assertNull(
            "summary + title 都缺时 a11y label 为 null——让 TalkBack 走 children 默认朗读，避免空字符串覆盖",
            plan!!.accessibilityLabel,
        )
    }

    /// ⑤ columns 缺失时 plan 返回 null（caller 走 RichFallback，行为不变）
    @Test
    fun `planTablePreviewRender returns null when columns missing or empty for fallback path`() {
        assertNull(planTablePreviewRender(
            title = "销售看板",
            summary = "Q3",
            columns = null,
            rows = null,
            totalRows = null,
        ))
        assertNull(planTablePreviewRender(
            title = null,
            summary = "Q3",
            columns = emptyList(),
            rows = null,
            totalRows = null,
        ))
    }

    /// ⑥ 端到端：BlockItem 真实 payload 解码后 → planTablePreviewRender → summary 字段保留 +
    /// 视觉无 summary + a11y 含 summary——把字段保留 + 视觉对齐 + a11y 三件事一次断言
    @Test
    fun `decoded BlockItem with summary feeds plan that excludes summary visually but keeps it for a11y`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "table_preview",
              "title": "销售看板",
              "summary": "Q3 销售数据",
              "total_rows": 1234,
              "columns": [
                {"key": "region", "label": "地区"},
                {"key": "sales", "label": "销量"}
              ],
              "rows": [
                {"region": "华东", "sales": "1234"}
              ]
            }
        """.trimIndent()
        val block = json.decodeFromString(BlockItem.serializer(), payload)
        assertEquals(
            "BlockItem.summary 必须保留——Wave 4 widget 烤图失败时移动端 fallback 还要用",
            "Q3 销售数据",
            block.summary,
        )

        val plan = planTablePreviewRender(
            title = block.title,
            summary = block.summary,
            columns = block.columns,
            rows = block.rows,
            totalRows = block.totalRows,
        )
        assertNotNull(plan)
        plan!!
        assertFalse(
            "端到端：plan.markdownTable 不应包含 summary 文本",
            plan.markdownTable.contains("Q3 销售数据"),
        )
        assertEquals("plan.visibleTitle 只渲染 title，不渲染 summary", "销售看板", plan.visibleTitle)
        assertTrue(
            "plan.accessibilityLabel 必须含 summary：实际=${plan.accessibilityLabel}",
            plan.accessibilityLabel?.contains("Q3 销售数据") == true,
        )
        assertEquals(
            "plan.truncationFooter 真实 payload total=1234 > rendered=1，必须显示 footer",
            TablePreviewRenderPlan.TruncationFooter(rendered = 1, total = 1234),
            plan.truncationFooter,
        )
    }

    /// ④ 端到端：服务端推 total_rows=1234 + rows.size=2 的真实 payload，
    /// 用 strings.xml zh format pattern "显示 %1${'$'}d / %2${'$'}d 行" 模拟 stringResource
    /// 输出，字面包含真实数字 + "显示" + "行"——与桌面 zh-Hans `richContent.showingRows`
    /// 文案"显示 {{shown}} / {{total}} 行"对齐。这是反思 5 防线：用 JSON 反序列化 + 字面
    /// 包含断言守住"服务端真实 payload → 用户可见字符串"全链路。
    @Test
    fun `showingRows message contains real numbers from decoded block end-to-end`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "table_preview",
              "title": "销售看板",
              "total_rows": 1234,
              "columns": [{"key": "region", "label": "地区"}],
              "rows": [
                {"region": "华东"},
                {"region": "华南"}
              ]
            }
        """.trimIndent()
        val block = json.decodeFromString(BlockItem.serializer(), payload)
        val rendered = block.rows?.size ?: 0
        val total = block.totalRows
        assertTrue(
            "测试前提：total_rows > 实际渲染行数",
            shouldShowTruncation(rendered, total),
        )

        // 模拟 strings.xml `rich_content_showing_rows` zh format
        // （JVM unit test 读不到 Android resources，但 format 串和 strings.xml 必须保持一致——
        // 任何对 strings.xml 该 key 的修改双端必须同步改这里的 expected）
        val message = "显示 %1\$d / %2\$d 行".format(rendered, total)

        assertEquals(
            "端到端：title='销售看板' + total_rows=1234 + rows.size=2 输出必须字面相等——" +
                "之前 BlockItem 缺字段导致用户永远看不到这条信息",
            "显示 2 / 1234 行",
            message,
        )
        assertTrue("title 也要从同 payload 解码出来", block.title == "销售看板")
    }

    // -------- Wave 2 prerequisite：widget kind 未知字段 silent skip 防线 --------

    /**
     * Wave 2 prerequisite（widget RFC §五）：服务端推 `kind:'widget'` 含 `code` /
     * `widget_id` / `format` / `image_url` 字段时，老 Android 客户端 BlockItem
     * 没有这些字段，必须**忽略未知字段**继续解码。
     *
     * 之前 `StreamManager.kt:569` 用裸 `Json.decodeFromJsonElement(BlockItem.serializer(), obj)`
     * 默认 `ignoreUnknownKeys = false` 会抛 UnknownFieldException 被外层 catch
     * 吞掉——用户看到空消息而不是 RichFallback 的 summary 兜底。
     *
     * 本测试模拟：用 `ApiClient.json`（`ignoreUnknownKeys = true`）解码 widget
     * payload 必须不抛异常 + 仍能拿到 type / kind / summary，让 RichFallback
     * 至少能渲染兜底文案。
     *
     * **不再使用主 set 的真实 ApiClient.json**：该 val 引用了 BuildConfig 等
     * Android 主 source set 里的依赖（K2JVMCompiler 单独编译时不可用）。这里
     * 在测试内部构造同等配置的 `Json { ignoreUnknownKeys = true }` 来断言
     * 行为；运行期实际由 ApiJson 兜底。
     */
    @Test
    fun `widget kind payload with declared fields decodes correctly`() {
        // BlockItem 已声明 widget 5 字段（widget_id / code / format / image_url /
        // loading_message）后，widget payload 含这些字段直接走正常路径就能解出来，
        // 不再依赖 ignoreUnknownKeys 兜底。这条测试守住"声明字段都能解码出来"的正向断言。
        val widgetPayload = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "Kubernetes 三层架构示意图",
              "widget_id": "wgt_abc123",
              "code": "<svg viewBox='0 0 680 400'><rect x='10' y='10' width='100' height='50'/></svg>",
              "format": "svg",
              "image_url": "https://example.com/widget.png",
              "loading_message": "正在画…",
              "title": "K8s 架构"
            }
        """.trimIndent()

        val apiJson = Json { ignoreUnknownKeys = true }
        val block = apiJson.decodeFromString(BlockItem.serializer(), widgetPayload)

        assertEquals("rich_content", block.type)
        assertEquals("widget", block.kind)
        assertEquals("Kubernetes 三层架构示意图", block.summary)
        assertEquals("wgt_abc123", block.widgetId)
        assertEquals("svg", block.format)
        assertEquals("https://example.com/widget.png", block.imageUrl)
        assertEquals("正在画…", block.loadingMessage)
        assertEquals("K8s 架构", block.title)
    }

    /**
     * 守护反例：默认 `Json {}`（不配 ignoreUnknownKeys）遇到**真未知字段**
     * 必须抛异常——证明 prerequisite 的修复是真有意义的（不是 vacuous 通过）。
     *
     * **重要**：因为 BlockItem 现在已经显式列了 widget 的 5 个字段（widget_id /
     * code / format / image_url / loading_message），用 widget kind 已知字段做反
     * 例已经不会爆。这里改用 Wave 4 / Wave 7 还没声明的"未来字段"模拟真实场景：
     * 服务端推 BlockItem 没声明的字段时，老 client 用裸 Json 解码会爆。
     *
     * 这条测试守住的真正逻辑：未来 BlockItem 字段集滞后于服务端时，必须用
     * ApiJson（ignoreUnknownKeys=true）兜底。
     */
    @Test(expected = kotlinx.serialization.SerializationException::class)
    fun `default Json throws on truly unknown field for forward compat`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "test",
              "code": "<svg/>",
              "format": "svg",
              "fictitious_future_field_v3": {"foo": "bar"}
            }
        """.trimIndent()
        // 裸 Json {}：ignoreUnknownKeys 默认 false，遇到 BlockItem 未声明字段必须抛异常
        Json.decodeFromString(BlockItem.serializer(), payload)
    }

    /**
     * 端到端：用 ApiJson 配置（ignoreUnknownKeys=true）解码同样含未来未知字段
     * 的 widget payload，必须不抛异常 + 仍能拿到 type/kind/summary 走 fallback。
     *
     * 这是 prerequisite 的真正价值：未来服务端推任何新字段（Wave 7 sendPrompt
     * 加 `interactive_regions` / Wave 6 mermaid 加 `compiled_at` / 等等）老
     * Android client 都不会 silent skip 整个 BlockItem。
     */
    @Test
    fun `ApiJson decodes widget payload with future unknown fields without throwing`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "Kubernetes 三层架构",
              "widget_id": "wgt_abc",
              "code": "<svg/>",
              "format": "svg",
              "image_url": "https://example.com/wgt.png",
              "loading_message": "正在画…",
              "interactive_regions_v3": [{"x": 1}],
              "compiled_at_v6": "2026-04-29"
            }
        """.trimIndent()
        val apiJson = Json { ignoreUnknownKeys = true }
        val block = apiJson.decodeFromString(BlockItem.serializer(), payload)
        assertEquals("rich_content", block.type)
        assertEquals("widget", block.kind)
        assertEquals("Kubernetes 三层架构", block.summary)
        // 已声明的 widget 字段也能解出来
        assertEquals("wgt_abc", block.widgetId)
        assertEquals("<svg/>", block.code)
        assertEquals("svg", block.format)
        assertEquals("https://example.com/wgt.png", block.imageUrl)
        assertEquals("正在画…", block.loadingMessage)
    }

    // -------- Wave 4 widget 渲染 plan（widget RFC §五 4.9 / 4.11） --------
    //
    // RichWidget Composable 的渲染路径完全由 `planWidgetRender` 决策——imageUrl 字段
    // 非空 → 走 image 路径；否则走"在桌面端查看"烤图失败兜底。这组测试守住三个
    // 关键回归（反思 5 / 反思 9 / 反思 10）：
    //
    //   1) **真实 server payload** 反序列化 → plan 走 image 路径（反思 5 防线）
    //   2) **image_url 空字符串 / 缺失** → plan 走 fallback（A 子 Agent 烤图失败契约）
    //   3) **多 turn 场景** → plan 互不污染（反思 10：两个 turn 独立 widget URL 不串台）
    //   4) **a11y label** 字面包含 widgetBadge + title + summary（视障用户兜底朗读）
    //
    // 与 iOS `WidgetRenderBridge.WidgetRenderPlan` 字面对齐：相同 BlockItem 输入双端
    // plan 字段值字面相等。任何修改双端必须同步——包括 a11y 分隔符（` — `）/ 空字段
    // 处理 / image_url 空字符串判定逻辑。

    /// ① 服务端真实 payload（含 image_url + summary + title + widget_id）反序列化 →
    /// plan 走 image 路径，URL 字段保留 + a11y label 完整。这是端到端反思 5 防线：
    /// 用 JSON 字符串解码而不是直接 BlockItem(...) 构造，验证 schema 解码链路本身。
    @Test
    fun `widget render plan shows image when image_url present in real server payload`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "Kubernetes 三层架构示意图",
              "title": "K8s 架构",
              "widget_id": "wgt_real_1",
              "code": "<svg viewBox='0 0 680 400'></svg>",
              "format": "svg",
              "image_url": "https://oss.example.com/widgets/k8s.png",
              "loading_message": "正在画…"
            }
        """.trimIndent()
        val apiJson = Json { ignoreUnknownKeys = true }
        val block = apiJson.decodeFromString(BlockItem.serializer(), payload)
        assertEquals(
            "BlockItem 必须能从 snake_case JSON 解出 imageUrl 字段",
            "https://oss.example.com/widgets/k8s.png",
            block.imageUrl,
        )

        val plan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = block.title,
            summary = block.summary,
            imageUrl = block.imageUrl,
        )
        assertEquals(
            "imageUrl 字符串非空 → plan.imageUrl 必须含真实 URL（走 image 路径）",
            "https://oss.example.com/widgets/k8s.png",
            plan.imageUrl,
        )
        assertFalse(
            "imageUrl 有效 → 不应走烤图失败兜底",
            plan.shouldShowBakeFailedFallback,
        )
        assertEquals("K8s 架构", plan.visibleTitle)
        assertEquals("Kubernetes 三层架构示意图", plan.visibleSummary)
        assertEquals(
            "a11y label 必须含 widgetBadge + title + summary，让 TalkBack 用户听到完整上下文",
            "图示 — K8s 架构 — Kubernetes 三层架构示意图",
            plan.accessibilityLabel,
        )
    }

    /// ② image_url 空字符串（A 子 Agent 烤图失败契约：emit RICH_CONTENT 但 image_url
    /// 为空字符串）→ plan 走兜底分支。这条测试守住 A/B 子 Agent 间的契约不能 silent 漂移。
    @Test
    fun `widget render plan falls back when image_url is empty string`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "Agent 画了一张图但烤图失败了",
              "title": "K8s 架构",
              "widget_id": "wgt_bake_failed_1",
              "code": "<svg viewBox='0 0 680 400'></svg>",
              "format": "svg",
              "image_url": ""
            }
        """.trimIndent()
        val apiJson = Json { ignoreUnknownKeys = true }
        val block = apiJson.decodeFromString(BlockItem.serializer(), payload)
        assertEquals("解码后 imageUrl 应该是空字符串而不是 null", "", block.imageUrl)

        val plan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = block.title,
            summary = block.summary,
            imageUrl = block.imageUrl,
        )
        assertNull(
            "image_url 空字符串 → plan.imageUrl 必须为 null，避免渲染层 AsyncImage 接空串",
            plan.imageUrl,
        )
        assertTrue(
            "image_url 空 → 必须走烤图失败兜底（A 子 Agent 烤图失败契约）",
            plan.shouldShowBakeFailedFallback,
        )
        assertEquals("K8s 架构", plan.visibleTitle)
        assertEquals("Agent 画了一张图但烤图失败了", plan.visibleSummary)
        assertEquals(
            "fallback 路径下 a11y label 仍要包含 summary，让视障用户至少听到 widget 大致内容",
            "图示 — K8s 架构 — Agent 画了一张图但烤图失败了",
            plan.accessibilityLabel,
        )
    }

    /// ③ image_url 字段缺失（旧 client / Wave 4 之前的 payload）→ plan 走兜底分支，
    /// 让客户端不爆栈，老消息历史回放也安全。
    @Test
    fun `widget render plan falls back when image_url field missing`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "缺 image_url 字段的旧 payload"
            }
        """.trimIndent()
        val apiJson = Json { ignoreUnknownKeys = true }
        val block = apiJson.decodeFromString(BlockItem.serializer(), payload)
        assertNull("缺字段必须解码为 null", block.imageUrl)

        val plan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = block.title,
            summary = block.summary,
            imageUrl = block.imageUrl,
        )
        assertNull(plan.imageUrl)
        assertTrue(
            "image_url 缺字段 → 必须走 fallback（旧 client 兼容）",
            plan.shouldShowBakeFailedFallback,
        )
        assertNull("title 缺失时 plan.visibleTitle 为 null", plan.visibleTitle)
        assertEquals("缺 image_url 字段的旧 payload", plan.visibleSummary)
        assertEquals(
            "title 缺失但 summary 在场时，a11y label 只含 widgetBadge + summary（没空白分隔符）",
            "图示 — 缺 image_url 字段的旧 payload",
            plan.accessibilityLabel,
        )
    }

    /// ④ 多 turn 场景（反思 10）：mock 同 session 跑 2 个 turn，每 turn emit 独立 widget
    /// block（不同 widget_id + 不同 image_url），断言 plan 互不污染。这是反思 10 教训
    /// 的延伸——sessionId 在两 turn 内是同一个，但 widget block 的 imageUrl 必须独立。
    @Test
    fun `widget render plan is independent across multiple turns`() {
        val turn1Json = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "Turn 1: K8s 架构图",
              "title": "K8s",
              "widget_id": "wgt_turn1",
              "image_url": "https://oss.example.com/widgets/turn1.png"
            }
        """.trimIndent()
        val turn2Json = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "Turn 2: 数据流图",
              "title": "DataFlow",
              "widget_id": "wgt_turn2",
              "image_url": "https://oss.example.com/widgets/turn2.png"
            }
        """.trimIndent()
        val apiJson = Json { ignoreUnknownKeys = true }
        val turn1Block = apiJson.decodeFromString(BlockItem.serializer(), turn1Json)
        val turn2Block = apiJson.decodeFromString(BlockItem.serializer(), turn2Json)

        val plan1 = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = turn1Block.title,
            summary = turn1Block.summary,
            imageUrl = turn1Block.imageUrl,
        )
        val plan2 = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = turn2Block.title,
            summary = turn2Block.summary,
            imageUrl = turn2Block.imageUrl,
        )

        assertEquals("https://oss.example.com/widgets/turn1.png", plan1.imageUrl)
        assertEquals("https://oss.example.com/widgets/turn2.png", plan2.imageUrl)
        assertTrue(
            "两 turn widget URL 必须独立——上 turn URL 不能污染下 turn",
            plan1.imageUrl != plan2.imageUrl,
        )
        assertTrue(
            "两 turn a11y label 必须各自独立反映自己的 summary / title",
            plan1.accessibilityLabel != plan2.accessibilityLabel,
        )
        assertEquals("wgt_turn1", turn1Block.widgetId)
        assertEquals(
            "两 turn widget_id 必须各自独立——验证多 turn 场景的字段隔离",
            "wgt_turn2",
            turn2Block.widgetId,
        )
    }

    /// ⑤ image_url 是非 http(s) scheme 字符串（边界 case）→ 走烤图失败 fallback。
    /// 与 iOS `WidgetRenderBridge.planRender` URL scheme 校验对齐：服务端推一段
    /// 脏数据（whitespace / `not a url` / `file:///` / 自定义 scheme）时 plan 拒绝
    /// 当作有效 URL，让 fallback 接管视觉。这是双端共同的早期防线，不依赖渲染层
    /// AsyncImage onState Error 兜底。
    @Test
    fun `widget render plan rejects non-http scheme image_url for stability`() {
        // whitespace-only：不是有效 URL
        val whitespacePlan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = null,
            summary = "脏 URL 1",
            imageUrl = "   ",
        )
        assertNull(
            "whitespace-only 字符串不是 http(s) URL → plan 走 fallback",
            whitespacePlan.imageUrl,
        )
        assertTrue(whitespacePlan.shouldShowBakeFailedFallback)

        // 非 http(s) scheme（比如服务端误推 file:/// 或自定义 scheme）→ fallback
        val nonHttpPlan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = null,
            summary = "脏 URL 2",
            imageUrl = "file:///etc/passwd",
        )
        assertNull(
            "非 http(s) scheme URL → plan 走 fallback（防安全风险）",
            nonHttpPlan.imageUrl,
        )
        assertTrue(nonHttpPlan.shouldShowBakeFailedFallback)

        // 含非法字符的 URL → fallback
        val garbagePlan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = null,
            summary = "脏 URL 3",
            imageUrl = "not a url \n\n\t with whitespace",
        )
        assertNull(garbagePlan.imageUrl)
        assertTrue(garbagePlan.shouldShowBakeFailedFallback)

        // http (大小写不敏感) 仍然接受
        val httpPlan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = null,
            summary = "正常 URL",
            imageUrl = "HTTPS://oss.example.com/wgt.png",
        )
        assertEquals(
            "URL scheme 校验大小写不敏感（`HTTPS://...` 也应接受）",
            "HTTPS://oss.example.com/wgt.png",
            httpPlan.imageUrl,
        )
        assertFalse(httpPlan.shouldShowBakeFailedFallback)
    }

    // -------- Mobile 对齐 Wave — widget / rich_content 新字段解码 + Mermaid fallback --------
    //
    // 这组测试守住 4 个关键 invariant（反思 5 / 9 / 10 的延伸，与 iOS
    // `StreamRichContentTests` Mobile 对齐 Wave 段字面对齐）：
    //
    //   1) **真实 server payload** 一次反序列化 8 个新字段（tool_call_id / source_code /
    //      mermaid_source / rendered_code / group_id / group_title / interrupted_at /
    //      interrupted_status）全部能解码出来，不 silent drop（反思 5 防线）
    //   2) **旧 payload 兼容**：这些字段缺失时解码不抛，字段为 null
    //   3) **Mermaid fallback 入口**：format=="mermaid" + imageUrl 缺失 + mermaid_source
    //      非空 → plan.mermaidFallbackSource 非 null（移动端用户能看到源码）
    //   4) **多 turn 场景**（反思 10）：同一 session 两个 turn emit 独立 widget block 含
    //      不同 tool_call_id / group_id / interrupted_at，字段互不污染
    //
    // 与 iOS `StreamRichContentTests` Mobile 对齐 Wave 段对应测试字面对齐——相同
    // BlockItem 输入双端字段 / plan 值字面相等。任何修改双端必须同步。

    /// ① 服务端真实 widget payload（含全部 8 个新字段 + 基础 widget 字段）反序列化 →
    /// BlockItem 所有新字段都能正确解码。之前 BlockItem 缺这 8 个字段，kotlinx 会 silent
    /// 丢弃（ignoreUnknownKeys=true 时）或抛异常（默认时），导致移动端拿到残缺 widget
    /// block 或整条 BlockItem 被 catch 吞掉。
    @Test
    fun `BlockItem decodes all new fields from real server payload`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "Mermaid ER 图",
              "title": "订单模型 ER",
              "widget_id": "wgt_real_new",
              "tool_call_id": "call_mermaid_er_42",
              "source_code": "erDiagram\n  USER ||--o{ ORDER : places",
              "mermaid_source": "erDiagram\n  USER ||--o{ ORDER : places",
              "rendered_code": "<svg viewBox='0 0 680 400'></svg>",
              "code": "<svg viewBox='0 0 680 400'></svg>",
              "format": "mermaid",
              "image_url": "https://oss.example.com/widgets/er.png",
              "loading_message": "正在编译 Mermaid…",
              "group_id": "grp_domain_model",
              "group_title": "订单域模型",
              "interrupted_at": 1735689600123,
              "interrupted_status": "cancelled"
            }
        """.trimIndent()

        val block = json.decodeFromString(BlockItem.serializer(), payload)
        assertEquals("widget", block.kind)
        assertEquals(
            "tool_call_id 必须解码到 toolCallId——前端精确替换 placeholder 依赖此字段",
            "call_mermaid_er_42",
            block.toolCallId,
        )
        assertEquals(
            "source_code 必须解码——Mermaid fallback 展示原始 mermaid 源码",
            "erDiagram\n  USER ||--o{ ORDER : places",
            block.sourceCode,
        )
        assertEquals(
            "mermaid_source 必须解码——Mermaid fallback 展示原始 mermaid 源码",
            "erDiagram\n  USER ||--o{ ORDER : places",
            block.mermaidSource,
        )
        assertEquals(
            "rendered_code 必须解码——未来原生 SVG 渲染走这个字段",
            "<svg viewBox='0 0 680 400'></svg>",
            block.renderedCode,
        )
        assertEquals(
            "group_id 必须解码——多 widget 分组展示（本轮不做 UI，但字段就位）",
            "grp_domain_model",
            block.groupId,
        )
        assertEquals(
            "group_title 必须解码——多 widget 分组展示（本轮不做 UI，但字段就位）",
            "订单域模型",
            block.groupTitle,
        )
        assertEquals(
            "interrupted_at 必须解码为 Long 毫秒时间戳，保证 2038 之后依然安全",
            1735689600123L,
            block.interruptedAt,
        )
        assertEquals(
            "interrupted_status 必须解码为字符串，与 TS 枚举字面对齐",
            "cancelled",
            block.interruptedStatus,
        )
        // 已有字段仍能共存
        assertEquals("wgt_real_new", block.widgetId)
        assertEquals("mermaid", block.format)
        assertEquals("https://oss.example.com/widgets/er.png", block.imageUrl)
    }

    /// ② 旧 payload 兼容：缺失新字段时解码不抛，字段为 null——服务端还没推这些字段的
    /// 旧 widget block（Wave 4 之前）必须照常解码，让移动端历史回放不爆。
    @Test
    fun `BlockItem new fields absence decodes gracefully`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "只有 summary 的老 widget payload"
            }
        """.trimIndent()
        val block = json.decodeFromString(BlockItem.serializer(), payload)
        assertEquals("widget", block.kind)
        assertEquals("只有 summary 的老 widget payload", block.summary)
        // 所有 8 个新字段必须为 null，不是空字符串不是 0 不是 "unknown"
        assertNull("缺字段必须为 null", block.toolCallId)
        assertNull(block.sourceCode)
        assertNull(block.mermaidSource)
        assertNull(block.renderedCode)
        assertNull(block.groupId)
        assertNull(block.groupTitle)
        assertNull(
            "Long 缺字段必须为 null，不是 0L——渲染层按 null 跳过中断 UI",
            block.interruptedAt,
        )
        assertNull(
            "String 缺字段必须为 null，不是空字符串或 'unknown'",
            block.interruptedStatus,
        )
    }

    /// ③ Mermaid fallback 入口：当烤图失败（imageUrl 空）+ format=="mermaid" + mermaid_source
    /// 非空时，plan.mermaidFallbackSource 非 null。这是本轮做 UI 的**唯一新入口**——
    /// 用户场景：桌面端画 Mermaid widget → 移动端拉历史，烤图失败，至少能看到 mermaid 源码。
    @Test
    fun `mermaid fallback source exposed when bake failed with mermaid format`() {
        val payload = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "Mermaid 流程图 - 订单处理",
              "title": "订单处理流程",
              "widget_id": "wgt_mermaid_flow",
              "format": "mermaid",
              "mermaid_source": "graph TD;\n  A[下单] --> B[支付]\n  B --> C[发货]",
              "image_url": ""
            }
        """.trimIndent()
        val block = json.decodeFromString(BlockItem.serializer(), payload)
        assertEquals("mermaid", block.format)
        assertEquals("imageUrl 是空字符串——A 子 Agent 烤图失败契约", "", block.imageUrl)

        val plan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = block.title,
            summary = block.summary,
            imageUrl = block.imageUrl,
            format = block.format,
            mermaidSource = block.mermaidSource,
            sourceCode = block.sourceCode,
        )
        assertTrue(
            "imageUrl 空 → 走 fallback 分支",
            plan.shouldShowBakeFailedFallback,
        )
        assertEquals(
            "format=mermaid + imageUrl 缺失 + mermaid_source 非空 → plan 必须暴露 mermaid 源码给 UI 层",
            "graph TD;\n  A[下单] --> B[支付]\n  B --> C[发货]",
            plan.mermaidFallbackSource,
        )

        // 边界 ③a：format 大小写不敏感
        val upperFormatPlan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = null,
            summary = null,
            imageUrl = "",
            format = "MERMAID",
            mermaidSource = "graph TD; A-->B",
        )
        assertEquals(
            "format 大小写不敏感（防服务端推 'Mermaid' / 'MERMAID' 让源码入口失踪）",
            "graph TD; A-->B",
            upperFormatPlan.mermaidFallbackSource,
        )

        // 边界 ③b：format=mermaid 但 mermaid_source 空 → source_code 兜底（Python mirror
        // 暂不编译 Mermaid 只保留 source_code 的场景）
        val sourceCodeOnlyPlan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = null,
            summary = null,
            imageUrl = "",
            format = "mermaid",
            mermaidSource = null,
            sourceCode = "graph LR; X-->Y",
        )
        assertEquals(
            "mermaid_source 空时 source_code 兜底——Python mirror 暂不编译 Mermaid 的场景",
            "graph LR; X-->Y",
            sourceCodeOnlyPlan.mermaidFallbackSource,
        )

        // 边界 ③c：format=mermaid 但**两个源码字段都空** → mermaidFallbackSource 必须为 null
        // （UI 层走纯"在桌面端查看"兜底，不展示空面板）
        val bothEmptyPlan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = null,
            summary = null,
            imageUrl = "",
            format = "mermaid",
            mermaidSource = "",
            sourceCode = "",
        )
        assertNull(
            "两个源码字段都空 → 不挂空面板（视觉上不能让用户点开发现啥也没有）",
            bothEmptyPlan.mermaidFallbackSource,
        )

        // 边界 ③d：format=svg（非 mermaid）→ mermaidFallbackSource 必须为 null（SVG 源码
        // 对用户不可读，展开反而增加认知负担）
        val svgPlan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = null,
            summary = null,
            imageUrl = "",
            format = "svg",
            mermaidSource = "<svg>...</svg>",
            sourceCode = "<svg>...</svg>",
        )
        assertNull(
            "format=svg 时不挂源码入口——SVG 源码对用户不可读",
            svgPlan.mermaidFallbackSource,
        )

        // 边界 ③e：imageUrl **有效**时不挂源码入口（即使 format=mermaid + 源码非空）
        // ——有图的情况下展开源码会抢焦点，用户一般只想看图
        val hasImagePlan = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = null,
            summary = null,
            imageUrl = "https://oss.example.com/widgets/ok.png",
            format = "mermaid",
            mermaidSource = "graph TD; A-->B",
        )
        assertNull(
            "imageUrl 有效时不挂源码入口——有图就让图说话，源码面板抢焦点",
            hasImagePlan.mermaidFallbackSource,
        )
    }

    /// ④ 多 turn 场景（反思 10）：mock 同 session 跑 2 个 turn，每 turn emit 独立 widget
    /// block（不同 tool_call_id / group_id / interrupted_at），断言字段互不污染。
    /// sessionId 在两 turn 内是同一个，但 widget block 的独立身份字段必须独立。
    @Test
    fun `new widget fields are independent across multiple turns`() {
        val turn1Json = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "Turn 1: Mermaid 流程图",
              "title": "下单流程",
              "widget_id": "wgt_turn1",
              "tool_call_id": "call_turn1_svg",
              "mermaid_source": "graph TD; A-->B",
              "format": "mermaid",
              "group_id": "grp_flow",
              "group_title": "下单",
              "interrupted_at": 1735689600123,
              "interrupted_status": "cancelled"
            }
        """.trimIndent()
        val turn2Json = """
            {
              "type": "rich_content",
              "kind": "widget",
              "summary": "Turn 2: ER 图",
              "title": "订单模型",
              "widget_id": "wgt_turn2",
              "tool_call_id": "call_turn2_er",
              "mermaid_source": "erDiagram\n  USER ||--o{ ORDER : places",
              "format": "mermaid",
              "group_id": "grp_model",
              "group_title": "数据模型",
              "interrupted_at": 1735689700456,
              "interrupted_status": "error"
            }
        """.trimIndent()
        val turn1Block = json.decodeFromString(BlockItem.serializer(), turn1Json)
        val turn2Block = json.decodeFromString(BlockItem.serializer(), turn2Json)

        // tool_call_id 独立——前端按 tool_call_id 精确寻址 placeholder 不串台
        assertEquals("call_turn1_svg", turn1Block.toolCallId)
        assertEquals("call_turn2_er", turn2Block.toolCallId)
        assertTrue(
            "两 turn tool_call_id 必须独立——前端按 tool_call_id 精确替换 placeholder 不串台",
            turn1Block.toolCallId != turn2Block.toolCallId,
        )

        // group_id / group_title 独立
        assertEquals("grp_flow", turn1Block.groupId)
        assertEquals("grp_model", turn2Block.groupId)
        assertEquals("下单", turn1Block.groupTitle)
        assertEquals("数据模型", turn2Block.groupTitle)
        assertTrue(
            "两 turn group_id 必须独立——多 widget 分组展示防串台",
            turn1Block.groupId != turn2Block.groupId,
        )

        // interrupted_at / interrupted_status 独立
        assertEquals(1735689600123L, turn1Block.interruptedAt)
        assertEquals(1735689700456L, turn2Block.interruptedAt)
        assertTrue(
            "两 turn interrupted_at 必须独立——时间戳反映各自 turn 的中断时机",
            turn1Block.interruptedAt != turn2Block.interruptedAt,
        )
        assertEquals("cancelled", turn1Block.interruptedStatus)
        assertEquals("error", turn2Block.interruptedStatus)

        // mermaid_source 独立（两 turn 源码内容完全不同）
        assertTrue(
            "两 turn mermaid_source 必须独立——源码内容反映各自 turn 的 widget 内容",
            turn1Block.mermaidSource != turn2Block.mermaidSource,
        )

        // 进一步验证 plan 层面字段互不污染
        val plan1 = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = turn1Block.title,
            summary = turn1Block.summary,
            imageUrl = turn1Block.imageUrl,
            format = turn1Block.format,
            mermaidSource = turn1Block.mermaidSource,
        )
        val plan2 = planWidgetRender(
            widgetBadgeLabel = "图示",
            title = turn2Block.title,
            summary = turn2Block.summary,
            imageUrl = turn2Block.imageUrl,
            format = turn2Block.format,
            mermaidSource = turn2Block.mermaidSource,
        )
        assertEquals(
            "turn1 Mermaid 源码在 plan 层面独立暴露",
            "graph TD; A-->B",
            plan1.mermaidFallbackSource,
        )
        assertEquals(
            "turn2 Mermaid 源码在 plan 层面独立暴露——反思 10 多 turn 防线",
            "erDiagram\n  USER ||--o{ ORDER : places",
            plan2.mermaidFallbackSource,
        )
        assertTrue(
            "两 turn Mermaid fallback 源码必须独立——不能 silent 串台",
            plan1.mermaidFallbackSource != plan2.mermaidFallbackSource,
        )
    }
}
