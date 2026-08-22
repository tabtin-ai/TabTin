package com.tabtin.mobile.features.doc.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 批次 1b：逐块可编辑性 + 复杂块局部只读。
 *
 * 核心不变量：未通过安全门禁的块保留原始子树、局部只读、不参与删除/转换；
 * 简单表格可编辑，编辑后序列化走结构化路径（rawNode 失效）而不是写回原文。
 */
class PerBlockEditabilityTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun docOf(vararg nodeJson: String): JsonObject =
        json.parseToJsonElement(
            """{"type":"doc","content":[${nodeJson.joinToString(",")}]}""",
        ).jsonObject

    private val simpleTableJson = """
        {"type":"table","attrs":{"blockId":"t-simple"},"content":[
          {"type":"tableRow","content":[
            {"type":"tableHeader","attrs":{"colspan":1,"rowspan":1,"colwidth":null},"content":[
              {"type":"paragraph","content":[{"type":"text","text":"名称"}]}]},
            {"type":"tableHeader","content":[
              {"type":"paragraph","content":[{"type":"text","text":"数量"}]}]}]},
          {"type":"tableRow","content":[
            {"type":"tableCell","content":[
              {"type":"paragraph","content":[{"type":"text","text":"苹果"}]}]},
            {"type":"tableCell","content":[
              {"type":"paragraph","content":[{"type":"text","text":"3"}]}]}]}]}
    """.trimIndent()

    private val mergedTableJson = """
        {"type":"table","content":[
          {"type":"tableRow","content":[
            {"type":"tableHeader","attrs":{"colspan":2,"rowspan":1,"colwidth":null},"content":[
              {"type":"paragraph","content":[{"type":"text","text":"跨两列"}]}]},
            {"type":"tableHeader","attrs":{"colspan":1,"rowspan":2,"colwidth":null},"content":[
              {"type":"paragraph","content":[{"type":"text","text":"跨两行"}]}]}]}]}
    """.trimIndent()

    @Test
    fun `unknown node becomes readonly preserved block`() {
        val doc = docOf("""{"type":"futureChart","attrs":{"chartId":"c1","engine":"v9"}}""")
        val block = ProseMirrorParser.parseBlocks(doc).single()
        assertEquals(BlockKind.UNSUPPORTED, block.kind)
        assertFalse(block.editable)
        assertFalse(block.canEditInline)
        assertNotNull(block.rawNode)

        val serialized = ProseMirrorParser.serializeBlocks(listOf(block))
        assertEquals(doc, serialized)
    }

    @Test
    fun `paragraph with canonical textAlign stays editable and round trips`() {
        val doc = docOf(
            """{"type":"paragraph","attrs":{"textAlign":"center"},"content":[{"type":"text","text":"居中"}]}""",
        )
        val block = ProseMirrorParser.parseBlocks(doc).single()
        assertEquals(BlockKind.PARAGRAPH, block.kind)
        assertTrue(block.editable)
        assertEquals(doc, ProseMirrorParser.serializeBlocks(listOf(block)))
    }

    @Test
    fun `paragraph with reconstructible unknown mark stays editable and round trips`() {
        val doc = docOf(
            """{"type":"paragraph","content":[{"type":"text","text":"文本","marks":[{"type":"futureMark","attrs":{"weight":9}}]}]}""",
        )
        val block = ProseMirrorParser.parseBlocks(doc).single()
        assertEquals(BlockKind.PARAGRAPH, block.kind)
        assertTrue(block.editable)
        assertTrue(block.canEditInline)
        val unknown = block.spans.single().marks.filterIsInstance<InlineMark.Unknown>().single()
        assertEquals("futureMark", unknown.type)
        assertEquals(9L, (unknown.attrs["weight"] as? Number)?.toLong())
        assertEquals("未知 mark 必须原样写回", doc, ProseMirrorParser.serializeBlocks(listOf(block)))
    }

    @Test
    fun `safe paragraph stays editable`() {
        val doc = docOf(
            """{"type":"paragraph","attrs":{"blockId":"p1","textAlign":null},"content":[{"type":"text","text":"普通"}]}""",
        )
        val block = ProseMirrorParser.parseBlocks(doc).single()
        assertEquals(BlockKind.PARAGRAPH, block.kind)
        assertTrue(block.editable)
        assertTrue(block.canEditInline)
    }

    @Test
    fun `unsafe list is preserved whole instead of flattened`() {
        val listJson = """
            {"type":"bulletList","content":[
              {"type":"listItem","attrs":{"blockId":"li1","mystery":"x"},"content":[
                {"type":"paragraph","content":[{"type":"text","text":"项"}]}]}]}
        """.trimIndent()
        val doc = docOf(listJson)
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals("不安全列表不拍平，整体只读保留", 1, blocks.size)
        assertEquals(BlockKind.UNSUPPORTED, blocks.single().kind)
        assertFalse(blocks.single().editable)
        assertEquals(doc, ProseMirrorParser.serializeBlocks(blocks))
    }

    @Test
    fun `simple table is editable, merged table is readonly`() {
        assertTrue(
            NativeDocumentSafetyPolicy.isSimpleEditableTable(
                json.parseToJsonElement(simpleTableJson).jsonObject,
            ),
        )
        assertFalse(
            NativeDocumentSafetyPolicy.isSimpleEditableTable(
                json.parseToJsonElement(mergedTableJson).jsonObject,
            ),
        )

        val doc = docOf(simpleTableJson, mergedTableJson)
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(2, blocks.size)
        assertTrue("简单表格可编辑", blocks[0].editable)
        assertFalse("合并单元格表格局部只读", blocks[1].editable)
        assertTrue("简单表格仍可整块删除", blocks[0].canDeleteWholeBlock)
        assertTrue("复杂表格也可无损整块删除", blocks[1].canDeleteWholeBlock)
        assertNotNull("只读表格保留 rawNode", blocks[1].rawNode)
    }

    @Test
    fun `table with canonical bold cell text stays editable`() {
        val markedCellTable = """
            {"type":"table","content":[
              {"type":"tableRow","content":[
                {"type":"tableCell","content":[
                  {"type":"paragraph","content":[{"type":"text","text":"加粗","marks":[{"type":"bold"}]}]}]}]}]}
        """.trimIndent()
        assertTrue(
            "canonical bold 格子必须可编辑，否则整表保存会丢掉加粗",
            NativeDocumentSafetyPolicy.isSimpleEditableTable(
                json.parseToJsonElement(markedCellTable).jsonObject,
            ),
        )
        val cell = ProseMirrorParser.parseBlocks(docOf(markedCellTable))
            .single().tableData!!.rows.single().cells.single()
        assertFalse("canonical bold 格子不得走只读投影", cell.isReadOnlyProjection)
        assertEquals(listOf(InlineMark.Bold), cell.spans.single().marks)
    }

    @Test
    fun `table with unknown mark cell stays readonly`() {
        val unknownMarkTable = """
            {"type":"table","content":[
              {"type":"tableRow","content":[
                {"type":"tableCell","content":[
                  {"type":"paragraph","content":[{"type":"text","text":"未知","marks":[{"type":"futureMark","attrs":{"weight":9}}]}]}]}]}]}
        """.trimIndent()
        assertFalse(
            NativeDocumentSafetyPolicy.isSimpleEditableTable(
                json.parseToJsonElement(unknownMarkTable).jsonObject,
            ),
        )
        val cell = ProseMirrorParser.parseBlocks(docOf(unknownMarkTable))
            .single().tableData!!.rows.single().cells.single()
        assertTrue("未知 mark 格子必须只读投影，避免写回丢掉标记", cell.isReadOnlyProjection)
    }

    @Test
    fun `table with mathematics cell stays readonly`() {
        val mathCellTable = """
            {"type":"table","content":[
              {"type":"tableRow","content":[
                {"type":"tableCell","content":[
                  {"type":"paragraph","content":[{"type":"mathematics","attrs":{"latex":"x+y"}}]}]}]}]}
        """.trimIndent()
        assertFalse(
            NativeDocumentSafetyPolicy.isSimpleEditableTable(
                json.parseToJsonElement(mathCellTable).jsonObject,
            ),
        )
        val cell = ProseMirrorParser.parseBlocks(docOf(mathCellTable))
            .single().tableData!!.rows.single().cells.single()
        assertTrue("公式格子必须只读投影，格子编辑器还不消费 mathematics", cell.isReadOnlyProjection)
    }

    @Test
    fun `editing sibling paragraph preserves oversized readonly table exactly`() {
        val rows = (0..500).joinToString(",") { row ->
            """{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"R$row"}]}]}]}"""
        }
        val oversizedTable = """{"type":"table","content":[$rows]}"""
        val document = docOf(
            oversizedTable,
            """{"type":"paragraph","content":[{"type":"text","text":"修改前"}]}""",
        )
        val blocks = ProseMirrorParser.parseBlocks(document)
        assertFalse(blocks[0].editable)
        assertEquals(500, blocks[0].tableData!!.rows.size)

        val edited = blocks.toMutableList().also {
            it[1] = it[1].copy(spans = listOf(InlineSpan("修改后")))
        }
        val serialized = ProseMirrorParser.serializeBlocks(edited)
        val serializedContent = serialized.getValue("content").jsonArray

        assertEquals(
            "只编辑旁段时，大表必须原样回写而不是按投影重建",
            document.getValue("content").jsonArray.first(),
            serializedContent.first(),
        )
        assertEquals(
            501,
            serializedContent.first().jsonObject.getValue("content").jsonArray.size,
        )
        assertEquals(
            "修改后",
            serializedContent[1].jsonObject.getValue("content").jsonArray.single().jsonObject
                .getValue("text").jsonPrimitive.content,
        )
    }

    @Test
    fun `edited simple table serializes structured data instead of stale rawNode`() {
        val doc = docOf(simpleTableJson)
        val block = ProseMirrorParser.parseBlocks(doc).single()
        assertTrue(block.editable)

        // 模拟 onCellTextChanged：改文本（spans 同步替换）+ 弃用 rawNode
        val table = block.tableData!!
        val editedCell = table.rows[1].cells[0].copy(
            text = "苹果（已改）",
            spans = listOf(InlineSpan("苹果（已改）")),
        )
        val editedRows = table.rows.toMutableList().also {
            it[1] = it[1].copy(cells = it[1].cells.toMutableList().also { c -> c[0] = editedCell })
        }
        val edited = block.copy(tableData = table.copy(rows = editedRows), rawNode = null)

        val serialized = ProseMirrorParser.serializeBlocks(listOf(edited))
        val tableNode = serialized.getValue("content").jsonArray.single().jsonObject
        val firstDataCell = tableNode.getValue("content").jsonArray[1].jsonObject
            .getValue("content").jsonArray[0].jsonObject
        val cellText = firstDataCell.getValue("content").jsonArray[0].jsonObject
            .getValue("content").jsonArray[0].jsonObject
            .getValue("text").jsonPrimitive.content
        assertEquals("苹果（已改）", cellText)
        // tableHeader 结构保留
        assertEquals(
            "tableHeader",
            tableNode.getValue("content").jsonArray[0].jsonObject
                .getValue("content").jsonArray[0].jsonObject.getValue("type").jsonPrimitive.content,
        )
    }

    @Test
    fun `untouched simple table keeps rawNode byte identical`() {
        val doc = docOf(simpleTableJson)
        val block = ProseMirrorParser.parseBlocks(doc).single()
        val serialized = ProseMirrorParser.serializeBlocks(listOf(block))
        assertEquals(
            "未编辑的简单表格写回原始子树（含 blockId、colwidth:null 等原样保留）",
            doc, serialized,
        )
    }

    @Test
    fun `mixed document has both editable and readonly blocks`() {
        val doc = docOf(
            """{"type":"paragraph","content":[{"type":"text","text":"可编辑段落"}]}""",
            mergedTableJson,
            """{"type":"futureChart","attrs":{"chartId":"c1"}}""",
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(3, blocks.size)
        assertTrue(blocks[0].editable)
        assertFalse(blocks[1].editable)
        assertFalse(blocks[2].editable)
        // 整篇无损往返（未编辑时）
        assertEquals(doc, ProseMirrorParser.serializeBlocks(blocks))
    }

    @Test
    fun `readonly block deletion is the forbidden path - serializer never invents content`() {
        // UNSUPPORTED 块 rawNode 为空时序列化为无输出（不虚构内容），
        // 真正的防删除门禁在 ViewModel 层（editable == false 禁止删除）。
        val ghost = DocBlock(kind = BlockKind.UNSUPPORTED, unsupportedType = "x", editable = false)
        val serialized = ProseMirrorParser.serializeBlocks(listOf(ghost))
        assertTrue(serialized.getValue("content").jsonArray.isEmpty())
    }
}
