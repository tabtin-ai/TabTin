package com.tabtin.mobile.features.doc.editor.core

import com.tabtin.mobile.features.doc.editor.DocEditorOrchestrator
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.DocTextAlignment
import com.tabtin.mobile.features.doc.model.InlineMark
import com.tabtin.mobile.features.doc.model.InlineSpan
import com.tabtin.mobile.features.doc.model.ProseMirrorParser
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BlockViewConverterTest {

    @Test
    fun `heading levels three through six preserve their distinct view semantics and text state`() {
        val cases = listOf(
            BlockKind.HEADING3 to TabDocBlockView.Text.HeaderThree::class,
            BlockKind.HEADING4 to TabDocBlockView.Text.HeaderFour::class,
            BlockKind.HEADING5 to TabDocBlockView.Text.HeaderFive::class,
            BlockKind.HEADING6 to TabDocBlockView.Text.HeaderSix::class,
        )

        val views = cases.mapIndexed { index, (kind, expectedViewClass) ->
            val id = "heading-${index + 3}"
            val body = "Heading ${index + 3}"
            val block = DocBlock(
                id = id,
                kind = kind,
                spans = listOf(InlineSpan(body, marks = listOf(InlineMark.Bold))),
                indentLevel = index + 1,
            )

            val view = BlockViewConverter.toBlockViews(
                blocks = listOf(block),
                focusedBlockId = id,
                cursorPosition = index + 2,
                selectedBlockIds = setOf(id),
            ).single()

            assertTrue("$kind must map to ${expectedViewClass.simpleName}", expectedViewClass.isInstance(view))
            assertTextState(
                view = view,
                id = id,
                body = body,
                cursor = index + 2,
                indent = index + 1,
            )
            view
        }

        assertEquals(
            "H3–H6 must each have a dedicated RecyclerView type",
            views.size,
            views.map { it.getViewType() }.toSet().size,
        )
    }

    @Test
    fun `ordered numbering follows starts and container identity across nested lists`() {
        fun ordered(
            id: String,
            containerId: String,
            start: Int,
            indent: Int,
        ): DocBlock = DocBlock(
            id = id,
            kind = BlockKind.ORDERED_ITEM,
            spans = listOf(InlineSpan(id)),
            listStart = start,
            listContainerId = containerId,
            indentLevel = indent,
        )

        val views = BlockViewConverter.toBlockViews(
            listOf(
                ordered("outer-1", "outer", start = 7, indent = 0),
                ordered("nested-1", "nested", start = 3, indent = 1),
                ordered("nested-2", "nested", start = 3, indent = 1),
                ordered("outer-2", "outer", start = 7, indent = 0),
                ordered("adjacent", "adjacent", start = 9, indent = 0),
            ),
        ).map { (it as TabDocBlockView.Text.Numbered).number }

        assertEquals(listOf(7, 3, 4, 8, 9), views)
    }

    @Test
    fun `legacy ordered numbering survives nested bullet but resets after same level bullet`() {
        val blocks = listOf(
            DocBlock(
                id = "legacy-outer-1",
                kind = BlockKind.ORDERED_ITEM,
                listStart = 7,
                listContainerId = null,
                indentLevel = 0,
            ),
            DocBlock(id = "nested-bullet", kind = BlockKind.BULLET_ITEM, indentLevel = 1),
            DocBlock(
                id = "legacy-outer-2",
                kind = BlockKind.ORDERED_ITEM,
                listStart = 7,
                listContainerId = null,
                indentLevel = 0,
            ),
            DocBlock(id = "top-bullet", kind = BlockKind.BULLET_ITEM, indentLevel = 0),
            DocBlock(
                id = "legacy-new-list",
                kind = BlockKind.ORDERED_ITEM,
                listStart = 7,
                listContainerId = null,
                indentLevel = 0,
            ),
        )

        val numbers = BlockViewConverter.toBlockViews(blocks)
            .filterIsInstance<TabDocBlockView.Text.Numbered>()
            .map(TabDocBlockView.Text.Numbered::number)

        assertEquals(listOf(7, 8, 7), numbers)
    }

    @Test
    fun `ordered numbering resets across an independent same-level list before and after reload`() {
        val canonical = listOf(
            DocBlock(
                id = "ordered-a",
                kind = BlockKind.ORDERED_ITEM,
                spans = listOf(InlineSpan("ordered-a")),
                listStart = 7,
                listContainerId = "ordered-container",
            ),
            DocBlock(
                id = "ordered-b",
                kind = BlockKind.ORDERED_ITEM,
                spans = listOf(InlineSpan("ordered-b")),
                listStart = 7,
                listContainerId = "ordered-container",
            ),
        )
        val parsed = ProseMirrorParser.parseBlocks(ProseMirrorParser.serializeBlocks(canonical))
        val (created, _) = DocEditorOrchestrator.createBlock(
            blocks = parsed,
            afterBlockId = parsed.first().id,
            kind = BlockKind.BULLET_ITEM,
        )

        val beforeReload = BlockViewConverter.toBlockViews(created)
            .filterIsInstance<TabDocBlockView.Text.Numbered>()
            .map(TabDocBlockView.Text.Numbered::number)
        val reloaded = ProseMirrorParser.parseBlocks(ProseMirrorParser.serializeBlocks(created))
        val afterReload = BlockViewConverter.toBlockViews(reloaded)
            .filterIsInstance<TabDocBlockView.Text.Numbered>()
            .map(TabDocBlockView.Text.Numbered::number)

        assertEquals(listOf(7, 7), beforeReload)
        assertEquals(beforeReload, afterReload)
    }

    @Test
    fun `image projection carries per block readonly state and file identity`() {
        val views = BlockViewConverter.toBlockViews(
            listOf(
                DocBlock(
                    id = "existing-image",
                    kind = BlockKind.IMAGE,
                    imageFileId = "file-history",
                    editable = false,
                ),
                DocBlock(
                    id = "new-image",
                    kind = BlockKind.IMAGE,
                    editable = true,
                ),
            ),
        ).map { it as TabDocBlockView.Image }

        assertEquals("file-history", views[0].fileId)
        assertTrue(views[0].isReadOnly)
        assertFalse(views[1].isReadOnly)
    }

    @Test
    fun `table projection is always readonly even when its schema is editable`() {
        val view = BlockViewConverter.toBlockViews(
            listOf(
                DocBlock(
                    id = "simple-table",
                    kind = BlockKind.TABLE,
                    editable = true,
                ),
            ),
        ).single() as TabDocBlockView.Table

        assertTrue("移动端原生云文档不开放表格编辑", view.isReadonly)
    }

    @Test
    fun `all text view subtypes retain canonical alignment while null stays natural`() {
        val textKinds = listOf(
            BlockKind.PARAGRAPH,
            BlockKind.HEADING1,
            BlockKind.HEADING2,
            BlockKind.HEADING3,
            BlockKind.HEADING4,
            BlockKind.HEADING5,
            BlockKind.HEADING6,
            BlockKind.BULLET_ITEM,
            BlockKind.ORDERED_ITEM,
            BlockKind.TODO_ITEM,
            BlockKind.BLOCKQUOTE,
        )

        textKinds.forEach { kind ->
            fun convert(alignment: String?, explicitNull: Boolean = false): TabDocBlockView.Text {
                val sourceAttributes = when {
                    explicitNull -> buildJsonObject { put("textAlign", JsonNull) }
                    alignment != null -> buildJsonObject { put("textAlign", alignment) }
                    else -> null
                }
                return BlockViewConverter.toBlockViews(
                    listOf(
                        DocBlock(
                            id = "same-id",
                            kind = kind,
                            spans = listOf(InlineSpan("same body")),
                            sourceAttributes = sourceAttributes,
                        ),
                    ),
                ).single() as TabDocBlockView.Text
            }

            val natural = convert(null)
            assertEquals("$kind 缺失 textAlign 必须保持自然起点", null, natural.alignment)
            assertEquals(
                "$kind 的 textAlign 缺失与显式 null 应投影为同一自然起点",
                natural,
                convert(null, explicitNull = true),
            )

            val aligned = listOf(
                "left" to DocTextAlignment.LEFT,
                "center" to DocTextAlignment.CENTER,
                "right" to DocTextAlignment.RIGHT,
                "justify" to DocTextAlignment.JUSTIFY,
            ).map { (serialized, expected) ->
                convert(serialized).also { view ->
                    assertEquals("$kind 必须精确投影 $serialized", expected, view.alignment)
                }
            }
            assertEquals("$kind 必须区分四个正典对齐值", 4, aligned.toSet().size)
            aligned.forEach { view ->
                assertNotEquals("$kind 的显式对齐不能塌缩成自然起点", natural, view)
            }
        }
    }

    private fun assertTextState(
        view: TabDocBlockView,
        id: String,
        body: String,
        cursor: Int,
        indent: Int,
    ) {
        assertEquals(id, view.id)
        assertTrue(view is TabDocBlockView.TextSupport)
        assertTrue(view is TabDocBlockView.Focusable)
        assertTrue(view is TabDocBlockView.Indentable)
        assertTrue(view is TabDocBlockView.Selectable)

        val textView = view as TabDocBlockView.TextSupport
        assertEquals(body, textView.body)
        assertEquals(listOf(TabDocMarkup.Mark.Bold(0, body.length)), textView.marks)

        val focusableView = view as TabDocBlockView.Focusable
        assertTrue(focusableView.isFocused)
        assertEquals(cursor, focusableView.cursor)

        val indentableView = view as TabDocBlockView.Indentable
        assertEquals(indent, indentableView.indent)

        val selectableView = view as TabDocBlockView.Selectable
        assertTrue(selectableView.isSelected)
    }
}
