package com.tabtin.mobile.features.doc.editor

import com.tabtin.mobile.features.doc.editor.core.BlockViewConverter
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.DocTextAlignment
import com.tabtin.mobile.features.doc.model.InlineMark
import com.tabtin.mobile.features.doc.model.InlineMarkKind
import com.tabtin.mobile.features.doc.model.InlineSpan
import com.tabtin.mobile.features.doc.model.plainText
import java.util.UUID
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * 编辑器操作编排器 —— 纯函数式操作层，不持有任何状态。
 *
 * 所有方法都是纯函数：输入旧的 blocks 列表，输出新的 blocks 列表。
 * ViewModel 负责持有状态并调用这些方法。
 */
public object DocEditorOrchestrator {

    private fun DocBlock.hasExplicitTextAlignment(): Boolean =
        DocTextAlignment.fromSourceAttributes(sourceAttributes) != null

    /**
     * 在指定 block 之后创建新块。
     * @return (新列表, 新创建的 block)
     */
    public fun createBlock(
        blocks: List<DocBlock>,
        afterBlockId: String,
        kind: BlockKind,
    ): Pair<List<DocBlock>, DocBlock> {
        val result = blocks.toMutableList()
        val index = result.indexOfFirst { it.id == afterBlockId }
        val insertAt = when {
            index < 0 -> result.size
            result[index].kind.isListLike -> {
                val topLevelAncestor = topLevelListAncestorIndex(result, index)
                listSubtreeEnd(result, topLevelAncestor)
            }
            else -> index + 1
        }
        val newBlock = DocBlock.empty(kind)
        result.add(insertAt, newBlock)
        return result to newBlock
    }

    /**
     * 分裂块 —— Enter 键行为：在光标位置将当前块一分为二。
     *
     * 特殊规则：
     * - 列表类型的空块按 Enter → 降级为 PARAGRAPH
     * - 列表块 Enter → 新块继承列表类型和缩进
     * - 其他类型 Enter → 新块为 PARAGRAPH
     *
     * @return (新列表, 新创建的 block)
     */
    public fun splitBlock(
        blocks: List<DocBlock>,
        blockId: String,
        cursorPosition: Int,
        spans: List<InlineSpan>,
    ): Pair<List<DocBlock>, DocBlock> {
        val result = blocks.toMutableList()
        val index = result.indexOfFirst { it.id == blockId }
        if (index < 0) {
            val newBlock = DocBlock.empty(BlockKind.PARAGRAPH)
            result.add(newBlock)
            return result to newBlock
        }

        val current = result[index]

        // 列表类型空块按 Enter → 降级为段落
        if (current.kind.isListLike && current.text.isEmpty()) {
            if (wouldDetachListStructure(result, index, BlockKind.PARAGRAPH)) {
                return result to current
            }
            val listTransition = listTransitionFor(current, BlockKind.PARAGRAPH)
            result[index] = current.copy(
                kind = BlockKind.PARAGRAPH,
                indentLevel = listTransition.indentLevel,
                listStart = listTransition.listStart,
                orderedListHasExplicitNullType = listTransition.orderedListHasExplicitNullType,
                listContainerId = listTransition.listContainerId,
                blockId = listTransition.blockId,
                listBlockId = listTransition.listBlockId,
                listParagraphBlockId = listTransition.listParagraphBlockId,
            )
            renewTrailingListRunAfterSplit(blocks, result, index, BlockKind.PARAGRAPH)
            return result to result[index]
        }

        val (spansBefore, spansAfter) = splitSpansAt(spans, cursorPosition)
        result[index] = current.copy(spans = spansBefore)

        val newKind = if (current.kind.isListLike) current.kind else BlockKind.PARAGRAPH
        val newIndent = if (current.kind.isListLike) current.indentLevel else 0
        val newBlock = DocBlock(
            kind = newKind,
            spans = spansAfter,
            indentLevel = newIndent,
            listStart = if (current.kind == BlockKind.ORDERED_ITEM) current.listStart else 1,
            orderedListHasExplicitNullType = current.kind == BlockKind.ORDERED_ITEM &&
                current.orderedListHasExplicitNullType,
            listContainerId = if (current.kind.isListLike) current.listContainerId else null,
            // 拆出来的是同一个容器里的新项：容器身份沿用，项与项内段落都是新节点。
            listBlockId = if (current.kind.isListLike) current.listBlockId else null,
            sourceAttributes = identityFreeSourceAttributes(current.sourceAttributes),
        )
        result.add(index + 1, newBlock)
        return result to newBlock
    }

    /**
     * 合并块 —— Backspace 在块首时，把当前正文接到上一块末尾并删除当前块。
     * 带子树的列表项不能安全提升，保持原状，避免静默丢失子项。
     *
     * @return (新列表, 合并后应聚焦的 blockId, 聚焦光标位置)
     */
    public fun mergeWithPrevious(
        blocks: List<DocBlock>,
        blockId: String,
    ): Triple<List<DocBlock>, String?, Int> {
        val result = blocks.toMutableList()
        val index = result.indexOfFirst { it.id == blockId }
        if (index < 0) return Triple(result, null, 0)

        val current = result[index]

        // 已经是最前面的块，不可合并
        if (index == 0) return Triple(result, blockId, 0)

        // 只有一个块时不删除
        if (result.size <= 1) return Triple(result, blockId, 0)

        if (current.kind.isListLike && listSubtreeEnd(result, index) > index + 1) {
            return Triple(result, blockId, 0)
        }

        val prevBlock = result[index - 1]
        // 非文本块的序列化不会消费 spans。把正文合进图片、表格、
        // 分隔线或未知块后再删掉当前块，会在保存时静默丢文。
        if (!canMergeInlineContent(prevBlock, current)) {
            return Triple(result, blockId, 0)
        }
        val cursorPos = prevBlock.text.length
        val mergedSpans = mergeSpans(prevBlock.spans, current.spans)
        result[index - 1] = prevBlock.copy(spans = mergedSpans)
        result.removeAt(index)

        return Triple(result, prevBlock.id, cursorPos)
    }

