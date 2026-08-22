package com.tabtin.mobile.features.doc.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 409 后判断远端版本推进是否只是服务端补齐节点身份或 schema 缺省属性。
 *
 * 只忽略 `blockId` 和按节点类型白名单确认的 schema 默认值；标题、节点顺序、文本、
 * 格式、非默认属性及未知属性都保持严格比较。
 */
public object NativeDocumentConflictRebasePolicy {
    public fun remoteMatchesCommittedSnapshot(
        remoteTitle: String,
        remoteDocument: JsonObject,
        committedTitle: String,
        committedDocument: JsonObject,
    ): Boolean = remoteTitle == committedTitle &&
        isSafeNormalizationInput(remoteDocument) &&
        isSafeNormalizationInput(committedDocument) &&
        normalize(remoteDocument) == normalize(committedDocument)

    private fun normalize(element: JsonElement): JsonElement = when (element) {
        is JsonObject -> {
            val nodeType = (element["type"] as? JsonPrimitive)
                ?.takeIf { it.isString }
                ?.contentOrNull
            buildJsonObject {
                element.forEach { (key, value) ->
                    if (key == GENERATED_BLOCK_ID_KEY) return@forEach
                    if (key == ATTRIBUTES_KEY && value is JsonObject) {
                        val normalizedAttributes = normalizeAttributes(value, nodeType)
                        if (normalizedAttributes.isEmpty()) return@forEach
                        put(key, normalizedAttributes)
                        return@forEach
                    }
                    val normalized = normalize(value)
                    if (key == ATTRIBUTES_KEY && normalized is JsonObject && normalized.isEmpty()) {
                        return@forEach
                    }
                    put(key, normalized)
                }
            }
        }
        is JsonArray -> buildJsonArray { element.forEach { add(normalize(it)) } }
        else -> element
    }

    /**
     * 归一化只服务于自动 rebase，输入结构无法证明符合节点 schema 时必须拒绝比较。
     * 这既避免 jsonPrimitive 对 object/array 抛异常，也避免两份相同的畸形 JSON 被误判等价。
     */
    private fun isSafeNormalizationInput(element: JsonElement): Boolean = when (element) {
        is JsonObject -> {
            val nodeType = when (val type = element["type"]) {
                null -> null
                is JsonPrimitive -> type.contentOrNull
                    ?.takeIf { type.isString && it.isNotBlank() }
                    ?: return false
                else -> return false
            }
            val attributes = element[ATTRIBUTES_KEY]
            if (attributes != null) {
                val attributeObject = attributes as? JsonObject ?: return false
                if (!hasValidSchemaAttributeShapes(attributeObject, nodeType)) return false
            }
            element.all { (key, value) ->
                // attrs 是数据对象，不把其中名为 `type` 的业务属性误当成节点类型。
                key == ATTRIBUTES_KEY || isSafeNormalizationInput(value)
            }
        }
        is JsonArray -> element.all(::isSafeNormalizationInput)
        else -> true
    }

    private fun hasValidSchemaAttributeShapes(
        attributes: JsonObject,
        nodeType: String?,
    ): Boolean {
        if (nodeType !in setOf("tableCell", "tableHeader")) return true
        return listOf("colspan", "rowspan").all { key ->
            val value = attributes[key] ?: return@all true
            if (value is JsonNull) return@all true
            val dimension = (value as? JsonPrimitive)
                ?.takeUnless { it.isString }
                ?.intOrNull
            dimension != null && dimension >= 1
        }
    }

    private fun normalizeAttributes(attributes: JsonObject, nodeType: String?): JsonObject =
        buildJsonObject {
            attributes.forEach { (key, value) ->
                if (key == GENERATED_BLOCK_ID_KEY) return@forEach
                if (isKnownSchemaDefault(key, value, nodeType)) return@forEach
                put(key, normalize(value))
            }
        }

