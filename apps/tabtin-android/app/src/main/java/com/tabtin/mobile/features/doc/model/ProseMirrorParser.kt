package com.tabtin.mobile.features.doc.model

import kotlinx.serialization.json.*

public object ProseMirrorParser {

    /**
     * 可编辑块与其来源文档根必须作为一个整体流转。旧的 [parseBlocks] / [serializeBlocks]
     * 继续用于新建 canonical 文档；从远端加载后编辑应使用本类型，避免把根级扩展字段
     * 或未来的文档 type 静默重写成 `{type: "doc"}`。
     */
    @ConsistentCopyVisibility
    public data class ParsedDocument internal constructor(
        val blocks: List<DocBlock>,
        internal val sourceRoot: JsonObject,
    )

    private const val MAX_LIST_NESTING_DEPTH = 20
    private const val MAX_TABLE_ROWS = 500
    private const val MAX_TABLE_COLUMNS = 50

    public fun parseDocument(json: JsonObject): ParsedDocument = ParsedDocument(
        blocks = parseBlocks(json),
        sourceRoot = json,
    )

    /** 用编辑后的 [ParsedDocument.blocks] 替换正文，同时原样保留来源根的其余键和值。 */
    public fun serializeDocument(document: ParsedDocument): JsonObject {
        val canonical = serializeBlocks(document.blocks)
        return buildJsonObject {
            if ("type" !in document.sourceRoot) {
                put("type", "doc")
            }
            document.sourceRoot.forEach { (key, value) ->
                if (key != "content") put(key, value)
            }
            put("content", canonical.getValue("content"))
        }
    }

    public fun parseBlocks(json: JsonObject): List<DocBlock> {
        val content = json.arrayValue("content") ?: return emptyList()
        val blocks = mutableListOf<DocBlock>()
        for (node in content) {
            if (node is JsonObject) {
                parseTopLevelNode(node, blocks)
            } else {
                blocks.add(preserveMalformedRootElement(node))
            }
        }
        return blocks
    }

    private fun preserveMalformedRootElement(element: JsonElement): DocBlock = DocBlock(
        kind = BlockKind.UNSUPPORTED,
        rawElement = element,
        editable = false,
    )

    /**
     * 将表格单元格里的 block content 解析成一个只读的迷你云文档。
     *
     * 单元格内容仍然是 ProseMirror JSON，不转换成 Markdown，也不参与整篇文档
     * 的序列化；调用方只拿解析后的块交给原生文档渲染器展示。
     */
    public fun parseTableCellContent(rawCell: Map<String, Any?>?): List<DocBlock> {
        val content = rawCell?.asJsonObject()?.arrayValue("content") ?: return emptyList()
        return parseBlocks(
            buildJsonObject {
                put("type", "doc")
                put("content", content)
            },
        )
    }

    /**
     * 兼容早期只保存 description_markdown、没有 description_json.content 的文档。
     *
     * 这里刻意只做稳定、可逆的块级投影：标题、引用和普通段落。其余 Markdown
     * 语法仍作为普通文本保留，避免一个不完整的 Markdown 解析器静默吞正文。
     */
    public fun parseMarkdownFallback(markdown: String): List<DocBlock> {
        val normalized = markdown
            .replace("\r\n", "\n")
            .replace('\r', '\n')
            .trim()
        if (normalized.isEmpty()) return emptyList()

        return normalized
            .split(Regex("\\n[\\t ]*\\n+"))
            .mapNotNull { rawParagraph ->
                val paragraph = rawParagraph.trim()
                if (paragraph.isEmpty()) return@mapNotNull null
                val hashes = paragraph.takeWhile { it == '#' }.length
                when {
                    hashes in 1..6 && paragraph.getOrNull(hashes) == ' ' -> DocBlock(
                        kind = when (hashes) {
                            1 -> BlockKind.HEADING1
                            2 -> BlockKind.HEADING2
                            3 -> BlockKind.HEADING3
                            4 -> BlockKind.HEADING4
                            5 -> BlockKind.HEADING5
                            else -> BlockKind.HEADING6
                        },
                        spans = listOf(InlineSpan(paragraph.drop(hashes + 1))),
                    )
                    paragraph.startsWith("> ") -> DocBlock(
                        kind = BlockKind.BLOCKQUOTE,
                        spans = listOf(InlineSpan(paragraph.drop(2))),
                    )
                    else -> DocBlock(
                        kind = BlockKind.PARAGRAPH,
                        spans = listOf(InlineSpan(paragraph)),
                    )
                }
            }
    }

    private fun makeTextBlock(kind: BlockKind, node: JsonObject, blockId: String? = null): DocBlock {
        val spans = extractInlineSpans(node)
        return DocBlock(
            kind = kind,
            spans = spans,
            blockId = blockId,
            sourceAttributes = identityFreeTextAttributes(node["attrs"]),
        )
    }

    /**
     * `blockId` 与 heading `level` 已有结构化字段承载，不能再放进 attrs 快照形成第二真源。
     * 只保留当前安全策略允许、但仍需维持 JSON 形态的 textAlign；missing/null/{} 三态不折叠。
     */
    private fun identityFreeTextAttributes(attributes: JsonElement?): JsonElement? = when (attributes) {
        null -> null
        JsonNull -> JsonNull
        is JsonObject -> JsonObject(attributes.filterKeys { it == "textAlign" })
        else -> null
    }

    private fun extractBlockId(node: JsonObject): String? =
        node.objectValue("attrs")?.primitiveValue("blockId")?.contentOrNull

