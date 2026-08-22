package com.tabtin.mobile.features.doc.editor

import com.tabtin.mobile.features.doc.editor.core.BlockViewConverter
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.InlineMark
import com.tabtin.mobile.features.doc.model.InlineMarkKind
import com.tabtin.mobile.features.doc.model.InlineSpan
import com.tabtin.mobile.features.doc.model.ProseMirrorParser
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DocMathematicsAtomTest {

    @Test
    fun `adjacent equivalent formulas remain two atoms when blocks merge`() {
        val first = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("a", listOf(InlineMark.Mathematics()))),
        )
        val second = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("b", listOf(InlineMark.Mathematics()))),
        )

        val (mergedBlocks, _, _) = DocEditorOrchestrator.mergeWithPrevious(
            listOf(first, second),
            second.id,
        )
        val serializedContent = ProseMirrorParser.serializeBlocks(mergedBlocks)
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray

        assertEquals(2, mergedBlocks.single().spans.size)
        assertEquals(2, serializedContent.size)
        assertEquals(
            "a",
            serializedContent[0].jsonObject.getValue("attrs").jsonObject
                .getValue("latex").jsonPrimitive.content,
        )
        assertEquals(
            "b",
            serializedContent[1].jsonObject.getValue("attrs").jsonObject
                .getValue("latex").jsonPrimitive.content,
        )
    }

    @Test
    fun `inline formatting inside formula leaves the formula atom unchanged`() {
        val mathematics = InlineMark.Mathematics()
        val block = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("a+b", listOf(mathematics))),
        )

        val updated = DocEditorOrchestrator.toggleMark(
            blocks = listOf(block),
            blockId = block.id,
            markKind = InlineMarkKind.BOLD,
            selStart = 1,
            selEnd = 2,
        ).single()

        assertEquals(listOf(InlineSpan("a+b", listOf(mathematics))), updated.spans)
        val serializedContent = ProseMirrorParser.serializeBlocks(listOf(updated))
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray
        assertEquals(1, serializedContent.size)
        assertEquals(
            "a+b",
            serializedContent.single().jsonObject.getValue("attrs").jsonObject
                .getValue("latex").jsonPrimitive.content,
        )
    }

    @Test
    fun `splitting inside formula keeps the entire atom on one side`() {
        val mathematics = InlineMark.Mathematics()
        val spans = listOf(
            InlineSpan("before"),
            InlineSpan("a+b", listOf(mathematics)),
            InlineSpan("after"),
        )

        val (before, after) = DocEditorOrchestrator.splitSpansAt(spans, position = 7)

        assertEquals("beforea+b", before.joinToString("") { it.text })
        assertEquals("after", after.joinToString("") { it.text })
        assertSame(mathematics, before.last().marks.single())
        assertTrue(after.none { span -> span.marks.any { it is InlineMark.Mathematics } })
    }

    @Test
    fun `mathematics format action is explicitly unavailable instead of becoming code`() {
        val block = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("plain")),
        )

        val updated = DocEditorOrchestrator.toggleMark(
            blocks = listOf(block),
            blockId = block.id,
            markKind = InlineMarkKind.MATHEMATICS,
            selStart = 0,
            selEnd = 5,
        )

        assertEquals(listOf(block), updated)
    }

    @Test
    fun `fragments of one formula recover as one serialized atom`() {
        val mathematics = InlineMark.Mathematics()
        val block = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(
                InlineSpan("a", listOf(mathematics)),
                InlineSpan("+", listOf(mathematics, InlineMark.Bold)),
                InlineSpan("b", listOf(mathematics)),
            ),
        )

        val serializedContent = ProseMirrorParser.serializeBlocks(listOf(block))
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray

        assertEquals(1, serializedContent.size)
        assertEquals(
            "a+b",
            serializedContent.single().jsonObject.getValue("attrs").jsonObject
                .getValue("latex").jsonPrimitive.content,
        )
    }

    @Test
    fun `fragments of one formula recover as one editor mark`() {
        val mathematics = InlineMark.Mathematics()
        val spans = listOf(
            InlineSpan("a", listOf(mathematics)),
            InlineSpan("+", listOf(mathematics, InlineMark.Bold)),
            InlineSpan("b", listOf(mathematics)),
        )

        val marks = BlockViewConverter.spansToMarks("a+b", spans)
        val mathematicsMarks = marks.filterIsInstance<TabDocMarkup.Mark.Mathematics>()

        assertEquals(1, mathematicsMarks.size)
        assertEquals(0, mathematicsMarks.single().from)
        assertEquals(3, mathematicsMarks.single().to)
        assertEquals(mathematics.atomId, mathematicsMarks.single().atomId)
    }

    @Test
    fun `duplicating block renews formula identity while retaining fragment identity`() {
        val mathematics = InlineMark.Mathematics()
        val original = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(
                InlineSpan("a", listOf(mathematics)),
                InlineSpan("+b", listOf(mathematics, InlineMark.Bold)),
            ),
        )

        val (_, duplicate) = DocEditorOrchestrator.duplicateBlock(listOf(original), original.id)
        val originalAtomIds = original.spans
            .flatMap(InlineSpan::marks)
            .filterIsInstance<InlineMark.Mathematics>()
            .map(InlineMark.Mathematics::atomId)
            .toSet()
        val duplicateAtomIds = duplicate!!.spans
            .flatMap(InlineSpan::marks)
            .filterIsInstance<InlineMark.Mathematics>()
            .map(InlineMark.Mathematics::atomId)
            .toSet()

        assertEquals(1, originalAtomIds.size)
        assertEquals(1, duplicateAtomIds.size)
        assertNotEquals(originalAtomIds.single(), duplicateAtomIds.single())
    }

    @Test
    fun `duplicating formula block keeps text alignment without reviving persisted identity attrs`() {
        val original = DocBlock(
            blockId = "persisted-block-id",
            kind = BlockKind.HEADING2,
            spans = listOf(InlineSpan("a+b", listOf(InlineMark.Mathematics()))),
            sourceAttributes = buildJsonObject {
                put("blockId", "persisted-block-id")
                put("level", 6)
                put("textAlign", JsonNull)
            },
        )

        val (_, duplicate) = DocEditorOrchestrator.duplicateBlock(listOf(original), original.id)
        val duplicateBlock = requireNotNull(duplicate)
        val serializedAttrs = ProseMirrorParser.serializeBlocks(listOf(duplicateBlock))
            .getValue("content").jsonArray.single().jsonObject
            .getValue("attrs").jsonObject

        assertNull(duplicateBlock.blockId)
        assertEquals(
            buildJsonObject { put("textAlign", JsonNull) },
            duplicateBlock.sourceAttributes,
        )
        assertFalse(serializedAttrs.containsKey("blockId"))
        assertEquals(2, serializedAttrs.getValue("level").jsonPrimitive.content.toInt())
        assertEquals(JsonNull, serializedAttrs.getValue("textAlign"))
    }

    @Test
    fun `splitting at adjacent formula boundary and merging back preserves two atoms`() {
        val first = InlineMark.Mathematics()
        val second = InlineMark.Mathematics()
        val block = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(
                InlineSpan("a", listOf(first)),
                InlineSpan("b", listOf(second)),
            ),
        )

        val (splitBlocks, newBlock) = DocEditorOrchestrator.splitBlock(
            blocks = listOf(block),
            blockId = block.id,
            cursorPosition = 1,
            spans = block.spans,
        )
        assertEquals(
            listOf(first.atomId),
            splitBlocks.first().spans
                .flatMap(InlineSpan::marks)
                .filterIsInstance<InlineMark.Mathematics>()
                .map(InlineMark.Mathematics::atomId),
        )
        assertEquals(
            listOf(second.atomId),
            newBlock.spans
                .flatMap(InlineSpan::marks)
                .filterIsInstance<InlineMark.Mathematics>()
                .map(InlineMark.Mathematics::atomId),
        )

        val (merged, _, _) = DocEditorOrchestrator.mergeWithPrevious(splitBlocks, newBlock.id)
        val serializedContent = ProseMirrorParser.serializeBlocks(merged)
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray
        assertEquals(2, serializedContent.size)
    }

    @Test
    fun `runtime formula identity is never written to ProseMirror JSON`() {
        val runtimeOnlyAtomId = "runtime-only-atom-id"
        val block = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(
                InlineSpan(
                    "a+b",
                    listOf(InlineMark.Mathematics(atomId = runtimeOnlyAtomId)),
                ),
            ),
        )

        val serialized = ProseMirrorParser.serializeBlocks(listOf(block)).toString()

        assertFalse(serialized.contains("atomId"))
        assertFalse(serialized.contains(runtimeOnlyAtomId))
    }

    @Test
    fun `formatting across formula applies only to surrounding text`() {
        val mathematics = InlineMark.Mathematics()
        val block = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(
                InlineSpan("x"),
                InlineSpan("a+b", listOf(mathematics)),
                InlineSpan("y"),
            ),
        )

        val updated = DocEditorOrchestrator.toggleMark(
            blocks = listOf(block),
            blockId = block.id,
            markKind = InlineMarkKind.BOLD,
            selStart = 0,
            selEnd = 5,
        ).single()

        assertEquals(
            listOf(
                InlineSpan("x", listOf(InlineMark.Bold)),
                InlineSpan("a+b", listOf(mathematics)),
                InlineSpan("y", listOf(InlineMark.Bold)),
            ),
            updated.spans,
        )
    }
}