    /**
     * 协作层的 ProseMirror schema 会把缺省属性显式写回 JSON。这里只忽略 schema
     * 明确定义的默认值；同名属性一旦带非默认值，仍按真实内容变化处理。
     */
    private fun isKnownSchemaDefault(key: String, value: JsonElement, nodeType: String?): Boolean =
        when (nodeType) {
            "paragraph", "heading" -> key == "textAlign" && value is JsonNull
            "codeBlock" -> key == "language" && value is JsonNull
            "taskItem" -> key == "todoId" && value is JsonNull
            "tableCell", "tableHeader" -> when (key) {
                "colwidth" -> value is JsonNull
                "colspan", "rowspan" -> (value as? JsonPrimitive)
                    ?.takeUnless { it.isString }
                    ?.intOrNull == 1
                else -> false
            }
            "image" -> key in setOf("fileId", "alt", "title", "width", "height") &&
                value is JsonNull
            else -> false
        }

    private const val GENERATED_BLOCK_ID_KEY = "blockId"
    private const val ATTRIBUTES_KEY = "attrs"
}

/**
 * 判定 ProseMirror 内容能否经过当前原生模型编辑后安全写回。
 *
 * 这里的允许集合必须是 [ProseMirrorParser] 的解析器和序列化器的交集。策略宁可把
 * 文档交给完整编辑器，也不能放行一个随后会被 parser 吞掉、默认化或换层级的字段。
 * 缺省值（例如 `textAlign=null`、`checked=false`）允许被 canonical serializer 省略；
 * 非缺省语义必须能被原生模型保留。
 */
public object NativeDocumentSafetyPolicy {
    private const val MAX_LIST_NESTING_DEPTH = 20

    private val canonicalMarkTypes = setOf(
        "bold",
        "italic",
        "code",
        "strike",
        "underline",
        "subscript",
        "superscript",
        "link",
        "textStyle",
        "highlight",
    )
    private val listTypes = setOf("bulletList", "orderedList", "taskList")

    public fun canEditWithoutLoss(document: JsonObject): Boolean {
        if (document.keys.any { it !in setOf("type", "content") }) return false
        if (document.string("type") != "doc") return false

        // `description_json={}` 是旧数据缺失正文，不等于一份明确的空文档。整文档
        // replace 若把它当成可编辑内容，用户第一次输入就会覆盖仍存在于 markdown 的正文。
        val content = document["content"] as? JsonArray ?: return false
        if (content.any { it !is JsonObject }) return false
        return content.all { isSafeTopLevel(it as JsonObject) }
    }

    /**
     * 逐块可编辑性（批次 1b）：单个顶层块能否交给原生编辑链路。
     *
     * 与 [canEditWithoutLoss] 的整篇门禁不同，这里回答「这一块能不能编辑」；
     * 判定为 false 的块由 parser 保留原始子树、按局部只读呈现，不再牵连整篇。
     * 表格由 [isEditableTable] 单独判定；结构安全的表格允许逐格编辑，不能无损
     * 写回的复杂单元格仍由 parser 标记为局部只读。
     */
    public fun isEditableTopLevel(node: JsonObject): Boolean = when (node.string("type")) {
        "paragraph" -> isSafeParagraph(node, allowBlockId = true, allowUnknownRange = true)
        "heading" -> isSafeHeading(node)
        "codeBlock" -> isSafeCodeBlock(node)
        "blockquote" -> isSafeBlockquote(node)
        in listTypes -> isSafeList(node, depth = 0)
        "horizontalRule" -> isSafeHorizontalRule(node)
        else -> false
    }

    /**
     * 简单可编辑表格：无合并单元格、无自定义列宽，每个单元格是单个段落
     * （text + canonical marks + hardBreak）。未知 mark / 行内公式 / 复杂内容
     * 仍只读保留，避免写回时丢掉无法表达的格式。
     */
    public fun isSimpleEditableTable(node: JsonObject): Boolean {
        if (node.string("type") != "table") return false
        if (!node.hasOnlyKeys("type", "attrs", "content")) return false
        val attrs = node.optionalAttrsAllowMissing() ?: return false
        if (!attrs.hasOnlyKeys("blockId") || !attrs.hasOptionalString("blockId")) return false
        val rows = node.strictChildren() ?: return false
        if (rows.isEmpty()) return false
        return rows.all { row ->
            if (row.string("type") != "tableRow" || !row.hasOnlyKeys("type", "content")) {
                return@all false
            }
            val cells = row.strictChildren() ?: return@all false
            if (cells.isEmpty()) return@all false
            cells.all(::isSimpleEditableCell)
        }
    }