    /**
     * 批次 1b：逐块安全门禁。通过 [NativeDocumentSafetyPolicy.isEditableTopLevel]
     * 的块按类型解析为可编辑块；未通过的块（含未知类型、非常规属性、未知 mark）
     * 保留原始子树、局部只读，不再让整篇文档降级只读。
     */
    private fun parseTopLevelNode(node: JsonObject, blocks: MutableList<DocBlock>) {
        val type = node.primitiveValue("type")?.contentOrNull
        if (type == null) {
            blocks.add(preserveMalformedRootElement(node))
            return
        }
        val blockId = extractBlockId(node)

        fun preservedReadonly() {
            blocks.add(
                DocBlock(
                    kind = BlockKind.UNSUPPORTED,
                    unsupportedType = type,
                    rawNode = jsonObjectToMap(node),
                    blockId = blockId,
                    editable = false,
                ),
            )
        }

        when (type) {
            "paragraph" -> {
                val inlineContent = node["content"] as? JsonArray
                val standaloneImage = inlineContent
                    ?.singleOrNull()
                    ?.let { it as? JsonObject }
                    ?.takeIf { it["type"]?.jsonPrimitive?.contentOrNull == "image" }
                val paragraphTextAlignment = (node["attrs"] as? JsonObject)?.get("textAlign")
                val standaloneImageHasExplicitAlignment =
                    paragraphTextAlignment != null && paragraphTextAlignment !is JsonNull
                when {
                    standaloneImage != null -> {
                        if (standaloneImageHasExplicitAlignment) {
                            preservedReadonly()
                        } else {
                            blocks.add(
                                makeImageBlock(
                                    paragraph = node,
                                    imageNode = standaloneImage,
                                    blockId = blockId,
                                ),
                            )
                        }
                    }
                    else -> if (NativeDocumentSafetyPolicy.isEditableTopLevel(node)) {
                        blocks.add(makeTextBlock(BlockKind.PARAGRAPH, node, blockId))
                    } else {
                        preservedReadonly()
                    }
                }
            }
            "heading" -> {
                val level = node.objectValue("attrs")?.primitiveValue("level")?.intOrNull ?: 1
                val kind = when (level) {
                    1 -> BlockKind.HEADING1
                    2 -> BlockKind.HEADING2
                    3 -> BlockKind.HEADING3
                    4 -> BlockKind.HEADING4
                    5 -> BlockKind.HEADING5
                    6 -> BlockKind.HEADING6
                    else -> BlockKind.HEADING3
                }
                if (NativeDocumentSafetyPolicy.isEditableTopLevel(node)) {
                    blocks.add(makeTextBlock(kind, node, blockId))
                } else {
                    preservedReadonly()
                }
            }
            "codeBlock" -> {
                if (!NativeDocumentSafetyPolicy.isEditableTopLevel(node)) {
                    preservedReadonly()
                    return
                }
                val lang = node.objectValue("attrs")?.primitiveValue("language")?.contentOrNull ?: ""
                val text = extractPlainText(node)
                blocks.add(DocBlock(kind = BlockKind.CODE_BLOCK, spans = listOf(InlineSpan(text)), codeLanguage = lang, blockId = blockId))
            }
            "blockquote" -> {
                if (!NativeDocumentSafetyPolicy.isEditableTopLevel(node)) {
                    preservedReadonly()
                    return
                }
                val innerContent = node.arrayValue("content") ?: return
                val result = mutableListOf<DocBlock>()
                val quoteContainerId = java.util.UUID.randomUUID().toString()
                for (inner in innerContent) {
                    if (inner is JsonObject) {
                        val innerType = inner.primitiveValue("type")?.contentOrNull
                        if (innerType == "paragraph") {
                            val text = extractInlineSpans(inner)
                            result.add(
                                DocBlock(
                                    kind = BlockKind.BLOCKQUOTE,
                                    spans = text,
                                    // 容器身份与子段落身份是两层独立锚点，缺一层时留空，
                                    // 不能互相顶替，否则保存后另一层身份会凭空出现或消失。
                                    blockId = extractBlockId(inner),
                                    quoteContainerId = quoteContainerId,
                                    quoteBlockId = blockId,
                                    sourceAttributes = identityFreeTextAttributes(inner["attrs"]),
                                ),
                            )
                        } else {
                            val nested = mutableListOf<DocBlock>()
                            parseTopLevelNode(inner, nested)
                            result.addAll(nested)
                        }
                    }
                }
                if (result.isEmpty()) {
                    blocks.add(
                        DocBlock(
                            kind = BlockKind.BLOCKQUOTE,
                            quoteContainerId = quoteContainerId,
                            quoteBlockId = blockId,
                        ),
                    )
                } else {
                    blocks.addAll(result)
                }
            }
            "bulletList", "orderedList", "taskList" -> {
                if (!NativeDocumentSafetyPolicy.isEditableTopLevel(node)) {
                    // 不安全列表整体保留原始子树，避免拍平后 canonical 序列化丢属性。
                    preservedReadonly()
                    return
                }
                when (type) {
                    "bulletList" -> flattenListNode(node, BlockKind.BULLET_ITEM, blocks)
                    "orderedList" -> {
                        val attrs = node.objectValue("attrs")
                        val start = attrs?.primitiveValue("start")?.intOrNull ?: 1
                        flattenListNode(
                            node,
                            BlockKind.ORDERED_ITEM,
                            blocks,
                            listStart = start,
                            orderedListHasExplicitNullType = attrs?.get("type") is JsonNull,
                        )
                    }
                    else -> flattenListNode(node, BlockKind.TODO_ITEM, blocks)
                }
            }
            "horizontalRule" -> {
                if (NativeDocumentSafetyPolicy.isEditableTopLevel(node)) {
                    blocks.add(DocBlock(kind = BlockKind.DIVIDER, blockId = blockId))
                } else {
                    preservedReadonly()
                }
            }
            // 顶层 image 是历史结构。保留原始节点用于只读展示/完整模式，不能把它
            // 误写回成当前正典；当前正典是 paragraph 内的 inline image。
            "image" -> preservedReadonly()
            "table" -> {
                val tableData = parseTableNode(node)
                val rawNode = jsonObjectToMap(node)
                blocks.add(
                    DocBlock(
                        kind = BlockKind.TABLE,
                        tableData = tableData,
                        rawNode = rawNode,
                        blockId = blockId,
                        editable = NativeDocumentSafetyPolicy.isEditableTable(node),
                        // 表格内容在原生端统一只读，但移除顶层 table 节点本身是无损操作。
                        canDeleteWholeBlock = true,
                    ),
                )
            }
            else -> preservedReadonly()
        }
    }

    private fun makeImageBlock(
        paragraph: JsonObject,
        imageNode: JsonObject,
        blockId: String?,
    ): DocBlock {
        val attrs = imageNode["attrs"] as? JsonObject
        return DocBlock(
            kind = BlockKind.IMAGE,
            editable = false,
            canDeleteWholeBlock = NativeDocumentSafetyPolicy.isEditableTopLevel(paragraph),
            blockId = blockId,
            imageURL = attrs.string("src"),
            imageAlt = attrs.string("alt"),
            imageFileId = attrs.string("fileId").ifBlank { attrs.string("file_id") },
            imageWidth = attrs.int("width"),
            imageHeight = attrs.int("height"),
            imageTitle = attrs.string("title"),
            rawNode = jsonObjectToMap(paragraph),
        )
    }

