package com.tabtin.mobile.features.doc.editor

import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.InlineMark
import com.tabtin.mobile.features.doc.model.InlineMarkKind
import com.tabtin.mobile.features.doc.model.InlineSpan
import com.tabtin.mobile.features.doc.model.ProseMirrorParser
import com.tabtin.mobile.features.doc.model.TableCell
import com.tabtin.mobile.features.doc.model.TableData
import com.tabtin.mobile.features.doc.model.TableRow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class DocEditorOrchestratorSafetyTest {

    @Test
    fun `backspace at heading start merges content into previous block`() {
        val previous = DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("before")))
        val heading = DocBlock(kind = BlockKind.HEADING2, spans = listOf(InlineSpan("after")))

        val (updated, focusId, cursor) =
            DocEditorOrchestrator.mergeWithPrevious(listOf(previous, heading), heading.id)

        assertEquals(1, updated.size)
        assertEquals("beforeafter", updated.single().text)
        assertEquals(previous.id, focusId)
        assertEquals(6, cursor)
    }

    @Test
    fun `backspace at list item start removes item and keeps following sibling`() {
        val previous = DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("before")))
        val current = DocBlock(
            kind = BlockKind.BULLET_ITEM,
            spans = listOf(InlineSpan("current")),
            listContainerId = "list",
        )
        val following = DocBlock(
            kind = BlockKind.BULLET_ITEM,
            spans = listOf(InlineSpan("following")),
            listContainerId = "list",
        )

        val (updated, focusId, cursor) = DocEditorOrchestrator.mergeWithPrevious(
            listOf(previous, current, following),
            current.id,
        )

        assertEquals(listOf("beforecurrent", "following"), updated.map { it.text })
        assertEquals(listOf(BlockKind.PARAGRAPH, BlockKind.BULLET_ITEM), updated.map { it.kind })
        assertEquals(previous.id, focusId)
        assertEquals(6, cursor)
    }

    @Test
    fun `backspace at empty code block removes it after paragraph`() {
        val previous = DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("before")))
        val code = DocBlock(kind = BlockKind.CODE_BLOCK)

        val (updated, focusId, cursor) =
            DocEditorOrchestrator.mergeWithPrevious(listOf(previous, code), code.id)

        assertEquals(listOf(previous), updated)
        assertEquals(previous.id, focusId)
        assertEquals(6, cursor)
    }

    @Test
    fun `moving a list parent carries descendants and snaps after the target subtree`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "parent-a",
                    text = "parent-a",
                    orderedList(
                        start = 3,
                        listItem("child-a1", "child-a1"),
                        listItem("child-a2", "child-a2"),
                    ),
                ),
                listItem(
                    id = "parent-b",
                    text = "parent-b",
                    orderedList(
                        start = 11,
                        listItem("child-b1", "child-b1"),
                    ),
                ),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)
        val parentA = blocks.indexOfFirst { it.text == "parent-a" }
        val parentB = blocks.indexOfFirst { it.text == "parent-b" }
        val childA1 = blocks.indexOfFirst { it.text == "child-a1" }
        val childA2 = blocks.indexOfFirst { it.text == "child-a2" }
        val childB1 = blocks.indexOfFirst { it.text == "child-b1" }

        val movedByDrop = DocEditorOrchestrator.moveBlock(blocks, parentA, childB1)
        val movedByDownAction = DocEditorOrchestrator.moveBlock(blocks, parentA, childA1)
        val movedByUpAction = DocEditorOrchestrator.moveBlock(blocks, parentB, childA2)
        val expected = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "parent-b",
                    text = "parent-b",
                    orderedList(
                        start = 11,
                        listItem("child-b1", "child-b1"),
                    ),
                ),
                listItem(
                    id = "parent-a",
                    text = "parent-a",
                    orderedList(
                        start = 3,
                        listItem("child-a1", "child-a1"),
                        listItem("child-a2", "child-a2"),
                    ),
                ),
            ),
        )

        assertEquals(
            listOf("parent-b", "child-b1", "parent-a", "child-a1", "child-a2"),
            movedByDrop.map { it.text },
        )
        assertEquals(expected, ProseMirrorParser.serializeBlocks(movedByDrop))
        assertEquals(
            "move-down landing on the source's first child must still move the whole parent subtree",
            expected,
            ProseMirrorParser.serializeBlocks(movedByDownAction),
        )
        assertEquals(
            "move-up landing on the previous sibling's last child must snap before that subtree",
            expected,
            ProseMirrorParser.serializeBlocks(movedByUpAction),
        )
    }

    @Test
    fun `moving a nested list item carries only its own deeper descendants`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "root",
                    text = "root",
                    orderedList(
                        start = 3,
                        listItem(
                            id = "nested-a",
                            text = "nested-a",
                            orderedList(
                                start = 21,
                                listItem("deep-a", "deep-a"),
                            ),
                        ),
                        listItem(
                            id = "nested-b",
                            text = "nested-b",
                            orderedList(
                                start = 31,
                                listItem("deep-b", "deep-b"),
                            ),
                        ),
                    ),
                ),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)

        val moved = DocEditorOrchestrator.moveBlock(
            blocks = blocks,
            fromIndex = blocks.indexOfFirst { it.text == "nested-a" },
            toIndex = blocks.indexOfFirst { it.text == "deep-b" },
        )
        val expected = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "root",
                    text = "root",
                    orderedList(
                        start = 3,
                        listItem(
                            id = "nested-b",
                            text = "nested-b",
                            orderedList(
                                start = 31,
                                listItem("deep-b", "deep-b"),
                            ),
                        ),
                        listItem(
                            id = "nested-a",
                            text = "nested-a",
                            orderedList(
                                start = 21,
                                listItem("deep-a", "deep-a"),
                            ),
                        ),
                    ),
                ),
            ),
        )

        assertEquals(
            listOf("root", "nested-b", "deep-b", "nested-a", "deep-a"),
            moved.map { it.text },
        )
        assertEquals(expected, ProseMirrorParser.serializeBlocks(moved))
    }

    @Test
    fun `nested list move across parent containers fails closed`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "parent-a",
                    text = "parent-a",
                    orderedList(
                        start = 3,
                        listItem("child-a", "child-a"),
                    ),
                ),
                listItem(
                    id = "parent-b",
                    text = "parent-b",
                    orderedList(
                        start = 11,
                        listItem("child-b", "child-b"),
                    ),
                ),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)

        val moved = DocEditorOrchestrator.moveBlock(
            blocks = blocks,
            fromIndex = blocks.indexOfFirst { it.text == "child-a" },
            toIndex = blocks.indexOfFirst { it.text == "child-b" },
        )

        assertEquals(blocks, moved)
        assertEquals(source, ProseMirrorParser.serializeBlocks(moved))
    }

    @Test
    fun `ordinary blocks keep single-block move semantics`() {
        val first = DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("first")))
        val second = DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("second")))
        val third = DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("third")))

        val moved = DocEditorOrchestrator.moveBlock(listOf(first, second, third), 0, 1)

        assertEquals(listOf(second, first, third), moved)
    }

    @Test
    fun `ordinary block cannot be inserted between a list parent and child`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "parent",
                    text = "parent",
                    orderedList(
                        start = 3,
                        listItem("child", "child"),
                    ),
                ),
            ),
            paragraph("outside"),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)

        val moved = DocEditorOrchestrator.moveBlock(
            blocks = blocks,
            fromIndex = blocks.indexOfFirst { it.text == "outside" },
            toIndex = blocks.indexOfFirst { it.text == "child" },
        )

        assertEquals(blocks, moved)
        assertEquals(source, ProseMirrorParser.serializeBlocks(moved))
    }

    @Test
    fun `create after a list parent inserts after all descendants`() {
        val source = nestedParentDocument()
        val blocks = ProseMirrorParser.parseBlocks(source)
        val parent = blocks.first { it.text == "parent-a" }

        val (updated, created) = DocEditorOrchestrator.createBlock(
            blocks = blocks,
            afterBlockId = parent.id,
            kind = BlockKind.PARAGRAPH,
        )

        assertEquals(
            listOf("parent-a", "child-a", "", "parent-b"),
            updated.map { it.text },
        )
        assertEquals(2, updated.indexOfFirst { it.id == created.id })
        val serialized = ProseMirrorParser.serializeBlocks(updated)
        val topLevel = serialized.getValue("content").jsonArray
        assertEquals(3, topLevel.size)
        val firstListItemContent = topLevel.first().jsonObject
            .getValue("content").jsonArray.first().jsonObject
            .getValue("content").jsonArray
        assertEquals("orderedList", firstListItemContent.last().jsonObject
            .getValue("type").jsonPrimitive.content)
        assertEquals(
            listOf(0, 1, 0, 0),
            ProseMirrorParser.parseBlocks(serialized).map { it.indentLevel },
        )
    }

    @Test
    fun `slash command converts an otherwise empty command block in place`() {
        val command = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("/标题")),
        )

        val result = DocEditorOrchestrator.applySlashCommand(
            blocks = listOf(command),
            blockId = command.id,
            slashStart = 0,
            filterLen = 2,
            targetKind = BlockKind.HEADING1,
        )

        assertEquals(1, result.blocks.size)
        assertEquals(command.id, result.blocks.single().id)
        assertEquals(BlockKind.HEADING1, result.blocks.single().kind)
        assertEquals("", result.blocks.single().text)
        assertEquals(command.id, result.focusBlockId)
        assertEquals(0, result.cursorPosition)
    }

    @Test
    fun `slash command keeps surrounding text and inserts the target after it`() {
        val command = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("前言 /标题 结尾")),
        )

        val result = DocEditorOrchestrator.applySlashCommand(
            blocks = listOf(command),
            blockId = command.id,
            slashStart = 3,
            filterLen = 2,
            targetKind = BlockKind.HEADING1,
        )

        assertEquals(2, result.blocks.size)
        assertEquals("前言  结尾", result.blocks.first().text)
        assertEquals(BlockKind.PARAGRAPH, result.blocks.first().kind)
        assertEquals(BlockKind.HEADING1, result.blocks.last().kind)
        assertEquals(result.blocks.last().id, result.focusBlockId)
    }

    @Test
    fun `duplicate list parent stays after descendants without adopting them`() {
        val source = nestedParentDocument()
        val blocks = ProseMirrorParser.parseBlocks(source)
        val parent = blocks.first { it.text == "parent-a" }

        val (updated, duplicated) = DocEditorOrchestrator.duplicateBlock(blocks, parent.id)
        val duplicate = requireNotNull(duplicated)

        assertEquals(
            listOf("parent-a", "child-a", "parent-a", "parent-b"),
            updated.map { it.text },
        )
        assertEquals(2, updated.indexOfFirst { it.id == duplicate.id })
        val serialized = ProseMirrorParser.serializeBlocks(updated)
        val listItems = serialized.getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray
        assertEquals(3, listItems.size)
        assertEquals(2, listItems[0].jsonObject.getValue("content").jsonArray.size)
        assertEquals(1, listItems[1].jsonObject.getValue("content").jsonArray.size)
        assertEquals(
            listOf(0, 1, 0, 0),
            ProseMirrorParser.parseBlocks(serialized).map { it.indentLevel },
        )
    }

    @Test
    fun `first list item and first nested sibling cannot indent without a parent`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "parent",
                    text = "parent",
                    orderedList(
                        start = 3,
                        listItem("first-child", "first-child"),
                    ),
                ),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)

        val rootAttempt = DocEditorOrchestrator.indent(
            blocks,
            blocks.first { it.text == "parent" }.id,
        )
        val nestedAttempt = DocEditorOrchestrator.indent(
            blocks,
            blocks.first { it.text == "first-child" }.id,
        )

        assertEquals(blocks, rootAttempt)
        assertEquals(blocks, nestedAttempt)
        assertEquals(source, ProseMirrorParser.serializeBlocks(rootAttempt))
        assertEquals(source, ProseMirrorParser.serializeBlocks(nestedAttempt))
    }

    @Test
    fun `indent and unindent move an entire list subtree and survive reload`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "parent-a",
                    text = "parent-a",
                    orderedList(
                        start = 5,
                        listItem("child-a", "child-a"),
                    ),
                ),
                listItem(
                    id = "parent-b",
                    text = "parent-b",
                    orderedList(
                        start = 3,
                        listItem("child-b", "child-b"),
                    ),
                ),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)
        val parentB = blocks.first { it.text == "parent-b" }

        val indented = DocEditorOrchestrator.indent(blocks, parentB.id)
        val serializedIndented = ProseMirrorParser.serializeBlocks(indented)
        val reloadedIndented = ProseMirrorParser.parseBlocks(serializedIndented)
        assertEquals(listOf(0, 1, 1, 2), indented.map { it.indentLevel })
        assertEquals(listOf(0, 1, 1, 2), reloadedIndented.map { it.indentLevel })
        assertEquals(indented.map { it.text }, reloadedIndented.map { it.text })

        val restored = DocEditorOrchestrator.unindent(indented, parentB.id)
        assertEquals(listOf(0, 1, 0, 1), restored.map { it.indentLevel })
        assertEquals(source, ProseMirrorParser.serializeBlocks(restored))
    }

    @Test
    fun `unindent with a following nested sibling fails closed`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "parent",
                    text = "parent",
                    orderedList(
                        start = 3,
                        listItem("child-a", "child-a"),
                        listItem("child-b", "child-b"),
                    ),
                ),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)

        val updated = DocEditorOrchestrator.unindent(
            blocks,
            blocks.first { it.text == "child-a" }.id,
        )

        assertEquals(blocks, updated)
        assertEquals(source, ProseMirrorParser.serializeBlocks(updated))
    }

    @Test
    fun `turn into list renews identity across kinds and clears it when leaving lists`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem("item-a", "item-a"),
                listItem("item-b", "item-b"),
                listItem("item-c", "item-c"),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)
        val itemA = blocks.first { it.text == "item-a" }
        val itemB = blocks.first { it.text == "item-b" }

        val sameKind = DocEditorOrchestrator.turnIntoBlock(
            blocks,
            itemB.id,
            BlockKind.ORDERED_ITEM,
        )
        assertEquals(source, ProseMirrorParser.serializeBlocks(sameKind))

        val bullet = DocEditorOrchestrator.turnIntoBlock(
            blocks,
            itemB.id,
            BlockKind.BULLET_ITEM,
        )
        val bulletItem = bullet.first { it.id == itemB.id }
        val trailingItem = bullet.first { it.text == "item-c" }
        assertNotNull(bulletItem.listContainerId)
        assertNotEquals(itemB.listContainerId, bulletItem.listContainerId)
        assertNotEquals(
            "the ordered suffix must become a distinct runtime list after the split",
            itemA.listContainerId,
            trailingItem.listContainerId,
        )
        assertEquals(1, bulletItem.listStart)
        assertEquals(false, bulletItem.orderedListHasExplicitNullType)

        val orderedAgain = DocEditorOrchestrator.turnIntoBlock(
            bullet,
            itemB.id,
            BlockKind.ORDERED_ITEM,
        )
        val renewed = orderedAgain.first { it.id == itemB.id }
        assertNotNull(renewed.listContainerId)
        assertNotEquals(bulletItem.listContainerId, renewed.listContainerId)
        assertEquals(1, renewed.listStart)
        val serialized = ProseMirrorParser.serializeBlocks(orderedAgain)
        val topLevel = serialized.getValue("content").jsonArray
        assertEquals(listOf("orderedList", "orderedList", "orderedList"), topLevel.map {
            it.jsonObject.getValue("type").jsonPrimitive.content
        })
        assertEquals(
            listOf(7, 1, 7),
            topLevel.map { node ->
                node.jsonObject["attrs"]?.jsonObject
                    ?.get("start")?.jsonPrimitive?.content?.toInt() ?: 1
            },
        )
        assertEquals(
            listOf(7, 1, 7),
            ProseMirrorParser.parseBlocks(serialized).map { it.listStart },
        )

        val paragraph = DocEditorOrchestrator.turnIntoBlock(
            blocks,
            itemB.id,
            BlockKind.PARAGRAPH,
        ).first { it.id == itemB.id }
        assertNull(paragraph.listContainerId)
        assertEquals(0, paragraph.indentLevel)
        assertEquals(1, paragraph.listStart)
        assertEquals(false, paragraph.orderedListHasExplicitNullType)

        val nested = ProseMirrorParser.parseBlocks(nestedParentDocument())
        val nestedParent = nested.first { it.text == "parent-a" }
        assertEquals(
            "leaving list mode cannot detach a parent's descendants",
            nested,
            DocEditorOrchestrator.turnIntoBlock(
                nested,
                nestedParent.id,
                BlockKind.PARAGRAPH,
            ),
        )
    }

    @Test
    fun `markdown list shortcuts allocate independent containers and survive reload`() {
        val source = doc(
            paragraph("1. alpha"),
            paragraph("1. beta"),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)
        val first = blocks[0]
        val second = blocks[1]

        val afterFirst = DocEditorOrchestrator.applyMarkdownShortcut(
            blocks = blocks,
            blockId = first.id,
            text = first.text,
            targetKind = BlockKind.ORDERED_ITEM,
            prefixLength = 3,
        ).blocks
        val updated = DocEditorOrchestrator.applyMarkdownShortcut(
            blocks = afterFirst,
            blockId = second.id,
            text = second.text,
            targetKind = BlockKind.ORDERED_ITEM,
            prefixLength = 3,
        ).blocks

        assertNotNull(updated[0].listContainerId)
        assertNotNull(updated[1].listContainerId)
        assertNotEquals(updated[0].listContainerId, updated[1].listContainerId)
        assertEquals(listOf(1, 1), updated.map { it.listStart })
        val serialized = ProseMirrorParser.serializeBlocks(updated)
        assertEquals(2, serialized.getValue("content").jsonArray.size)
        val reloaded = ProseMirrorParser.parseBlocks(serialized)
        assertEquals(listOf("alpha", "beta"), reloaded.map { it.text })
        assertEquals(listOf(1, 1), reloaded.map { it.listStart })
    }

    @Test
    fun `nested list item cannot change kind when it has siblings under the same parent`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "parent",
                    text = "parent",
                    bulletList(
                        listItem("nested-a", "nested-a"),
                        listItem("nested-b", "nested-b"),
                    ),
                ),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)
        val nestedA = blocks.first { it.text == "nested-a" }

        val refused = DocEditorOrchestrator.turnIntoBlock(
            blocks,
            nestedA.id,
            BlockKind.ORDERED_ITEM,
        )

        assertEquals(blocks, refused)
        val serialized = ProseMirrorParser.serializeBlocks(refused)
        assertEquals(source, serialized)
        val reloaded = ProseMirrorParser.parseBlocks(serialized)
        assertEquals(
            listOf(BlockKind.ORDERED_ITEM, BlockKind.BULLET_ITEM, BlockKind.BULLET_ITEM),
            reloaded.map { it.kind },
        )
        assertEquals(listOf(true, true, true), reloaded.map { it.editable })

        val refusedLeaving = DocEditorOrchestrator.turnIntoBlock(
            blocks,
            nestedA.id,
            BlockKind.PARAGRAPH,
        )
        assertEquals(blocks, refusedLeaving)
        assertEquals(source, ProseMirrorParser.serializeBlocks(refusedLeaving))

        val refusedDividerShortcut = DocEditorOrchestrator.applyMarkdownShortcut(
            blocks = blocks,
            blockId = nestedA.id,
            text = "---",
            targetKind = BlockKind.DIVIDER,
            prefixLength = 3,
        )
        assertEquals(blocks, refusedDividerShortcut.blocks)
        assertEquals(source, ProseMirrorParser.serializeBlocks(refusedDividerShortcut.blocks))

        val nestedB = blocks.first { it.text == "nested-b" }
        val allowedLeaving = DocEditorOrchestrator.turnIntoBlock(
            blocks,
            nestedB.id,
            BlockKind.PARAGRAPH,
        )
        val leavingReloaded = ProseMirrorParser.parseBlocks(
            ProseMirrorParser.serializeBlocks(allowedLeaving),
        )
        assertEquals(
            listOf(BlockKind.ORDERED_ITEM, BlockKind.BULLET_ITEM, BlockKind.PARAGRAPH),
            leavingReloaded.map { it.kind },
        )
        assertEquals(listOf(true, true, true), leavingReloaded.map { it.editable })

        val singleChildSource = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "single-parent",
                    text = "single-parent",
                    bulletList(listItem("only-child", "only-child")),
                ),
            ),
        )
        val singleChildBlocks = ProseMirrorParser.parseBlocks(singleChildSource)
        val onlyChild = singleChildBlocks.first { it.text == "only-child" }
        val allowed = DocEditorOrchestrator.turnIntoBlock(
            singleChildBlocks,
            onlyChild.id,
            BlockKind.ORDERED_ITEM,
        )
        val allowedReloaded = ProseMirrorParser.parseBlocks(
            ProseMirrorParser.serializeBlocks(allowed),
        )
        assertEquals(
            listOf(BlockKind.ORDERED_ITEM, BlockKind.ORDERED_ITEM),
            allowedReloaded.map { it.kind },
        )
        assertEquals(listOf(true, true), allowedReloaded.map { it.editable })
    }

    @Test
    fun `create after nested list item inserts after its top-level ancestor subtree`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "parent",
                    text = "parent",
                    bulletList(
                        listItem("nested-a", "nested-a"),
                        listItem("nested-b", "nested-b"),
                    ),
                ),
                listItem("next-root", "next-root"),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)
        val nestedA = blocks.first { it.text == "nested-a" }

        val (updated, created) = DocEditorOrchestrator.createBlock(
            blocks,
            nestedA.id,
            BlockKind.PARAGRAPH,
        )

        assertEquals(
            listOf("parent", "nested-a", "nested-b", "", "next-root"),
            updated.map { it.text },
        )
        assertEquals(3, updated.indexOfFirst { it.id == created.id })
        val serialized = ProseMirrorParser.serializeBlocks(updated)
        val reloaded = ProseMirrorParser.parseBlocks(serialized)
        assertEquals(listOf(0, 1, 1, 0, 0), reloaded.map { it.indentLevel })
        assertEquals(
            listOf(
                BlockKind.ORDERED_ITEM,
                BlockKind.BULLET_ITEM,
                BlockKind.BULLET_ITEM,
                BlockKind.PARAGRAPH,
                BlockKind.ORDERED_ITEM,
            ),
            reloaded.map { it.kind },
        )
        assertEquals(listOf(true, true, true, true, true), reloaded.map { it.editable })
    }

    @Test
    fun `empty nested list split and merge fail closed when lifting would detach structure`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "parent",
                    text = "parent",
                    bulletList(
                        listItem(
                            id = "empty-child",
                            text = "",
                            orderedList(
                                start = 3,
                                listItem("deep-child", "deep-child"),
                            ),
                        ),
                        listItem("nested-sibling", "nested-sibling"),
                    ),
                ),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)
        val emptyChild = blocks.first { it.blockId == "empty-child" }

        val (splitBlocks, splitFocus) = DocEditorOrchestrator.splitBlock(
            blocks = blocks,
            blockId = emptyChild.id,
            cursorPosition = 0,
            spans = emptyChild.spans,
        )
        val (mergedBlocks, mergeFocus, mergeCursor) =
            DocEditorOrchestrator.mergeWithPrevious(blocks, emptyChild.id)

        assertEquals(blocks, splitBlocks)
        assertEquals(emptyChild, splitFocus)
        assertEquals(blocks, mergedBlocks)
        assertEquals(emptyChild.id, mergeFocus)
        assertEquals(0, mergeCursor)
        assertEquals(source, ProseMirrorParser.serializeBlocks(splitBlocks))
        assertEquals(source, ProseMirrorParser.serializeBlocks(mergedBlocks))
        assertEquals(
            listOf(0, 1, 2, 1),
            ProseMirrorParser.parseBlocks(source).map { it.indentLevel },
        )
    }

    @Test
    fun `deleting a list parent removes its complete subtree without reparenting descendants`() {
        val source = doc(
            orderedList(
                start = 7,
                listItem(
                    id = "parent",
                    text = "parent",
                    bulletList(
                        listItem(
                            id = "nested-parent",
                            text = "nested-parent",
                            orderedList(
                                start = 3,
                                listItem("deep-child", "deep-child"),
                            ),
                        ),
                        listItem("nested-sibling", "nested-sibling"),
                    ),
                ),
                listItem("next-root", "next-root"),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(source)
        val nestedParent = blocks.first { it.text == "nested-parent" }
        val rootParent = blocks.first { it.text == "parent" }

        val nestedDeleted = DocEditorOrchestrator.deleteBlock(blocks, nestedParent.id)
        val nestedReloaded = ProseMirrorParser.parseBlocks(
            ProseMirrorParser.serializeBlocks(nestedDeleted),
        )
        assertEquals(
            listOf("parent", "nested-sibling", "next-root"),
            nestedReloaded.map { it.text },
        )
        assertEquals(listOf(0, 1, 0), nestedReloaded.map { it.indentLevel })
        assertEquals(listOf(true, true, true), nestedReloaded.map { it.editable })

        val rootDeleted = DocEditorOrchestrator.deleteBlock(blocks, rootParent.id)
        val rootReloaded = ProseMirrorParser.parseBlocks(
            ProseMirrorParser.serializeBlocks(rootDeleted),
        )
        assertEquals(listOf("next-root"), rootReloaded.map { it.text })
        assertEquals(listOf(0), rootReloaded.map { it.indentLevel })
        assertEquals(listOf(true), rootReloaded.map { it.editable })
    }

    @Test
    fun `rich text cannot turn into code block while plain text still can`() {
        val markedBlocks = listOf(
            DocBlock(
                kind = BlockKind.PARAGRAPH,
                spans = listOf(InlineSpan("bold", listOf(InlineMark.Bold))),
            ),
            DocBlock(
                kind = BlockKind.PARAGRAPH,
                spans = listOf(InlineSpan("link", listOf(InlineMark.Link("https://www.example.com")))),
            ),
            DocBlock(
                kind = BlockKind.PARAGRAPH,
                spans = listOf(InlineSpan("a+b", listOf(InlineMark.Mathematics()))),
            ),
            DocBlock(
                kind = BlockKind.PARAGRAPH,
                spans = listOf(InlineSpan("future", listOf(InlineMark.Unknown("futureMark")))),
            ),
        )

        markedBlocks.forEach { marked ->
            assertEquals(
                "turn into code must fail closed for ${marked.spans.single().marks.single().kind}",
                listOf(marked),
                DocEditorOrchestrator.turnIntoBlock(
                    blocks = listOf(marked),
                    blockId = marked.id,
                    newKind = BlockKind.CODE_BLOCK,
                ),
            )
        }

        val plain = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("plain")),
        )
        val converted = DocEditorOrchestrator.turnIntoBlock(
            blocks = listOf(plain),
            blockId = plain.id,
            newKind = BlockKind.CODE_BLOCK,
        ).single()

        assertEquals(BlockKind.CODE_BLOCK, converted.kind)
        assertEquals("plain", converted.text)
    }

    @Test
    fun `canonical text alignment survives split duplicate and text block conversions`() {
        listOf("left", "center", "right", "justify").forEach { alignment ->
            val sourceAttributes = buildJsonObject { put("textAlign", alignment) }
            val original = DocBlock(
                blockId = "persisted-$alignment",
                kind = BlockKind.PARAGRAPH,
                spans = listOf(InlineSpan("前后")),
                sourceAttributes = sourceAttributes,
            )

            val (splitBlocks, splitTail) = DocEditorOrchestrator.splitBlock(
                blocks = listOf(original),
                blockId = original.id,
                cursorPosition = 1,
                spans = original.spans,
            )
            val (_, duplicated) = DocEditorOrchestrator.duplicateBlock(
                blocks = listOf(original),
                blockId = original.id,
            )

            assertEquals(sourceAttributes, splitBlocks.first().sourceAttributes)
            assertEquals(sourceAttributes, splitTail.sourceAttributes)
            assertNull("分裂出的新块不得复制持久化身份", splitTail.blockId)
            assertEquals(sourceAttributes, requireNotNull(duplicated).sourceAttributes)
            assertNull("复制出的新块不得复制持久化身份", duplicated.blockId)

            listOf(
                BlockKind.HEADING2,
                BlockKind.BULLET_ITEM,
                BlockKind.ORDERED_ITEM,
                BlockKind.TODO_ITEM,
                BlockKind.BLOCKQUOTE,
            ).forEach { targetKind ->
                val converted = DocEditorOrchestrator.turnIntoBlock(
                    blocks = listOf(original),
                    blockId = original.id,
                    newKind = targetKind,
                ).single()

                assertEquals(
                    "$alignment 转换到 $targetKind 后不得丢失对齐",
                    sourceAttributes,
                    converted.sourceAttributes,
                )
            }
        }
    }

    @Test
    fun `aligned text fails closed when code conversion cannot serialize alignment`() {
        listOf("left", "center", "right", "justify").forEach { alignment ->
            val aligned = DocBlock(
                kind = BlockKind.PARAGRAPH,
                spans = listOf(InlineSpan("plain")),
                sourceAttributes = buildJsonObject { put("textAlign", alignment) },
            )

            assertEquals(
                "$alignment 文本不得转换到不消费 textAlign 的 codeBlock",
                listOf(aligned),
                DocEditorOrchestrator.turnIntoBlock(
                    blocks = listOf(aligned),
                    blockId = aligned.id,
                    newKind = BlockKind.CODE_BLOCK,
                ),
            )

            val markdownSource = aligned.copy(spans = listOf(InlineSpan("``` ")))
            val shortcut = DocEditorOrchestrator.applyMarkdownShortcut(
                blocks = listOf(markdownSource),
                blockId = markdownSource.id,
                text = "``` ",
                targetKind = BlockKind.CODE_BLOCK,
                prefixLength = 4,
            )
            assertEquals(
                "$alignment 文本不得通过 Markdown 快捷语法绕过 codeBlock 门禁",
                listOf(markdownSource),
                shortcut.blocks,
            )
        }
    }

    @Test
    fun `aligned text rejects divider markdown shortcuts that cannot serialize alignment`() {
        listOf("left", "center", "right", "justify").forEach { alignment ->
            val sourceAttributes = buildJsonObject { put("textAlign", alignment) }
            listOf("---", "***").forEach { marker ->
                val source = DocBlock(
                    kind = BlockKind.PARAGRAPH,
                    spans = listOf(InlineSpan(marker)),
                    sourceAttributes = sourceAttributes,
                )

                val result = DocEditorOrchestrator.applyMarkdownShortcut(
                    blocks = listOf(source),
                    blockId = source.id,
                    text = marker,
                    targetKind = BlockKind.DIVIDER,
                    prefixLength = marker.length,
                )

                assertEquals(
                    "$alignment 文本不得通过 $marker 静默丢弃对齐",
                    listOf(source),
                    result.blocks,
                )
                assertEquals(sourceAttributes, result.blocks.single().sourceAttributes)
                assertEquals(source.id, result.focusBlockId)
                assertNull("拒绝转换时不得产生光标替换位置", result.cursorPosition)
            }
        }
    }

    @Test
    fun `divider markdown shortcut preserves persistent block identity`() {
        val paragraph = DocBlock(
            id = "runtime-paragraph-id",
            blockId = "persisted-paragraph-id",
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("---")),
            sourceAttributes = buildJsonObject {
                put("textAlign", JsonNull)
            },
        )

        val result = DocEditorOrchestrator.applyMarkdownShortcut(
            blocks = listOf(paragraph),
            blockId = paragraph.id,
            text = "---",
            targetKind = BlockKind.DIVIDER,
            prefixLength = 3,
        )

        val divider = result.blocks.first()
        val trailingParagraph = result.blocks.last()
        assertEquals("runtime-paragraph-id", divider.id)
        assertEquals("persisted-paragraph-id", divider.blockId)
        assertEquals(BlockKind.DIVIDER, divider.kind)
        assertEquals("", divider.text)
        assertNull(divider.sourceAttributes)
        assertNotEquals(paragraph.id, trailingParagraph.id)
        assertNull(trailingParagraph.blockId)
        assertEquals(trailingParagraph.id, result.focusBlockId)

        val serialized = ProseMirrorParser.serializeBlocks(result.blocks)
            .getValue("content").jsonArray
        assertEquals(
            "persisted-paragraph-id",
            serialized.first().jsonObject.getValue("attrs").jsonObject
                .getValue("blockId").jsonPrimitive.content,
        )
        assertNull(serialized.last().jsonObject["attrs"])
    }

    @Test
    fun `adding bold across a formula normalizes existing marks without duplicates`() {
        val mathematics = InlineMark.Mathematics(atomId = "formula-atom")
        val block = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(
                InlineSpan("x", listOf(InlineMark.Bold)),
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
        assertEquals(
            1,
            updated.spans.maxOf { span -> span.marks.count { it == InlineMark.Bold } },
        )

        val serialized = ProseMirrorParser.serializeBlocks(listOf(updated))
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray
        val textNodes = serialized.filter { node ->
            node.jsonObject.getValue("type").jsonPrimitive.content == "text"
        }
        assertEquals(2, textNodes.size)
        textNodes.forEach { node ->
            assertEquals(1, node.jsonObject.getValue("marks").jsonArray.size)
        }
        assertEquals(
            "a+b",
            serialized.single { node ->
                node.jsonObject.getValue("type").jsonPrimitive.content == "mathematics"
            }.jsonObject.getValue("attrs").jsonObject.getValue("latex").jsonPrimitive.content,
        )
    }

    @Test
    fun `toggle bold skips unknown mark range and keeps its identity`() {
        val unknown = InlineMark.Unknown("futureMark", mapOf("weight" to 9, "source" to "ai"))
        val block = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(
                InlineSpan("前", listOf()),
                InlineSpan("未知标记", listOf(unknown)),
                InlineSpan("后"),
            ),
        )

        val updated = DocEditorOrchestrator.toggleMark(
            blocks = listOf(block),
            blockId = block.id,
            markKind = InlineMarkKind.BOLD,
            selStart = 0,
            selEnd = 7,
        ).single()

        assertEquals(
            listOf(
                InlineSpan("前", listOf(InlineMark.Bold)),
                InlineSpan("未知标记", listOf(unknown)),
                InlineSpan("后", listOf(InlineMark.Bold)),
            ),
            updated.spans,
        )
        val serialized = ProseMirrorParser.serializeBlocks(listOf(updated))
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray.filterIsInstance<JsonObject>()
        val future = serialized
            .flatMap { (it["marks"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty() }
            .single { it["type"]?.jsonPrimitive?.contentOrNull == "futureMark" }
        assertEquals("ai", future.getValue("attrs").jsonObject["source"]?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun `paragraph does not merge into raw unsupported block or lose its content`() {
        val unsupported = DocBlock(
            kind = BlockKind.UNSUPPORTED,
            rawNode = mapOf(
                "type" to "futureBlock",
                "attrs" to mapOf("blockId" to "future-block-id"),
                "content" to listOf(
                    mapOf(
                        "type" to "paragraph",
                        "content" to listOf(mapOf("type" to "text", "text" to "opaque")),
                    ),
                ),
            ),
            unsupportedType = "futureBlock",
            editable = false,
        )
        val paragraph = DocBlock(
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("must survive")),
        )
        val original = listOf(unsupported, paragraph)
        val serializedBefore = ProseMirrorParser.serializeBlocks(original)

        val (updated, focusBlockId, cursorPosition) =
            DocEditorOrchestrator.mergeWithPrevious(original, paragraph.id)

        assertEquals(original, updated)
        assertEquals(paragraph.id, focusBlockId)
        assertEquals(0, cursorPosition)
        assertEquals(serializedBefore, ProseMirrorParser.serializeBlocks(updated))
    }

    @Test
    fun `table with persisted inner block identities cannot be duplicated`() {
        val table = DocBlock(
            blockId = "table-block-id",
            kind = BlockKind.TABLE,
            rawNode = mapOf(
                "type" to "table",
                "attrs" to mapOf("blockId" to "table-block-id"),
            ),
            tableData = TableData(
                rows = listOf(
                    TableRow(
                        cells = listOf(
                            TableCell(
                                text = "cell",
                                spans = listOf(InlineSpan("cell")),
                                rawNode = mapOf(
                                    "type" to "tableCell",
                                    "attrs" to mapOf("blockId" to "cell-block-id"),
                                ),
                                rawParagraph = mapOf(
                                    "type" to "paragraph",
                                    "attrs" to mapOf("blockId" to "paragraph-block-id"),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
        val original = listOf(table)

        val (updated, duplicate) = DocEditorOrchestrator.duplicateBlock(original, table.id)

        assertEquals(original, updated)
        assertNull(duplicate)
    }

    @Test
    fun `split and duplicate preserve semantic attrs without copying persisted identity`() {
        val source = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "paragraph")
                    put("attrs", buildJsonObject {
                        put("blockId", "old-block-id")
                        put("textAlign", JsonNull)
                    })
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "text")
                            put("text", "前后")
                        })
                    })
                })
            })
        }
        val original = ProseMirrorParser.parseBlocks(source).single()

        val (splitBlocks, splitTail) = DocEditorOrchestrator.splitBlock(
            listOf(original),
            original.id,
            1,
            original.spans,
        )
        val (_, duplicate) = DocEditorOrchestrator.duplicateBlock(listOf(original), original.id)
        val nodes = ProseMirrorParser.serializeBlocks(splitBlocks + requireNotNull(duplicate))
            .getValue("content").jsonArray

        assertEquals("old-block-id", nodes[0].jsonObject.getValue("attrs").jsonObject["blockId"]?.toString()?.trim('"'))
        listOf(nodes[1], nodes[2]).forEach { node ->
            val attrs = node.jsonObject.getValue("attrs").jsonObject
            assertNull("新块不得复制旧 blockId", attrs["blockId"])
            assertEquals(JsonNull, attrs["textAlign"])
        }
        assertEquals(splitTail.id, splitBlocks[1].id)
    }

    @Test
    fun `ordered list split and duplicate preserve start without copying persisted identity`() {
        val original = DocBlock(
            blockId = "persisted-list-item",
            kind = BlockKind.ORDERED_ITEM,
            spans = listOf(InlineSpan("前后")),
            listStart = 7,
            listContainerId = "ordered-list-container",
            indentLevel = 2,
            sourceAttributes = buildJsonObject {
                put("blockId", "persisted-list-item")
                put("textAlign", JsonNull)
            },
        )

        val (splitBlocks, splitTail) = DocEditorOrchestrator.splitBlock(
            blocks = listOf(original),
            blockId = original.id,
            cursorPosition = 1,
            spans = original.spans,
        )
        val (_, duplicate) = DocEditorOrchestrator.duplicateBlock(listOf(original), original.id)

        assertEquals(7, splitTail.listStart)
        assertEquals("ordered-list-container", splitTail.listContainerId)
        assertEquals(2, splitTail.indentLevel)
        assertNull(splitTail.blockId)
        assertNull((splitTail.sourceAttributes as? kotlinx.serialization.json.JsonObject)?.get("blockId"))

        val copied = requireNotNull(duplicate)
        assertEquals(7, copied.listStart)
        assertEquals("ordered-list-container", copied.listContainerId)
        assertEquals(2, copied.indentLevel)
        assertNull(copied.blockId)
        assertNull((copied.sourceAttributes as? kotlinx.serialization.json.JsonObject)?.get("blockId"))

        val topLevel = ProseMirrorParser.serializeBlocks(splitBlocks + copied)
            .getValue("content").jsonArray
        assertEquals("分裂和复制的列表项仍属于同一 orderedList", 1, topLevel.size)
        val orderedList = topLevel.single().jsonObject
        assertEquals("orderedList", orderedList.getValue("type").jsonPrimitive.content)
        assertEquals(7, orderedList.getValue("attrs").jsonObject.getValue("start").jsonPrimitive.content.toInt())
        assertEquals(3, orderedList.getValue("content").jsonArray.size)
    }

    @Test
    fun `new and duplicated quotes receive independent runtime containers`() {
        val anchor = DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("anchor")))
        val source = DocBlock(
            kind = BlockKind.BLOCKQUOTE,
            spans = listOf(InlineSpan("source")),
            quoteContainerId = "source-quote",
        )

        val (_, created) = DocEditorOrchestrator.createBlock(
            blocks = listOf(anchor),
            afterBlockId = anchor.id,
            kind = BlockKind.BLOCKQUOTE,
        )
        val (_, duplicated) = DocEditorOrchestrator.duplicateBlock(listOf(source), source.id)

        assertNotNull(created.quoteContainerId)
        assertNotEquals(source.quoteContainerId, created.quoteContainerId)
        assertNotNull(requireNotNull(duplicated).quoteContainerId)
        assertNotEquals(source.quoteContainerId, duplicated.quoteContainerId)

        val serialized = ProseMirrorParser.serializeBlocks(listOf(source, duplicated))
            .getValue("content").jsonArray
        assertEquals("independent quote containers must not be merged", 2, serialized.size)
    }

    private fun doc(vararg nodes: JsonObject): JsonObject = buildJsonObject {
        put("type", "doc")
        put("content", buildJsonArray { nodes.forEach(::add) })
    }

    private fun nestedParentDocument(): JsonObject = doc(
        orderedList(
            start = 7,
            listItem(
                id = "parent-a",
                text = "parent-a",
                orderedList(
                    start = 3,
                    listItem("child-a", "child-a"),
                ),
            ),
            listItem("parent-b", "parent-b"),
        ),
    )

    private fun orderedList(start: Int, vararg items: JsonObject): JsonObject = buildJsonObject {
        put("type", "orderedList")
        put("attrs", buildJsonObject {
            put("start", start)
        })
        put("content", buildJsonArray { items.forEach(::add) })
    }

    private fun bulletList(vararg items: JsonObject): JsonObject = buildJsonObject {
        put("type", "bulletList")
        put("content", buildJsonArray { items.forEach(::add) })
    }

    private fun paragraph(text: String): JsonObject = buildJsonObject {
        put("type", "paragraph")
        if (text.isNotEmpty()) {
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "text")
                    put("text", text)
                })
            })
        }
    }

    private fun listItem(id: String, text: String, vararg children: JsonObject): JsonObject =
        buildJsonObject {
            put("type", "listItem")
            put("attrs", buildJsonObject { put("blockId", id) })
            put("content", buildJsonArray {
                add(paragraph(text))
                children.forEach(::add)
            })
        }
}