    /** 删除指定块 */
    public fun deleteBlock(blocks: List<DocBlock>, blockId: String): List<DocBlock> {
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return blocks
        val end = if (blocks[index].kind.isListLike) listSubtreeEnd(blocks, index) else index + 1
        return blocks.filterIndexed { cursor, _ -> cursor !in index until end }
    }

    /** 更新块的文本内容（InlineSpan 列表） */
    public fun updateBlockText(
        blocks: List<DocBlock>,
        blockId: String,
        newSpans: List<InlineSpan>,
    ): List<DocBlock> {
        return blocks.map {
            if (it.id == blockId) it.copy(spans = newSpans) else it
        }
    }

    /** Turn Into —— 将指定块转换为另一种类型 */
    public fun turnIntoBlock(
        blocks: List<DocBlock>,
        blockId: String,
        newKind: BlockKind,
    ): List<DocBlock> {
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return blocks
        val target = blocks[index]
        // codeBlock 只序列化纯文本，不消费 ProseMirror marks。若让粗体、链接、公式
        // 或未来 mark 进入该路径，下一次保存会静默吞掉格式/原子语义。
        if (newKind == BlockKind.CODE_BLOCK &&
            (target.spans.any { it.marks.isNotEmpty() } || target.hasExplicitTextAlignment())
        ) {
            return blocks
        }
        if (wouldDetachListStructure(blocks, index, newKind) ||
            wouldCreateMultipleNestedLists(blocks, index, newKind)
        ) return blocks

        val listTransition = listTransitionFor(target, newKind)
        val result = blocks.toMutableList()
        result[index] = target.copy(
            kind = newKind,
            indentLevel = listTransition.indentLevel,
            listStart = listTransition.listStart,
            orderedListHasExplicitNullType = listTransition.orderedListHasExplicitNullType,
            listContainerId = listTransition.listContainerId,
            blockId = listTransition.blockId,
            listBlockId = listTransition.listBlockId,
            listParagraphBlockId = listTransition.listParagraphBlockId,
            quoteContainerId = when {
                newKind != BlockKind.BLOCKQUOTE -> null
                target.kind == BlockKind.BLOCKQUOTE ->
                    target.quoteContainerId ?: UUID.randomUUID().toString()
                else -> UUID.randomUUID().toString()
            },
            quoteBlockId = quoteBlockIdFor(target, newKind),
        )
        renewTrailingListRunAfterSplit(blocks, result, index, newKind)
        return result
    }

    /**
     * 引用容器的持久身份只属于同一个 blockquote 节点：转出引用时随该节点消失，
     * 段落新转成的引用是全新容器、没有协作身份，只有原地保持引用才继续携带。
     */
    private fun quoteBlockIdFor(source: DocBlock, newKind: BlockKind): String? =
        if (newKind == BlockKind.BLOCKQUOTE && source.kind == BlockKind.BLOCKQUOTE) {
            source.quoteBlockId
        } else {
            null
        }

    /** 更新代码块的语言 */
    public fun updateCodeLanguage(
        blocks: List<DocBlock>,
        blockId: String,
        language: String,
    ): List<DocBlock> {
        return blocks.map {
            if (it.id == blockId) it.copy(codeLanguage = language) else it
        }
    }

    /** 更新 checkbox 的 checked 状态 */
    public fun updateCheckbox(
        blocks: List<DocBlock>,
        blockId: String,
        isChecked: Boolean,
    ): List<DocBlock> {
        return blocks.map {
            if (it.id == blockId) it.copy(checked = isChecked) else it
        }
    }

    /** 增加缩进层级（最大 MAX_INDENT_LEVEL） */
    public fun indent(blocks: List<DocBlock>, blockId: String): List<DocBlock> {
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return blocks
        val target = blocks[index]
        if (!target.kind.canIndent || target.indentLevel >= DocBlock.MAX_INDENT_LEVEL) return blocks

        // 增加一级缩进等价于成为前一个同层兄弟的孩子。首项、跨容器项或父级结构
        // 不完整时没有可证明的父项；直接拒绝，避免 serializer 以 minLevel 归零。
        val previousSiblingIndex = previousListSiblingIndex(blocks, index) ?: return blocks
        val nestedLevel = target.indentLevel + 1
        val existingNestedSibling = ((previousSiblingIndex + 1) until index)
            .firstOrNull { cursor ->
                blocks[cursor].kind.isListLike && blocks[cursor].indentLevel == nestedLevel
            }
            ?.let(blocks::get)
        if (existingNestedSibling != null && existingNestedSibling.kind != target.kind) return blocks

        val nestedContainerId = existingNestedSibling?.listContainerId ?: UUID.randomUUID().toString()
        val nestedStart = existingNestedSibling?.listStart ?: 1
        val nestedHasExplicitNullType = existingNestedSibling?.orderedListHasExplicitNullType ?: false
        // 并入已存在的嵌套容器时沿用它的持久身份；新建的嵌套容器还没有身份。
        val nestedListBlockId = existingNestedSibling?.listBlockId
        val subtreeEnd = listSubtreeEnd(blocks, index)
        return blocks.mapIndexed { cursor, block ->
            if (cursor !in index until subtreeEnd) return@mapIndexed block
            val shifted = block.copy(indentLevel = block.indentLevel + 1)
            if (cursor == index) {
                shifted.copy(
                    listContainerId = nestedContainerId,
                    listBlockId = nestedListBlockId,
                    listStart = nestedStart,
                    orderedListHasExplicitNullType = nestedHasExplicitNullType,
                )
            } else {
                shifted
            }
        }
    }