    /**
     * 表格能否进入原生逐格编辑链路。这里仅要求表格结构可以一一映射；单元格
     * 内容能否编辑由 parser 继续逐格判定，复杂格保留原始节点并保持只读。
     */
    public fun isEditableTable(node: JsonObject): Boolean =
        node.string("type") == "table" && isSafeTable(node)

    private fun isSimpleEditableCell(cell: JsonObject): Boolean {
        val type = cell.string("type")
        if (type != "tableCell" && type != "tableHeader") return false
        if (!cell.hasOnlyKeys("type", "attrs", "content")) return false
        val attrs = cell.optionalAttrsAllowMissing() ?: return false
        if (!attrs.hasOnlyKeys("colspan", "rowspan", "colwidth")) return false
        val colspan = attrs["colspan"]
        if (colspan != null && colspan !is JsonNull && colspan.asInt() != 1) return false
        val rowspan = attrs["rowspan"]
        if (rowspan != null && rowspan !is JsonNull && rowspan.asInt() != 1) return false
        if (!attrs.isNullOrMissing("colwidth")) return false

        val children = cell.strictChildren() ?: return false
        val paragraph = children.singleOrNull() ?: return false
        return isSimpleEditableTableParagraph(paragraph)
    }

    /**
     * 表格格子可消费的单段落契约。text 允许 type/text/marks，marks 走正文同一套
     * 安全口径；没有 marks 字段仍是可编辑纯文本。parser 复用此门禁，非法内容
     * 只把当前格降为只读投影，不会在保存时被 serializer 静默压平。
     */
    public fun isSimpleEditableTableParagraph(paragraph: JsonObject): Boolean {
        if (paragraph.string("type") != "paragraph") return false
        if (!paragraph.hasOnlyKeys("type", "attrs", "content")) return false
        val paragraphAttrs = paragraph.optionalAttrsAllowMissing() ?: return false
        if (!paragraphAttrs.hasOnlyKeys("blockId", "textAlign")) return false
        if (!paragraphAttrs.hasOptionalString("blockId")) return false
        if (!paragraphAttrs.hasSafeTextAlignment()) return false

        val inlines = paragraph.strictChildren() ?: return false
        return inlines.all { inline ->
            when (inline.string("type")) {
                "text" ->
                    inline.hasOnlyKeys("type", "text", "marks") &&
                        inline.nonEmptyString("text")?.contains('\n') == false &&
                        hasSafeMarks(inline)
                "hardBreak" -> inline.hasOnlyKeys("type")
                else -> false
            }
        }
    }

    private fun isSafeTopLevel(node: JsonObject): Boolean = when (node.string("type")) {
        "paragraph" -> isSafeParagraph(node, allowBlockId = true, allowUnknownRange = true)
        "heading" -> isSafeHeading(node)
        "codeBlock" -> isSafeCodeBlock(node)
        "blockquote" -> isSafeBlockquote(node)
        in listTypes -> isSafeList(node, depth = 0)
        "horizontalRule" -> isSafeHorizontalRule(node)
        "table" -> isSafeTable(node)
        // 顶层 legacy image 及未知原子块仍不能无损编辑。
        "image" -> false
        else -> false
    }

    private fun isSafeParagraph(
        node: JsonObject,
        allowBlockId: Boolean,
        allowUnknownRange: Boolean = false,
    ): Boolean {
        if (!node.hasOnlyKeys("type", "attrs", "content")) return false
        if (!hasSafeTextBlockAttributes(node, allowBlockId)) return false
        if (isStandaloneImageParagraph(node)) {
            // 图片使用独立表面，不消费段落对齐；仅 schema 自然值可安全忽略。
            return node.optionalAttrsAllowMissing()?.isNullOrMissing("textAlign") == true
        }
        return hasSafeTextInlineContent(node, allowUnknownRange)
    }