    private fun JsonObject?.string(key: String): String =
        (this?.get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()

    private fun JsonObject?.int(key: String): Int? =
        (this?.get(key) as? JsonPrimitive)?.intOrNull

    private fun flattenListNode(
        node: JsonObject,
        kind: BlockKind,
        blocks: MutableList<DocBlock>,
        level: Int = 0,
        listStart: Int = 1,
        listContainerId: String = java.util.UUID.randomUUID().toString(),
        orderedListHasExplicitNullType: Boolean = false,
    ) {
        if (level > MAX_LIST_NESTING_DEPTH) return
        // 容器身份属于当前这一层的 list 节点；递归时每层各取各的，嵌套列表不会继承外层身份。
        val listBlockId = extractBlockId(node)
        val items = node.arrayValue("content") ?: return
        for (item in items) {
            if (item !is JsonObject) continue
            val itemAttrs = item.objectValue("attrs")
            val blockId = itemAttrs?.primitiveValue("blockId")?.contentOrNull
            val checked = if (kind == BlockKind.TODO_ITEM) {
                itemAttrs?.primitiveValue("checked")?.booleanOrNull ?: false
            } else false
            val innerContent = item.arrayValue("content") ?: continue
            for (child in innerContent) {
                if (child !is JsonObject) continue
                val childType = child.primitiveValue("type")?.contentOrNull ?: continue
                when (childType) {
                    "paragraph" -> {
                        val spans = extractInlineSpans(child)
                        blocks.add(
                            DocBlock(
                                kind = kind,
                                spans = spans,
                                checked = checked,
                                indentLevel = level,
                                blockId = blockId,
                                listStart = listStart,
                                listContainerId = listContainerId,
                                listBlockId = listBlockId,
                                listParagraphBlockId = extractBlockId(child),
                                orderedListHasExplicitNullType = orderedListHasExplicitNullType,
                                sourceAttributes = identityFreeTextAttributes(child["attrs"]),
                            ),
                        )
                    }
                    "bulletList" -> flattenListNode(child, BlockKind.BULLET_ITEM, blocks, level + 1)
                    "orderedList" -> {
                        val nestedAttrs = child.objectValue("attrs")
                        val nestedStart = nestedAttrs?.primitiveValue("start")?.intOrNull ?: 1
                        flattenListNode(
                            child,
                            BlockKind.ORDERED_ITEM,
                            blocks,
                            level + 1,
                            listStart = nestedStart,
                            orderedListHasExplicitNullType = nestedAttrs?.get("type") is JsonNull,
                        )
                    }
                    "taskList" -> flattenListNode(child, BlockKind.TODO_ITEM, blocks, level + 1)
                }
            }
        }
    }

    private fun parseTableNode(node: JsonObject): TableData {
        val rows = mutableListOf<TableRow>()
        val rowNodes = node.arrayValue("content") ?: return TableData()
        for (rowNode in rowNodes.take(MAX_TABLE_ROWS)) {
            if (rowNode !is JsonObject) continue
            val cells = mutableListOf<TableCell>()
            val cellNodes = rowNode.arrayValue("content") ?: continue
            for (cellNode in cellNodes.take(MAX_TABLE_COLUMNS)) {
                if (cellNode !is JsonObject) continue
                val cellType = cellNode.primitiveValue("type")?.contentOrNull ?: "tableCell"
                val isHeader = cellType == "tableHeader"
                val attrs = cellNode.objectValue("attrs")
                val colspan = attrs?.primitiveValue("colspan")?.intOrNull ?: 1
                val rowspan = attrs?.primitiveValue("rowspan")?.intOrNull ?: 1
                val cellContent = cellNode.arrayValue("content")
                val contentNodes = cellContent?.filterIsInstance<JsonObject>().orEmpty()
                val simpleParagraph = contentNodes.singleOrNull()
                    ?.takeIf { it.primitiveValue("type")?.contentOrNull == "paragraph" }
                val editableSpans = simpleParagraph?.let(::parseEditableTableParagraph)
                val alignment = if (editableSpans != null) {
                    DocTextAlignment.fromSourceAttributes(
                        identityFreeTextAttributes(simpleParagraph["attrs"]),
                    )
                } else {
                    null
                }
                val projection = if (editableSpans == null) {
                    TableCellProjection.join(
                        contentNodes.map { projectTableBlock(it, depth = 0) },
                        separator = "\n",
                    )
                } else {
                    null
                }
                val spans = editableSpans
                    ?: projection?.unlocalizedText
                        ?.takeIf(String::isNotEmpty)
                        ?.let { listOf(InlineSpan(it)) }
                    ?: emptyList()
                val text = spans.plainText()
                cells.add(
                    TableCell(
                        text = text,
                        spans = spans,
                        alignment = alignment,
                        isHeader = isHeader,
                        colspan = colspan,
                        rowspan = rowspan,
                        rawNode = jsonObjectToMap(cellNode),
                        rawParagraph = simpleParagraph?.let(::jsonObjectToMap),
                        isReadOnlyProjection = editableSpans == null,
                        projection = projection,
                    ),
                )
            }
            rows.add(TableRow(cells = cells, rawNode = jsonObjectToMap(rowNode)))
        }
        return TableData(rows)
    }

    /**
     * 通过 [NativeDocumentSafetyPolicy.isSimpleEditableTableParagraph] 后门禁。
     * 格子编辑器正在另刀改成保留 marks；解析必须把 marks 带进 spans，否则下次
     * 整表保存会丢掉格式。数学节点或未知 inline 仍返回 null，走只读投影。
     */
    private fun parseEditableTableParagraph(node: JsonObject): List<InlineSpan>? {
        if (!NativeDocumentSafetyPolicy.isSimpleEditableTableParagraph(node)) return null
        val contentElement = node["content"] ?: return emptyList()
        val content = contentElement as? JsonArray ?: return null
        val spans = mutableListOf<InlineSpan>()
        for (element in content) {
            val inline = element as? JsonObject ?: return null
            when (inline.primitiveValue("type")?.contentOrNull) {
                "text" -> {
                    if (inline.keys.any { it !in setOf("type", "text", "marks") }) return null
                    val text = (inline["text"] as? JsonPrimitive)
                        ?.takeIf(JsonPrimitive::isString)
                        ?.contentOrNull
                        ?: return null
                    if ('\n' in text) return null
                    val marks = parseMarks(inline.arrayValue("marks"))
                    if (text.isNotEmpty()) spans.add(InlineSpan(text, marks))
                }
                "hardBreak" -> {
                    if (inline.keys != setOf("type")) return null
                    spans.add(InlineSpan("\n"))
                }
                else -> return null
            }
        }
        return spans
    }

    private fun projectTableBlock(node: JsonObject, depth: Int): TableCellProjection {
        if (depth > MAX_LIST_NESTING_DEPTH) return TableCellProjection.literal("…")
        return when (val type = node.primitiveValue("type")?.contentOrNull.orEmpty()) {
            "text" -> TableCellProjection.literal(
                node.primitiveValue("text")?.contentOrNull.orEmpty(),
            )
            "hardBreak" -> TableCellProjection.literal("\n")
            "paragraph", "heading", "codeBlock" -> TableCellProjection.join(
                node.arrayValue("content")
                    ?.filterIsInstance<JsonObject>()
                    ?.map { projectTableBlock(it, depth + 1) }
                    .orEmpty(),
                separator = "",
            )
            "blockquote", "listItem", "taskItem" -> projectTableBlockChildren(node, depth + 1)
            "bulletList", "orderedList", "taskList" -> projectTableList(node, type, depth + 1)
            "image" -> TableCellProjection.literal(
                projectTableAttribute(node, listOf("alt", "title", "name"))
                    ?.let { "🖼 $it" }
                    ?: "🖼",
            )
            "htmlBlock" -> projectTableProductSummary(node, TableContentSummaryKind.EMBEDDED_HTML)
            "tabwhiteboard" -> projectTableProductSummary(node, TableContentSummaryKind.WHITEBOARD)
            "tabdataBlock", "tabdataEmbed" ->
                projectTableProductSummary(node, TableContentSummaryKind.EMBEDDED_TABLE)
            "youtube", "video" -> projectTableProductSummary(node, TableContentSummaryKind.VIDEO)
            else -> projectTableBlockChildren(node, depth + 1).takeIf {
                it.hasVisibleContent
            } ?: TableCellProjection.summary(TableContentSummaryKind.COMPLEX_CONTENT)
        }
    }

    private fun projectTableProductSummary(
        node: JsonObject,
        kind: TableContentSummaryKind,
    ): TableCellProjection = TableCellProjection.summary(
        kind,
        projectTableAttribute(node, listOf("title", "name", "label", "alt")),
    )

    private fun projectTableBlockChildren(
        node: JsonObject,
        depth: Int,
    ): TableCellProjection = TableCellProjection.join(
        node.arrayValue("content")
            ?.filterIsInstance<JsonObject>()
            ?.map { projectTableBlock(it, depth) }
            .orEmpty(),
        separator = "\n",
    )

    private fun projectTableList(
        node: JsonObject,
        type: String,
        depth: Int,
    ): TableCellProjection {
        val start = node.objectValue("attrs")?.primitiveValue("start")?.intOrNull ?: 1
        val items = node.arrayValue("content")
            ?.filterIsInstance<JsonObject>()
            ?.mapIndexed { index, item ->
                val itemProjection = projectTableBlock(item, depth)
                val checked = item.objectValue("attrs")?.primitiveValue("checked")?.booleanOrNull == true
                val marker = when (type) {
                    "orderedList" -> "${start + index}."
                    "taskList" -> if (checked) "☑" else "☐"
                    else -> "•"
                }
                TableCellProjection.literal("$marker ")
                    .appending(itemProjection.indentContinuation("  "))
            }
            .orEmpty()
        return TableCellProjection.join(items, separator = "\n")
    }

    private fun projectTableAttribute(node: JsonObject, keys: List<String>): String? {
        val attributes = node.objectValue("attrs") ?: return null
        return keys.firstNotNullOfOrNull { key ->
            attributes.primitiveValue(key)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
        }
    }

    public fun extractInlineSpans(node: JsonObject): List<InlineSpan> {
        val content = node.arrayValue("content") ?: return listOf(InlineSpan(""))
        val spans = mutableListOf<InlineSpan>()
        for (inline in content) {
            if (inline !is JsonObject) continue
            val inlineType = inline.primitiveValue("type")?.contentOrNull ?: continue
            when (inlineType) {
                "text" -> {
                    val text = inline.primitiveValue("text")?.contentOrNull ?: ""
                    val marks = parseMarks(inline.arrayValue("marks"))
                    spans.add(InlineSpan(text, marks))
                }
                "hardBreak" -> {
                    spans.add(InlineSpan("\n"))
                }
                "image" -> {
                    // attrs 原样进模型：fileId/alt/title/width/height 与渲染期 src 都不重写。
                    val attrs = inline.objectValue("attrs")?.let(::jsonObjectToMap).orEmpty()
                    spans.add(
                        InlineSpan(
                            InlineMark.InlineImage.placeholderText(attrs),
                            listOf(InlineMark.InlineImage(inlineType, attrs)),
                        ),
                    )
                }
                "mathematics", "math", "math_inline" -> {
                    val attrs = inline.objectValue("attrs")
                    val latexValue = attrs?.primitiveValue("latex")?.contentOrNull
                    val textValue = attrs?.primitiveValue("text")?.contentOrNull
                    val valueAttribute = if (latexValue != null) "latex" else "text"
                    val latex = latexValue ?: textValue ?: ""
                    if (latex.isNotEmpty()) {
                        val semanticAttrs = attrs
                            ?.filterKeys { it != "latex" && it != "text" }
                            ?.let(::JsonObject)
                            ?.let(::jsonObjectToMap)
                            .orEmpty()
                        spans.add(
                            InlineSpan(
                                latex,
                                listOf(
                                    InlineMark.Mathematics(
                                        inlineType,
                                        valueAttribute,
                                        semanticAttrs,
                                    ),
                                ),
                            ),
                        )
                    }
                }
            }
        }
        return spans.ifEmpty { listOf(InlineSpan("")) }
    }

    private fun parseMarks(marksArray: JsonArray?): List<InlineMark> {
        if (marksArray == null) return emptyList()
        return marksArray.mapNotNull { markEl ->
            if (markEl !is JsonObject) return@mapNotNull null
            val markType = markEl.primitiveValue("type")?.contentOrNull ?: return@mapNotNull null
            when (markType) {
                "bold", "strong" -> InlineMark.Bold
                "italic", "em" -> InlineMark.Italic
                "code" -> InlineMark.Code
                "strike" -> InlineMark.Strike
                "underline" -> InlineMark.Underline
                "subscript", "sub" -> InlineMark.Subscript
                "superscript", "sup" -> InlineMark.Superscript
                "link" -> {
                    val attrs = markEl.objectValue("attrs")
                    val href = attrs?.primitiveValue("href")?.contentOrNull ?: ""
                    val target = (attrs?.get("target") as? JsonPrimitive)
                        ?.takeIf { it.isString }
                        ?.contentOrNull
                    InlineMark.Link(href, target)
                }
                "textStyle" -> {
                    val attrs = markEl.objectValue("attrs")
                    val color = attrs?.primitiveValue("color")?.contentOrNull ?: ""
                    val bgColor = attrs?.primitiveValue("backgroundColor")?.contentOrNull ?: ""
                    val fontSize = attrs?.primitiveValue("fontSize")?.contentOrNull ?: ""
                    val fontFamily = attrs?.primitiveValue("fontFamily")?.contentOrNull ?: ""
                    if (color.isNotBlank() || bgColor.isNotBlank() || fontSize.isNotBlank() || fontFamily.isNotBlank()) {
                        InlineMark.TextColor(color, bgColor, fontSize, fontFamily)
                    } else null
                }
                "highlight" -> {
                    val color = markEl.objectValue("attrs")?.primitiveValue("color")?.contentOrNull ?: "yellow"
                    InlineMark.Highlight(color)
                }
                // 未知 mark 不再丢弃：保留 type + attrs，序列化时原样写回。
                else -> {
                    val rawAttrs = (markEl["attrs"] as? JsonObject)?.let(::jsonObjectToMap) ?: emptyMap()
                    InlineMark.Unknown(markType, rawAttrs)
                }
            }
        }
    }

    private fun extractPlainText(node: JsonObject): String {
        val content = node.arrayValue("content") ?: return ""
        return content.mapNotNull { el ->
            if (el is JsonObject && el.primitiveValue("type")?.contentOrNull == "text") {
                el.primitiveValue("text")?.contentOrNull
            } else null
        }.joinToString("")
    }

    // --- Serialization ---

    public fun serializeBlocks(blocks: List<DocBlock>): JsonObject {
        // 一个引用容器被移入的块打断后会写出多个 blockquote 节点。持久身份只能落在
        // 第一段上，否则同一个 blockId 会同时出现在两个节点上，块级评论与分享锚点
        // 将无法确定指向哪一段。
        val emittedQuoteBlockIds = mutableSetOf<String>()
        // 容器被移入的块打断时会写出多个 list 节点。持久身份只锚定第一个，避免同一个
        // blockId 出现在两处、让块级评论与分享锚点失去唯一指向。
        val emittedListBlockIds = mutableSetOf<String>()
        val content = buildJsonArray {
            var i = 0
            while (i < blocks.size) {
                val block = blocks[i]
                when (block.kind) {
                    BlockKind.PARAGRAPH -> add(makeTextNode("paragraph", block.spans, block = block))
                    BlockKind.HEADING1 -> add(makeTextNode("heading", block.spans, headingLevel = 1, block = block))
                    BlockKind.HEADING2 -> add(makeTextNode("heading", block.spans, headingLevel = 2, block = block))
                    BlockKind.HEADING3 -> add(makeTextNode("heading", block.spans, headingLevel = 3, block = block))
                    BlockKind.HEADING4 -> add(makeTextNode("heading", block.spans, headingLevel = 4, block = block))
                    BlockKind.HEADING5 -> add(makeTextNode("heading", block.spans, headingLevel = 5, block = block))
                    BlockKind.HEADING6 -> add(makeTextNode("heading", block.spans, headingLevel = 6, block = block))
                    BlockKind.CODE_BLOCK -> {
                        add(buildJsonObject {
                            put("type", "codeBlock")
                            val hasLang = block.codeLanguage.isNotBlank()
                            if (hasLang || block.blockId != null) {
                                put("attrs", buildJsonObject {
                                    if (hasLang) put("language", block.codeLanguage)
                                    if (block.blockId != null) put("blockId", block.blockId)
                                })
                            }
                            if (block.text.isNotEmpty()) {
                                put("content", buildJsonArray {
                                    add(buildJsonObject { put("type", "text"); put("text", block.text) })
                                })
                            }
                        })
                    }
                    BlockKind.BLOCKQUOTE -> {
                        val end = findQuoteRunEnd(i, blocks)
                        val paragraphs = buildJsonArray {
                            for (j in i until end) {
                                add(makeTextNode("paragraph", blocks[j].spans, block = blocks[j]))
                            }
                        }
                        val quoteBlockId = block.quoteBlockId?.takeIf(emittedQuoteBlockIds::add)
                        add(buildJsonObject {
                            put("type", "blockquote")
                            if (quoteBlockId != null) {
                                put("attrs", buildJsonObject { put("blockId", quoteBlockId) })
                            }
                            put("content", paragraphs)
                        })
                        i = end - 1
                    }
                    BlockKind.BULLET_ITEM, BlockKind.ORDERED_ITEM, BlockKind.TODO_ITEM -> {
                        val end = findListRunEnd(i, blocks)
                        add(serializeListRun(blocks.subList(i, end), emittedListBlockIds))
                        i = end - 1
                    }
                    BlockKind.DIVIDER -> {
                        add(buildJsonObject {
                            put("type", "horizontalRule")
                            if (block.blockId != null) {
                                put("attrs", buildJsonObject { put("blockId", block.blockId) })
                            }
                        })
                    }
                    BlockKind.IMAGE -> {
                        val preservedParagraph = block.rawNode
                            ?.let(::mapToJsonElement)
                            ?.takeIf { raw ->
                                raw["type"]?.jsonPrimitive?.contentOrNull == "paragraph" &&
                                    (raw["content"] as? JsonArray)
                                        ?.singleOrNull()
                                        ?.let { it as? JsonObject }
                                        ?.get("type")
                                        ?.jsonPrimitive
                                        ?.contentOrNull == "image"
                            }
                        if (preservedParagraph != null) {
                            add(preservedParagraph)
                        } else {
                            add(buildJsonObject {
                                put("type", "paragraph")
                                if (block.blockId != null) {
                                    put("attrs", buildJsonObject { put("blockId", block.blockId) })
                                }
                                if (block.imageURL.isNotBlank() || block.imageFileId.isNotBlank()) {
                                    put("content", buildJsonArray {
                                        add(buildJsonObject {
                                            put("type", "image")
                                            put("attrs", buildJsonObject {
                                                put("src", block.imageURL)
                                                if (block.imageAlt.isNotBlank()) put("alt", block.imageAlt)
                                                if (block.imageFileId.isNotBlank()) put("fileId", block.imageFileId)
                                                if (block.imageWidth != null) put("width", block.imageWidth)
                                                if (block.imageHeight != null) put("height", block.imageHeight)
                                                if (block.imageTitle.isNotBlank()) put("title", block.imageTitle)
                                            })
                                        })
                                    })
                                }
                            })
                        }
                    }
                    BlockKind.TABLE -> {
                        val td = block.tableData
                        if (!block.editable && block.rawNode != null) {
                            add(mapToJsonElement(block.rawNode))
                        } else if (td != null && !td.isEmpty) {
                            add(tableDataToJsonObject(td, block.rawNode))
                        } else if (block.rawNode != null) {
                            add(mapToJsonElement(block.rawNode))
                        }
                    }
                    BlockKind.UNSUPPORTED -> {
                        if (block.rawElement != null) {
                            add(block.rawElement)
                        } else if (block.rawNode != null) {
                            add(mapToJsonElement(block.rawNode))
                        }
                    }
                }
                i++
            }
        }
        return buildJsonObject {
            put("type", "doc")
            put("content", content)
        }
    }

    private fun makeTextNode(
        type: String,
        spans: List<InlineSpan>,
        headingLevel: Int? = null,
        blockId: String? = null,
        block: DocBlock? = null,
        includeBlockIdentity: Boolean = true,
    ): JsonObject {
        val resolvedBlockId = if (includeBlockIdentity) block?.blockId ?: blockId else blockId
        val sourceAttributes = block?.sourceAttributes
        return buildJsonObject {
            put("type", type)
            if (sourceAttributes is JsonNull && headingLevel == null && resolvedBlockId == null) {
                put("attrs", JsonNull)
            } else if (sourceAttributes is JsonObject || headingLevel != null || resolvedBlockId != null) {
                put("attrs", buildJsonObject {
                    (sourceAttributes as? JsonObject)?.forEach { (key, value) ->
                        if (key == "textAlign") put(key, value)
                    }
                    if (headingLevel != null) put("level", headingLevel)
                    if (resolvedBlockId != null) put("blockId", resolvedBlockId)
                })
            }
            val inlineNodes = makeInlineTextNodes(spans)
            if (inlineNodes.isNotEmpty()) {
                put("content", buildJsonArray { inlineNodes.forEach { add(it) } })
            }
        }
    }

    private fun makeInlineTextNodes(spans: List<InlineSpan>): List<JsonObject> {
        val nodes = mutableListOf<JsonObject>()
        var pendingMathematics: InlineMark.Mathematics? = null
        val pendingMathematicsText = StringBuilder()
        var pendingImage: InlineMark.InlineImage? = null
        var pendingImageLength = 0

        fun flushMathematics() {
            val mathematics = pendingMathematics ?: return
            if (pendingMathematicsText.isNotEmpty()) {
                nodes.add(
                    buildJsonObject {
                        put("type", mathematics.nodeType)
                        put("attrs", buildJsonObject {
                            mapToJsonElement(mathematics.attrs).forEach { (key, value) ->
                                if (key != "latex" && key != "text") put(key, value)
                            }
                            put(mathematics.valueAttribute, pendingMathematicsText.toString())
                        })
                    },
                )
            }
            pendingMathematics = null
            pendingMathematicsText.clear()
        }

        // 图片身份来自 attrs，占位文字不参与写回；占位被整段删光才等于删除这张图片。
        fun flushImage() {
            val image = pendingImage ?: return
            if (pendingImageLength > 0) {
                nodes.add(
                    buildJsonObject {
                        put("type", image.nodeType)
                        put("attrs", mapToJsonElement(image.attrs))
                    },
                )
            }
            pendingImage = null
            pendingImageLength = 0
        }

        for (span in spans) {
            val image = span.marks.filterIsInstance<InlineMark.InlineImage>().firstOrNull()
            if (image != null) {
                flushMathematics()
                val pending = pendingImage
                val continuesSameAtom = pending != null &&
                    pending.atomId == image.atomId &&
                    pending.nodeType == image.nodeType &&
                    pending.attrs == image.attrs
                if (!continuesSameAtom) {
                    flushImage()
                    pendingImage = image
                }
                pendingImageLength += span.text.length
                continue
            }
            flushImage()
            val mathematics = span.marks.filterIsInstance<InlineMark.Mathematics>().firstOrNull()
            if (mathematics != null) {
                val pending = pendingMathematics
                val continuesSameAtom = pending != null &&
                    pending.atomId == mathematics.atomId &&
                    pending.nodeType == mathematics.nodeType &&
                    pending.valueAttribute == mathematics.valueAttribute &&
                    pending.attrs == mathematics.attrs
                if (!continuesSameAtom) {
                    flushMathematics()
                    pendingMathematics = mathematics
                }
                pendingMathematicsText.append(span.text)
                continue
            }
            flushMathematics()
            val lines = span.text.split("\n")
            for ((idx, line) in lines.withIndex()) {
                if (idx > 0) {
                    nodes.add(buildJsonObject { put("type", "hardBreak") })
                }
                if (line.isNotEmpty()) {
                    nodes.add(buildJsonObject {
                        put("type", "text")
                        put("text", line)
                        if (span.marks.isNotEmpty()) {
                            put("marks", buildJsonArray {
                                for (mark in span.marks) {
                                    add(serializeMark(mark))
                                }
                            })
                        }
                    })
                }
            }
        }
        flushImage()
        flushMathematics()
        return nodes
    }

    private fun serializeMark(mark: InlineMark): JsonObject = buildJsonObject {
        when (mark) {
            is InlineMark.Bold -> put("type", "bold")
            is InlineMark.Italic -> put("type", "italic")
            is InlineMark.Code -> put("type", "code")
            is InlineMark.Strike -> put("type", "strike")
            is InlineMark.Underline -> put("type", "underline")
            is InlineMark.Subscript -> put("type", "subscript")
            is InlineMark.Superscript -> put("type", "superscript")
            is InlineMark.Link -> {
                put("type", "link")
                put("attrs", buildJsonObject {
                    put("href", mark.href)
                    if (mark.target != null) put("target", mark.target)
                })
            }
            is InlineMark.TextColor -> {
                put("type", "textStyle")
                put("attrs", buildJsonObject {
                    if (mark.color.isNotBlank()) put("color", mark.color)
                    if (mark.backgroundColor.isNotBlank()) put("backgroundColor", mark.backgroundColor)
                    if (mark.fontSize.isNotBlank()) put("fontSize", mark.fontSize)
                    if (mark.fontFamily.isNotBlank()) put("fontFamily", mark.fontFamily)
                })
            }
            is InlineMark.Highlight -> {
                put("type", "highlight")
                put("attrs", buildJsonObject { put("color", mark.color) })
            }
            is InlineMark.Mathematics -> {
                put("type", mark.nodeType)
                put("attrs", buildJsonObject {
                    mapToJsonElement(mark.attrs).forEach { (key, value) ->
                        if (key != "latex" && key != "text") put(key, value)
                    }
                })
            }
            // 行内图片是节点不是 mark，正常路径由 makeInlineTextNodes 直接写节点。
            is InlineMark.InlineImage -> {
                put("type", mark.nodeType)
                put("attrs", mapToJsonElement(mark.attrs))
            }
            is InlineMark.Unknown -> {
                put("type", mark.type)
                if (mark.attrs.isNotEmpty()) {
                    put("attrs", mapToJsonElement(mark.attrs))
                }
            }
        }
    }

    private fun serializeListRun(
        items: List<DocBlock>,
        emittedListBlockIds: MutableSet<String>,
    ): JsonObject {
        if (items.isEmpty()) return buildJsonObject { put("type", "bulletList"); put("content", buildJsonArray {}) }
        val minLevel = items.minOf { it.indentLevel }
        return buildListNode(items, 0, minLevel, emittedListBlockIds = emittedListBlockIds).first
    }

    private fun buildListNode(
        items: List<DocBlock>,
        startIdx: Int,
        level: Int,
        depth: Int = 0,
        emittedListBlockIds: MutableSet<String>,
    ): Pair<JsonObject, Int> {
        if (depth > MAX_LIST_NESTING_DEPTH) {
            var i = startIdx
            while (i < items.size && items[i].indentLevel >= level) i++
            return Pair(buildJsonObject { put("type", "bulletList"); put("content", buildJsonArray {}) }, i)
        }
        val kind = items[startIdx].kind
        val containerId = items[startIdx].listContainerId
        val listType = when (kind) {
            BlockKind.BULLET_ITEM -> "bulletList"
            BlockKind.ORDERED_ITEM -> "orderedList"
            BlockKind.TODO_ITEM -> "taskList"
            else -> "bulletList"
        }
        val listItems = mutableListOf<JsonObject>()
        var i = startIdx

        while (i < items.size && items[i].indentLevel >= level) {
            if (items[i].indentLevel == level &&
                items[i].kind == kind &&
                items[i].listContainerId == containerId
            ) {
                val item = items[i]
                val childContent = mutableListOf<JsonObject>()
                childContent.add(
                    makeTextNode(
                        "paragraph",
                        item.spans,
                        // 项身份留在 listItem 上；这里写回的是项内段落自己的持久身份。
                        blockId = item.listParagraphBlockId,
                        block = item,
                        includeBlockIdentity = false,
                    ),
                )
                i++
                while (i < items.size && items[i].indentLevel > level) {
                    val (childList, newIdx) = buildListNode(
                        items,
                        i,
                        items[i].indentLevel,
                        depth + 1,
                        emittedListBlockIds,
                    )
                    childContent.add(childList)
                    i = newIdx
                }
                listItems.add(buildJsonObject {
                    put("type", if (kind == BlockKind.TODO_ITEM) "taskItem" else "listItem")
                    if (kind == BlockKind.TODO_ITEM || item.blockId != null) {
                        put("attrs", buildJsonObject {
                            if (kind == BlockKind.TODO_ITEM) put("checked", item.checked)
                            if (item.blockId != null) put("blockId", item.blockId)
                        })
                    }
                    put("content", buildJsonArray { childContent.forEach { add(it) } })
                })
            } else {
                break
            }
        }

        val persistentId = items.getOrNull(startIdx)?.listBlockId
        val containerBlockId = if (persistentId != null && emittedListBlockIds.add(persistentId)) {
            persistentId
        } else {
            null
        }
        val start = items.getOrNull(startIdx)?.listStart ?: 1
        val hasExplicitNullType = items.getOrNull(startIdx)?.orderedListHasExplicitNullType == true
        // 带持久身份的容器一定会落 attrs，start 必须一并写回，否则来源里的 start=1 会被吞掉。
        val writesOrderedShape = listType == "orderedList" &&
            (start != 1 || hasExplicitNullType || containerBlockId != null)
        return Pair(buildJsonObject {
            put("type", listType)
            if (containerBlockId != null || writesOrderedShape) {
                put("attrs", buildJsonObject {
                    if (containerBlockId != null) put("blockId", containerBlockId)
                    if (writesOrderedShape) {
                        put("start", start)
                        if (hasExplicitNullType) put("type", JsonNull)
                    }
                })
            }
            put("content", buildJsonArray { listItems.forEach { add(it) } })
        }, i)
    }

    private fun tableDataToJsonObject(
        tableData: TableData,
        rawTable: Map<String, Any?>?,
    ): JsonObject = buildJsonObject {
        rawTable.asJsonObject()?.forEach { (key, value) ->
            if (key != "content") put(key, value)
        }
        put("type", "table")
        put("content", buildJsonArray {
            tableData.rows.forEach { add(tableRowToJsonObject(it)) }
        })
    }

    private fun tableRowToJsonObject(row: TableRow): JsonObject = buildJsonObject {
        row.rawNode.asJsonObject()?.forEach { (key, value) ->
            if (key != "content") put(key, value)
        }
        put("type", "tableRow")
        put("content", buildJsonArray {
            row.cells.forEach { add(tableCellToJsonObject(it)) }
        })
    }

    private fun tableCellToJsonObject(cell: TableCell): JsonObject {
        if (cell.isReadOnlyProjection) {
            cell.rawNode.asJsonObject()?.let { return it }
        }
        return buildJsonObject {
            cell.rawNode.asJsonObject()?.forEach { (key, value) ->
                if (key != "content") put(key, value)
            }
            put("type", if (cell.isHeader) "tableHeader" else "tableCell")
            if (cell.rawNode == null && (cell.colspan > 1 || cell.rowspan > 1)) {
                put("attrs", buildJsonObject {
                    if (cell.colspan > 1) put("colspan", cell.colspan)
                    if (cell.rowspan > 1) put("rowspan", cell.rowspan)
                })
            }
            val cellSpans = cell.spans.ifEmpty {
                if (cell.text.isEmpty()) emptyList() else listOf(InlineSpan(cell.text))
            }
            val inlines = makeInlineTextNodes(cellSpans)
            put("content", buildJsonArray {
                add(buildJsonObject {
                    val rawParagraph = cell.rawParagraph.asJsonObject()
                    rawParagraph?.forEach { (key, value) ->
                        if (key != "content") put(key, value)
                    }
                    put("type", "paragraph")
                    if (rawParagraph == null && cell.alignment != null) {
                        put("attrs", buildJsonObject {
                            put("textAlign", cell.alignment.serializedValue)
                        })
                    }
                    if (inlines.isNotEmpty()) {
                        put("content", buildJsonArray { inlines.forEach { add(it) } })
                    }
                })
            })
        }
    }

    private fun Map<String, Any?>?.asJsonObject(): JsonObject? =
        this?.let(::mapToJsonElement)

    private fun findQuoteRunEnd(start: Int, blocks: List<DocBlock>): Int {
        val containerId = blocks[start].quoteContainerId ?: return start + 1
        var i = start + 1
        while (i < blocks.size &&
            blocks[i].kind == BlockKind.BLOCKQUOTE &&
            blocks[i].quoteContainerId == containerId
        ) {
            i++
        }
        return i
    }

    private fun findListRunEnd(start: Int, blocks: List<DocBlock>): Int {
        val baseKind = blocks[start].kind
        val baseLevel = blocks[start].indentLevel
        val baseContainerId = blocks[start].listContainerId
        var i = start + 1
        while (i < blocks.size && blocks[i].kind.isListLike &&
            (blocks[i].indentLevel > baseLevel ||
                (blocks[i].indentLevel == baseLevel &&
                    blocks[i].kind == baseKind &&
                    blocks[i].listContainerId == baseContainerId))
        ) {
            i++
        }
        return i
    }

    // --- Markdown / Plaintext ---

    private fun spansToMarkdownText(spans: List<InlineSpan>): String = spans.joinToString("") { span ->
        if (span.marks.any { it is InlineMark.Mathematics }) "\$${span.text}\$" else span.text
    }

    public fun blocksToMarkdown(blocks: List<DocBlock>): String {
        val lines = mutableListOf<String>()
        var i = 0
        while (i < blocks.size) {
            val b = blocks[i]
            val mdText = spansToMarkdownText(b.spans)
            when (b.kind) {
                BlockKind.PARAGRAPH -> lines.add(mdText)
                BlockKind.HEADING1 -> lines.add("# $mdText")
                BlockKind.HEADING2 -> lines.add("## $mdText")
                BlockKind.HEADING3 -> lines.add("### $mdText")
                BlockKind.HEADING4 -> lines.add("#### $mdText")
                BlockKind.HEADING5 -> lines.add("##### $mdText")
                BlockKind.HEADING6 -> lines.add("###### $mdText")
                BlockKind.BULLET_ITEM -> {
                    val indent = "  ".repeat(b.indentLevel)
                    lines.add("${indent}- $mdText")
                }
                BlockKind.ORDERED_ITEM -> {
                    val indent = "  ".repeat(b.indentLevel)
                    lines.add("${indent}1. $mdText")
                }
                BlockKind.TODO_ITEM -> {
                    val indent = "  ".repeat(b.indentLevel)
                    lines.add("${indent}- [${if (b.checked) "x" else " "}] $mdText")
                }
                BlockKind.CODE_BLOCK -> {
                    lines.add("```${b.codeLanguage}")
                    lines.add(b.text)
                    lines.add("```")
                }
                BlockKind.BLOCKQUOTE -> lines.add("> $mdText")
                BlockKind.DIVIDER -> lines.add("---")
                BlockKind.IMAGE -> lines.add("![${b.imageAlt}](${b.imageReference()})")
                BlockKind.TABLE -> {
                    val td = b.tableData
                    if (td != null && !td.isEmpty) {
                        for ((ri, row) in td.rows.withIndex()) {
                            lines.add("| " + row.cells.joinToString(" | ") { it.text } + " |")
                            if (ri == 0) {
                                lines.add("| " + row.cells.joinToString(" | ") { "---" } + " |")
                            }
                        }
                    }
                }
                BlockKind.UNSUPPORTED -> {}
            }
            if (i < blocks.size - 1) lines.add("")
            i++
        }
        return lines.joinToString("\n").trim()
    }

    public fun blocksToPlaintext(
        blocks: List<DocBlock>,
        renderTableCell: (TableCell) -> String = TableCell::text,
    ): String {
        return blocks.mapNotNull { b ->
            when (b.kind) {
                BlockKind.DIVIDER -> "---"
                BlockKind.IMAGE -> b.imageAlt.ifBlank { b.imageReference() }.trim().ifEmpty { null }
                BlockKind.TABLE -> {
                    b.tableData?.rows?.joinToString("\n") { row ->
                        row.cells.joinToString("\t", transform = renderTableCell)
                    }
                }
                BlockKind.UNSUPPORTED -> null
                else -> b.text.trim().ifEmpty { null }
            }
        }.joinToString("\n")
    }

    private fun DocBlock.imageReference(): String = imageFileId
        .takeIf(String::isNotBlank)
        ?.let { "tabtin-file://asset/$it" }
        ?: imageURL

    // --- JSON helpers ---

    private fun JsonObject.objectValue(key: String): JsonObject? = this[key] as? JsonObject

    private fun JsonObject.arrayValue(key: String): JsonArray? = this[key] as? JsonArray

    private fun JsonObject.primitiveValue(key: String): JsonPrimitive? = this[key] as? JsonPrimitive

    /**
     * Map 是既有 UI 投影 API；[source] 才是序列化真源。数字绝不能先经过
     * Long/Double 再写回，否则科学计数法、超大整数和高精度小数都会变形。
     */
    private class JsonBackedMap(
        val source: JsonObject,
        projection: Map<String, Any?>,
    ) : AbstractMap<String, Any?>() {
        override val entries: Set<Map.Entry<String, Any?>> = projection.entries
    }

    private fun jsonObjectToMap(obj: JsonObject): Map<String, Any?> = JsonBackedMap(
        source = obj,
        projection = obj.mapValues { (_, value) -> jsonElementToAny(value) },
    )

    private fun jsonElementToAny(element: JsonElement): Any? = when (element) {
        is JsonNull -> null
        is JsonPrimitive -> when {
            element.isString -> element.content
            element.content == "true" -> true
            element.content == "false" -> false
            element.content.contains('.') -> element.content.toDoubleOrNull()
            else -> element.content.toLongOrNull() ?: element.content
        }
        is JsonArray -> element.map { jsonElementToAny(it) }
        is JsonObject -> jsonObjectToMap(element)
    }

    private fun mapToJsonElement(map: Map<String, Any?>): JsonObject {
        if (map is JsonBackedMap) return map.source
        return buildJsonObject {
            for ((key, value) in map) {
                put(key, anyToJsonElement(value))
            }
        }
    }

    private fun anyToJsonElement(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is Boolean -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is String -> JsonPrimitive(value)
        is List<*> -> buildJsonArray { value.forEach { add(anyToJsonElement(it)) } }
        is Map<*, *> -> buildJsonObject {
            @Suppress("UNCHECKED_CAST")
            for ((k, v) in value as Map<String, Any?>) {
                put(k, anyToJsonElement(v))
            }
        }
        else -> JsonPrimitive(value.toString())
    }
}