    /** 减少缩进层级（最小 0） */
    public fun unindent(blocks: List<DocBlock>, blockId: String): List<DocBlock> {
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return blocks
        val target = blocks[index]
        if (!target.kind.isListLike || target.indentLevel <= 0) return blocks
        val parentIndex = listParentIndex(blocks, index)
        if (parentIndex < 0) return blocks
        val parent = blocks[parentIndex]
        if (parent.kind != target.kind) return blocks

        val subtreeEnd = listSubtreeEnd(blocks, index)
        val hasFollowingSibling = subtreeEnd < blocks.size &&
            blocks[subtreeEnd].kind.isListLike &&
            blocks[subtreeEnd].indentLevel == target.indentLevel &&
            listParentIndex(blocks, subtreeEnd) == parentIndex
        if (hasFollowingSibling) return blocks

        return blocks.mapIndexed { cursor, block ->
            if (cursor !in index until subtreeEnd) return@mapIndexed block
            val shifted = block.copy(indentLevel = block.indentLevel - 1)
            if (cursor == index) {
                shifted.copy(
                    listContainerId = parent.listContainerId,
                    listBlockId = parent.listBlockId,
                    listStart = parent.listStart,
                    orderedListHasExplicitNullType = parent.orderedListHasExplicitNullType,
                )
            } else {
                shifted
            }
        }
    }

    /** 复制块 —— 在原块之后插入一个深拷贝副本 */
    public fun duplicateBlock(blocks: List<DocBlock>, blockId: String): Pair<List<DocBlock>, DocBlock?> {
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return blocks to null
        val original = blocks[index]
        // 只有结构化文本块能在不重用持久化身份的前提下安全复制。
        // 复杂/只读块的 rawNode 和表格内层 rawParagraph 可能携带 blockId，
        // 在有完整深复制与身份续期策略前必须 fail closed。
        if (!original.editable || !original.kind.canDuplicateSafely()) return blocks to null
        val renewedAtomIds = mutableMapOf<String, String>()
        fun renewedAtomId(atomId: String): String =
            renewedAtomIds.getOrPut(atomId) { UUID.randomUUID().toString() }
        val duplicateSourceAttributes = identityFreeSourceAttributes(original.sourceAttributes)
        val duplicate = DocBlock(
            kind = original.kind,
            spans = original.spans.map { span ->
                span.copy(
                    marks = span.marks.map { mark ->
                        when (mark) {
                            is InlineMark.Mathematics ->
                                mark.copy(atomId = renewedAtomId(mark.atomId))
                            is InlineMark.InlineImage ->
                                mark.copy(atomId = renewedAtomId(mark.atomId))
                            else -> mark
                        }
                    },
                )
            },
            checked = original.checked,
            indentLevel = original.indentLevel,
            listStart = original.listStart,
            orderedListHasExplicitNullType = original.orderedListHasExplicitNullType,
            listContainerId = original.listContainerId,
            // 副本落在同一个容器里，但项与项内段落都是新节点，不复用持久身份。
            listBlockId = original.listBlockId,
            codeLanguage = original.codeLanguage,
            imageURL = original.imageURL,
            imageAlt = original.imageAlt,
            sourceAttributes = duplicateSourceAttributes,
            tableData = original.tableData,
        )
        val result = blocks.toMutableList()
        val insertAt = if (original.kind.isListLike) listSubtreeEnd(blocks, index) else index + 1
        result.add(insertAt, duplicate)
        return result to duplicate
    }

    /** 新块只继承排版语义与 attrs 形态，永不继承持久化块身份或旧 heading level。 */
    private fun identityFreeSourceAttributes(attributes: JsonElement?): JsonElement? = when (attributes) {
        null -> null
        JsonNull -> JsonNull
        is JsonObject -> JsonObject(attributes.filterKeys { it == "textAlign" })
        else -> null
    }

    private data class ListTransition(
        val indentLevel: Int,
        val listStart: Int,
        val orderedListHasExplicitNullType: Boolean,
        val listContainerId: String?,
        val blockId: String?,
        val listBlockId: String?,
        val listParagraphBlockId: String?,
    )

    /**
     * 容器身份只属于一个具体类型的 ProseMirror list 节点。列表类型不变时沿用；
     * 跨类型复用会让 UI 延续编号，而 serializer 已拆成另一份列表。离开列表时清空
     * 全部列表状态，重新进入时从独立的 start=1 容器开始。
     *
     * 持久身份按节点归属搬运：容器身份与 [DocBlock.listContainerId] 同生共死；列表项
     * 与项内段落是两个节点，进出列表时各自的身份跟着对应节点走，不互相顶替。
     */
    private fun listTransitionFor(block: DocBlock, newKind: BlockKind): ListTransition = when {
        !newKind.isListLike -> ListTransition(
            indentLevel = 0,
            listStart = 1,
            orderedListHasExplicitNullType = false,
            listContainerId = null,
            // 列表项提升为普通块后留下的是项内那个段落节点；listItem 身份随节点一起
            // 消失，挪用到新块上会让块级评论锚到错误的对象。
            blockId = if (block.kind.isListLike) block.listParagraphBlockId else block.blockId,
            listBlockId = null,
            listParagraphBlockId = null,
        )
        block.kind == newKind -> ListTransition(
            indentLevel = block.indentLevel,
            listStart = block.listStart,
            orderedListHasExplicitNullType = block.orderedListHasExplicitNullType,
            listContainerId = block.listContainerId,
            blockId = block.blockId,
            listBlockId = block.listBlockId,
            listParagraphBlockId = block.listParagraphBlockId,
        )
        else -> ListTransition(
            indentLevel = if (block.kind.isListLike) block.indentLevel else 0,
            listStart = 1,
            orderedListHasExplicitNullType = false,
            listContainerId = UUID.randomUUID().toString(),
            // 换到另一个容器：容器身份属于旧的 list 节点，不跟着走。普通块转成列表项时
            // 正文落进新建的项内段落，原块身份随正文下沉，新 listItem 自身没有持久身份。
            blockId = if (block.kind.isListLike) block.blockId else null,
            listBlockId = null,
            listParagraphBlockId = if (block.kind.isListLike) {
                block.listParagraphBlockId
            } else {
                block.blockId
            },
        )
    }

    private fun wouldDetachListStructure(
        blocks: List<DocBlock>,
        index: Int,
        newKind: BlockKind,
    ): Boolean = blocks[index].kind.isListLike &&
        !newKind.isListLike &&
        (listSubtreeEnd(blocks, index) > index + 1 || hasFollowingListSibling(blocks, index))