    private fun isSafeHeading(node: JsonObject): Boolean {
        if (!node.hasOnlyKeys("type", "attrs", "content")) return false
        val attrs = node.optionalAttrs() ?: return false
        val level = attrs["level"]?.asInt() ?: return false
        if (level !in 1..6) return false
        if (!attrs.hasOnlyKeys("level", "blockId", "textAlign")) return false
        if (!attrs.hasOptionalString("blockId")) return false
        if (!attrs.hasSafeTextAlignment()) return false
        return hasSafeTextInlineContent(node)
    }

    private fun isSafeCodeBlock(node: JsonObject): Boolean {
        if (!node.hasOnlyKeys("type", "attrs", "content")) return false
        val attrs = node.optionalAttrsAllowMissing() ?: return false
        if (!attrs.hasOnlyKeys("language", "blockId")) return false
        if (!attrs.hasOptionalString("language") || !attrs.hasOptionalString("blockId")) return false

        val content = node.strictChildren() ?: return false
        return content.all { inline ->
            inline.string("type") == "text" &&
                inline.hasOnlyKeys("type", "text") &&
                inline.nonEmptyString("text") != null
        }
    }

    private fun isSafeBlockquote(node: JsonObject): Boolean {
        if (!node.hasOnlyKeys("type", "attrs", "content")) return false
        // 容器身份由 DocBlock.quoteBlockId 独立承载并原样写回引用节点，不再下放到子段落。
        // 只放行能完整重建的非空字符串身份；`blockId: null` 这类写回后会改变 JSON 形态的
        // 形态继续局部只读。
        val attrs = node.optionalAttrsAllowMissing() ?: return false
        if (!attrs.hasOnlyKeys("blockId")) return false
        if ("blockId" in attrs && attrs.nonEmptyString("blockId") == null) return false
        val children = node.strictChildren() ?: return false
        if (children.isEmpty()) return false
        return children.all { child ->
            child.string("type") == "paragraph" && isSafeParagraph(child, allowBlockId = true)
                && !isStandaloneImageParagraph(child)
        }
    }

    private fun isSafeList(node: JsonObject, depth: Int): Boolean {
        if (depth > MAX_LIST_NESTING_DEPTH) return false
        if (!node.hasOnlyKeys("type", "attrs", "content")) return false
        val listType = node.string("type") ?: return false
        val attrs = node.optionalAttrsAllowMissing() ?: return false
        when (listType) {
            "orderedList" -> {
                val hasCanonicalNullType = attrs["type"] is JsonNull
                if (hasCanonicalNullType) {
                    // Electron 当前会把默认编号样式写成 `type=null`。原生只放行
                    // 已确认的完整缺省形态；非空类型、缺少 start 或额外属性都可能
                    // 带有当前模型无法表达的编号语义，必须保持局部只读。
                    if (!attrs.hasOnlyKeys("start", "type", "blockId") || attrs["start"]?.asInt() != 1) {
                        return false
                    }
                } else if ("type" in attrs || !attrs.hasOnlyKeys("start", "blockId")) {
                    return false
                }
                val start = attrs["start"]
                if (start != null && start !is JsonNull && start.asInt() == null) return false
                // 带身份的容器写回时一定会落 attrs，缺省的 start 会被补成 1；原本没有
                // start 的容器因此会凭空长出属性，保持局部只读更安全。
                if ("blockId" in attrs && start == null) return false
            }
            "bulletList", "taskList" -> if (!attrs.hasOnlyKeys("blockId")) return false
            else -> return false
        }
        // 容器持久身份只能按非空字符串重建；null 与非字符串写回后会被 canonicalize 掉。
        if ("blockId" in attrs && attrs.nonEmptyString("blockId") == null) return false

        val items = node.strictChildren() ?: return false
        if (items.isEmpty()) return false
        val expectedItemType = if (listType == "taskList") "taskItem" else "listItem"
        return items.all { item -> isSafeListItem(item, expectedItemType, depth) }
    }

