package com.tabtin.mobile.features.doc.model

import com.tabtin.mobile.features.doc.editor.DocEditorOrchestrator
import com.tabtin.mobile.features.doc.editor.core.BlockViewConverter
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 移动端统一能力契约：Android 侧文档夹具测试。
 *
 * 夹具真源：`tests/mobile-contract/fixtures/doc/rich-mixed.pm.json`
 * （`app/src/test/resources/mobile-contract/` 是只读拷贝，由
 * `scripts/check-mobile-contract-fixtures.sh` 校验漂移）。
 *
 * 覆盖云文档原生编辑的无损总门禁：
 * 1. 每个顶层块的当前处置与显式 gap 清单精确一致；
 * 2. 所有声明可编辑的正文、分割线与简单表格都有真实模型修改，兄弟块零改写；
 * 3. 上下标 / 行内公式经过 UI mark 往返仍保留节点身份、原正文键与附加属性；
 * 4. 未知 mark、嵌入块、未知节点和复杂表格继续走局部只读 raw 保留路径。
 */
class NativeDocContractFixtureTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun loadFixtureDoc(): JsonObject {
        val text = requireNotNull(
            javaClass.classLoader?.getResourceAsStream("mobile-contract/doc/rich-mixed.pm.json"),
        ) { "缺少 mobile-contract/doc/rich-mixed.pm.json（tests/mobile-contract 的只读拷贝）" }
            .bufferedReader().use { it.readText() }
        return json.parseToJsonElement(text).jsonObject.getValue("doc").jsonObject
    }

    private fun loadExpectations(): JsonObject {
        val text = requireNotNull(
            javaClass.classLoader?.getResourceAsStream(
                "mobile-contract/doc/rich-mixed.expectations.json",
            ),
        ) { "缺少 mobile-contract/doc/rich-mixed.expectations.json（tests/mobile-contract 的只读拷贝）" }
            .bufferedReader().use { it.readText() }
        return json.parseToJsonElement(text).jsonObject
    }

    @Test
    fun `fixture expectations pin every top level block and current Android disposition`() {
        val doc = loadFixtureDoc()
        val sourceNodes = doc.getValue("content").jsonArray.filterIsInstance<JsonObject>()
        val contract = loadExpectations()
        val expectedBlocks = contract.getValue("blocks").jsonArray.filterIsInstance<JsonObject>()
        val expectedTableCells = contract.getValue("tableCells")
            .jsonArray.filterIsInstance<JsonObject>()
        val expectedMarkCases = contract.getValue("markCases")
            .jsonArray.filterIsInstance<JsonObject>()

        assertEquals("每个顶层块必须有且只有一条期望", sourceNodes.size, expectedBlocks.size)
        assertEquals(
            "期望路径必须唯一",
            expectedBlocks.size,
            expectedBlocks.map { it.string("path") }.toSet().size,
        )

        expectedBlocks.forEachIndexed { index, expectation ->
            val path = "/content/$index"
            val source = sourceNodes[index]
            assertEquals("期望路径连续：index=$index", path, expectation.string("path"))
            assertEquals("节点类型与期望一致：$path", source.string("type"), expectation.string("type"))
            assertEquals(
                "blockId 与期望一致：$path",
                (source["attrs"] as? JsonObject)?.get("blockId")?.jsonPrimitive?.contentOrNull,
                expectation["blockId"]?.jsonPrimitive?.contentOrNull,
            )

            val declaredCurrent = expectation.getValue("currentDisposition")
                .jsonObject.string("android")
            val actual = currentDisposition(source)
            assertEquals("Android 当前处置发生漂移：$path", declaredCurrent, actual)

            if (actual != "editable") {
                val serialized = ProseMirrorParser.serializeBlocks(
                    ProseMirrorParser.parseBlocks(singletonDoc(source)),
                ).getValue("content").jsonArray.single()
                assertEquals("只读或摘要块必须原样写回：$path", source, serialized)
            }
        }

        expectedTableCells.forEach { expectation ->
            val path = expectation.string("path")
            val (blockIndex, rowIndex, cellIndex) = tableCellIndices(path)
            val tableBlock = ProseMirrorParser.parseBlocks(singletonDoc(sourceNodes[blockIndex]))
                .single()
            val table = requireNotNull(tableBlock.tableData) { "表格投影缺失：$path" }
            val cell = table.rows[rowIndex].cells[cellIndex]
            val actual = if (cell.isReadOnlyProjection) "readonly_preserve" else "editable"
            val declaredCurrent = expectation.getValue("currentDisposition")
                .jsonObject.string("android")
            assertEquals("Android 表格格子当前处置发生漂移：$path", declaredCurrent, actual)
        }

        val releaseGate = contract.getValue("releaseGate").jsonObject
        assertEquals(
            "契约必须保留双端处置一致的发版门禁",
            true,
            releaseGate["requireDispositionParity"]?.jsonPrimitive?.booleanOrNull,
        )
        assertEquals(
            "契约必须保留 knownGaps 清零的发版门禁",
            true,
            releaseGate["requireKnownGapsEmpty"]?.jsonPrimitive?.booleanOrNull,
        )

        val declaredGapEntries = contract.getValue("knownGaps").jsonObject
            .getValue("android").jsonArray
            .filterIsInstance<JsonObject>()
            .onEach { gap ->
                assertEquals("gap 必须归属 ", 10459, gap["issue"]?.jsonPrimitive?.intOrNull)
                assertEquals("gap 必须归属批次 4", 4, gap["batch"]?.jsonPrimitive?.intOrNull)
                assertTrue("gap 必须写明原因", gap.string("reason").isNotBlank())
                assertTrue(
                    "gap aspect 只能是 disposition 或 presentation",
                    gap.string("aspect") in setOf("disposition", "presentation"),
                )
            }
        val declaredGapKeys = declaredGapEntries
            .map { "${it.string("path")}#${it.string("aspect")}" }
            .toSet()
        assertEquals("gap 的 path#aspect 必须唯一", declaredGapEntries.size, declaredGapKeys.size)
        val declaredGapPaths = declaredGapEntries.map { it.string("path") }.toSet()
        val contractSurfacePaths = (
            expectedBlocks.map { it.string("path") } +
                expectedTableCells.map { it.string("path") } +
                expectedMarkCases.map { it.string("path") }
            ).toSet()
        assertTrue(
            "gap 路径必须指向已登记的块",
            declaredGapPaths.all(contractSurfacePaths::contains),
        )
        val structuredSurfaceGapKeys = (expectedBlocks + expectedMarkCases).flatMap { expectation ->
            val path = expectation.string("path")
            val currentDisposition = expectation.getValue("currentDisposition")
                .jsonObject.string("android")
            buildList {
                if (expectation.string("disposition") != currentDisposition) {
                    add("$path#disposition")
                }
                val presentation = expectation["presentation"] as? JsonObject
                val targetPresentation = presentation?.string("target").orEmpty()
                val currentPresentation = (presentation?.get("current") as? JsonObject)
                    ?.string("android")
                    .orEmpty()
                if (
                    targetPresentation.isNotEmpty() &&
                    currentPresentation != targetPresentation
                ) {
                    add("$path#presentation")
                }
            }
        }
        val cellGapKeys = expectedTableCells.mapNotNull { expectation ->
            val path = expectation.string("path")
            val currentDisposition = expectation.getValue("currentDisposition")
                .jsonObject.string("android")
            if (expectation.string("disposition") == currentDisposition) null
            else "$path#disposition"
        }
        val actualGapKeys = (structuredSurfaceGapKeys + cellGapKeys).toSet()
        assertEquals(
            "Android gap 必须与 disposition/presentation 的当前事实精确相等，不能多报或漏报",
            actualGapKeys,
            declaredGapKeys,
        )

        val allDispositionSurfaces = expectedBlocks + expectedTableCells + expectedMarkCases
        val hasDispositionMismatch = allDispositionSurfaces.any { expectation ->
            val current = expectation.getValue("currentDisposition").jsonObject
            current.string("ios") != current.string("android")
        }
        val hasKnownGaps = contract.getValue("knownGaps").jsonObject.values.any { gaps ->
            (gaps as? JsonArray)?.isNotEmpty() == true
        }
        val hasUnresolvedTargetGaps = allDispositionSurfaces.any { expectation ->
            val current = expectation.getValue("currentDisposition").jsonObject
            val disposition = expectation.string("disposition")
            val presentation = expectation["presentation"] as? JsonObject
            val currentPresentation = presentation?.get("current") as? JsonObject
            val targetPresentation = presentation?.string("target")
            val currentIosPresentation = currentPresentation?.string("ios")
            val currentAndroidPresentation = currentPresentation?.string("android")
            disposition != current.string("ios") ||
                disposition != current.string("android") ||
                (
                    presentation != null &&
                        (
                            targetPresentation != currentIosPresentation ||
                                targetPresentation != currentAndroidPresentation
                            )
                    )
        }
        val derivedReadiness = if (
            !hasDispositionMismatch && !hasKnownGaps && !hasUnresolvedTargetGaps
        ) {
            "ready"
        } else {
            "blocked"
        }
        assertEquals(
            "开发态测试必须明确呈现发版阻断，不能把带 gap 的全绿误报为可发布",
            derivedReadiness,
            releaseGate.string("releaseReadiness"),
        )
    }

    @Test
    fun `mark cases drive Android production parser and exact serialization`() {
        val cases = loadExpectations().getValue("markCases")
            .jsonArray.filterIsInstance<JsonObject>()

        assertEquals("共享契约必须独立覆盖八类行内能力", 8, cases.size)

        cases.forEach { expectation ->
            val path = expectation.string("path")
            val fixture = expectation.getValue("fixture").jsonObject
            val declaredCurrent = expectation.getValue("currentDisposition")
                .jsonObject.string("android")
            val actual = currentDisposition(fixture)
            assertEquals("Android 行内能力处置发生漂移：$path", declaredCurrent, actual)

            val block = ProseMirrorParser.parseBlocks(singletonDoc(fixture)).single()
            val presentation = expectation["presentation"] as? JsonObject
            val declaredPresentation = (presentation?.get("current") as? JsonObject)
                ?.string("android")
            if (declaredPresentation == "formula_rendered") {
                val body = block.spans.plainText()
                val uiMarks = BlockViewConverter.spansToMarks(body, block.spans)
                val mathMarks = uiMarks.filterIsInstance<
                    com.tabtin.mobile.features.doc.editor.core.TabDocMarkup.Mark.Mathematics
                    >()
                assertTrue("formula_rendered 必须由真实 UI 模型携带公式身份：$path", mathMarks.isNotEmpty())
            }
            if (actual == "editable") {
                assertTrue("声明可编辑的行内 case 必须进入真实正文模型：$path", block.canEditInline)
                val suffix = " 契约行内编辑"
                val originalBody = block.spans.plainText()
                val uiMarks = BlockViewConverter.spansToMarks(originalBody, block.spans)
                val edited = block.copy(
                    spans = BlockViewConverter.marksToSpans(originalBody + suffix, uiMarks),
                )
                val serialized = ProseMirrorParser.serializeBlocks(listOf(edited))
                    .getValue("content").jsonArray.single()
                assertEquals(
                    "可编辑行内 case 只能改变目标正文，mark 类型、属性与公式节点必须原样保留：$path",
                    appendToRightmostTextNode(fixture, suffix),
                    serialized,
                )
            } else {
                assertFalse("声明只读的行内 case 不得进入正文编辑模型：$path", block.canEditInline)
                val serialized = ProseMirrorParser.serializeBlocks(listOf(block))
                    .getValue("content").jsonArray.single()
                assertEquals("只读行内 case 必须 raw 原样写回：$path", fixture, serialized)
            }
        }
    }

    /**
     * 列表容器会被拍平成多个原生块，顶层节点与块不再一一对应。逐个节点单独解析求出
     * 各自占用的块范围，契约驱动才能定位到正确的块。
     */
    private fun blockRangesByTopLevelIndex(sourceNodes: List<JsonObject>): List<IntRange> {
        var cursor = 0
        return sourceNodes.map { node ->
            val size = ProseMirrorParser.parseBlocks(singletonDoc(node)).size
            (cursor until cursor + size).also { cursor += size }
        }
    }

    @Test
    fun `editing every declared Android editable fixture surface preserves attributes and siblings`() {
        val doc = loadFixtureDoc()
        val originalContent = doc.getValue("content").jsonArray
        val contract = loadExpectations()
        val expectedBlocks = contract.getValue("blocks").jsonArray.filterIsInstance<JsonObject>()
        val editableIndices = expectedBlocks.indices.filter { index ->
            expectedBlocks[index].getValue("currentDisposition")
                .jsonObject.string("android") == "editable"
        }

        assertTrue("夹具至少需要一个可驱动的 Android 可编辑块", editableIndices.isNotEmpty())

        val blockRanges = blockRangesByTopLevelIndex(originalContent.filterIsInstance<JsonObject>())

        editableIndices.forEach { editedIndex ->
            val blocks = ProseMirrorParser.parseBlocks(doc).toMutableList()
            assertEquals(
                "夹具顶层节点解析出的块范围必须覆盖整篇",
                blockRanges.last().last + 1,
                blocks.size,
            )
            // 拍平后的最后一个块对应节点里最右侧的文本节点，与 appendToRightmostTextNode 一致。
            val targetIndex = blockRanges[editedIndex].last
            val target = blocks[targetIndex]
            val sourceTarget = originalContent[editedIndex].jsonObject
            var expectedTarget: JsonObject? = null
            val removed = when {
                target.canEditInline -> {
                    val suffix = " 契约编辑$editedIndex"
                    val originalBody = target.spans.plainText()
                    val uiMarks = BlockViewConverter.spansToMarks(originalBody, target.spans)
                    blocks[targetIndex] = target.copy(
                        spans = BlockViewConverter.marksToSpans(originalBody + suffix, uiMarks),
                    )
                    expectedTarget = appendToRightmostTextNode(sourceTarget, suffix)
                    false
                }
                target.kind == BlockKind.TABLE -> {
                    val table = requireNotNull(target.tableData) { "可编辑表格缺少 TableData" }
                    val rowIndex = table.rows.indexOfFirst { row ->
                        row.cells.any { !it.isReadOnlyProjection }
                    }
                    assertTrue("可编辑表格必须至少有一个可编辑单元格", rowIndex >= 0)
                    val row = table.rows[rowIndex]
                    val cellIndex = row.cells.indexOfFirst { !it.isReadOnlyProjection }
                    val cell = row.cells[cellIndex]
                    val editedText = "${cell.text} 契约编辑$editedIndex"
                    val editedCell = cell.copy(
                        text = editedText,
                        spans = listOf(InlineSpan(editedText)),
                    )
                    val editedRow = row.copy(
                        cells = row.cells.toMutableList().also { it[cellIndex] = editedCell },
                    )
                    val editedTable = table.copy(
                        rows = table.rows.toMutableList().also { it[rowIndex] = editedRow },
                    )
                    blocks[targetIndex] = target.copy(tableData = editedTable)
                    expectedTarget = appendToTableCellText(
                        sourceTarget,
                        rowIndex,
                        cellIndex,
                        " 契约编辑$editedIndex",
                    )
                    false
                }
                target.kind == BlockKind.IMAGE && target.canDeleteWholeBlock -> {
                    blocks.removeAt(targetIndex)
                    true
                }
                target.kind == BlockKind.DIVIDER -> {
                    blocks.removeAt(targetIndex)
                    true
                }
                else -> error(
                    "currentDisposition.android=editable 的 ${target.kind} 没有契约驱动；" +
                        "必须先增加真实修改路径，禁止静默跳过",
                )
            }
            val serializedContent = ProseMirrorParser.serializeBlocks(blocks)
                .getValue("content").jsonArray

            assertEquals(
                "编辑后顶层块数量必须符合修改类型",
                originalContent.size - if (removed) 1 else 0,
                serializedContent.size,
            )
            for (index in originalContent.indices) {
                if (index == editedIndex) continue
                val serializedIndex = if (removed && index > editedIndex) index - 1 else index
                assertEquals(
                    "编辑 index=$editedIndex 不得改写兄弟顶层 JSON：index=$index",
                    originalContent[index],
                    serializedContent[serializedIndex],
                )
            }
            if (!removed) {
                assertEquals(
                    "编辑 index=$editedIndex 只能改变被驱动的目标叶子；" +
                        "目标块内其它文字、节点类型、marks/mark attrs 与容器 attrs 必须逐项不变",
                    requireNotNull(expectedTarget),
                    serializedContent[editedIndex],
                )
            }
        }
    }

    @Test
    fun `table cell contract drives editable and raw preserving production serialization`() {
        val doc = loadFixtureDoc()
        val originalContent = doc.getValue("content").jsonArray
        val expectedTableCells = loadExpectations().getValue("tableCells")
            .jsonArray.filterIsInstance<JsonObject>()
        val exercisedKinds = mutableSetOf<TableCellFixtureKind>()
        val blockRanges = blockRangesByTopLevelIndex(originalContent.filterIsInstance<JsonObject>())

        assertTrue("夹具必须登记表格格子契约", expectedTableCells.isNotEmpty())

        expectedTableCells.forEach { expectation ->
            val path = expectation.string("path")
            val (blockIndex, rowIndex, cellIndex) = tableCellIndices(path)
            val sourceTable = originalContent[blockIndex].jsonObject
            val sourceCell = sourceTable.tableCell(rowIndex, cellIndex)
            val fixtureKind = sourceCell.fixtureKind()
            exercisedKinds.add(fixtureKind)

            val blocks = ProseMirrorParser.parseBlocks(doc).toMutableList()
            val tableBlockIndex = blockRanges[blockIndex].first
            val tableBlock = blocks[tableBlockIndex]
            val table = requireNotNull(tableBlock.tableData) { "表格投影缺失：$path" }
            val cell = table.rows[rowIndex].cells[cellIndex]
            val declaredCurrent = expectation.getValue("currentDisposition")
                .jsonObject.string("android")

            when (fixtureKind) {
                TableCellFixtureKind.PLAIN,
                TableCellFixtureKind.HARD_BREAK -> {
                    assertEquals("纯文本/换行格必须声明可编辑：$path", "editable", declaredCurrent)
                    assertFalse("纯文本/换行格必须进入生产编辑模型：$path", cell.isReadOnlyProjection)

                    val suffix = " 契约格编辑"
                    val editedSpans = cell.spans.toMutableList().also { spans ->
                        val lastTextIndex = spans.indexOfLast { it.text.isNotEmpty() && it.text != "\n" }
                        require(lastTextIndex >= 0) { "可编辑格缺少文本 span：$path" }
                        spans[lastTextIndex] = spans[lastTextIndex].copy(
                            text = spans[lastTextIndex].text + suffix,
                        )
                    }
                    val editedCell = cell.copy(
                        text = editedSpans.plainText(),
                        spans = editedSpans,
                    )
                    blocks[tableBlockIndex] = tableBlock.replacingTableCell(
                        rowIndex,
                        cellIndex,
                        editedCell,
                    )

                    val serializedContent = ProseMirrorParser.serializeBlocks(blocks)
                        .getValue("content").jsonArray
                    val expectedTable = appendToTableCellText(
                        sourceTable,
                        rowIndex,
                        cellIndex,
                        suffix,
                    )
                    assertEquals(
                        "编辑格子只能改写目标 text；表格 attrs、行列结构及其它格子必须深度相等：$path",
                        expectedTable,
                        serializedContent[blockIndex],
                    )
                    assertTopLevelSiblingsEqual(
                        originalContent = originalContent,
                        serializedContent = serializedContent,
                        editedIndex = blockIndex,
                        message = "编辑表格格子不得改写顶层兄弟：$path",
                    )

                    if (fixtureKind == TableCellFixtureKind.HARD_BREAK) {
                        val serializedCell = serializedContent[blockIndex].jsonObject
                            .tableCell(rowIndex, cellIndex)
                        val inlineNodes = serializedCell.tableCellInlines()
                        assertEquals(
                            "换行格编辑后必须仍是 text / hardBreak / text：$path",
                            listOf("text", "hardBreak", "text"),
                            inlineNodes.map { it.string("type") },
                        )
                        assertEquals("第一段正文必须保留：$path", "第一行", inlineNodes[0].string("text"))
                        assertEquals(
                            "第二段正文只追加本次编辑：$path",
                            "第二行$suffix",
                            inlineNodes[2].string("text"),
                        )
                    }
                }

                TableCellFixtureKind.MARKED -> {
                    assertEquals("带格式格必须声明可编辑：$path", "editable", declaredCurrent)
                    assertFalse("带格式格必须进入生产编辑模型：$path", cell.isReadOnlyProjection)

                    val suffix = " 契约格编辑"
                    val editedSpans = cell.spans.toMutableList().also { spans ->
                        val lastTextIndex = spans.indexOfLast { it.text.isNotEmpty() && it.text != "\n" }
                        require(lastTextIndex >= 0) { "可编辑格缺少文本 span：$path" }
                        spans[lastTextIndex] = spans[lastTextIndex].copy(
                            text = spans[lastTextIndex].text + suffix,
                        )
                    }
                    val editedCell = cell.copy(
                        text = editedSpans.plainText(),
                        spans = editedSpans,
                    )
                    blocks[tableBlockIndex] = tableBlock.replacingTableCell(
                        rowIndex,
                        cellIndex,
                        editedCell,
                    )

                    val serializedContent = ProseMirrorParser.serializeBlocks(blocks)
                        .getValue("content").jsonArray
                    val expectedTable = appendToTableCellText(
                        sourceTable,
                        rowIndex,
                        cellIndex,
                        suffix,
                    )
                    assertEquals(
                        "编辑带格式格只能追加目标 text；marks 与表格结构必须深度相等：$path",
                        expectedTable,
                        serializedContent[blockIndex],
                    )
                    val serializedCell = serializedContent[blockIndex].jsonObject
                        .tableCell(rowIndex, cellIndex)
                    val inlineNodes = serializedCell.tableCellInlines()
                    assertEquals("带格式格编辑后必须仍是单个 text：$path", 1, inlineNodes.size)
                    assertEquals("加粗正文只追加本次编辑：$path", "加粗备注$suffix", inlineNodes[0].string("text"))
                    assertEquals(
                        "加粗 mark 必须原样保留：$path",
                        json.parseToJsonElement("""[{"type":"bold"}]"""),
                        inlineNodes[0]["marks"],
                    )
                    assertTopLevelSiblingsEqual(
                        originalContent = originalContent,
                        serializedContent = serializedContent,
                        editedIndex = blockIndex,
                        message = "编辑带格式格不得改写顶层兄弟：$path",
                    )
                }
            }
        }

        assertEquals(
            "共享表格格子契约必须同时覆盖纯文本、hardBreak 与 marks",
            TableCellFixtureKind.values().toSet(),
            exercisedKinds,
        )
    }

    @Test
    fun `editing inline mathematics updates latex without dropping atom defaults`() {
        val doc = loadFixtureDoc()
        val block = ProseMirrorParser.parseBlocks(doc)[7]
        assertTrue("公式段落必须仍可编辑", block.canEditInline)

        val editedSpans = block.spans.map { span ->
            if (span.marks.any { it is InlineMark.Mathematics }) {
                span.copy(text = "E = m c^2")
            } else {
                span
            }
        }
        val serialized = ProseMirrorParser.serializeBlocks(
            listOf(block.copy(spans = editedSpans)),
        )
        val mathematics = serialized.getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray
            .filterIsInstance<JsonObject>()
            .single { it.string("type") == "mathematics" }

        assertEquals(
            "编辑后的 latex 必须覆盖来源值，同时保留 display=false",
            json.parseToJsonElement("""{"latex":"E = m c^2","display":false}"""),
            mathematics.getValue("attrs"),
        )
    }

    // ── 夹具级：原始节点保留 ────────────────────────────────────────

    @Test
    fun `fixture raw-preserved blocks round trip byte identical`() {
        val doc = loadFixtureDoc()
        val originalContent = doc.getValue("content").jsonArray
        val serialized = ProseMirrorParser.serializeBlocks(ProseMirrorParser.parseBlocks(doc))
        val serializedContent = serialized.getValue("content").jsonArray

        assertEquals("序列化后顶层块数量不变", originalContent.size, serializedContent.size)

        // 这些节点走 rawNode 保留路径，必须逐字节等价（深度相等）。
        val rawPreservedTypes = setOf(
            "mathematicsBlock", "tabdataBlock", "tabwhiteboard", "htmlBlock",
            "youtube", "futureChart", "table",
        )
        originalContent.forEachIndexed { index, element ->
            val node = element as JsonObject
            val type = node.getValue("type").jsonPrimitive.content
            if (type in rawPreservedTypes) {
                assertEquals(
                    "rawNode 保留节点逐字节等价：index=$index type=$type",
                    node, serializedContent[index],
                )
            }
        }
    }

    @Test
    fun `fixture canonical standalone image supports exact deletion while content stays readonly`() {
        val sourceNodes = loadFixtureDoc().getValue("content").jsonArray
            .filterIsInstance<JsonObject>()
        val readonlySibling = sourceNodes[23]
        val imageSource = sourceNodes[24]
        val blocks = ProseMirrorParser.parseBlocks(buildJsonDoc(readonlySibling, imageSource))
        val image = blocks.single { it.blockId == "blk-p-0047" }

        assertEquals(BlockKind.IMAGE, image.kind)
        assertFalse("已有图片内容仍不可替换或编辑", image.editable)
        assertTrue("正典独立图片必须支持整块删除", image.canDeleteWholeBlock)

        val afterDelete = DocEditorOrchestrator.deleteBlock(blocks, image.id)

        assertEquals(
            "整块删除只能移除图片引用，兄弟 raw 子树必须逐字节保留",
            buildJsonDoc(readonlySibling),
            ProseMirrorParser.serializeBlocks(afterDelete),
        )
    }

    /**
     * 本次解锁的核心断言：编辑混排段落的文字后保存，行内图片节点必须逐字段回到 JSON。
     * 走的是生产 UI 往返（spans → TabDocMarkup.Mark → spans），不是模型层直通。
     */
    @Test
    fun `editing mixed inline image paragraph keeps every image attribute byte identical`() {
        val doc = loadFixtureDoc()
        val originalContent = doc.getValue("content").jsonArray
        val sourceParagraph = originalContent[15].jsonObject
        val sourceImage = sourceParagraph.getValue("content").jsonArray
            .filterIsInstance<JsonObject>()
            .single { it.string("type") == "image" }

        val blockRanges = blockRangesByTopLevelIndex(originalContent.filterIsInstance<JsonObject>())
        val targetIndex = blockRanges[15].single()
        val blocks = ProseMirrorParser.parseBlocks(doc).toMutableList()
        val target = blocks[targetIndex]
        assertEquals("混排图文段落必须投影成可编辑段落", BlockKind.PARAGRAPH, target.kind)
        assertTrue("混排图文段落必须进入真实正文编辑模型", target.canEditInline)

        val suffix = "（本轮编辑）"
        val body = target.spans.plainText()
        val uiMarks = BlockViewConverter.spansToMarks(body, target.spans)
        assertTrue(
            "UI 模型必须携带行内图片身份，否则编辑后无法还原",
            uiMarks.any { it is com.tabtin.mobile.features.doc.editor.core.TabDocMarkup.Mark.InlineImage },
        )
        blocks[targetIndex] = target.copy(
            spans = BlockViewConverter.marksToSpans(body + suffix, uiMarks),
        )

        val serializedContent = ProseMirrorParser.serializeBlocks(blocks)
            .getValue("content").jsonArray
        assertEquals(
            "编辑混排段落只能改写目标文字，图片与 hardBreak 必须逐字段深度相等",
            appendToRightmostTextNode(sourceParagraph, suffix),
            serializedContent[15],
        )
        assertTopLevelSiblingsEqual(
            originalContent = originalContent,
            serializedContent = serializedContent,
            editedIndex = 15,
            message = "编辑混排图文段落不得改写顶层兄弟",
        )

        val serializedInlines = serializedContent[15].jsonObject
            .getValue("content").jsonArray.filterIsInstance<JsonObject>()
        assertEquals(
            "混排结构必须仍是 文字 / 图片 / hardBreak / 文字",
            listOf("text", "image", "hardBreak", "text"),
            serializedInlines.map { it.string("type") },
        )
        val serializedImage = serializedInlines.single { it.string("type") == "image" }
        assertEquals("图片节点必须原样写回", sourceImage, serializedImage)
        val attrs = serializedImage.getValue("attrs").jsonObject
        assertEquals("fileId 是稳定引用，不得被改写", "file-demo-0001", attrs.string("fileId"))
        assertEquals("alt 必须保留", "示例图片", attrs.string("alt"))
        assertEquals("title 必须保留", "示例图片标题", attrs.string("title"))
        assertEquals("width 必须保留", 640, attrs["width"]?.jsonPrimitive?.intOrNull)
        assertEquals("height 必须保留", 360, attrs["height"]?.jsonPrimitive?.intOrNull)
        assertEquals(
            "src 只能原样带回来源值，原生端不得重新生成签名地址",
            sourceImage.getValue("attrs").jsonObject["src"],
            attrs["src"],
        )
    }

    /**
     * `src` 是渲染期签名地址。原生端只允许原样带回来源值：来源没有 `src` 时，
     * 保存也不能凭空长出一个 URL。
     */
    @Test
    fun `inline image without source url never gains one through the editing round trip`() {
        val paragraph = buildParagraph(
            textWithMarks("图："),
            json.parseToJsonElement(
                """{"type":"image","attrs":{"fileId":"file-only-id","alt":"仅有 fileId"}}""",
            ).jsonObject,
        )
        val block = ProseMirrorParser.parseBlocks(buildJsonDoc(paragraph)).single()
        assertTrue("仅有 fileId 的行内图片段落必须可编辑", block.canEditInline)

        val body = block.spans.plainText()
        val edited = block.copy(
            spans = BlockViewConverter.marksToSpans(
                body + " 追加",
                BlockViewConverter.spansToMarks(body, block.spans),
            ),
        )
        val serializedImage = ProseMirrorParser.serializeBlocks(listOf(edited))
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray.filterIsInstance<JsonObject>()
            .single { it.string("type") == "image" }

        assertEquals(
            "attrs 必须与来源逐字段相同，不得补出 src",
            json.parseToJsonElement("""{"fileId":"file-only-id","alt":"仅有 fileId"}"""),
            serializedImage.getValue("attrs"),
        )
    }

    /** 删掉整段占位等于删除这张图片；其余正文与兄弟节点不受影响。 */
    @Test
    fun `deleting the inline image placeholder removes exactly one image node`() {
        val doc = loadFixtureDoc()
        val blockRanges = blockRangesByTopLevelIndex(
            doc.getValue("content").jsonArray.filterIsInstance<JsonObject>(),
        )
        val targetIndex = blockRanges[15].single()
        val blocks = ProseMirrorParser.parseBlocks(doc).toMutableList()
        val target = blocks[targetIndex]
        val remainingSpans = target.spans.filterNot { span ->
            span.marks.any { it is InlineMark.InlineImage }
        }
        blocks[targetIndex] = target.copy(spans = remainingSpans)

        val serializedInlines = ProseMirrorParser.serializeBlocks(blocks)
            .getValue("content").jsonArray[15].jsonObject
            .getValue("content").jsonArray.filterIsInstance<JsonObject>()

        assertEquals(
            "删除占位后只剩文字与 hardBreak",
            listOf("text", "hardBreak", "text"),
            serializedInlines.map { it.string("type") },
        )
    }

    /** 诚实占位是产品可见表面，必须只暴露 alt/title，不得泄露签名 URL 或 fileId。 */
    @Test
    fun `inline image placeholder shows alt text without leaking src or fileId`() {
        val doc = loadFixtureDoc()
        val blockRanges = blockRangesByTopLevelIndex(
            doc.getValue("content").jsonArray.filterIsInstance<JsonObject>(),
        )
        val block = ProseMirrorParser.parseBlocks(doc)[blockRanges[15].single()]
        val body = block.spans.plainText()

        assertTrue("占位必须显示 alt 文案：$body", body.contains("🖼 示例图片"))
        assertFalse("占位不得泄露签名 URL：$body", body.contains("oss.example.com"))
        assertFalse("占位不得泄露 fileId：$body", body.contains("file-demo-0001"))
        assertFalse("占位不得暴露实现类型名：$body", body.contains("image"))
    }

    @Test
    fun `fixture unknown mark is preserved verbatim through parse and serialize`() {
        val doc = loadFixtureDoc()
        val blocks = ProseMirrorParser.parseBlocks(doc)
        val serialized = ProseMirrorParser.serializeBlocks(blocks)

        val futureMark = serialized.getValue("content").jsonArray
            .filterIsInstance<JsonObject>()
            .flatMap { node -> (node["content"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty() }
            .flatMap { inline -> (inline["marks"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty() }
            .firstOrNull { it["type"]?.jsonPrimitive?.contentOrNull == "futureMark" }

        assertNotNull("futureMark 不得被静默丢弃", futureMark)
        assertEquals(
            "futureMark 的 attrs 原样写回",
            json.parseToJsonElement("""{"weight":9,"source":"ai"}"""),
            futureMark!!.getValue("attrs"),
        )
    }

    @Test
    fun `fixture sub sup and inline math survive full pipeline`() {
        val doc = loadFixtureDoc()
        val blocks = ProseMirrorParser.parseBlocks(doc)

        val mathParagraph = blocks.first { block ->
            block.spans.any { span -> span.marks.any { it is InlineMark.Mathematics } }
        }
        val flatMarks = mathParagraph.spans.flatMap { it.marks }
        assertTrue("解析保留下标", flatMarks.any { it is InlineMark.Subscript })
        assertTrue("解析保留上标", flatMarks.any { it is InlineMark.Superscript })

        // UI 往返：spans → marks → spans → 序列化
        val body = mathParagraph.spans.plainText()
        val uiMarks = BlockViewConverter.spansToMarks(body, mathParagraph.spans)
        assertTrue(
            "UI 模型不再丢弃下标",
            uiMarks.any { it is com.tabtin.mobile.features.doc.editor.core.TabDocMarkup.Mark.Subscript },
        )
        assertTrue(
            "UI 模型不再丢弃上标",
            uiMarks.any { it is com.tabtin.mobile.features.doc.editor.core.TabDocMarkup.Mark.Superscript },
        )
        assertTrue(
            "UI 模型不再丢弃行内公式",
            uiMarks.any { it is com.tabtin.mobile.features.doc.editor.core.TabDocMarkup.Mark.Mathematics },
        )

        val roundTripped = mathParagraph.copy(spans = BlockViewConverter.marksToSpans(body, uiMarks))
        val serialized = ProseMirrorParser.serializeBlocks(listOf(roundTripped))
        val paragraph = serialized.getValue("content").jsonArray.single() as JsonObject
        val inlines = paragraph.getValue("content").jsonArray.filterIsInstance<JsonObject>()

        val markTypes = inlines
            .flatMap { (it["marks"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty() }
            .mapNotNull { it["type"]?.jsonPrimitive?.contentOrNull }
        assertTrue("编辑写回后下标仍在", markTypes.contains("subscript"))
        assertTrue("编辑写回后上标仍在", markTypes.contains("superscript"))

        val mathNodes = inlines.filter { it["type"]?.jsonPrimitive?.contentOrNull == "mathematics" }
        assertEquals("编辑写回后行内公式 latex 不变", 1, mathNodes.size)
        assertEquals(
            "E = mc^2",
            mathNodes.single()["attrs"]?.jsonObject?.get("latex")?.jsonPrimitive?.contentOrNull,
        )
    }

    // ── 单元级：精确结构 ────────────────────────────────────────────

    @Test
    fun `sub sup and math serialize back to canonical inline nodes`() {
        val paragraph = buildParagraph(
            textWithMarks("H"),
            textWithMarks("2", """[{"type":"subscript"}]"""),
            textWithMarks("O "),
            json.parseToJsonElement(
                """{"type":"mathematics","attrs":{"latex":"E = mc^2","display":false}}""",
            ).jsonObject,
        )
        val doc = buildJsonDoc(paragraph)

        val serialized = ProseMirrorParser.serializeBlocks(ProseMirrorParser.parseBlocks(doc))
        val inlines = (serialized.getValue("content").jsonArray.single() as JsonObject)
            .getValue("content").jsonArray.filterIsInstance<JsonObject>()

        val sub = inlines.firstNotNullOfOrNull { inline ->
            (inline["marks"] as? JsonArray)?.filterIsInstance<JsonObject>()
                ?.firstOrNull { it["type"]?.jsonPrimitive?.contentOrNull == "subscript" }
        }
        assertNotNull("下标写回", sub)
        assertEquals("E = mc^2", inlines.first {
            it["type"]?.jsonPrimitive?.contentOrNull == "mathematics"
        }["attrs"]?.jsonObject?.get("latex")?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun `unknown mark paragraph stays editable and keeps raw attrs after adjacent edit`() {
        val paragraph = buildParagraph(
            textWithMarks("普通"),
            textWithMarks("带未知标记", """[{"type":"futureMark","attrs":{"weight":9}}]"""),
        )
        val doc = buildJsonDoc(paragraph)
        val block = ProseMirrorParser.parseBlocks(doc).single()

        assertEquals(BlockKind.PARAGRAPH, block.kind)
        assertTrue("可重建的未知 mark 范围必须进入可编辑段落", block.editable)
        val body = block.spans.plainText()
        val uiMarks = BlockViewConverter.spansToMarks(body, block.spans)
        val edited = block.copy(spans = BlockViewConverter.marksToSpans(body + "旁", uiMarks))
        val serialized = ProseMirrorParser.serializeBlocks(listOf(edited))
            .getValue("content").jsonArray.single().jsonObject
        val inlines = serialized.getValue("content").jsonArray.filterIsInstance<JsonObject>()
        val futureMark = inlines
            .flatMap { (it["marks"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty() }
            .firstOrNull { it["type"]?.jsonPrimitive?.contentOrNull == "futureMark" }
        assertNotNull("相邻文字编辑后 futureMark 仍在", futureMark)
        assertEquals(
            json.parseToJsonElement("""{"weight":9}"""),
            futureMark!!.getValue("attrs"),
        )
        assertEquals("普通带未知标记旁", inlines.joinToString("") { it.string("text") })
    }

    @Test
    fun `adjacent math atoms are not merged in ui model`() {
        val paragraph = buildParagraph(
            json.parseToJsonElement("""{"type":"mathematics","attrs":{"latex":"a"}}""").jsonObject,
            json.parseToJsonElement("""{"type":"mathematics","attrs":{"latex":"b"}}""").jsonObject,
        )
        val block = ProseMirrorParser.parseBlocks(buildJsonDoc(paragraph)).single()
        val body = block.spans.plainText()
        val uiMarks = BlockViewConverter.spansToMarks(body, block.spans)
        val mathMarks = uiMarks
            .filterIsInstance<com.tabtin.mobile.features.doc.editor.core.TabDocMarkup.Mark.Mathematics>()
        assertEquals("相邻公式原子不得合并", 2, mathMarks.size)

        val serialized = ProseMirrorParser.serializeBlocks(
            listOf(block.copy(spans = BlockViewConverter.marksToSpans(body, uiMarks))),
        )
        val mathNodes = (serialized.getValue("content").jsonArray.single() as JsonObject)
            .getValue("content").jsonArray.filterIsInstance<JsonObject>()
            .filter { it["type"]?.jsonPrimitive?.contentOrNull == "mathematics" }
        assertEquals(2, mathNodes.size)
        assertEquals("a", mathNodes[0]["attrs"]?.jsonObject?.get("latex")?.jsonPrimitive?.contentOrNull)
        assertEquals("b", mathNodes[1]["attrs"]?.jsonObject?.get("latex")?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun `math atom semantics follow spans through delete split merge and duplicate`() {
        val paragraph = buildParagraph(
            textWithMarks("A"),
            json.parseToJsonElement(
                """{"type":"math_inline","attrs":{"latex":"first","display":false,"source":"one"}}""",
            ).jsonObject,
            textWithMarks("|"),
            json.parseToJsonElement(
                """{"type":"mathematics","attrs":{"text":"second","display":true,"source":"two"}}""",
            ).jsonObject,
            textWithMarks("Z"),
        )
        // 直接驱动行内解析器，覆盖 nodeType、latex/text 与其余 attrs 到 mark 的归一化；
        // 顶层安全策略是否允许这些扩展属性编辑属于另一层契约。
        val parsed = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = ProseMirrorParser.extractInlineSpans(paragraph),
        )

        // 先走真实 UI mark 往返，证明两个公式的类型与属性跟随各自范围，而非块内序号。
        val body = parsed.spans.plainText()
        val uiRoundTripped = parsed.copy(
            spans = BlockViewConverter.marksToSpans(
                body,
                BlockViewConverter.spansToMarks(body, parsed.spans),
            ),
        )
        val initialMath = serializedMathNodes(listOf(uiRoundTripped))
        assertEquals(listOf("math_inline", "mathematics"), initialMath.map { it.string("type") })
        assertEquals(false, initialMath[0].jsonObjectAttrs()["display"]?.jsonPrimitive?.booleanOrNull)
        assertEquals(true, initialMath[1].jsonObjectAttrs()["display"]?.jsonPrimitive?.booleanOrNull)
        assertEquals("second", initialMath[1].jsonObjectAttrs()["text"]?.jsonPrimitive?.contentOrNull)
        assertFalse("text 来源键不得被规范化成 latex", initialMath[1].jsonObjectAttrs().containsKey("latex"))

        // 删除第一个公式并编辑第二个后，不能继承第一个的 display=false / nodeType，
        // 也不能把历史 text 键静默改写成 latex。
        val withoutFirst = uiRoundTripped.copy(
            spans = uiRoundTripped.spans.mapNotNull { span ->
                val mathematics = span.marks.filterIsInstance<InlineMark.Mathematics>().firstOrNull()
                when {
                    mathematics?.nodeType == "math_inline" -> null
                    mathematics?.attrs?.get("source") == "two" -> span.copy(text = "second edited")
                    else -> span
                }
            },
        )
        val afterDeleteMath = serializedMathNodes(listOf(withoutFirst))
        assertEquals(
            "删除第一个公式后只能剩下第二个：${withoutFirst.spans}",
            1,
            afterDeleteMath.size,
        )
        assertSecondFormulaSemantics(afterDeleteMath.single())

        // 在第二个公式之前拆块，再合回；公式语义应跟随 mark 留在第二段。
        val splitAt = withoutFirst.spans.plainText().indexOf("second edited")
        val (splitBlocks, secondBlock) = DocEditorOrchestrator.splitBlock(
            listOf(withoutFirst),
            withoutFirst.id,
            splitAt,
            withoutFirst.spans,
        )
        assertSecondFormulaSemantics(serializedMathNodes(listOf(secondBlock)).single())

        val (mergedBlocks, _, _) = DocEditorOrchestrator.mergeWithPrevious(
            splitBlocks,
            secondBlock.id,
        )
        assertSecondFormulaSemantics(serializedMathNodes(mergedBlocks).single())

        // duplicateBlock 对 spans 做结构复制；公式属性必须随 mark 一起复制。
        val merged = mergedBlocks.single()
        val (_, duplicate) = DocEditorOrchestrator.duplicateBlock(mergedBlocks, merged.id)
        assertNotNull("复制块必须成功", duplicate)
        assertSecondFormulaSemantics(serializedMathNodes(listOf(duplicate!!)).single())
    }

    // ── helpers ─────────────────────────────────────────────────────

    private enum class TableCellFixtureKind {
        PLAIN,
        HARD_BREAK,
        MARKED,
    }

    private fun textWithMarks(text: String, marksJson: String? = null): JsonObject =
        buildJsonObject {
            put("type", "text")
            put("text", text)
            if (marksJson != null) put("marks", json.parseToJsonElement(marksJson))
        }

    private fun buildParagraph(vararg inlines: JsonObject): JsonObject =
        buildJsonObject {
            put("type", "paragraph")
            put("content", buildJsonArray { inlines.forEach { add(it) } })
        }

    private fun buildJsonDoc(vararg nodes: JsonObject): JsonObject =
        buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray { nodes.forEach { add(it) } })
        }

    private fun singletonDoc(node: JsonObject): JsonObject = buildJsonDoc(node)

    private fun DocBlock.replacingTableCell(
        rowIndex: Int,
        cellIndex: Int,
        replacement: TableCell,
    ): DocBlock {
        val table = requireNotNull(tableData) { "目标块不是表格" }
        val row = table.rows[rowIndex]
        val editedRow = row.copy(
            cells = row.cells.toMutableList().also { it[cellIndex] = replacement },
        )
        return copy(
            tableData = table.copy(
                rows = table.rows.toMutableList().also { it[rowIndex] = editedRow },
            ),
        )
    }

    private fun JsonObject.tableCell(rowIndex: Int, cellIndex: Int): JsonObject =
        getValue("content").jsonArray[rowIndex].jsonObject
            .getValue("content").jsonArray[cellIndex].jsonObject

    private fun JsonObject.tableCellInlines(): List<JsonObject> =
        getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray.filterIsInstance<JsonObject>()

    private fun JsonObject.fixtureKind(): TableCellFixtureKind {
        val inlines = tableCellInlines()
        return when {
            inlines.any { inline ->
                (inline["marks"] as? JsonArray)?.isNotEmpty() == true
            } -> TableCellFixtureKind.MARKED
            inlines.any { it.string("type") == "hardBreak" } -> TableCellFixtureKind.HARD_BREAK
            inlines.all { it.string("type") == "text" } -> TableCellFixtureKind.PLAIN
            else -> error("tableCells 登记了尚未建模的夹具形态：$this")
        }
    }

    private fun assertTopLevelSiblingsEqual(
        originalContent: JsonArray,
        serializedContent: JsonArray,
        editedIndex: Int,
        message: String,
    ) {
        assertEquals("$message（顶层数量）", originalContent.size, serializedContent.size)
        originalContent.indices
            .filter { it != editedIndex }
            .forEach { index ->
                assertEquals("$message（index=$index）", originalContent[index], serializedContent[index])
            }
    }

    private fun tableCellIndices(path: String): Triple<Int, Int, Int> {
        val components = path.split('/').filter(String::isNotEmpty)
        require(
            components.size == 6 &&
                components[0] == "content" &&
                components[2] == "content" &&
                components[4] == "content",
        ) { "非法表格格子路径：$path" }
        return Triple(
            components[1].toInt(),
            components[3].toInt(),
            components[5].toInt(),
        )
    }

    private fun appendToRightmostTextNode(node: JsonObject, suffix: String): JsonObject {
        if (node.string("type") == "text") {
            return JsonObject(node + ("text" to JsonPrimitive(node.string("text") + suffix)))
        }

        val content = node["content"] as? JsonArray
            ?: error("目标节点没有可编辑的 text 叶子：${node.string("type")}")
        val textChildIndex = content.indexOfLast(::containsTextNode)
        require(textChildIndex >= 0) { "目标节点没有可编辑的 text 叶子：${node.string("type")}" }
        val child = content[textChildIndex] as? JsonObject
            ?: error("text 叶子的祖先必须是对象")
        val updatedContent = content.toMutableList().also {
            it[textChildIndex] = appendToRightmostTextNode(child, suffix)
        }
        return JsonObject(node + ("content" to JsonArray(updatedContent)))
    }

    private fun containsTextNode(element: JsonElement): Boolean {
        val objectValue = element as? JsonObject ?: return false
        if (objectValue.string("type") == "text") return true
        return (objectValue["content"] as? JsonArray)?.any(::containsTextNode) == true
    }

    private fun appendToTableCellText(
        table: JsonObject,
        rowIndex: Int,
        cellIndex: Int,
        suffix: String,
    ): JsonObject {
        val rows = table.getValue("content").jsonArray.toMutableList()
        val row = rows[rowIndex].jsonObject
        val cells = row.getValue("content").jsonArray.toMutableList()
        cells[cellIndex] = appendToRightmostTextNode(cells[cellIndex].jsonObject, suffix)
        rows[rowIndex] = JsonObject(row + ("content" to JsonArray(cells)))
        return JsonObject(table + ("content" to JsonArray(rows)))
    }

    private fun serializedMathNodes(blocks: List<DocBlock>): List<JsonObject> =
        ProseMirrorParser.serializeBlocks(blocks).getValue("content").jsonArray
            .filterIsInstance<JsonObject>()
            .flatMap { node ->
                (node["content"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
            }
            .filter { it.string("type") in setOf("mathematics", "math", "math_inline") }

    private fun assertSecondFormulaSemantics(node: JsonObject) {
        assertEquals("mathematics", node.string("type"))
        assertEquals(
            json.parseToJsonElement(
                """{"display":true,"source":"two","text":"second edited"}""",
            ),
            node.getValue("attrs"),
        )
        assertFalse("text 来源键不得额外生成 latex", node.jsonObjectAttrs().containsKey("latex"))
    }

    private fun JsonObject.jsonObjectAttrs(): JsonObject = getValue("attrs").jsonObject

    private fun currentDisposition(node: JsonObject): String {
        val blocks = ProseMirrorParser.parseBlocks(singletonDoc(node))
        val type = node.string("type")
        val productSummaryTypes = setOf("tabdataBlock", "tabwhiteboard", "htmlBlock", "youtube")
        if (type in productSummaryTypes && blocks.isNotEmpty() && blocks.all { !it.editable }) {
            return "summary"
        }
        return if (blocks.isNotEmpty() && blocks.all { it.canDeleteWholeBlock }) {
            "editable"
        } else {
            "readonly_preserve"
        }
    }

    private fun JsonObject.string(key: String): String =
        this[key]?.jsonPrimitive?.contentOrNull.orEmpty()
}