    private fun wouldCreateMultipleNestedLists(
        blocks: List<DocBlock>,
        index: Int,
        newKind: BlockKind,
    ): Boolean {
        val source = blocks[index]
        if (!source.kind.isListLike ||
            !newKind.isListLike ||
            source.kind == newKind ||
            source.indentLevel == 0
        ) return false

        val parentIndex = listParentIndex(blocks, index)
        if (parentIndex < 0) return true
        return blocks.indices.any { cursor ->
            cursor != index &&
                blocks[cursor].kind.isListLike &&
                blocks[cursor].indentLevel == source.indentLevel &&
                listParentIndex(blocks, cursor) == parentIndex
        }
    }

    private fun hasFollowingListSibling(blocks: List<DocBlock>, index: Int): Boolean {
        val source = blocks[index]
        if (!source.kind.isListLike || source.indentLevel == 0) return false
        val parentIndex = listParentIndex(blocks, index)
        if (parentIndex < 0) return true
        val nextIndex = listSubtreeEnd(blocks, index)
        if (nextIndex >= blocks.size) return false
        val next = blocks[nextIndex]
        return next.kind.isListLike &&
            next.indentLevel == source.indentLevel &&
            listParentIndex(blocks, nextIndex) == parentIndex
    }

    /**
     * 类型转换会把原列表切成前后两段。后缀若继续复用旧容器身份，UI 的编号计数会
     * 穿过中间的新列表类型继续累加，而 serializer/reload 会按后缀自身的 listStart
     * 重新开始。给后缀同层兄弟续一个运行时身份，使保存前后看到同一序列。
     */
    private fun renewTrailingListRunAfterSplit(
        sourceBlocks: List<DocBlock>,
        updatedBlocks: MutableList<DocBlock>,
        sourceIndex: Int,
        newKind: BlockKind,
    ) {
        val source = sourceBlocks[sourceIndex]
        if (!source.kind.isListLike || source.kind == newKind) return

        val renewedContainerId = UUID.randomUUID().toString()
        var cursor = listSubtreeEnd(sourceBlocks, sourceIndex)
        while (cursor < sourceBlocks.size) {
            val trailing = sourceBlocks[cursor]
            if (!trailing.kind.isListLike ||
                trailing.kind != source.kind ||
                trailing.indentLevel != source.indentLevel ||
                trailing.listContainerId != source.listContainerId
            ) {
                return
            }
            // 续期成新容器：持久身份仍锚在被打断前的那个 list 节点上，续期段不再携带。
            updatedBlocks[cursor] = updatedBlocks[cursor].copy(
                listContainerId = renewedContainerId,
                listBlockId = null,
            )
            cursor = listSubtreeEnd(sourceBlocks, cursor)
        }
    }

    private fun canMergeInlineContent(previous: DocBlock, current: DocBlock): Boolean {
        if (!previous.canEditInline || !current.canEditInline) return false
        if (!previous.kind.carriesInlineContent() || !current.kind.carriesInlineContent()) return false

        // 空块没有语义内容可丢，可以跨普通文本/代码类型直接删除并回到上一块。
        if (current.text.isEmpty()) return true

        // 代码块只能和代码块合并；否则富文本 mark 会在代码块序列化时丢失。
        return (previous.kind == BlockKind.CODE_BLOCK) == (current.kind == BlockKind.CODE_BLOCK)
    }

    private fun BlockKind.carriesInlineContent(): Boolean =
        this == BlockKind.PARAGRAPH ||
            isHeading ||
            isListLike ||
            this == BlockKind.CODE_BLOCK ||
            this == BlockKind.BLOCKQUOTE

    private fun BlockKind.canDuplicateSafely(): Boolean = carriesInlineContent()

    /**
     * 移动块位置（fromIndex → toIndex）。
     *
     * 列表在内存中是展平的先序序列，缩进更深的连续项实际属于前一个父项。移动列表项
     * 必须把这段后代一起移动，并把落点吸附到同层兄弟子树的边界；否则下一次序列化会
     * 把后代挂到错误父项。跨层级、跨容器或跨普通块的落点无法无歧义表达，直接拒绝。
     */
    public fun moveBlock(blocks: List<DocBlock>, fromIndex: Int, toIndex: Int): List<DocBlock> {
        if (fromIndex == toIndex) return blocks
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= blocks.size || toIndex >= blocks.size) return blocks

        val source = blocks[fromIndex]
        if (source.kind.isListLike) {
            return moveListSubtree(blocks, fromIndex, toIndex)
        }

        // 普通块仍保留既有的单块移动语义，但不能插入展平列表内部；当前 API 没有携带
        // “放到整份列表之前/之后”的意图，宁可不移动，也不能改变列表父子关系。
        if (blocks[toIndex].kind.isListLike) return blocks