    private fun isSafeListItem(item: JsonObject, expectedType: String, depth: Int): Boolean {
        if (item.string("type") != expectedType) return false
        if (!item.hasOnlyKeys("type", "attrs", "content")) return false
        val attrs = item.optionalAttrsAllowMissing() ?: return false
        if (expectedType == "taskItem") {
            if (!attrs.hasOnlyKeys("checked", "blockId", "todoId")) return false
            val checked = attrs["checked"]
            if (checked != null && checked !is JsonNull && checked.asBoolean() == null) return false
            // todoId 尚未进入 DocBlock，只有 schema 默认 null 可以安全 canonicalize。
            if (!attrs.isNullOrMissing("todoId")) return false
        } else if (!attrs.hasOnlyKeys("blockId") || !attrs.hasOptionalString("blockId")) {
            return false
        }
        if (!attrs.hasOptionalString("blockId")) return false

        val children = item.strictChildren() ?: return false
        // flattenListNode 会把多个段落拆成多个 item；每个 item 必须恰好一个正文段落，
        // 后面最多跟一个嵌套列表，才能由 serializer 重建同一层级关系。
        if (children.size !in 1..2) return false
        val paragraph = children.first()
        if (paragraph.string("type") != "paragraph") return false
        // 项内段落与 listItem 是两个可被引用的节点，各自保留身份。
        if (!isSafeParagraph(paragraph, allowBlockId = true) ||
            isStandaloneImageParagraph(paragraph)
        ) return false
        // 段落身份同样只能按非空字符串重建。
        val paragraphAttrs = paragraph.optionalAttrsAllowMissing() ?: return false
        if ("blockId" in paragraphAttrs && paragraphAttrs.nonEmptyString("blockId") == null) return false
        if (children.size == 2) {
            val nested = children[1]
            if (nested.string("type") !in listTypes || !isSafeList(nested, depth + 1)) return false
        }
        return true
    }

    private fun isSafeHorizontalRule(node: JsonObject): Boolean {
        if (!node.hasOnlyKeys("type", "attrs")) return false
        val attrs = node.optionalAttrsAllowMissing() ?: return false
        return attrs.hasOnlyKeys("blockId") && attrs.hasOptionalString("blockId")
    }

    /**
     * 表格顶层、行与单元格的未知属性由 raw JSON 原样保留。这里只约束解析映射
     * 必须一一对应：矩形、无合并、未超过移动端可编辑上限。复杂 cell 内容会被
     * 逐格标记为只读，不影响同表内标准纯文本 cell 的编辑。
     */
    private fun isSafeTable(node: JsonObject): Boolean {
        val rows = node.strictChildren() ?: return false
        if (rows.isEmpty() || rows.size > TableData.MAX_ROW_COUNT) return false
        var columnCount: Int? = null
        return rows.all { row ->
            if (row.string("type") != "tableRow") return@all false
            val cells = row.strictChildren() ?: return@all false
            if (cells.isEmpty() || cells.size > TableData.MAX_COLUMN_COUNT) return@all false
            if (columnCount != null && cells.size != columnCount) return@all false
            columnCount = cells.size
            cells.all(::isSafeTableCellShape)
        }
    }

    private fun isSafeTableCellShape(cell: JsonObject): Boolean {
        if (cell.string("type") !in setOf("tableCell", "tableHeader")) return false
        val attrs = cell.optionalAttrsAllowMissing() ?: return false
        for (key in listOf("colspan", "rowspan")) {
            val value = attrs[key] ?: continue
            if (value !is JsonNull && value.asInt() != 1) return false
        }
        return cell.strictChildren() != null
    }

    private fun hasSafeTextInlineContent(
        node: JsonObject,
        allowUnknownRange: Boolean = false,
    ): Boolean {
        val content = node.strictChildren() ?: return false
        return content.all { isSafeTextInline(it, allowUnknownRange) }
    }

    private fun isSafeTextInline(
        inline: JsonObject,
        allowUnknownRange: Boolean = false,
    ): Boolean = when (inline.string("type")) {
        "text" -> {
            inline.hasOnlyKeys("type", "text", "marks") &&
                inline.nonEmptyString("text")?.contains('\n') == false &&
                hasSafeMarks(inline, allowUnknownRange)
        }
        "hardBreak" -> inline.hasOnlyKeys("type")
        "image" -> isSafeInlineImage(inline)
        "mathematics" -> {
            if (!inline.hasOnlyKeys("type", "attrs")) return false
            val attrs = inline.optionalAttrs() ?: return false
            if (!attrs.hasOnlyKeys("latex", "display")) return false
            if (attrs.nonEmptyString("latex") == null) return false
            val display = attrs["display"]
            display == null || display is JsonNull || display.asBoolean() == false
        }
        else -> false
    }

