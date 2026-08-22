package com.tabtin.mobile.features.doc.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ProseMirrorParserTest {

    private fun buildDoc(vararg nodes: JsonElement): JsonObject = buildJsonObject {
        put("type", "doc")
        put("content", buildJsonArray { nodes.forEach { add(it) } })
    }

    private fun paragraph(vararg inlines: JsonObject): JsonObject = buildJsonObject {
        put("type", "paragraph")
        put("content", buildJsonArray { inlines.forEach { add(it) } })
    }

    private fun textNode(text: String): JsonObject = buildJsonObject {
        put("type", "text")
        put("text", text)
    }

    private fun numberLiteral(value: String): JsonElement = Json.parseToJsonElement(value)

    private fun mathNode(latex: String, display: Boolean = false): JsonObject = buildJsonObject {
        put("type", "mathematics")
        put("attrs", buildJsonObject {
            put("latex", latex)
            put("display", display)
        })
    }

    private fun listItem(vararg children: JsonObject): JsonObject = buildJsonObject {
        put("type", "listItem")
        put("content", buildJsonArray { children.forEach { add(it) } })
    }

    private fun taskItem(checked: Boolean, vararg children: JsonObject): JsonObject = buildJsonObject {
        put("type", "taskItem")
        put("attrs", buildJsonObject { put("checked", checked) })
        put("content", buildJsonArray { children.forEach { add(it) } })
    }

    private fun bulletList(vararg items: JsonObject): JsonObject = buildJsonObject {
        put("type", "bulletList")
        put("content", buildJsonArray { items.forEach { add(it) } })
    }

    private fun orderedList(vararg items: JsonObject): JsonObject = buildJsonObject {
        put("type", "orderedList")
        put("content", buildJsonArray { items.forEach { add(it) } })
    }

    private fun taskList(vararg items: JsonObject): JsonObject = buildJsonObject {
        put("type", "taskList")
        put("content", buildJsonArray { items.forEach { add(it) } })
    }

    @Test
    fun `html block stays intact as unsupported across attrs shapes`() {
        listOf<JsonElement>(
            buildJsonObject {
                put("fileId", "file-001")
                put("src", "https://oss.example.com/demo.html")
                put("title", "demo")
                put("height", 480)
            },
            JsonNull,
            JsonPrimitive("not-an-object"),
            buildJsonArray { add("not-an-object") },
        ).forEach { attrs ->
            val document = buildDoc(
                buildJsonObject {
                    put("type", "htmlBlock")
                    put("attrs", attrs)
                },
            )

            val block = ProseMirrorParser.parseBlocks(document).single()

            assertEquals(BlockKind.UNSUPPORTED, block.kind)
            assertEquals("htmlBlock", block.unsupportedType)
            assertEquals(document, ProseMirrorParser.serializeBlocks(listOf(block)))
        }
    }

    @Test
    fun `primitive root node survives editing a supported sibling`() {
        val opaqueRootNode = JsonPrimitive("opaque-root")
        val document = buildDoc(paragraph(textNode("before")), opaqueRootNode)

        val blocks = ProseMirrorParser.parseBlocks(document)
        val edited = blocks.map { block ->
            if (block.kind == BlockKind.PARAGRAPH) {
                block.copy(spans = listOf(InlineSpan("after")))
            } else {
                block
            }
        }

        assertEquals(
            buildDoc(paragraph(textNode("after")), opaqueRootNode),
            ProseMirrorParser.serializeBlocks(edited),
        )
    }

    @Test
    fun `root object without type survives editing a supported sibling`() {
        val opaqueRootNode = buildJsonObject {
            put("attrs", buildJsonObject { put("futureSchema", true) })
            put("payload", buildJsonArray { add(1); add("two") })
        }
        val document = buildDoc(paragraph(textNode("before")), opaqueRootNode)

        val blocks = ProseMirrorParser.parseBlocks(document)
        val edited = blocks.map { block ->
            if (block.kind == BlockKind.PARAGRAPH) {
                block.copy(spans = listOf(InlineSpan("after")))
            } else {
                block
            }
        }

        assertEquals(
            buildDoc(paragraph(textNode("after")), opaqueRootNode),
            ProseMirrorParser.serializeBlocks(edited),
        )
    }

    // ========== flattenListNode / nested list tests ==========

    @Test
    fun `flat bullet list parsed correctly`() {
        val doc = buildDoc(
            bulletList(
                listItem(paragraph(textNode("item 1"))),
                listItem(paragraph(textNode("item 2"))),
            )
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(2, blocks.size)
        assertEquals(BlockKind.BULLET_ITEM, blocks[0].kind)
        assertEquals("item 1", blocks[0].text)
        assertEquals(0, blocks[0].indentLevel)
        assertEquals("item 2", blocks[1].text)
        assertEquals(0, blocks[1].indentLevel)
    }

    @Test
    fun `table cell content reuses native document parser without mutating raw cell`() {
        val rawCell: Map<String, Any?> = mapOf(
            "type" to "tableCell",
            "attrs" to mapOf("colspan" to 1, "rowspan" to 1),
            "content" to listOf(
                mapOf(
                    "type" to "paragraph",
                    "content" to listOf(mapOf("type" to "text", "text" to "详情正文")),
                ),
                mapOf(
                    "type" to "bulletList",
                    "content" to listOf(
                        mapOf(
                            "type" to "listItem",
                            "content" to listOf(
                                mapOf(
                                    "type" to "paragraph",
                                    "content" to listOf(mapOf("type" to "text", "text" to "列表项")),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
        val snapshot = rawCell.toMap()

        val blocks = ProseMirrorParser.parseTableCellContent(rawCell)

        assertEquals(2, blocks.size)
        assertEquals(BlockKind.PARAGRAPH, blocks[0].kind)
        assertEquals("详情正文", blocks[0].text)
        assertEquals(BlockKind.BULLET_ITEM, blocks[1].kind)
        assertEquals("列表项", blocks[1].text)
        assertEquals(snapshot, rawCell)
    }

    @Test
    fun `nested bullet list preserves hierarchy`() {
        val doc = buildDoc(
            bulletList(
                listItem(
                    paragraph(textNode("parent")),
                    bulletList(
                        listItem(paragraph(textNode("child 1"))),
                        listItem(paragraph(textNode("child 2"))),
                    )
                )
            )
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(3, blocks.size)
        assertEquals("parent", blocks[0].text)
        assertEquals(0, blocks[0].indentLevel)
        assertEquals(BlockKind.BULLET_ITEM, blocks[0].kind)

        assertEquals("child 1", blocks[1].text)
        assertEquals(1, blocks[1].indentLevel)
        assertEquals(BlockKind.BULLET_ITEM, blocks[1].kind)

        assertEquals("child 2", blocks[2].text)
        assertEquals(1, blocks[2].indentLevel)
    }

    @Test
    fun `deeply nested lists preserve all levels`() {
        val doc = buildDoc(
            bulletList(
                listItem(
                    paragraph(textNode("L0")),
                    bulletList(
                        listItem(
                            paragraph(textNode("L1")),
                            bulletList(
                                listItem(paragraph(textNode("L2")))
                            )
                        )
                    )
                )
            )
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(3, blocks.size)
        assertEquals(0, blocks[0].indentLevel)
        assertEquals("L0", blocks[0].text)
        assertEquals(1, blocks[1].indentLevel)
        assertEquals("L1", blocks[1].text)
        assertEquals(2, blocks[2].indentLevel)
        assertEquals("L2", blocks[2].text)
    }

    @Test
    fun `mixed nested list types are preserved`() {
        val doc = buildDoc(
            bulletList(
                listItem(
                    paragraph(textNode("bullet parent")),
                    orderedList(
                        listItem(paragraph(textNode("ordered child")))
                    )
                )
            )
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(2, blocks.size)
        assertEquals(BlockKind.BULLET_ITEM, blocks[0].kind)
        assertEquals(0, blocks[0].indentLevel)
        assertEquals(BlockKind.ORDERED_ITEM, blocks[1].kind)
        assertEquals(1, blocks[1].indentLevel)
    }

    @Test
    fun `nested task list preserves checked state`() {
        val doc = buildDoc(
            taskList(
                taskItem(true,
                    paragraph(textNode("done")),
                    taskList(
                        taskItem(false, paragraph(textNode("not done")))
                    )
                )
            )
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(2, blocks.size)
        assertEquals(BlockKind.TODO_ITEM, blocks[0].kind)
        assertTrue(blocks[0].checked)
        assertEquals(0, blocks[0].indentLevel)
        assertEquals(BlockKind.TODO_ITEM, blocks[1].kind)
        assertFalse(blocks[1].checked)
        assertEquals(1, blocks[1].indentLevel)
    }

    @Test
    fun `multiple siblings after nested list`() {
        val doc = buildDoc(
            bulletList(
                listItem(
                    paragraph(textNode("first")),
                    bulletList(
                        listItem(paragraph(textNode("nested")))
                    )
                ),
                listItem(paragraph(textNode("second")))
            )
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(3, blocks.size)
        assertEquals("first", blocks[0].text)
        assertEquals(0, blocks[0].indentLevel)
        assertEquals("nested", blocks[1].text)
        assertEquals(1, blocks[1].indentLevel)
        assertEquals("second", blocks[2].text)
        assertEquals(0, blocks[2].indentLevel)
    }

    // ========== extractInlineSpans / math tests ==========

    @Test
    fun `mathematics node extracted with Mathematics mark`() {
        val para = paragraph(
            textNode("Energy: "),
            mathNode("E=mc^2"),
        )
        val spans = ProseMirrorParser.extractInlineSpans(para)
        assertEquals(2, spans.size)
        assertEquals("Energy: ", spans[0].text)
        assertEquals("E=mc^2", spans[1].text)
        assertTrue(spans[1].marks.any { it is InlineMark.Mathematics })
    }

    @Test
    fun `math node with text attr fallback`() {
        val para = buildJsonObject {
            put("type", "paragraph")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "math")
                    put("attrs", buildJsonObject { put("text", "x^2") })
                })
            })
        }
        val spans = ProseMirrorParser.extractInlineSpans(para)
        assertEquals(1, spans.size)
        assertEquals("x^2", spans[0].text)
        assertTrue(spans[0].marks.any { it is InlineMark.Mathematics })
    }

    @Test
    fun `empty latex mathematics is skipped`() {
        val para = paragraph(
            textNode("before"),
            mathNode(""),
            textNode("after"),
        )
        val spans = ProseMirrorParser.extractInlineSpans(para)
        assertEquals(2, spans.size)
        assertEquals("before", spans[0].text)
        assertEquals("after", spans[1].text)
    }

    @Test
    fun `unknown inline node is skipped without losing siblings`() {
        val para = buildJsonObject {
            put("type", "paragraph")
            put("content", buildJsonArray {
                add(textNode("before"))
                add(buildJsonObject {
                    put("type", "mention")
                    put("attrs", buildJsonObject { put("id", "user123") })
                })
                add(textNode("after"))
            })
        }
        val spans = ProseMirrorParser.extractInlineSpans(para)
        assertEquals(2, spans.size)
        assertEquals("before", spans[0].text)
        assertEquals("after", spans[1].text)
    }

    @Test
    fun `math mixed with styled text`() {
        val para = buildJsonObject {
            put("type", "paragraph")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "text")
                    put("text", "The formula ")
                    put("marks", buildJsonArray {
                        add(buildJsonObject { put("type", "bold") })
                    })
                })
                add(mathNode("a^2 + b^2 = c^2"))
                add(textNode(" is important"))
            })
        }
        val spans = ProseMirrorParser.extractInlineSpans(para)
        assertEquals(3, spans.size)
        assertEquals("The formula ", spans[0].text)
        assertTrue(spans[0].marks.contains(InlineMark.Bold))
        assertEquals("a^2 + b^2 = c^2", spans[1].text)
        assertTrue(spans[1].marks.any { it is InlineMark.Mathematics })
        assertEquals(" is important", spans[2].text)
    }

    // ========== blocksToMarkdown with indentLevel ==========

    @Test
    fun `blocksToMarkdown indents nested list items`() {
        val blocks = listOf(
            DocBlock(kind = BlockKind.BULLET_ITEM, spans = listOf(InlineSpan("parent")), indentLevel = 0),
            DocBlock(kind = BlockKind.BULLET_ITEM, spans = listOf(InlineSpan("child")), indentLevel = 1),
            DocBlock(kind = BlockKind.BULLET_ITEM, spans = listOf(InlineSpan("grandchild")), indentLevel = 2),
        )
        val md = ProseMirrorParser.blocksToMarkdown(blocks)
        assertTrue(md.contains("- parent"))
        assertTrue(md.contains("  - child"))
        assertTrue(md.contains("    - grandchild"))
    }

    @Test
    fun `blocksToMarkdown indents nested ordered list`() {
        val blocks = listOf(
            DocBlock(kind = BlockKind.ORDERED_ITEM, spans = listOf(InlineSpan("top")), indentLevel = 0),
            DocBlock(kind = BlockKind.ORDERED_ITEM, spans = listOf(InlineSpan("sub")), indentLevel = 1),
        )
        val md = ProseMirrorParser.blocksToMarkdown(blocks)
        assertTrue(md.contains("1. top"))
        assertTrue(md.contains("  1. sub"))
    }

    // ========== blockId round-trip ==========

    @Test
    fun `paragraph blockId is parsed and preserved`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "paragraph")
                put("attrs", buildJsonObject { put("blockId", "blk-001") })
                put("content", buildJsonArray { add(textNode("hello")) })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks.size)
        assertEquals("blk-001", blocks[0].blockId)
    }

    @Test
    fun `heading blockId is parsed and preserved`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "heading")
                put("attrs", buildJsonObject { put("level", 2); put("blockId", "blk-h2") })
                put("content", buildJsonArray { add(textNode("Title")) })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks.size)
        assertEquals(BlockKind.HEADING2, blocks[0].kind)
        assertEquals("blk-h2", blocks[0].blockId)
    }

    @Test
    fun `list item blockId is parsed and preserved`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "bulletList")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "listItem")
                        put("attrs", buildJsonObject { put("blockId", "blk-li1") })
                        put("content", buildJsonArray { add(paragraph(textNode("item"))) })
                    })
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks.size)
        assertEquals("blk-li1", blocks[0].blockId)
    }

    @Test
    fun `blockId survives parse-serialize round-trip for paragraph`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "paragraph")
                put("attrs", buildJsonObject { put("blockId", "blk-rt") })
                put("content", buildJsonArray { add(textNode("round trip")) })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val node = reserialized["content"]!!.jsonArray[0].jsonObject
        assertEquals("blk-rt", node["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `blockId survives parse-serialize round-trip for code block`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "codeBlock")
                put("attrs", buildJsonObject { put("language", "kotlin"); put("blockId", "blk-code") })
                put("content", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", "val x = 1") }) })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals("blk-code", blocks[0].blockId)
        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val attrs = reserialized["content"]!!.jsonArray[0].jsonObject["attrs"]!!.jsonObject
        assertEquals("blk-code", attrs["blockId"]!!.jsonPrimitive.content)
        assertEquals("kotlin", attrs["language"]!!.jsonPrimitive.content)
    }

    @Test
    fun `blockId survives parse-serialize round-trip for list item`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "bulletList")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "listItem")
                        put("attrs", buildJsonObject { put("blockId", "blk-li") })
                        put("content", buildJsonArray { add(paragraph(textNode("item"))) })
                    })
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals("blk-li", blocks[0].blockId)
        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val listNode = reserialized["content"]!!.jsonArray[0].jsonObject
        val listItemNode = listNode["content"]!!.jsonArray[0].jsonObject
        assertEquals("blk-li", listItemNode["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `missing blockId defaults to null`() {
        val doc = buildDoc(paragraph(textNode("no blockId")))
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertNull(blocks[0].blockId)
    }

    @Test
    fun `no attrs emitted when blockId is null`() {
        val blocks = listOf(DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("plain"))))
        val json = ProseMirrorParser.serializeBlocks(blocks)
        val node = json["content"]!!.jsonArray[0].jsonObject
        assertNull(node["attrs"])
    }

    @Test
    fun `divider blockId round-trip`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "horizontalRule")
                put("attrs", buildJsonObject { put("blockId", "blk-hr") })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals("blk-hr", blocks[0].blockId)
        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val node = reserialized["content"]!!.jsonArray[0].jsonObject
        assertEquals("blk-hr", node["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `legacy top level image is read only and survives round trip`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "image")
                put("attrs", buildJsonObject {
                    put("src", "https://example.com/img.png")
                    put("blockId", "blk-img")
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(BlockKind.UNSUPPORTED, blocks[0].kind)
        assertFalse(blocks[0].canDeleteWholeBlock)
        assertEquals("blk-img", blocks[0].blockId)
        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val node = reserialized["content"]!!.jsonArray[0].jsonObject
        assertEquals("image", node["type"]!!.jsonPrimitive.content)
        assertEquals("blk-img", node["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
    }

    // ========== serializeBlocks round-trip ==========

    @Test
    fun `unsupported block survives round trip without dropping nested payload`() {
        val unsupported = buildJsonObject {
            put("type", "tabDataEmbed")
            put("attrs", buildJsonObject {
                put("tableId", "table-42")
                put("viewId", "view-kanban")
                put("readonly", true)
            })
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "paragraph")
                    put("content", buildJsonArray { add(textNode("fallback preview")) })
                })
            })
        }
        val doc = buildDoc(
            paragraph(textNode("before")),
            unsupported,
            paragraph(textNode("after")),
        )

        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(BlockKind.UNSUPPORTED, blocks[1].kind)

        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        assertEquals(unsupported, reserialized["content"]!!.jsonArray[1].jsonObject)
    }

    @Test
    fun `nested list round-trip produces nested structure`() {
        val blocks = listOf(
            DocBlock(kind = BlockKind.BULLET_ITEM, spans = listOf(InlineSpan("parent")), indentLevel = 0),
            DocBlock(kind = BlockKind.BULLET_ITEM, spans = listOf(InlineSpan("child")), indentLevel = 1),
        )
        val json = ProseMirrorParser.serializeBlocks(blocks)
        val content = json["content"]!!.jsonArray
        assertEquals(1, content.size)
        val bulletList = content[0].jsonObject
        assertEquals("bulletList", bulletList["type"]!!.jsonPrimitive.content)
        val items = bulletList["content"]!!.jsonArray
        assertEquals(1, items.size)
        val item = items[0].jsonObject
        val itemContent = item["content"]!!.jsonArray
        assertEquals(2, itemContent.size)
        assertEquals("paragraph", itemContent[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("bulletList", itemContent[1].jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun `parse then serialize nested list is structurally correct`() {
        val doc = buildDoc(
            bulletList(
                listItem(
                    paragraph(textNode("parent")),
                    orderedList(
                        listItem(paragraph(textNode("child")))
                    )
                )
            )
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(2, blocks.size)

        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val topContent = reserialized["content"]!!.jsonArray
        assertEquals(1, topContent.size)
        val bl = topContent[0].jsonObject
        assertEquals("bulletList", bl["type"]!!.jsonPrimitive.content)

        val listItemNode = bl["content"]!!.jsonArray[0].jsonObject
        val listItemContent = listItemNode["content"]!!.jsonArray
        assertEquals(2, listItemContent.size)
        assertEquals("paragraph", listItemContent[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("orderedList", listItemContent[1].jsonObject["type"]!!.jsonPrimitive.content)
    }

    // ========== AND-003: subscript/superscript round-trip ==========

    @Test
    fun `subscript mark parsed and serialized`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "paragraph")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "text")
                        put("text", "H")
                    })
                    add(buildJsonObject {
                        put("type", "text")
                        put("text", "2")
                        put("marks", buildJsonArray {
                            add(buildJsonObject { put("type", "subscript") })
                        })
                    })
                    add(buildJsonObject {
                        put("type", "text")
                        put("text", "O")
                    })
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks.size)
        assertEquals(3, blocks[0].spans.size)
        assertEquals("2", blocks[0].spans[1].text)
        assertTrue(blocks[0].spans[1].marks.contains(InlineMark.Subscript))

        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val inlines = reserialized["content"]!!.jsonArray[0].jsonObject["content"]!!.jsonArray
        val subText = inlines[1].jsonObject
        assertEquals("2", subText["text"]!!.jsonPrimitive.content)
        val markType = subText["marks"]!!.jsonArray[0].jsonObject["type"]!!.jsonPrimitive.content
        assertEquals("subscript", markType)
    }

    @Test
    fun `superscript mark parsed and serialized`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "paragraph")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "text")
                        put("text", "x")
                    })
                    add(buildJsonObject {
                        put("type", "text")
                        put("text", "2")
                        put("marks", buildJsonArray {
                            add(buildJsonObject { put("type", "superscript") })
                        })
                    })
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertTrue(blocks[0].spans[1].marks.contains(InlineMark.Superscript))

        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val inlines = reserialized["content"]!!.jsonArray[0].jsonObject["content"]!!.jsonArray
        val supMark = inlines[1].jsonObject["marks"]!!.jsonArray[0].jsonObject
        assertEquals("superscript", supMark["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun `sub alias parsed as subscript`() {
        val para = buildJsonObject {
            put("type", "paragraph")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "text")
                    put("text", "2")
                    put("marks", buildJsonArray {
                        add(buildJsonObject { put("type", "sub") })
                    })
                })
            })
        }
        val spans = ProseMirrorParser.extractInlineSpans(para)
        assertTrue(spans[0].marks.contains(InlineMark.Subscript))
    }

    @Test
    fun `editing link text preserves canonical blank target on serialization`() {
        val document = buildDoc(
            buildJsonObject {
                put("type", "paragraph")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "text")
                        put("text", "before")
                        put("marks", buildJsonArray {
                            add(buildJsonObject {
                                put("type", "link")
                                put("attrs", buildJsonObject {
                                    put("href", "https://tabtin.example.com/extra")
                                    put("target", "_blank")
                                })
                            })
                        })
                    })
                })
            },
        )

        val parsed = ProseMirrorParser.parseBlocks(document).single()
        assertEquals(BlockKind.PARAGRAPH, parsed.kind)
        assertTrue(parsed.canEditInline)

        val edited = parsed.copy(
            spans = listOf(parsed.spans.single().copy(text = "after")),
        )
        val serializedText = ProseMirrorParser.serializeBlocks(listOf(edited))
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray.single().jsonObject

        assertEquals("after", serializedText.getValue("text").jsonPrimitive.content)
        val serializedMark = serializedText.getValue("marks").jsonArray.single().jsonObject
        assertEquals("link", serializedMark.getValue("type").jsonPrimitive.content)
        val serializedAttrs = serializedMark.getValue("attrs").jsonObject
        assertEquals(setOf("href", "target"), serializedAttrs.keys)
        assertEquals(
            "https://tabtin.example.com/extra",
            serializedAttrs.getValue("href").jsonPrimitive.content,
        )
        assertEquals("_blank", serializedAttrs.getValue("target").jsonPrimitive.content)
    }

    // ========== AND-004: blockquote with block-level children ==========

    @Test
    fun `blockquote with heading child preserves content`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "blockquote")
                put("content", buildJsonArray {
                    add(paragraph(textNode("quote text")))
                    add(buildJsonObject {
                        put("type", "heading")
                        put("attrs", buildJsonObject { put("level", 2) })
                        put("content", buildJsonArray { add(textNode("heading inside quote")) })
                    })
                })
            }
        )
        // 批次 1b：引用块含非段落子块时不再拍平（拍平后写回会丢失引用结构），
        // 整块只读保留原始子树，逐字节往返。
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks.size)
        assertEquals(BlockKind.UNSUPPORTED, blocks[0].kind)
        assertFalse(blocks[0].editable)
        assertEquals(doc, ProseMirrorParser.serializeBlocks(blocks))
    }

    @Test
    fun `blockquote with bullet list child preserves content`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "blockquote")
                put("content", buildJsonArray {
                    add(paragraph(textNode("quote")))
                    add(bulletList(
                        listItem(paragraph(textNode("list item")))
                    ))
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks.size)
        assertEquals(BlockKind.UNSUPPORTED, blocks[0].kind)
        assertFalse(blocks[0].editable)
        assertEquals(doc, ProseMirrorParser.serializeBlocks(blocks))
    }

    @Test
    fun `blockquote with code block child preserves content`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "blockquote")
                put("content", buildJsonArray {
                    add(paragraph(textNode("intro")))
                    add(buildJsonObject {
                        put("type", "codeBlock")
                        put("attrs", buildJsonObject { put("language", "python") })
                        put("content", buildJsonArray {
                            add(buildJsonObject { put("type", "text"); put("text", "print('hi')") })
                        })
                    })
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks.size)
        assertEquals(BlockKind.UNSUPPORTED, blocks[0].kind)
        assertFalse(blocks[0].editable)
        assertEquals(doc, ProseMirrorParser.serializeBlocks(blocks))
    }

    // ========== AND-005: textStyle full attributes round-trip ==========

    @Test
    fun `textStyle backgroundColor stays readonly and round-trips intact`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "paragraph")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "text")
                        put("text", "highlighted")
                        put("marks", buildJsonArray {
                            add(buildJsonObject {
                                put("type", "textStyle")
                                put("attrs", buildJsonObject {
                                    put("backgroundColor", "#ffff00")
                                })
                            })
                        })
                    })
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(BlockKind.UNSUPPORTED, blocks.single().kind)
        assertFalse(blocks.single().editable)
        assertEquals(doc, ProseMirrorParser.serializeBlocks(blocks))
    }

    @Test
    fun `textStyle fontSize and fontFamily stay readonly and round-trip intact`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "paragraph")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "text")
                        put("text", "styled")
                        put("marks", buildJsonArray {
                            add(buildJsonObject {
                                put("type", "textStyle")
                                put("attrs", buildJsonObject {
                                    put("color", "#333333")
                                    put("fontSize", "18px")
                                    put("fontFamily", "Georgia")
                                })
                            })
                        })
                    })
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(BlockKind.UNSUPPORTED, blocks.single().kind)
        assertFalse(blocks.single().editable)
        assertEquals(doc, ProseMirrorParser.serializeBlocks(blocks))
    }

    @Test
    fun `textStyle with all four attributes stays readonly and round-trips intact`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "paragraph")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "text")
                        put("text", "all")
                        put("marks", buildJsonArray {
                            add(buildJsonObject {
                                put("type", "textStyle")
                                put("attrs", buildJsonObject {
                                    put("color", "#ff0000")
                                    put("backgroundColor", "#00ff00")
                                    put("fontSize", "24px")
                                    put("fontFamily", "Courier")
                                })
                            })
                        })
                    })
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(BlockKind.UNSUPPORTED, blocks.single().kind)
        assertFalse(blocks.single().editable)
        assertEquals(doc, ProseMirrorParser.serializeBlocks(blocks))
    }

    // ========== AND-006: heading level 4/5/6 round-trip ==========

    @Test
    fun `heading level 4 parsed and preserved`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "heading")
                put("attrs", buildJsonObject { put("level", 4) })
                put("content", buildJsonArray { add(textNode("H4 title")) })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(BlockKind.HEADING4, blocks[0].kind)
        assertEquals("H4 title", blocks[0].text)
    }

    @Test
    fun `heading level 5 parsed and preserved`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "heading")
                put("attrs", buildJsonObject { put("level", 5) })
                put("content", buildJsonArray { add(textNode("H5 title")) })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(BlockKind.HEADING5, blocks[0].kind)
    }

    @Test
    fun `heading level 6 parsed and preserved`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "heading")
                put("attrs", buildJsonObject { put("level", 6) })
                put("content", buildJsonArray { add(textNode("H6 title")) })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(BlockKind.HEADING6, blocks[0].kind)
    }

    @Test
    fun `heading H4 round-trip preserves level`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "heading")
                put("attrs", buildJsonObject { put("level", 4) })
                put("content", buildJsonArray { add(textNode("Sub-heading")) })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val node = reserialized["content"]!!.jsonArray[0].jsonObject
        assertEquals("heading", node["type"]!!.jsonPrimitive.content)
        assertEquals(4, node["attrs"]!!.jsonObject["level"]!!.jsonPrimitive.int)
    }

    @Test
    fun `heading H5 and H6 markdown output`() {
        val blocks = listOf(
            DocBlock(kind = BlockKind.HEADING5, spans = listOf(InlineSpan("Five"))),
            DocBlock(kind = BlockKind.HEADING6, spans = listOf(InlineSpan("Six"))),
        )
        val md = ProseMirrorParser.blocksToMarkdown(blocks)
        assertTrue(md.contains("##### Five"))
        assertTrue(md.contains("###### Six"))
    }

    // ========== XP-12: orderedList start attribute round-trip ==========

    @Test
    fun `orderedList start attribute parsed`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "orderedList")
                put("attrs", buildJsonObject { put("start", 5) })
                put("content", buildJsonArray {
                    add(listItem(paragraph(textNode("fifth"))))
                    add(listItem(paragraph(textNode("sixth"))))
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(2, blocks.size)
        assertEquals(5, blocks[0].listStart)
        assertEquals(5, blocks[1].listStart)
    }

    @Test
    fun `orderedList start defaults to 1`() {
        val doc = buildDoc(
            orderedList(listItem(paragraph(textNode("first"))))
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks[0].listStart)
    }

    @Test
    fun `orderedList start round-trip`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "orderedList")
                put("attrs", buildJsonObject { put("start", 3) })
                put("content", buildJsonArray {
                    add(listItem(paragraph(textNode("third"))))
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(3, blocks[0].listStart)

        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val listNode = reserialized["content"]!!.jsonArray[0].jsonObject
        assertEquals("orderedList", listNode["type"]!!.jsonPrimitive.content)
        assertEquals(3, listNode["attrs"]!!.jsonObject["start"]!!.jsonPrimitive.int)
    }

    @Test
    fun `canonical orderedList null type survives native text editing`() {
        val originalAttrs = buildJsonObject {
            put("start", 1)
            put("type", JsonNull)
        }
        val document = buildDoc(
            buildJsonObject {
                put("type", "orderedList")
                put("attrs", originalAttrs)
                put("content", buildJsonArray {
                    add(listItem(paragraph(textNode("编辑前"))))
                })
            },
        )

        val parsed = ProseMirrorParser.parseBlocks(document)
        assertEquals(BlockKind.ORDERED_ITEM, parsed.single().kind)
        assertTrue(parsed.single().canEditInline)

        val edited = parsed.single().copy(spans = listOf(InlineSpan("编辑后")))
        val listNode = ProseMirrorParser.serializeBlocks(listOf(edited))
            .getValue("content").jsonArray.single().jsonObject

        assertEquals(originalAttrs, listNode.getValue("attrs"))
        assertEquals(
            "编辑后",
            listNode.getValue("content").jsonArray.single().jsonObject
                .getValue("content").jsonArray.single().jsonObject
                .getValue("content").jsonArray.single().jsonObject
                .getValue("text").jsonPrimitive.content,
        )
    }

    @Test
    fun `orderedList non null type stays readonly and round-trips intact`() {
        val document = buildDoc(
            buildJsonObject {
                put("type", "orderedList")
                put("attrs", buildJsonObject {
                    put("start", 1)
                    put("type", "decimal")
                })
                put("content", buildJsonArray {
                    add(listItem(paragraph(textNode("自定义编号"))))
                })
            },
        )

        val parsed = ProseMirrorParser.parseBlocks(document)

        assertEquals(BlockKind.UNSUPPORTED, parsed.single().kind)
        assertFalse(parsed.single().editable)
        assertEquals(document, ProseMirrorParser.serializeBlocks(parsed))
    }

    @Test
    fun `orderedList start=1 omits attrs`() {
        val blocks = listOf(
            DocBlock(kind = BlockKind.ORDERED_ITEM, spans = listOf(InlineSpan("first")), listStart = 1),
        )
        val json = ProseMirrorParser.serializeBlocks(blocks)
        val listNode = json["content"]!!.jsonArray[0].jsonObject
        assertNull(listNode["attrs"])
    }

    // ========== XP-13: canonical inline image round-trip ==========

    @Test
    fun `canonical standalone image is content readonly but whole block deletable`() {
        listOf(false, true).forEach { includeNaturalAlignment ->
            val imageParagraph = buildJsonObject {
                put("type", "paragraph")
                put("attrs", buildJsonObject {
                    put("blockId", "image-natural")
                    if (includeNaturalAlignment) put("textAlign", JsonNull)
                })
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "image")
                        put("attrs", buildJsonObject {
                            put("src", "https://example.com/canonical.png")
                            put("fileId", "file-canonical")
                            put("alt", "canonical image")
                            put("title", "Canonical")
                            put("width", 1280)
                            put("height", 720)
                        })
                    })
                })
            }

            val block = ProseMirrorParser.parseBlocks(buildDoc(imageParagraph)).single()

            assertEquals(BlockKind.IMAGE, block.kind)
            assertFalse(block.editable)
            assertTrue(block.canDeleteWholeBlock)
            assertEquals(
                buildDoc(imageParagraph),
                ProseMirrorParser.serializeBlocks(listOf(block)),
            )
        }
    }

    @Test
    fun `standalone inline image preserves paragraph and attrs`() {
        val image = buildJsonObject {
            put("type", "image")
            put("attrs", buildJsonObject {
                put("src", "https://example.com/img.png")
                put("fileId", "file-camel")
                put("width", 800)
                put("height", 600)
                put("title", "A nice picture")
                put("custom", "keep-me")
            })
        }
        val doc = buildDoc(
            buildJsonObject {
                put("type", "paragraph")
                put("attrs", buildJsonObject { put("blockId", "image-paragraph") })
                put("content", buildJsonArray { add(image) })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks.size)
        assertEquals(BlockKind.IMAGE, blocks[0].kind)
        assertEquals("file-camel", blocks[0].imageFileId)
        assertEquals(800, blocks[0].imageWidth)
        assertEquals(600, blocks[0].imageHeight)
        assertEquals("A nice picture", blocks[0].imageTitle)
        assertFalse("未知图片属性不能获得整块删除能力", blocks[0].canDeleteWholeBlock)
        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val paragraphNode = reserialized["content"]!!.jsonArray[0].jsonObject
        assertEquals("paragraph", paragraphNode["type"]!!.jsonPrimitive.content)
        assertEquals("image-paragraph", paragraphNode["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
        val attrs = paragraphNode["content"]!!.jsonArray[0].jsonObject["attrs"]!!.jsonObject
        assertEquals("file-camel", attrs["fileId"]!!.jsonPrimitive.content)
        assertEquals("keep-me", attrs["custom"]!!.jsonPrimitive.content)
    }

    @Test
    fun `new image serializes as paragraph with camel case fileId`() {
        val blocks = listOf(
            DocBlock(
                kind = BlockKind.IMAGE,
                imageURL = "https://example.com/img.png",
                imageFileId = "file-new",
            ),
        )
        val json = ProseMirrorParser.serializeBlocks(blocks)
        val paragraphNode = json["content"]!!.jsonArray[0].jsonObject
        assertEquals("paragraph", paragraphNode["type"]!!.jsonPrimitive.content)
        val attrs = paragraphNode["content"]!!.jsonArray[0].jsonObject["attrs"]!!.jsonObject
        assertEquals("file-new", attrs["fileId"]!!.jsonPrimitive.content)
        assertNull(attrs["file_id"])
        assertNull(attrs["width"])
        assertNull(attrs["height"])
    }

    @Test
    fun `snake case file id is accepted when reading canonical image paragraph`() {
        val doc = buildDoc(
            paragraph(
                buildJsonObject {
                    put("type", "image")
                    put("attrs", buildJsonObject { put("file_id", "file-snake") })
                },
            ),
        )

        assertEquals("file-snake", ProseMirrorParser.parseBlocks(doc).single().imageFileId)
    }

    @Test
    fun `standalone image with explicit alignment stays read only and lossless`() {
        val alignedImage = buildJsonObject {
            put("type", "paragraph")
            put("attrs", buildJsonObject { put("textAlign", "center") })
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "image")
                    put("attrs", buildJsonObject { put("fileId", "file-aligned") })
                })
            })
        }

        val block = ProseMirrorParser.parseBlocks(buildDoc(alignedImage)).single()

        assertEquals(BlockKind.UNSUPPORTED, block.kind)
        assertFalse(block.editable)
        assertFalse(block.canDeleteWholeBlock)
        assertEquals(buildDoc(alignedImage), ProseMirrorParser.serializeBlocks(listOf(block)))
    }

    @Test
    fun `blank camel file id falls back to snake case`() {
        val doc = buildDoc(
            paragraph(
                buildJsonObject {
                    put("type", "image")
                    put("attrs", buildJsonObject {
                        put("fileId", "")
                        put("file_id", "file-snake")
                    })
                },
            ),
        )

        assertEquals("file-snake", ProseMirrorParser.parseBlocks(doc).single().imageFileId)
    }

    @Test
    fun `markdown fallback preserves headings quotes and remaining body text`() {
        val blocks = ProseMirrorParser.parseMarkdownFallback(
            "# 标题\n\n> 引用\n\n- 暂不解释的列表\n仍完整保留",
        )

        assertEquals(
            listOf(BlockKind.HEADING1, BlockKind.BLOCKQUOTE, BlockKind.PARAGRAPH),
            blocks.map(DocBlock::kind),
        )
        assertEquals(
            listOf("标题", "引用", "- 暂不解释的列表\n仍完整保留"),
            blocks.map(DocBlock::text),
        )
    }

    @Test
    fun `mixed text and image paragraph stays read only and lossless`() {
        val mixed = paragraph(
            textNode("before"),
            buildJsonObject {
                put("type", "image")
                put("attrs", buildJsonObject {
                    put("src", "https://example.com/mixed.png")
                    put("custom", "keep-mixed")
                })
            },
            textNode("after"),
        )
        val blocks = ProseMirrorParser.parseBlocks(buildDoc(mixed))

        assertEquals(BlockKind.UNSUPPORTED, blocks.single().kind)
        assertFalse(blocks.single().canDeleteWholeBlock)
        assertEquals(mixed, ProseMirrorParser.serializeBlocks(blocks)["content"]!!.jsonArray.single())
    }

    // ========== EI-008: flattenListNode depth guard ==========

    @Test
    fun `deeply nested list beyond max depth does not crash`() {
        fun nestBullet(depth: Int, text: String): JsonObject {
            if (depth == 0) {
                return bulletList(listItem(paragraph(textNode(text))))
            }
            return bulletList(listItem(paragraph(textNode("L$depth")), nestBullet(depth - 1, text)))
        }
        val doc = buildDoc(nestBullet(25, "leaf"))
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertTrue(blocks.isNotEmpty())
        assertTrue(blocks.size <= 25)
        assertTrue(blocks.none { it.indentLevel > 20 })
    }

    // ========== EI-009: buildListNode depth guard ==========

    @Test
    fun `serializing deeply nested list items does not crash`() {
        val items = (0..25).map { level ->
            DocBlock(
                kind = BlockKind.BULLET_ITEM,
                spans = listOf(InlineSpan("level$level")),
                indentLevel = level,
            )
        }
        val json = ProseMirrorParser.serializeBlocks(items)
        assertNotNull(json["content"])
        assertTrue(json["content"]!!.jsonArray.isNotEmpty())
    }

    // ========== EI-011: table row/column limits ==========

    @Test
    fun `large table is truncated to limits`() {
        val bigTable = buildJsonObject {
            put("type", "table")
            put("content", buildJsonArray {
                repeat(600) { rowIdx ->
                    add(buildJsonObject {
                        put("type", "tableRow")
                        put("content", buildJsonArray {
                            repeat(60) { colIdx ->
                                add(buildJsonObject {
                                    put("type", "tableCell")
                                    put("content", buildJsonArray {
                                        add(paragraph(textNode("R${rowIdx}C${colIdx}")))
                                    })
                                })
                            }
                        })
                    })
                }
            })
        }
        val doc = buildDoc(bigTable)
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks.size)
        assertEquals(BlockKind.TABLE, blocks[0].kind)
        val td = blocks[0].tableData!!
        assertTrue(td.rows.size <= 500)
        assertTrue(td.rows.all { it.cells.size <= 50 })
    }

    @Test
    fun `complex table cell projects nested readable content and preserves raw document`() {
        val complexCell = buildJsonObject {
            put("type", "tableCell")
            put("content", buildJsonArray {
                add(paragraph(textNode("第一段")))
                add(
                    bulletList(
                        listItem(
                            paragraph(textNode("父项")),
                            bulletList(listItem(paragraph(textNode("子项")))),
                        ),
                    ),
                )
                add(
                    paragraph(
                        buildJsonObject {
                            put("type", "image")
                            put("attrs", buildJsonObject {
                                put("src", "https://example.com/diagram.png")
                                put("alt", "架构图")
                            })
                        },
                    ),
                )
                add(buildJsonObject {
                    put("type", "htmlBlock")
                    put("attrs", buildJsonObject { put("title", "嵌入内容") })
                })
            })
        }
        val rawTable = buildJsonObject {
            put("type", "table")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "tableRow")
                    put("content", buildJsonArray {
                        add(complexCell)
                        add(buildJsonObject {
                            put("type", "tableCell")
                            put("content", buildJsonArray { add(paragraph(textNode("第二列"))) })
                        })
                    })
                })
            })
        }
        val document = buildDoc(rawTable)

        val block = ProseMirrorParser.parseBlocks(document).single()
        assertEquals(BlockKind.TABLE, block.kind)
        assertTrue(block.editable)
        val table = requireNotNull(block.tableData)
        assertEquals(1, table.rowCount)
        assertEquals(2, table.columnCount)
        val projected = table.rows.single().cells.first().text
        listOf("第一段", "父项", "子项", "架构图", "嵌入内容").forEach { expected ->
            assertTrue("missing projected content: $expected", projected.contains(expected))
        }
        assertEquals(1, table.projectedCellCount)
        assertTrue(table.rows.single().cells.first().isReadOnlyProjection)
        assertFalse(table.rows.single().cells[1].isReadOnlyProjection)
        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
        assertEquals(document, ProseMirrorParser.serializeBlocks(listOf(block)))

        val row = table.rows.single()
        val editedCell = row.cells[1].copy(
            text = "第二列已更新",
            spans = listOf(InlineSpan("第二列已更新")),
        )
        val editedBlock = block.copy(
            tableData = table.copy(
                rows = listOf(row.copy(cells = listOf(row.cells[0], editedCell))),
            ),
        )
        val serializedTable = ProseMirrorParser.serializeBlocks(listOf(editedBlock))
            .getValue("content").jsonArray.single().jsonObject
        val serializedCells = serializedTable.getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray
        assertEquals(complexCell, serializedCells[0])
        val editedText = serializedCells[1].jsonObject
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray.single().jsonObject
            .getValue("text").jsonPrimitive.content
        assertEquals("第二列已更新", editedText)
    }

    @Test
    fun `simple table cell with bold mark parses editable spans and round-trips`() {
        val boldText = buildJsonObject {
            put("type", "text")
            put("text", "加粗备注")
            put("marks", buildJsonArray {
                add(buildJsonObject { put("type", "bold") })
            })
        }
        val table = buildJsonObject {
            put("type", "table")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "tableRow")
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "tableCell")
                            put("content", buildJsonArray { add(paragraph(boldText)) })
                        })
                    })
                })
            })
        }
        val document = buildDoc(table, paragraph(textNode("旁段原文")))
        val blocks = ProseMirrorParser.parseBlocks(document)

        val cell = blocks[0].tableData!!.rows.single().cells.single()
        assertFalse(cell.isReadOnlyProjection)
        assertEquals("加粗备注", cell.spans.single().text)
        assertEquals(listOf(InlineMark.Bold), cell.spans.single().marks)
        assertEquals(document, ProseMirrorParser.serializeBlocks(blocks))

        val edited = blocks.toMutableList().also {
            it[1] = it[1].copy(spans = listOf(InlineSpan("旁段已改")))
        }
        val serialized = ProseMirrorParser.serializeBlocks(edited)
        val serializedCellText = serialized.getValue("content").jsonArray[0].jsonObject
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray.single().jsonObject
        assertEquals("旁段改字后该格 marks 必须深等，否则整表保存会丢掉加粗", boldText, serializedCellText)
        assertEquals(
            "旁段已改",
            serialized.getValue("content").jsonArray[1].jsonObject
                .getValue("content").jsonArray.single().jsonObject
                .getValue("text").jsonPrimitive.content,
        )
    }

    @Test
    fun `complex table summaries stay semantic without model language or schema types`() {
        val complexCell = buildJsonObject {
            put("type", "tableCell")
            put("content", buildJsonArray {
                listOf("tabwhiteboard", "tabdataBlock", "htmlBlock", "youtube", "futureWidget")
                    .forEach { type -> add(buildJsonObject { put("type", type) }) }
            })
        }
        val table = buildJsonObject {
            put("type", "table")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "tableRow")
                    put("content", buildJsonArray { add(complexCell) })
                })
            })
        }

        val cell = ProseMirrorParser.parseBlocks(buildDoc(table)).single()
            .tableData!!.rows.single().cells.single()
        val summaries = cell.projection!!.parts.filterIsInstance<TableCellProjectionPart.Summary>()

        assertEquals(
            listOf(
                TableContentSummaryKind.WHITEBOARD,
                TableContentSummaryKind.EMBEDDED_TABLE,
                TableContentSummaryKind.EMBEDDED_HTML,
                TableContentSummaryKind.VIDEO,
                TableContentSummaryKind.COMPLEX_CONTENT,
            ),
            summaries.map(TableCellProjectionPart.Summary::kind),
        )
        assertTrue("模型层不应写入任何界面语言", cell.text.isBlank())
    }

    // ========== EIP-009: mathematics round-trip ==========

    @Test
    fun `mathematics node round-trip produces mathematics node`() {
        val doc = buildDoc(
            paragraph(
                textNode("Energy: "),
                mathNode("E=mc^2"),
            )
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        val reserialized = ProseMirrorParser.serializeBlocks(blocks)
        val inlines = reserialized["content"]!!.jsonArray[0].jsonObject["content"]!!.jsonArray
        assertEquals(2, inlines.size)
        val textEl = inlines[0].jsonObject
        assertEquals("text", textEl["type"]!!.jsonPrimitive.content)
        assertEquals("Energy: ", textEl["text"]!!.jsonPrimitive.content)
        val mathEl = inlines[1].jsonObject
        assertEquals("mathematics", mathEl["type"]!!.jsonPrimitive.content)
        assertEquals("E=mc^2", mathEl["attrs"]!!.jsonObject["latex"]!!.jsonPrimitive.content)
    }

    @Test
    fun `mathematics markdown output wraps in dollar signs`() {
        val blocks = listOf(
            DocBlock(
                kind = BlockKind.PARAGRAPH,
                spans = listOf(
                    InlineSpan("Energy: "),
                    InlineSpan("E=mc^2", listOf(InlineMark.Mathematics())),
                ),
            )
        )
        val md = ProseMirrorParser.blocksToMarkdown(blocks)
        assertEquals("Energy: \$E=mc^2\$", md)
    }

    // ========== EIP-012: blockquote non-paragraph child ==========

    @Test
    fun `empty blockquote produces blockquote block`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "blockquote")
                put("content", buildJsonArray {})
            }
        )
        // 批次 1b：空引用块无法安全重建（serializer 不会产出空 quote），只读保留。
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks.size)
        assertEquals(BlockKind.UNSUPPORTED, blocks[0].kind)
        assertFalse(blocks[0].editable)
        assertEquals(doc, ProseMirrorParser.serializeBlocks(blocks))
    }

    @Test
    fun `blockquote interleaved paragraph and codeBlock preserves order`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "blockquote")
                put("content", buildJsonArray {
                    add(paragraph(textNode("first")))
                    add(buildJsonObject {
                        put("type", "codeBlock")
                        put("content", buildJsonArray {
                            add(buildJsonObject { put("type", "text"); put("text", "code()") })
                        })
                    })
                    add(paragraph(textNode("second")))
                })
            }
        )
        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals(1, blocks.size)
        assertEquals(BlockKind.UNSUPPORTED, blocks[0].kind)
        assertFalse(blocks[0].editable)
        assertEquals(doc, ProseMirrorParser.serializeBlocks(blocks))
    }

    @Test
    fun `clearing modeled block id cannot resurrect it from source attributes`() {
        val source = buildJsonObject {
            put("type", "paragraph")
            put("attrs", buildJsonObject {
                put("blockId", "old-block-id")
                put("textAlign", JsonNull)
            })
            put("content", buildJsonArray { add(textNode("正文")) })
        }
        val parsed = ProseMirrorParser.parseBlocks(buildDoc(source)).single()

        val serialized = ProseMirrorParser.serializeBlocks(
            listOf(parsed.copy(blockId = null)),
        ).getValue("content").jsonArray.single().jsonObject
        val attrs = serialized.getValue("attrs").jsonObject

        assertNull("持久化身份只认 DocBlock.blockId，旧值不得从 sourceAttributes 复活", attrs["blockId"])
        assertEquals(JsonNull, attrs["textAlign"])
    }

    @Test
    fun `text attrs missing null and empty object keep their original shape`() {
        val sources = listOf(
            buildJsonObject {
                put("type", "paragraph")
                put("content", buildJsonArray { add(textNode("missing")) })
            },
            buildJsonObject {
                put("type", "paragraph")
                put("attrs", JsonNull)
                put("content", buildJsonArray { add(textNode("null")) })
            },
            buildJsonObject {
                put("type", "paragraph")
                put("attrs", buildJsonObject {})
                put("content", buildJsonArray { add(textNode("empty")) })
            },
        )

        sources.forEach { source ->
            val parsed = ProseMirrorParser.parseBlocks(buildDoc(source)).single()
            val edited = parsed.copy(spans = listOf(InlineSpan("已编辑")))
            val serialized = ProseMirrorParser.serializeBlocks(listOf(edited))
                .getValue("content").jsonArray.single().jsonObject
            assertEquals(source["attrs"], serialized["attrs"])
        }
    }

    @Test
    fun `canonical paragraph and heading alignment survives body edits`() {
        val alignedParagraph = buildJsonObject {
            put("type", "paragraph")
            put("attrs", buildJsonObject { put("textAlign", "center") })
            put("content", buildJsonArray { add(textNode("paragraph-before")) })
        }
        val alignedHeading = buildJsonObject {
            put("type", "heading")
            put("attrs", buildJsonObject {
                put("level", 2)
                put("textAlign", "left")
            })
            put("content", buildJsonArray { add(textNode("heading-before")) })
        }
        val parsed = ProseMirrorParser.parseBlocks(buildDoc(alignedParagraph, alignedHeading))

        assertEquals(listOf(BlockKind.PARAGRAPH, BlockKind.HEADING2), parsed.map { it.kind })
        assertEquals(
            listOf(
                buildJsonObject { put("textAlign", "center") },
                buildJsonObject { put("textAlign", "left") },
            ),
            parsed.map { it.sourceAttributes },
        )

        val edited = parsed.mapIndexed { index, block ->
            block.copy(spans = listOf(InlineSpan("edited-$index")))
        }
        val expectedParagraph = buildJsonObject {
            alignedParagraph.forEach { (key, value) ->
                if (key != "content") put(key, value)
            }
            put("content", buildJsonArray { add(textNode("edited-0")) })
        }
        val expectedHeading = buildJsonObject {
            alignedHeading.forEach { (key, value) ->
                if (key != "content") put(key, value)
            }
            put("content", buildJsonArray { add(textNode("edited-1")) })
        }
        assertEquals(
            buildDoc(expectedParagraph, expectedHeading),
            ProseMirrorParser.serializeBlocks(edited),
        )
    }

    @Test
    fun `document envelope preserves root type and extension keys after editing content`() {
        val source = buildJsonObject {
            put("type", "tabtinDocV2")
            put("schemaVersion", 17)
            put("collaboration", buildJsonObject {
                put("mode", "tracked")
                put("threshold", numberLiteral("1e3"))
            })
            put("content", buildJsonArray { add(paragraph(textNode("before"))) })
        }
        val parsed = ProseMirrorParser.parseDocument(source)
        val edited = parsed.copy(
            blocks = parsed.blocks.map { block ->
                block.copy(spans = listOf(InlineSpan("after")))
            },
        )

        val expected = buildJsonObject {
            source.forEach { (key, value) ->
                if (key != "content") put(key, value)
            }
            put("content", buildJsonArray { add(paragraph(textNode("after"))) })
        }
        assertEquals(expected, ProseMirrorParser.serializeDocument(edited))
    }

    @Test
    fun `document envelope adds canonical type only when source root omits it`() {
        val source = buildJsonObject {
            put("legacyProjection", "markdown")
        }
        val parsed = ProseMirrorParser.parseDocument(source).copy(
            blocks = listOf(
                DocBlock(
                    kind = BlockKind.PARAGRAPH,
                    spans = listOf(InlineSpan("restored markdown")),
                ),
            ),
        )

        val expected = buildJsonObject {
            put("type", "doc")
            put("legacyProjection", "markdown")
            put("content", buildJsonArray {
                add(paragraph(textNode("restored markdown")))
            })
        }
        assertEquals(expected, ProseMirrorParser.serializeDocument(parsed))
    }

    @Test
    fun `readonly node preserves every JSON number spelling after editing a sibling`() {
        val opaque = buildJsonObject {
            put("type", "futureWidget")
            put("attrs", buildJsonObject {
                put("scientific", numberLiteral("1e3"))
                put("huge", numberLiteral("1234567890123456789012345678901234567890"))
                put("precise", numberLiteral("0.123456789012345678901234567890123456789"))
                put("nested", buildJsonArray {
                    add(buildJsonObject {
                        put("negativeScientific", numberLiteral("-9.876e-123"))
                    })
                })
            })
        }
        val source = buildDoc(paragraph(textNode("before")), opaque)
        val edited = ProseMirrorParser.parseBlocks(source).map { block ->
            if (block.kind == BlockKind.PARAGRAPH) {
                block.copy(spans = listOf(InlineSpan("after")))
            } else {
                block
            }
        }

        assertEquals(
            buildDoc(paragraph(textNode("after")), opaque),
            ProseMirrorParser.serializeBlocks(edited),
        )
    }

    @Test
    fun `table raw table row cell and paragraph preserve JSON numbers while another cell is edited`() {
        val projectedParagraph = buildJsonObject {
            put("type", "paragraph")
            put("attrs", buildJsonObject {
                put("futurePrecision", numberLiteral("0.123456789012345678901234567890"))
            })
            put("content", buildJsonArray { add(textNode("只读投影")) })
        }
        val projectedCell = buildJsonObject {
            put("type", "tableCell")
            put("attrs", buildJsonObject {
                put("futureHuge", numberLiteral("1234567890123456789012345678901234567890"))
            })
            put("content", buildJsonArray { add(projectedParagraph) })
        }
        val editableCell = buildJsonObject {
            put("type", "tableCell")
            put("attrs", buildJsonObject {
                put("futureScientific", numberLiteral("1e3"))
            })
            put("content", buildJsonArray { add(paragraph(textNode("before"))) })
        }
        val row = buildJsonObject {
            put("type", "tableRow")
            put("futureRowNumber", numberLiteral("9.876543210987654321e42"))
            put("content", buildJsonArray {
                add(projectedCell)
                add(editableCell)
            })
        }
        val table = buildJsonObject {
            put("type", "table")
            put("futureTableNumber", numberLiteral("-7e-100"))
            put("content", buildJsonArray { add(row) })
        }
        val block = ProseMirrorParser.parseBlocks(buildDoc(table)).single()
        val tableData = requireNotNull(block.tableData)
        val sourceRow = tableData.rows.single()
        val editedCell = sourceRow.cells[1].copy(
            text = "after",
            spans = listOf(InlineSpan("after")),
        )
        val editedBlock = block.copy(
            tableData = tableData.copy(
                rows = listOf(sourceRow.copy(cells = listOf(sourceRow.cells[0], editedCell))),
            ),
        )

        val expectedEditableCell = buildJsonObject {
            editableCell.forEach { (key, value) ->
                if (key != "content") put(key, value)
            }
            put("content", buildJsonArray { add(paragraph(textNode("after"))) })
        }
        val expectedRow = buildJsonObject {
            row.forEach { (key, value) ->
                if (key != "content") put(key, value)
            }
            put("content", buildJsonArray {
                add(projectedCell)
                add(expectedEditableCell)
            })
        }
        val expectedTable = buildJsonObject {
            table.forEach { (key, value) ->
                if (key != "content") put(key, value)
            }
            put("content", buildJsonArray { add(expectedRow) })
        }
        assertEquals(
            buildDoc(expectedTable),
            ProseMirrorParser.serializeBlocks(listOf(editedBlock)),
        )
    }

    @Test
    fun `adjacent ordered list containers keep independent starts`() {
        fun orderedListStartingAt(start: Int, text: String): JsonObject = buildJsonObject {
            put("type", "orderedList")
            put("attrs", buildJsonObject { put("start", start) })
            put("content", buildJsonArray {
                add(listItem(paragraph(textNode(text))))
            })
        }
        val first = orderedListStartingAt(3, "third")
        val second = orderedListStartingAt(9, "ninth")
        val source = buildDoc(first, second)

        val parsed = ProseMirrorParser.parseBlocks(source)

        assertEquals(source, ProseMirrorParser.serializeBlocks(parsed))
    }

    @Test
    fun `adjacent bullet list containers keep three layer identities and stay unmerged`() {
        val first = identifiedBulletList(
            "blk-bl-adj-a",
            identifiedListItem("blk-li-adj-a", identifiedParagraph("blk-p-adj-a", "相邻无序甲")),
        )
        val second = identifiedBulletList(
            "blk-bl-adj-b",
            identifiedListItem("blk-li-adj-b", identifiedParagraph("blk-p-adj-b", "相邻无序乙")),
        )
        val source = buildDoc(first, second)

        val parsed = ProseMirrorParser.parseBlocks(source)

        assertEquals(2, parsed.size)
        assertEquals("blk-bl-adj-a", parsed[0].listBlockId)
        assertEquals("blk-li-adj-a", parsed[0].blockId)
        assertEquals("blk-p-adj-a", parsed[0].listParagraphBlockId)
        assertEquals("blk-bl-adj-b", parsed[1].listBlockId)
        assertEquals("blk-li-adj-b", parsed[1].blockId)
        assertEquals("blk-p-adj-b", parsed[1].listParagraphBlockId)
        assertNotEquals(parsed[0].listContainerId, parsed[1].listContainerId)

        val edited = parsed.toMutableList().also {
            it[0] = it[0].copy(spans = listOf(InlineSpan("相邻无序甲已改")))
        }
        val serialized = ProseMirrorParser.serializeBlocks(edited).getValue("content").jsonArray

        assertEquals(2, serialized.size)
        assertEquals("bulletList", serialized[0].jsonObject.getValue("type").jsonPrimitive.content)
        assertEquals("bulletList", serialized[1].jsonObject.getValue("type").jsonPrimitive.content)
        assertEquals(second, serialized[1])
        assertEquals(
            "blk-bl-adj-a",
            serialized[0].jsonObject.getValue("attrs").jsonObject["blockId"]?.jsonPrimitive?.content,
        )
        assertEquals(
            "blk-li-adj-a",
            serialized[0].jsonObject.getValue("content").jsonArray[0]
                .jsonObject.getValue("attrs").jsonObject["blockId"]?.jsonPrimitive?.content,
        )
        assertEquals(
            "blk-p-adj-a",
            serialized[0].jsonObject.getValue("content").jsonArray[0]
                .jsonObject.getValue("content").jsonArray[0]
                .jsonObject.getValue("attrs").jsonObject["blockId"]?.jsonPrimitive?.content,
        )
    }

    @Test
    fun `adjacent ordered list containers keep three layer identities and restart numbering`() {
        val first = identifiedOrderedList(
            "blk-ol-adj-a",
            1,
            identifiedListItem("blk-li-oadj-a", identifiedParagraph("blk-p-oadj-a", "相邻有序甲")),
        )
        val second = identifiedOrderedList(
            "blk-ol-adj-b",
            1,
            identifiedListItem("blk-li-oadj-b", identifiedParagraph("blk-p-oadj-b", "相邻有序乙")),
        )
        val source = buildDoc(first, second)

        val parsed = ProseMirrorParser.parseBlocks(source)

        assertEquals(2, parsed.size)
        assertEquals("blk-ol-adj-a", parsed[0].listBlockId)
        assertEquals("blk-li-oadj-a", parsed[0].blockId)
        assertEquals("blk-p-oadj-a", parsed[0].listParagraphBlockId)
        assertEquals("blk-ol-adj-b", parsed[1].listBlockId)
        assertEquals("blk-li-oadj-b", parsed[1].blockId)
        assertEquals("blk-p-oadj-b", parsed[1].listParagraphBlockId)
        assertNotEquals(parsed[0].listContainerId, parsed[1].listContainerId)

        val edited = parsed.toMutableList().also {
            it[0] = it[0].copy(spans = listOf(InlineSpan("相邻有序甲已改")))
        }
        val serialized = ProseMirrorParser.serializeBlocks(edited).getValue("content").jsonArray

        assertEquals(2, serialized.size)
        assertEquals(second, serialized[1])
        // 合并会让第二个列表接着上一列表编号，用户直接看到序号从 1 变成 2
        assertEquals(
            1,
            serialized[1].jsonObject.getValue("attrs").jsonObject["start"]?.jsonPrimitive?.int,
        )
        assertEquals(
            "blk-ol-adj-a",
            serialized[0].jsonObject.getValue("attrs").jsonObject["blockId"]?.jsonPrimitive?.content,
        )
        assertEquals(
            "blk-li-oadj-a",
            serialized[0].jsonObject.getValue("content").jsonArray[0]
                .jsonObject.getValue("attrs").jsonObject["blockId"]?.jsonPrimitive?.content,
        )
        assertEquals(
            "blk-p-oadj-a",
            serialized[0].jsonObject.getValue("content").jsonArray[0]
                .jsonObject.getValue("content").jsonArray[0]
                .jsonObject.getValue("attrs").jsonObject["blockId"]?.jsonPrimitive?.content,
        )
    }

    @Test
    fun `blockquote child paragraph attrs and container boundaries survive text editing`() {
        fun quotedParagraph(label: String, attrs: JsonElement? = null, includeAttrs: Boolean = true): JsonObject =
            buildJsonObject {
                put("type", "paragraph")
                if (includeAttrs) put("attrs", attrs ?: buildJsonObject {})
                put("content", buildJsonArray { add(textNode(label)) })
            }

        val firstQuote = buildJsonObject {
            put("type", "blockquote")
            put("content", buildJsonArray {
                add(quotedParagraph("missing", includeAttrs = false))
                add(quotedParagraph("null", JsonNull))
                add(quotedParagraph("empty", buildJsonObject {}))
                add(quotedParagraph("aligned", buildJsonObject { put("textAlign", "justify") }))
            })
        }
        val secondQuote = buildJsonObject {
            put("type", "blockquote")
            put("content", buildJsonArray {
                add(quotedParagraph("second", includeAttrs = false))
            })
        }
        val parsed = ProseMirrorParser.parseBlocks(buildDoc(firstQuote, secondQuote))

        assertEquals(5, parsed.size)
        assertNotNull(parsed[0].quoteContainerId)
        assertTrue(parsed.take(4).all { it.quoteContainerId == parsed[0].quoteContainerId })
        assertNotEquals(parsed[0].quoteContainerId, parsed[4].quoteContainerId)

        val edited = parsed.mapIndexed { index, block ->
            block.copy(spans = listOf(InlineSpan("edited-$index")))
        }
        val serializedQuotes = ProseMirrorParser.serializeBlocks(edited)
            .getValue("content").jsonArray

        assertEquals(2, serializedQuotes.size)
        val paragraphs = serializedQuotes[0].jsonObject.getValue("content").jsonArray
        assertFalse("missing attrs must stay missing", "attrs" in paragraphs[0].jsonObject)
        assertEquals(JsonNull, paragraphs[1].jsonObject["attrs"])
        assertEquals(buildJsonObject {}, paragraphs[2].jsonObject["attrs"])
        assertEquals(
            buildJsonObject { put("textAlign", "justify") },
            paragraphs[3].jsonObject["attrs"],
        )

        val anonymousQuotes = listOf(
            DocBlock(
                kind = BlockKind.BLOCKQUOTE,
                spans = listOf(InlineSpan("anonymous-1")),
                quoteContainerId = null,
            ),
            DocBlock(
                kind = BlockKind.BLOCKQUOTE,
                spans = listOf(InlineSpan("anonymous-2")),
                quoteContainerId = null,
            ),
        )
        assertEquals(
            "quotes without a runtime container must never be merged by adjacency",
            2,
            ProseMirrorParser.serializeBlocks(anonymousQuotes).getValue("content").jsonArray.size,
        )
    }

    @Test
    fun `collaborative blockquote keeps container block id without leaking it into child paragraphs`() {
        val source = buildDoc(
            buildJsonObject {
                put("type", "blockquote")
                put("attrs", buildJsonObject { put("blockId", "blk-q-0009") })
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "paragraph")
                        put("attrs", buildJsonObject {
                            put("blockId", "blk-p-0010")
                            put("textAlign", JsonNull)
                        })
                        put("content", buildJsonArray { add(textNode("引用块里的一段文字。")) })
                    })
                })
            },
        )

        val parsed = ProseMirrorParser.parseBlocks(source)

        assertEquals(1, parsed.size)
        assertEquals(BlockKind.BLOCKQUOTE, parsed[0].kind)
        assertTrue("协作正典引用必须可编辑", parsed[0].editable)
        assertEquals("容器身份必须独立承载", "blk-q-0009", parsed[0].quoteBlockId)
        assertEquals("子段落身份不能被容器身份顶替", "blk-p-0010", parsed[0].blockId)
        assertEquals("未编辑时整篇必须深等", source, ProseMirrorParser.serializeBlocks(parsed))

        val edited = parsed.map { it.copy(spans = listOf(InlineSpan("改过的引用正文"))) }
        val quote = ProseMirrorParser.serializeBlocks(edited)
            .getValue("content").jsonArray[0].jsonObject
        assertEquals(
            "blk-q-0009",
            quote.getValue("attrs").jsonObject.getValue("blockId").jsonPrimitive.content,
        )
        val paragraphAttrs = quote.getValue("content").jsonArray[0].jsonObject
            .getValue("attrs").jsonObject
        assertEquals("blk-p-0010", paragraphAttrs.getValue("blockId").jsonPrimitive.content)
        assertEquals(JsonNull, paragraphAttrs["textAlign"])
    }

    @Test
    fun `blockquote without child paragraph identity does not inherit the container block id`() {
        val source = buildDoc(
            buildJsonObject {
                put("type", "blockquote")
                put("attrs", buildJsonObject { put("blockId", "quote-only-parent") })
                put("content", buildJsonArray {
                    add(paragraph(textNode("只有容器有身份")))
                })
            },
        )

        val parsed = ProseMirrorParser.parseBlocks(source)

        assertEquals(1, parsed.size)
        assertEquals("quote-only-parent", parsed[0].quoteBlockId)
        assertNull("容器身份不得下放成子段落身份", parsed[0].blockId)
        assertEquals(source, ProseMirrorParser.serializeBlocks(parsed))
    }

    @Test
    fun `interrupted quote run never emits the same container block id twice`() {
        val source = buildDoc(
            buildJsonObject {
                put("type", "blockquote")
                put("attrs", buildJsonObject { put("blockId", "blk-q-split") })
                put("content", buildJsonArray {
                    add(paragraph(textNode("第一段")))
                    add(paragraph(textNode("第二段")))
                })
            },
        )

        val parsed = ProseMirrorParser.parseBlocks(source)
        assertEquals(2, parsed.size)
        assertEquals("blk-q-split", parsed[1].quoteBlockId)

        // 用户把一个普通段落挪进引用中间：同一容器被拆成两段不连续的 run。
        val interrupted = listOf(
            parsed[0],
            DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("插进来的段落"))),
            parsed[1],
        )
        val serialized = ProseMirrorParser.serializeBlocks(interrupted)
            .getValue("content").jsonArray
        val emittedQuoteIds = serialized
            .filter { it.jsonObject["type"]?.jsonPrimitive?.content == "blockquote" }
            .mapNotNull { it.jsonObject["attrs"]?.jsonObject?.get("blockId")?.jsonPrimitive?.content }

        assertEquals(3, serialized.size)
        assertEquals(
            "同一个 blockId 绝不能同时出现在两个引用节点上",
            emittedQuoteIds.size,
            emittedQuoteIds.distinct().size,
        )
    }

    @Test
    fun `list child paragraph attrs survive editing without receiving item block id`() {
        fun item(index: Int, attrs: JsonElement? = null, includeAttrs: Boolean = true): JsonObject =
            buildJsonObject {
                put("type", "listItem")
                put("attrs", buildJsonObject { put("blockId", "item-$index") })
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "paragraph")
                        if (includeAttrs) put("attrs", attrs ?: buildJsonObject {})
                        put("content", buildJsonArray { add(textNode("before-$index")) })
                    })
                })
            }
        val parsed = ProseMirrorParser.parseBlocks(
            buildDoc(
                orderedList(
                    item(0, includeAttrs = false),
                    item(1, JsonNull),
                    item(2, buildJsonObject {}),
                    item(3, buildJsonObject { put("textAlign", "right") }),
                ),
            ),
        )
        val edited = parsed.mapIndexed { index, block ->
            block.copy(spans = listOf(InlineSpan("after-$index")))
        }

        val serializedItems = ProseMirrorParser.serializeBlocks(edited)
            .getValue("content").jsonArray.single().jsonObject
            .getValue("content").jsonArray
        val serializedParagraphs = serializedItems.map { serializedItem ->
            serializedItem.jsonObject.getValue("content").jsonArray.single().jsonObject
        }

        serializedItems.forEachIndexed { index, serializedItem ->
            assertEquals(
                "item-$index",
                serializedItem.jsonObject.getValue("attrs").jsonObject["blockId"]?.jsonPrimitive?.content,
            )
            assertNull(
                "listItem identity must never move into its child paragraph",
                (serializedParagraphs[index]["attrs"] as? JsonObject)?.get("blockId"),
            )
        }
        assertFalse("missing attrs must stay missing", "attrs" in serializedParagraphs[0])
        assertEquals(JsonNull, serializedParagraphs[1]["attrs"])
        assertEquals(buildJsonObject {}, serializedParagraphs[2]["attrs"])
        assertEquals(
            buildJsonObject { put("textAlign", "right") },
            serializedParagraphs[3]["attrs"],
        )
    }

    private fun identifiedParagraph(blockId: String, text: String): JsonObject = buildJsonObject {
        put("type", "paragraph")
        put("attrs", buildJsonObject { put("blockId", blockId) })
        put("content", buildJsonArray { add(textNode(text)) })
    }

    private fun identifiedListItem(blockId: String, vararg children: JsonObject): JsonObject = buildJsonObject {
        put("type", "listItem")
        put("attrs", buildJsonObject { put("blockId", blockId) })
        put("content", buildJsonArray { children.forEach { add(it) } })
    }

    private fun identifiedBulletList(blockId: String, vararg items: JsonObject): JsonObject = buildJsonObject {
        put("type", "bulletList")
        put("attrs", buildJsonObject { put("blockId", blockId) })
        put("content", buildJsonArray { items.forEach { add(it) } })
    }

    private fun identifiedOrderedList(
        blockId: String,
        start: Int,
        vararg items: JsonObject,
    ): JsonObject = buildJsonObject {
        put("type", "orderedList")
        put("attrs", buildJsonObject { put("blockId", blockId); put("start", start) })
        put("content", buildJsonArray { items.forEach { add(it) } })
    }

    @Test
    fun `collaborative list keeps container item and paragraph identities on their own anchors`() {
        val doc = buildDoc(
            identifiedBulletList(
                "blk-list",
                identifiedListItem("blk-item", identifiedParagraph("blk-para", "item")),
            ),
        )

        val blocks = ProseMirrorParser.parseBlocks(doc)

        assertEquals(1, blocks.size)
        assertEquals("blk-list", blocks[0].listBlockId)
        assertEquals("blk-item", blocks[0].blockId)
        assertEquals("blk-para", blocks[0].listParagraphBlockId)

        val listNode = ProseMirrorParser.serializeBlocks(blocks)["content"]!!.jsonArray[0].jsonObject
        assertEquals("blk-list", listNode["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
        val itemNode = listNode["content"]!!.jsonArray[0].jsonObject
        assertEquals("blk-item", itemNode["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
        val paragraphNode = itemNode["content"]!!.jsonArray[0].jsonObject
        assertEquals("blk-para", paragraphNode["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `nested list container identity stays with its own level`() {
        val doc = buildDoc(
            identifiedBulletList(
                "blk-outer",
                identifiedListItem(
                    "blk-outer-item",
                    identifiedParagraph("blk-outer-para", "parent"),
                    identifiedBulletList(
                        "blk-inner",
                        identifiedListItem("blk-inner-item", identifiedParagraph("blk-inner-para", "child")),
                    ),
                ),
            ),
        )

        val blocks = ProseMirrorParser.parseBlocks(doc)

        assertEquals(2, blocks.size)
        assertEquals("blk-outer", blocks[0].listBlockId)
        assertEquals("blk-inner", blocks[1].listBlockId)
        assertNotEquals(
            "nested container must not share the outer container session identity",
            blocks[0].listContainerId,
            blocks[1].listContainerId,
        )

        val outer = ProseMirrorParser.serializeBlocks(blocks)["content"]!!.jsonArray[0].jsonObject
        assertEquals("blk-outer", outer["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
        val outerItem = outer["content"]!!.jsonArray[0].jsonObject
        val inner = outerItem["content"]!!.jsonArray[1].jsonObject
        assertEquals("blk-inner", inner["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
        val innerItem = inner["content"]!!.jsonArray[0].jsonObject
        assertEquals("blk-inner-item", innerItem["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `interrupted list run never emits the same container block id twice`() {
        val doc = buildDoc(
            identifiedBulletList(
                "blk-list",
                identifiedListItem("blk-item-1", identifiedParagraph("blk-para-1", "first")),
                identifiedListItem("blk-item-2", identifiedParagraph("blk-para-2", "second")),
            ),
        )
        val blocks = ProseMirrorParser.parseBlocks(doc).toMutableList()
        blocks.add(1, DocBlock(kind = BlockKind.PARAGRAPH, spans = listOf(InlineSpan("moved between"))))

        val content = ProseMirrorParser.serializeBlocks(blocks)["content"]!!.jsonArray
        val listNodes = content.map { it.jsonObject }.filter { it["type"]?.jsonPrimitive?.content == "bulletList" }

        assertEquals(2, listNodes.size)
        assertEquals("blk-list", listNodes[0]["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content)
        assertNull(
            "a persistent container id must anchor exactly one list node",
            (listNodes[1]["attrs"] as? JsonObject)?.get("blockId"),
        )
        assertEquals(
            "splitting a run must not disturb item identities",
            listOf("blk-item-1", "blk-item-2"),
            listNodes.map { it["content"]!!.jsonArray[0].jsonObject["attrs"]!!.jsonObject["blockId"]!!.jsonPrimitive.content },
        )
    }

    @Test
    fun `ordered list keeps container identity alongside start`() {
        val doc = buildDoc(
            buildJsonObject {
                put("type", "orderedList")
                put("attrs", buildJsonObject {
                    put("blockId", "blk-ol")
                    put("start", 3)
                })
                put("content", buildJsonArray {
                    add(identifiedListItem("blk-ol-item", identifiedParagraph("blk-ol-para", "numbered")))
                })
            },
        )

        val blocks = ProseMirrorParser.parseBlocks(doc)
        assertEquals("blk-ol", blocks[0].listBlockId)
        assertEquals(3, blocks[0].listStart)

        val attrs = ProseMirrorParser.serializeBlocks(blocks)["content"]!!
            .jsonArray[0].jsonObject["attrs"]!!.jsonObject
        assertEquals("blk-ol", attrs["blockId"]!!.jsonPrimitive.content)
        assertEquals(3, attrs["start"]!!.jsonPrimitive.int)
        assertNull("编号样式不在来源里就不该凭空写出", attrs["type"])
    }

    @Test
    fun `list without persistent identity emits no container attrs`() {
        val blocks = listOf(
            DocBlock(kind = BlockKind.BULLET_ITEM, spans = listOf(InlineSpan("plain"))),
        )
        val listNode = ProseMirrorParser.serializeBlocks(blocks)["content"]!!.jsonArray[0].jsonObject
        assertNull("locally created lists must not grow empty attrs", listNode["attrs"])
        val paragraphNode = listNode["content"]!!.jsonArray[0].jsonObject["content"]!!.jsonArray[0].jsonObject
        assertNull("locally created list paragraphs carry no identity", paragraphNode["attrs"])
    }
}