        val result = blocks.toMutableList()
        val item = result.removeAt(fromIndex)
        result.add(toIndex, item)
        return result
    }

    private fun moveListSubtree(
        blocks: List<DocBlock>,
        fromIndex: Int,
        toIndex: Int,
    ): List<DocBlock> {
        val sourceEnd = listSubtreeEnd(blocks, fromIndex)
        val targetIndex = resolveListSiblingTarget(
            blocks = blocks,
            sourceIndex = fromIndex,
            sourceEnd = sourceEnd,
            requestedIndex = toIndex,
        ) ?: return blocks
        val targetEnd = listSubtreeEnd(blocks, targetIndex)
        val insertionBoundary = if (targetIndex > fromIndex) targetEnd else targetIndex
        val subtree = blocks.subList(fromIndex, sourceEnd)
        val result = blocks.toMutableList().apply {
            subList(fromIndex, sourceEnd).clear()
        }
        val adjustedBoundary = if (insertionBoundary > fromIndex) {
            insertionBoundary - subtree.size
        } else {
            insertionBoundary
        }
        result.addAll(adjustedBoundary, subtree)
        return result
    }

    /** 返回 [start, end) 中 end：当前列表项及其连续、更深缩进的全部后代。 */
    private fun listSubtreeEnd(blocks: List<DocBlock>, start: Int): Int {
        val rootIndent = blocks[start].indentLevel
        var end = start + 1
        while (end < blocks.size &&
            blocks[end].kind.isListLike &&
            blocks[end].indentLevel > rootIndent
        ) {
            end++
        }
        return end
    }

    private fun topLevelListAncestorIndex(blocks: List<DocBlock>, index: Int): Int {
        var ancestor = index
        while (blocks[ancestor].indentLevel > 0) {
            val parent = listParentIndex(blocks, ancestor)
            if (parent < 0) return index
            ancestor = parent
        }
        return ancestor
    }

    private fun resolveListSiblingTarget(
        blocks: List<DocBlock>,
        sourceIndex: Int,
        sourceEnd: Int,
        requestedIndex: Int,
    ): Int? {
        val source = blocks[sourceIndex]
        val candidateIndex = if (requestedIndex in sourceIndex until sourceEnd) {
            // “下移”按钮传入 from + 1；对带孩子的父项而言它恰好落在自己的子树内。
            // 将它归一到紧随整棵源子树之后的兄弟，而不是把父项与孩子拆开。
            if (requestedIndex <= sourceIndex || sourceEnd >= blocks.size) return null
            sourceEnd
        } else {
            siblingAncestorAtLevel(blocks, requestedIndex, source.indentLevel) ?: return null
        }

        if (candidateIndex in sourceIndex until sourceEnd) return null
        if (!isSameListSiblingScope(blocks, sourceIndex, candidateIndex)) return null
        return candidateIndex
    }

    /** 将落在兄弟后代上的位置吸附回该兄弟；落到更浅层或普通块时无法安全映射。 */
    private fun siblingAncestorAtLevel(
        blocks: List<DocBlock>,
        index: Int,
        level: Int,
    ): Int? {
        var cursor = index
        while (cursor >= 0) {
            val block = blocks[cursor]
            if (!block.kind.isListLike) return null
            if (block.indentLevel <= level) {
                return cursor.takeIf { block.indentLevel == level }
            }
            cursor--
        }
        return null
    }

    private fun previousListSiblingIndex(blocks: List<DocBlock>, index: Int): Int? {
        val level = blocks[index].indentLevel
        for (cursor in index - 1 downTo 0) {
            val candidate = blocks[cursor]
            if (!candidate.kind.isListLike || candidate.indentLevel < level) return null
            if (candidate.indentLevel == level) {
                return cursor.takeIf { isSameListSiblingScope(blocks, index, cursor) }
            }
        }
        return null
    }

    private fun isSameListSiblingScope(
        blocks: List<DocBlock>,
        sourceIndex: Int,
        targetIndex: Int,
    ): Boolean {
        val source = blocks[sourceIndex]
        val target = blocks[targetIndex]
        if (!target.kind.isListLike ||
            target.kind != source.kind ||
            target.indentLevel != source.indentLevel ||
            target.listContainerId != source.listContainerId
        ) {
            return false
        }

        if (listParentIndex(blocks, sourceIndex) != listParentIndex(blocks, targetIndex)) return false

        // 新建列表在分配运行时容器身份前可能为 null；此时不能跨普通块猜测两边属于
        // 同一列表。连续的同层结构仍可由父项与缩进关系唯一确定。
        val between = if (sourceIndex < targetIndex) {
            (sourceIndex + 1) until targetIndex
        } else {
            (targetIndex + 1) until sourceIndex
        }
        return between.all { blocks[it].kind.isListLike }
    }

    /** -1 表示顶层，-2 表示结构不完整，非负数表示直接父列表项的位置。 */
    private fun listParentIndex(blocks: List<DocBlock>, index: Int): Int {
        val level = blocks[index].indentLevel
        if (level == 0) return -1

        for (cursor in index - 1 downTo 0) {
            val candidate = blocks[cursor]
            if (!candidate.kind.isListLike) return -2
            if (candidate.indentLevel < level) {
                return if (candidate.indentLevel == level - 1) cursor else -2
            }
        }
        return -2
    }

    // ── Markdown 快捷语法（纯函数） ──────────────────────────────────────

    public data class MarkdownShortcutResult(
        val blocks: List<DocBlock>,
        val focusBlockId: String?,
        val cursorPosition: Int?,
    )

    public fun applyMarkdownShortcut(
        blocks: List<DocBlock>,
        blockId: String,
        text: String,
        targetKind: BlockKind,
        prefixLength: Int,
    ): MarkdownShortcutResult {
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return MarkdownShortcutResult(blocks, null, null)

        val result = blocks.toMutableList()

        if (wouldDetachListStructure(blocks, index, targetKind) ||
            wouldCreateMultipleNestedLists(blocks, index, targetKind)
        ) {
            return MarkdownShortcutResult(blocks, blockId, null)
        }
        if ((targetKind == BlockKind.CODE_BLOCK || targetKind == BlockKind.DIVIDER) &&
            result[index].hasExplicitTextAlignment()
        ) {
            return MarkdownShortcutResult(blocks, blockId, null)
        }
        if (targetKind == BlockKind.DIVIDER) {
            result[index] = result[index].copy(
                kind = BlockKind.DIVIDER,
                spans = listOf(InlineSpan("")),
                checked = false,
                indentLevel = 0,
                codeLanguage = "",
                imageURL = "",
                imageAlt = "",
                imageFileId = "",
                imageWidth = null,
                imageHeight = null,
                imageTitle = "",
                listStart = 1,
                orderedListHasExplicitNullType = false,
                listContainerId = null,
                listBlockId = null,
                listParagraphBlockId = null,
                quoteContainerId = null,
                quoteBlockId = null,
                sourceAttributes = null,
                rawNode = null,
                rawElement = null,
                unsupportedType = null,
                tableData = null,
            )
            val newBlock = DocBlock.empty(BlockKind.PARAGRAPH)
            result.add(index + 1, newBlock)
            return MarkdownShortcutResult(result, newBlock.id, 0)
        }

        val remaining = text.substring(prefixLength)
        val isChecked = text.startsWith("[x] ")
        val listTransition = listTransitionFor(result[index], targetKind)
        result[index] = result[index].copy(
            kind = targetKind,
            spans = listOf(InlineSpan(remaining)),
            checked = isChecked,
            indentLevel = listTransition.indentLevel,
            listStart = listTransition.listStart,
            orderedListHasExplicitNullType = listTransition.orderedListHasExplicitNullType,
            listContainerId = listTransition.listContainerId,
            blockId = listTransition.blockId,
            listBlockId = listTransition.listBlockId,
            listParagraphBlockId = listTransition.listParagraphBlockId,
            quoteContainerId = when {
                targetKind != BlockKind.BLOCKQUOTE -> null
                result[index].kind == BlockKind.BLOCKQUOTE ->
                    result[index].quoteContainerId ?: UUID.randomUUID().toString()
                else -> UUID.randomUUID().toString()
            },
            quoteBlockId = quoteBlockIdFor(result[index], targetKind),
        )
        renewTrailingListRunAfterSplit(blocks, result, index, targetKind)
        return MarkdownShortcutResult(result, blockId, 0)
    }

    // ── Slash 文本清理（纯函数） ─────────────────────────────────────

    public data class SlashCommandResult(
        val blocks: List<DocBlock>,
        val focusBlockId: String?,
        val cursorPosition: Int?,
    )

    public fun applySlashCommand(
        blocks: List<DocBlock>,
        blockId: String,
        slashStart: Int,
        filterLen: Int,
        targetKind: BlockKind,
    ): SlashCommandResult {
        val cleaned = cleanSlashPrefix(blocks, blockId, slashStart, filterLen)
        val commandBlock = cleaned.firstOrNull { it.id == blockId }
            ?: return SlashCommandResult(cleaned, null, null)
        if (commandBlock.text.isEmpty() && targetKind.isEditable) {
            val converted = turnIntoBlock(cleaned, blockId, targetKind)
            if (converted.firstOrNull { it.id == blockId }?.kind == targetKind) {
                return SlashCommandResult(converted, blockId, 0)
            }
        }
        val (updated, created) = createBlock(cleaned, blockId, targetKind)
        return SlashCommandResult(updated, created.id, 0)
    }

    public fun cleanSlashPrefix(
        blocks: List<DocBlock>,
        blockId: String,
        slashStart: Int,
        filterLen: Int,
    ): List<DocBlock> {
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0 || slashStart < 0) return blocks

        val current = blocks[index]
        val fullText = current.text
        if (slashStart > fullText.length) return blocks

        val slashEnd = (slashStart + 1 + filterLen).coerceAtMost(fullText.length)
        val deleteLen = slashEnd - slashStart
        val textBefore = fullText.substring(0, slashStart)
        val textAfter = if (slashEnd < fullText.length) fullText.substring(slashEnd) else ""
        val cleanedText = textBefore + textAfter

        val currentMarks = BlockViewConverter.spansToMarks(fullText, current.spans)
        val adjustedMarks = currentMarks.mapNotNull { mark ->
            when {
                mark.to <= slashStart -> mark
                mark.from >= slashEnd -> markWithRange(mark, mark.from - deleteLen, mark.to - deleteLen)
                mark.from >= slashStart && mark.to <= slashEnd -> null
                mark.from < slashStart && mark.to > slashEnd -> markWithRange(mark, mark.from, mark.to - deleteLen)
                mark.from < slashStart -> markWithRange(mark, mark.from, slashStart)
                else -> markWithRange(mark, slashStart, mark.to - deleteLen)
            }
        }
        val newSpans = BlockViewConverter.marksToSpans(cleanedText, adjustedMarks)

        val result = blocks.toMutableList()
        result[index] = current.copy(
            spans = if (cleanedText.isEmpty()) listOf(InlineSpan("")) else newSpans
        )
        return result
    }

    // ── Mark 工具（公开） ─────────────────────────────────────────────

    public fun markKindOf(mark: TabDocMarkup.Mark): InlineMarkKind = when (mark) {
        is TabDocMarkup.Mark.Bold -> InlineMarkKind.BOLD
        is TabDocMarkup.Mark.Italic -> InlineMarkKind.ITALIC
        is TabDocMarkup.Mark.Strikethrough -> InlineMarkKind.STRIKE
        is TabDocMarkup.Mark.Underline -> InlineMarkKind.UNDERLINE
        is TabDocMarkup.Mark.Code -> InlineMarkKind.CODE
        is TabDocMarkup.Mark.Link -> InlineMarkKind.LINK
        is TabDocMarkup.Mark.TextColor -> InlineMarkKind.TEXT_COLOR
        is TabDocMarkup.Mark.Highlight -> InlineMarkKind.HIGHLIGHT
        is TabDocMarkup.Mark.Subscript -> InlineMarkKind.SUBSCRIPT
        is TabDocMarkup.Mark.Superscript -> InlineMarkKind.SUPERSCRIPT
        is TabDocMarkup.Mark.Mathematics -> InlineMarkKind.MATHEMATICS
        is TabDocMarkup.Mark.InlineImage -> InlineMarkKind.INLINE_IMAGE
        is TabDocMarkup.Mark.Unknown -> InlineMarkKind.UNKNOWN
    }

    // ── Mark 操作 ─────────────────────────────────────────────────────

    /**
     * 在选区范围内切换 mark 格式。
     * - 如果该 mark 完全覆盖选区 → 从选区中移除
     * - 否则 → 添加到选区
     */
    public fun toggleMark(
        blocks: List<DocBlock>,
        blockId: String,
        markKind: InlineMarkKind,
        selStart: Int,
        selEnd: Int,
        linkUrl: String? = null,
    ): List<DocBlock> {
        if (selStart >= selEnd) return blocks
        // 公式 / 行内图片是 inline atom；未知 mark 是不可拆范围身份，都不能当格式开关。
        if (markKind == InlineMarkKind.MATHEMATICS ||
            markKind == InlineMarkKind.INLINE_IMAGE ||
            markKind == InlineMarkKind.UNKNOWN
        ) return blocks
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return blocks
        val block = blocks[index]
        val body = block.spans.plainText()
        val currentMarks = BlockViewConverter.spansToMarks(body, block.spans)
        val editableRanges = subtractProtectedRanges(
            selStart,
            selEnd,
            protectedAtomRanges(currentMarks),
        )
        if (editableRanges.isEmpty()) return blocks

        val isActive = editableRanges.all { range ->
            isRangeFullyCovered(currentMarks, markKind, range.from, range.to)
        }

        // 同一选区可能一部分已有该 mark，另一部分没有（且中间还可能夹着公式原子）。
        // 添加前先从所有可编辑子区间清掉同类 mark，再按区间各加一次，避免产生重复 mark。
        val marksWithoutTargetInEditableRanges = currentMarks.flatMap { mark ->
            if (!markKindMatches(mark, markKind)) return@flatMap listOf(mark)
            removeRangesFromMark(mark, editableRanges)
        }
        val newMarks = if (isActive) {
            marksWithoutTargetInEditableRanges
        } else {
            marksWithoutTargetInEditableRanges + editableRanges.mapNotNull { range ->
                createMark(markKind, range.from, range.to, linkUrl)
            }
        }

        val newSpans = BlockViewConverter.marksToSpans(body, newMarks)
        val result = blocks.toMutableList()
        result[index] = block.copy(spans = newSpans)
        return result
    }

    private fun isRangeFullyCovered(
        marks: List<TabDocMarkup.Mark>,
        kind: InlineMarkKind,
        start: Int,
        end: Int,
    ): Boolean {
        val relevant = marks.filter { markKindMatches(it, kind) }.sortedBy { it.from }
        var covered = start
        for (mark in relevant) {
            if (mark.from > covered) return false
            if (mark.to > covered) covered = mark.to
            if (covered >= end) return true
        }
        return covered >= end
    }

    private fun markKindMatches(mark: TabDocMarkup.Mark, kind: InlineMarkKind): Boolean = when (kind) {
        InlineMarkKind.BOLD -> mark is TabDocMarkup.Mark.Bold
        InlineMarkKind.ITALIC -> mark is TabDocMarkup.Mark.Italic
        InlineMarkKind.STRIKE -> mark is TabDocMarkup.Mark.Strikethrough
        InlineMarkKind.UNDERLINE -> mark is TabDocMarkup.Mark.Underline
        InlineMarkKind.CODE -> mark is TabDocMarkup.Mark.Code
        InlineMarkKind.LINK -> mark is TabDocMarkup.Mark.Link
        InlineMarkKind.TEXT_COLOR -> mark is TabDocMarkup.Mark.TextColor
        InlineMarkKind.HIGHLIGHT -> mark is TabDocMarkup.Mark.Highlight
        InlineMarkKind.MATHEMATICS -> mark is TabDocMarkup.Mark.Mathematics
        InlineMarkKind.INLINE_IMAGE -> mark is TabDocMarkup.Mark.InlineImage
        InlineMarkKind.SUBSCRIPT -> mark is TabDocMarkup.Mark.Subscript
        InlineMarkKind.SUPERSCRIPT -> mark is TabDocMarkup.Mark.Superscript
        // UNKNOWN 不参与工具条切换；对未知范围套格式必须拒绝，避免静默丢身份。
        InlineMarkKind.UNKNOWN -> false
    }

    public fun markWithRange(mark: TabDocMarkup.Mark, from: Int, to: Int): TabDocMarkup.Mark = when (mark) {
        is TabDocMarkup.Mark.Bold -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.Italic -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.Strikethrough -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.Underline -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.Code -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.Link -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.TextColor -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.Highlight -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.Subscript -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.Superscript -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.Mathematics -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.InlineImage -> mark.copy(from = from, to = to)
        is TabDocMarkup.Mark.Unknown -> mark.copy(from = from, to = to)
    }

    private fun createMark(
        kind: InlineMarkKind, from: Int, to: Int,
        url: String? = null, color: String? = null,
    ): TabDocMarkup.Mark? = when (kind) {
        InlineMarkKind.BOLD -> TabDocMarkup.Mark.Bold(from, to)
        InlineMarkKind.ITALIC -> TabDocMarkup.Mark.Italic(from, to)
        InlineMarkKind.STRIKE -> TabDocMarkup.Mark.Strikethrough(from, to)
        InlineMarkKind.UNDERLINE -> TabDocMarkup.Mark.Underline(from, to)
        InlineMarkKind.CODE -> TabDocMarkup.Mark.Code(from, to)
        InlineMarkKind.LINK -> TabDocMarkup.Mark.Link(from, to, url ?: "")
        InlineMarkKind.TEXT_COLOR -> TabDocMarkup.Mark.TextColor(from, to, color ?: "")
        InlineMarkKind.HIGHLIGHT -> TabDocMarkup.Mark.Highlight(from, to, color ?: "")
        InlineMarkKind.MATHEMATICS -> null
        InlineMarkKind.INLINE_IMAGE -> null
        InlineMarkKind.SUBSCRIPT -> TabDocMarkup.Mark.Subscript(from, to)
        InlineMarkKind.SUPERSCRIPT -> TabDocMarkup.Mark.Superscript(from, to)
        InlineMarkKind.UNKNOWN -> null
    }

    /**
     * 设置选区的颜色类 mark（文字颜色 / 背景高亮）。
     * 先移除该 kind 的所有 mark，再添加新颜色（空颜色表示移除）。
     */
    public fun setColorMark(
        blocks: List<DocBlock>,
        blockId: String,
        markKind: InlineMarkKind,
        selStart: Int,
        selEnd: Int,
        color: String,
    ): List<DocBlock> {
        if (selStart >= selEnd) return blocks
        if (markKind != InlineMarkKind.TEXT_COLOR && markKind != InlineMarkKind.HIGHLIGHT) return blocks
        val index = blocks.indexOfFirst { it.id == blockId }
        if (index < 0) return blocks
        val block = blocks[index]
        val body = block.spans.plainText()
        val currentMarks = BlockViewConverter.spansToMarks(body, block.spans)
        val editableRanges = subtractProtectedRanges(
            selStart,
            selEnd,
            protectedAtomRanges(currentMarks),
        )
        if (editableRanges.isEmpty()) return blocks

        val cleaned = currentMarks.flatMap { mark ->
            if (!markKindMatches(mark, markKind)) return@flatMap listOf(mark)
            removeRangesFromMark(mark, editableRanges)
        }

        val newMarks = if (color.isNotBlank()) {
            cleaned + editableRanges.mapNotNull { range ->
                createMark(markKind, range.from, range.to, color = color)
            }
        } else {
            cleaned
        }

        val newSpans = BlockViewConverter.marksToSpans(body, newMarks)
        val result = blocks.toMutableList()
        result[index] = block.copy(spans = newSpans)
        return result
    }

    // ── Span 工具方法 ─────────────────────────────────────────────────

    /**
     * 在指定位置切分 InlineSpan 列表，正确处理跨 span 的切割点。
     */
    public fun splitSpansAt(
        spans: List<InlineSpan>,
        position: Int,
    ): Pair<List<InlineSpan>, List<InlineSpan>> {
        // 原生暂以源码文本展示公式，但持久化语义仍是不可拆的 inline atom。
        // Enter 落在公式内部时统一吸附到原子末尾，避免一次保存把单个公式裂成两个节点。
        val atomRanges = inlineAtomRanges(spans)
        val resolvedPosition = atomRanges
            .firstOrNull { position > it.from && position < it.to }
            ?.to
            ?: position
        val before = mutableListOf<InlineSpan>()
        val after = mutableListOf<InlineSpan>()
        var offset = 0
        for (span in spans) {
            val spanStart = offset
            val spanEnd = offset + span.text.length
            offset = spanEnd
            when {
                spanEnd <= resolvedPosition -> before.add(span)
                spanStart >= resolvedPosition -> after.add(span)
                else -> {
                    val splitPos = resolvedPosition - spanStart
                    before.add(InlineSpan(span.text.substring(0, splitPos), span.marks))
                    after.add(InlineSpan(span.text.substring(splitPos), span.marks))
                }
            }
        }
        if (before.isEmpty()) before.add(InlineSpan(""))
        if (after.isEmpty()) after.add(InlineSpan(""))
        return before to after
    }

    private data class TextRange(val from: Int, val to: Int)

    /**
     * 行内 atom 的范围不接受用户格式操作：mark 会被挂到 atom span 上，而 atom 序列化
     * 只写节点本身，格式会在保存时静默消失。
     */
    private fun protectedAtomRanges(marks: List<TabDocMarkup.Mark>): List<TextRange> =
        marks.mapNotNull { mark ->
            when (mark) {
                is TabDocMarkup.Mark.Mathematics -> TextRange(mark.from, mark.to)
                is TabDocMarkup.Mark.InlineImage -> TextRange(mark.from, mark.to)
                is TabDocMarkup.Mark.Unknown -> TextRange(mark.from, mark.to)
                else -> null
            }
        }

    /** 公式、行内图片与未知 mark 范围都按不可拆身份对待，避免 Enter / 格式把它切开。 */
    private fun inlineAtomRanges(spans: List<InlineSpan>): List<TextRange> {
        val ranges = linkedMapOf<String, TextRange>()
        var offset = 0
        spans.forEach { span ->
            val start = offset
            val end = start + span.text.length
            span.marks.forEach { mark ->
                val atomKey = when (mark) {
                    is InlineMark.Mathematics -> "mathematics:${mark.atomId}"
                    is InlineMark.InlineImage -> "image:${mark.atomId}"
                    is InlineMark.Unknown -> "unknown:${mark.type}:${mark.attrs}:$start"
                    else -> return@forEach
                }
                val existing = ranges[atomKey]
                ranges[atomKey] = if (existing == null) {
                    TextRange(start, end)
                } else {
                    TextRange(minOf(existing.from, start), maxOf(existing.to, end))
                }
            }
            offset = end
        }
        return ranges.values.toList()
    }

    private fun subtractProtectedRanges(
        from: Int,
        to: Int,
        protected: List<TextRange>,
    ): List<TextRange> {
        if (from >= to) return emptyList()
        val normalized = protected
            .filter { it.from < to && it.to > from }
            .sortedBy(TextRange::from)
        val result = mutableListOf<TextRange>()
        var cursor = from
        normalized.forEach { range ->
            val start = range.from.coerceAtLeast(from)
            val end = range.to.coerceAtMost(to)
            if (start > cursor) result.add(TextRange(cursor, start))
            cursor = maxOf(cursor, end)
        }
        if (cursor < to) result.add(TextRange(cursor, to))
        return result
    }

    private fun removeRangesFromMark(
        mark: TabDocMarkup.Mark,
        ranges: List<TextRange>,
    ): List<TabDocMarkup.Mark> {
        var remaining = listOf(mark)
        ranges.forEach { range ->
            remaining = remaining.flatMap { part ->
                if (part.from >= range.to || part.to <= range.from) {
                    listOf(part)
                } else {
                    buildList {
                        if (part.from < range.from) {
                            add(markWithRange(part, part.from, range.from))
                        }
                        if (part.to > range.to) {
                            add(markWithRange(part, range.to, part.to))
                        }
                    }
                }
            }
        }
        return remaining
    }

    /**
     * 合并两个 span 列表，相邻且 marks 相同的 span 会合并为一个。
     */
    public fun mergeSpans(a: List<InlineSpan>, b: List<InlineSpan>): List<InlineSpan> {
        val combined = a.filter { it.text.isNotEmpty() } + b.filter { it.text.isNotEmpty() }
        if (combined.isEmpty()) return listOf(InlineSpan(""))
        val merged = mutableListOf(combined.first())
        for (i in 1 until combined.size) {
            val last = merged.last()
            val current = combined[i]
            if (last.marks.toSet() == current.marks.toSet()) {
                merged[merged.lastIndex] = InlineSpan(last.text + current.text, last.marks)
            } else {
                merged.add(current)
            }
        }
        return merged
    }
}