    private fun hasSafeMarks(node: JsonObject, allowUnknownRange: Boolean = false): Boolean {
        val marksElement = node["marks"] ?: return true
        val marks = marksElement as? JsonArray ?: return false
        // serialize 会省略空 marks，放行后写回会改变 raw 形态。
        if (marks.isEmpty()) return false
        return marks.all { element ->
            val mark = element as? JsonObject ?: return@all false
            isSafeMark(mark, allowUnknownRange)
        }
    }

    /**
     * 未知 mark 是向前兼容的不透明范围身份：只放行能完整重建的形态。
     * 表格格仍走 [allowUnknownRange]=false，避免轻量预览误解锁。
     */
    private fun isSafeUnknownRangeMark(mark: JsonObject): Boolean {
        if (!mark.hasOnlyKeys("type", "attrs")) return false
        val type = mark.string("type") ?: return false
        if (type.isEmpty()) return false
        val attrs = mark["attrs"] ?: return true
        // 空对象写回会被省略，无法与「没有 attrs」区分，必须继续只读。
        return attrs is JsonObject && attrs.isNotEmpty()
    }

    private fun isSafeMark(mark: JsonObject, allowUnknownRange: Boolean = false): Boolean {
        val type = mark.string("type") ?: return false
        if (type !in canonicalMarkTypes) {
            return allowUnknownRange && isSafeUnknownRangeMark(mark)
        }
        return when (type) {
            "bold", "italic", "code", "strike", "underline", "subscript", "superscript" ->
                mark.hasOnlyKeys("type")
            "link" -> {
                if (!mark.hasOnlyKeys("type", "attrs")) return false
                val attrs = mark.optionalAttrs() ?: return false
                if (attrs.nonEmptyString("href") == null) return false
                attrs.keys == setOf("href") ||
                    (attrs.keys == setOf("href", "target") && attrs.string("target") == "_blank")
            }
            "textStyle" -> {
                if (!mark.hasOnlyKeys("type", "attrs")) return false
                val attrs = mark.optionalAttrs() ?: return false
                // Editable 目前只能把前景色原样回收为 textStyle。backgroundColor 会被
                // 误收为 highlight，fontSize/fontFamily 则没有可回收的 mark；放行会在
                // 用户编辑相邻文字时静默改写文档语义，因此这些形态必须局部只读。
                attrs.keys == setOf("color") && isNativeRoundTripColor(attrs.string("color"))
            }
            "highlight" -> {
                if (!mark.hasOnlyKeys("type", "attrs")) return false
                val attrs = mark.optionalAttrs() ?: return false
                // Renderer 只会为 Android 能解析的颜色建立身份 span。CSS 函数、变量
                // 等无法解析的值若进入 Editable 会整条消失，必须 fail-closed。
                attrs.keys == setOf("color") && isNativeRoundTripHighlightColor(attrs.string("color"))
            }
            else -> false
        }
    }

    /**
     * Android Color.parseColor 与 CSS 对 8 位 hex 的通道顺序不同，因此这里只接受双方
     * 语义一致的 #RRGGBB；其他值局部只读，避免“字符串没丢但颜色显示错”。
     */
    private fun isNativeRoundTripColor(color: String?): Boolean =
        color?.matches(NATIVE_ROUND_TRIP_COLOR) == true

    private fun isNativeRoundTripHighlightColor(color: String?): Boolean =
        color == DEFAULT_HIGHLIGHT_COLOR || isNativeRoundTripColor(color)

    private fun hasSafeTextBlockAttributes(node: JsonObject, allowBlockId: Boolean): Boolean {
        val attrs = node.optionalAttrsAllowMissing() ?: return false
        val allowed = if (allowBlockId) setOf("blockId", "textAlign") else setOf("textAlign")
        if (attrs.keys.any { it !in allowed }) return false
        if (allowBlockId && !attrs.hasOptionalString("blockId")) return false
        return attrs.hasSafeTextAlignment()
    }

    private fun isStandaloneImageParagraph(node: JsonObject): Boolean {
        val image = node.strictChildren()?.singleOrNull() ?: return false
        return isSafeInlineImage(image)
    }

    /**
     * 图片节点能否在原生模型里往返。attrs 会被整体带进 mark 再原样写回，因此这里
     * 只放行值类型可无损重建的已知键；未知键或结构化值继续局部只读。
     *
     * `src` 只是渲染期地址，允许原样带回但不构成身份；`fileId` 才是稳定引用。
     */
    private fun isSafeInlineImage(image: JsonObject): Boolean {
        if (image.string("type") != "image") return false
        if (!image.hasOnlyKeys("type", "attrs")) return false
        val attrs = image.optionalAttrs() ?: return false
        if (!attrs.hasOnlyKeys("src", "fileId", "file_id", "alt", "width", "height", "title")) return false
        if (!attrs.hasOptionalString("src") ||
            !attrs.hasOptionalString("fileId") ||
            !attrs.hasOptionalString("file_id") ||
            !attrs.hasOptionalString("alt") ||
            !attrs.hasOptionalString("title") ||
            !attrs.hasOptionalInt("width") ||
            !attrs.hasOptionalInt("height")
        ) return false
        val src = attrs.string("src").orEmpty()
        val fileId = attrs.string("fileId").orEmpty().ifBlank { attrs.string("file_id").orEmpty() }
        return src.isNotBlank() || fileId.isNotBlank()
    }

    private fun JsonObject.strictChildren(): List<JsonObject>? {
        val contentElement = this["content"] ?: return emptyList()
        val content = contentElement as? JsonArray ?: return null
        if (content.any { it !is JsonObject }) return null
        return content.map { it as JsonObject }
    }

    /** Missing attrs and a JSON object are valid; any other JSON type is not. */
    private fun JsonObject.optionalAttrsAllowMissing(): JsonObject? {
        val attrs = this["attrs"] ?: return EMPTY_OBJECT
        if (attrs is JsonNull) return EMPTY_OBJECT
        return attrs as? JsonObject
    }

    /** This node/mark requires an attrs object. */
    private fun JsonObject.optionalAttrs(): JsonObject? = this["attrs"] as? JsonObject

    private fun JsonObject.hasNoSemanticAttrs(): Boolean {
        val attrs = optionalAttrsAllowMissing() ?: return false
        return attrs.isEmpty()
    }

    private fun JsonObject.hasOnlyKeys(vararg allowed: String): Boolean = keys.all { it in allowed }

    private fun JsonObject.hasOptionalString(key: String): Boolean {
        val value = this[key] ?: return true
        return value is JsonNull || value.asString() != null
    }

    private fun JsonObject.hasOptionalInt(key: String): Boolean {
        val value = this[key] ?: return true
        return value is JsonNull || value.asInt() != null
    }

    private fun JsonObject.hasSafeTextAlignment(): Boolean {
        val value = this["textAlign"] ?: return true
        if (value is JsonNull) return true
        return DocTextAlignment.fromSerializedValue(value.asString()) != null
    }

    private fun JsonObject.isNullOrMissing(key: String): Boolean = this[key] == null || this[key] is JsonNull

    private fun JsonObject.string(key: String): String? = this[key].asString()

    private fun JsonObject.nonEmptyString(key: String): String? = string(key)?.takeIf(String::isNotEmpty)

    private fun JsonElement?.asString(): String? =
        (this as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun JsonElement?.asInt(): Int? =
        (this as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

    private fun JsonElement?.asBoolean(): Boolean? =
        (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    private val EMPTY_OBJECT = JsonObject(emptyMap())
    private const val DEFAULT_HIGHLIGHT_COLOR = "yellow"
    private val NATIVE_ROUND_TRIP_COLOR = Regex("^#[0-9A-Fa-f]{6}$")
}
